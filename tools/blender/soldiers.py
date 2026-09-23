"""Soldier sprite atlases: procedural infantryman, keyframed poses, 16 facings, 4 palettes, 2 scales.

Run headless:
  blender -b -P tools/blender/soldiers.py -- [--side german|soviet|all] [--season summer|winter|all]
          [--scale 1|2|all] [--only PATTERN[,PATTERN]] [--force] [--pack-only] [--jobs N] [--list]

Every entry is rendered once per atlas as a strip (16 facings x frames) into
tools/blender/.cache/<atlas>/<key>.png, then all cached strips are packed into
public/sprites/soldiers_<side>_<season>_<scale>.png/.json.  Re-running skips cached entries
(resumable); --only re-renders just the matching keys (fnmatch or prefix) and re-packs; --force
re-renders everything selected.  --jobs N runs the atlases as N parallel Blender processes.

All geometry is original and built here from primitives.  Figure faces +Y; see common.py.
"""
import fnmatch
import json
import math
import os
import subprocess
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(ROOT, "public", "sprites")
CACHE_DIR = os.path.join(HERE, ".cache")

DIRS = 16
MAX_FRAMES = 8             # grid rows per render (gaits use all 8)
CELL = 36                  # px at scale 1 (3.6 m); scale 2 -> 72
ANCHOR = (18, 19)          # px at scale 1
COLUMNS = 96
FIG = 1.30                 # sprite-art enlargement of the whole figure (reads at ~17 px, like the old sprites)
HEAD = 1.15                # extra head/helmet enlargement
OUTLINE_ALPHA = 0.5        # dark 1px rim for legibility on the painted ground (0 = off)

# ------------------------------------------------------------------------------------------
# palettes (sRGB)
# ------------------------------------------------------------------------------------------
PALETTES = {
    ("german", "summer"): dict(
        tunic=("#72775f", 0.92), trousers=("#696c5a", 0.95), helmet=("#434a42", 0.6),
        skin=("#e2b08c", 0.6), leather=("#2a2522", 0.5), boots=("#1f1c1a", 0.45),
        wood=("#6a4628", 0.6), metal=("#34373b", 0.4), pack=("#6c6750", 0.92),
        roll=("#4a5244", 0.92), glove=("#d0a07e", 0.7), gear=("#3a403d", 0.7), brass=("#b89040", 0.35), hair=("#4a3a2a", 0.8), blood=("#5a1a16", 0.45), tread=("#2b1614", 0.8)),
    ("german", "winter"): dict(
        tunic=("#a3a8ac", 0.95), trousers=("#969ca1", 0.95), helmet=("#aab0b3", 0.65),
        skin=("#e2b08c", 0.6), leather=("#2a2522", 0.5), boots=("#262220", 0.45),
        wood=("#6a4628", 0.6), metal=("#34373b", 0.4), pack=("#4f5751", 0.92),
        roll=("#46504a", 0.92), glove=("#4a524d", 0.85), gear=("#3a403d", 0.7), brass=("#b89040", 0.35), hair=("#4a3a2a", 0.8), blood=("#5a1a16", 0.45), tread=("#2b1614", 0.8)),
    ("soviet", "summer"): dict(
        tunic=("#8c7a4c", 0.92), trousers=("#7b6b45", 0.95), helmet=("#4f5a30", 0.6),
        skin=("#e2b08c", 0.6), leather=("#6b4424", 0.5), boots=("#2b231d", 0.5),
        wood=("#7a4e26", 0.6), metal=("#363638", 0.4), pack=("#786d48", 0.92),
        roll=("#6c6456", 0.92), glove=("#d0a07e", 0.7), gear=("#3e4629", 0.7), brass=("#b89040", 0.35), hair=("#4a3a2a", 0.8), blood=("#5a1a16", 0.45), tread=("#2b1614", 0.8)),
    ("soviet", "winter"): dict(
        tunic=("#afa895", 0.95), trousers=("#a39c89", 0.95), helmet=("#b3ad9a", 0.65),
        skin=("#e2b08c", 0.6), leather=("#6b4424", 0.5), boots=("#4a4136", 0.7),
        wood=("#7a4e26", 0.6), metal=("#363638", 0.4), pack=("#6f6443", 0.92),
        roll=("#5e574b", 0.92), glove=("#5e4630", 0.85), gear=("#3e4629", 0.7), brass=("#b89040", 0.35), hair=("#4a3a2a", 0.8), blood=("#5a1a16", 0.45), tread=("#2b1614", 0.8)),
}

import kit as K  # noqa: E402
from kit import MeshB, Rx, Ry, Rz, T, S  # noqa: E402

for _pal in PALETTES.values():      # side-neutral scorched vehicle debris
    _pal.update(burnt=("#33302c", 0.75), rust=("#6e4429", 0.85), bare=("#8d9094", 0.35), rubber=("#1e1e1e", 0.9))

# ------------------------------------------------------------------------------------------
# the figure (dimensions in metres before FIG scaling)
# ------------------------------------------------------------------------------------------
HIP = Vector((0.10, 0.0, -0.03))
CHEST_PIVOT = Vector((0, 0, 0.10))
SHOULDER = Vector((0.235, 0.0, 0.40))
NECK = Vector((0, 0.0, 0.46))
L_UARM, L_FARM = 0.29, 0.27
L_THIGH, L_SHIN = 0.44, 0.43
ANKLE = 0.08


DEBRIS = ("plate0", "plate1", "plate2", "wheel0", "wheel1", "wheel2", "hatch0", "hatch1", "hatch2")


def build_debris_meshes():
    """Vehicle wreck debris for the parts atlas, TRUE scale (vehicles are not enlarged like the men):
    built in metres and shrunk by 1/FIG because the rig root scales everything by FIG."""
    M = {}
    k = 1.0 / FIG

    def fin(b):
        M[b.name] = b.finish(scale=k)

    b = MeshB("plate0")                 # torn plate, one end bent up
    b.box("burnt", (0.80, 0.55, 0.045), (-0.10, 0, 0.04), rot=(0, 4, 0), bevel=0.01)
    b.box("burnt", (0.36, 0.50, 0.045), (0.40, 0.02, 0.13), rot=(0, -32, 8), bevel=0.01)
    b.box("bare", (0.80, 0.035, 0.05), (-0.10, 0.275, 0.042), rot=(0, 4, 0), bevel=0.004)
    b.box("rust", (0.05, 0.50, 0.05), (-0.50, 0, 0.07), rot=(0, 4, 10), bevel=0.004)
    fin(b)
    b = MeshB("plate1")                 # small jagged fragment
    b.box("burnt", (0.52, 0.40, 0.04), (0, 0, 0.04), rot=(6, 0, 20), bevel=0.01)
    b.box("burnt", (0.24, 0.22, 0.04), (0.26, 0.20, 0.10), rot=(-30, -25, 50), bevel=0.01)
    b.box("rust", (0.50, 0.04, 0.045), (-0.06, -0.18, 0.045), rot=(6, 0, 20), bevel=0.004)
    b.box("bare", (0.04, 0.30, 0.045), (-0.24, 0.02, 0.05), rot=(6, 0, 20), bevel=0.004)
    fin(b)
    b = MeshB("plate2")                 # long twisted strip (track guard / side skirt)
    for i_, (x, tw, zz) in enumerate(((-0.40, -14, 0.05), (0.0, 6, 0.07), (0.38, 30, 0.13))):
        b.box("burnt", (0.42, 0.32, 0.035), (x, 0.02 * i_, zz), rot=(tw, -6 * i_, 4 * i_), bevel=0.008)
    b.box("bare", (1.10, 0.03, 0.04), (0, 0.17, 0.08), rot=(8, -5, 3), bevel=0.004)
    b.box("rust", (0.30, 0.10, 0.04), (-0.35, -0.08, 0.075), rot=(-14, 0, 0), bevel=0.004)
    fin(b)

    b = MeshB("wheel0")                 # road wheel with rubber tyre
    b.xf = T((0, 0, 0.08)) @ Rx(9)
    b.tube("rubber", 0.34, 0.34, (0, 0, -0.06), (0, 0, 0.06), segs=18)
    b.tube("burnt", 0.26, 0.25, (0, 0, -0.065), (0, 0, 0.075), segs=16)
    b.tube("bare", 0.09, 0.07, (0, 0, 0.07), (0, 0, 0.12), segs=10)
    for i_ in range(6):
        a_ = i_ * math.pi / 3
        b.ball("rubber", (0.035, 0.035, 0.02), (0.17 * math.cos(a_), 0.17 * math.sin(a_), 0.078), segs=6, rings=4)
    fin(b)
    b = MeshB("wheel1")                 # bare steel road wheel, tyre burnt off
    b.xf = T((0, 0, 0.07)) @ Rx(-7) @ Ry(5)
    b.tube("rust", 0.33, 0.33, (0, 0, -0.05), (0, 0, 0.05), segs=18)
    b.torus("bare", 0.33, 0.025, (0, 0, 0.05), seg=18, sides=6)
    b.tube("burnt", 0.24, 0.22, (0, 0, 0.04), (0, 0, 0.07), segs=16)
    b.tube("bare", 0.08, 0.06, (0, 0, 0.06), (0, 0, 0.11), segs=10)
    fin(b)
    b = MeshB("wheel2")                 # drive sprocket
    b.xf = T((0, 0, 0.07)) @ Rx(6)
    b.tube("burnt", 0.30, 0.30, (0, 0, -0.05), (0, 0, 0.05), segs=18)
    for i_ in range(14):
        a_ = i_ * 2 * math.pi / 14
        b.box("bare", (0.10, 0.06, 0.10), (0.33 * math.cos(a_), 0.33 * math.sin(a_), 0), rot=(0, 0, math.degrees(a_)), bevel=0.01)
    b.tube("rust", 0.16, 0.13, (0, 0, 0.05), (0, 0, 0.10), segs=12)
    b.tube("bare", 0.06, 0.05, (0, 0, 0.10), (0, 0, 0.14), segs=8)
    fin(b)

    b = MeshB("hatch0")                 # round cupola hatch
    b.xf = T((0, 0, 0.05)) @ Rx(8) @ Ry(-5)
    b.tube("burnt", 0.31, 0.31, (0, 0, -0.025), (0, 0, 0.025), segs=18)
    b.ball("burnt", (0.27, 0.27, 0.06), (0, 0, 0.025), segs=16, rings=6)
    b.torus("bare", 0.31, 0.018, (0, 0, 0.025), seg=18, sides=5)
    b.box("rust", (0.16, 0.10, 0.06), (0, -0.33, 0.0), bevel=0.01)
    b.box("bare", (0.14, 0.03, 0.04), (0, 0.10, 0.09), bevel=0.006)
    fin(b)
    b = MeshB("hatch1")                 # rectangular hull hatch
    b.xf = T((0, 0, 0.05)) @ Rx(-6) @ Ry(7)
    b.box("burnt", (0.72, 0.50, 0.05), (0, 0, 0), bevel=0.03)
    b.box("burnt", (0.60, 0.38, 0.02), (0, 0, 0.035), bevel=0.01)
    b.box("rust", (0.22, 0.14, 0.022), (-0.15, 0.08, 0.036), rot=(0, 0, 20), bevel=0.01)
    b.box("bare", (0.72, 0.03, 0.055), (0, 0.25, 0.0), bevel=0.004)
    b.box("bare", (0.16, 0.03, 0.04), (0.12, -0.08, 0.06), bevel=0.006)
    for x in (-0.22, 0.22):
        b.box("burnt", (0.08, 0.10, 0.06), (x, -0.28, 0.0), bevel=0.01)
    fin(b)
    b = MeshB("hatch2")                 # engine deck grille piece
    b.xf = T((0, 0, 0.05)) @ Rx(5) @ Ry(-9)
    for y in (-0.24, 0.24):
        b.box("burnt", (0.84, 0.05, 0.06), (0, y, 0), bevel=0.008)
    for x in (-0.40, 0.40):
        b.box("burnt", (0.05, 0.50, 0.06), (x, 0, 0), bevel=0.008)
    for i_ in range(7):
        b.box("bare" if i_ == 2 else "rust" if i_ % 3 == 0 else "burnt", (0.035, 0.46, 0.05), (-0.30 + i_ * 0.10, 0, 0.0), rot=(0, 35, 0), bevel=0.004)
    fin(b)
    return M


def build_meshes(side):
    g = side == "german"
    M = {}
    # pelvis: hips, tunic skirt, belt, pouches, hip gear (kit from kit.py, same meshes as the ground items)
    b = MeshB("pelvis")
    b.ball("trousers", (0.165, 0.125, 0.13), (0, 0, -0.06))
    b.tube("tunic", 0.20, 0.165, (0, 0, -0.15), (0, 0, 0.10), sxy=(1, 0.72), segs=14)
    b.tube("leather", 0.172, 0.172, (0, 0, 0.065), (0, 0, 0.115), sxy=(1, 0.74), segs=14)
    b.box("metal", (0.05, 0.02, 0.04), (0, 0.127, 0.09), bevel=0.004)
    if g:
        for sx in (-1, 1):
            b.xf = T((sx * 0.095, 0.125, 0.06)); K.k_pouch(b, True)
        b.xf = T((0.09, -0.15, -0.03)) @ Rz(-12); K.k_breadbag(b)
        b.xf = T((0.14, -0.20, -0.03)); K.k_canteen(b, True)
        b.xf = T((-0.10, -0.16, -0.03)); K.k_canister(b)
        b.xf = T((-0.19, 0.0, -0.10)) @ Ry(90) @ Rx(0); K.k_tool(b)
    else:
        b.xf = T((0.10, 0.125, 0.06)); K.k_pouch(b, False)
        b.xf = T((-0.10, 0.125, 0.055)); K.k_pouch(b, False)
        b.xf = T((0.12, -0.17, -0.03)); K.k_canteen(b, False)
        b.xf = T((-0.12, -0.14, -0.05)); K.k_gasbag(b)
        b.xf = T((0.19, 0.0, -0.10)) @ Ry(90); K.k_tool(b)
    b.xf = Matrix.Identity(4)
    M["pelvis"] = b.finish()

    # chest: torso, shoulders, collar, back gear
    b = MeshB("chest")
    b.tube("tunic", 0.165, 0.205, (0, 0, -0.02), (0, 0, 0.36), sxy=(1, 0.64), segs=14)
    b.ball("tunic", (0.262, 0.125, 0.085), (0, 0, 0.385), segs=14)
    b.tube("tunic", 0.075, 0.062, (0, 0.005, 0.40), (0, 0.005, 0.475), segs=10)                 # collar
    K.k_pack(b, g)
    if g:
        for sx in (-1, 1):
            b.box("leather", (0.028, 0.012, 0.36), (sx * 0.09, 0.128, 0.22), rot=(0, sx * 8, 0), bevel=0.003)
    else:
        K.k_greatcoat_roll(b)
    M["chest"] = b.finish()

    # head: neck, head, helmet.  Scaled HEAD about the neck pivot.
    for nm in ("head", "headbare"):
        b = MeshB(nm)
        b.tube("skin", 0.052, 0.05, (0, 0, -0.03), (0, 0, 0.06), segs=8)
        b.ball("skin", (0.092, 0.105, 0.11), (0, 0.012, 0.125))
        b.ball("skin", (0.018, 0.022, 0.02), (0, 0.118, 0.10), segs=6, rings=4)                 # nose
        if nm == "head":
            K.k_helmet(b, g)
        else:
            b.ball("hair", (0.096, 0.108, 0.085), (0, -0.004, 0.17))
        M[nm] = b.finish(scale=HEAD)

    b = MeshB("uarm"); b.limb("tunic", 0.062, 0.05, L_UARM); M["uarm"] = b.finish()
    b = MeshB("farm"); b.limb("tunic", 0.05, 0.042, L_FARM); M["farm"] = b.finish()
    b = MeshB("hand"); b.ball("glove", (0.048, 0.04, 0.06), (0, 0, 0.05), segs=8, rings=6); M["hand"] = b.finish()
    b = MeshB("thigh"); b.limb("trousers", 0.088, 0.066, L_THIGH); M["thigh"] = b.finish()
    b = MeshB("shin")
    b.limb("trousers", 0.066, 0.05, L_SHIN, role2="boots", split=0.30 if g else 0.42)
    M["shin"] = b.finish()
    b = MeshB("foot")
    b.box("boots", (0.105, 0.29, 0.085), (0, 0.065, -0.04), bevel=0.03)
    b.ball("boots", (0.055, 0.06, 0.06), (0, 0.0, 0.0), segs=8, rings=6)
    M["foot"] = b.finish()

    b = MeshB("rifle"); K.w_rifle(b, "kar98k" if g else "mosin"); M["rifle"] = b.finish()
    b = MeshB("smg"); K.w_smg(b, g); M["smg"] = b.finish()
    b = MeshB("lmg"); K.w_lmg(b, g); M["lmg"] = b.finish()
    M["mgun"] = M["lmg"]
    # crew props (origin at the carrying point, long axis +Z unless noted)
    for nm, fn in (("bomb", K.w_mortar_bomb), ("shell", K.w_shell), ("tube", K.w_mortar_tube),
                   ("plate", K.w_baseplate), ("tripod", K.w_tripod), ("box", K.w_belt_box)):
        b = MeshB(nm); fn(b); M[nm] = b.finish()
    b = MeshB("grenade")            # the grenade in the throwing hand (a little oversized to read)
    (K.w_stick_grenade if g else K.w_egg_grenade)(b)
    M["grenade"] = b.finish(scale=1.4)

    # overrun stain: blood pool, tread print along +Y (travel direction), smear carried forward
    b = MeshB("stain")
    bm = b.bm
    n = 28
    ring = [bm.verts.new((math.sin(2 * math.pi * i / n) * 0.40 * (1 + 0.22 * math.sin(3 * 2 * math.pi * i / n + 1.0) + 0.12 * math.sin(7 * 2 * math.pi * i / n)),
                          math.cos(2 * math.pi * i / n) * 0.52 * (1 + 0.18 * math.sin(4 * 2 * math.pi * i / n + 0.5)), 0.006)) for i in range(n)]
    f = bm.faces.new(ring)
    f.material_index = b._mi("blood")
    for x0, w0, y1 in ((-0.13, 0.10, 1.18), (0.10, 0.12, 1.05), (0.0, 0.07, 0.92)):
        q = [bm.verts.new(v) for v in ((x0 - w0 / 2, 0.3, 0.005), (x0 + w0 / 2, 0.3, 0.005), (x0 + w0 * 0.2, y1, 0.005), (x0 - w0 * 0.2, y1, 0.005))]
        bm.faces.new(q).material_index = b._mi("blood")
    k = 0
    y = -0.62
    while y < 1.0:
        on_body = abs(y) < 0.5
        b.box("tread", (0.40, 0.055, 0.012), (0.0, y, 0.15 if on_body else 0.012), rot=(0, 0, 12 if k % 2 else -12), bevel=0)
        y += 0.125
        k += 1
    M["stain"] = b.finish()
    b = MeshB("blot")          # small dark stain under a body part
    ring = [b.bm.verts.new((math.sin(2 * math.pi * i / 16) * 0.14 * (1 + 0.3 * math.sin(3 * 2 * math.pi * i / 16 + 0.7)),
                            math.cos(2 * math.pi * i / 16) * 0.12 * (1 + 0.25 * math.sin(2 * 2 * math.pi * i / 16)), 0.005)) for i in range(16)]
    b.bm.faces.new(ring).material_index = b._mi("tread")
    M["blot"] = b.finish()
    M.update(build_debris_meshes())
    return M


WEAPON_INFO = {   # butt length behind the grip, fore-end hold, muzzle, grip height when on its bipod/prone
    "rifle": dict(butt=0.34, fore=(0, 0.30, -0.02), prone_z=0.20),
    "smg": dict(butt=0.30, fore=(0, 0.20, -0.09), prone_z=0.26),
    "lmg": dict(butt=0.38, fore=(0, 0.32, -0.04), prone_z=0.275),
}
WEAPON_POINTS = {"grip": (0, -0.02, -0.045), "butt_top": (0, -0.28, 0.03), "bolt": (0.04, 0.03, 0.06)}

PART_NAMES = ["pelvis", "chest", "head", "uarmL", "uarmR", "farmL", "farmR", "handL", "handR",
              "thighL", "thighR", "shinL", "shinR", "footL", "footR", "rifle", "smg", "lmg",
              "bomb", "shell", "tube", "plate", "mgun", "tripod", "box", "stain", "blot", "headbare", "grenade"] + list(DEBRIS)
PROPS = ("bomb", "shell", "tube", "plate", "mgun", "tripod", "box", "stain", "blot", "headbare", "grenade") + DEBRIS


class Rig:
    def __init__(self, meshes, coll, origin_xy, d):
        self.objs = {}
        for pn in PART_NAMES:
            me = meshes[pn.rstrip("LR") if pn[-1] in "LR" and pn not in meshes else pn]
            o = bpy.data.objects.new(pn, me)
            coll.objects.link(o)
            self.objs[pn] = o
        # parts hang off an empty so a non-uniform "squash" of the whole figure keeps its shear
        self.empty = bpy.data.objects.new("rigroot", None)
        coll.objects.link(self.empty)
        for o in self.objs.values():
            o.parent = self.empty
        self.root = T((origin_xy[0], origin_xy[1], 0)) @ Matrix.Rotation(C.dir_angle(d, DIRS), 4, "Z") @ S(FIG)

    def apply(self, mats, weapon):
        pre = mats.get("_squash")
        self.empty.matrix_world = self.root @ pre if pre is not None else self.root
        inv = pre.inverted() if pre is not None else None
        for pn, o in self.objs.items():
            m = mats.get(pn)
            if pn in ("rifle", "smg", "lmg"):
                m = mats.get("weapon") if pn == weapon else None
            if pn in PROPS and pn not in mats:
                m = None
            if m is None:
                o.hide_render = True
            else:
                o.hide_render = False
                o.matrix_basis = inv @ m if (inv is not None and pn in ("stain", "blot")) else m

    def hide(self):
        for o in self.objs.values():
            o.hide_render = True


# ------------------------------------------------------------------------------------------
# pose solving: a pose is a dict; solve() turns it into root-space matrices for every part
# ------------------------------------------------------------------------------------------
def rot_body(pitch=0, roll=0, yaw=0, twist=0):
    """pitch>0 leans forward (toward +Y); yaw>0 turns left (CCW from above); twist about the spine."""
    return Rz(yaw) @ Rx(-pitch) @ Rz(twist) @ Ry(roll)


def rot_weapon(pitch=0, yaw=0, roll=0):
    """pitch>0 lifts the muzzle; yaw>0 swings the muzzle to the left."""
    return Rz(yaw) @ Rx(pitch) @ Ry(roll)


def seg_matrix(a, b):
    z = (b - a)
    if z.length < 1e-6:
        z = Vector((0, 0, 1))
    z = z.normalized()
    hint = Vector((0, 1, 0)) if abs(z.y) < 0.95 else Vector((0, 0, 1))
    x = hint.cross(z).normalized()
    y = z.cross(x)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = a
    return m


def ik2(a, t, l1, l2, pole):
    d = t - a
    dist = d.length
    lo, hi = abs(l1 - l2) + 0.02, (l1 + l2) * 0.995
    if dist < 1e-6:
        d, dist = Vector((0, 0, -1)), 1.0
    n = d / dist
    dist = max(lo, min(hi, dist))
    x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, l1 * l1 - x * x))
    p = pole - n * pole.dot(n)
    if p.length < 1e-5:
        p = Vector((1, 0, 0)) - n * n.x
    p.normalize()
    return a + n * x + p * h, a + n * dist


def solve(pose, weapon):
    P = pose
    Mp = T(P["pelvis_pos"]) @ rot_body(*P.get("pelvis_rot", (0, 0, 0, 0)))
    Mc = Mp @ T(CHEST_PIVOT) @ rot_body(*P.get("chest_rot", (0, 0, 0)))
    Mh = Mc @ T(NECK) @ rot_body(*P.get("head_rot", (0, 0, 0)))
    frames = {"root": Matrix.Identity(4), "pelvis": Mp, "chest": Mc, "head": Mh}
    out = {"pelvis": Mp, "chest": Mc, "head": Mh}
    sh = {s: Mc @ Vector((sx * SHOULDER.x, SHOULDER.y, SHOULDER.z)) for s, sx in (("L", -1), ("R", 1))}

    Mw = None
    W = P.get("weapon")
    if W is not None and weapon:
        fr = W.get("frame", "chest")
        rw = rot_weapon(*W.get("rot", (0, 0, 0)))
        if fr == "rshoulder":      # shouldered: butt in the right shoulder pocket, orientation in root space
            info = WEAPON_INFO[weapon]
            dirv = (rw @ Vector((0, 1, 0, 0))).to_3d()
            pos = sh["R"] + Vector((-0.05, 0.04, -0.035)) + Vector(W.get("pos", (0, 0, 0))) + dirv * info["butt"]
            Mw = T(pos) @ rw
        else:
            Mw = frames[fr] @ T(W["pos"]) @ rw
        out["weapon"] = Mw

    def target(h):
        fr = h.get("frame", "chest")
        if fr == "w":
            if Mw is None:
                return None
            pt = h.get("pos", "grip")
            if pt == "fore":
                pt = WEAPON_INFO[weapon]["fore"]
            elif isinstance(pt, str):
                pt = WEAPON_POINTS[pt]
            return Mw @ Vector(pt)
        return frames[fr] @ Vector(h["pos"])

    def direction(h, default, dframe):
        pole = h.get("pole")
        if pole is None:
            return (frames[dframe].to_3x3() @ Vector(default))
        pf = h.get("pole_frame", h.get("frame", "chest"))
        if pf == "w":
            pf = "chest"
        return frames[pf].to_3x3() @ Vector(pole)

    for s, sx in (("L", -1), ("R", 1)):
        h = P.get("hand" + s) or dict(frame="chest", pos=(sx * 0.27, 0.05, -0.08))
        t = target(h)
        if t is None:
            t = Mc @ Vector((sx * 0.27, 0.05, -0.08))
        pole = direction(h, (sx * 0.7, -0.5, -0.8), "chest")
        el, wr = ik2(sh[s], t, L_UARM, L_FARM, pole)
        out["uarm" + s] = seg_matrix(sh[s], el)
        fm = seg_matrix(el, wr)
        out["farm" + s] = fm
        hm = fm.copy()
        hm.translation = wr
        out["hand" + s] = hm

        f = P["foot" + s]
        fr = f.get("frame", "root")
        hip = Mp @ Vector((sx * HIP.x, HIP.y, HIP.z))
        t = frames[fr] @ Vector(f["pos"])
        pole = direction(f, (sx * 0.12, 1.0, 0.1), "pelvis") if f.get("pole") is None else \
            frames[f.get("pole_frame", fr)].to_3x3() @ Vector(f["pole"])
        kn, an = ik2(hip, t, L_THIGH, L_SHIN, pole)
        out["thigh" + s] = seg_matrix(hip, kn)
        out["shin" + s] = seg_matrix(kn, an)
        fmat = frames[fr].to_3x3().to_4x4() @ Rz(f.get("yaw", 0)) @ Rx(-f.get("pitch", 0)) @ Ry(f.get("roll", 0))
        fmat.translation = an
        out["foot" + s] = fmat
    if P.get("bare"):
        out["headbare"] = out.pop("head")
    if P.get("only"):
        keep = set(P["only"])
        out = {k_: v for k_, v in out.items() if k_ in keep}
        c = sum((v.translation for v in out.values()), Vector((0, 0, 0))) / max(1, len(out))
        shift = T((-c.x, -c.y, 0))
        out = {k_: shift @ v for k_, v in out.items()}
    for k_ in P.get("hide", ()):
        out.pop(k_, None)
    if P.get("squash"):
        out["_squash"] = T((0, 0, 0.03)) @ S(*P["squash"])
    for name, (fr, pos, rot) in (P.get("props") or {}).items():
        out[name] = frames[fr] @ T(pos) @ Rz(rot[2]) @ Ry(rot[1]) @ Rx(rot[0])
    return out


# ------------------------------------------------------------------------------------------
# poses.  Every animation is a function (t in [0,1), weapon) -> pose dict.
# ------------------------------------------------------------------------------------------
def sn(t, ph=0.0): return math.sin(2 * math.pi * (t + ph))
def cs(t, ph=0.0): return math.cos(2 * math.pi * (t + ph))
def lerp(a, b, k): return a + (b - a) * k
def lerpv(a, b, k): return tuple(lerp(x, y, k) for x, y in zip(a, b))


def key(t, *vals):
    """Piecewise-linear through equally spaced key values over t in [0,1] (non looping)."""
    n = len(vals) - 1
    x = max(0.0, min(0.9999, t)) * n
    i = int(x)
    a, b = vals[i], vals[i + 1]
    k = x - i
    if isinstance(a, (tuple, list)):
        return lerpv(a, b, k)
    return lerp(a, b, k)


def foot(x, y, z=ANKLE, yaw=0, pitch=0, **kw):
    return dict(frame="root", pos=(x, y, z), yaw=yaw, pitch=pitch, **kw)


def w_hold(w):
    """Both hands on the weapon."""
    return dict(handR=dict(frame="w", pos="grip"), handL=dict(frame="w", pos="fore"))


def base(posture, w, t=0.0):
    """Relaxed-ready pose for a posture, weapon held in both hands."""
    if posture == "standing":
        p = dict(pelvis_pos=(0, 0, 0.955), pelvis_rot=(4, 0, -8, 0), chest_rot=(5, 0, -6), head_rot=(0, 0, 12),
                 footL=foot(-0.12, 0.08, yaw=8), footR=foot(0.13, -0.08, yaw=-18),
                 weapon=dict(frame="chest", pos=(0.12, 0.17, 0.10), rot=(12, 38, 0)))
    elif posture == "crouched":
        p = dict(pelvis_pos=(0, -0.20, 0.60), pelvis_rot=(22, 0, -8, 0), chest_rot=(24, 0, -6), head_rot=(-32, 0, 12),
                 footL=foot(-0.15, 0.04, yaw=10), footR=foot(0.16, -0.30, yaw=-22, z=0.10, pitch=20),
                 weapon=dict(frame="chest", pos=(0.12, 0.19, 0.10), rot=(28, 38, 0)))
    elif posture == "kneeling":
        p = dict(pelvis_pos=(0, -0.08, 0.50), pelvis_rot=(2, 0, -12, 0), chest_rot=(8, 0, -8), head_rot=(-4, 0, 18),
                 footL=foot(-0.13, 0.24, yaw=5, pole=(-0.1, 1, 0.5)),
                 footR=foot(0.14, -0.50, z=0.07, yaw=-8, pitch=62, pole=(0.05, 0.4, -1)),
                 weapon=dict(frame="chest", pos=(0.12, 0.18, 0.12), rot=(10, 38, 0)))
    else:  # prone, propped on the elbows
        z = WEAPON_INFO[w]["prone_z"] if w else 0.2
        wy = 0.33 if w == "lmg" else 0.40
        p = dict(pelvis_pos=(0, -0.25, 0.125), pelvis_rot=(90, 0, -6, 0), chest_rot=(-16, 0, -4), head_rot=(-52, 0, 8),
                 footL=foot(-0.25, -1.14, z=0.07, yaw=34, pitch=38, pole=(-1, 0.2, 0.25)),     # legs straight,
                 footR=foot(0.29, -1.12, z=0.07, yaw=-38, pitch=38, pole=(1, 0.2, 0.25)),     # spread, toes out
                 weapon=dict(frame="root", pos=(0.13, wy, z), rot=(0, 10, 0)))
        p.update(handR=dict(frame="w", pos="grip", pole=(1, -0.3, -0.6), pole_frame="root"),
                 handL=dict(frame="w", pos="fore", pole=(-1, -0.2, -0.6), pole_frame="root"))
        if not w:
            p["handL"] = dict(frame="root", pos=(-0.20, 0.50, 0.05), pole=(-1, -0.3, -0.3), pole_frame="root")
            p["handR"] = dict(frame="root", pos=(0.22, 0.46, 0.05), pole=(1, -0.3, -0.3), pole_frame="root")
        return p
    p.update(w_hold(w))
    if not w:
        p["handL"] = dict(frame="chest", pos=(-0.30, 0.10, -0.04), pole=(-1, -0.6, -0.3))
        p["handR"] = dict(frame="chest", pos=(0.30, 0.10, -0.04), pole=(1, -0.6, -0.3))
    return p


def aimed(posture, w, recoil=0.0, lift=0.0):
    """Weapon shouldered and pointing exactly along the facing."""
    p = base(posture, w)
    if posture == "prone":
        z = WEAPON_INFO[w]["prone_z"]
        p["pelvis_rot"] = (90, 0, -10, 0)
        p["chest_rot"] = (-18, 0, -6)
        p["head_rot"] = (-50, 10, 12)
        p["weapon"] = dict(frame="root", pos=(0.125, (0.33 if w == "lmg" else 0.40) - recoil, z + lift * 0.3), rot=(lift * 40, 0, 0))
        if w == "lmg":
            p["handL"] = dict(frame="w", pos="butt_top", pole=(-1, -0.2, -0.4), pole_frame="root")
        return p
    yawc = {"standing": -32, "crouched": -28, "kneeling": -34}[posture]
    pp = p["pelvis_pos"]
    p["pelvis_pos"] = (pp[0], pp[1] - 0.10, pp[2])        # lean room: keeps the muzzle inside the cell
    for k_ in ("footL", "footR"):
        fp = p[k_]["pos"]
        p[k_]["pos"] = (fp[0], fp[1] - 0.10, fp[2])
    pr = p["pelvis_rot"]
    p["pelvis_rot"] = (pr[0], 0, -16, 0)
    cr = p["chest_rot"]
    p["chest_rot"] = (cr[0] + 3 - recoil * 60, 0, yawc + 16)
    p["head_rot"] = (p["head_rot"][0] + 6, 14, -yawc - 4)
    p["weapon"] = dict(frame="rshoulder", pos=(0, -recoil, lift * 0.25), rot=(lift * 40, 0, 0))
    p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.2, -0.5))
    p["handL"] = dict(frame="w", pos="fore", pole=(-0.6, 0, -1))
    if posture == "standing":
        p["footL"] = foot(-0.12, 0.07, yaw=5)
        p["footR"] = foot(0.15, -0.27, yaw=-40)
    return p


def a_idle(posture):
    def f(t, w):
        p = base(posture, w)
        br = sn(t)
        c = p["chest_rot"]
        p["chest_rot"] = (c[0] + 1.5 * br, c[1], c[2] + 2 * sn(t, 0.25))
        h = p["head_rot"]
        p["head_rot"] = (h[0], h[1], h[2] + key(t, 0, 22, 4, -20, 0))
        W = p["weapon"]
        if W["frame"] == "chest":
            W["rot"] = (W["rot"][0] + 3 * sn(t, 0.1), W["rot"][1] + 3 * sn(t, 0.4), 0)
        else:
            W["rot"] = (0, W["rot"][1] + 4 * sn(t, 0.4), 0)
        return p
    return f


def a_alert(posture):
    def f(t, w):
        p = aimed(posture, w)
        if posture != "prone":
            p["weapon"]["rot"] = (-10, 0, 0)       # weapon up but just below the line of sight
        h = p["head_rot"]
        p["head_rot"] = (h[0] - 4, 0, h[2] + key(t, -38, -10, 34, 8, -38))
        return p
    return f


def a_aim(posture):
    def f(t, w):
        p = aimed(posture, w)
        c = p["chest_rot"]
        p["chest_rot"] = (c[0] + 1.2 * sn(t), c[1], c[2])
        return p
    return f


def a_fire(posture):
    def f(t, w):
        k = w == "lmg" and 0.7 or 1.0
        return aimed(posture, w, recoil=key(t, 0.075, 0.035, 0.0, 0.0) * k, lift=key(t, 0.2, 0.12, 0.0, 0.0) * k)
    return f


def a_reload(posture):
    def f(t, w):
        p = base(posture, w)
        W = p["weapon"]
        if posture == "prone":
            W["rot"] = (0, 28, 40)                  # rolled onto its side, pulled in
            W["pos"] = (0.10, 0.36, W["pos"][2])
            tgt = [(0.22, -0.10, 0.12), None, None, None]
        else:
            W["pos"] = (0.10, 0.20, 0.14)
            W["rot"] = (key(t, 25, 32, 30, 14), key(t, 40, 46, 44, 30), key(t, 20, 35, 35, 10))
            tgt = [(0.17, 0.16, -0.02), None, None, None]
        i = min(3, int(t * 4))
        if i == 0:      # hand to the pouch
            p["handR"] = dict(frame="pelvis" if posture != "prone" else "root", pos=tgt[0])
            p["head_rot"] = (p["head_rot"][0] + 18, 0, -20)
        elif i in (1, 2):   # magazine / bolt
            pt = (0.0, 0.16, 0.10) if i == 1 else (0.05, 0.0, 0.09)
            if w == "smg":
                pt = (0, 0.19, -0.2) if i == 1 else (0, 0.19, -0.1)
            if w == "lmg":
                pt = (0, 0.10, 0.18) if i == 1 else (0, 0.10, 0.12)
            p["handR"] = dict(frame="w", pos=pt)
            p["head_rot"] = (p["head_rot"][0] + 22, 0, 6)
        return p
    return f


def a_hide(posture):
    def f(t, w):
        b = 0.5 + 0.5 * sn(t)
        if posture == "standing":
            p = base("standing", w)
            p.update(pelvis_pos=(0, -0.10, 0.80 - 0.02 * b), pelvis_rot=(38, 0, -6, 0), chest_rot=(34 + 3 * b, 0, 0),
                     head_rot=(26, 0, 0), footL=foot(-0.15, 0.14, yaw=8), footR=foot(0.16, -0.16, yaw=-15))
            p["weapon"] = dict(frame="chest", pos=(0.08, 0.15, 0.16), rot=(62, 30, 0))
        elif posture == "crouched":
            p = base("crouched", w)
            p.update(pelvis_pos=(0, -0.20, 0.46 - 0.02 * b), pelvis_rot=(30, 0, -4, 0), chest_rot=(36 + 3 * b, 0, 0),
                     head_rot=(24, 0, 0))
            p["weapon"] = dict(frame="chest", pos=(0.08, 0.15, 0.16), rot=(70, 30, 0))
        elif posture == "kneeling":
            p = base("kneeling", w)
            p.update(pelvis_pos=(0, -0.12, 0.44), pelvis_rot=(24, 0, -6, 0), chest_rot=(46 + 3 * b, 0, 0), head_rot=(30, 0, 0))
            p["weapon"] = dict(frame="chest", pos=(0.10, 0.13, 0.14), rot=(66, 25, 0))
        else:
            p = base("prone", w)
            p.update(chest_rot=(-2, 0, 0), head_rot=(6 - 6 * b, 0, 30))
            p["weapon"] = dict(frame="root", pos=(0.27, 0.16, 0.07), rot=(0, 4, 80))
            p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.3, 0.2), pole_frame="root")
            p["handL"] = dict(frame="root", pos=(-0.20, 0.42, 0.05), pole=(-1, -0.4, 0.2), pole_frame="root")
        return p
    return f


WALK_AMP, RUN_AMP, SNEAK_AMP = 0.30, 0.50, 0.22     # foot travel (m, before FIG) either side of centre


def gait_feet(t, amp, lift, xoff=0.12, y0=0.0, z0=ANKLE, toe=12):
    out = []
    for sx, ph in ((-1, 0.0), (1, 0.5)):
        c, s_ = cs(t, ph), sn(t, ph)
        swing = max(0.0, -s_)                       # in the air while travelling forward
        out.append(foot(sx * xoff, y0 + amp * c, z=z0 + lift * swing, yaw=-sx * 6,
                        pitch=toe * 2.2 * swing - 14 * max(0, c) * (1 - swing)))
    return out


def a_walk(mood=None):
    def f(t, w):
        p = base("standing", w)
        amp = WALK_AMP if mood != "shaken" else 0.19
        p["footL"], p["footR"] = gait_feet(t, amp, 0.11)
        bob = 0.025 * abs(cs(t))
        p["pelvis_pos"] = (0, 0, 0.945 - bob)
        p["pelvis_rot"] = (6, 0, 7 * cs(t), 0)
        p["chest_rot"] = (6, 0, -14 * cs(t) - 6)
        W = p["weapon"]
        W["rot"] = (12 + 3 * sn(t * 2), 38, 0)
        if mood is None:
            # arms swing against the legs so the step reads from above: the rifle / SMG is carried
            # in the right hand at the balance, the left arm swings free (an LMG stays two-handed)
            sw = -cs(t)                                   # left arm back while the left leg is forward
            if w in ("rifle", "smg"):
                p["weapon"] = dict(frame="chest", pos=(0.25, 0.10 - 0.07 * sw, -0.05), rot=(24, 6 - 6 * sw, 0))
                p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.3, -0.5))
            elif w is None:
                p["handR"] = dict(frame="chest", pos=(0.28, 0.06 - 0.22 * sw, -0.11 + 0.05 * abs(sw)), pole=(1, -0.3, -0.4))
            if w != "lmg":
                p["handL"] = dict(frame="chest", pos=(-0.28, 0.06 + 0.24 * sw, -0.11 + 0.05 * abs(sw)), pole=(-1, -0.3, -0.4))
        if mood == "shaken":
            p["pelvis_pos"] = (0, -0.03, 0.89 - bob)
            p["pelvis_rot"] = (14, 0, 4 * cs(t), 0)
            p["chest_rot"] = (22, 0, -8 * cs(t))
            p["head_rot"] = (-2, 0, key(t, 55, 20, -60, -25, 55))
            W["pos"] = (0.10, 0.13, 0.16)
            W["rot"] = (40, 30, 0)
        elif mood == "surrendered":
            p["weapon"] = None
            hands_up(p, sway=2 * sn(t))
        return p
    return f


def a_run(mood=None):
    def f(t, w):
        p = base("standing", w)
        amp, lift = RUN_AMP, 0.26
        if mood == "berserk":
            p["footL"], p["footR"] = gait_feet(t, amp, lift, toe=20)
            p["pelvis_pos"] = (0, 0.02, 0.93 - 0.035 * abs(cs(t)))
            p["pelvis_rot"] = (8, 0, 7 * cs(t), 0)
            p["chest_rot"] = (4, 0, -8 * cs(t) - 14)
            p["head_rot"] = (-10, 0, 14)
            p["weapon"] = dict(frame="chest", pos=(0.17, 0.30 + 0.05 * sn(t * 2), 0.17), rot=(-6, 14, 0))
            p["handL"] = dict(frame="w", pos="fore", pole=(-1, 0, -0.5))
        elif mood == "panicked":
            p["footL"], p["footR"] = gait_feet(t, 0.40, 0.26, xoff=0.16, toe=20)
            p["pelvis_pos"] = (0.05 * sn(t), 0.05, 0.90 - 0.05 * abs(cs(t)))
            p["pelvis_rot"] = (24, 10 * sn(t), 12 * cs(t), 0)
            p["chest_rot"] = (12, -8 * sn(t), -10 * cs(t))
            p["head_rot"] = (-22, 0, key(t, 40, 60, 10, -30, -50, 0, 40))
            p["weapon"] = None
            p["handL"] = dict(frame="chest", pos=(-0.56, 0.12 + 0.2 * sn(t, 0.1), 0.50 + 0.22 * cs(t)), pole=(-0.3, -1, -0.3))
            p["handR"] = dict(frame="chest", pos=(0.56, 0.12 - 0.2 * sn(t, 0.1), 0.50 - 0.22 * cs(t)), pole=(0.3, -1, -0.3))
        else:
            p["footL"], p["footR"] = gait_feet(t, amp, lift, toe=20)
            p["pelvis_pos"] = (0, 0.06, 0.91 - 0.04 * abs(cs(t)))
            p["pelvis_rot"] = (22, 0, 8 * cs(t), 0)
            p["chest_rot"] = (14, 0, -16 * cs(t) - 4)
            p["head_rot"] = (-26, 0, 6)
            p["weapon"] = dict(frame="chest", pos=(0.13 + 0.03 * cs(t), 0.18, 0.14 + 0.04 * sn(t * 2)),
                               rot=(18 + 8 * cs(t), 44 + 10 * cs(t), 0))
        return p
    return f


def a_sneak(mood=None):
    def f(t, w):
        p = base("crouched", w)
        p["footL"], p["footR"] = gait_feet(t, SNEAK_AMP, 0.08, xoff=0.15, y0=-0.12)
        p["pelvis_pos"] = (0, -0.18, 0.63 - 0.02 * abs(cs(t)))
        p["pelvis_rot"] = (24, 0, 5 * cs(t), 0)
        p["chest_rot"] = (26, 0, -8 * cs(t) - 6)
        if mood == "shaken":
            p["chest_rot"] = (36, 0, -6 * cs(t))
            p["head_rot"] = (-20, 0, key(t, 60, 15, -65, -20, 60))
            p["weapon"]["rot"] = (50, 30, 0)
        return p
    return f


def a_crawl(mood=None):
    def f(t, w):
        p = base("prone", w)
        c, s_ = cs(t), sn(t)
        if mood == "panicked":      # scrabbling backwards, half turned, weapon abandoned
            p["pelvis_pos"] = (0, -0.34, 0.20)
            p["pelvis_rot"] = (78, 0, 10 * s_, 14 * c)
            p["chest_rot"] = (-34, 0, 16 * s_)
            p["head_rot"] = (-40, 0, key(t, 60, 20, -55, -10, 60))
            p["weapon"] = dict(frame="root", pos=(0.50, 0.30, 0.05), rot=(0, 40, 85))
            p["handL"] = dict(frame="root", pos=(-0.42, 0.34 + 0.16 * c, 0.05), pole=(-1, -0.3, 0.3), pole_frame="root")
            p["handR"] = dict(frame="root", pos=(0.42, 0.34 - 0.16 * c, 0.05), pole=(1, -0.3, 0.3), pole_frame="root")
            p["footL"] = foot(-0.30 - 0.1 * c, -0.92 + 0.18 * c, z=0.08, yaw=35, pitch=30, pole=(-1, 0.2, 0.6))
            p["footR"] = foot(0.30 - 0.1 * c, -0.92 - 0.18 * c, z=0.08, yaw=-35, pitch=30, pole=(1, 0.2, 0.6))
            return p
        # army crawl: body flat, legs trailing nearly straight; one knee at a time is drawn up to the
        # side and pushes while the opposite elbow reaches forward (contralateral), weight shifting
        # onto the pushing side.  Smooth (cosine) phases so 8 frames read as one continuous motion.
        dl, dr = max(0.0, c), max(0.0, -c)              # 1 = that knee fully drawn up, 0 = leg straight
        dl, dr = dl * dl * (3 - 2 * dl), dr * dr * (3 - 2 * dr)
        p["pelvis_pos"] = (0.025 * c, -0.25 + 0.02 * s_, 0.125)
        p["pelvis_rot"] = (90, 0, -7 * c, 7 * c)
        p["chest_rot"] = (-12, 0, 10 * c)
        p["head_rot"] = (-50, 0, -4 * c)
        z = (WEAPON_INFO[w]["prone_z"] if w else 0.2) - 0.07
        p["weapon"] = dict(frame="root", pos=(0.20 + 0.02 * c, 0.34 + 0.10 * s_, z), rot=(3, 8, 22))
        # a forearm reaches forward past the helmet and pulls back beside the shoulder (clear of the
        # head, so it never reads as hands clasped over the helmet)
        def hand(sx, d):
            return dict(frame="root", pos=(sx * (0.34 - 0.12 * d), 0.34 + 0.46 * d, 0.05), pole=(sx * 0.8, -0.5, 0.2), pole_frame="root")
        p["handR"] = dict(frame="w", pos="grip", pole=(0.7, -0.6, 0.2), pole_frame="root") if w else hand(1, dl)
        p["handL"] = hand(-1, dr)
        p["footL"] = foot(-0.13 - 0.24 * dl, -1.15 + 0.38 * dl, z=0.07, yaw=12 + 36 * dl, pitch=40,
                          pole=(-1, 0.15 * dl, 0.15))
        p["footR"] = foot(0.13 + 0.24 * dr, -1.15 + 0.38 * dr, z=0.07, yaw=-12 - 36 * dr, pitch=40,
                          pole=(1, 0.15 * dr, 0.15))
        return p
    return f


def a_wounded_crawl(t, w):
    c = cs(t)
    p = base("prone", None)
    p["pelvis_pos"] = (0.0, -0.25, 0.13)
    p["pelvis_rot"] = (90, 0, 8 + 4 * c, -22)
    p["chest_rot"] = (-6, 0, 10 * c)
    p["head_rot"] = (-20 - 14 * max(0, c), 0, -18)
    p["weapon"] = None
    p["handR"] = dict(frame="root", pos=(0.22, 0.58 - 0.22 * c, 0.05), pole=(1, -0.4, 0.3), pole_frame="root")
    p["handL"] = dict(frame="root", pos=(-0.36, -0.30, 0.05), pole=(-1, -0.2, 0.1), pole_frame="root")   # dragging
    p["footL"] = foot(-0.22, -0.98, z=0.07, yaw=30, pitch=40, pole=(-1, 0, 0))
    p["footR"] = foot(0.30 + 0.12 * max(0, c), -1.0 + 0.2 * max(0, c), z=0.07, yaw=-50, pitch=35, pole=(1, 0.3, 0.1))
    return p


def a_throw(posture):
    """6 frames over the 0.9 s throw: cock, full wind-up, release, follow-through, recover x2.
    The grenade is in the hand for the first two frames."""
    def f(t, w):
        p = base(posture, w)
        i = min(5, int(round(t * 5)))
        if posture == "prone":
            p["weapon"] = dict(frame="root", pos=(-0.26, 0.30, 0.07), rot=(0, 8, -80))
            p["handL"] = dict(frame="w", pos="fore", pole=(-1, -0.3, 0.2), pole_frame="root")
            p["pelvis_rot"] = (90, 0, key(t, -20, -28, 10, 5, 2, 0), key(t, 25, 35, -10, -5, -2, 0))
            p["chest_rot"] = (key(t, -30, -40, -26, -22, -20, -18), 0, key(t, -25, -35, 25, 15, 8, 5))
            hp = key(t, (0.35, -0.25, 0.30), (0.40, -0.40, 0.46), (0.15, 0.62, 0.42), (0.22, 0.56, 0.20),
                     (0.25, 0.46, 0.10), (0.25, 0.40, 0.07))
            p["handR"] = dict(frame="root", pos=hp, pole=(1, -0.5, 0.5), pole_frame="root")
            if i < 2:
                p["props"] = {"grenade": ("root", hp, (60, 0, 20))}
            return p
        p["weapon"] = dict(frame="chest", pos=(-0.20, 0.16, 0.06), rot=(55, 10, 0))
        p["handL"] = dict(frame="w", pos="fore")
        cr = p["chest_rot"]
        p["chest_rot"] = (cr[0] + key(t, -10, -18, 18, 12, 6, 2), 0, key(t, -40, -58, 35, 22, 8, 0))
        pr = p["pelvis_rot"]
        p["pelvis_rot"] = (pr[0], 0, key(t, -20, -30, 15, 8, 3, 0), 0)
        p["head_rot"] = (p["head_rot"][0], 0, key(t, 40, 54, -25, -12, -5, 0))
        hp = key(t, (0.40, -0.30, 0.32), (0.34, -0.46, 0.56), (0.12, 0.50, 0.68), (0.18, 0.50, 0.30),
                 (0.24, 0.36, 0.12), (0.24, 0.24, 0.02))
        p["handR"] = dict(frame="chest", pos=hp, pole=(1, -0.6, -0.2))
        if i < 2:
            p["props"] = {"grenade": ("chest", hp, (70, 0, 30))}
        if posture == "standing":
            p["footL"] = foot(-0.12, key(t, 0.10, 0.12, 0.30, 0.28, 0.24, 0.20), yaw=5)
            p["footR"] = foot(0.15, key(t, -0.22, -0.26, -0.20, -0.18, -0.16, -0.14), yaw=-35)
        return p
    return f


def hands_up(p, sway=0.0):
    p["weapon"] = None
    p["handL"] = dict(frame="chest", pos=(-0.60, 0.08, 0.60 + 0.01 * sway), pole=(-1, -0.2, -0.6))
    p["handR"] = dict(frame="chest", pos=(0.60, 0.08, 0.60 - 0.01 * sway), pole=(1, -0.2, -0.6))
    return p


def hands_on_helmet(p, both=True, left=True):
    hz = NECK.z + 0.27 * HEAD
    if both or left:
        p["handL"] = dict(frame="chest", pos=(-0.09, 0.06, hz), pole=(-1, 0.5, 0.0))
    if both or not left:
        p["handR"] = dict(frame="chest", pos=(0.09, 0.06, hz), pole=(1, 0.5, 0.0))
    return p


def a_surrender(posture):
    def f(t, w):
        p = base(posture, None)
        if posture == "kneeling":     # both knees down
            p.update(pelvis_pos=(0, 0.0, 0.50), pelvis_rot=(-4, 0, 0, 0), chest_rot=(4, 0, 0),
                     footL=foot(-0.14, -0.47, z=0.07, yaw=6, pitch=62, pole=(-0.05, 0.4, -1)),
                     footR=foot(0.14, -0.47, z=0.07, yaw=-6, pitch=62, pole=(0.05, 0.4, -1)))
        else:
            p.update(pelvis_rot=(2, 0, 0, 0), chest_rot=(2, 0, 0), footL=foot(-0.14, 0.0, yaw=10), footR=foot(0.14, 0.0, yaw=-10))
        p["head_rot"] = (8, 0, 8 * sn(t))
        return hands_up(p, sway=sn(t))
    return f


def a_shaken_idle(posture):
    def f(t, w):
        p = base(posture, w)
        look = key(t, 70, 25, -75, -30, 70)       # glancing over the shoulders
        c = p["chest_rot"]
        pr = p["pelvis_rot"]
        if posture == "prone":
            p["chest_rot"] = (-8, 0, look * 0.2)
            p["head_rot"] = (-30, 0, look * 0.8)
            p["weapon"]["pos"] = (0.16, 0.30, p["weapon"]["pos"][2])
            p["weapon"]["rot"] = (0, 22, 20)
        else:
            pp = p["pelvis_pos"]
            p["pelvis_pos"] = (pp[0], pp[1] - 0.03, pp[2] - 0.06)
            p["pelvis_rot"] = (pr[0] + 8, 0, pr[2], 0)
            p["chest_rot"] = (c[0] + 18, 0, look * 0.25)
            p["head_rot"] = (p["head_rot"][0] + 4, 0, look * 0.75)
            p["weapon"] = dict(frame="chest", pos=(0.08, 0.13, 0.17), rot=(58, 30, 0))   # clutched to the chest
        return p
    return f


def a_pinned(posture):
    def f(t, w):
        fl = key(t, 0.0, 1.0, 0.0)               # flinch
        if posture == "prone":
            p = base("prone", w)
            p.update(pelvis_rot=(90, 0, 0, 0), chest_rot=(0, 0, 0), head_rot=(12 + 8 * fl, 0, -35))
            p["pelvis_pos"] = (0, -0.25, 0.11)
            p["weapon"] = dict(frame="root", pos=(0.33, 0.22, 0.06), rot=(0, 0, 85))
            p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.5, 0.1), pole_frame="root")
            p["handL"] = dict(frame="chest", pos=(-0.10, -0.06, NECK.z + 0.26 * HEAD), pole=(-1, 0, 0.1))
            p["footL"] = foot(-0.38, -0.95, z=0.06, yaw=70, pitch=10, pole=(-1, 0, 0.25))
            p["footR"] = foot(0.38, -0.95, z=0.06, yaw=-70, pitch=10, pole=(1, 0, 0.25))
            return p
        p = base("kneeling" if posture == "kneeling" else "crouched", w)
        zz = {"standing": 0.56, "crouched": 0.46, "kneeling": 0.42}[posture]
        p["pelvis_pos"] = (0, -0.10, zz - 0.05 * fl)
        p["pelvis_rot"] = (30 if posture != "kneeling" else 22, 0, 0, 0)
        p["chest_rot"] = (48 + 10 * fl, 0, 10)
        p["head_rot"] = (30, 0, 0)
        p["weapon"] = dict(frame="chest", pos=(0.24, 0.14, 0.10), rot=(-38, 6, 0))      # muzzle dipped to the ground
        p["handR"] = dict(frame="w", pos="grip")
        hands_on_helmet(p, both=False, left=True)
        return p
    return f


def a_cower(posture):
    def f(t, w):
        sh = sn(t) * 1.0
        if posture == "prone":         # foetal, on his side
            p = base("prone", None)
            p.update(pelvis_pos=(0.0, -0.22, 0.17), pelvis_rot=(90, 0, 12, 78), chest_rot=(52 + 3 * sh, 0, 0), head_rot=(38, 0, 0))
            p["footL"] = dict(frame="pelvis", pos=(-0.10, 0.50, -0.30), pitch=40, pole=(0, 1, 0.3))
            p["footR"] = dict(frame="pelvis", pos=(0.12, 0.42, -0.40), pitch=40, pole=(0, 1, 0.3))
            hands_on_helmet(p)
            p["weapon"] = dict(frame="root", pos=(0.42, -0.30, 0.05), rot=(0, 14, 85))
            return p
        if posture == "kneeling":      # folded forward over both knees
            p = base("kneeling", None)
            p.update(pelvis_pos=(0, -0.22, 0.34), pelvis_rot=(40, 0, 0, 0), chest_rot=(58 + 3 * sh, 0, 0), head_rot=(36, 0, 0),
                     footL=foot(-0.14, -0.60, z=0.07, yaw=8, pitch=70, pole=(-0.1, 0.5, -1)),
                     footR=foot(0.14, -0.60, z=0.07, yaw=-8, pitch=70, pole=(0.1, 0.5, -1)))
        else:                          # squatting ball
            p = base("crouched", None)
            zz = 0.44 if posture == "standing" else 0.38
            p.update(pelvis_pos=(0, -0.16, zz), pelvis_rot=(28, 0, 0, 0), chest_rot=(56 + 3 * sh, 0, 0), head_rot=(38, 0, 0),
                     footL=foot(-0.14, 0.06, yaw=14), footR=foot(0.14, 0.04, yaw=-14))
        hands_on_helmet(p)
        p["weapon"] = dict(frame="root", pos=(0.46, 0.0, 0.05), rot=(0, 10, 85))
        return p
    return f


def a_panic_idle(posture):
    def f(t, w):
        c, s_ = cs(t), sn(t)
        turn = key(t, -30, 25, -10, 35, -30)
        if posture == "prone":
            p = a_crawl("panicked")(t, w)
            return p
        if posture == "standing":
            p = base("standing", w)
            p["pelvis_pos"] = (0.04 * s_, -0.04, 0.90)
            p["pelvis_rot"] = (-6, 6 * s_, turn, 0)
            p["chest_rot"] = (-6, -6 * s_, turn * 0.5)
            p["head_rot"] = (-8, 0, -turn * 1.6)
            p["footL"] = foot(-0.20, 0.06 + 0.1 * s_, yaw=20)
            p["footR"] = foot(0.20, -0.06 - 0.1 * s_, yaw=-25)
            p["weapon"] = dict(frame="chest", pos=(0.36, 0.05, -0.12), rot=(-72, 10, 0))     # dangling from one hand
            p["handR"] = dict(frame="w", pos="grip")
            p["handL"] = dict(frame="chest", pos=(-0.52, 0.10 + 0.25 * c, 0.52 + 0.24 * s_), pole=(-0.3, -1, -0.3))
        else:                          # recoiling backwards, arm shielding the face, weapon dropped
            p = base(posture, None)
            pp = p["pelvis_pos"]
            p["pelvis_pos"] = (pp[0] + 0.03 * s_, pp[1] - 0.10, pp[2] - 0.04)
            p["pelvis_rot"] = (-14, 0, turn, 0)
            p["chest_rot"] = (-12, 0, turn * 0.5)
            p["head_rot"] = (4, 0, -turn * 1.4)
            p["weapon"] = dict(frame="root", pos=(0.40, -0.25, 0.05), rot=(0, 15, 85))
            p["handL"] = dict(frame="chest", pos=(-0.18 + 0.1 * c, 0.34, 0.62 + 0.1 * s_), pole=(-1, 0, 0.25))
            p["handR"] = dict(frame="chest", pos=(0.50, -0.12 + 0.12 * s_, 0.0 + 0.2 * c), pole=(1, -0.5, 0))
        return p
    return f


def a_berserk_idle(t, w):
    p = base("standing", w)
    p["pelvis_pos"] = (0, 0.03, 0.95)
    p["pelvis_rot"] = (2, 0, -10, 0)
    p["chest_rot"] = (-4 + 2 * sn(t), 0, -12)
    p["head_rot"] = (-14, 0, 20 + 10 * sn(t))
    p["footL"] = foot(-0.20, 0.20, yaw=10)
    p["footR"] = foot(0.22, -0.18, yaw=-30)
    p["weapon"] = dict(frame="chest", pos=(0.22, 0.10, 0.62 + 0.06 * sn(t)), rot=(40, 60, 0))   # brandished overhead
    p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.3, 0))
    p["handL"] = dict(frame="chest", pos=(-0.50, 0.16, 0.30 + 0.1 * sn(t)), pole=(-1, -0.5, -0.5))
    return p


def a_berserk_fire(t, w):
    p = base("standing", w)
    rc = key(t, 0.06, 0.03, 0.0, 0.0)
    p["pelvis_rot"] = (4, 0, -14, 0)
    p["chest_rot"] = (2 - rc * 60, 0, -10)
    p["head_rot"] = (-8, 0, 22)
    p["footL"] = foot(-0.16, 0.22, yaw=6)
    p["footR"] = foot(0.18, -0.20, yaw=-30)
    p["weapon"] = dict(frame="root", pos=(0.20, 0.30 - rc, 1.10), rot=(key(t, 8, 4, 0, 0), 0, 0))   # from the hip
    p["handR"] = dict(frame="w", pos="grip")
    p["handL"] = dict(frame="w", pos="fore")
    return p


# ---- crew of served weapons (the weapon itself comes from the weapons atlas) ---------------
# Task entries are ordered by PROGRESS: frame 0 = task start, last frame = task done.
def _hands(p, l, r, frame="chest", polel=(-1, -0.2, -0.6), poler=(1, -0.2, -0.6)):
    p["handL"] = dict(frame=frame, pos=l, pole=polel, pole_frame="chest")
    p["handR"] = dict(frame=frame, pos=r, pole=poler, pole_frame="chest")


def _body(posture, z=None, y=None, pel=None, chest=None, head=None):
    p = base(posture, None)
    p["weapon"] = None
    pp = p["pelvis_pos"]
    p["pelvis_pos"] = (pp[0], pp[1] if y is None else y, pp[2] if z is None else z)
    if pel is not None:
        p["pelvis_rot"] = (pel[0], 0, pel[1], 0)
    if chest is not None:
        p["chest_rot"] = (chest[0], 0, chest[1])
    if head is not None:
        p["head_rot"] = (head[0], 0, head[1])
    return p


def a_crew_lay(t, w):
    k = sn(t)
    p = _body("kneeling", pel=(10, -6), chest=(26, 4 + 3 * k), head=(-6, -4))
    _hands(p, (-0.20, 0.44, 0.24), (0.22 + 0.04 * cs(t), 0.40, 0.12 + 0.05 * k))
    return p


def a_crew_fire(t, w):
    i = min(2, int(t * 3))
    if i == 0:      # lanyard pulled hard back
        p = _body("kneeling", pel=(4, -14), chest=(10, -28), head=(-4, 24))
        _hands(p, (-0.20, 0.40, 0.22), (0.34, -0.22, 0.10), poler=(1, -0.6, 0))
    elif i == 1:    # flinch away from the breech
        p = _body("kneeling", y=-0.16, pel=(-6, 16), chest=(18, 34), head=(24, 40))
        _hands(p, (-0.10, 0.10, 0.62), (0.30, -0.10, 0.20), polel=(-1, 0.4, 0))
    else:
        p = _body("kneeling", pel=(8, -6), chest=(22, 2), head=(-6, 0))
        _hands(p, (-0.20, 0.42, 0.24), (0.22, 0.34, 0.14))
    return p


def a_crew_trail(t, w):
    i = min(4, int(t * 5))
    if i == 0:      # bend and grip the trail end
        p = _body("crouched", z=0.62, pel=(34, 0), chest=(44, 0), head=(-10, 0))
        _hands(p, (-0.12, 0.42, -0.08), (0.12, 0.42, -0.08), polel=(-1, 0, 0), poler=(1, 0, 0))
    elif i == 1:    # lift
        p = _body("standing", z=0.84, y=-0.06, pel=(20, 0), chest=(22, 0), head=(-14, 0))
        p["footL"], p["footR"] = foot(-0.20, 0.10, yaw=12), foot(0.20, -0.06, yaw=-14)
        _hands(p, (-0.12, 0.38, 0.0), (0.12, 0.38, 0.0), polel=(-1, 0, 0), poler=(1, 0, 0))
    elif i == 2:    # swing it outward, stepping sideways
        p = _body("standing", z=0.84, y=-0.04, pel=(18, 28), chest=(20, 22), head=(-12, -20))
        p["pelvis_pos"] = (-0.14, -0.04, 0.84)
        p["footL"], p["footR"] = foot(-0.36, 0.10, yaw=35), foot(0.10, -0.08, yaw=5)
        _hands(p, (-0.14, 0.40, 0.0), (0.10, 0.40, 0.0), polel=(-1, 0, 0), poler=(1, 0, 0))
    elif i == 3:    # set it down
        p = _body("crouched", z=0.58, pel=(36, 36), chest=(46, 14), head=(-6, -10))
        p["pelvis_pos"] = (-0.20, -0.10, 0.58)
        p["footL"], p["footR"] = foot(-0.40, 0.06, yaw=40), foot(0.0, -0.22, yaw=10, z=0.10, pitch=20)
        _hands(p, (-0.12, 0.42, -0.10), (0.12, 0.42, -0.10), polel=(-1, 0, 0), poler=(1, 0, 0))
    else:           # straighten up, done
        p = _body("standing", pel=(8, 30), chest=(8, 10), head=(0, -10))
        p["pelvis_pos"] = (-0.20, -0.04, 0.94)
        p["footL"], p["footR"] = foot(-0.34, 0.04, yaw=35), foot(-0.06, -0.12, yaw=10)
    return p


def a_crew_dig(t, w):
    i = min(3, int(t * 4))
    up = (1.0, 0.0, 0.3, 0.0)[i]
    lean = (0, 14, 26, 6)[i]
    p = _body("standing", z=0.90 - 0.06 * (i == 1), pel=(10 + lean * 0.5, 0), chest=(14 + lean, -8), head=(16, 0))
    p["footL"] = foot(-0.14, -0.06, yaw=10)
    p["footR"] = foot(0.12, 0.26, z=ANKLE + 0.30 * up, yaw=-5, pitch=-10 * up)
    hz = (0.30, 0.20, 0.10, 0.26)[i]
    _hands(p, (-0.10, 0.36, hz), (0.12, 0.34, hz - 0.12), polel=(-1, 0, -0.3), poler=(1, 0, -0.3))
    return p


def a_crew_load_gun(t, w):
    i = min(4, int(t * 5))
    if i == 0:      # shell cradled in both arms
        p = _body("standing", z=0.88, y=-0.18, pel=(12, -10), chest=(14, -8), head=(-4, 8))
        p["footL"], p["footR"] = foot(-0.13, -0.10, yaw=8), foot(0.14, -0.28, yaw=-16)
        _hands(p, (-0.06, 0.36, 0.14), (0.16, 0.20, 0.12))
        p["props"] = {"shell": ("chest", (0.05, 0.30, 0.20), (-90, 0, 20))}
    elif i == 1:    # step to the breech
        p = _body("standing", z=0.84, y=-0.04, pel=(18, -4), chest=(20, 0), head=(-10, 0))
        p["footL"], p["footR"] = foot(-0.13, 0.20, yaw=5), foot(0.14, -0.26, yaw=-16, z=0.12, pitch=25)
        _hands(p, (-0.04, 0.44, 0.16), (0.12, 0.26, 0.14))
        p["props"] = {"shell": ("chest", (0.04, 0.40, 0.21), (-90, 0, 6))}
    elif i == 2:    # ram it home
        p = _body("standing", z=0.80, y=0.04, pel=(28, 4), chest=(30, 10), head=(-22, -6))
        p["footL"], p["footR"] = foot(-0.13, 0.26, yaw=5), foot(0.14, -0.30, yaw=-16, z=0.12, pitch=30)
        _hands(p, (-0.10, 0.30, 0.20), (0.06, 0.56, 0.24), poler=(1, 0, -0.4))
    elif i == 3:    # withdraw
        p = _body("standing", z=0.86, y=-0.10, pel=(10, -10), chest=(8, -16), head=(-4, 14))
        p["footL"], p["footR"] = foot(-0.13, 0.04, yaw=8), foot(0.16, -0.30, yaw=-25)
        _hands(p, (-0.24, 0.16, 0.06), (0.26, 0.22, 0.20))
    else:           # crouch aside, clear of the recoil
        p = _body("crouched", y=-0.24, pel=(24, -30), chest=(30, -20), head=(-18, 40))
        p["pelvis_pos"] = (0.16, -0.24, 0.56)
        p["footL"], p["footR"] = foot(0.0, -0.04, yaw=-10), foot(0.34, -0.30, yaw=-40, z=0.10, pitch=20)
        _hands(p, (-0.20, 0.22, 0.04), (0.24, 0.20, 0.04))
    return p


def a_crew_load_mortar(t, w):
    i = min(3, int(t * 4))
    if i == 0:      # bomb held over the muzzle
        p = _body("crouched", z=0.66, pel=(16, 0), chest=(14, 0), head=(-14, 0))
        _hands(p, (-0.07, 0.42, 0.50), (0.07, 0.42, 0.50), polel=(-1, 0, -0.4), poler=(1, 0, -0.4))
        p["props"] = {"bomb": ("chest", (0, 0.46, 0.44), (-20, 0, 0))}
    elif i == 1:    # let go
        p = _body("crouched", z=0.64, pel=(18, 0), chest=(18, 0), head=(-6, 0))
        _hands(p, (-0.16, 0.40, 0.46), (0.16, 0.40, 0.46), polel=(-1, 0, -0.4), poler=(1, 0, -0.4))
        p["props"] = {"bomb": ("chest", (0, 0.46, 0.28), (-20, 0, 0))}
    elif i == 2:    # duck, hands to the ears
        p = _body("crouched", z=0.50, y=-0.26, pel=(30, 24), chest=(50, 20), head=(30, 10))
        hz = NECK.z + 0.16 * HEAD
        _hands(p, (-0.13, 0.05, hz), (0.13, 0.05, hz), polel=(-1, 0.5, 0), poler=(1, 0.5, 0))
    else:           # recover, reaching for the next bomb
        p = _body("crouched", z=0.60, pel=(22, 10), chest=(24, 6), head=(-20, -6))
        _hands(p, (-0.22, 0.24, 0.10), (0.26, 0.10, -0.04))
    return p


def _set_down(prop, carry_rot, down_rot, down_y=0.46):
    """Generic 4-frame 'carry it in, lower it, seat it, press/check' task."""
    def f(t, w):
        i = min(3, int(t * 4))
        if i == 0:
            p = _body("standing", z=0.90, y=-0.16, pel=(10, 0), chest=(12, 0), head=(6, 0))
            p["footL"], p["footR"] = foot(-0.13, -0.04, yaw=8), foot(0.14, -0.26, yaw=-14)
            _hands(p, (-0.18, 0.34, 0.12), (0.18, 0.34, 0.12))
            p["props"] = {prop: ("chest", (0, 0.40, 0.12), carry_rot)}
        elif i == 1:
            p = _body("crouched", z=0.66, pel=(26, 0), chest=(34, 0), head=(-4, 0))
            _hands(p, (-0.18, 0.40, 0.0), (0.18, 0.40, 0.0))
            p["props"] = {prop: ("chest", (0, 0.46, 0.0), tuple(lerp(a, b, 0.5) for a, b in zip(carry_rot, down_rot)))}
        elif i == 2:
            p = _body("crouched", z=0.52, pel=(30, 0), chest=(44, 0), head=(0, 0))
            _hands(p, (-0.17, 0.40, -0.04), (0.17, 0.40, -0.04))
            p["props"] = {prop: ("root", (0, down_y, 0.04 if prop == "plate" else 0.30), down_rot)}
        else:
            p = _body("kneeling", pel=(10, -8), chest=(24, 0), head=(4, 0))
            _hands(p, (-0.12, 0.44, 0.10), (0.14, 0.42, 0.02))
            p["props"] = {prop: ("root", (0, down_y, 0.04 if prop == "plate" else 0.30), down_rot)}
        return p
    return f


def a_crew_tube(t, w):
    i = min(3, int(t * 4))
    ang = (-20, -35, -48, -50)[i]           # tube leaning forward as it is seated
    p = _body("crouched" if i < 3 else "kneeling", z=(0.74, 0.66, 0.58, 0.50)[i], pel=(18, -6), chest=(20 + 4 * i, 0), head=(-8, 0))
    hy = 0.36 + 0.03 * i
    _hands(p, (-0.06, hy + 0.10, 0.36 - 0.06 * i), (0.08, hy - 0.04, 0.16 - 0.06 * i), polel=(-1, 0, -0.5), poler=(1, 0, -0.5))
    p["props"] = {"tube": ("root", (0.0, 0.55 + 0.05 * i, (0.62, 0.52, 0.42, 0.40)[i]), (ang, 0, 0))}
    return p


def a_crew_bipod(t, w):
    i = min(3, int(t * 4))
    p = _body("kneeling", pel=(12, -8), chest=(26 + 6 * (i % 2), 6 - 12 * (i % 2)), head=(2, 0))
    sp = (0.06, 0.12, 0.2, 0.2)[i]
    _hands(p, (-0.08 - sp, 0.46, 0.10 - 0.03 * i), (0.08 + sp, 0.46, 0.10 - 0.03 * i), polel=(-1, 0, -0.3), poler=(1, 0, -0.3))
    if i < 2:
        p["props"] = {"tripod": ("chest", (0, 0.46, 0.12), (-70 + 20 * i, 0, 0))}
    return p


def a_crew_mountmg(t, w):
    i = min(3, int(t * 4))
    if i == 0:
        p = _body("standing", z=0.88, y=-0.18, pel=(12, 0), chest=(14, 0), head=(4, 0))
        p["footL"], p["footR"] = foot(-0.13, -0.06, yaw=8), foot(0.14, -0.28, yaw=-14)
        _hands(p, (-0.10, 0.44, 0.16), (0.12, 0.20, 0.14))
        p["props"] = {"mgun": ("chest", (0.02, 0.10, 0.22), (4, 0, 8))}
    elif i == 1:
        p = _body("crouched", z=0.62, pel=(24, 0), chest=(30, 0), head=(-6, 0))
        _hands(p, (-0.10, 0.50, 0.06), (0.12, 0.24, 0.04))
        p["props"] = {"mgun": ("chest", (0.02, 0.14, 0.12), (2, 0, 4))}
    else:
        p = _body("kneeling", pel=(10 + 4 * (i == 2), -6), chest=(26 + 6 * (i == 2), 0), head=(0, 0))
        _hands(p, (-0.10, 0.48, 0.08), (0.12, 0.30, 0.06 - 0.04 * (i == 3)))
    return p


def a_crew_belt(t, w):
    i = min(3, int(t * 4))
    p = _body("kneeling", z=0.46, pel=(16, 14), chest=(34, 10), head=(4, 8))
    reach = (0.0, 0.10, 0.18, 0.06)[i]
    _hands(p, (-0.16, 0.34 + reach, 0.04), (0.10, 0.30 + reach * 0.6, 0.0 + 0.06 * (i == 2)), polel=(-1, 0, -0.2), poler=(1, 0, -0.2))
    p["props"] = {"box": ("root", (-0.08, 0.42, 0.0), (0, 0, 20))}
    return p


def a_crew_mg(fire=False):
    def f(t, w):
        p = base("prone", None)
        k = sn(t)
        rc = (0.025 * (1 if int(t * 2) == 0 else -0.4)) if fire else 0.0
        p.update(pelvis_rot=(90, 0, 0, 0), chest_rot=(-14 - (4 * k if fire else 0), 0, 0), head_rot=(-46, 0, 0 if fire else 3 * k))
        p["pelvis_pos"] = (0, -0.25 - rc, 0.125)
        p["weapon"] = None
        p["handL"] = dict(frame="root", pos=(-0.07, 0.70 - rc, 0.30), pole=(-1, -0.3, -0.5), pole_frame="root")
        p["handR"] = dict(frame="root", pos=(0.07, 0.70 - rc, 0.30), pole=(1, -0.3, -0.5), pole_frame="root")
        return p
    return f


def a_crew_carry(kind):
    def f(t, w):
        p = a_walk()(t, None)
        p["weapon"] = None
        c = p["chest_rot"]
        p["chest_rot"] = (c[0] + 10, 0, c[2] * 0.5)
        p["pelvis_rot"] = (10, 0, p["pelvis_rot"][2], 0)
        sw = 0.10 * cs(t)
        p["handL"] = dict(frame="chest", pos=(-0.28, 0.06 + sw, -0.06), pole=(-1, -0.5, -0.3))
        if kind == "tube":
            p["props"] = {"tube": ("chest", (0.21, 0.02, 0.50), (-82, 0, 4))}
            p["handR"] = dict(frame="chest", pos=(0.23, 0.30, 0.48), pole=(1, 0, -1))
        elif kind == "mg":
            p["props"] = {"mgun": ("chest", (0.21, -0.22, 0.52), (8, 0, 3))}
            p["handR"] = dict(frame="chest", pos=(0.23, 0.30, 0.52), pole=(1, 0, -1))
        elif kind == "plate":
            p["props"] = {"plate": ("chest", (0.0, -0.20, 0.22), (90, 0, 0))}
            p["handR"] = dict(frame="chest", pos=(0.16, 0.12, 0.34), pole=(1, -0.3, -1))
            p["handL"] = dict(frame="chest", pos=(-0.16, 0.12, 0.34), pole=(-1, -0.3, -1))
        else:
            p["props"] = {"tripod": ("chest", (0.0, -0.20, 0.18), (8, 0, 0))}
            p["handR"] = dict(frame="chest", pos=(0.16, 0.12, 0.34), pole=(1, -0.3, -1))
        return p
    return f


def a_crew_haul(t, w):
    p = base("standing", None)
    p["footL"], p["footR"] = gait_feet(t, 0.20, 0.07, xoff=0.14, y0=-0.10)
    p["pelvis_pos"] = (0, 0.0, 0.84 - 0.02 * abs(cs(t)))
    p["pelvis_rot"] = (30, 0, 5 * cs(t), 0)
    p["chest_rot"] = (22, 0, -6 * cs(t))
    p["head_rot"] = (-30, 0, 0)
    p["weapon"] = None
    p["handL"] = dict(frame="root", pos=(-0.20, -0.42, 0.62), pole=(-1, -0.3, 0.3), pole_frame="root")
    p["handR"] = dict(frame="root", pos=(0.20, -0.42, 0.62), pole=(1, -0.3, 0.3), pole_frame="root")
    return p


CRUSHED = [
    dict(face_up=False, twist=0, heading=25, armL=(140, 0.5), armR=(70, 0.5), legL=(20, 0.7), legR=(30, 0.7), head=(10, 0, 40), weapon=None),
    dict(face_up=True, twist=0, heading=-70, armL=(100, 0.52), armR=(125, 0.5), legL=(28, 0.7), legR=(14, 0.72), head=(0, 0, -30), weapon=None),
    dict(face_up=False, twist=0, heading=100, armL=(60, 0.5), armR=(150, 0.5), legL=(10, 0.72), legR=(34, 0.7), head=(8, 0, -45), weapon=None),
    dict(face_up=True, twist=0, heading=160, armL=(80, 0.5), armR=(40, 0.46), legL=(32, 0.7), legR=(18, 0.72), head=(0, 0, 35), weapon=None),
]


def a_crushed(n):
    def f(t, w):
        p = sprawl(**CRUSHED[n])
        p["squash"] = (1.04, 1.04, 0.30)
        p["props"] = {"stain": ("root", ((-0.06, 0.05, 0.04, -0.03)[n], 0, 0), (0, 0, (0, 180, 0, 180)[n] * 0 + (4, -5, 3, -2)[n]))}
        return p
    return f


def a_pickup(posture):
    def f(t, w):
        if posture == "prone":
            i = min(2, int(t * 3))
            p = base("prone", w)
            p["chest_rot"] = (-10, 0, (18, 26, 8)[i])
            p["head_rot"] = (-30, 0, (20, 28, 10)[i])
            if w:
                p["weapon"] = dict(frame="root", pos=(0.28, 0.22, 0.07), rot=(0, 6, 80))
                p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.3, 0.2), pole_frame="root")
            p["handL"] = dict(frame="root", pos=((-0.30, -0.34, -0.22)[i], (0.62, 0.78, 0.50)[i], 0.05), pole=(-1, -0.3, 0.2), pole_frame="root")
            return p
        i = min(3, int(t * 4))
        lo = {"standing": 0.0, "crouched": 0.5, "kneeling": 0.6}[posture]
        d = (0.45, 1.0, 0.8, 0.25)[i]                     # bend, reach, lift, rise
        d = lo + (1 - lo) * d
        p = base("crouched", w)
        st = base(posture, w)
        p["pelvis_pos"] = lerpv(st["pelvis_pos"], (0, -0.18, 0.48), d)
        p["pelvis_rot"] = (lerp(st["pelvis_rot"][0], 34, d), 0, 0, 0)
        p["chest_rot"] = (lerp(st["chest_rot"][0], 50, d), 0, 12 * d)
        p["head_rot"] = (lerp(0, 10, d), 0, 0)
        if posture == "kneeling":
            p["footL"], p["footR"] = st["footL"], st["footR"]
        if w:
            p["weapon"] = dict(frame="chest", pos=(0.26, 0.10, 0.06), rot=(lerp(-60, -20, d), 8, 0))
            p["handR"] = dict(frame="w", pos="grip")
        gz = (0.30, 0.04, 0.16, 0.5)[i]
        p["handL"] = dict(frame="root", pos=(-0.10, 0.46 if i in (1, 2) else 0.34, gz + (0.35 if i == 0 else 0)), pole=(-1, 0, 0.2), pole_frame="root")
        return p
    return f


# ---- blown-off parts (parts atlas): a sprawl with only some segments kept, recentred, plus a blot
PART_SETS = {
    "torso": ("chest", "pelvis"),
    "head": ("head",),
    "arm": ("uarmL", "farmL", "handL"),
    "leg": ("thighR", "shinR", "footR"),
    "boot": ("shinL", "footL"),
}


def a_part(kind, n):
    spec = dict(CORPSES[(n * 2 + len(kind)) % len(CORPSES)], weapon=None, heading=(0, 130, -100)[n], twist=0, chest=(0, 0, 0), z=0.14)
    def f(t, w):
        p = sprawl(**spec)
        only = list(PART_SETS[kind])
        if kind == "head":
            if n == 2:
                p["bare"] = True
                only = ["headbare"]
            p["head_rot"] = (0, 0, (40, -60, 20)[n])
        if kind == "arm" and n == 1:
            only = ["uarmR", "farmR", "handR"]
        if kind == "leg" and n == 2:
            only = ["thighL", "shinL", "footL"]
        if kind == "boot":
            only = [("shinL", "footL"), ("footR",), ("shinR", "footR")][n]
        p["only"] = list(only) + ["blot"]
        p["props"] = {"blot": ("root", (0, 0, 0), (0, 0, n * 70))}
        p["part_blot"] = True
        return p
    return f


def a_debris(name, n):
    def f(t, w):
        p = sprawl(weapon=None)
        p["only"] = [name]
        p["props"] = {name: ("root", (0, 0, 0), (0, 0, (15, -40, 70)[n])),
                      "blot": ("root", (0.05, -0.04, 0), (0, 0, n * 50))}     # scorch mark under it
        return p
    return f


def build_part_entries():
    E = {}
    for kind in PART_SETS:
        for n in range(3):
            E[f"part.{kind}{n}"] = dict(fn=a_part(kind, n), frames=1, fps=1, loop=False, weapons=("rifle",), shadow=True,
                                        sample="loop", extra=dict(helmet=(kind == "head" and n < 2)) if kind == "head" else {})
    for kind in ("plate", "wheel", "hatch"):       # appended: vehicle debris (true scale, side-neutral)
        for n in range(3):
            E[f"part.{kind}{n}"] = dict(fn=a_debris(f"{kind}{n}", n), frames=1, fps=1, loop=False, weapons=("rifle",),
                                        shadow=True, sample="loop", extra=dict(debris=True))
    return E


HULL_H = 1.5 / FIG          # a hull roof about 1.5 m above the ground (true metres)


def a_bailout(reverse=False):
    """Climbing out of a hatch and dropping to the ground (or, reversed, mounting).  Frame = progress."""
    H = HULL_H

    def f(t, w):
        i = min(5, int(t * 6))
        if reverse:
            i = 5 - i
        sl = dict(frame="chest", pos=(0.04, -0.20, 0.22), rot=(78, 8, 0))       # rifle slung on the back
        if i == 0:      # head and shoulders, arms braced on the rim
            p = dict(pelvis_pos=(0, -0.05, H - 0.38), pelvis_rot=(4, 0, 0, 0), chest_rot=(8, 0, 0), head_rot=(-6, 0, 10),
                     footL=foot(-0.1, 0, z=H - 1.2), footR=foot(0.1, 0, z=H - 1.2),
                     hide=("pelvis", "thighL", "thighR", "shinL", "shinR", "footL", "footR"))
            _hands(p, (-0.40, 0.12, H + 0.03), (0.40, 0.12, H + 0.03), frame="root", polel=(-1, -0.4, 0.4), poler=(1, -0.4, 0.4))
        elif i == 1:    # torso pushed up on straight arms
            p = dict(pelvis_pos=(0, -0.02, H + 0.02), pelvis_rot=(12, 0, 0, 0), chest_rot=(12, 0, 0), head_rot=(-10, 0, 0),
                     footL=foot(-0.1, 0, z=H - 0.8), footR=foot(0.1, 0, z=H - 0.8),
                     hide=("thighL", "thighR", "shinL", "shinR", "footL", "footR"))
            _hands(p, (-0.36, 0.06, H + 0.03), (0.36, 0.06, H + 0.03), frame="root", polel=(-1, -0.6, 0.2), poler=(1, -0.6, 0.2))
        elif i == 2:    # one knee on the rim
            p = dict(pelvis_pos=(0, 0.02, H + 0.34), pelvis_rot=(30, 0, 12, 0), chest_rot=(18, 0, 0), head_rot=(-20, 0, 0),
                     footL=foot(-0.12, -0.05, z=H - 0.35, pole=(0, 1, 0)),
                     footR=foot(0.22, -0.34, z=H + 0.10, pitch=60, pole=(0.3, 1, -0.6)),
                     hide=("shinL", "footL"))
            _hands(p, (-0.34, 0.30, H + 0.03), (0.30, 0.34, H + 0.03), frame="root", polel=(-1, -0.4, 0.3), poler=(1, -0.4, 0.3))
        elif i == 3:    # sitting on the edge, legs swinging over
            p = dict(pelvis_pos=(0, 0.10, H + 0.13), pelvis_rot=(-8, 0, 0, 0), chest_rot=(18, 0, 0), head_rot=(10, 0, 0),
                     footL=foot(-0.14, 0.62, z=H - 0.30, pitch=20, pole=(0, 0.3, 1)),
                     footR=foot(0.14, 0.50, z=H - 0.42, pitch=20, pole=(0, 0.3, 1)))
            _hands(p, (-0.30, 0.02, H + 0.03), (0.30, 0.02, H + 0.03), frame="root", polel=(-1, -0.6, 0.2), poler=(1, -0.6, 0.2))
        elif i == 4:    # dropping
            p = dict(pelvis_pos=(0, 0.22, 1.12), pelvis_rot=(10, 0, 0, 0), chest_rot=(10, 0, 0), head_rot=(14, 0, 0),
                     footL=foot(-0.14, 0.30, z=0.42, pitch=25), footR=foot(0.14, 0.16, z=0.34, pitch=25))
            _hands(p, (-0.46, 0.10, 0.62), (0.46, 0.10, 0.56), polel=(-1, -0.3, -0.4), poler=(1, -0.3, -0.4))
        else:           # landed in a crouch, one hand down
            p = dict(pelvis_pos=(0, 0.20, 0.50), pelvis_rot=(30, 0, -6, 0), chest_rot=(34, 0, 0), head_rot=(-30, 0, 0),
                     footL=foot(-0.17, 0.38, yaw=12), footR=foot(0.17, 0.12, yaw=-16, z=0.10, pitch=20))
            _hands(p, (-0.20, 0.46, -0.10), (0.34, 0.16, 0.10), polel=(-1, 0, 0), poler=(1, -0.4, 0))
        p["weapon"] = sl
        return p
    return f


# ---- sprawls: corpses, landed ragdolls, last hit frame -----------------------------------
def sprawl(face_up=False, twist=0, heading=0, armL=(120, 0.5), armR=(60, 0.5), legL=(12, 0.85), legR=(25, 0.8),
           head=(0, 0, 30), chest=(0, 0, 0), weapon=(0.5, 0.1, 20), z=0.12, lift=0.0, y_bias=0.0):
    """Body lying in the ground plane.  arm = (angle from hips-ward, reach); leg = (angle outward, reach)."""
    pitch = -90 if face_up else 90
    off = Rz(heading) @ Vector((0, 0.15 if face_up else -0.15, 0))
    p = dict(pelvis_pos=(off.x, off.y + y_bias, z + lift), pelvis_rot=(pitch + (lift and 0), 0, heading, twist),
             chest_rot=chest, head_rot=head)
    fy = 0.06 if not face_up else -0.04
    for s, sx, arm, leg in (("L", -1, armL, legL), ("R", 1, armR, legR)):
        a = math.radians(arm[0])
        r = arm[1]
        p["hand" + s] = dict(frame="chest", pos=(sx * (SHOULDER.x + r * math.sin(a)), fy, SHOULDER.z - r * math.cos(a)),
                             pole=(sx * abs(math.cos(a)) + 0.001, 0.12 if face_up else -0.12, -math.sin(a)))
        b = math.radians(leg[0])
        r = min(leg[1], 0.80)
        p["foot" + s] = dict(frame="pelvis", pos=(sx * (HIP.x + r * math.sin(b)), fy * 0.5, HIP.z - r * math.cos(b)),
                             yaw=-sx * 35, pitch=65, pole=(sx, 0.3 if face_up else -0.3, 0.0))
    if weapon:
        # keep the dropped weapon inside the cell: its middle (0.24 ahead of the grip) within 0.62 m
        wv = Vector((weapon[0], weapon[1], 0))
        if wv.length > 0.52:
            wv *= 0.52 / wv.length
        mid = (Rz(weapon[2]) @ Vector((0, 0.24, 0)))
        p["weapon"] = dict(frame="root", pos=(wv.x - mid.x, wv.y - mid.y, 0.05), rot=(0, weapon[2], 85))
    else:
        p["weapon"] = None
    return p


CORPSES = [
    dict(face_up=False, twist=8, heading=10, armL=(150, 0.5), armR=(40, 0.42), legL=(8, 0.86), legR=(32, 0.7), head=(10, 0, 40), weapon=(0.55, 0.35, 25)),
    dict(face_up=True, twist=-6, heading=-15, armL=(95, 0.55), armR=(135, 0.5), legL=(22, 0.84), legR=(6, 0.86), head=(-10, 0, -35), weapon=(-0.62, -0.1, -40)),
    dict(face_up=False, twist=50, heading=-30, armL=(60, 0.4), armR=(100, 0.5), legL=(5, 0.7), legR=(40, 0.62), head=(20, 0, -20), chest=(20, 0, 0), weapon=(0.2, 0.75, 70)),
    dict(face_up=True, twist=25, heading=35, armL=(170, 0.52), armR=(70, 0.5), legL=(35, 0.75), legR=(10, 0.86), head=(0, 0, 50), weapon=(0.7, -0.3, -10)),
    dict(face_up=False, twist=-35, heading=60, armL=(30, 0.45), armR=(160, 0.54), legL=(28, 0.8), legR=(14, 0.6), head=(15, 0, 60), chest=(12, 0, 10), weapon=(-0.5, 0.5, 100)),
    dict(face_up=True, twist=-55, heading=-70, armL=(110, 0.4), armR=(50, 0.5), legL=(10, 0.62), legR=(30, 0.7), head=(10, 0, -30), chest=(25, 0, 0), weapon=(0.35, -0.75, 150)),
]
CORPSES += [
    dict(face_up=False, twist=-10, heading=140, armL=(100, 0.5), armR=(160, 0.5), legL=(30, 0.8), legR=(8, 0.84), head=(12, 0, -50), weapon=(-0.5, 0.2, 60)),
    dict(face_up=True, twist=35, heading=-160, armL=(45, 0.45), armR=(120, 0.52), legL=(12, 0.84), legR=(38, 0.64), head=(-5, 0, 30), chest=(12, 0, 6), weapon=(0.6, -0.1, -140)),
]
LANDED = [
    dict(face_up=True, twist=10, heading=20, armL=(140, 0.54), armR=(110, 0.54), legL=(30, 0.84), legR=(20, 0.8), head=(-5, 0, 25), weapon=(0.85, 0.5, 60)),
    dict(face_up=False, twist=-12, heading=-25, armL=(165, 0.54), armR=(150, 0.5), legL=(18, 0.86), legR=(38, 0.74), head=(8, 0, -45), weapon=(-0.8, 0.6, -30)),
    dict(face_up=True, twist=-40, heading=75, armL=(60, 0.5), armR=(165, 0.54), legL=(8, 0.7), legR=(42, 0.66), head=(0, 0, -40), chest=(14, 0, -12), weapon=(0.3, -0.95, 110)),
    dict(face_up=False, twist=40, heading=-80, armL=(100, 0.52), armR=(20, 0.45), legL=(40, 0.7), legR=(4, 0.84), head=(18, 0, 35), chest=(16, 0, 12), weapon=(-0.4, -0.9, 20)),
    dict(face_up=True, twist=0, heading=150, armL=(125, 0.54), armR=(80, 0.5), legL=(34, 0.8), legR=(34, 0.8), head=(-8, 0, 10), weapon=(0.9, 0.0, 140)),
    dict(face_up=False, twist=65, heading=-140, armL=(75, 0.4), armR=(120, 0.5), legL=(12, 0.6), legR=(36, 0.56), head=(25, 0, 0), chest=(30, 0, 0), weapon=(0.75, 0.75, -70)),
    dict(face_up=True, twist=55, heading=-110, armL=(150, 0.5), armR=(95, 0.4), legL=(36, 0.6), legR=(10, 0.8), head=(5, 0, 45), chest=(20, 0, 8), weapon=(-0.9, 0.2, 80)),
    dict(face_up=False, twist=-20, heading=110, armL=(45, 0.5), armR=(135, 0.54), legL=(26, 0.84), legR=(16, 0.84), head=(10, 0, 55), weapon=(0.1, 0.95, -100)),
]


def a_static(spec):
    return lambda t, w: sprawl(**spec)


def a_hit(posture):
    def f(t, w):
        i = min(2, int(t * 3))
        if posture == "standing":
            if i == 0:
                p = base("standing", w)
                p.update(pelvis_pos=(0.03, -0.08, 0.93), pelvis_rot=(-14, 6, 12, 0), chest_rot=(-20, 0, 18), head_rot=(-18, 0, -10))
                p["weapon"] = dict(frame="chest", pos=(0.34, 0.24, 0.20), rot=(50, 10, 30))
                p["handR"] = dict(frame="w", pos="grip")
                p["handL"] = dict(frame="chest", pos=(-0.50, 0.05, 0.55), pole=(-1, -0.5, -0.3))
                p["footL"] = foot(-0.14, 0.12, yaw=10)
                p["footR"] = foot(0.16, -0.24, yaw=-25)
            elif i == 1:
                p = dict(pelvis_pos=(0, -0.22, 0.58), pelvis_rot=(-52, 0, 10, 12), chest_rot=(-10, 0, 8), head_rot=(-16, 0, 20),
                         footL=foot(-0.16, 0.30, z=0.12, yaw=12, pitch=-20), footR=foot(0.18, 0.05, yaw=-30),
                         handL=dict(frame="chest", pos=(-0.52, 0.10, 0.62), pole=(-1, -0.4, -0.3)),
                         handR=dict(frame="chest", pos=(0.55, 0.12, 0.40), pole=(1, -0.4, -0.3)),
                         weapon=dict(frame="root", pos=(0.55, 0.30, 0.35), rot=(30, -30, 60)))
            else:
                p = sprawl(face_up=True, twist=-4, heading=-8, armL=(120, 0.52), armR=(80, 0.5), legL=(16, 0.84), legR=(28, 0.7),
                           head=(-6, 0, -25), weapon=(0.62, 0.35, -35), y_bias=-0.35, lift=0.03)
            return p
        if posture in ("crouched", "kneeling"):
            if i == 0:
                p = base(posture, w)
                pr, pp = p["pelvis_rot"], p["pelvis_pos"]
                p["pelvis_rot"] = (pr[0] - 16, 8, 14, 0)
                p["chest_rot"] = (-10, 0, 20)
                p["head_rot"] = (-20, 0, -15)
                p["weapon"] = dict(frame="chest", pos=(0.32, 0.22, 0.12), rot=(30, 0, 40))
                p["handR"] = dict(frame="w", pos="grip")
                p["handL"] = dict(frame="chest", pos=(-0.48, 0.10, 0.50), pole=(-1, -0.4, -0.3))
            elif i == 1:
                p = base(posture, None)
                p.update(pelvis_pos=(0.05, 0.0, 0.34), pelvis_rot=(55, 0, 20, 30), chest_rot=(25, 0, 10), head_rot=(20, 0, 20))
                p["handL"] = dict(frame="chest", pos=(-0.40, 0.25, 0.40), pole=(-1, 0, -0.5))
                p["handR"] = dict(frame="chest", pos=(0.45, 0.20, 0.10), pole=(1, 0, -0.5))
                p["weapon"] = dict(frame="root", pos=(0.50, 0.30, 0.12), rot=(10, -10, 70))
            else:
                p = sprawl(face_up=False, twist=32, heading=18, armL=(130, 0.46), armR=(55, 0.45), legL=(10, 0.66), legR=(42, 0.58),
                           head=(14, 0, 40), chest=(14, 0, 0), weapon=(0.55, 0.30, -5), y_bias=0.2)
            return p
        # prone
        if i == 0:
            p = base("prone", w)
            p.update(chest_rot=(-30, 0, 14), head_rot=(-60, 0, -20), pelvis_rot=(90, 0, -4, -14))
        elif i == 1:
            p = sprawl(face_up=False, twist=-38, heading=-4, armL=(140, 0.5), armR=(95, 0.5), legL=(12, 0.84), legR=(30, 0.74),
                       head=(-10, 0, 30), chest=(-8, 0, 10), weapon=(0.30, 0.58, 12), y_bias=-0.08, lift=0.03)
        else:
            p = sprawl(face_up=False, twist=-16, heading=-6, armL=(150, 0.5), armR=(80, 0.46), legL=(10, 0.86), legR=(30, 0.74),
                       head=(16, 0, 45), weapon=(0.34, 0.58, 22), y_bias=-0.08)
        return p
    return f


FLIGHTS = [  # (spin axis in root space, total degrees, peak height, start face_up?, flail phase, landed index it approaches)
    ((1, 0.1, 0), -250, 1.25, 0),
    ((1, -0.2, 0.1), 200, 1.05, 1),
    ((0.3, 1, 0.1), 300, 1.15, 2),
    ((-0.2, 1, 0.3), -280, 0.95, 3),
    ((1, 0.5, 0.4), -340, 1.35, 4),
    ((0.6, -0.8, 0.5), 320, 1.10, 5),
]


def a_flight(n):
    axis, total, peak, li = FLIGHTS[n]
    end = sprawl(**LANDED[li])

    def f(t, w):
        # t = 0..5/6 sampled; u runs 0..1 over the airborne part, last frame is just above the ground
        u = min(1.0, t * 6 / 5.0)
        hgt = 0.30 + 0.25 * peak * 4 * u * (1 - u) if u < 1 else 0.16
        ang = total * (1 - u) ** 1.0
        fl = (1 - u) * 0.9 + 0.1
        p = sprawl(**{**LANDED[li], "weapon": None})
        ep = end["pelvis_pos"]
        # spin the landed orientation backwards around the axis so the last frame matches the landed pose
        Rl = rot_body(*end["pelvis_rot"])
        Rs = Matrix.Rotation(math.radians(ang), 4, Vector(axis).normalized())
        p["pelvis_mat"] = T((ep[0], ep[1], hgt)) @ Rs @ Rl
        k = n * 1.7
        p["chest_rot"] = tuple(a + b for a, b in zip(end.get("chest_rot", (0, 0, 0)), (22 * fl * math.sin(u * 7 + k), 0, 25 * fl * math.cos(u * 6 + k))))
        for s, sx in (("L", -1), ("R", 1)):
            a = math.radians(95 + 60 * math.sin(u * 8 + k + sx) * fl + 20 * sx)
            r = 0.40
            p["hand" + s] = dict(frame="chest", pos=(sx * (SHOULDER.x + r * math.sin(a)), 0.28 * fl * math.cos(u * 9 + sx + k), SHOULDER.z - r * math.cos(a)),
                                 pole=(sx * abs(math.cos(a)) + 0.001, -0.5, -math.sin(a)))
            b = math.radians(24 + 22 * math.sin(u * 7 + k * 2 + sx * 2) * fl)
            r = 0.66 + 0.1 * math.sin(u * 5 + sx)
            p["foot" + s] = dict(frame="pelvis", pos=(sx * (HIP.x + r * math.sin(b)), 0.34 * fl * math.sin(u * 8 + sx * 1.5 + k), HIP.z - r * math.cos(b)),
                                 yaw=-sx * 25, pitch=50, pole=(sx * 0.4, 1, 0.0))
        # the rifle tumbles away on its own
        lw = LANDED[li]["weapon"]
        ewp = end["weapon"]["pos"]
        p["weapon"] = dict(frame="root", pos=(ewp[0] * (0.3 + 0.7 * u), ewp[1] * (0.3 + 0.7 * u), 0.05 + (hgt - 0.1) * 0.8),
                           rot=((1 - u) * 260 + k * 30 * (1 - u), lw[2] + (1 - u) * 200, 85))
        return p
    return f


# ---- getting down / getting up ---------------------------------------------------------------
def a_drop(t, w):
    """Standing -> prone in 6 frames (the game plays it backwards to get up): step forward and
    crouch, drop onto the right knee, both knees with the weapon hand going down, hands on the
    ground, body stretched out, flat.  Frame = progress."""
    i = min(5, int(round(t * 5)))
    if i == 0:
        p = base("standing", w)
        p["pelvis_pos"] = (0, -0.02, 0.90)
        p["pelvis_rot"] = (10, 0, -8, 0)
        p["chest_rot"] = (12, 0, -6)
        p["footL"] = foot(-0.12, 0.26, yaw=8)
        return p
    if i == 1:
        p = base("crouched", w)
        p["pelvis_pos"] = (0, -0.08, 0.62)
        p["footL"] = foot(-0.13, 0.36, yaw=6, pole=(-0.1, 1, 0.4))
        p["footR"] = foot(0.15, -0.30, z=0.10, yaw=-12, pitch=35)
        return p
    if i == 2:
        p = base("kneeling", w)
        p["pelvis_pos"] = (0, 0.0, 0.46)
        p["pelvis_rot"] = (22, 0, -6, 0)
        p["chest_rot"] = (30, 0, -4)
        p["footL"] = foot(-0.13, 0.34, yaw=5, pole=(-0.1, 1, 0.5))
        return p
    # weapon laid ahead as he goes down (kept inside the cell: an LMG sits further back)
    wp = dict(frame="root", pos=(0.22, 0.28 if w == "lmg" else 0.42, 0.06), rot=(0, 8, 70)) if w else None
    if i == 3:      # both knees down, weapon hand to the ground ahead
        p = base("kneeling", None)
        p.update(pelvis_pos=(0, 0.02, 0.40), pelvis_rot=(42, 0, -4, 0), chest_rot=(34, 0, 0), head_rot=(-24, 0, 0),
                 footL=foot(-0.14, -0.46, z=0.07, yaw=6, pitch=62, pole=(-0.05, 0.4, -1)),
                 footR=foot(0.14, -0.46, z=0.07, yaw=-6, pitch=62, pole=(0.05, 0.4, -1)))
        p["weapon"] = wp
        p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.3, 0.2), pole_frame="root") if w else \
            dict(frame="root", pos=(0.22, 0.60, 0.05), pole=(1, -0.3, 0.2), pole_frame="root")
        p["handL"] = dict(frame="root", pos=(-0.20, 0.66, 0.05), pole=(-1, -0.3, 0.2), pole_frame="root")
        return p
    if i == 4:      # on the hands, legs going out behind
        p = base("prone", w)
        p.update(pelvis_pos=(0, -0.18, 0.30), pelvis_rot=(70, 0, -4, 0), chest_rot=(-6, 0, 0), head_rot=(-40, 0, 0),
                 footL=foot(-0.20, -0.98, z=0.08, yaw=20, pitch=45, pole=(-0.3, 0.2, -1)),
                 footR=foot(0.22, -0.96, z=0.08, yaw=-20, pitch=45, pole=(0.3, 0.2, -1)))
        p["weapon"] = wp
        p["handR"] = dict(frame="w", pos="grip", pole=(1, -0.3, 0.2), pole_frame="root") if w else \
            dict(frame="root", pos=(0.24, 0.62, 0.05), pole=(1, -0.3, 0.2), pole_frame="root")
        p["handL"] = dict(frame="root", pos=(-0.24, 0.62, 0.05), pole=(-1, -0.3, 0.2), pole_frame="root")
        return p
    return base("prone", w)


# ---- first aid (sim/medic.ts): bandaging a comrade, dragging him to cover ------------------
def a_bandage(t, w):
    """Kneeling over a man lying in front of him, both hands working a dressing; the rifle laid
    down beside him.  Loops (4 frames): reach in, wrap, pull tight, glance up."""
    p = base("kneeling", None)
    p["pelvis_pos"] = (0, -0.10, 0.46)
    p["pelvis_rot"] = (24, 0, -4, 0)
    p["chest_rot"] = (key(t, 48, 54, 50, 40, 48), 0, key(t, 0, 6, -4, 0, 0))
    p["head_rot"] = (key(t, 26, 30, 28, -4, 26), 0, key(t, 0, 4, -4, 18, 0))
    a = 2 * math.pi * t
    p["handL"] = dict(frame="root", pos=(-0.10 + 0.05 * math.cos(a), 0.64 + 0.05 * math.sin(a), 0.10 + 0.03 * math.sin(a)),
                      pole=(-1, -0.2, 0.3), pole_frame="root")
    p["handR"] = dict(frame="root", pos=(0.12 - 0.05 * math.cos(a), 0.62 - 0.05 * math.sin(a), 0.10 + 0.03 * math.cos(a)),
                      pole=(1, -0.2, 0.3), pole_frame="root")
    p["weapon"] = dict(frame="root", pos=(0.46, -0.18, 0.05), rot=(0, 20, 85))
    return p


DRAG_M = 1.3      # medic anchor -> dragged man's anchor (true metres); sim/medic.ts DRAG_M must match


def a_drag(t, w):
    """Dragging a casualty by his shoulder straps: bent low, facing him, stepping backwards.
    The man himself is `prone.dragged`, placed DRAG_M in front of this figure by the game."""
    p = base("standing", None)
    p["footL"], p["footR"] = gait_feet(1.0 - t, 0.16, 0.07, xoff=0.16, y0=-0.18)
    p["pelvis_pos"] = (0, -0.20, 0.74 - 0.02 * abs(cs(t)))
    p["pelvis_rot"] = (34, 0, 4 * cs(t), 0)
    p["chest_rot"] = (22, 0, -5 * cs(t))
    p["head_rot"] = (-28, 0, 0)
    p["weapon"] = dict(frame="chest", pos=(0.0, -0.19, 0.24), rot=(22, -90, 0))    # slung across the back
    gy = 0.54
    p["handL"] = dict(frame="root", pos=(-0.14, gy, 0.26), pole=(-1, -0.3, 0.3), pole_frame="root")
    p["handR"] = dict(frame="root", pos=(0.14, gy, 0.26), pole=(1, -0.3, 0.3), pole_frame="root")
    return p


def a_dragged(t, w):
    """A casualty on his back being dragged head first toward +Y (the man pulling him)."""
    p = dict(pelvis_pos=(0, 0.0, 0.14), pelvis_rot=(-90, 0, 180, 0), chest_rot=(-6, 0, 4), head_rot=(-24, 0, 14),
             footL=foot(-0.14, -0.86, z=0.08, yaw=190, pitch=-80, pole=(-0.4, 0, 1)),
             footR=foot(0.16, -0.84, z=0.08, yaw=170, pitch=-80, pole=(0.4, 0, 1)))
    # arms dragged up past the shoulders by the pull
    p["handL"] = dict(frame="chest", pos=(-0.44, 0.02, 0.62), pole=(-1, 0.3, 0))
    p["handR"] = dict(frame="chest", pos=(0.46, 0.04, 0.58), pole=(1, 0.3, 0))
    p["weapon"] = None
    return p


def a_wounded(t, w):
    """A man who is down but alive (incapacitated), lying on his back: one knee drawn up, a hand
    pressed to his chest, head turned aside.  Distinct from the face-down sprawl of the dead.
    Same orientation as `prone.dragged` (head toward +Y) so a drag begins and ends without a pop."""
    p = dict(pelvis_pos=(0, 0.0, 0.14), pelvis_rot=(-90, 0, 180, 0), chest_rot=(-4, 0, 6), head_rot=(-10, 0, 28),
             footL=foot(-0.15, -0.86, z=0.08, yaw=195, pitch=-80, pole=(-0.4, 0, 1)),
             footR=foot(0.16, -0.56, z=ANKLE, yaw=180, pitch=0, pole=(0.25, 0, 1)))
    p["handL"] = dict(frame="chest", pos=(-0.06, 0.13, 0.26), pole=(-1, 0.2, 0))
    p["handR"] = dict(frame="chest", pos=(0.52, 0.02, 0.18), pole=(1, 0.3, 0))
    p["weapon"] = None
    return p


# ------------------------------------------------------------------------------------------
# entry table
# ------------------------------------------------------------------------------------------
POSTURES = ["standing", "crouched", "kneeling", "prone"]
STRIDE = {"walk": 4 * WALK_AMP, "run": 4 * RUN_AMP, "sneak": 4 * SNEAK_AMP, "crawl": 0.38 * 2, "woundedCrawl": 0.44}


def build_entries():
    """-> ordered dict key -> dict(fn, frames, fps, loop, weapons, shadow, extra)"""
    E = {}

    def add(k, fn, frames, fps, loop=True, weapons=("rifle",), shadow=True, sample="loop", shadow_rows=None, **extra):
        E[k] = dict(fn=fn, frames=frames, fps=fps, loop=loop, weapons=weapons, shadow=shadow, sample=sample,
                    shadow_rows=shadow_rows, extra=extra)

    ALLW = ("rifle", "smg", "lmg")
    ALLN = ("rifle", "smg", "lmg", "none")
    for po in POSTURES:
        add(f"{po}.idle", a_idle(po), 4, 3.3, weapons=ALLN)
        add(f"{po}.aim", a_aim(po), 2, 2, weapons=ALLW)
        add(f"{po}.fire", a_fire(po), 3, 12, loop=False, weapons=ALLW, sample="once")
        add(f"{po}.reload", a_reload(po), 4, 3, loop=False, sample="step")
        add(f"{po}.hide", a_hide(po), 2, 1.5, weapons=("rifle", "none"))
        add(f"{po}.pickup", a_pickup(po), 3 if po == "prone" else 4, 2, loop=False, sample="step", weapons=("rifle", "none"), progress=True)
        add(f"{po}.throw", a_throw(po), 6, 6.7, loop=False, sample="once")
        add(f"{po}.hit", a_hit(po), 3, 7, loop=False, sample="step")
    add("standing.walk", a_walk(), 8, 8, weapons=ALLN, strideM=STRIDE["walk"] * FIG)
    add("standing.run", a_run(), 8, 13, weapons=ALLN, strideM=STRIDE["run"] * FIG)
    add("crouched.sneak", a_sneak(), 8, 7, weapons=ALLN, strideM=STRIDE["sneak"] * FIG)
    add("prone.crawl", a_crawl(), 8, 5, weapons=ALLN, strideM=STRIDE["crawl"] * FIG)
    add("prone.woundedCrawl", a_wounded_crawl, 6, 3, strideM=STRIDE["woundedCrawl"] * FIG)
    # moods
    for po in POSTURES:
        add(f"{po}.idle.alert", a_alert(po), 4, 2.5)
        add(f"{po}.idle.shaken", a_shaken_idle(po), 4, 4)
        add(f"{po}.idle.pinned", a_pinned(po), 2, 3)
        add(f"{po}.idle.cowering", a_cower(po), 2, 6)
        add(f"{po}.idle.panicked", a_panic_idle(po), 4, 7)
    add("standing.walk.shaken", a_walk("shaken"), 8, 7, strideM=4 * 0.19 * FIG)
    add("crouched.sneak.shaken", a_sneak("shaken"), 8, 6, strideM=STRIDE["sneak"] * FIG)
    add("standing.run.panicked", a_run("panicked"), 8, 14, strideM=4 * 0.40 * FIG)
    add("prone.crawl.panicked", a_crawl("panicked"), 6, 8, strideM=0.5)
    add("standing.idle.berserk", a_berserk_idle, 4, 6)
    add("standing.run.berserk", a_run("berserk"), 8, 13, strideM=STRIDE["run"] * FIG)
    add("standing.fire.berserk", a_berserk_fire, 3, 12, loop=False, sample="once")
    add("standing.idle.surrendered", a_surrender("standing"), 2, 1.5)
    add("kneeling.idle.surrendered", a_surrender("kneeling"), 2, 1.5)
    add("standing.walk.surrendered", a_walk("surrendered"), 8, 7, strideM=STRIDE["walk"] * FIG)
    W = STRIDE["walk"] * FIG
    add("crew.haul", a_crew_haul, 8, 7, strideM=4 * 0.20 * FIG)
    add("crew.trail", a_crew_trail, 5, 2, loop=False, sample="step", progress=True)
    add("crew.dig", a_crew_dig, 4, 3, loop=False, sample="step", progress=True)
    add("crew.load.gun", a_crew_load_gun, 5, 2, loop=False, sample="step", progress=True)
    add("crew.lay", a_crew_lay, 3, 2)
    add("crew.fire", a_crew_fire, 3, 6, loop=False, sample="step", progress=True)
    add("crew.baseplate", _set_down("plate", (60, 0, 0), (0, 0, 0)), 4, 2, loop=False, sample="step", progress=True)
    add("crew.tube", a_crew_tube, 4, 2, loop=False, sample="step", progress=True)
    add("crew.bipod", a_crew_bipod, 4, 2, loop=False, sample="step", progress=True)
    add("crew.load.mortar", a_crew_load_mortar, 4, 3, loop=False, sample="step", progress=True)
    add("crew.tripod", _set_down("tripod", (-80, 0, 0), (-25, 0, 0)), 4, 2, loop=False, sample="step", progress=True)
    add("crew.mountmg", a_crew_mountmg, 4, 2, loop=False, sample="step", progress=True)
    add("crew.belt", a_crew_belt, 4, 3, loop=False, sample="step", progress=True)
    add("crew.mg", a_crew_mg(False), 2, 1.5)
    add("crew.mg.fire", a_crew_mg(True), 2, 14)
    add("crew.carry.tube", a_crew_carry("tube"), 8, 8, strideM=W)
    add("crew.carry.plate", a_crew_carry("plate"), 8, 8, strideM=W)
    add("crew.carry.mg", a_crew_carry("mg"), 8, 8, strideM=W)
    add("crew.carry.tripod", a_crew_carry("tripod"), 8, 8, strideM=W)
    for i in range(len(CRUSHED)):
        add(f"corpse.crushed{i}", a_crushed(i), 1, 1, loop=False)
    for i, spec in enumerate(CORPSES):
        add(f"corpse{i}", a_static(spec), 1, 1, loop=False)
    for i in range(len(FLIGHTS)):
        add(f"ragdoll.flight{i}", a_flight(i), 6, 9, loop=False, shadow=False, sample="step", landed=FLIGHTS[i][3])
    for i, spec in enumerate(LANDED):
        add(f"ragdoll.landed{i}", a_static(spec), 1, 1, loop=False)
    # appended later: keep new entries at the END so existing `start` indices never move
    add("crew.bailout", a_bailout(False), 6, 5, loop=False, sample="step", progress=True, hullHeightM=1.5,
        shadow_rows={3: 0.45, 4: 0.75, 5: 1.0})
    add("crew.mount", a_bailout(True), 6, 5, loop=False, sample="step", progress=True, hullHeightM=1.5,
        shadow_rows={0: 1.0, 1: 0.75, 2: 0.45})
    add("kneeling.bandage", a_bandage, 4, 3, weapons=("rifle",))
    add("crew.drag", a_drag, 8, 7, strideM=4 * 0.16 * FIG, dragM=DRAG_M)
    add("prone.dragged", a_dragged, 1, 1, loop=False)
    add("prone.wounded", a_wounded, 1, 1, loop=False)
    add("standing.drop", a_drop, 6, 12, loop=False, weapons=ALLN, sample="once", progress=True)
    return E


# alias key -> rendered key (costs no cells).  They fill the chains the game asks for
# (src/render/soldierAnim.ts buildKeyChain, src/render/unitRender.ts CREW_KEYS).
ALIASES = {
    "kneeling.sneak": "crouched.sneak", "standing.sneak": "crouched.sneak",
    "kneeling.sneak.shaken": "crouched.sneak.shaken", "standing.sneak.shaken": "crouched.sneak.shaken",
    "crouched.sneak.panicked": "standing.run.panicked", "kneeling.sneak.panicked": "standing.run.panicked",
    "standing.walk.panicked": "standing.run.panicked",
    "standing.walk.berserk": "standing.run.berserk",
    "standing.aim.berserk": "standing.fire.berserk",
    "crouched.idle.surrendered": "kneeling.idle.surrendered", "prone.idle.surrendered": "kneeling.idle.surrendered",
    "standing.woundedCrawl": "prone.woundedCrawl", "crouched.woundedCrawl": "prone.woundedCrawl",
    "kneeling.woundedCrawl": "prone.woundedCrawl",
    "crew.carry.baseplate": "crew.carry.plate", "crew.carry": "crew.carry.tripod",
    "crew.gunner": "crew.lay", "crew.loader.mortar": "crew.load.mortar", "crew.loader.gun": "crew.load.gun",
    "crew.loader": "crew.load.gun",
}
for _po in POSTURES:
    ALIASES[f"{_po}.hide.cowering"] = f"{_po}.idle.cowering"
    ALIASES[f"{_po}.hide.pinned"] = f"{_po}.idle.pinned"


NO_WEAPON = {"standing.run.panicked", "standing.idle.surrendered", "kneeling.idle.surrendered", "standing.walk.surrendered",
             "prone.woundedCrawl", "kneeling.bandage", "prone.dragged", "prone.wounded"}


def sample_t(e, i):
    n = e["frames"]
    if e["sample"] == "loop":
        return i / n
    if e["sample"] == "once":
        return i / max(1, n - 1) * 0.999 if n > 1 else 0.0
    return (i + 0.01) / n          # "step": frame i sits at the start of its step


def expand_keys(E):
    """-> list of (atlas key, entry key, weapon).  Unsuffixed key == rifle."""
    out = []
    for k, e in E.items():
        out.append((k, k, "rifle"))
        for w in e["weapons"]:
            if w != "rifle":
                out.append((f"{k}@{w}", k, None if w == "none" else w))
    return out


# ------------------------------------------------------------------------------------------
# rendering
# ------------------------------------------------------------------------------------------
def solve_with_override(pose, weapon):
    if "pelvis_mat" in pose:
        # free pelvis matrix (ragdoll): temporarily express through the normal path
        pm = pose["pelvis_mat"]
        global rot_body
        saved = rot_body
        calls = {"n": 0}

        def rb(*a, **k):
            calls["n"] += 1
            return pm.to_3x3().to_4x4() if calls["n"] == 1 else saved(*a, **k)
        rot_body = rb
        try:
            q = dict(pose)
            q["pelvis_pos"] = tuple(pm.translation)
            return solve(q, weapon)
        finally:
            rot_body = saved
    return solve(pose, weapon)


def add_outline(img, alpha):
    """1px dark rim around the figure (not the shadow) so it reads on busy painted ground."""
    if alpha <= 0:
        return img
    a = img[..., 3].astype(np.float32) / 255.0
    fig = (a > 0.45) & (img[..., :3].max(axis=2) > 46)
    nb = np.zeros_like(fig)
    nb[1:, :] |= fig[:-1, :]; nb[:-1, :] |= fig[1:, :]; nb[:, 1:] |= fig[:, :-1]; nb[:, :-1] |= fig[:, 1:]
    rim = nb & ~fig
    out = img.astype(np.float32)
    oc = np.array([22, 24, 18], dtype=np.float32)
    ra = alpha
    na = ra + a * (1 - ra)
    for k in range(3):
        mixed = (oc[k] * ra + out[..., k] * a * (1 - ra)) / np.maximum(na, 1e-5)
        out[..., k] = np.where(rim, mixed, out[..., k])
    out[..., 3] = np.where(rim, na * 255.0, out[..., 3])
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


PART_CELL, PART_ANCHOR, PART_COLUMNS = 18, (9, 9), 48


GRADE = {1: (1.12, -2.0), 2: (1.06, -2.0)}      # pack-time (contrast, lift) on figure pixels, per scale


EDGE_DARKEN = 0.84
# pack-time value gain per palette (summer uniforms were tuned darker at render time; this lifts them
# back to a mid value that still sits below the terrain, without re-rendering)
PALETTE_GAIN = {("german", "summer"): 1.2, ("soviet", "summer"): 1.36}


def grade(img, scale, gain=1.0):
    """Pack-time punch-up so the small sprites separate from the painted ground (not cached)."""
    c, lift = GRADE.get(scale, (1.0, 0.0))
    rgb = img[..., :3].astype(np.float32)
    fig = (rgb.max(axis=2) > 46) & (img[..., 3] > 0)
    out = np.clip(((rgb * gain) - 110.0) * c + 110.0 + lift, 0, 255)
    # a slightly darker last row of figure pixels (inside the outer rim) keeps a crisp silhouette
    # edge after the downsample, without a cartoon outline
    solid = fig & (img[..., 3] > 160)
    open_ = ~solid
    nb = np.zeros_like(solid)
    nb[1:, :] |= open_[:-1, :]; nb[:-1, :] |= open_[1:, :]; nb[:, 1:] |= open_[:, :-1]; nb[:, :-1] |= open_[:, 1:]
    out[solid & nb] *= EDGE_DARKEN
    res = img.copy()
    res[..., :3][fig] = (out[fig].astype(np.uint8) >> 2 << 2) | 2          # 6-bit colour: far smaller PNGs
    # shadows: render noise makes PNGs huge, so smooth the alpha (3x3) and quantise it; one flat tint
    sh = ~fig & (img[..., 3] > 0)
    al = img[..., 3].astype(np.float32)
    # the catcher leaves a faint haze (alpha 2-6) over the whole cell: remove that floor
    al = np.where(sh, np.clip((al - 12.0) * (255.0 / 243.0), 0, 255), al)
    pad = np.pad(al, 1, mode="edge")
    blur = sum(pad[dy:dy + al.shape[0], dx:dx + al.shape[1]] for dy in range(3) for dx in range(3)) / 9.0
    outline = sh & (al > 1.25 * blur + 20)                                  # keep the crisp dark rim
    qa = (np.round(blur / 12.0) * 12).clip(0, 255)
    res[..., 3] = np.where(sh & ~outline, qa, al).astype(np.uint8)
    res[..., :3][sh] = C.SHADOW_RGB
    res[res[..., 3] == 0] = 0
    return res


def soldier_light(ctx):
    """The shared scene lights the men a little softer than vehicles: less blue sky fill on the top
    surfaces (which read as pale, washed-out shoulders and helmets) and a slightly weaker sun, so
    figures stay darker than the terrain like the original's."""
    ctx.sun.data.energy = C.SUN_STRENGTH * 0.9
    bg = ctx.scene.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.86, 0.88, 0.9, 1.0)
    bg.inputs[1].default_value = C.SKY_STRENGTH * 0.55


def soldier_look(ctx, side, season):
    """Lights and materials of every soldier-figure render (soldiers.py and smg.py share it):
    soldier_light() plus the palette as matt cloth and paint."""
    soldier_light(ctx)
    for role, (col, rough) in PALETTES[(side, season)].items():
        m = C.make_material("sol_" + role, col, roughness=rough, metallic=0.6 if role == "metal" else 0.0)
        spec = m.node_tree.nodes["Principled BSDF"].inputs.get("Specular IOR Level")
        if spec is not None and role not in ("metal", "brass"):
            spec.default_value = 0.12          # cloth and paint: no sheen washing out the tops


def atlas_name(side, season, scale, kind="soldiers"):
    return f"{kind}_{side}_{season}_{scale}"


def render_atlas(side, season, scale, only, force, pack_only, samples, kind="soldiers"):
    name = atlas_name(side, season, scale, kind)
    cdir = os.path.join(CACHE_DIR, name)
    os.makedirs(cdir, exist_ok=True)
    parts = kind == "parts"
    E = build_part_entries() if parts else build_entries()
    keys = expand_keys(E)
    cell = (PART_CELL if parts else CELL) * scale
    anchor = tuple(v * scale for v in (PART_ANCHOR if parts else ANCHOR))

    def wanted(k):
        return any(fnmatch.fnmatch(k, pat) or k.startswith(pat) for pat in only) if only else True

    todo = []
    for ak, ek, w in keys:
        path = os.path.join(cdir, ak.replace("@", "__") + ".png")
        if pack_only:
            continue
        if not wanted(ak):
            continue
        if os.path.exists(path) and not (force or only):
            continue
        todo.append((ak, ek, w, path))

    t0 = time.time()
    if todo:
        ctx = C.setup_scene(10 * scale, cell, cell, anchor=anchor, grid=(DIRS, MAX_FRAMES), samples=samples)
        soldier_look(ctx, side, season)
        meshes = build_meshes(side)
        coll = bpy.data.collections.new("rigs")
        ctx.scene.collection.children.link(coll)
        rigs = [[Rig(meshes, coll, ctx.cell_origin(d, r, exact=True), d) for d in range(DIRS)] for r in range(MAX_FRAMES)]
        for n, (ak, ek, w, path) in enumerate(todo):
            e = E[ek]
            t1 = time.time()
            for r in range(MAX_FRAMES):
                if r < e["frames"]:
                    pose = e["fn"](sample_t(e, r), w)
                    mats = solve_with_override(pose, w)
                    for d in range(DIRS):
                        rigs[r][d].apply(mats, w)
                else:
                    for d in range(DIRS):
                        rigs[r][d].hide()
            r_ = ctx.scene.render
            r_.use_border, r_.use_crop_to_border = True, False
            r_.border_min_x, r_.border_max_x, r_.border_max_y = 0.0, 1.0, 1.0
            r_.border_min_y = 1.0 - e["frames"] / MAX_FRAMES
            srows = e.get("shadow_rows")
            C.set_shadow(ctx, e["shadow"] and not srows)
            cells = C.render_grid(ctx)
            if srows:       # per-frame shadow strength: second pass with the catcher, mixed in per row
                C.set_shadow(ctx, True)
                with_sh = C.render_grid(ctx)
                for r, k_ in srows.items():
                    for d in range(DIRS):
                        c2 = with_sh[r][d].copy()
                        shm = (c2[..., :3].max(axis=2) <= 46) & (c2[..., 3] > 0)
                        c2[..., 3][shm] = (c2[..., 3][shm] * k_).astype(np.uint8)
                        cells[r][d] = c2
            strip = np.zeros((e["frames"] * cell, DIRS * cell, 4), dtype=np.uint8)
            spill, where = 0, []
            for r in range(e["frames"]):
                for d in range(DIRS):
                    c = add_outline(cells[r][d], OUTLINE_ALPHA)
                    fig = (c[..., 3] > 200) & (c[..., :3].max(axis=2) > 46)
                    sp = int(fig[0, :].sum() + fig[-1, :].sum() + fig[:, 0].sum() + fig[:, -1].sum())
                    if sp:
                        where.append(f"f{r}d{d}")
                    spill += sp
                    strip[r * cell:(r + 1) * cell, d * cell:(d + 1) * cell] = c
            C.save_png(path, strip)
            print(f"[{name}] {n + 1}/{len(todo)} {ak} {time.time() - t1:.2f}s" + (f"  WARNING figure touches cell edge ({spill}px) {' '.join(where[:8])}" if spill else ""), flush=True)
    render_s = time.time() - t0

    # pack everything cached
    packer = C.AtlasPacker(scale, cell, cell, anchor, DIRS, columns=PART_COLUMNS if parts else COLUMNS)
    missing = []
    aliases = {}
    for ak, ek, w in keys:
        path = os.path.join(cdir, ak.replace("@", "__") + ".png")
        if not os.path.exists(path):
            missing.append(ak)
            continue
        e = E[ek]
        strip = grade(C.load_png(path), scale, 1.0 if parts and E[ek]["extra"].get("debris") else PALETTE_GAIN.get((side, season), 1.0))
        fbd = [[strip[r * cell:(r + 1) * cell, d * cell:(d + 1) * cell] for r in range(e["frames"])] for d in range(DIRS)]
        packer.add(ak, fbd, fps=e["fps"], loop=e["loop"], **e["extra"])
        if "@" not in ak and len(e["weapons"]) > 1:
            aliases[ak + "@rifle"] = ak
    if packer.entries:
        base = os.path.join(OUT_DIR, name)
        meta = packer.save(base, extra=dict(side=side, season=season, pxPerM=10 * scale, figureScale=FIG,
                                            tiltDeg=C.TILT_DEG, weapons=["rifle", "smg", "lmg"]))
        if parts:
            ALIASES_ = {f"part.{k_}": f"part.{k_}0" for k_ in list(PART_SETS) + ["plate", "wheel", "hatch"]}
        else:
            ALIASES_ = ALIASES
        for k in list(meta["entries"]):       # entries that never show a weapon also answer to @none
            if "@" not in k and (k in NO_WEAPON or k.startswith("crew.")):
                aliases[k + "@none"] = k
        for al, k in ALIASES_.items():
            for suf in ("", "@smg", "@lmg", "@none"):
                if k + suf in meta["entries"] and (suf == "" or al + suf not in meta["entries"]):
                    aliases[al + suf] = k + suf
            if len(E[k]["weapons"]) > 1:
                aliases[al + "@rifle"] = k
        for al, k in aliases.items():        # aliases share the target entry's cells
            if al not in meta["entries"] and k in meta["entries"]:
                meta["entries"][al] = dict(meta["entries"][k], alias=k)
        if C.to_webp(base):
            meta["image"] = os.path.basename(base) + ".webp"
        with open(base + ".json", "w") as fh:
            json.dump(meta, fh, indent=1)
    print(f"[{name}] rendered {len(todo)} entries in {render_s:.1f}s; packed {len(packer.entries)} entries"
          + (f"; MISSING {len(missing)}: {missing[:6]}..." if missing else ""), flush=True)
    with open(os.path.join(cdir, "_timing.json"), "w") as fh:
        json.dump(dict(atlas=name, rendered=len(todo), seconds=round(render_s, 1)), fh)
    return render_s


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    import argparse
    ap = argparse.ArgumentParser(prog="soldiers.py")
    ap.add_argument("--side", default="all", choices=["german", "soviet", "all"])
    ap.add_argument("--season", default="all", choices=["summer", "winter", "all"])
    ap.add_argument("--scale", default="all", choices=["1", "2", "all"])
    ap.add_argument("--only", default="", help="comma separated key patterns (fnmatch or prefix); re-renders them")
    ap.add_argument("--force", action="store_true", help="re-render even when cached")
    ap.add_argument("--pack-only", action="store_true", help="only re-pack the atlases from the cache")
    ap.add_argument("--jobs", type=int, default=1, help="run atlases in N parallel Blender processes")
    ap.add_argument("--samples", type=int, default=8)
    ap.add_argument("--list", action="store_true", help="print the entry keys and exit")
    ap.add_argument("--kind", default="all", choices=["soldiers", "parts", "all"], help="which atlas family to build")
    return ap.parse_args(argv)


def main():
    a = parse_args()
    if a.list:
        E = build_entries()
        for ak, ek, w in expand_keys(E):
            print(ak, E[ek]["frames"])
        return
    sides = ["german", "soviet"] if a.side == "all" else [a.side]
    seasons = ["summer", "winter"] if a.season == "all" else [a.season]
    scales = [1, 2] if a.scale == "all" else [int(a.scale)]
    kinds = ["soldiers", "parts"] if a.kind == "all" else [a.kind]
    combos = [(s, se, sc, kd) for kd in kinds for s in sides for se in seasons for sc in scales]
    only = [p for p in a.only.split(",") if p]
    t0 = time.time()
    if a.jobs > 1 and len(combos) > 1:
        procs, pending = [], list(combos)
        while pending or procs:
            while pending and len(procs) < a.jobs:
                s, se, sc, kd = pending.pop(0)
                cmd = [bpy.app.binary_path, "-b", "-t", str(max(2, (os.cpu_count() or 8) // a.jobs)), "-P", os.path.abspath(__file__), "--",
                       "--side", s, "--season", se, "--scale", str(sc), "--kind", kd, "--samples", str(a.samples)]
                if only: cmd += ["--only", ",".join(only)]
                if a.force: cmd += ["--force"]
                if a.pack_only: cmd += ["--pack-only"]
                procs.append(subprocess.Popen(cmd))
            procs = [p for p in procs if p.poll() is None]
            time.sleep(0.5)
    else:
        for s, se, sc, kd in combos:
            render_atlas(s, se, sc, only, a.force, a.pack_only, a.samples, kd)
    print(f"soldiers: {len(combos)} atlas(es) done in {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
