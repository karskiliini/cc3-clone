"""Shared Blender scene setup, cell renderer and atlas packer for the sprite pipeline.

Used by tools/blender/soldiers.py and tools/blender/vehicles.py.  Runs inside Blender's
Python (bpy); needs numpy (bundled with Blender).  PNG writing uses Pillow when available
and falls back to Blender's own image API, so no extra install is needed.

WORLD CONVENTIONS (everything a model script needs to know)
  * Units are metres.  +Y is screen-north (up on the screen), +X is east (right), +Z is up.
  * A unit is modelled FACING +Y (direction 0 = north).  Direction d of N is a rotation
    about Z of  -d * 2*pi/N  radians (clockwise seen from above); use `dir_angle(d, N)`.
  * The ground is z = 0.  The ground point under the unit's origin lands on the cell's
    `anchor` pixel.
  * Camera: orthographic, tilted TILT_DEG (12 deg) from vertical, standing south of the subject
    and looking north/down, so tall things lean "up" the screen and south faces show a bit.
    Ground scale is exactly px_per_m in BOTH screen axes (the tilt's cos() foreshortening is
    compensated with the pixel aspect); height z shifts a point up-screen by z*tan(12deg)*ppm.
  * Light: sun from the NW (azimuth 315 deg, elevation 45 deg) so shadows fall to the SE, plus
    a soft sky fill.  Film is transparent.  A shadow-catcher plane at z=0 keeps the contact
    shadow in the sprite as semi-transparent dark pixels.

API (keep small; only backwards-compatible changes after v1)
  ctx = setup_scene(px_per_m, cell_w, cell_h, anchor=(ax, ay), grid=(1, 1),
                    supersample=2, shadow=True, engine="CYCLES", samples=24)
  x, y = ctx.cell_origin(col, row)      # world XY whose ground point is that cell's anchor
  rgba = render_cell(ctx)               # (cell_h, cell_w, 4) uint8, straight alpha, cell (0,0)
  cells = render_grid(ctx)              # list[row][col] of such arrays: many cells, ONE render
  set_shadow(ctx, on)                   # toggle the baked contact shadow (off for ragdoll flights)
  dir_angle(d, n)                       # Z rotation (radians) for facing d of n
  mat = make_material(name, rgb, roughness=0.8, metallic=0.0, emission=0.0)   # sRGB 0..1 or "#hex"
  clear_scene()                         # wipe all data (setup_scene calls it unless keep=True)
  packer = AtlasPacker(scale, cell_w, cell_h, anchor, dirs, columns=32)
  packer.add(key, frames_by_dir, fps=8, loop=True, **extra)   # frames_by_dir[dir][frame] = rgba
  packer.save("/path/public/sprites/soldiers_german_summer_1", extra={...})  # -> .png + .json
  save_png(path, rgba) / load_png(path)

The atlas JSON follows docs/superpowers/specs/2026-09-17-soldier-animation-design.md section 5:
  {scale, cell:{w,h}, anchor:{x,y}, columns, dirs, entries:{key:{start,frames,fps,loop}}}
  frame index = start + dir*frames + frame ; grid pos = (index % columns, index // columns).
"""
import json
import math
import os
import tempfile

import numpy as np

try:
    import bpy
    from mathutils import Vector  # noqa: F401
except ImportError:  # allows importing AtlasPacker etc. from plain python (contact sheets, tests)
    bpy = None

TILT_DEG = 12.0
SUN_AZIMUTH_DEG = 315.0
SUN_ELEVATION_DEG = 45.0
SUN_STRENGTH = 4.0
SKY_STRENGTH = 0.55
SKY_COLOR = (0.80, 0.87, 1.0)
SHADOW_DARKNESS = 0.62     # max alpha of the baked contact shadow
SHADOW_RGB = (16, 18, 14)


def dir_angle(d, n=16):
    """Z rotation in radians that turns a +Y-facing model to facing d of n (0 = north, clockwise)."""
    return -2.0 * math.pi * d / n


def _srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _rgb(col):
    if isinstance(col, str):
        col = col.lstrip("#")
        col = tuple(int(col[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return tuple(col[:3])


def make_material(name, rgb, roughness=0.8, metallic=0.0, emission=0.0):
    """Principled material from an sRGB colour (tuple 0..1 or '#rrggbb').  Reuses by name."""
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    lin = tuple(_srgb_to_lin(c) for c in _rgb(rgb)) + (1.0,)
    b.inputs["Base Color"].default_value = lin
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    if emission > 0:
        b.inputs["Emission Color"].default_value = lin
        b.inputs["Emission Strength"].default_value = emission
    m.diffuse_color = lin
    return m


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


class SceneCtx:
    """Returned by setup_scene; treat the attributes as read-only."""

    def __init__(self):
        self.scene = None
        self.camera = None
        self.sun = None
        self.catcher = None
        self.px_per_m = 10
        self.cell_w = self.cell_h = 0
        self.anchor = (0, 0)
        self.grid = (1, 1)
        self.supersample = 2
        self.engine = "CYCLES"
        self._tmp = None

    def cell_origin(self, col=0, row=0):
        """World (x, y) of the ground point that lands on the anchor pixel of grid cell col,row
        (row 0 is the TOP row of the rendered image)."""
        gw, gh = self.grid
        tw, th = gw * self.cell_w, gh * self.cell_h
        px = col * self.cell_w + self.anchor[0]
        py = row * self.cell_h + self.anchor[1]
        return ((px - tw / 2.0) / self.px_per_m, -(py - th / 2.0) / self.px_per_m)


def setup_scene(px_per_m, cell_w, cell_h, anchor=None, grid=(1, 1), supersample=2,
                shadow=True, engine="CYCLES", samples=24, keep=False):
    """Create camera, sun, sky, shadow catcher and render settings.  Returns a SceneCtx.

    px_per_m   final pixels per metre (10 at scale 1, 20 at scale 2)
    cell_w/h   final cell size in pixels; anchor = (x, y) pixel of the ground point in a cell
    grid       (cols, rows): render that many cells in one image (place objects at cell_origin)
    engine     "CYCLES" (default: true shadow catcher, few samples, CPU) or "EEVEE"
    keep       do not wipe the file first (use when your objects already exist)
    """
    if not keep:
        clear_scene()
    ctx = SceneCtx()
    scene = bpy.context.scene
    ctx.scene = scene
    ctx.px_per_m = px_per_m
    ctx.cell_w, ctx.cell_h = int(cell_w), int(cell_h)
    ctx.anchor = tuple(anchor) if anchor else (cell_w // 2, cell_h // 2)
    ctx.grid = tuple(grid)
    ctx.supersample = int(supersample)
    ctx.engine = engine
    ctx._tmp = os.path.join(tempfile.mkdtemp(prefix="sprites_"), "cell.png")

    tw, th = grid[0] * ctx.cell_w, grid[1] * ctx.cell_h
    tilt = math.radians(TILT_DEG)
    r = scene.render
    r.resolution_x = tw * supersample
    r.resolution_y = th * supersample
    r.resolution_percentage = 100
    # pixel aspect compensates the cos(tilt) ground foreshortening: ground is ppm in both axes
    r.pixel_aspect_x = 1.0
    r.pixel_aspect_y = math.cos(tilt)
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    r.image_settings.color_depth = "8"
    r.image_settings.compression = 0
    r.use_file_extension = False
    r.filepath = ctx._tmp
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
    except Exception:
        pass

    if engine == "CYCLES":
        r.engine = "CYCLES"
        c = scene.cycles
        c.device = "CPU"
        c.samples = samples
        c.use_adaptive_sampling = False
        c.use_denoising = False
        c.max_bounces = 2
        c.diffuse_bounces = 1
        c.glossy_bounces = 1
        c.transparent_max_bounces = 4
        c.pixel_filter_type = "BLACKMAN_HARRIS"
        c.filter_width = 1.5
        r.threads_mode = "AUTO"
        r.use_persistent_data = True
    else:
        r.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in [e.identifier for e in
                   type(r).bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE_NEXT"
        try:
            scene.eevee.taa_render_samples = samples
        except Exception:
            pass

    # camera: south of the subject, looking north and down, tilted from vertical
    cam_data = bpy.data.cameras.new("SpriteCam")
    cam_data.type = "ORTHO"
    cam_data.clip_start = 0.1
    cam_data.clip_end = 400.0
    width_m = tw / px_per_m
    height_m_img = th * math.cos(tilt) / px_per_m   # image-plane height
    cam_data.ortho_scale = max(width_m, height_m_img)
    cam = bpy.data.objects.new("SpriteCam", cam_data)
    scene.collection.objects.link(cam)
    dist = 100.0
    cam.location = (0.0, -dist * math.sin(tilt), dist * math.cos(tilt))
    cam.rotation_euler = (tilt, 0.0, 0.0)
    scene.camera = cam
    ctx.camera = cam

    # sun from the NW: azimuth 315 (compass), elevation 45 -> light travels toward SE and down
    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = SUN_STRENGTH
    sun_data.angle = math.radians(6.0)
    sun_data.color = (1.0, 0.96, 0.88)
    sun = bpy.data.objects.new("Sun", sun_data)
    scene.collection.objects.link(sun)
    az = math.radians(SUN_AZIMUTH_DEG)
    el = math.radians(SUN_ELEVATION_DEG)
    to_sun = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    sun.rotation_euler = to_sun.to_track_quat("Z", "Y").to_euler()   # lamp shines along its -Z
    sun.location = to_sun * 50
    ctx.sun = sun

    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = SKY_COLOR + (1.0,)
    bg.inputs[1].default_value = SKY_STRENGTH
    scene.world = world

    # shadow catcher plane
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0, 0, 0))
    plane = bpy.context.active_object
    plane.name = "ShadowCatcher"
    plane.scale = (width_m * 3 + 20, (th / px_per_m) * 3 + 20, 1)
    plane.data.materials.append(make_material("_catcher", (0.5, 0.5, 0.5), 1.0))
    ctx.catcher = plane
    if engine == "CYCLES":
        plane.is_shadow_catcher = True
    set_shadow(ctx, shadow)
    return ctx


def set_shadow(ctx, on):
    """Show/hide the shadow-catcher plane (ragdoll flights are rendered without a shadow)."""
    ctx.catcher.hide_render = not on


def _read_render(ctx):
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(ctx._tmp, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    a = buf.reshape(h, w, 4)[::-1]          # top row first; straight alpha, sRGB-encoded 0..1
    return a


def _finish(ctx, a):
    """Downsample by the supersample factor (premultiplied box filter); tame the shadow."""
    s = ctx.supersample
    h, w = a.shape[0] // s, a.shape[1] // s
    # shadow-catcher pixels come out pure black with alpha; soften and tint them
    a = a.copy()
    sh = (a[..., :3].max(axis=2) < 0.02) & (a[..., 3] > 0)
    a[..., 3][sh] *= SHADOW_DARKNESS
    for k in range(3):
        a[..., k][sh] = SHADOW_RGB[k] / 255.0
    rgb = a[..., :3] * a[..., 3:4]
    rgb = rgb.reshape(h, s, w, s, 3).mean(axis=(1, 3))
    al = a[..., 3].reshape(h, s, w, s).mean(axis=(1, 3))
    out = np.zeros((h, w, 4), dtype=np.float32)
    nz = al > 1e-4
    out[..., :3][nz] = rgb[nz] / al[nz][:, None]
    out[..., 3] = al
    return (np.clip(out, 0, 1) * 255.0 + 0.5).astype(np.uint8)


def render_grid(ctx):
    """Render once and slice into grid cells: returns cells[row][col] -> (cell_h, cell_w, 4) uint8."""
    img = _finish(ctx, _read_render(ctx))
    cols, rows = ctx.grid
    return [[img[j * ctx.cell_h:(j + 1) * ctx.cell_h, i * ctx.cell_w:(i + 1) * ctx.cell_w].copy()
             for i in range(cols)] for j in range(rows)]


def render_cell(ctx, col=0, row=0):
    """Render the scene and return one cell as an RGBA uint8 array (straight alpha)."""
    return render_grid(ctx)[row][col]


def save_png(path, rgba):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    try:
        from PIL import Image
        Image.fromarray(rgba, "RGBA").save(path, optimize=True)
        return
    except ImportError:
        pass
    h, w = rgba.shape[:2]
    img = bpy.data.images.new("_out", w, h, alpha=True)
    img.alpha_mode = "STRAIGHT"
    img.colorspace_settings.name = "sRGB"   # store bytes as given
    img.pixels.foreach_set((rgba[::-1].astype(np.float32) / 255.0).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def load_png(path):
    try:
        from PIL import Image
        return np.array(Image.open(path).convert("RGBA"))
    except ImportError:
        img = bpy.data.images.load(path, check_existing=False)
        w, h = img.size
        buf = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
        bpy.data.images.remove(img)
        return (buf.reshape(h, w, 4)[::-1] * 255 + 0.5).astype(np.uint8)


class AtlasPacker:
    """Collects entries and writes <base>.png + <base>.json in the contract format."""

    def __init__(self, scale, cell_w, cell_h, anchor, dirs, columns=32):
        self.scale, self.cell_w, self.cell_h = scale, int(cell_w), int(cell_h)
        self.anchor, self.dirs, self.columns = tuple(anchor), dirs, columns
        self.entries = {}      # key -> dict(meta)
        self.cells = {}        # key -> frames_by_dir

    def add(self, key, frames_by_dir, fps=8, loop=True, **extra):
        """frames_by_dir[dir][frame] -> RGBA uint8 (cell_h, cell_w, 4).  Re-adding a key replaces it."""
        assert len(frames_by_dir) == self.dirs, (key, len(frames_by_dir), self.dirs)
        n = len(frames_by_dir[0])
        assert all(len(f) == n for f in frames_by_dir), key
        self.cells[key] = frames_by_dir
        self.entries[key] = dict(frames=n, fps=fps, loop=bool(loop), **extra)

    def save(self, base, extra=None):
        """Write base+'.png' and base+'.json'.  `extra` is merged into the JSON top level."""
        idx = 0
        layout = {}
        for key in self.entries:
            layout[key] = idx
            idx += self.dirs * self.entries[key]["frames"]
        rows = max(1, -(-idx // self.columns))
        sheet = np.zeros((rows * self.cell_h, self.columns * self.cell_w, 4), dtype=np.uint8)
        for key, start in layout.items():
            n = self.entries[key]["frames"]
            for d in range(self.dirs):
                for f in range(n):
                    i = start + d * n + f
                    cx, cy = i % self.columns, i // self.columns
                    sheet[cy * self.cell_h:(cy + 1) * self.cell_h,
                          cx * self.cell_w:(cx + 1) * self.cell_w] = self.cells[key][d][f]
        save_png(base + ".png", sheet)
        meta = {
            "scale": self.scale,
            "cell": {"w": self.cell_w, "h": self.cell_h},
            "anchor": {"x": self.anchor[0], "y": self.anchor[1]},
            "columns": self.columns,
            "dirs": self.dirs,
            "entries": {k: dict(start=layout[k], **v) for k, v in self.entries.items()},
        }
        if extra:
            meta.update(extra)
        with open(base + ".json", "w") as fh:
            json.dump(meta, fh, indent=1)
        return meta
