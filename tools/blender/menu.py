"""Main-menu poster backdrop (public/menu/poster.png, 800x600) rendered headless with Cycles.

    blender -b -P tools/blender/menu.py -- [--samples 48] [--raw]     # npm run sprites:menu

Also writes public/menu/poster_plain.png: the same scene without the soldier, the backdrop of the
working screens (setup, requisition, options, debrief) where he would only compete with the panels.

The CC3 menu look, in our own art: a Soviet rifleman (SSh-40 helmet, greatcoat) on the left third
points toward the menu buttons, rim-lit by a burning town whose ruins stand against the fire glow behind the menu buttons.  Everything is a simple procedural shape
(metaball body, lathed helmet, boxes); the figure is a matte near-black silhouette that only the
fire behind him rim-lights, like a poster.  The render is graded in
numpy with a single maroon-to-flame gradient map so the poster has one clean palette (no texture
noise), then darkened toward the top bar and the bottom button strip so the chrome stays legible.

Scene: metres, camera looks along +Y, +Z up.  The figure stands at x<0 (screen left).
--raw also writes poster_raw.png (the ungraded render) next to the poster, for tuning.
"""
import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import clear_scene, make_material, save_png  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "menu", "poster.png")
W, H = 800, 600
FIG_X = -0.50   # figure position (m, screen left of centre)
SS = 2   # supersample

# gradient map, luminance 0..1 -> sRGB (dark oxblood -> maroon -> brick red -> flame -> hot white)
GRADE = [(0.00, (14, 4, 4)), (0.10, (38, 8, 7)), (0.28, (92, 20, 12)), (0.50, (168, 52, 22)),
         (0.72, (228, 124, 44)), (0.90, (250, 204, 120)), (1.00, (255, 244, 212))]


def args():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    samples = int(a[a.index("--samples") + 1]) if "--samples" in a else 48
    return samples, "--raw" in a


# ------------------------------------------------------------------------------------ helpers --
def obj(name, me, mat=None):
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if mat is not None:
        me.materials.append(mat)
    return o


def box(name, center, size, mat, rot_z=0.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rot_z, 3, "Z"), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    return obj(name, me, mat)


def cylinder(name, p0, p1, r, mat, segs=12):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=d.length)
    bm.to_mesh(me)
    bm.free()
    o = obj(name, me, mat)
    o.location = (p0 + p1) / 2
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    for p in me.polygons:
        p.use_smooth = True
    return o


def lathe(name, profile, mat, loc, segs=48, scale=(1, 1, 1)):
    """Surface of revolution about Z from a list of (radius, z) points, top to bottom."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for (r, z) in profile:
        ring = [bm.verts.new((r * math.cos(2 * math.pi * i / segs) * scale[0],
                              r * math.sin(2 * math.pi * i / segs) * scale[1], z * scale[2])) for i in range(segs)]
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    o = obj(name, me, mat)
    o.location = loc
    return o


class Meta:
    """Metaball body: capsules and ellipsoids melt into one smooth figure."""

    def __init__(self, name, mat):
        self.mb = bpy.data.metaballs.new(name)
        self.mb.resolution = 0.012
        self.mb.render_resolution = 0.006
        self.mb.threshold = 0.6
        self.k = 1.74     # element radius -> visible surface radius (~0.575 r at threshold 0.6)
        self.o = obj(name, self.mb, mat)

    def capsule(self, p0, p1, r, stiff=2.0):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        e = self.mb.elements.new(type="CAPSULE")
        e.co = (p0 + p1) / 2
        e.radius = r * self.k
        e.size_x = d.length / 2
        e.rotation = Vector((1, 0, 0)).rotation_difference(d.normalized())
        e.stiffness = stiff
        return e

    def ellipsoid(self, c, sx, sy, sz, r=1.0, stiff=2.0):
        e = self.mb.elements.new(type="ELLIPSOID")
        e.co = c
        e.radius = r * self.k
        e.size_x, e.size_y, e.size_z = sx, sy, sz
        e.stiffness = stiff
        return e


def sky_mat():
    """Backdrop: emissive radial glow (fire) low right of centre fading to near black up top."""
    m = bpy.data.materials.new("sky")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    # plane UV (0..1 over 80 x 52 m); radius 1 of the gradient = 25 m, centred at uv (0.545, 0.35)
    mp.inputs["Scale"].default_value = (3.2, 2.08, 1)
    mp.inputs["Location"].default_value = (-0.545 * 3.2, -0.35 * 2.08, 0)
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.elements[0].position = 0.0
    cr.elements[0].color = (0.004, 0.001, 0.001, 1)
    cr.elements[1].position = 1.0
    cr.elements[1].color = (1.0, 0.85, 0.55, 1)
    e = cr.elements.new(0.55)
    e.color = (0.30, 0.06, 0.02, 1)
    e = cr.elements.new(0.82)
    e.color = (0.85, 0.38, 0.10, 1)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 3.0
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


# ----------------------------------------------------------------------------------- the scene --
def build():
    clear_scene()
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.render.resolution_x, scene.render.resolution_y = W * SS, H * SS
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.world = bpy.data.worlds.new("w")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.01, 0.002, 0.002, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.02

    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 40
    cam = bpy.data.objects.new("cam", cam_d)
    scene.collection.objects.link(cam)
    cam.location = (0.0, -1.55, 1.48)
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.camera = cam

    # the figure is a poster silhouette: dark, matte, no specular; only the fire behind him
    # draws a thin warm rim along his edges
    dark = make_material("fig", "#3a2a22", roughness=1.0)
    dark.node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.0
    ruin = make_material("ruin", "#120c0a", roughness=1.0)

    # ---- the rifleman in a greatcoat, rifle slung, pointing with his left hand ----
    fx = 0.0      # modelled at the origin; the 'figure' empty places and turns him
    body = Meta("body", dark)
    body.ellipsoid((fx, 0.08, 1.02), 0.24, 0.14, 0.32)                      # chest (greatcoat)
    body.ellipsoid((fx, 0.08, 0.70), 0.23, 0.13, 0.30)
    body.capsule((fx - 0.20, 0.08, 1.31), (fx + 0.20, 0.08, 1.31), 0.070)    # square shoulders
    body.capsule((fx - 0.23, 0.08, 1.27), (fx - 0.27, 0.10, 0.88), 0.064)    # right arm hanging
    body.capsule((fx - 0.27, 0.10, 0.88), (fx - 0.24, 0.02, 0.62), 0.056)
    # left arm (screen right) thrust forward: shoulder -> elbow -> wrist
    sh = (fx + 0.21, 0.06, 1.28)
    el = (fx + 0.28, -0.08, 1.39)
    wr = (fx + 0.29, -0.27, 1.56)
    body.capsule(sh, el, 0.064)
    body.capsule(el, wr, 0.050)                                               # greatcoat sleeve
    body.capsule((fx, 0.05, 1.34), (fx, 0.05, 1.46), 0.050)                  # neck
    collar = lathe("collar", [(0.098, 0.045), (0.088, 0.0), (0.084, -0.04)], dark,          # stand-up collar
                   (fx, 0.05, 1.39), segs=32, scale=(1.0, 0.95, 1.0))

    # the hand at silhouette level, pointing ahead-right: back of the hand, a straight index
    # finger, the thumb laid along it, three curled fingers under the knuckles
    hand = Meta("hand", dark)
    ax = Vector((0.80, -0.50, 0.28)).normalized()           # pointing direction (figure space)
    up = Vector((0.0, 0.0, 1.0))
    side = ax.cross(up).normalized()
    w = Vector(wr)
    P = lambda a, s_, u: tuple(w + ax * a + side * s_ + up * u)   # noqa: E731
    hand.capsule(P(-0.03, 0, 0), P(0.02, 0, 0), 0.030)                    # cuff / wrist
    hand.ellipsoid(P(0.055, 0, 0), 0.034, 0.030, 0.030)                   # back of the hand
    hand.capsule(P(0.08, 0, 0.012), P(0.17, 0, 0.018), 0.0095)           # index finger
    hand.capsule(P(0.05, 0.02, 0.022), P(0.095, 0.012, 0.028), 0.010)    # thumb
    for k in range(3):                                                    # curled fingers
        hand.capsule(P(0.085, 0, -0.004 - 0.014 * k), P(0.075, 0, -0.018 - 0.014 * k), 0.0085)

    head = Meta("head", dark)
    hz = 1.565
    head.ellipsoid((fx, 0.04, hz), 0.080, 0.090, 0.104)
    head.ellipsoid((fx, -0.005, hz - 0.068), 0.058, 0.050, 0.038)                       # jaw/chin
    head.capsule((fx, -0.056, hz + 0.0), (fx, -0.068, hz - 0.03), 0.011)                # nose
    for sgn in (-1, 1):
        head.ellipsoid((fx + sgn * 0.08, 0.04, hz - 0.01), 0.015, 0.024, 0.03)          # ears

    # SSh-40: a low, deep dome whose sides come straight down over the temples and flare
    # out slightly at the rim; no brim, no visor, no German neck skirt
    prof = [(0.001, 0.112)] + [(0.121 * math.sin(math.radians(a)), 0.112 * math.cos(math.radians(a)))
                               for a in range(10, 91, 10)]
    prof += [(0.123, -0.030), (0.127, -0.050), (0.133, -0.062)]
    helm = lathe("helmet", prof, dark, (fx, 0.035, hz + 0.05), scale=(1.0, 1.08, 1.0))
    helm.rotation_euler = (math.radians(-5), 0, 0)

    # Mosin slung on the right shoulder: muzzle and bayonet rise behind it, strap over the chest
    r0 = Vector((fx - 0.15, 0.17, 0.62))
    r1 = Vector((fx - 0.25, 0.19, 1.66))
    d = (r1 - r0).normalized()
    rifle = [cylinder("stock", r0, r0 + d * 0.6, 0.024, dark),
             cylinder("barrel", r0 + d * 0.55, r1, 0.011, dark),
             cylinder("bayonet", r1, r1 + d * 0.28, 0.0045, dark, segs=6),
             cylinder("sling", (fx - 0.20, 0.0, 1.33), (fx + 0.06, -0.12, 0.75), 0.009, dark, segs=6)]

    # stand him left of the buttons, turned a little toward the fire (screen right) so the
    # rim light draws his profile; he points past the viewer toward the menu buttons
    fig = bpy.data.objects.new("figure", None)
    scene.collection.objects.link(fig)
    fig.location = (FIG_X, 0.0, 0.0)
    fig.rotation_euler = (0, 0, math.radians(18))
    for o in (body.o, collar, hand.o, head.o, helm, *rifle):
        o.parent = fig
    fx = FIG_X

    # ---- the burning town: ruins silhouetted against the glow, rubble under the buttons ----
    sky = bpy.data.meshes.new("sky")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
    bm.to_mesh(sky)
    bm.free()
    sky.uv_layers.new(name="UV")
    for i, l in enumerate(sky.loops):
        v = sky.vertices[l.vertex_index].co
        sky.uv_layers[0].data[i].uv = ((v.x + 1) / 2, (v.y + 1) / 2)
    so = obj("sky", sky, sky_mat())
    so.location = (0.0, 40.0, 6.0)
    so.rotation_euler = (math.radians(90), 0, 0)
    so.scale = (40.0, 26.0, 1.0)

    def facade(x0, y, width, height, seed, depth=0.4):
        """A shelled facade: an extruded outline with a broken top edge, window rows cut by a boolean."""
        rng = np.random.default_rng(seed)
        n = int(width / 0.6) + 2
        xs = np.linspace(x0, x0 + width, n)
        tops = height * (0.55 + 0.45 * np.convolve(rng.random(n + 2), np.ones(3) / 3, "valid"))
        tops[rng.integers(1, n - 1)] *= 0.45
        xs = xs + np.r_[0, (rng.random(n - 2) - 0.5) * 0.3, 0]
        me = bpy.data.meshes.new(f"facade{seed}")
        bm = bmesh.new()
        bot = [bm.verts.new((x, y, 0.0)) for x in xs]
        top = [bm.verts.new((x, y, t)) for x, t in zip(xs, tops)]
        for i in range(n - 1):
            bm.faces.new((bot[i], bot[i + 1], top[i + 1], top[i]))
        bm.to_mesh(me)
        bm.free()
        o = obj(f"facade{seed}", me, ruin)
        sol = o.modifiers.new("depth", "SOLIDIFY")
        sol.thickness, sol.offset = depth, 1.0
        wm = bpy.data.meshes.new(f"win{seed}")
        bm = bmesh.new()
        for fl in range(1, int(height / 3.2) + 1):
            for wx in np.arange(x0 + 0.9, x0 + width - 0.9, 1.9):
                if rng.random() < 0.9:
                    c = bmesh.ops.create_cube(bm, size=1.0)["verts"]
                    bmesh.ops.scale(bm, vec=(0.85, 2.0, 1.5), verts=c)
                    bmesh.ops.translate(bm, vec=(wx + 0.45, y, fl * 3.2 - 1.0), verts=c)
        bm.to_mesh(wm)
        bm.free()
        wo = obj(f"win{seed}", wm)
        wo.hide_render = True
        mod = o.modifiers.new("win", "BOOLEAN")
        mod.operation, mod.solver, mod.object = "DIFFERENCE", "EXACT", wo
        return o

    facade(-16.0, 26.0, 10.0, 5.0, 1)
    facade(-5.5, 36.0, 5.0, 6.0, 4)
    facade(2.0, 30.0, 8.0, 13.0, 2)
    facade(10.5, 21.0, 6.5, 7.0, 3)
    box("chimney", (8.4, 34.0, 6.0), (0.7, 0.7, 12.0), ruin)
    for i, x in enumerate(np.linspace(-20, 20, 28)):       # low rubble line along the horizon
        box(f"hz{i}", (x, 18.0 + (i % 3) * 3, 0.0), (1.6 + (i * 7 % 5) * 0.4, 1.0, 0.5 + (i * 5 % 4) * 0.35), ruin,
            rot_z=0.3 * (i % 5))
    box("ground", (0, 20, -0.05), (80, 60, 0.1), ruin)

    # a rubble mound rising to the right under the buttons, its flat edges sunk below the ground
    gm = bpy.data.meshes.new("mound")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=60, y_segments=30, size=1.0)
    for v in bm.verts:
        u, w = (v.co.x + 1) / 2, (v.co.y + 1) / 2          # 0..1
        x, y = 0.0 + u * 7.0, 3.0 + w * 5.0
        hump = max(0.0, 1.0 - ((u - 0.85) / 0.75) ** 2 - ((w - 0.45) / 0.6) ** 2)
        v.co = Vector((x, y, 1.3 * hump ** 1.3 - 0.03))   # flat edges sink under the ground
    bm.to_mesh(gm)
    bm.free()
    obj("mound", gm, ruin)

    # ---- light: fire rim from behind-right, a dim warm fill from the front-left ----
    def area(name, loc, target, energy, size, rgb):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy, ld.size, ld.color = energy, size, rgb
        lo = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_mode = "QUATERNION"
        lo.rotation_quaternion = Vector((0, 0, -1)).rotation_difference((Vector(target) - Vector(loc)).normalized())
        return lo

    area("rim", (fx + 0.8, 1.3, 1.7), (fx, 0.0, 1.3), 700.0, 0.5, (1.0, 0.55, 0.22))
    area("rim2", (fx - 0.9, 1.3, 1.9), (fx, 0.0, 1.4), 300.0, 0.5, (1.0, 0.35, 0.12))
    area("glow", (3.0, 14.0, 1.5), (1.5, 5.0, 0.5), 120.0, 4.0, (1.0, 0.5, 0.15))
    return scene


# --------------------------------------------------------------------------------------- grade --
def grade(rgba):
    """Gradient-map the luminance onto the poster palette, then shade top bar / bottom strip."""
    rgb = rgba[..., :3].astype(np.float32) / 255.0
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    lum = np.clip(lum * 1.15, 0, 1) ** 0.85
    xs = np.array([g[0] for g in GRADE], dtype=np.float32)
    out = np.stack([np.interp(lum, xs, np.array([g[1][c] for g in GRADE], dtype=np.float32)) for c in range(3)], -1)
    h, w = lum.shape
    y = (np.arange(h, dtype=np.float32) / h)[:, None]
    x = (np.arange(w, dtype=np.float32) / w)[None, :]
    shade = np.ones((h, w), dtype=np.float32)
    shade *= 1.0 - 0.55 * np.clip((0.10 - y) / 0.10, 0, 1) ** 1.5          # title bar
    shade *= 1.0 - 0.70 * np.clip((y - 0.86) / 0.14, 0, 1) ** 1.2          # button strip
    r = np.sqrt(((x - 0.5) / 0.75) ** 2 + ((y - 0.5) / 0.75) ** 2)
    shade *= 1.0 - 0.45 * np.clip(r - 0.35, 0, 1) ** 1.5                   # vignette
    out *= shade[..., None]
    res = np.dstack([np.clip(out + 0.5, 0, 255).astype(np.uint8), np.full((h, w), 255, np.uint8)])
    return res


def render(scene, name):
    tmp = os.path.join(bpy.app.tempdir or "/tmp", name)
    scene.render.filepath = tmp
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp)
    buf = np.empty(W * SS * H * SS * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    a = buf.reshape(H * SS, W * SS, 4)[::-1]
    a = a.reshape(H, SS, W, SS, 4).mean(axis=(1, 3))
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def main():
    samples, raw = args()
    scene = build()
    scene.cycles.samples = samples
    scene.render.threads_mode = "FIXED"   # the machine is shared with other render jobs
    scene.render.threads = 4
    scene.cycles.use_denoising = True
    rgba = render(scene, "poster.png")
    if raw:
        save_png(OUT.replace(".png", "_raw.png"), rgba)
    save_png(OUT, grade(rgba))
    print("wrote", OUT)
    # the same town without the soldier: the backdrop of the working screens behind their panels
    for o in bpy.data.objects["figure"].children:
        o.hide_render = True
    plain = OUT.replace(".png", "_plain.png")
    save_png(plain, grade(render(scene, "poster_plain.png")))
    print("wrote", plain)


main()
