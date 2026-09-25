"""Procedural crew-served weapon sprites (own geometry from primitives), 32 facings, states
setup / half / packed, packed into public/sprites/weapons_<scale>.png/.json per the atlas contract.

  blender -b -P tools/blender/weapons.py -- [--only pak40,maxim] [--scale 1|2] [--force]
                                            [--dirs 32] [--samples 32]

Weapon ids are the game's (src/data/weapons.ts): mortar81, mortar82, mg34_hmg, mg42_hmg, maxim,
pak38, pak40, m1937_45mm, zis3, ptrd, nebel41.  Frame: muzzle toward +Y (direction 0 = north), origin/anchor
at the weapon pivot (mortar baseplate, tripod head, gun axle, PTRD bipod) as in weaponArt.ts.
Every weapon's 3 x 32 cells are cached in node_modules/.cache/sprites/weapons_<scale>/<id>_*.npz so a partial
run (--only) re-renders just those and re-packs the whole atlas (resumable).
JSON extras: weapons.<id> = {muzzleM:{x,y}, artScale} (muzzle in weapon-frame metres, forward = -y).
Small weapons are drawn a little larger than life (artScale) like the game's code-drawn ones.
"""
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import vehicles_common as VC  # noqa: E402
from vehicles_common import Kit, rect_fp, ellipse_fp  # noqa: E402
from mathutils import Matrix, Euler, Vector  # noqa: E402

MORTAR_STATES = ("baseplate", "tube", "setup", "packed")
HMG_STATES = ("tripod", "setup", "packed")
PTRD_STATES = ("setup", "half", "packed")
# alias -> rendered state (alias entries share the same frames: same `start`, no extra pixels)
AT_ALIASES = {"setup": "emplaced", "half": "trailLeftOpen", "packed": "limbered"}
MORTAR_ALIASES = {"half": "tube"}
HMG_ALIASES = {"half": "tripod"}
GER_GREY = "#50575b"
GER_YEL = "#9e8a52"
SOV_GREEN = "#414e2c"
CELL_M = 4.3     # generous half-size of the render cell in metres (AT guns); cropped afterwards


def ammo_case(k, x, y, size=(0.25, 0.5, 0.2), mat="ammo", rot=0.0, open_=False):
    k.box(size, (x, y, size[2] / 2), mat, rot=(0, 0, rot))
    k.box((size[0] * 0.2, size[1] * 0.3, 0.03), (x, y, size[2] + 0.01), "gunmetal", rot=(0, 0, rot))
    if open_:
        k.box((size[0] * 0.8, size[1] * 0.8, 0.02), (x, y, size[2] + 0.005), "hole", rot=(0, 0, rot))
        for i in (-1, 0, 1):
            k.cyl(0.035, 0.03, (x, y + i * size[1] * 0.25, size[2] + 0.02), "brass", axis="Z", seg=6)


# ---------------------------------------------------------------------- mortar
def mortar(k, st, soviet):
    """States: baseplate (plate only), tube (plate + tube resting forward, no bipod), setup, packed."""
    s = 1.5
    tube_r = 0.085 * s
    case = "wood" if soviet else "ammo"

    def plate(x=0.0, y=0.0, rot=0.0):
        if soviet:
            k.cyl(0.36 * s, 0.06, (x, y, 0.03), "gun", axis="Z", seg=14)
            k.cyl(0.1 * s, 0.03, (x, y, 0.075), "gunmetal", axis="Z", seg=8)
        else:
            k.box((0.6 * s, 0.5 * s, 0.06), (x, y, 0.03), "gun", rot=(0, 0, rot))
            k.cyl(0.09 * s, 0.03, (x, y, 0.075), "gunmetal", axis="Z", seg=8)
    if st == "baseplate":
        plate()
    elif st == "tube":
        plate()
        k.tube((0, 0, 0.08), (0.0, 1.05 * s, 0.3), tube_r, "steel", seg=10)               # tube socketed, resting low
        k.tube((0, 1.05 * s - 0.01, 0.3), (0, 1.05 * s + 0.012, 0.303), tube_r * 0.75, "hole", seg=8)
    elif st == "setup":
        plate()
        top = (0, 0.62 * s, 0.98 * s)
        k.tube((0, 0, 0.06), top, tube_r, "steel", seg=10)
        k.tube((0, top[1] - 0.01, top[2] - 0.015), (0, top[1] + 0.012, top[2] + 0.02), tube_r * 0.75, "hole", seg=8)
        col = (0, 0.42 * s, 0.66 * s)
        for sx in (-1, 1):
            k.tube(col, (sx * 0.36 * s, 0.78 * s, 0.0), 0.04 * s, "gun", seg=6)
            k.cyl(0.09 * s, 0.03, (sx * 0.36 * s, 0.78 * s, 0.015), "gun", axis="Z", seg=8)
        k.tube((-0.12 * s, col[1], col[2]), (0.16 * s, col[1], col[2]), 0.03 * s, "gunmetal", seg=6)
        k.box((0.06, 0.06, 0.1), (-0.1 * s, 0.3 * s, 0.55 * s), "gunmetal")            # sight
        ammo_case(k, 0.95, -0.1, (0.3, 0.62, 0.22), case, 8, open_=True)
        ammo_case(k, 1.3, 0.0, (0.3, 0.62, 0.22), case, -6)
        ammo_case(k, 1.1, 0.62, (0.62, 0.3, 0.22), case, 4)
    else:
        k.tube((-0.2, -0.5 * s, tube_r), (-0.2, 0.55 * s, tube_r), tube_r, "steel", seg=10)
        plate(0.4, 0.3, 12)
        k.tube((0.1, -0.85, 0.04), (0.22, -0.1, 0.04), 0.04 * s, "gun", seg=6)
        k.tube((0.2, -0.85, 0.04), (0.36, -0.12, 0.04), 0.04 * s, "gun", seg=6)
        ammo_case(k, 0.85, -0.55, (0.3, 0.62, 0.22), case, 0)
    stations = {"gunner": (-0.6, 0.1), "loader": (0.6, 0.55), "ammo": (1.1, -0.45), "trailLeft": None, "trailRight": None,
                "baseplate": (0.0, -0.6), "bipod": (0.0, 1.75)}
    return (0.0, 0.66 * s), s, stations


# ------------------------------------------------------------------ MG on tripod
def mg_gun(k, base, yaw, mg42, s, on_ground=False):
    """Air-cooled MG: receiver, jacket, butt; base = pivot point under the receiver."""
    M = Matrix.Translation(Vector(base)) @ Euler((0, math.radians(80 if on_ground else 0), math.radians(yaw)), "XYZ").to_matrix().to_4x4()
    old = k.xform
    k.xform = M if old is None else old @ M
    k.box((0.12 * s, 0.42 * s, 0.11 * s), (0, -0.05 * s, 0.0), "gunmetal")
    k.cyl(0.055 * s, 0.62 * s, (0, 0.45 * s, 0.0), "steel", axis="Y", seg=8)
    if mg42:
        k.box((0.115 * s, 0.5 * s, 0.1 * s), (0, 0.42 * s, 0.0), "steel")           # square slotted jacket
    k.cyl(0.035 * s, 0.12 * s, (0, 0.8 * s, 0.0), "gunmetal", axis="Y", seg=6)
    k.box((0.09 * s, 0.3 * s, 0.1 * s), (0, -0.4 * s, -0.01), "wood", top=(1, 0.7))
    k.box((0.16 * s, 0.1 * s, 0.03), (0.09 * s, 0.0, 0.0), "brass")                  # belt
    k.xform = old


def lafette(k, st, mg42):
    s = 1.5
    head = (0, 0, 0.42 * s)
    if st in ("setup", "tripod"):
        spread = 1.0
        k.tube(head, (0, 0.72 * s * spread + 0.1, 0.0), 0.045 * s, "gun", seg=6)
        for sx in (-1, 1):
            k.tube(head, (sx * 0.5 * s * spread, -0.62 * s * spread - 0.05, 0.0), 0.045 * s, "gun", seg=6)
        k.box((0.2 * s, 0.5 * s, 0.07 * s), (0, -0.02, head[2]), "gun")                 # cradle
        k.tube((-0.22 * s, -0.3 * s, 0.1), (0.22 * s, -0.3 * s, 0.1), 0.02 * s, "gun", seg=6)
        if st == "setup":
            mg_gun(k, (0, 0.05, head[2] + 0.08 * s), 0, mg42, s)
            k.box((0.06, 0.05, 0.12), (0.0, -0.25 * s, head[2] + 0.18 * s), "gunmetal")   # optical sight
            ammo_case(k, -0.5 * s, 0.1, (0.2, 0.42, 0.2), "ammo", 10, open_=False)
            k.tube((-0.4 * s, 0.1, 0.2), (-0.09 * s, 0.05, head[2] + 0.08 * s), 0.035, "brass", seg=6)
            ammo_case(k, -0.75 * s, -0.35, (0.2, 0.42, 0.2), "ammo", -12)
    else:
        # folded tripod bundle + gun + boxes on the ground
        for i, dx in enumerate((-0.08, 0.0, 0.08)):
            k.tube((dx * s - 0.25, -0.5 * s, 0.05), (dx * s * 0.4 - 0.25, 0.5 * s, 0.05), 0.045 * s, "gun", seg=6)
        k.box((0.18 * s, 0.4 * s, 0.1), (-0.25, 0.0, 0.1), "gun")
        mg_gun(k, (0.3 * s, -0.05, 0.06), -6, mg42, s, on_ground=True)
        ammo_case(k, 0.75 * s, -0.2, (0.2, 0.42, 0.2), "ammo", 4)
    stations = {"gunner": (0.0, -1.15), "loader": (-0.95, -0.1), "ammo": (-0.75 * s, -0.35), "trailLeft": None,
                "trailRight": None, "tripod": (0.0, -0.7)}
    return (0.0, 0.95 * s), s, stations


# ------------------------------------------------------------------------ Maxim
def maxim(k, st):
    s = 1.35
    ax = 0.3 * s
    for sx in (-1, 1):
        k.cyl(0.22 * s, 0.09 * s, (sx * ax, 0, 0.22 * s), "gun", axis="X", seg=14)
        k.cyl(0.17 * s, 0.1 * s, (sx * ax, 0, 0.22 * s), "gunmetal", axis="X", seg=10)
    k.tube((-ax, 0, 0.22 * s), (ax, 0, 0.22 * s), 0.025 * s, "gun", seg=6)
    # U-shaped trail to the rear
    tl = 0.95 * s
    zt = 0.04 if st != "packed" else 0.3 * s
    for sx in (-1, 1):
        k.tube((sx * 0.14 * s, -0.05, 0.25 * s), (sx * 0.1 * s, -tl, zt), 0.04 * s, "gun", seg=6)
    k.tube((-0.1 * s, -tl, zt), (0.1 * s, -tl, zt), 0.025 * s, "gun", seg=6)
    gz = 0.4 * s
    k.box((0.2 * s, 0.4 * s, 0.1 * s), (0, 0.0, gz - 0.08 * s), "gun")                     # turntable
    if st != "tripod":
        k.box((0.15 * s, 0.5 * s, 0.13 * s), (0, -0.25 * s, gz + 0.03), "gunmetal")            # receiver
        k.cyl(0.085 * s, 0.68 * s, (0, 0.38 * s, gz + 0.03), "gun", axis="Y", seg=10)           # water jacket
        k.cyl(0.025 * s, 0.12 * s, (0, 0.78 * s, gz + 0.03), "gunmetal", axis="Y", seg=6)
        k.cyl(0.025, 0.04, (0, 0.55 * s, gz + 0.1 * s), "brass", axis="Z", seg=6)             # filler cap
        k.box((0.16 * s, 0.04, 0.05), (0, -0.52 * s, gz + 0.03), "wood")                      # spade grips
        k.box((0.66 * s, 0.04, 0.5 * s), (0, 0.06 * s, gz + 0.12 * s), "gun", rot=(-28, 0, 0))  # shield
        k.box((0.12 * s, 0.05, 0.2 * s), (0, 0.08 * s, gz + 0.04 * s), "hole", rot=(-28, 0, 0))
    if st == "setup":
        ammo_case(k, 0.5 * s, 0.05, (0.22, 0.4, 0.2), "ammo", -8, open_=True)
        ammo_case(k, 0.85 * s, -0.4, (0.22, 0.4, 0.2), "ammo", 10)
        k.tube((0.42 * s, 0.0, 0.2), (0.06 * s, -0.1 * s, gz + 0.03), 0.03, "canvas", seg=6)
    stations = {"gunner": (0.0, -1.35), "loader": (0.95, -0.1), "ammo": (0.85 * s, -0.4), "trailLeft": None,
                "trailRight": None, "tripod": (0.0, -1.0 * s - 0.4)}
    return (0.0, 0.96 * s), s, stations


# ---------------------------------------------------------------------- AT guns
AT = {
    #            trail  spread wheelX wheelR wheelW barrel  r     brake         shield(w,h)  kind     spoked
    "pak38": dict(trail=2.3, spread=24, wx=0.78, wr=0.42, ww=0.2, barrel=2.45, r=0.05, brake=(0.26, 0.085), shield=(1.5, 0.95), kind="ger"),
    "pak40": dict(trail=2.7, spread=25, wx=0.93, wr=0.45, ww=0.24, barrel=2.95, r=0.062, brake=(0.36, 0.11), shield=(1.8, 1.0), kind="ger"),
    "m1937_45mm": dict(trail=2.2, spread=23, wx=0.76, wr=0.43, ww=0.14, barrel=2.0, r=0.04, brake=None, shield=(1.35, 0.85), kind="sov45"),
    "zis3": dict(trail=2.8, spread=26, wx=0.98, wr=0.46, ww=0.24, barrel=2.85, r=0.06, brake=(0.34, 0.115), shield=(1.7, 1.05), kind="zis3"),
    # 15 cm Nebelwerfer 41: six tubes on the lightened 3.7 cm PaK 35/36 carriage
    "nebel41": dict(trail=1.9, spread=22, wx=0.7, wr=0.36, ww=0.12, barrel=1.3, r=0.08, brake=None, shield=None, kind="nebel"),
}


def nebel_tubes(k, st, p):
    """The six-tube cluster (a revolver of 15 cm tubes held by front and rear hexagonal frames).  It
    travels level and is cranked up once the trails are spread and dug in."""
    wr = p["wr"]
    elev = {"emplaced": 35.0, "recoil": 35.0, "trailsOpen": 12.0}.get(st, 0.0)
    E = Euler((math.radians(elev), 0, 0), "XYZ").to_matrix().to_4x4()
    piv = Vector((0, -0.2, wr + 0.42))
    k.xform = Matrix.Translation(piv) @ E
    tl, rr = p["barrel"], 0.19
    y0 = -0.35
    for i in range(6):
        a = math.radians(30 + 60 * i)
        x, z = rr * math.cos(a), rr * math.sin(a)
        k.tube((x, y0, z), (x, y0 + tl, z), p["r"] * 1.1, "gun", seg=10)
        k.cyl(p["r"] * 0.8, 0.02, (x, y0 + tl + 0.005, z), "hole", axis="Y", seg=8)
    for yy in (y0 + 0.12, y0 + tl - 0.12):
        k.cyl(rr + 0.12, 0.06, (0, yy, 0), "gun", axis="Y", seg=6)                    # hexagonal frames
    k.tube((0, y0 - 0.1, 0), (0, y0 + tl, 0), 0.05, "gunmetal", seg=8)                    # central spindle
    k.xform = None
    k.box((0.3, 0.45, 0.35), (0, -0.15, wr + 0.12), "gun")                                    # cradle / elevating gear
    k.cyl(0.08, 0.03, (-0.3, -0.35, wr + 0.3), "gunmetal", axis="X", seg=8)                  # elevation handwheel
    if st in ("emplaced", "recoil"):
        k.tube((0, 0.35, wr + 0.2), (0, 0.75, 0.02), 0.035, "gun", seg=6)                     # front support leg
        k.box((0.2, 0.2, 0.03), (0, 0.78, 0.015), "gun")
        for i in range(3):                                                                    # rockets in their crates
            k.box((0.34, 1.05, 0.3), (1.25 + i * 0.1, -0.9 - i * 0.42, 0.15), "wood", rot=(0, 0, 8 + i * 4))
    if st == "recoil":                                                                        # launch scorch behind
        k.extrude(ellipse_fp(0.9, 1.6, 12, cy=-1.6), 0.0, 0.01, "earth", scale=(0.7, 0.7))
    ca, se = math.cos(math.radians(elev)), math.sin(math.radians(elev))
    my = -0.2 + (y0 + tl) * ca
    return (0.0, round(my, 2))


AT_STATES = ("limbered", "trailsClosed", "trailLeftOpen", "trailRightOpen", "trailsOpen", "emplaced", "recoil")


def at_gun(k, st, wid):
    """Split-trail gun.  Left/right are the gun's own (left = -X when the muzzle points +Y)."""
    p = AT[wid]
    wr = p["wr"]
    closed = 2.5
    ang_l = p["spread"] if st in ("trailLeftOpen", "trailsOpen", "emplaced", "recoil") else closed
    ang_r = p["spread"] if st in ("trailRightOpen", "trailsOpen", "emplaced", "recoil") else closed
    dug = st in ("emplaced", "recoil")
    tip_z = 0.55 if st == "limbered" else (0.04 if dug else 0.1)
    for sx in (-1, 1):
        x = sx * p["wx"]
        k.cyl(wr, p["ww"] * 1.3, (x, 0, wr), "rubber", axis="X", seg=16)
        k.cyl(wr * 0.62, p["ww"] * 1.3 + 0.03, (x, 0, wr), "gun", axis="X", seg=12)
        k.cyl(wr * 0.2, p["ww"] * 1.3 + 0.08, (x, 0, wr), "gunmetal", axis="X", seg=8)
    k.tube((-p["wx"], 0, wr), (p["wx"], 0, wr), 0.06, "gun", seg=8)
    ends = {}
    for sx, ang in ((-1, ang_l), (1, ang_r)):
        a = math.radians(ang)
        x0, y0 = sx * 0.16, -0.1
        x1, y1 = x0 + sx * math.sin(a) * p["trail"], y0 - math.cos(a) * p["trail"]
        ends[sx] = (x1, y1)
        k.tube((x0, y0, wr * 0.95), (x1, y1, tip_z), 0.1, "gun", seg=8, r2=0.075)
        if dug:     # spade seated: only its top shows, in a little scrape of turned earth
            k.extrude(ellipse_fp(0.55, 0.42, 10, cy=y1 - 0.12, cx=x1), 0.0, 0.035, "earth", scale=(0.7, 0.7))
            k.box((0.22, 0.12, 0.1), (x1, y1 - 0.05, 0.06), "gun", rot=(0, 0, -sx * ang))
        else:
            k.box((0.22, 0.3, 0.2), (x1, y1 - 0.05, tip_z), "gun", rot=(0, 0, -sx * ang))
    if st in ("limbered", "trailsClosed"):
        k.cyl(0.07, 0.12, (0, -p["trail"] - 0.2, tip_z + 0.02), "gunmetal", axis="Z", seg=8)       # towing eye
        k.box((0.3, 0.1, 0.06), (0, -p["trail"] + 0.35, tip_z + 0.06), "gunmetal")                # trail lock
    if p["kind"] == "nebel":
        muzzle = nebel_tubes(k, st, p)
        a = math.radians(p["spread"])
        tl = p["trail"] + 0.45
        stations = {"gunner": (-0.6, -0.5), "loader": (0.6, -0.8),
                    "trailLeft": (round(-0.16 - math.sin(a) * tl, 2), round(-0.1 - math.cos(a) * tl, 2)),
                    "trailRight": (round(0.16 + math.sin(a) * tl, 2), round(-0.1 - math.cos(a) * tl, 2)),
                    "ammo": (1.35, -1.3), "tail": (0.0, round(-p["trail"] - 0.75, 2)),
                    "trailLeftClosed": (-0.5, round(-p["trail"] - 0.15, 2)), "trailRightClosed": (0.5, round(-p["trail"] - 0.15, 2))}
        return muzzle, 1.0, stations
    # cradle, breech, barrel
    gz = wr + 0.42
    rc = 0.4 if st == "recoil" else 0.0
    k.box((0.34, 0.5, 0.3), (0, 0.0, wr + 0.2), "gun")                                     # saddle
    k.box((0.2, 1.25, 0.14), (0, 0.55, gz - 0.12), "gun")                                  # recoil cradle
    k.box((0.24, 0.42, 0.24), (0, -0.4 - rc, gz), "gunmetal")                              # breech block
    if st == "recoil":
        k.box((0.13, 0.05, 0.13), (0, -0.62 - rc, gz), "hole")                             # open breech
        k.cyl(p["r"] * 1.3, 0.4, (0.12, -1.35, p["r"] * 1.3), "brass", axis="Y", seg=8, rot=(-90, 0, 25))   # ejected case
    r = p["r"] * 1.8
    k.tube((0, -0.2 - rc, gz), (0, p["barrel"] - rc, gz + 0.02), r, "gun", seg=10, r2=r * 0.85)
    k.tube((0, -0.2 - rc, gz), (0, 0.8 - rc, gz), r * 1.5, "gun", seg=10)
    if p["brake"]:
        b0 = p["barrel"] - rc
        k.tube((0, b0, gz + 0.02), (0, b0 + p["brake"][0], gz + 0.02), p["brake"][1] * 1.25, "gun", seg=10)
        k.tube((0, b0 + p["brake"][0] * 0.35, gz + 0.02), (0, b0 + p["brake"][0] * 0.6, gz + 0.02), p["brake"][1] * 1.4, "gunmetal", seg=10)
    # shield, leaning back so it reads from above
    sw, sh = p["shield"]
    z0 = wr * 0.55
    if p["kind"] == "ger":
        k.box((sw * 0.5, 0.05, sh), (0, 0.28, z0 + sh / 2), "gun", rot=(-32, 0, 0))
        for sx in (-1, 1):
            k.box((sw * 0.3, 0.05, sh), (sx * sw * 0.385, 0.2, z0 + sh / 2), "gun", rot=(-32, 0, -sx * 28))
    elif p["kind"] == "sov45":
        k.box((sw, 0.035, sh * 0.8), (0, 0.25, z0 + sh * 0.4), "gun", rot=(-25, 0, 0))
        k.box((sw * 0.9, 0.035, sh * 0.3), (0, 0.2, z0 + sh * 0.88), "gun", rot=(-60, 0, 0))
    else:
        k.box((sw, 0.04, sh), (0, 0.25, z0 + sh / 2), "gun", rot=(-26, 0, 0))
        k.box((sw * 0.45, 0.04, 0.22), (0, 0.0, z0 + sh + 0.05), "gun", rot=(-26, 0, 0))
    k.box((0.22, 0.08, 0.3), (0, 0.27, gz), "hole", rot=(-12, 0, 0))
    k.box((0.08, 0.1, 0.16), (-0.3, -0.15, gz + 0.12), "gunmetal")                         # sight (gunner's side = left)
    k.cyl(0.09, 0.03, (-0.42, -0.2, gz - 0.1), "gunmetal", axis="X", seg=8)                # traverse handwheel
    ammo_at = (1.45, -1.15)
    if dug:
        casem = "wood" if p["kind"] != "ger" else "ammo"
        ammo_case(k, ammo_at[0], ammo_at[1], (0.34, 0.85, 0.26), casem, rot=75, open_=True)
        ammo_case(k, ammo_at[0] + 0.1, ammo_at[1] - 0.5, (0.34, 0.85, 0.26), casem, rot=83)
        for i in range(2):
            k.cyl(p["r"] * 1.3, 0.55, (0.85 + i * 0.13, -1.3, p["r"] * 1.3), "brass", axis="Y", seg=8)
    a = math.radians(p["spread"])
    tl = p["trail"] + 0.45
    stations = {"gunner": (-0.55, -0.6), "loader": (0.55, -0.95),
                "trailLeft": (round(-0.16 - math.sin(a) * tl, 2), round(-0.1 - math.cos(a) * tl, 2)),
                "trailRight": (round(0.16 + math.sin(a) * tl, 2), round(-0.1 - math.cos(a) * tl, 2)),
                "ammo": ammo_at, "tail": (0.0, round(-p["trail"] - 0.75, 2)),
                "trailLeftClosed": (-0.55, round(-p["trail"] - 0.15, 2)), "trailRightClosed": (0.55, round(-p["trail"] - 0.15, 2))}
    return (0.0, p["barrel"] + (p["brake"][0] if p["brake"] else 0)), 1.0, stations


# ------------------------------------------------------------------------- PTRD
def ptrd(k, st):
    s = 1.2
    if st == "setup":
        z = 0.3 * s
        k.tube((0, -0.45 * s, z - 0.06), (0, 1.52 * s, z + 0.02), 0.04 * s, "steel", seg=8)
        k.box((0.1 * s, 0.4 * s, 0.1 * s), (0, -0.2 * s, z - 0.05), "gunmetal")
        k.box((0.09 * s, 0.3 * s, 0.11 * s), (0, -0.62 * s, z - 0.08), "wood")
        k.box((0.08 * s, 0.07 * s, 0.1 * s), (0, -0.8 * s, z - 0.08), "leather")
        k.box((0.12 * s, 0.12 * s, 0.07 * s), (0, 1.5 * s, z + 0.02), "gunmetal")               # muzzle brake
        for sx in (-1, 1):
            k.tube((0, 0.0, z - 0.02), (sx * 0.22 * s, 0.06, 0.0), 0.028 * s, "gunmetal", seg=6)
        k.box((0.2, 0.26, 0.1), (0.4, -0.3, 0.05), "canvas", rot=(0, 0, 15))                  # cartridge bag
    else:
        yaw = 0 if st == "half" else 20
        M = Euler((0, 0, math.radians(yaw)), "XYZ").to_matrix().to_4x4()
        k.xform = M
        z = 0.05
        k.tube((0, -0.45 * s, z), (0, 1.52 * s, z), 0.04 * s, "steel", seg=8)
        k.box((0.08 * s, 0.4 * s, 0.06 * s), (0, -0.2 * s, z), "gunmetal")
        k.box((0.11 * s, 0.3 * s, 0.05 * s), (0.02, -0.62 * s, z), "wood")
        k.box((0.1 * s, 0.07 * s, 0.08 * s), (0.02, -0.8 * s, z), "leather")
        k.box((0.06 * s, 0.1 * s, 0.05 * s), (0, 1.5 * s, z), "gunmetal")
        if st == "half":
            for sx in (-1, 1):
                k.tube((0, 0.0, z), (sx * 0.1 * s, 0.3 * s, 0.02), 0.028 * s, "gunmetal", seg=6)
            k.box((0.2, 0.26, 0.1), (0.4, -0.3, 0.05), "canvas", rot=(0, 0, 15))
        else:
            k.tube((0.03, 0.0, z), (0.03, 0.32 * s, z), 0.02 * s, "gunmetal", seg=6)
        k.xform = None
    stations = {"gunner": (0.0, -1.3), "loader": (0.6, -0.9), "ammo": (0.4, -0.3), "trailLeft": None, "trailRight": None}
    return (0.0, 1.55 * s), s, stations


AT_ST = ("limbered", "trailsClosed", "trailLeftOpen", "trailRightOpen", "trailsOpen", "emplaced", "recoil")
WEAPONS = {
    # id: (builder, paint, ammo-tin colour, states, aliases)
    "mortar81": (lambda k, st: mortar(k, st, False), GER_GREY, "#4a4f40", MORTAR_STATES, MORTAR_ALIASES),
    "mortar82": (lambda k, st: mortar(k, st, True), SOV_GREEN, "#4f5738", MORTAR_STATES, MORTAR_ALIASES),
    "mg34_hmg": (lambda k, st: lafette(k, st, False), GER_GREY, "#4a4f40", HMG_STATES, HMG_ALIASES),
    "mg42_hmg": (lambda k, st: lafette(k, st, True), GER_GREY, "#4a4f40", HMG_STATES, HMG_ALIASES),
    "maxim": (maxim, SOV_GREEN, "#4f5738", HMG_STATES, HMG_ALIASES),
    "pak38": (lambda k, st: at_gun(k, st, "pak38"), GER_GREY, "#4a4f40", AT_ST, AT_ALIASES),
    "pak40": (lambda k, st: at_gun(k, st, "pak40"), GER_YEL, "#4a4f40", AT_ST, AT_ALIASES),
    "m1937_45mm": (lambda k, st: at_gun(k, st, "m1937_45mm"), SOV_GREEN, "#4f5738", AT_ST, AT_ALIASES),
    "zis3": (lambda k, st: at_gun(k, st, "zis3"), SOV_GREEN, "#4f5738", AT_ST, AT_ALIASES),
    "nebel41": (lambda k, st: at_gun(k, st, "nebel41"), GER_YEL, "#4a4f40", AT_ST, AT_ALIASES),
    "ptrd": (ptrd, SOV_GREEN, "#4f5738", PTRD_STATES, {}),
}


def build(wid, st):
    fn, paint, ammo = WEAPONS[wid][:3]
    mats = VC.common_materials({})
    mats["gun"] = VC.paint_material("gun", paint, dust_top=0.35, dust_amt=0.35, mottle=0.15)
    mats["ammo"] = VC.flat_material("ammo", ammo, 0.8)
    mats["earth"] = VC.flat_material("earth", "#4a3a26", 1.0)
    k = Kit("%s_%s" % (wid, st))
    fn(k, st)
    return [(k.build(mats), True)]


def cache_dir(scale):
    # under node_modules/.cache: git-ignored, and out of reach of the soldier script's own cache cleaning
    d = os.path.join(VC.ROOT, "node_modules", ".cache", "sprites", "weapons_%d" % scale)
    os.makedirs(d, exist_ok=True)
    return d


def main():
    import argparse
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--scale", type=int, default=0)
    ap.add_argument("--dirs", type=int, default=32)
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--engine", default="CYCLES")
    ap.add_argument("--device", default="GPU")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    only = [i for i in args.only.split(",") if i]

    def log(s):
        print("[weapons] " + s, flush=True)
    t_all = time.time()
    for scale in ([args.scale] if args.scale else [1, 2]):
        ppm = 10 * scale
        cell = int(math.ceil(CELL_M * ppm)) * 2
        anchor = (cell // 2, cell // 2)
        info = {}
        entries = {}
        for wid in WEAPONS:
            states, aliases = WEAPONS[wid][3], WEAPONS[wid][4]
            path = os.path.join(cache_dir(scale), "%s_%d_%s.npz" % (wid, args.dirs, "-".join(states)))
            probe = Kit("probe")
            muzzle, art, stations = WEAPONS[wid][0](probe, "emplaced" if "emplaced" in states else "setup")
            info[wid] = {"muzzleM": {"x": round(muzzle[0], 3), "y": round(muzzle[1], 3)}, "artScale": art,
                         "states": list(states), "aliases": dict(aliases),
                         "stations": {n: ({"x": round(v[0], 2), "y": round(v[1], 2)} if v else None) for n, v in stations.items()}}
            need = args.force or wid in only or not os.path.exists(path)
            if only and wid not in only and not os.path.exists(path):
                log("%s: not cached and not selected; left out of the atlas" % wid)
                continue
            if need:
                t0 = time.time()
                data = {}
                for st in states:
                    frames = VC.render_dirs(lambda ctx: build(wid, st), args.dirs, ppm, cell, anchor, shadow=True,
                                            engine=args.engine, samples=args.samples, device=args.device)
                    data[st] = np.stack(frames)
                np.savez_compressed(path, **data)
                log("%s scale %d rendered in %.1fs" % (wid, scale, time.time() - t0))
            z = np.load(path)
            for st in states:
                entries["%s.%s" % (wid, st)] = [z[st][i] for i in range(args.dirs)]
        entries, (cw, ch), anc = VC.crop_union(entries, anchor)
        packer = C.AtlasPacker(scale, cw, ch, anc, args.dirs, columns=32)
        for key, frames in entries.items():
            packer.add(key, [[f] for f in frames], fps=0, loop=False)
        base = os.path.join(VC.SPRITES, "weapons_%d" % scale)
        have = {w: info[w] for w in info if ("%s.%s" % (w, WEAPONS[w][3][0])) in entries}
        meta = packer.save(base, extra={"frame": "weapon-local metres: x = right, y = FORWARD (toward the muzzle), origin = pivot = cell anchor",
                                        "weapons": have})
        for w in have:          # aliases share frames with the state they point at
            for alias, target in WEAPONS[w][4].items():
                meta["entries"]["%s.%s" % (w, alias)] = dict(meta["entries"]["%s.%s" % (w, target)])
        with open(base + ".json", "w") as fh:
            json.dump(meta, fh, indent=1)
        log("scale %d packed: cell %dx%d anchor %s" % (scale, cw, ch, anc))
    log("all done in %.1fs" % (time.time() - t_all))


if __name__ == "__main__":
    main()
