"""Mesh kit, procedural paint materials, batched direction renderer and contact-sheet tool for
tools/blender/vehicles.py and tools/blender/weapons.py.

Scene, camera, light, shadow catcher, supersampled grid render and the atlas packer all come from
tools/blender/common.py (never duplicated here).  This file only adds what the vehicle / weapon
scripts share:

  Kit            accumulates primitives (boxes, tapered boxes, prisms, extruded footprints,
                 cylinders, hatches) straight into ONE mesh with per-face materials
  paint / track / flat materials (procedural: mottling, dust on the lower hull, soft camouflage
                 bands, scorched knock-out variant with a sooty engine deck)
  render_dirs    N facings of one object in a few grid renders (one render = many cells)
  crop_union     trims the generous render cell to the union bbox and returns the new anchor
  contact sheets `python3 tools/blender/vehicles_common.py sheet-vehicles|sheet-weapons`
                 (plain Python + Pillow, composites exactly like the game is expected to)

Model frame: +Y forward (direction 0 = north), +X right, +Z up, ground z=0, metres.
"""
import json
import math
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

try:
    import bpy
    import bmesh
    from mathutils import Matrix, Euler, Vector
except ImportError:
    bpy = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SPRITES = os.path.join(ROOT, "public", "sprites")


# ------------------------------------------------------------------ footprints
def rect_fp(w, l, cy=0.0, cx=0.0):
    return [(cx - w / 2, cy - l / 2), (cx + w / 2, cy - l / 2), (cx + w / 2, cy + l / 2), (cx - w / 2, cy + l / 2)]


def rounded_fp(w, l, r, seg=4, cy=0.0, cx=0.0, r_front=None):
    """Rounded rectangle, CCW.  r_front overrides the corner radius of the two front (+Y) corners."""
    rf = r if r_front is None else r_front
    pts = []
    corners = [(w / 2 - r, -l / 2 + r, -90, r), (w / 2 - rf, l / 2 - rf, 0, rf),
               (-w / 2 + rf, l / 2 - rf, 90, rf), (-w / 2 + r, -l / 2 + r, 180, r)]
    for (px, py, a0, rr) in corners:
        for i in range(seg + 1):
            a = math.radians(a0 + 90.0 * i / seg)
            pts.append((cx + px + rr * math.cos(a), cy + py + rr * math.sin(a)))
    return pts


def ellipse_fp(w, l, seg=16, cy=0.0, cx=0.0):
    return [(cx + w / 2 * math.cos(2 * math.pi * i / seg), cy + l / 2 * math.sin(2 * math.pi * i / seg))
            for i in range(seg)]


def star_fp(r, cx=0.0, cy=0.0, inner=0.4):
    pts = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        rr = r if i % 2 == 0 else r * inner
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


# ------------------------------------------------------------------------- kit
class Kit:
    """Collects primitives into one mesh.  All rotations are XYZ euler DEGREES."""

    def __init__(self, name):
        self.name = name
        self.v, self.f, self.mi, self.sm = [], [], [], []
        self.mats = []
        self.xform = None       # optional Matrix applied to everything added from now on

    def _mat(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def add(self, verts, faces, mat, loc=(0, 0, 0), rot=(0, 0, 0), smooth=None):
        M = Matrix.Translation(Vector(loc)) @ Euler([math.radians(a) for a in rot], "XYZ").to_matrix().to_4x4()
        if self.xform is not None:
            M = self.xform @ M
        base = len(self.v)
        for p in verts:
            self.v.append(tuple(M @ Vector(p)))
        k = self._mat(mat)
        for i, fc in enumerate(faces):
            self.f.append(tuple(base + j for j in fc))
            self.mi.append(k)
            self.sm.append(bool(smooth[i]) if smooth else False)

    # ---- primitives
    def box(self, size, loc, mat, rot=(0, 0, 0), top=(1.0, 1.0), shift=(0.0, 0.0)):
        """Box centred at loc (size = x,y,z).  top scales the top face, shift offsets it (x,y)."""
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        tx, ty = sx * top[0], sy * top[1]
        dx, dy = shift
        vs = [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
              (-tx + dx, -ty + dy, sz), (tx + dx, -ty + dy, sz), (tx + dx, ty + dy, sz), (-tx + dx, ty + dy, sz)]
        fs = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        self.add(vs, fs, mat, loc, rot)

    def prism(self, profile, width, mat, x=0.0, width2=None, loc=(0, 0, 0), rot=(0, 0, 0)):
        """Side profile [(y,z)...] extruded across X (centre x).  width2: list of per-point widths."""
        n = len(profile)
        ws = width2 if width2 else [width] * n
        vs = [(x - ws[i] / 2, p[0], p[1]) for i, p in enumerate(profile)] + \
             [(x + ws[i] / 2, p[0], p[1]) for i, p in enumerate(profile)]
        fs = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
        for i in range(n):
            j = (i + 1) % n
            fs.append((i, j, n + j, n + i))
        self.add(vs, fs, mat, loc, rot)

    def extrude(self, fp, z0, z1, mat, scale=(1.0, 1.0), shift=(0.0, 0.0), smooth=False, loc=(0, 0, 0),
                rot=(0, 0, 0), centre=None):
        """Footprint [(x,y)...] from z0 to z1; the top is scaled about `centre` and shifted."""
        n = len(fp)
        if centre is None:
            centre = (sum(p[0] for p in fp) / n, sum(p[1] for p in fp) / n)
        vs = [(p[0], p[1], z0) for p in fp] + \
             [(centre[0] + (p[0] - centre[0]) * scale[0] + shift[0],
               centre[1] + (p[1] - centre[1]) * scale[1] + shift[1], z1) for p in fp]
        fs = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
        sm = [False, False]
        for i in range(n):
            j = (i + 1) % n
            fs.append((i, j, n + j, n + i))
            sm.append(smooth)
        self.add(vs, fs, mat, loc, rot, sm)

    def cyl(self, r, length, loc, mat, axis="Y", seg=12, r2=None, smooth=True, rot=None):
        """Cylinder centred at loc along axis X/Y/Z (r at the -axis end, r2 at the +axis end)."""
        r2 = r if r2 is None else r2
        vs, fs, sm = [], [], []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            vs.append((r * math.cos(a), r * math.sin(a), -length / 2))
        for i in range(seg):
            a = 2 * math.pi * i / seg
            vs.append((r2 * math.cos(a), r2 * math.sin(a), length / 2))
        fs.append(tuple(range(seg - 1, -1, -1))); sm.append(False)
        fs.append(tuple(range(seg, 2 * seg))); sm.append(False)
        for i in range(seg):
            j = (i + 1) % seg
            fs.append((i, j, seg + j, seg + i)); sm.append(smooth)
        if rot is None:
            rot = {"X": (0, 90, 0), "Y": (-90, 0, 0), "Z": (0, 0, 0)}[axis]
        self.add(vs, fs, mat, loc, rot, sm)

    def tube(self, p0, p1, r, mat, seg=8, r2=None):
        """Cylinder between two points (struts, bipod legs, trails, barrels at an elevation)."""
        a, b = Vector(p0), Vector(p1)
        d = b - a
        L = d.length
        if L < 1e-6:
            return
        q = d.to_track_quat("Z", "Y")
        e = q.to_euler("XYZ")
        self.cyl(r, L, tuple((a + b) / 2), mat, seg=seg, r2=r2, rot=tuple(math.degrees(x) for x in e))

    def hatch(self, size, loc, mat, open_deg=0.0, hinge="rear", hole="hole", thick=0.04, round_seg=0):
        """Flat hatch on a deck at loc (centre, z = deck height).  open_deg>0 swings it up about the
        hinge edge and leaves a dark opening."""
        w, l = size
        mat = "paint2" if mat == "paint" else mat
        if open_deg <= 0:
            if round_seg:
                self.extrude(ellipse_fp(w, l, round_seg, loc[1], loc[0]), loc[2], loc[2] + thick, mat)
            else:
                self.box((w, l, thick), (loc[0], loc[1], loc[2] + thick / 2), mat)
            return
        if round_seg:
            self.extrude(ellipse_fp(w * 0.9, l * 0.9, round_seg, loc[1], loc[0]), loc[2], loc[2] + 0.012, hole)
        else:
            self.box((w * 0.9, l * 0.9, 0.012), (loc[0], loc[1], loc[2] + 0.006), hole)
        a = open_deg
        if hinge == "rear":
            piv, rot, off = (loc[0], loc[1] - l / 2, loc[2]), (-a, 0, 0), (0, l / 2, 0)
        elif hinge == "front":
            piv, rot, off = (loc[0], loc[1] + l / 2, loc[2]), (a, 0, 0), (0, -l / 2, 0)
        elif hinge == "left":
            piv, rot, off = (loc[0] - w / 2, loc[1], loc[2]), (0, -a, 0), (w / 2, 0, 0)
        else:
            piv, rot, off = (loc[0] + w / 2, loc[1], loc[2]), (0, a, 0), (-w / 2, 0, 0)
        R = Euler([math.radians(x) for x in rot], "XYZ").to_matrix()
        c = Vector(piv) + R @ Vector((off[0], off[1], thick / 2))
        if round_seg:
            self.cyl(w / 2, thick, tuple(c), mat, seg=round_seg, rot=rot, smooth=False)
        else:
            self.box((w, l, thick), tuple(c), mat, rot=rot)

    def grille(self, size, loc, frame_mat, slat_mat="grille"):
        """Engine-deck air grille: a raised frame with a dark slatted inset."""
        w, l = size
        frame_mat = "paint2" if frame_mat == "paint" else frame_mat
        self.box((w, l, 0.05), (loc[0], loc[1], loc[2] + 0.025), frame_mat)
        self.box((w * 0.84, l * 0.84, 0.02), (loc[0], loc[1], loc[2] + 0.06), slat_mat)

    def cross(self, size, loc, rot=(0, 0, 0)):
        """Plain national marking: black cross with a white outline, lying in the local XY plane."""
        s = size
        M = Matrix.Translation(Vector(loc)) @ Euler([math.radians(a) for a in rot], "XYZ").to_matrix().to_4x4()
        old = self.xform
        self.xform = (old @ M) if old is not None else M
        self.box((s, s * 0.36, 0.006), (0, 0, 0.003), "white")
        self.box((s * 0.36, s, 0.006), (0, 0, 0.003), "white")
        self.box((s * 0.9, s * 0.2, 0.006), (0, 0, 0.008), "black")
        self.box((s * 0.2, s * 0.9, 0.006), (0, 0, 0.008), "black")
        self.xform = old

    def star(self, r, loc, rot=(0, 0, 0)):
        """Plain red star lying in the local XY plane."""
        fp = star_fp(r)
        n = len(fp)
        vs = [(p[0], p[1], 0.006) for p in fp] + [(0, 0, 0.006)]
        fs = [(i, (i + 1) % n, n) for i in range(n)]
        self.add(vs, fs, "red", loc, rot)

    # ---- finish
    def build(self, materials, collection=None):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.v, [], self.f)
        for m in self.mats:
            me.materials.append(materials[m])
        me.polygons.foreach_set("material_index", self.mi)
        me.polygons.foreach_set("use_smooth", self.sm)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        me.update()
        ob = bpy.data.objects.new(self.name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        return ob

    def bounds(self):
        a = np.array(self.v) if self.v else np.zeros((1, 3))
        return float(np.hypot(a[:, 0], a[:, 1]).max()), float(a[:, 2].max())


# ------------------------------------------------------------------- materials
def _lin(hexcol):
    h = hexcol.lstrip("#")
    return tuple(C._srgb_to_lin(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (1.0,)


def _nodes(name):
    m = bpy.data.materials.get(name)
    if m:
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    return m, nt, nt.nodes, nt.links, nt.nodes.get("Principled BSDF")


def _mix(nodes, links, fac, a, b, blend="MIX"):
    n = nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    n.blend_type = blend
    for sock, val in ((n.inputs[0], fac), (n.inputs[6], a), (n.inputs[7], b)):
        if hasattr(val, "links") or hasattr(val, "is_linked"):
            links.new(val, sock)
        else:
            sock.default_value = val
    return n.outputs[2]


def _ramp(nodes, links, src, lo, hi):
    n = nodes.new("ShaderNodeMapRange")
    n.inputs[1].default_value = lo
    n.inputs[2].default_value = hi
    n.interpolation_type = "SMOOTHSTEP"
    links.new(src, n.inputs[0])
    return n.outputs[0]


def paint_material(name, base, dust="#8a7d60", camo=None, dust_top=0.9, rough=0.85, dust_amt=0.6,
                   scorch=None, soot_at=None, mottle=0.2, gain=1.0):
    """Painted armour.  camo = [(hex, threshold_lo, threshold_hi, noise_seed_offset)...] soft bands.
    scorch = (dark_hex, rust_hex) turns it into the knocked-out burnt finish; soot_at = (x, y, radius)
    blackens the engine deck (object coordinates)."""
    m, nt, nodes, links, bsdf = _nodes(name)
    tc = nodes.new("ShaderNodeTexCoord")
    obj = tc.outputs["Object"]
    col = _lin(base)
    out = None
    if camo:
        cur = col
        for i, (hexc, lo, hi, off) in enumerate(camo):
            mp = nodes.new("ShaderNodeMapping")
            mp.inputs["Location"].default_value = (off, off * 1.7, 0)
            mp.inputs["Rotation"].default_value = (0, 0, 0.6 + i)
            mp.inputs["Scale"].default_value = (1.0, 0.55, 0.5)
            links.new(obj, mp.inputs[0])
            nz = nodes.new("ShaderNodeTexNoise")
            nz.inputs["Scale"].default_value = 0.85
            nz.inputs["Detail"].default_value = 1.5
            nz.inputs["Distortion"].default_value = 0.6
            links.new(mp.outputs[0], nz.inputs["Vector"])
            f = _ramp(nodes, links, nz.outputs[0], lo, hi)
            cur = _mix(nodes, links, f, cur, _lin(hexc))
        out = cur
    else:
        out = col
    # mottling (paint wear / stains)
    nz = nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 4.0
    nz.inputs["Detail"].default_value = 3.0
    links.new(obj, nz.inputs["Vector"])
    f = _ramp(nodes, links, nz.outputs[0], 0.35, 0.75)
    fm = nodes.new("ShaderNodeMath"); fm.operation = "MULTIPLY"; fm.inputs[1].default_value = mottle
    links.new(f, fm.inputs[0])
    out = _mix(nodes, links, fm.outputs[0], out, (0.02, 0.02, 0.018, 1))
    if scorch:
        dark, rust = scorch
        nz2 = nodes.new("ShaderNodeTexNoise")
        nz2.inputs["Scale"].default_value = 1.6
        nz2.inputs["Detail"].default_value = 3.0
        links.new(obj, nz2.inputs["Vector"])
        f2 = _ramp(nodes, links, nz2.outputs[0], 0.3, 0.7)
        burnt = _mix(nodes, links, f2, _lin(dark), _lin(rust))
        # a little of the old paint survives in patches
        nz3 = nodes.new("ShaderNodeTexNoise")
        nz3.inputs["Scale"].default_value = 0.9
        links.new(obj, nz3.inputs["Vector"])
        f3 = _ramp(nodes, links, nz3.outputs[0], 0.52, 0.72)
        f3m = nodes.new("ShaderNodeMath"); f3m.operation = "MULTIPLY"; f3m.inputs[1].default_value = 0.45
        links.new(f3, f3m.inputs[0])
        out = _mix(nodes, links, f3m.outputs[0], burnt, out)
    # dust: strong on the lower hull, a breath on everything
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(obj, sep.inputs[0])
    fz = _ramp(nodes, links, sep.outputs[2], dust_top, 0.15)
    fzm = nodes.new("ShaderNodeMath"); fzm.operation = "MULTIPLY"; fzm.inputs[1].default_value = dust_amt
    links.new(fz, fzm.inputs[0])
    fza = nodes.new("ShaderNodeMath"); fza.operation = "ADD"; fza.inputs[1].default_value = 0.06
    links.new(fzm.outputs[0], fza.inputs[0])
    dustc = _lin(dust) if not scorch else _lin("#4a443a")
    out = _mix(nodes, links, fza.outputs[0], out, dustc)
    if soot_at:
        sx, sy, sr = soot_at
        mp = nodes.new("ShaderNodeMapping")
        mp.inputs["Location"].default_value = (-sx, -sy, 0)
        mp.inputs["Scale"].default_value = (1, 1, 0)
        links.new(obj, mp.inputs[0])
        ln = nodes.new("ShaderNodeVectorMath"); ln.operation = "LENGTH"
        links.new(mp.outputs[0], ln.inputs[0])
        fs = _ramp(nodes, links, ln.outputs["Value"], sr, sr * 0.35)
        fsm = nodes.new("ShaderNodeMath"); fsm.operation = "MULTIPLY"; fsm.inputs[1].default_value = 0.9
        links.new(fs, fsm.inputs[0])
        out = _mix(nodes, links, fsm.outputs[0], out, _lin("#0b0a09"))
    if gain != 1.0:
        out = _mix(nodes, links, 1.0, out, (gain, gain, gain, 1.0), blend="MULTIPLY")
    links.new(out, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    try:
        bsdf.inputs["Specular IOR Level"].default_value = 0.25
    except Exception:
        pass
    return m


def track_material(name, base="#2b2926", dust="#7d7259", pitch=0.17, burnt=False):
    """Dark steel track with link bands hinted across the run (bands along Y in object space)."""
    m, nt, nodes, links, bsdf = _nodes(name)
    tc = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(tc.outputs["Object"], sep.inputs[0])
    mul = nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = 1.0 / pitch
    links.new(sep.outputs[1], mul.inputs[0])
    fr = nodes.new("ShaderNodeMath"); fr.operation = "FRACT"
    links.new(mul.outputs[0], fr.inputs[0])
    f = _ramp(nodes, links, fr.outputs[0], 0.55, 0.75)
    band = _mix(nodes, links, f, _lin(base), _lin("#0e0d0c"))
    fz = _ramp(nodes, links, sep.outputs[2], 0.7, 0.05)
    fzm = nodes.new("ShaderNodeMath"); fzm.operation = "MULTIPLY"; fzm.inputs[1].default_value = 0.2 if burnt else 0.5
    links.new(fz, fzm.inputs[0])
    fza = nodes.new("ShaderNodeMath"); fza.operation = "ADD"; fza.inputs[1].default_value = 0.0 if burnt else 0.15
    links.new(fzm.outputs[0], fza.inputs[0])
    out = _mix(nodes, links, fza.outputs[0], band, _lin(dust))
    links.new(out, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.7
    bsdf.inputs["Metallic"].default_value = 0.3
    return m


def flat_material(name, hexcol, rough=0.8, metallic=0.0):
    return C.make_material(name, hexcol, rough, metallic)


def common_materials(mats, burnt=False):
    """Materials every model can use (mats is the dict handed to Kit.build)."""
    k = 0.55 if burnt else 1.0

    def sc(h):
        hh = h.lstrip("#")
        return "#" + "".join("%02x" % int(int(hh[i:i + 2], 16) * k) for i in (0, 2, 4))
    sfx = "_ko" if burnt else ""
    mats["hole"] = flat_material("hole" + sfx, "#060605", 1.0)
    mats["grille"] = flat_material("grille" + sfx, "#15140f" if not burnt else "#070706", 0.9)
    mats["black"] = flat_material("blackm" + sfx, "#121212", 0.7)
    mats["white"] = flat_material("whitem" + sfx, sc("#e6e4da"), 0.8)
    mats["red"] = flat_material("redm" + sfx, sc("#b3261c"), 0.8)
    mats["steel"] = flat_material("steel" + sfx, sc("#3a3c38"), 0.45, 0.6)
    mats["gunmetal"] = flat_material("gunmetal" + sfx, sc("#2a2b28"), 0.4, 0.7)
    mats["rubber"] = flat_material("rubber" + sfx, "#191917", 0.9)
    mats["wood"] = flat_material("wood" + sfx, sc("#6c5332") if not burnt else "#1c1712", 0.9)
    mats["canvas"] = flat_material("canvas" + sfx, sc("#6e6a4e"), 1.0)
    mats["brass"] = flat_material("brass" + sfx, sc("#a88f48"), 0.4, 0.8)
    mats["leather"] = flat_material("leather" + sfx, sc("#4a3626"), 0.8)
    mats["rust"] = flat_material("rust" + sfx, sc("#5a3a26"), 0.9)
    mats["floor"] = flat_material("floor" + sfx, sc("#3a3a34"), 0.9)
    mats["track"] = track_material("track" + sfx, burnt=burnt)
    return mats


# ------------------------------------------------------------------- rendering
def best_grid(n, cell_px, max_px=4096):
    """Columns x rows for n cells so that one render stays below max_px on a side."""
    cols = max(1, min(n, max_px // cell_px))
    per = cols * max(1, max_px // cell_px)
    return cols, per


def use_gpu(scene):
    """Cycles on the GPU (Metal/OptiX/...) when one is available; silently stays on the CPU otherwise."""
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for t in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = t
            except Exception:
                continue
            prefs.get_devices()
            devs = [dv for dv in prefs.devices if dv.type == t]
            if devs:
                for dv in prefs.devices:
                    dv.use = dv.type == t
                scene.cycles.device = "GPU"
                return True
    except Exception:
        pass
    return False


def ground_y_factor(ctx):
    """Measured screen-y pixels per (px_per_m * metre) of ground along world +Y.  common.py documents
    this as exactly 1 (pixel-aspect compensation) but Blender 5.2 renders it as cos(tilt) = 0.978, so
    objects placed at ctx.cell_origin() in grid rows away from the image centre miss their anchor by
    2.2 % of their distance from the centre.  Measuring it keeps us right whichever way common.py goes."""
    from bpy_extras.object_utils import world_to_camera_view
    bpy.context.view_layer.update()
    sc = ctx.scene
    p0 = world_to_camera_view(sc, ctx.camera, Vector((0, 0, 0)))
    p1 = world_to_camera_view(sc, ctx.camera, Vector((0, 10, 0)))
    px = (p1.y - p0.y) * sc.render.resolution_y / ctx.supersample
    return px / (10.0 * ctx.px_per_m)


def render_dirs(objs_fn, dirs, px_per_m, cell, anchor, shadow, engine="CYCLES", samples=24,
                supersample=2, max_px=4096, log=None, device="GPU"):
    """Render `dirs` facings.  objs_fn(ctx) is called after each setup_scene (which wipes the file)
    and must (re)build the model and return a list of (object, camera_visible) to be instanced per
    facing; the first placement reuses the objects themselves.  Returns [rgba per dir]."""
    ss_cell = cell
    cols = max(1, min(dirs, max_px // (ss_cell * supersample)))
    rows_max = max(1, max_px // (ss_cell * supersample))
    out = []
    d0 = 0
    while d0 < dirs:
        n = min(dirs - d0, cols * rows_max)
        rows = -(-n // cols)
        ctx = C.setup_scene(px_per_m, cell, cell, anchor=anchor, grid=(cols, rows), supersample=supersample,
                            shadow=shadow, engine=engine, samples=samples)
        if engine == "CYCLES" and device == "GPU":
            use_gpu(ctx.scene)
        protos = objs_fn(ctx)
        ky = ground_y_factor(ctx)
        for i in range(n):
            d = d0 + i
            x, y = ctx.cell_origin(i % cols, i // cols)
            y /= ky
            for (ob, cam_vis) in protos:
                o = ob if i == 0 else ob.copy()
                if i != 0:
                    ctx.scene.collection.objects.link(o)
                o.location = (x, y, 0.0)
                o.rotation_euler = (0, 0, C.dir_angle(d, dirs))
                o.visible_camera = cam_vis
        cells = C.render_grid(ctx)
        shutil.rmtree(os.path.dirname(ctx._tmp), ignore_errors=True)
        for i in range(n):
            out.append(cells[i // cols][i % cols])
        if log:
            log("   rendered dirs %d..%d (%dx%d grid)" % (d0, d0 + n - 1, cols, rows))
        d0 += n
    return out


def crop_union(entries, anchor, pad=1, thresh=6):
    """entries: {key: [rgba per dir]} all the same cell size.  Crops every cell to the union alpha
    bbox (+pad) and returns (entries, (w, h), new_anchor).  Width/height are made even."""
    x0 = y0 = 10 ** 9
    x1 = y1 = -1
    entries = {k: [clean_cell(im) for im in frames] for k, frames in entries.items()}
    for frames in entries.values():
        for im in frames:
            ys, xs = np.where(im[..., 3] > thresh)
            if len(xs):
                x0, x1 = min(x0, xs.min()), max(x1, xs.max())
                y0, y1 = min(y0, ys.min()), max(y1, ys.max())
    h, w = next(iter(entries.values()))[0].shape[:2]
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(w - 1, x1 + pad), min(h - 1, y1 + pad)
    if (x1 - x0 + 1) % 2:
        x1 = min(w - 1, x1 + 1) if x1 < w - 1 else x1
        if (x1 - x0 + 1) % 2:
            x0 -= 1
    if (y1 - y0 + 1) % 2:
        y1 = min(h - 1, y1 + 1) if y1 < h - 1 else y1
        if (y1 - y0 + 1) % 2:
            y0 -= 1
    out = {k: [im[y0:y1 + 1, x0:x1 + 1].copy() for im in frames] for k, frames in entries.items()}
    return out, (int(x1 - x0 + 1), int(y1 - y0 + 1)), (int(anchor[0] - x0), int(anchor[1] - y0))


SHADOW_GAIN = 0.8      # Cycles' catcher shadow peaks near 0.78 alpha; bring it to ~common.SHADOW_DARKNESS


def clean_cell(a):
    """Post-process one RGBA cell: drop near-invisible alpha, recolour the pure-shadow pixels to
    common.SHADOW_RGB, scale and quantise their alpha (kills the render noise that bloats the PNG)."""
    a = a.copy()
    al = a[..., 3].astype(np.int32)
    shadow = (a[..., :3].astype(np.int32).sum(-1) < 40) & (al < 250)
    al = np.where(al < 10, 0, al)
    al = np.where(shadow, (al * SHADOW_GAIN).astype(np.int32) // 8 * 8, al)
    a[..., 3] = al.astype(np.uint8)
    a[..., :3][shadow] = C.SHADOW_RGB
    a[..., :3][a[..., 3] == 0] = 0
    return a


# ------------------------------------------------------------- atlas utilities
class Atlas:
    """Reader used by the contact sheets (plain Python)."""

    def __init__(self, base):
        from PIL import Image
        with open(base + ".json") as fh:
            self.meta = json.load(fh)
        self.img = Image.open(base + ".png").convert("RGBA")
        self.cw, self.ch = self.meta["cell"]["w"], self.meta["cell"]["h"]
        self.ax, self.ay = self.meta["anchor"]["x"], self.meta["anchor"]["y"]

    def cell(self, key, d, frame=0):
        e = self.meta["entries"][key]
        i = e["start"] + d * e["frames"] + frame
        cx, cy = i % self.meta["columns"], i // self.meta["columns"]
        return self.img.crop((cx * self.cw, cy * self.ch, (cx + 1) * self.cw, (cy + 1) * self.ch))

    def draw(self, dst, key, d, x, y):
        """Composite like the game: the anchor pixel lands on (x, y)."""
        c = self.cell(key, d)
        px, py = int(round(x - self.ax)), int(round(y - self.ay))
        sx, sy = max(0, -px), max(0, -py)
        if sx < c.width and sy < c.height:
            dst.alpha_composite(c.crop((sx, sy, c.width, c.height)), (px + sx, py + sy))


def draw_vehicle(dst, atlas, vid, hull_dir, turret_dir, x, y, state="ok"):
    """THE composition rule (game side must match):
       hull cell anchor at (x, y); turret cell anchor at (x, y) + R(hullFacing) * turretPivotM * ppm,
       where turretPivotM = {x: metres to the vehicle's right, y: metres FORWARD}; on screen (y down)
       the unrotated offset is (x, -y) and R rotates it clockwise by the hull facing."""
    m = atlas.meta
    ppm = 10 * m["scale"]
    atlas.draw(dst, vid + ".hull." + state, hull_dir, x, y)
    if (vid + ".turret." + state) in m["entries"]:
        p = m["turretPivotM"][vid] if vid in m.get("turretPivotM", {}) else m["turretPivotM"]
        a = 2 * math.pi * hull_dir / m["dirs"]
        sx, sy = p["x"], -p["y"]
        rx = sx * math.cos(a) - sy * math.sin(a)
        ry = sx * math.sin(a) + sy * math.cos(a)
        atlas.draw(dst, vid + ".turret." + state, turret_dir, x + rx * ppm, y + ry * ppm)


def _bg(path, box, w, h):
    from PIL import Image
    im = Image.open(path).convert("RGBA")
    x0, y0 = box
    tile = im.crop((x0, y0, x0 + min(w, im.width - x0), y0 + min(h, 560 - y0)))
    out = Image.new("RGBA", (w, h))
    for yy in range(0, h, tile.height):
        for xx in range(0, w, tile.width):
            out.paste(tile, (xx, yy))
    return out


GRASS = (os.path.join(ROOT, "ref/wf18/full_steppe_grass_z1.png"), (40, 40))
SNOW = (os.path.join(ROOT, "ref/wf18/full_moscow_snow_z1.png"), (40, 40))


def sheet_vehicles(ids, scale, out_path, state="ok", zoom=1):
    """One row per vehicle; columns = hull/turret angle combinations; left half grass, right snow."""
    from PIL import Image
    combos = [(0, 0), (8, 8), (16, 24), (27, 20), (32, 40), (45, 45), (56, 3)]
    ppm = 10 * scale
    step = int(11.5 * ppm)
    W, H = step * len(combos) * 2, int(10.5 * ppm) * len(ids)
    sheet = Image.new("RGBA", (W, H))
    half = step * len(combos)
    sheet.paste(_bg(GRASS[0], GRASS[1], half, H) if scale == 1 else
                _bg(GRASS[0], GRASS[1], half // 2 + 1, H // 2 + 1).resize((half, H), Image.NEAREST), (0, 0))
    sheet.paste(_bg(SNOW[0], SNOW[1], half, H) if scale == 1 else
                _bg(SNOW[0], SNOW[1], half // 2 + 1, H // 2 + 1).resize((half, H), Image.NEAREST), (half, 0))
    for r, vid in enumerate(ids):
        base = os.path.join(SPRITES, "vehicles_%s_%d" % (vid, scale))
        if not os.path.exists(base + ".json"):
            continue
        at = Atlas(base)
        for side in range(2):
            for c, (hd, td) in enumerate(combos):
                x = side * half + c * step + step // 2
                y = r * int(10.5 * ppm) + int(5.5 * ppm)
                nd = at.meta["dirs"]
                draw_vehicle(sheet, at, vid, hd * nd // 64, td * nd // 64, x, y, state)
    if zoom != 1:
        sheet = sheet.resize((W * zoom, H * zoom), Image.NEAREST)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sheet.convert("RGB").save(out_path)
    return out_path


def sheet_weapons(ids, scale, out_path, zoom=1):
    from PIL import Image
    ppm = 10 * scale
    at = Atlas(os.path.join(SPRITES, "weapons_%d" % scale))
    dirs = at.meta["dirs"]
    cols = [("setup", 0), ("setup", 11), ("limbered", 4), ("trailsClosed", 4), ("trailLeftOpen", 4), ("trailRightOpen", 4),
            ("trailsOpen", 4), ("emplaced", 4), ("recoil", 4), ("baseplate", 4), ("tube", 4), ("tripod", 4), ("half", 27), ("packed", 18)]
    step = int(7.5 * ppm)
    ncol = 9
    W, H = step * ncol * 2, step * len(ids)
    half = step * ncol
    sheet = Image.new("RGBA", (W, H))
    for k, bg in enumerate((GRASS, SNOW)):
        b = _bg(bg[0], bg[1], half // scale + 1, H // scale + 1).resize(((half // scale + 1) * scale, (H // scale + 1) * scale), Image.NEAREST)
        sheet.paste(b.crop((0, 0, half, H)), (k * half, 0))
    for r, wid in enumerate(ids):
        for side in range(2):
            c = 0
            for (st, d) in cols:
                key = "%s.%s" % (wid, st)
                if key in at.meta["entries"] and c < ncol:
                    at.draw(sheet, key, d * dirs // 32, side * half + c * step + step // 2, r * step + step // 2)
                    c += 1
    if zoom != 1:
        sheet = sheet.resize((W * zoom, H * zoom), Image.NEAREST)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sheet.convert("RGB").save(out_path)
    return out_path


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["sheet-vehicles", "sheet-weapons"])
    ap.add_argument("--only", default="")
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--zoom", type=int, default=1)
    ap.add_argument("--state", default="ok")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    if a.cmd == "sheet-vehicles":
        with open(os.path.join(SPRITES, "vehicles_%d.json" % a.scale)) as fh:
            ids = list(json.load(fh)["vehicles"].keys())
        if a.only:
            ids = [i for i in a.only.split(",") if i]
        out = a.out or os.path.join(ROOT, "ref/wf22", "vehicles_%s_s%d_z%d.png" % (a.state, a.scale, a.zoom))
        print(sheet_vehicles(ids, a.scale, out, a.state, a.zoom))
    else:
        with open(os.path.join(SPRITES, "weapons_%d.json" % a.scale)) as fh:
            ids = sorted({k.split(".")[0] for k in json.load(fh)["entries"]})
        if a.only:
            ids = [i for i in a.only.split(",") if i]
        out = a.out or os.path.join(ROOT, "ref/wf22", "weapons_s%d_z%d.png" % (a.scale, a.zoom))
        print(sheet_weapons(ids, a.scale, out, a.zoom))
