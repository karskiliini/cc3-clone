"""Procedural WWII vehicle sprites: builds every VEHICLE_DEFS id from primitives (own geometry, no
third-party assets) and renders hull + turret in 64 facings into per-vehicle atlases.

  blender -b -P tools/blender/vehicles.py -- [--only t34_76,tiger] [--scale 1|2] [--force]
                                             [--dirs 64] [--samples 24] [--engine CYCLES|EEVEE]

Outputs (public/sprites/):
  vehicles_<defId>_<scale>.png/.json   contract atlas for ONE vehicle: entries <defId>.hull.<state> and, for
                                       turreted vehicles, <defId>.turret.<state>; 64 dirs;
                                       JSON adds turretPivotM {x, y} (hull-local metres, x = right,
                                       y = FORWARD; same frame as the weapon stations)
  vehicles_<scale>.json                index: {scale, dirs, vehicles: {defId: {file, cell, anchor,
                                       columns, turretPivotM, hasTurret, entries}}}
Resumable: every entry's 64 cells are cached in node_modules/.cache/sprites/vehicles_<scale>/ and
reused unless --force (pass --force after changing a model); an interrupted run just continues.
Hull states: ok, ko, blown (turret gone, open ring), trackL / trackR (the vehicle's own left / right
track thrown); turret states: ok, ko, blown (burnt turret lying on the ground, with ground shadow).
Dimensions (lengthM, widthM, hasTurret) are read from src/data/units.ts.
"""
import json
import math
import os
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import vehicles_common as VC  # noqa: E402
from vehicles_common import Kit, rect_fp, rounded_fp, ellipse_fp  # noqa: E402
from mathutils import Matrix, Euler, Vector  # noqa: E402

GREY = "#3e4548"      # Dunkelgrau RAL 7021 (1940-42), as it renders under the game's sun
DYEL = "#8e7a48"      # Dunkelgelb RAL 7028 (1943-45)
SOVG = "#3a4727"      # Soviet 4BO protective green
BARREL_K = 1.6       # gun tubes are drawn a little fat so they survive at 10 px/m
OLIV = "#46502d"      # Olivgruen RAL 6003
RBRN = "#5a3424"      # Rotbraun RAL 8017
CAMO_A = [(OLIV, 0.52, 0.58, 0.0), (RBRN, 0.57, 0.63, 7.3)]
CAMO_B = [(OLIV, 0.50, 0.56, 3.1)]
CAMO_A2 = [(OLIV, 0.52, 0.58, 4.4), (RBRN, 0.57, 0.63, 2.9)]
OD = "#474a2e"        # US olive drab (Lend-Lease Shermans kept it, with Soviet markings)
CAMO_C = [(RBRN, 0.50, 0.56, 5.2), (OLIV, 0.58, 0.64, 1.4)]


SUPERSAMPLE = {1: 3, 2: 2}   # per scale: 3x3 / 2x2 pixel grid, box-downsampled (clean plate edges without mush;
                             # at 20 px/m 2x2 is as fine as 3x3 at 10 px/m and renders twice as fast)
FILTER_W = 1.0       # Cycles pixel filter width (px of the supersampled image)
OUTLINE = 0.3        # darken the silhouette pixels by this much (see VC.clean_cell)
SHARPEN = 0.35       # unsharp mask on the object colour after the downsample

FRAME = "hull-local metres: x = right, y = FORWARD, origin = hull centre = hull cell anchor"


def read_defs():
    src = open(os.path.join(VC.ROOT, "src/data/units.ts")).read()
    src = src[src.index("VEHICLE_DEFS"):]
    out = {}
    for m in re.finditer(r"id: '(\w+)', name: '[^']*', kind: '(\w+)', lengthM: ([\d.]+), widthM: ([\d.]+)", src):
        tail = src[m.end():m.end() + 400]
        ht = re.search(r"hasTurret: (true|false)", tail).group(1) == "true"
        out[m.group(1)] = dict(kind=m.group(2), L=float(m.group(3)), W=float(m.group(4)), hasTurret=ht)
    return out


# ------------------------------------------------------------ shared assemblies
def gear(k, Lt, W, tw, top, n, r, cy=0.0, zs=None, zi=None, tyre=True, interleave=False, rs=None, ri=None,
         rollers=0, mat="paint"):
    """Both track runs with road wheels, sprocket and idler.  Lt = track length, top = top-run height."""
    zs = top * 0.62 if zs is None else zs
    zi = top * 0.55 if zi is None else zi
    rs = top * 0.36 if rs is None else rs
    ri = top * 0.32 if ri is None else ri
    for s in (-1, 1):
        x = s * (W / 2 - tw / 2)
        if getattr(k, "broken", 0) == s:
            # thrown track: the run has come off the wheels and lies slewed on the ground behind
            k.box((tw, Lt * 0.62, 0.05), (x + s * 0.28, cy - Lt * 0.52, 0.025), "thrown", rot=(0, 0, -s * 9))
            k.box((tw, Lt * 0.3, 0.05), (x + s * 0.05, cy + Lt * 0.1, 0.025), "thrown", rot=(0, 0, s * 3))
        prof = [(cy - Lt / 2 + 0.4, 0.0), (cy + Lt / 2 - 0.45, 0.0), (cy + Lt / 2, zs), (cy + Lt / 2 - 0.14, top),
                (cy - Lt / 2 + 0.14, top), (cy - Lt / 2, zi)]
        if getattr(k, "broken", 0) != s:
            k.prism(prof, tw, "track", x=x)
        span = Lt - 0.95 - 2 * r
        for i in range(n):
            y = cy - Lt / 2 + 0.45 + r + (span * i / (n - 1) if n > 1 else 0) + 0.03
            xo = x + (s * 0.02 if (not interleave or i % 2 == 0) else -s * 0.06)
            if tyre:
                k.cyl(r, tw * 0.6, (xo + s * tw * 0.2, y, r + 0.02), "rubber", axis="X", seg=14)
                k.cyl(r * 0.78, tw * 0.6 + 0.04, (xo + s * tw * 0.2, y, r + 0.02), mat, axis="X", seg=12)
            else:
                k.cyl(r, tw * 0.6 + 0.03, (xo + s * tw * 0.2, y, r + 0.02), mat, axis="X", seg=14)
            k.cyl(r * 0.25, tw * 0.6 + 0.09, (xo + s * tw * 0.2, y, r + 0.02), "steel", axis="X", seg=8)
        k.cyl(rs, tw + 0.05, (x, cy + Lt / 2 - rs - 0.03, zs), mat, axis="X", seg=12)
        k.cyl(rs * 0.4, tw + 0.1, (x, cy + Lt / 2 - rs - 0.03, zs), "steel", axis="X", seg=8)
        k.cyl(ri, tw + 0.05, (x, cy - Lt / 2 + ri + 0.03, zi), mat, axis="X", seg=12)
        for i in range(rollers):
            y = cy - Lt / 2 + 0.9 + (Lt - 1.8) * i / max(1, rollers - 1)
            k.cyl(0.13, tw + 0.04, (x, y, top - 0.16), "rubber", axis="X", seg=8)


def fenders(k, L, W, fw, z, cy=0.0, mat="paint", flaps=True, thick=0.035):
    for s in (-1, 1):
        x = s * (W / 2 - fw / 2)
        k.box((fw, L, thick), (x, cy, z), mat)
        if flaps:
            k.box((fw, 0.3, thick), (x, cy + L / 2 + 0.12, z - 0.07), mat, rot=(-28, 0, 0))
            k.box((fw, 0.26, thick), (x, cy - L / 2 - 0.1, z - 0.07), mat, rot=(30, 0, 0))


def tools(k, x, y, z, length=1.2, side=1):
    k.box((0.05, length, 0.05), (x, y, z + 0.03), "wood")
    k.box((0.16, 0.22, 0.04), (x, y + length / 2, z + 0.03), "steel")
    k.box((0.04, length * 0.9, 0.04), (x + side * 0.12, y - 0.1, z + 0.03), "steel")


def spare_track(k, loc, n, along="X", rot=(0, 0, 0), link=(0.2, 0.34, 0.06)):
    for i in range(n):
        o = (i - (n - 1) / 2) * (link[0] + 0.03)
        p = (loc[0] + o, loc[1], loc[2]) if along == "X" else (loc[0], loc[1] + o, loc[2])
        sz = link if along == "X" else (link[1], link[0], link[2])
        k.box(sz, p, "gunmetal", rot=rot)


def barrel(k, y0, length, r, z, brake=None, x=0.0, sleeve=None, taper=0.85, elev=0.0, mat="paint"):
    """Gun tube from y0 forward.  brake=(len, r) adds a muzzle brake; sleeve=(len, r) a recoil sleeve."""
    dz = math.tan(math.radians(elev))
    r *= BARREL_K
    sleeve = (sleeve[0], sleeve[1] * 1.15) if sleeve else None
    brake = (brake[0], brake[1] * 1.2) if brake else None
    p0 = (x, y0, z)
    p1 = (x, y0 + length, z + dz * length)
    k.tube(p0, p1, r, mat, seg=10, r2=r * taper)
    if sleeve:
        k.tube(p0, (x, y0 + sleeve[0], z + dz * sleeve[0]), sleeve[1], mat, seg=10)
    if brake:
        b0 = length - brake[0]
        k.tube((x, y0 + b0, z + dz * b0), p1, brake[1], mat, seg=10)
        k.tube((x, y0 + b0 + brake[0] * 0.3, z + dz * b0), (x, y0 + b0 + brake[0] * 0.55, z + dz * b0),
               brake[1] * 1.12, "gunmetal", seg=10)
    k.tube((x, p1[1] - 0.02, p1[2]), (x, p1[1] + 0.012, p1[2]), r * taper * 0.7, "hole", seg=8)


def cupola(k, x, y, z, r, h, ko, mat="paint", hinge="rear"):
    k.cyl(r, h, (x, y, z + h / 2), mat, axis="Z", seg=14, r2=r * 0.92)
    k.hatch((r * 1.5, r * 1.5), (x, y, z + h), mat, open_deg=100 if ko else 0, hinge=hinge, round_seg=12)


def skirts(k, L, x, z0, z1, n=5, cy=0.0, mat="paint"):
    seg = L / n
    for s in (-1, 1):
        for i in range(n):
            y = cy - L / 2 + seg * (i + 0.5)
            k.box((0.025, seg - 0.04, z1 - z0), (s * x, y, (z0 + z1) / 2), mat)
        k.box((0.04, L, 0.04), (s * (x - 0.04), cy, z1 - 0.08), "steel")


def exhaust_pipe(k, x, y, z, length=0.5, r=0.07, axis="Y"):
    k.cyl(r, length, (x, y, z), "rust", axis=axis, seg=8)


def ko_xform(k, ko, yaw=9.0, roll=3.5, shift=(0.05, -0.04)):
    if ko:
        k.xform = Matrix.Translation(Vector((shift[0], shift[1], 0.02))) @ \
            Euler((math.radians(roll * 0.6), math.radians(roll), math.radians(yaw)), "XYZ").to_matrix().to_4x4()


# ======================================================================= GERMAN
def german_medium(k, d, ko, v):
    """Pz III J / Flammpanzer III (Pz III M hull) / Pz IV F1, G, H: tub between the tracks, box
    superstructure over the fenders, lower engine deck, near-vertical plates."""
    L, W = d["L"], d["W"]
    pz4 = v.startswith("pz4")
    skirt = v in ("pz4gh", "flammpanzer3")
    Wh = W
    tw = 0.38 if pz4 else 0.36
    top = 0.92
    gear(k, L - 0.05, Wh, tw, top, 8 if pz4 else 6, 0.235 if pz4 else 0.26, rollers=4 if pz4 else 3)
    wb = Wh - 2 * tw + 0.06
    zr = 1.62 if pz4 else 1.55          # hull roof
    ze = zr - 0.16                        # engine deck
    ys0, ys1 = -0.55, L / 2 - 1.15        # superstructure extent
    prof = [(-L / 2 + 0.3, 0.42), (-L / 2 + 0.05, 0.95), (-L / 2 + 0.12, ze), (ys0, ze), (ys1, 1.22), (L / 2 - 0.42, 1.1),
            (L / 2 - 0.05, 0.8), (L / 2 - 0.4, 0.42)]
    k.prism(prof, wb, "paint")
    fenders(k, L - 0.25, Wh, tw + 0.1, top + 0.06)
    # superstructure (over the fenders), front plate with a slight slope
    ws = Wh - 0.08
    k.box((ws, ys1 - ys0, zr - top - 0.05), (0, (ys0 + ys1) / 2, (zr + top + 0.05) / 2), "paint", top=(1, 0.97), shift=(0, -0.03))
    # engine deck block, narrower, with side air intakes
    k.box((ws - 0.1, L / 2 + ys0 - 0.15, ze - top), (0, (-L / 2 + 0.15 + ys0) / 2, (ze + top) / 2), "paint", top=(0.9, 1.0))
    ey = (-L / 2 + ys0) / 2
    for s in (-1, 1):
        k.grille((0.3, 1.3), (s * (ws / 2 - 0.32), ey, ze + 0.0), "paint")
        k.hatch((0.62, 0.8), (s * 0.4, ey + 0.35, ze), "paint", open_deg=70 if ko and s > 0 else 0, hinge="left" if s < 0 else "right")
        k.hatch((0.6, 0.5), (s * 0.4, ey - 0.45, ze), "paint")
        # driver / radio-operator hatches on the glacis roof
        k.hatch((0.5, 0.42), (s * 0.62, ys1 - 0.32, zr), "paint", open_deg=95 if ko else 0, hinge="front")
        # brake access hatches on the glacis
        k.hatch((0.5, 0.36), (s * 0.55, L / 2 - 0.85, 1.17), "paint")
    # visor block + hull MG
    k.box((0.34, 0.06, 0.16), (-0.62, ys1 + 0.0, zr - 0.2), "gunmetal")
    k.cyl(0.11, 0.1, (0.62, ys1 + 0.02, zr - 0.22), "paint", axis="Y", seg=10)
    k.tube((0.62, ys1, zr - 0.22), (0.62, ys1 + 0.4, zr - 0.22), 0.025, "gunmetal", seg=6)
    spare_track(k, (0, L / 2 - 0.22, 0.98), 7, rot=(-35, 0, 0))
    # muffler across the rear plate
    if pz4:
        k.cyl(0.17, 1.5, (0, -L / 2 - 0.08, 0.95), "rust", axis="X", seg=10)
        k.cyl(0.1, 0.5, (-0.95, -L / 2 - 0.06, 0.92), "rust", axis="X", seg=8)
    else:
        for s in (-1, 1):
            k.cyl(0.12, 0.6, (s * 0.55, -L / 2 - 0.05, 1.0), "rust", axis="X", seg=10)
    tools(k, -(Wh / 2 - 0.22), 0.6, top + 0.08, 1.3, -1)
    tools(k, (Wh / 2 - 0.22), -0.2, top + 0.08, 1.1, 1)
    k.box((0.3, 0.45, 0.22), (Wh / 2 - 0.24, -L / 2 + 0.75, top + 0.19), "paint")      # jack / box
    k.box((0.22, 0.6, 0.12), (-(Wh / 2 - 0.22), -L / 2 + 0.9, top + 0.14), "wood")    # jack block
    k.cyl(0.035, 1.6, (-(Wh / 2 - 0.4), -0.9, top + 0.12), "steel", axis="Y", seg=6)   # aerial trough / cable
    k.cross(0.42, (ws / 2 + 0.003, -0.1, (zr + top) / 2 + 0.05), rot=(90, 0, 90))
    k.cross(0.42, (-ws / 2 - 0.003, -0.1, (zr + top) / 2 + 0.05), rot=(90, 0, -90))
    if skirt:
        skirts(k, L - 0.5, Wh / 2 + 0.14, 0.62, zr - 0.08, n=5, cy=-0.05)
    return (0.0, 0.18 if pz4 else 0.1), zr


def german_medium_turret(k, d, ko, v, zr, proxy):
    pz4 = v.startswith("pz4")
    w, l = (1.95, 2.25) if pz4 else (1.8, 2.0)
    h = 0.62
    fp = [(-w / 2, -l * 0.28), (-w * 0.34, -l / 2), (w * 0.34, -l / 2), (w / 2, -l * 0.28), (w * 0.43, l * 0.42), (-w * 0.43, l * 0.42)]
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.8, 0.9), shift=(0, -0.02), centre=(0, 0))
    # side doors / vision
    for s in (-1, 1):
        k.box((0.04, 0.55, 0.36), (s * (w * 0.45), 0.05, zr + 0.32), "paint", rot=(0, s * -12, s * -4))
    cupola(k, 0.0, -l * 0.27, zr + h - 0.02, 0.36, 0.26, ko)
    k.hatch((0.3, 0.3), (0.55, 0.35, zr + h), "paint", round_seg=10)      # ventilator
    # rear stowage bin
    k.box((1.25, 0.5, 0.42), (0, -l / 2 - 0.22, zr + 0.36), "paint", top=(0.96, 0.9))
    k.cross(0.3, (0, -l / 2 - 0.475, zr + 0.36), rot=(90, 0, 180))
    if proxy:
        return
    # mantlet + gun
    k.box((1.0 if pz4 else 0.9, 0.22, 0.46), (0, l * 0.42 + 0.08, zr + 0.34), "paint", top=(0.9, 0.8))
    if v == "pz3j":
        barrel(k, l * 0.42 + 0.1, 2.35, 0.06, zr + 0.34, sleeve=(0.55, 0.11))
    elif v == "flammpanzer3":
        # flame projector: a thick dummy sleeve with the thin flame tube running out of it
        barrel(k, l * 0.42 + 0.1, 2.3, 0.034, zr + 0.34, sleeve=(1.0, 0.12), taper=1.0)
        k.cyl(0.055, 0.12, (0, l * 0.42 + 2.37, zr + 0.34), "gunmetal", axis="Y", seg=8)
    elif v == "pz4f1":
        barrel(k, l * 0.42 + 0.1, 1.05, 0.105, zr + 0.34, sleeve=(0.4, 0.15), taper=1.0)
    elif v == "pz4g":
        # 7.5 cm KwK 40 L/43 with the single-baffle ball muzzle brake
        barrel(k, l * 0.42 + 0.1, 2.75, 0.075, zr + 0.34, sleeve=(0.6, 0.13), brake=(0.26, 0.14))
    else:
        barrel(k, l * 0.42 + 0.1, 3.05, 0.075, zr + 0.34, sleeve=(0.6, 0.13), brake=(0.36, 0.13))
    k.tube((0.3, l * 0.42, zr + 0.34), (0.3, l * 0.42 + 0.5, zr + 0.34), 0.025, "gunmetal", seg=6)


def pz4_turret_skirt(k, zr):
    """Pz IV H turret Schuerzen: bent plate around the sides and rear, standing off the turret."""
    rx, ry, cy = 1.3, 1.55, -0.22
    n = 12
    pts = []
    for i in range(n + 1):
        a = math.radians(-50 - 260.0 * i / n)       # from right-front, round the rear, to left-front
        pts.append((rx * math.cos(a), cy + ry * math.sin(a)))
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        ln = math.hypot(x1 - x0, y1 - y0)
        ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
        k.box((ln + 0.02, 0.025, 0.56), (mx, my, zr + 0.4), "paint", rot=(0, 0, ang))


def tiger(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.7, 1.12
    gear(k, L + 0.0, W, tw, top, 8, 0.4, interleave=True, rs=0.42, ri=0.34, zs=0.78, zi=0.6)
    wb = W - 2 * tw + 0.08
    zr = 1.78
    prof = [(-L / 2 + 0.2, 0.47), (-L / 2 + 0.08, zr - 0.1), (-L / 2 + 0.12, zr), (L / 2 - 1.35, zr), (L / 2 - 1.3, 1.32),
            (L / 2 - 0.35, 1.22), (L / 2 - 0.12, 0.85), (L / 2 - 0.5, 0.47)]
    k.prism(prof, wb, "paint")
    # full-width sponson superstructure
    k.box((W - 0.04, L - 1.5, zr - top - 0.02), (0, -0.62, (zr + top + 0.02) / 2), "paint")
    for s in (-1, 1):   # front mud guards + side fenders lip
        k.box((tw + 0.04, 1.2, 0.035), (s * (W / 2 - tw / 2), L / 2 - 0.72, top + 0.08), "paint", rot=(-7, 0, 0))
        k.box((0.12, L - 1.5, 0.03), (s * (W / 2 + 0.03), -0.62, top + 0.05), "paint")
        k.hatch((0.5, 0.5), (s * 0.95, L / 2 - 1.75, zr), "paint", open_deg=100 if ko else 0, hinge="front", round_seg=10)
    k.box((0.4, 0.06, 0.18), (-0.75, L / 2 - 1.33, zr - 0.22), "gunmetal")
    k.cyl(0.13, 0.1, (0.75, L / 2 - 1.31, zr - 0.24), "paint", axis="Y", seg=10)
    k.tube((0.75, L / 2 - 1.3, zr - 0.24), (0.75, L / 2 - 0.9, zr - 0.24), 0.025, "gunmetal", seg=6)
    spare_track(k, (0, L / 2 - 0.2, 1.05), 8, rot=(-50, 0, 0), link=(0.22, 0.4, 0.07))
    # engine deck: central hatch, four grilles
    ey = -L / 2 + 1.0
    k.hatch((1.0, 1.35), (0, ey, zr), "paint", open_deg=55 if ko else 0, hinge="left")
    for s in (-1, 1):
        k.grille((0.85, 0.62), (s * 1.15, ey + 0.42, zr), "paint")
        k.grille((0.85, 0.62), (s * 1.15, ey - 0.38, zr), "paint")
        # Feifel-less rear: two upright exhausts with shrouds
        k.cyl(0.13, 0.75, (s * 0.42, -L / 2 - 0.12, 1.45), "rust", axis="Z", seg=10)
        k.box((0.36, 0.06, 0.6), (s * 0.42, -L / 2 - 0.27, 1.35), "paint")
    k.box((0.3, 0.5, 0.2), (W / 2 - 0.4, -L / 2 + 0.3, zr + 0.1), "paint")
    tools(k, -0.95, 0.35, zr, 1.3, -1)
    k.cyl(0.03, 2.4, (W / 2 - 0.2, -0.4, zr + 0.04), "steel", axis="Y", seg=6)     # tow cable
    k.cyl(0.03, 2.4, (-W / 2 + 0.2, -0.4, zr + 0.04), "steel", axis="Y", seg=6)
    k.cross(0.5, (W / 2 - 0.015, -0.2, (zr + top) / 2 + 0.02), rot=(90, 0, 90))
    k.cross(0.5, (-W / 2 + 0.015, -0.2, (zr + top) / 2 + 0.02), rot=(90, 0, -90))
    return (0.0, 0.05), zr


def tiger_turret(k, d, ko, zr, proxy):
    # horseshoe turret: round rear, flat front
    w, l, h = 2.5, 2.75, 0.8
    fp = []
    for i in range(13):
        a = math.radians(180 + 180.0 * i / 12)
        fp.append((w / 2 * math.cos(a), -0.35 + (l / 2 - 0.2) * math.sin(a)))
    fp += [(w * 0.4, l / 2 - 0.1), (-w * 0.4, l / 2 - 0.1)]
    k.extrude(fp, zr + 0.02, zr + h, "paint", smooth=False, centre=(0, 0), scale=(0.99, 0.99))
    cupola(k, -0.62, -0.35, zr + h, 0.4, 0.22, ko)
    k.hatch((0.5, 0.6), (0.6, -0.3, zr + h), "paint", open_deg=90 if ko else 0, hinge="rear")
    k.hatch((0.3, 0.3), (0.1, 0.55, zr + h), "paint", round_seg=10)
    k.box((1.3, 0.55, 0.5), (0, -l / 2 - 0.45, zr + 0.42), "paint", top=(0.92, 0.85))
    k.cross(0.34, (0, -l / 2 - 0.73, zr + 0.42), rot=(90, 0, 180))
    if proxy:
        return
    k.box((2.1, 0.3, 0.72), (0, l / 2 + 0.03, zr + 0.42), "paint", top=(0.97, 0.75))
    barrel(k, l / 2 + 0.1, 3.75, 0.1, zr + 0.42, sleeve=(1.0, 0.2), brake=(0.5, 0.2))
    k.tube((0, l / 2 + 1.1, zr + 0.42), (0, l / 2 + 1.9, zr + 0.42), 0.15, "paint", seg=10)


def panther(k, d, ko, v="G"):
    """Panther G (and A / D: v): same plan; D has the letterbox MG port instead of the ball mount."""
    L, W = d["L"], d["W"]
    tw, top = 0.66, 1.08
    gear(k, L, W, tw, top, 8, 0.43, interleave=True, rs=0.42, ri=0.32, zs=0.8, zi=0.55)
    zr = 1.85
    wb = W - 2 * tw + 0.08
    # lower tub with long sloped glacis and undercut rear
    prof = [(-L / 2 + 0.55, 0.5), (-L / 2 + 0.1, zr - 0.05), (L / 2 - 1.75, zr), (L / 2 - 0.2, 0.95), (L / 2 - 0.75, 0.5)]
    k.prism(prof, wb, "paint")
    # upper hull: sponsons over the tracks with inward-sloped sides; glacis continues full width
    fp = [(-W / 2, -L / 2 + 0.25), (W / 2, -L / 2 + 0.25), (W / 2, L / 2 - 1.2), (-W / 2, L / 2 - 1.2)]
    k.extrude(fp, top + 0.02, zr, "paint", scale=(0.78, 1.0), shift=(0, -0.0), centre=(0, (-L / 2 + 0.25 + L / 2 - 1.2) / 2))
    gl = [(L / 2 - 1.2, top + 0.02), (L / 2 - 1.2, zr - 0.02), (L / 2 - 1.72, zr), (L / 2 - 0.35, top + 0.02)]
    k.prism([(L / 2 - 1.75, zr), (L / 2 - 0.3, top + 0.02), (L / 2 - 1.75, top + 0.02)], W, "paint", width2=[W * 0.78, W, W])
    for s in (-1, 1):
        k.box((tw * 0.9, 0.6, 0.03), (s * (W / 2 - tw / 2), L / 2 - 0.25, top + 0.02), "paint", rot=(-20, 0, 0))
        k.hatch((0.48, 0.55), (s * 0.78, L / 2 - 2.15, zr), "paint", open_deg=90 if ko else 0, hinge="left" if s < 0 else "right")
        # engine deck: round fan housings + rectangular grilles each side
        k.cyl(0.36, 0.06, (s * 0.98, -L / 2 + 1.05, zr + 0.03), "paint", axis="Z", seg=14)
        k.cyl(0.29, 0.02, (s * 0.98, -L / 2 + 1.05, zr + 0.07), "grille", axis="Z", seg=14)
        k.grille((0.7, 0.42), (s * 0.98, -L / 2 + 1.75, zr), "paint")
        k.grille((0.7, 0.42), (s * 0.98, -L / 2 + 0.45, zr), "paint")
        k.cyl(0.085, 0.8, (s * 0.35, -L / 2 + 0.05, 1.5), "rust", axis="Z", seg=8, rot=(-12, 0, 0))
        k.box((0.5, 0.35, 0.55), (s * 1.2, -L / 2 + 0.12, 1.35), "paint", rot=(-25, 0, 0))   # rear stowage boxes
        tools(k, s * (W / 2 - 0.33), 0.3, 1.45, 1.3, s)
        spare_track(k, (s * (W / 2 - 0.22), -1.6, 1.45), 4, along="Y", rot=(0, s * 35, 0), link=(0.2, 0.3, 0.06))
    k.hatch((0.95, 1.2), (0, -L / 2 + 1.1, zr), "paint", open_deg=50 if ko else 0, hinge="left")
    if v == "D":
        k.box((0.3, 0.05, 0.1), (0.8, L / 2 - 1.1, 1.47), "gunmetal", rot=(-55, 0, 0))            # letterbox MG port
    else:
        k.cyl(0.12, 0.12, (0.8, L / 2 - 1.1, 1.45), "paint", axis="Y", seg=10, rot=(-90 + 35, 0, 0))   # ball MG
    k.cross(0.46, (W / 2 * 0.89 + 0.01, -0.2, (zr + top) / 2), rot=(90 - 16, 0, 90))
    k.cross(0.46, (-W / 2 * 0.89 - 0.01, -0.2, (zr + top) / 2), rot=(90 - 16, 0, -90))
    return (0.0, 0.3), zr


def panther_turret(k, d, ko, zr, proxy, v="G"):
    w, l, h = 2.3, 2.55, 0.78
    fp = [(-w / 2, -l / 2 + 0.2), (-w * 0.38, -l / 2), (w * 0.38, -l / 2), (w / 2, -l / 2 + 0.2), (w * 0.32, l / 2 - 0.2), (-w * 0.32, l / 2 - 0.2)]
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.74, 0.88), shift=(0, -0.1), centre=(0, 0))
    if v == "D":
        # tall drum cupola; triple smoke-grenade dischargers on the turret cheeks
        cupola(k, -0.45, -0.55, zr + h - 0.02, 0.36, 0.36, ko)
        for s in (-1, 1):
            for i in range(3):
                k.cyl(0.05, 0.22, (s * 0.92, 0.35 - i * 0.14, zr + 0.62), "gunmetal", axis="Y", seg=6, rot=(-90 + 45, 0, s * 30))
    else:
        cupola(k, -0.45, -0.55, zr + h - 0.02, 0.4, 0.25, ko)
    k.hatch((0.3, 0.3), (0.35, 0.3, zr + h - 0.01), "paint", round_seg=10)
    if proxy:
        return
    k.cyl(0.36, 1.55, (0, l / 2 - 0.12, zr + 0.4), "paint", axis="X", seg=12)        # rounded mantlet
    barrel(k, l / 2 + 0.1, 4.3, 0.085, zr + 0.4, sleeve=(0.7, 0.15), brake=(0.45, 0.15))


def stug3g(k, d, ko, pz4=False):
    """StuG III G; pz4: StuG IV (the same casemate on the longer Pz IV chassis, 8 small road wheels,
    with the driver's armoured cab jutting out of the front left)."""
    L, W = d["L"], d["W"]
    tw, top = 0.38, 0.9
    if pz4:
        gear(k, L - 0.05, W, tw, top, 8, 0.235, rollers=4)
    else:
        gear(k, L - 0.05, W, tw, top, 6, 0.26, rollers=3)
    wb = W - 2 * tw + 0.06
    ze, zc = 1.38, 1.72
    prof = [(-L / 2 + 0.3, 0.42), (-L / 2 + 0.05, 0.95), (-L / 2 + 0.12, ze), (-0.1, ze), (L / 2 - 1.1, 1.2), (L / 2 - 0.4, 1.08),
            (L / 2 - 0.05, 0.8), (L / 2 - 0.4, 0.42)]
    k.prism(prof, wb, "paint")
    fenders(k, L - 0.25, W, tw + 0.1, top + 0.06)
    # engine deck
    k.box((W - 0.2, L / 2 - 0.35, ze - top), (0, (-L / 2 + 0.1 - 0.25) / 2 - 0.0, (ze + top) / 2), "paint", top=(0.88, 1.0))
    ey = -L / 2 + 1.15
    for s in (-1, 1):
        k.grille((0.3, 1.2), (s * (W / 2 - 0.42), ey, ze), "paint")
        k.hatch((0.6, 0.75), (s * 0.4, ey + 0.35, ze), "paint", open_deg=65 if ko and s < 0 else 0, hinge="left" if s < 0 else "right")
        k.hatch((0.6, 0.5), (s * 0.4, ey - 0.4, ze), "paint")
        k.cyl(0.12, 0.6, (s * 0.55, -L / 2 - 0.05, 1.0), "rust", axis="X", seg=10)
        k.hatch((0.5, 0.36), (s * 0.55, L / 2 - 0.8, 1.13), "paint")
    # casemate: low box with sloped front and side panniers
    cy0, cy1 = -0.35, L / 2 - 1.05
    fp = rect_fp(W - 0.1, cy1 - cy0, (cy0 + cy1) / 2)
    k.extrude(fp, top + 0.08, zc, "paint", scale=(0.8, 0.86), shift=(0, -0.12), centre=(0, (cy0 + cy1) / 2))
    k.box((1.6, 1.0, 0.1), (0, 0.35, zc + 0.04), "paint")                                # raised roof centre
    if pz4:
        k.box((0.72, 0.62, 0.42), (-0.62, cy1 + 0.18, top + 0.3), "paint", top=(0.9, 0.55), shift=(0, -0.12))
        k.box((0.3, 0.05, 0.08), (-0.62, cy1 + 0.43, top + 0.36), "gunmetal", rot=(-50, 0, 0))   # driver's visor
    cupola(k, -0.6, -0.05, zc + 0.06, 0.34, 0.2, ko)
    k.hatch((0.55, 0.7), (0.55, 0.0, zc + 0.09), "paint", open_deg=100 if ko else 0, hinge="rear")
    k.box((0.6, 0.03, 0.34), (0.55, 0.42, zc + 0.3), "paint", rot=(-15, 0, 0))            # loader MG shield
    k.tube((0.55, 0.4, zc + 0.3), (0.55, 0.95, zc + 0.32), 0.022, "gunmetal", seg=6)
    # gun: Saukopf mantlet, offset right of centre
    gx = 0.18
    k.cyl(0.34, 0.75, (gx, cy1 + 0.0, 1.42), "paint", axis="Y", seg=12, r2=0.2)
    barrel(k, cy1 + 0.3, 2.7, 0.075, 1.42, x=gx, sleeve=(0.5, 0.13), brake=(0.36, 0.13))
    spare_track(k, (0, L / 2 - 0.2, 0.96), 7, rot=(-35, 0, 0))
    tools(k, -(W / 2 - 0.2), -1.2, top + 0.08, 1.1, -1)
    k.cross(0.4, ((W - 0.1) / 2 * 0.9 + 0.012, 0.4, 1.35), rot=(90 - 20, 0, 90))
    k.cross(0.4, (-(W - 0.1) / 2 * 0.9 - 0.012, 0.4, 1.35), rot=(90 - 20, 0, -90))
    skirts(k, L - 0.5, W / 2 + 0.14, 0.6, 1.5, n=5, cy=-0.05)
    return None, zc


def marder3(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.34, 0.85
    gear(k, L - 0.05, W, tw, top, 4, 0.39, rollers=2, rs=0.3, ri=0.27)
    wb = W - 2 * tw + 0.05
    zd = 1.25
    prof = [(-L / 2 + 0.3, 0.4), (-L / 2 + 0.05, 0.9), (-L / 2 + 0.1, zd), (L / 2 - 1.0, zd), (L / 2 - 0.85, 1.0), (L / 2 - 0.25, 0.92),
            (L / 2 - 0.05, 0.7), (L / 2 - 0.4, 0.4)]
    k.prism(prof, wb, "paint")
    fenders(k, L - 0.2, W, tw + 0.12, top + 0.05)
    # driver's box front-right + bolt-studded superstructure
    k.box((wb * 0.98, 1.0, 0.3), (0, L / 2 - 1.55, zd + 0.15), "paint", top=(0.96, 0.9))
    k.hatch((0.5, 0.45), (0.5, L / 2 - 1.5, zd + 0.3), "paint", open_deg=90 if ko else 0, hinge="front")
    # open-topped fighting compartment: floor, thin angled shield walls
    k.box((wb + 0.5, 2.1, 0.05), (0, -0.55, zd + 0.03), "gunmetal")
    h = 0.95
    zc = zd + 0.3 + h / 2
    wall = "paint"
    for s in (-1, 1):
        k.box((0.035, 2.0, h), (s * (W / 2 - 0.42), -0.45, zc), wall, rot=(0, s * -10, s * 9))
        k.box((0.75, 0.035, h), (s * 0.78, 0.58, zc), wall, rot=(-16, 0, s * -22))
        k.box((0.04, 1.5, 0.05), (s * (W / 2 - 0.5), -0.5, zd + 0.35), "wood")          # ammo racks / seats
        k.box((0.4, 0.8, 0.3), (s * (W / 2 - 0.62), -0.9, zd + 0.2), "gunmetal")
    # interior darkness so it reads as open
    k.box((wb + 0.35, 1.7, 0.02), (0, -0.55, zd + 0.07), "floor")
    # PaK 40 on its pedestal: breech, cradle, small inner shield, long barrel
    gz = zd + 0.95
    k.box((0.3, 0.75, 0.3), (0, -0.25, gz), "gunmetal")
    k.box((0.22, 1.0, 0.18), (0, 0.45, gz - 0.12), "paint")
    k.box((0.8, 0.04, 0.5), (0, 0.66, gz - 0.08), wall, rot=(-24, 0, 0))
    barrel(k, 0.1, 3.3, 0.072, gz, brake=(0.38, 0.13), sleeve=(0.9, 0.1))
    k.box((0.5, 0.35, 0.3), (-(W / 2 - 0.3), -L / 2 + 0.5, top + 0.22), "paint")
    k.cyl(0.09, 0.9, (W / 2 - 0.25, -L / 2 + 0.55, top + 0.18), "rust", axis="Y", seg=8)
    # engine deck rear
    k.grille((0.9, 0.5), (0, -L / 2 + 0.4, zd), "paint")
    tools(k, -(W / 2 - 0.2), 0.7, top + 0.07, 1.0, -1)
    spare_track(k, (0, L / 2 - 0.55, 0.99), 5, rot=(-8, 0, 0), link=(0.17, 0.3, 0.05))
    k.cross(0.36, ((W / 2 - 0.42) + 0.1, -0.55, zc - 0.05), rot=(90 - 10, 0, 90 + 9))
    k.cross(0.36, (-(W / 2 - 0.42) - 0.1, -0.55, zc - 0.05), rot=(90 - 10, 0, -90 - 9))
    return None, zd


def sdkfz251(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.28, 0.72
    # rear track units (interleaved wheels) under the back two thirds
    Lt = 3.6
    gear(k, Lt, W - 0.1, tw, top, 6, 0.3, cy=-L / 2 + Lt / 2 + 0.25, interleave=True, rs=0.27, ri=0.26, zs=0.45, zi=0.4)
    # front axle wheels
    for s in (-1, 1):
        k.cyl(0.42, 0.22, (s * (W / 2 - 0.13), L / 2 - 0.95, 0.42), "rubber", axis="X", seg=16)
        k.cyl(0.24, 0.24, (s * (W / 2 - 0.13), L / 2 - 0.95, 0.42), "paint", axis="X", seg=10)
        k.box((0.34, 1.45, 0.03), (s * (W / 2 - 0.17), L / 2 - 1.3, 0.9), "paint")                # mudguard
        k.box((0.34, 0.42, 0.03), (s * (W / 2 - 0.17), L / 2 - 0.42, 0.78), "paint", rot=(-32, 0, 0))
        k.box((0.3, 0.03, 0.2), (s * (W / 2 - 0.17), L / 2 - 2.0, 0.8), "paint")                  # fender web to the bay
        k.box((0.34, Lt - 0.2, 0.03), (s * (W / 2 - 0.19), -L / 2 + Lt / 2 + 0.3, top + 0.08), "paint")
    k.cyl(0.05, W - 0.4, (0, L / 2 - 0.95, 0.42), "steel", axis="X", seg=6)
    # bonnet: narrow, sloped nose
    zb, zs = 1.28, 1.72
    bw = 1.15
    prof = [(L / 2 - 2.05, 0.55), (L / 2 - 2.05, zb + 0.1), (L / 2 - 0.55, zb - 0.12), (L / 2 - 0.05, 0.95), (L / 2 - 0.25, 0.55)]
    k.prism(prof, bw, "paint", width2=[bw + 0.35, bw + 0.35, bw - 0.1, bw - 0.3, bw - 0.3])
    k.grille((0.6, 0.4), (0, L / 2 - 1.0, zb - 0.06), "paint")
    for s in (-1, 1):
        k.hatch((0.4, 0.8), (s * 0.3, L / 2 - 1.45, zb + 0.03), "paint", open_deg=60 if ko and s > 0 else 0, hinge="left" if s < 0 else "right")
        k.cyl(0.09, 0.08, (s * 0.72, L / 2 - 0.6, 1.0), "gunmetal", axis="Y", seg=8)          # headlamps
    # crew bay: lower hull flares out, upper plates lean in (diamond section), open top
    y0, y1 = -L / 2 + 0.05, L / 2 - 2.0
    cyb = (y0 + y1) / 2
    wl, wm, wt = W - 0.75, W - 0.12, W - 0.5
    k.extrude(rect_fp(wl, y1 - y0, cyb), 0.5, 1.02, "paint", scale=(wm / wl, 1.0), centre=(0, cyb))
    # upper walls as four leaning plates
    hh = zs - 1.02
    for s in (-1, 1):
        k.box((0.04, y1 - y0 - 0.15, hh + 0.04), (s * ((wm + wt) / 4 - 0.0), cyb - 0.08, 1.02 + hh / 2), "paint", rot=(0, s * -14, 0))
    k.box((wt + 0.05, 0.04, hh), (0, y0 + 0.1, 1.02 + hh / 2), "paint", rot=(16, 0, 0))                 # rear doors
    k.box((0.03, 0.02, hh * 0.9), (0, y0 + 0.07, 1.02 + hh / 2), "black", rot=(16, 0, 0))
    # driver's roof / front armoured cab with visors
    k.box((wt + 0.1, 0.95, 0.04), (0, y1 - 0.45, zs), "paint")
    k.box((wt + 0.2, 0.04, 0.5), (0, y1 + 0.06, zs - 0.22), "paint", rot=(-28, 0, 0))
    for s in (-1, 1):
        k.box((0.3, 0.03, 0.1), (s * 0.4, y1 + 0.1, zs - 0.18), "black", rot=(-28, 0, 0))
    # bay floor, benches, stowage
    k.box((wt - 0.1, y1 - y0 - 1.25, 0.02), (0, cyb - 0.5, 0.96), "gunmetal")
    for s in (-1, 1):
        k.box((0.32, 1.9, 0.08), (s * (wt / 2 - 0.26), cyb - 0.55, 1.3), "leather")
        k.box((0.06, 1.9, 0.3), (s * (wt / 2 - 0.08), cyb - 0.55, 1.45), "leather")
    # MG34 with shield at the front of the bay
    k.box((0.7, 0.03, 0.32), (0, y1 - 0.92, zs + 0.2), "paint", rot=(-18, 0, 0))
    k.tube((0, y1 - 1.3, zs + 0.17), (0, y1 - 0.35, zs + 0.2), 0.03, "gunmetal", seg=6)
    k.box((0.06, 0.3, 0.1), (0, y1 - 1.35, zs + 0.13), "wood")
    k.tube((0, y0 + 0.4, zs + 0.1), (0, y0 + 0.95, zs + 0.2), 0.025, "gunmetal", seg=6)   # rear AA MG
    tools(k, -(W / 2 - 0.12), -0.6, top + 0.12, 1.0, -1)
    k.box((0.26, 0.7, 0.2), (W / 2 - 0.2, -0.2, top + 0.2), "paint")
    k.cross(0.36, (wm / 2 - 0.08, cyb - 0.2, 1.38), rot=(90 - 14, 0, 90))
    k.cross(0.36, (-wm / 2 + 0.08, cyb - 0.2, 1.38), rot=(90 - 14, 0, -90))
    return None, zs


# ======================================================================= SOVIET
def t34_hull(k, d, ko, su85=False, flame=False):
    L, W = d["L"], d["W"]
    tw, top = 0.5, 0.95
    Lh = L - 0.35 if not su85 else L - 0.1         # hull body; tracks run the full length
    gear(k, L - 0.1, W, tw, top, 5, 0.41, rs=0.32, ri=0.26, zs=0.62, zi=0.5, tyre=True)
    zr = 1.42
    wb = W - 2 * tw + 0.06
    prof = [(-Lh / 2 + 0.55, 0.42), (-Lh / 2 + 0.0, 1.0), (-Lh / 2 + 0.55, zr), (Lh / 2 - 1.3, zr), (Lh / 2 - 0.02, 0.92), (Lh / 2 - 0.45, 0.42)]
    k.prism(prof, wb, "paint")
    # upper hull over the tracks: sides lean in ~40 deg; glacis and rear slope
    y0, y1 = -Lh / 2 + 0.5, Lh / 2 - 1.28
    k.extrude(rect_fp(W - 0.04, y1 - y0, (y0 + y1) / 2), top + 0.03, zr, "paint", scale=(0.72, 1.0), centre=(0, (y0 + y1) / 2))
    k.prism([(y1, zr), (Lh / 2, top - 0.02), (y1, top + 0.03)], W, "paint", width2=[(W - 0.04) * 0.72, W - 0.04, W - 0.04])
    k.prism([(y0, zr), (y0, top + 0.03), (-Lh / 2 + 0.02, top + 0.0)], W, "paint", width2=[(W - 0.04) * 0.72, W - 0.04, W - 0.2])
    fenders(k, L - 0.3, W, tw + 0.02, top + 0.03, flaps=True)
    # driver's hatch in the glacis, hull MG ball
    sl = math.degrees(math.atan2(zr - top, Lh / 2 - y1))
    k.box((0.62, 0.7, 0.05), (-0.35 if not su85 else -0.55, (y1 + Lh / 2) / 2 - 0.1, (zr + top) / 2 + 0.1), "paint", rot=(-sl - (50 if ko else 0), 0, 0))
    if not su85:
        k.cyl(0.14, 0.14, (0.55, (y1 + Lh / 2) / 2 + 0.1, (zr + top) / 2 + 0.0), "paint", axis="Y", seg=10, rot=(-90 + sl, 0, 0))
    if flame:
        # OT-34: ATO-41 flame projector in place of the bow MG, a stubby armoured tube
        yb, zb = (y1 + Lh / 2) / 2 + 0.1, (zr + top) / 2
        k.tube((0.55, yb, zb), (0.55, yb + 0.75, zb - 0.05), 0.075, "paint", seg=10, r2=0.06)
        k.cyl(0.05, 0.08, (0.55, yb + 0.78, zb - 0.05), "gunmetal", axis="Y", seg=8)
    spare_track(k, (0.3 if su85 else 0.0, Lh / 2 - 0.22, top + 0.22), 4, rot=(-sl, 0, 0), link=(0.24, 0.3, 0.06))
    # engine deck: side louvres, central raised cover, rear mesh
    for s in (-1, 1):
        k.grille((0.34, 1.35), (s * 0.88, -Lh / 2 + 1.75, zr), "paint")
        k.cyl(0.075, 0.5, (s * 0.5, -Lh / 2 + 0.08, 1.12), "rust", axis="Y", seg=8, rot=(-90 - 20, 0, 0))
        # external fuel drums on the rear hull sides
        k.cyl(0.19, 0.95, (s * (W / 2 - 0.3), -Lh / 2 + 1.35, top + 0.36), "paint", axis="Y", seg=10)
        k.box((0.04, 0.05, 0.2), (s * (W / 2 - 0.3), -Lh / 2 + 1.35, top + 0.3), "steel")
    k.box((1.05, 1.3, 0.1), (0, -Lh / 2 + 1.8, zr + 0.05), "paint", top=(0.9, 0.95))
    k.hatch((0.6, 0.6), (0, -Lh / 2 + 1.9, zr + 0.1), "paint", open_deg=60 if ko else 0, hinge="front")
    k.grille((1.5, 0.62), (0, -Lh / 2 + 0.78, zr - 0.02), "paint")
    tools(k, W / 2 - 0.25, 0.9, top + 0.06, 1.1, 1)
    k.box((0.3, 0.65, 0.2), (-(W / 2 - 0.27), 0.7, top + 0.15), "paint")
    k.cyl(0.03, 2.2, (-(W / 2 - 0.25), -0.2, top + 0.4), "wood", axis="Y", seg=6)       # unditching log
    k.cyl(0.11, 2.2, (-(W / 2 - 0.2), -0.75, top + 0.16), "wood", axis="Y", seg=8)
    return zr


def t34_76(k, d, ko):
    zr = t34_hull(k, d, ko)
    return (0.0, 0.62), zr


def t34_76_turret(k, d, ko, zr, proxy):
    # 1942 hexagonal "nut" turret, two round hatches
    w, l, h = 1.95, 2.3, 0.62
    fp = [(-w * 0.34, -l / 2), (w * 0.34, -l / 2), (w / 2, -0.1), (w * 0.3, l / 2 - 0.1), (-w * 0.3, l / 2 - 0.1), (-w / 2, -0.1)]
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.72, 0.8), shift=(0, -0.05), centre=(0, -0.15))
    for s in (-1, 1):
        k.hatch((0.52, 0.52), (s * 0.36, -0.5, zr + h), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=12)
    k.hatch((0.26, 0.26), (0, 0.15, zr + h), "paint", round_seg=8)
    k.star(0.36, (0, 0.12, zr + h + 0.045))
    if proxy:
        return
    k.box((0.85, 0.5, 0.5), (0, l / 2 - 0.05, zr + 0.34), "paint", top=(0.7, 0.8))
    k.cyl(0.2, 0.6, (0, l / 2 + 0.35, zr + 0.34), "paint", axis="Y", seg=10, r2=0.14)
    barrel(k, l / 2 + 0.2, 2.2, 0.07, zr + 0.34)


def t34_85(k, d, ko):
    zr = t34_hull(k, d, ko)
    return (0.0, 0.55), zr


def t34_85_turret(k, d, ko, zr, proxy):
    w, l, h = 2.25, 2.9, 0.72
    fp = rounded_fp(w, l, 0.85, seg=4, cy=-0.3, r_front=0.55)
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.76, 0.84), shift=(0, -0.05), smooth=True, centre=(0, -0.3))
    cupola(k, -0.42, -0.25, zr + h - 0.02, 0.4, 0.22, ko, hinge="front")
    k.hatch((0.5, 0.5), (0.45, -0.3, zr + h), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=12)
    for y in (-1.0, -1.35):
        k.cyl(0.13, 0.1, (0, y, zr + h - 0.03), "paint", axis="Z", seg=10)          # twin ventilator domes
    k.star(0.42, (0, 0.42, zr + h + 0.005))
    if proxy:
        return
    k.cyl(0.33, 0.9, (0, l / 2 - 0.42, zr + 0.36), "paint", axis="X", seg=12)
    k.cyl(0.19, 0.7, (0, l / 2 + 0.05, zr + 0.36), "paint", axis="Y", seg=10, r2=0.14)
    barrel(k, l / 2 - 0.1, 4.0, 0.078, zr + 0.36)


def su85(k, d, ko, v="su85"):
    """SU-85; v = "su100" (D-10S, commander's cupola in a sponson bulge on the right) or "su122"
    (short M-30S howitzer in its big round armoured mantlet)."""
    L, W = d["L"], d["W"]
    zr = t34_hull(k, d, ko, su85=True)
    Lh = L - 0.1
    top = 0.95
    # casemate: the glacis carries on up into a fixed fighting compartment
    zc = 1.95
    y1 = Lh / 2 - 1.28
    y0 = -0.55
    fp = rect_fp(W - 0.06, (y1 + 0.75) - y0, (y0 + y1 + 0.75) / 2)
    k.extrude(fp, top + 0.03, zc, "paint", scale=(0.74, 0.62), shift=(0, -0.42), centre=(0, (y0 + y1 + 0.75) / 2))
    k.hatch((0.6, 0.55), (0.35, y0 + 0.5, zc), "paint", open_deg=95 if ko else 0, hinge="rear")
    if v != "su100":
        cupola(k, 0.62, 0.35, zc - 0.02, 0.3, 0.2, ko)
    k.hatch((0.5, 0.6), (-0.4, y0 + 0.55, zc), "paint", open_deg=80 if ko else 0, hinge="left")
    k.box((0.22, 0.22, 0.1), (-0.3, 0.6, zc + 0.05), "paint")
    k.star(0.4, (-0.12, 1.02, zc + 0.105))
    gx, gy, gz = 0.28, y1 + 0.35, 1.5
    if v == "su122":
        gx = -0.1
        k.cyl(0.55, 0.55, (gx, gy + 0.05, gz), "paint", axis="Y", seg=14, r2=0.42)       # "bell" mantlet
        k.cyl(0.2, 0.5, (gx, gy + 0.55, gz), "paint", axis="Y", seg=10, r2=0.17)
        barrel(k, gy + 0.5, 1.75, 0.105, gz, x=gx, taper=1.0)
        return None, zc
    if v == "su100":
        # commander's cupola on a bulge out of the right side plate
        k.box((0.5, 0.75, 0.62), (W / 2 - 0.62, y1 - 0.35, zc - 0.32), "paint", top=(0.8, 0.85))
        cupola(k, W / 2 - 0.62, y1 - 0.35, zc - 0.02, 0.3, 0.2, ko)
    # gun: ball mantlet right of centre, long tube
    k.cyl(0.42, 0.5, (gx, gy, gz), "paint", axis="Y", seg=12, r2=0.3, rot=(-90 + 8, 0, 0))
    k.cyl(0.24, 0.8, (gx, gy + 0.55, gz), "paint", axis="Y", seg=10, r2=0.17)
    if v == "su100":
        barrel(k, gy + 0.4, 4.7, 0.085, gz, x=gx, sleeve=(0.6, 0.14))
    else:
        barrel(k, gy + 0.4, 3.6, 0.078, gz, x=gx)
    return None, zc


def kv1(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.68, 1.02
    gear(k, L - 0.05, W, tw, top, 6, 0.3, rs=0.34, ri=0.33, zs=0.7, zi=0.62, tyre=False, rollers=3)
    zr = 1.62
    wb = W - 2 * tw + 0.06
    prof = [(-L / 2 + 0.45, 0.45), (-L / 2 + 0.02, 0.95), (-L / 2 + 0.5, zr - 0.12), (-L / 2 + 1.0, zr), (L / 2 - 1.55, zr),
            (L / 2 - 1.45, 1.3), (L / 2 - 0.5, 1.12), (L / 2 - 0.05, 0.85), (L / 2 - 0.5, 0.45)]
    k.prism(prof, wb + 0.0, "paint")
    # slab-sided upper hull over the tracks
    k.box((W - 0.5, L - 2.1, zr - top - 0.03), (0, -0.25, (zr + top + 0.03) / 2), "paint")
    fenders(k, L - 0.2, W, tw + 0.02, top + 0.04, flaps=True)
    for s in (-1, 1):
        k.box((0.36, 0.95, 0.24), (s * (W / 2 - 0.22), 0.6, top + 0.18), "paint")         # fender stowage boxes
        k.box((0.36, 0.8, 0.24), (s * (W / 2 - 0.22), -1.3, top + 0.18), "paint")
        k.grille((0.45, 0.95), (s * 0.85, -L / 2 + 2.0, zr), "paint")
        k.cyl(0.08, 0.3, (s * 0.55, -L / 2 + 2.05, zr + 0.1), "rust", axis="Y", seg=8)
    k.hatch((0.8, 0.9), (0, -L / 2 + 2.0, zr), "paint", open_deg=55 if ko else 0, hinge="front")
    k.cyl(0.32, 0.05, (0, -L / 2 + 1.05, zr - 0.02), "paint", axis="Z", seg=12)
    k.grille((1.7, 0.3), (0, -L / 2 + 0.62, zr - 0.2), "paint")
    k.hatch((0.5, 0.5), (0.3, L / 2 - 1.95, zr), "paint", open_deg=95 if ko else 0, hinge="rear", round_seg=10)
    k.box((0.3, 0.06, 0.14), (0, L / 2 - 1.5, zr - 0.2), "gunmetal")
    k.cyl(0.12, 0.1, (-0.55, L / 2 - 1.5, zr - 0.22), "paint", axis="Y", seg=8)
    spare_track(k, (0, L / 2 - 0.85, 1.22), 3, rot=(-12, 0, 0), link=(0.3, 0.36, 0.06))
    k.cyl(0.03, 2.6, (W / 2 - 0.55, -0.4, zr + 0.03), "steel", axis="Y", seg=6)
    return (0.0, 0.75), zr


def kv1_turret(k, d, ko, zr, proxy):
    w, l, h = 2.15, 2.75, 0.85
    fp = rounded_fp(w, l, 0.55, seg=3, cy=-0.25, r_front=0.3)
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.9, 0.93), shift=(0, -0.03), centre=(0, -0.25))
    k.hatch((0.6, 0.6), (0, -0.55, zr + h), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=12)
    k.hatch((0.22, 0.22), (0.55, 0.45, zr + h), "paint", round_seg=8)
    k.hatch((0.22, 0.22), (-0.55, 0.45, zr + h), "paint", round_seg=8)
    k.star(0.42, (0, 0.32, zr + h + 0.005))
    k.cyl(0.12, 0.2, (0, -l / 2 - 0.22, zr + 0.5), "paint", axis="Y", seg=8)            # rear MG ball
    if proxy:
        return
    k.box((1.0, 0.4, 0.6), (0, l / 2 - 0.3, zr + 0.42), "paint", top=(0.85, 0.8))
    k.cyl(0.3, 0.75, (0, l / 2 + 0.0, zr + 0.42), "paint", axis="X", seg=10)
    barrel(k, l / 2 - 0.05, 2.35, 0.085, zr + 0.42, sleeve=(0.7, 0.14))


def is2(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.63, 0.98
    gear(k, L - 0.05, W, tw, top, 6, 0.27, rs=0.34, ri=0.3, zs=0.68, zi=0.58, tyre=False, rollers=3)
    zr = 1.55
    wb = W - 2 * tw + 0.06
    prof = [(-L / 2 + 0.5, 0.45), (-L / 2 + 0.02, 0.95), (-L / 2 + 0.8, zr - 0.05), (L / 2 - 2.2, zr), (L / 2 - 0.35, 1.0), (L / 2 - 0.05, 0.8),
            (L / 2 - 0.5, 0.45)]
    k.prism(prof, wb, "paint")
    # upper hull: widens over the tracks around the turret ring, narrows to the nose
    fp = [(-W / 2 + 0.1, -L / 2 + 0.75), (W / 2 - 0.1, -L / 2 + 0.75), (W / 2 - 0.1, L / 2 - 2.3), (wb / 2, L / 2 - 1.2), (-wb / 2, L / 2 - 1.2),
          (-W / 2 + 0.1, L / 2 - 2.3)]
    k.extrude(fp, top + 0.03, zr, "paint", scale=(0.86, 0.9), shift=(0, -0.25), centre=(0, 0))
    fenders(k, L - 0.25, W, tw + 0.02, top + 0.03, flaps=True)
    k.box((0.42, 0.1, 0.16), (0, L / 2 - 2.05, zr - 0.05), "paint")                      # driver's visor plug
    for s in (-1, 1):
        k.cyl(0.2, 1.1, (s * (W / 2 - 0.27), -L / 2 + 1.6, top + 0.34), "paint", axis="Y", seg=10)   # fuel drums
        k.cyl(0.2, 1.1, (s * (W / 2 - 0.27), -L / 2 + 2.85, top + 0.34), "paint", axis="Y", seg=10)
        k.grille((0.5, 0.8), (s * 0.8, -L / 2 + 1.75, zr - 0.02), "paint")
        k.cyl(0.1, 0.35, (s * 0.95, -L / 2 + 2.45, zr + 0.06), "rust", axis="Y", seg=8)
        k.box((0.3, 0.7, 0.18), (s * (W / 2 - 0.25), 0.9, top + 0.14), "paint")
    k.hatch((0.75, 0.85), (0, -L / 2 + 1.9, zr), "paint", open_deg=55 if ko else 0, hinge="front")
    k.grille((1.6, 0.4), (0, -L / 2 + 1.0, zr - 0.12), "paint")
    spare_track(k, (0, L / 2 - 0.62, 1.12), 4, rot=(-24, 0, 0), link=(0.26, 0.34, 0.06))
    k.cyl(0.03, 2.4, (W / 2 - 0.62, 0.0, zr - 0.05), "steel", axis="Y", seg=6)
    return (0.0, 0.85), zr


def is2_turret(k, d, ko, zr, proxy, gun="122"):
    w, l, h = 2.2, 3.0, 0.8
    fp = rounded_fp(w, l, 0.9, seg=5, cy=-0.35, r_front=0.7)
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.78, 0.86), shift=(0, -0.02), smooth=True, centre=(0, -0.35))
    cupola(k, -0.48, -0.5, zr + h - 0.03, 0.42, 0.24, ko, hinge="front")
    k.hatch((0.5, 0.5), (0.45, -0.6, zr + h - 0.01), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=12)
    k.cyl(0.13, 0.08, (0.2, 0.35, zr + h), "paint", axis="Z", seg=8)
    k.star(0.42, (0, 0.45, zr + h + 0.045))
    k.cyl(0.1, 0.25, (0.35, -l / 2 - 0.4, zr + 0.5), "paint", axis="Y", seg=8)           # rear MG
    if proxy:
        return
    k.cyl(0.4, 1.15, (0, l / 2 - 0.62, zr + 0.4), "paint", axis="X", seg=12)
    k.box((1.0, 0.5, 0.62), (0, l / 2 - 0.45, zr + 0.4), "paint", top=(0.8, 0.8))
    if gun == "85":         # IS-1 / IS-85: D-5T, no muzzle brake
        barrel(k, l / 2 - 0.3, 4.35, 0.08, zr + 0.4, sleeve=(1.0, 0.16))
    else:
        barrel(k, l / 2 - 0.3, 5.1, 0.11, zr + 0.4, sleeve=(1.3, 0.2), brake=(0.62, 0.22), taper=0.9)


def t26(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.27, 0.78
    gear(k, L - 0.05, W, tw, top, 8, 0.15, rs=0.3, ri=0.24, zs=0.52, zi=0.42, rollers=4)
    wb = W - 2 * tw + 0.02
    zd = 1.05
    prof = [(-L / 2 + 0.3, 0.38), (-L / 2 + 0.05, 0.85), (-L / 2 + 0.1, zd + 0.12), (-0.2, zd + 0.12), (-0.2, zd), (L / 2 - 1.05, zd), (L / 2 - 0.3, 0.8),
            (L / 2 - 0.05, 0.62), (L / 2 - 0.35, 0.38)]
    k.prism(prof, wb, "paint")
    fenders(k, L - 0.35, W, tw + 0.2, top + 0.05, flaps=True, thick=0.025)
    # turret box (superstructure) over the hull centre
    zr = 1.5
    k.box((wb + 0.35, 1.55, zr - zd), (0, 0.45, (zr + zd) / 2), "paint", top=(0.97, 0.97))
    k.box((0.55, 0.5, 0.04), (0.42, 1.28, 1.25), "paint", rot=(-38 - (50 if ko else 0), 0, 0))   # driver's flap
    # engine deck: big air outlet cowl at the rear
    k.grille((1.0, 0.8), (0, -L / 2 + 1.35, zd + 0.12), "paint")
    k.box((1.1, 0.5, 0.18), (0, -L / 2 + 0.5, zd + 0.2), "paint", top=(0.9, 0.8))
    k.cyl(0.09, 1.0, (0, -L / 2 + 0.05, 0.95), "rust", axis="X", seg=8)
    tools(k, -(W / 2 - 0.2), -0.6, top + 0.07, 0.9, -1)
    k.box((0.25, 0.5, 0.15), (W / 2 - 0.22, -0.8, top + 0.13), "paint")
    return (0.0, 0.42), zr


def t26_turret(k, d, ko, zr, proxy):
    # cylindrical turret with a rear bustle (model 1933), leaning sides on later ones
    k.extrude(ellipse_fp(1.3, 1.3, 14), zr + 0.02, zr + 0.62, "paint", scale=(0.9, 0.9), smooth=True, centre=(0, 0))
    k.box((0.95, 0.75, 0.5), (0, -0.78, zr + 0.36), "paint", top=(0.92, 0.95))
    for s in (-1, 1):
        k.hatch((0.42, 0.5), (s * 0.26, -0.25, zr + 0.62), "paint", open_deg=95 if ko else 0, hinge="front")
    k.star(0.36, (0, 0.12, zr + 0.62 + 0.045))
    if proxy:
        return
    k.box((0.62, 0.22, 0.42), (0, 0.62, zr + 0.34), "paint")
    barrel(k, 0.65, 1.55, 0.045, zr + 0.34, sleeve=(0.4, 0.085))


def bt7(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.27, 0.95
    gear(k, L - 0.35, W, tw, top, 4, 0.41, cy=-0.12, rs=0.3, ri=0.28, zs=0.6, zi=0.55)
    wb = W - 2 * tw - 0.06
    zr = 1.32
    # long narrow hull whose nose tapers to a point in plan
    fp = [(-wb / 2, -L / 2 + 0.2), (wb / 2, -L / 2 + 0.2), (wb / 2, L / 2 - 1.35), (0.25, L / 2 - 0.02), (-0.25, L / 2 - 0.02), (-wb / 2, L / 2 - 1.35)]
    k.extrude(fp, 0.4, 1.0, "paint", centre=(0, 0))
    fp2 = [(-wb / 2, -L / 2 + 0.2), (wb / 2, -L / 2 + 0.2), (wb / 2, L / 2 - 1.5), (0.4, L / 2 - 0.9), (-0.4, L / 2 - 0.9), (-wb / 2, L / 2 - 1.5)]
    k.extrude(fp2, 1.0, zr, "paint", scale=(1.0, 1.0), centre=(0, 0))
    k.prism([(L / 2 - 0.9, zr), (L / 2 - 0.05, 1.0), (L / 2 - 0.9, 1.0)], 0.8, "paint", width2=[0.8, 0.5, 0.8])
    fenders(k, L - 1.2, W, tw + 0.16, top + 0.04, cy=-0.35, flaps=True, thick=0.025)
    k.box((0.5, 0.5, 0.04), (0, L / 2 - 1.15, zr + 0.0), "paint", rot=(-(60 if ko else 0), 0, 0))     # driver's hatch
    # engine deck: large mesh air cleaner + long exhaust muffler box at the rear
    k.grille((1.0, 1.0), (0, -L / 2 + 1.75, zr), "paint")
    k.cyl(0.2, 0.12, (0, -L / 2 + 1.75, zr + 0.1), "paint", axis="Z", seg=10)
    k.grille((1.1, 0.55), (0, -L / 2 + 0.75, zr), "paint")
    for s in (-1, 1):
        k.cyl(0.085, 0.7, (s * 0.3, -L / 2 + 0.15, 1.2), "rust", axis="Y", seg=8)
        k.box((0.3, 0.9, 0.14), (s * (W / 2 - 0.22), -0.9, top + 0.13), "paint")
    tools(k, W / 2 - 0.2, 0.4, top + 0.06, 0.9, 1)
    return (0.0, 0.62), zr


def bt7_turret(k, d, ko, zr, proxy):
    # conical turret, elliptical in plan with a bustle
    k.extrude(ellipse_fp(1.4, 1.85, 16, cy=-0.2), zr + 0.02, zr + 0.6, "paint", scale=(0.68, 0.74), shift=(0, -0.02), smooth=True, centre=(0, -0.2))
    for s in (-1, 1):
        k.hatch((0.4, 0.46), (s * 0.24, -0.3, zr + 0.6), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=10)
    k.star(0.36, (0, 0.12, zr + 0.6 + 0.045))
    if proxy:
        return
    k.box((0.6, 0.25, 0.4), (0, 0.62, zr + 0.32), "paint", top=(0.85, 0.8))
    barrel(k, 0.65, 1.6, 0.045, zr + 0.32, sleeve=(0.4, 0.085))


def t70_hull(k, d, ko, n=5, su76=False):
    L, W = d["L"], d["W"]
    tw, top = 0.3, 0.78
    gear(k, L - 0.05, W, tw, top, n, 0.24 if not su76 else 0.22, rs=0.28, ri=0.24, zs=0.52, zi=0.45, rollers=3)
    wb = W - 2 * tw + 0.02
    zr = 1.2
    prof = [(-L / 2 + 0.3, 0.36), (-L / 2 + 0.03, 0.85), (-L / 2 + 0.2, zr), (L / 2 - 1.35, zr), (L / 2 - 0.25, 0.78), (L / 2 - 0.05, 0.62),
            (L / 2 - 0.35, 0.36)]
    k.prism(prof, wb, "paint")
    fenders(k, L - 0.3, W, tw + 0.14, top + 0.04, flaps=True, thick=0.025)
    sl = math.degrees(math.atan2(zr - 0.78, 1.1))
    k.box((0.5, 0.55, 0.05), (-0.3 if not su76 else -0.35, L / 2 - 0.85, 1.02), "paint", rot=(-sl - (55 if ko else 0), 0, 0))
    return zr, wb, top


def t70(k, d, ko):
    L, W = d["L"], d["W"]
    zr, wb, top = t70_hull(k, d, ko)
    # engines down the right side: long grille and exhaust; turret offset left
    k.grille((0.5, 1.5), (0.5, -0.1, zr), "paint")
    k.grille((1.2, 0.6), (0, -L / 2 + 0.6, zr), "paint")
    k.cyl(0.07, 0.9, (W / 2 - 0.42, -L / 2 + 0.9, top + 0.22), "rust", axis="Y", seg=8)
    k.box((0.26, 0.6, 0.16), (-(W / 2 - 0.2), -0.9, top + 0.12), "paint")
    tools(k, W / 2 - 0.18, 0.5, top + 0.06, 0.8, 1)
    return (-0.28, 0.05), zr


def t70_turret(k, d, ko, zr, proxy):
    # small faceted (welded octagonal) cone
    fp = [(-0.35, -0.72), (0.35, -0.72), (0.62, -0.3), (0.62, 0.22), (0.35, 0.6), (-0.35, 0.6), (-0.62, 0.22), (-0.62, -0.3)]
    k.extrude(fp, zr + 0.02, zr + 0.55, "paint", scale=(0.68, 0.75), shift=(0, -0.03), centre=(0, -0.06))
    k.hatch((0.5, 0.5), (0, -0.2, zr + 0.55), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=10)
    k.star(0.32, (0, 0.18, zr + 0.55 + 0.005))
    if proxy:
        return
    k.box((0.6, 0.3, 0.36), (0, 0.55, zr + 0.28), "paint", top=(0.85, 0.7))
    barrel(k, 0.6, 1.5, 0.045, zr + 0.28, sleeve=(0.35, 0.08))


def su76(k, d, ko):
    L, W = d["L"], d["W"]
    zr, wb, top = t70_hull(k, d, ko, n=6, su76=True)
    k.grille((0.5, 1.0), (0.55, 0.55, zr), "paint")
    k.star(0.34, (-0.5, 0.8, zr + 0.005))
    k.cyl(0.07, 0.8, (W / 2 - 0.4, 0.4, top + 0.2), "rust", axis="Y", seg=8)
    # open-topped rear casemate: floor, front plate, leaning sides, low rear
    y0, y1 = -L / 2 + 0.02, 0.0
    cy = (y0 + y1) / 2
    h = 0.95
    zc = zr + h / 2
    k.box((W - 0.5, y1 - y0, 0.04), (0, cy, zr + 0.02), "gunmetal")
    k.box((W - 0.6, y1 - y0 - 0.15, 0.02), (0, cy, zr + 0.06), "floor")
    k.box((W - 0.45, 0.04, h + 0.1), (0, y1 + 0.12, zc + 0.02), "paint", rot=(-22, 0, 0))
    for s in (-1, 1):
        k.box((0.035, y1 - y0 + 0.05, h), (s * (W / 2 - 0.3), cy, zc), "paint", rot=(0, s * -11, 0))
        k.box((0.3, 0.9, 0.35), (s * (W / 2 - 0.55), cy - 0.5, zr + 0.2), "gunmetal")     # ammo bins
    k.box((W - 0.55, 0.035, h * 0.6), (0, y0 + 0.02, zr + h * 0.3), "paint", rot=(8, 0, 0))
    # ZiS-3: breech in the bay, recoil cradle + mantlet through the front plate, left of centre
    gx, gz = -0.12, zr + 0.62
    k.box((0.28, 0.7, 0.28), (gx, -0.6, gz), "gunmetal")
    k.box((0.7, 0.35, 0.5), (gx, 0.32, gz), "paint", top=(0.8, 0.7))
    k.box((0.24, 1.1, 0.2), (gx, 0.85, gz - 0.12), "paint")
    barrel(k, 0.2, 2.75, 0.07, gz, x=gx, brake=(0.36, 0.125))
    return None, zr


# ============================================================== 2026-09-25 additions
# ---------------------------------------------------------------- German
def tiger2(k, d, ko):
    """Tiger II: Panther-like sloped hull, bigger; nine overlapping road wheels a side."""
    L, W = d["L"], d["W"]
    tw, top = 0.8, 1.2
    gear(k, L, W, tw, top, 9, 0.4, interleave=True, rs=0.45, ri=0.36, zs=0.85, zi=0.6)
    zr = 2.02
    wb = W - 2 * tw + 0.08
    prof = [(-L / 2 + 0.55, 0.5), (-L / 2 + 0.1, zr - 0.05), (L / 2 - 1.9, zr), (L / 2 - 0.2, 1.0), (L / 2 - 0.8, 0.5)]
    k.prism(prof, wb, "paint")
    fp = [(-W / 2, -L / 2 + 0.25), (W / 2, -L / 2 + 0.25), (W / 2, L / 2 - 1.35), (-W / 2, L / 2 - 1.35)]
    k.extrude(fp, top + 0.02, zr, "paint", scale=(0.8, 1.0), centre=(0, (-L / 2 + 0.25 + L / 2 - 1.35) / 2))
    k.prism([(L / 2 - 1.9, zr), (L / 2 - 0.3, top + 0.02), (L / 2 - 1.9, top + 0.02)], W, "paint", width2=[W * 0.8, W, W])
    for s in (-1, 1):
        k.box((tw * 0.9, 0.7, 0.03), (s * (W / 2 - tw / 2), L / 2 - 0.25, top + 0.02), "paint", rot=(-20, 0, 0))
        k.hatch((0.5, 0.58), (s * 0.82, L / 2 - 2.35, zr), "paint", open_deg=90 if ko else 0, hinge="left" if s < 0 else "right")
        k.cyl(0.38, 0.06, (s * 1.02, -L / 2 + 1.15, zr + 0.03), "paint", axis="Z", seg=14)      # fan housings
        k.cyl(0.3, 0.02, (s * 1.02, -L / 2 + 1.15, zr + 0.07), "grille", axis="Z", seg=14)
        k.grille((0.75, 0.45), (s * 1.02, -L / 2 + 1.9, zr), "paint")
        k.grille((0.75, 0.42), (s * 1.02, -L / 2 + 0.5, zr), "paint")
        k.cyl(0.09, 0.8, (s * 0.38, -L / 2 + 0.05, 1.6), "rust", axis="Z", seg=8, rot=(-12, 0, 0))
        tools(k, s * (W / 2 - 0.35), 0.2, top + 0.45, 1.4, s)
        k.cyl(0.03, 2.6, (s * (W / 2 - 0.22), -0.6, top + 0.5), "steel", axis="Y", seg=6)   # tow cables
    k.hatch((1.0, 1.25), (0, -L / 2 + 1.2, zr), "paint", open_deg=50 if ko else 0, hinge="left")
    k.cyl(0.12, 0.12, (0.85, L / 2 - 1.2, 1.55), "paint", axis="Y", seg=10, rot=(-90 + 40, 0, 0))   # ball MG
    k.cross(0.5, (W / 2 * 0.9 + 0.01, -0.3, (zr + top) / 2), rot=(90 - 25, 0, 90))
    k.cross(0.5, (-W / 2 * 0.9 - 0.01, -0.3, (zr + top) / 2), rot=(90 - 25, 0, -90))
    return (0.0, 0.2), zr


def tiger2_turret(k, d, ko, zr, proxy):
    """Henschel turret: narrow sloped face, flat sides flaring back to a long overhanging bustle."""
    w, h = 2.75, 0.82
    fp = [(-0.72, 1.2), (0.72, 1.2), (w / 2, 0.35), (w / 2 - 0.05, -1.6), (w / 2 - 0.25, -1.95), (-w / 2 + 0.25, -1.95),
          (-w / 2 + 0.05, -1.6), (-w / 2, 0.35)]
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.84, 0.92), shift=(0, -0.2), centre=(0, -0.3))
    cupola(k, -0.55, -0.55, zr + h - 0.02, 0.38, 0.24, ko)
    k.hatch((0.5, 0.6), (0.55, -0.4, zr + h), "paint", open_deg=90 if ko else 0, hinge="rear")
    k.hatch((0.28, 0.28), (0.0, 0.3, zr + h), "paint", round_seg=10)
    k.hatch((0.55, 0.3), (0, -1.75, zr + 0.4), "paint")
    if proxy:
        return
    k.cyl(0.36, 0.7, (0, 1.35, zr + 0.42), "paint", axis="Y", seg=12, r2=0.26)            # Saukopf mantlet
    barrel(k, 1.6, 5.0, 0.085, zr + 0.42, sleeve=(1.1, 0.15), brake=(0.45, 0.15))


def hetzer(k, d, ko):
    """Jagdpanzer 38(t): low wedge on the widened 38(t) running gear, gun right of centre."""
    L, W = d["L"], d["W"]
    tw, top = 0.35, 0.72
    gear(k, L - 0.05, W, tw, top, 4, 0.39, rs=0.3, ri=0.28, zs=0.5, zi=0.5, rollers=1)
    zc = 1.82
    k.prism([(-L / 2 + 0.3, 0.38), (-L / 2 + 0.05, 0.8), (L / 2 - 0.05, 0.8), (L / 2 - 0.35, 0.38)], W - 2 * tw + 0.06, "paint")
    fp = rounded_fp(W - 0.02, L - 0.12, 0.08, seg=1)
    k.extrude(fp, 0.8, zc, "paint", scale=(0.66, 0.62), shift=(0, -0.62), centre=(0, 0))
    y0, y1 = -L / 2 + 0.55, L / 2 - 1.55                                                  # roof extent
    k.hatch((0.5, 0.62), (-0.35, -0.55, zc), "paint", open_deg=95 if ko else 0, hinge="left")
    k.hatch((0.48, 0.5), (0.3, -0.2, zc), "paint", open_deg=90 if ko else 0, hinge="right")
    k.grille((1.0, 0.55), (0, y0 + 0.2, zc), "paint")
    # remote-controlled MG with its little shield on the roof
    k.box((0.28, 0.03, 0.2), (-0.35, 0.25, zc + 0.14), "paint", rot=(-20, 0, 0))
    k.tube((-0.35, 0.05, zc + 0.12), (-0.35, 0.8, zc + 0.12), 0.022, "gunmetal", seg=6)
    # gun: cast Saukopf mantlet on the glacis, right of centre
    gx, gz = 0.38, 1.28
    k.cyl(0.3, 0.55, (gx, L / 2 - 0.95, gz), "paint", axis="Y", seg=12, r2=0.18, rot=(-90 + 10, 0, 0))
    barrel(k, L / 2 - 0.7, 2.35, 0.07, gz, x=gx, sleeve=(0.4, 0.12))
    k.cyl(0.16, 1.3, (0, -L / 2 - 0.05, 0.95), "rust", axis="X", seg=10)                   # muffler
    for s in (-1, 1):
        k.box((0.28, L - 1.2, 0.03), (s * (W / 2 - 0.14), -0.2, top + 0.05), "paint")         # fenders
        k.box((0.02, L - 1.5, 0.32), (s * (W / 2 + 0.02), -0.3, 0.72), "paint")              # side skirts
    tools(k, W / 2 - 0.2, -0.4, top + 0.1, 1.1, 1)
    k.cross(0.36, (W / 2 * 0.72 + 0.03, -0.4, 1.3), rot=(90 - 40, 0, 90))
    k.cross(0.36, (-W / 2 * 0.72 - 0.03, -0.4, 1.3), rot=(90 - 40, 0, -90))
    return None, zc


def sdkfz251_rocket(k, d, ko):
    """SdKfz 251/1 with Wurfrahmen 40: three launch frames a side, each with a crated 28/32 cm rocket."""
    out = sdkfz251(k, d, ko)
    L, W = d["L"], d["W"]
    cyb = (-L / 2 + 0.05 + L / 2 - 2.0) / 2
    for s in (-1, 1):
        for i, y in enumerate((cyb - 0.85, cyb, cyb + 0.85)):
            x = s * (W / 2 + 0.12)
            k.box((0.06, 0.7, 0.05), (x, y, 1.25), "steel")                                   # frame rail
            k.box((0.36, 0.7, 0.3), (x, y, 1.42), "wood", rot=(18, 0, 0))                     # crate
            if not ko or i != 1:
                k.cyl(0.15, 0.36, (x, y + 0.48, 1.52), "paint2", axis="Y", seg=10, rot=(-90 + 18, 0, 0))   # warhead
    return out


def kubelwagen(k, d, ko):
    """VW Type 82: flat-panelled open body, bonnet sloping to the nose, spare wheel on the bonnet."""
    L, W = d["L"], d["W"]
    wr, ww = 0.34, 0.18
    yf, yr = L / 2 - 0.62, -L / 2 + 0.62
    for s in (-1, 1):
        for y in (yf, yr):
            k.cyl(wr, ww, (s * (W / 2 - ww / 2 - 0.02), y, wr), "rubber", axis="X", seg=14)
            k.cyl(wr * 0.55, ww + 0.02, (s * (W / 2 - ww / 2 - 0.02), y, wr), "paint", axis="X", seg=10)
            # mudguard: curved plate over the wheel
            k.box((ww + 0.1, 0.62, 0.03), (s * (W / 2 - ww / 2 - 0.02), y, 2 * wr + 0.1), "paint2")
            k.box((ww + 0.1, 0.3, 0.03), (s * (W / 2 - ww / 2 - 0.02), y + 0.4, 2 * wr - 0.02), "paint2", rot=(-40, 0, 0))
            k.box((ww + 0.1, 0.3, 0.03), (s * (W / 2 - ww / 2 - 0.02), y - 0.4, 2 * wr - 0.02), "paint2", rot=(40, 0, 0))
    bw = W - 0.42
    zb = 0.98
    # body: slab sides, bonnet sloping down to the nose, rear engine deck
    prof = [(-L / 2 + 0.05, 0.4), (-L / 2, 0.85), (-L / 2 + 0.3, zb), (L / 2 - 1.05, zb), (L / 2 - 0.05, 0.78), (L / 2, 0.45)]
    k.prism(prof, bw, "paint")
    # open cabin: dark well with two bench seats, windscreen frame, steering wheel
    cy0, cy1 = -L / 2 + 0.55, L / 2 - 1.1
    k.box((bw - 0.12, cy1 - cy0, 0.02), (0, (cy0 + cy1) / 2, zb + 0.005), "floor")
    for y in (cy1 - 0.45, cy0 + 0.35):
        k.box((bw - 0.25, 0.4, 0.08), (0, y, zb + 0.05), "canvas")
        k.box((bw - 0.25, 0.08, 0.35), (0, y - 0.22, zb + 0.18), "canvas")
    k.box((bw + 0.02, 0.04, 0.34), (0, cy1 + 0.02, zb + 0.16), "steel", rot=(-15, 0, 0))    # windscreen frame
    k.cyl(0.17, 0.03, (-0.28, cy1 - 0.2, zb + 0.3), "black", axis="Y", seg=10, rot=(-90 + 50, 0, 0))
    k.cyl(0.14, bw - 0.1, (0, -L / 2 + 0.38, zb + 0.1), "canvas", axis="X", seg=10)         # folded hood
    k.cyl(0.28, 0.14, (0, L / 2 - 0.62, 0.95), "rubber", axis="Z", seg=14, rot=(-13, 0, 0))   # spare wheel
    k.cyl(0.15, 0.16, (0, L / 2 - 0.62, 0.95), "paint2", axis="Z", seg=10, rot=(-13, 0, 0))
    k.box((0.12, 0.3, 0.4), (-(bw / 2 + 0.07), cy0 + 0.3, zb - 0.15), "paint2")             # jerrycan
    for s in (-1, 1):
        k.cyl(0.07, 0.06, (s * 0.42, L / 2 - 0.05, 0.72), "gunmetal", axis="Y", seg=8)       # headlamps
    return None, zb


def kettenkrad(k, d, ko):
    """SdKfz 2 Kettenkrad: motorcycle front end, tracked rear with a rear-facing bench.  Drawn at its
    real 1 m width (the def's 1.6 m includes clearance)."""
    L = d["L"]
    W = 1.05
    tw, top = 0.2, 0.6
    Lt = 1.95
    cyt = -L / 2 + Lt / 2 + 0.05
    gear(k, Lt, W, tw, top, 4, 0.22, cy=cyt, interleave=True, rs=0.2, ri=0.2, zs=0.4, zi=0.38)
    for s in (-1, 1):
        k.box((tw + 0.08, Lt - 0.05, 0.03), (s * (W / 2 - tw / 2), cyt, top + 0.05), "paint")       # track guards
    # front wheel, fork and handlebar
    yf = L / 2 - 0.35
    k.cyl(0.3, 0.1, (0, yf, 0.3), "rubber", axis="X", seg=14)
    k.box((0.16, 0.55, 0.03), (0, yf, 0.66), "paint2", rot=(-8, 0, 0))                          # mudguard
    k.tube((0, yf, 0.3), (0, yf - 0.35, 0.95), 0.03, "steel", seg=6)
    k.tube((-0.36, yf - 0.4, 1.0), (0.36, yf - 0.4, 1.0), 0.02, "black", seg=6)
    # body: engine cowling tapering to the nose, driver's saddle, rear bench over the tracks
    prof = [(-L / 2 + 0.05, 0.35), (-L / 2 + 0.05, 0.72), (yf - 0.55, 0.78), (yf - 0.3, 0.62), (yf - 0.4, 0.35)]
    k.prism(prof, W - 2 * tw - 0.04, "paint", width2=[W - 0.45, W - 0.45, W - 0.45, 0.3, 0.3])
    k.box((0.32, 0.45, 0.14), (0, yf - 0.85, 0.85), "leather")                                  # saddle
    k.box((W - 0.2, 0.42, 0.08), (0, -L / 2 + 0.45, 0.82), "canvas")                           # rear bench
    k.box((W - 0.2, 0.06, 0.3), (0, -L / 2 + 0.7, 0.95), "canvas")
    k.grille((0.4, 0.4), (0, yf - 1.35, 0.72), "paint")
    k.box((0.3, 0.15, 0.2), (0.3, -L / 2 + 0.05, 0.7), "paint2")                                # tool box
    return None, 0.8


# ---------------------------------------------------------------- Soviet
def ot34(k, d, ko):
    zr = t34_hull(k, d, ko, flame=True)
    return (0.0, 0.62), zr


def is1(k, d, ko):
    return is2(k, d, ko)


def is3(k, d, ko):
    """IS-3: 'pike nose' of two plates meeting at a ridge, low wide hull with the side shelves."""
    L, W = d["L"], d["W"]
    tw, top = 0.63, 0.98
    gear(k, L - 0.05, W, tw, top, 6, 0.27, rs=0.34, ri=0.3, zs=0.68, zi=0.58, tyre=False, rollers=3)
    zr = 1.5
    wb = W - 2 * tw + 0.06
    k.prism([(-L / 2 + 0.5, 0.45), (-L / 2 + 0.02, 0.95), (-L / 2 + 0.6, zr), (L / 2 - 1.9, zr), (L / 2 - 0.3, 0.85), (L / 2 - 0.6, 0.45)], wb, "paint")
    # upper hull: sloped side shelves over the tracks, plan narrows into the pike
    fp = [(-W / 2, -L / 2 + 0.6), (W / 2, -L / 2 + 0.6), (W / 2, L / 2 - 2.2), (0.55, L / 2 - 0.1), (-0.55, L / 2 - 0.1), (-W / 2, L / 2 - 2.2)]
    k.extrude(fp, top + 0.03, zr, "paint", scale=(0.84, 0.92), shift=(0, -0.3), centre=(0, 0))
    k.prism([(L / 2 - 1.9, zr + 0.02), (L / 2 - 0.35, top + 0.1), (L / 2 - 1.9, top + 0.1)], 0.06, "paint2")   # the ridge
    k.hatch((0.55, 0.5), (0, L / 2 - 2.15, zr), "paint", open_deg=95 if ko else 0, hinge="rear")
    for s in (-1, 1):
        k.grille((0.55, 0.85), (s * 0.78, -L / 2 + 1.7, zr), "paint")
        k.cyl(0.1, 0.35, (s * 0.95, -L / 2 + 0.5, zr + 0.02), "rust", axis="Y", seg=8)
        k.box((0.3, 1.2, 0.2), (s * (W / 2 - 0.2), -0.2, top + 0.14), "paint")                 # side stowage
    k.hatch((0.8, 0.9), (0, -L / 2 + 1.65, zr), "paint", open_deg=55 if ko else 0, hinge="front")
    k.grille((1.4, 0.4), (0, -L / 2 + 0.85, zr - 0.02), "paint")
    k.cyl(0.03, 2.2, (W / 2 - 0.5, -0.8, zr + 0.02), "steel", axis="Y", seg=6)
    return (0.0, 0.55), zr


def is3_turret(k, d, ko, zr, proxy):
    """The flat 'frying pan' dome."""
    w, l = 2.5, 2.95
    fp = ellipse_fp(w, l, 20, cy=-0.25)
    k.extrude(fp, zr + 0.02, zr + 0.34, "paint", scale=(0.9, 0.9), smooth=True, centre=(0, -0.25))
    fp2 = ellipse_fp(w * 0.9, l * 0.9, 20, cy=-0.25)
    k.extrude(fp2, zr + 0.34, zr + 0.62, "paint", scale=(0.62, 0.66), smooth=True, centre=(0, -0.25))
    cupola(k, -0.42, -0.45, zr + 0.58, 0.38, 0.2, ko, hinge="front")
    k.hatch((0.45, 0.45), (0.45, -0.5, zr + 0.6), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=12)
    k.star(0.4, (0.0, 0.3, zr + 0.64))
    if proxy:
        return
    k.cyl(0.3, 0.7, (0, 1.2, zr + 0.36), "paint", axis="Y", seg=12, r2=0.22)
    barrel(k, 1.35, 4.9, 0.11, zr + 0.38, sleeve=(1.2, 0.2), brake=(0.62, 0.22), taper=0.9)


def su152(k, d, ko):
    """SU-152: KV-1S chassis with a big slab casemate; the 152 mm ML-20S in a boxy mantlet."""
    L, W = d["L"], d["W"]
    tw, top = 0.66, 1.0
    gear(k, L - 0.05, W, tw, top, 6, 0.3, rs=0.34, ri=0.33, zs=0.7, zi=0.62, tyre=False, rollers=3)
    zr = 1.55
    wb = W - 2 * tw + 0.06
    k.prism([(-L / 2 + 0.45, 0.45), (-L / 2 + 0.02, 0.95), (-L / 2 + 0.5, zr - 0.12), (-L / 2 + 1.0, zr), (L / 2 - 0.9, zr),
             (L / 2 - 0.45, 1.12), (L / 2 - 0.05, 0.85), (L / 2 - 0.5, 0.45)], wb, "paint")
    fenders(k, L - 0.2, W, tw + 0.02, top + 0.04, flaps=True)
    zc = 2.3
    cy0, cy1 = -0.6, L / 2 - 0.55
    fp = rect_fp(W - 0.45, cy1 - cy0, (cy0 + cy1) / 2)
    k.extrude(fp, top + 0.03, zc, "paint", scale=(0.9, 0.78), shift=(0, -0.3), centre=(0, (cy0 + cy1) / 2))
    k.hatch((0.55, 0.5), (0.55, cy0 + 0.5, zc), "paint", open_deg=95 if ko else 0, hinge="rear", round_seg=12)
    k.hatch((0.5, 0.5), (-0.55, cy0 + 0.5, zc), "paint", open_deg=85 if ko else 0, hinge="rear", round_seg=12)
    k.hatch((0.55, 0.5), (0.0, cy0 + 1.1, zc), "paint")
    k.star(0.42, (-0.1, cy0 + 1.75, zc + 0.045))
    for s in (-1, 1):
        k.box((0.36, 0.9, 0.24), (s * (W / 2 - 0.22), -1.5, top + 0.18), "paint")
        k.grille((0.45, 0.95), (s * 0.85, -L / 2 + 1.3, zr), "paint")
        k.cyl(0.08, 0.3, (s * 0.55, -L / 2 + 1.35, zr + 0.1), "rust", axis="Y", seg=8)
    k.grille((1.7, 0.3), (0, -L / 2 + 0.55, zr - 0.2), "paint")
    k.hatch((0.8, 0.6), (0, -L / 2 + 1.25, zr), "paint", open_deg=55 if ko else 0, hinge="front")
    gx, gz = 0.28, 1.6
    k.box((0.8, 0.55, 0.75), (gx, cy1 + 0.1, gz), "paint", top=(0.85, 0.7))                    # mantlet box
    k.cyl(0.24, 0.9, (gx, cy1 + 0.75, gz), "paint", axis="Y", seg=12, r2=0.2)                  # recoil sleeve
    barrel(k, cy1 + 0.9, 2.0, 0.105, gz, x=gx, brake=(0.5, 0.17), taper=1.0)
    k.cyl(0.03, 2.4, (W / 2 - 0.3, -1.6, top + 0.35), "steel", axis="Y", seg=6)
    return None, zc


def t28(k, d, ko):
    """T-28: long hull, main turret amidships, two small MG turrets flanking the driver's cab,
    small coil-sprung road wheels behind armoured skirts."""
    L, W = d["L"], d["W"]
    tw, top = 0.38, 1.05
    gear(k, L - 0.05, W, tw, top, 12, 0.16, rs=0.33, ri=0.3, zs=0.62, zi=0.55, rollers=4)
    zr = 1.72
    wb = W - 2 * tw + 0.1
    k.prism([(-L / 2 + 0.35, 0.45), (-L / 2 + 0.05, 1.05), (-L / 2 + 0.3, zr - 0.1), (L / 2 - 1.35, zr - 0.1), (L / 2 - 1.3, 1.5),
             (L / 2 - 0.35, 1.3), (L / 2 - 0.05, 0.9), (L / 2 - 0.45, 0.45)], wb + 0.35, "paint")
    for s in (-1, 1):
        k.box((0.03, L - 1.2, 0.55), (s * (W / 2 + 0.01), -0.1, 0.68), "paint")                  # suspension skirt
        k.box((tw + 0.12, L - 0.5, 0.035), (s * (W / 2 - tw / 2 + 0.02), -0.05, top + 0.03), "paint")
    # forward superstructure: driver's cab between the two MG turrets
    k.box((W - 0.25, 1.25, 0.12), (0, L / 2 - 1.45, zr - 0.02), "paint")
    k.box((0.7, 0.55, 0.3), (0, L / 2 - 1.05, zr + 0.1), "paint", top=(0.85, 0.6), shift=(0, -0.08))
    k.hatch((0.45, 0.35), (0, L / 2 - 1.25, zr + 0.25), "paint", open_deg=90 if ko else 0, hinge="rear")
    for s in (-1, 1):
        x, y = s * 0.78, L / 2 - 1.45
        k.cyl(0.42, 0.52, (x, y, zr + 0.3), "paint", axis="Z", seg=14, r2=0.38)
        k.hatch((0.36, 0.36), (x - s * 0.05, y - 0.08, zr + 0.56), "paint", round_seg=10, open_deg=90 if ko else 0, hinge="rear")
        k.tube((x + s * 0.12, y + 0.3, zr + 0.32), (x + s * 0.3, y + 0.85, zr + 0.32), 0.03, "gunmetal", seg=6)
        k.grille((0.4, 1.3), (s * 0.8, -L / 2 + 1.35, zr - 0.1), "paint")
    k.grille((1.1, 0.7), (0, -L / 2 + 1.1, zr - 0.08), "paint")
    k.hatch((0.8, 0.8), (0, -L / 2 + 2.05, zr - 0.1), "paint", open_deg=55 if ko else 0, hinge="front")
    k.cyl(0.09, 0.9, (0, -L / 2 + 0.05, 1.2), "rust", axis="X", seg=8)
    tools(k, -(W / 2 - 0.22), -1.4, top + 0.06, 1.2, -1)
    return (0.0, -0.1), zr - 0.1


def t28_turret(k, d, ko, zr, proxy):
    """Main turret: elliptical, with a rear bustle and the handrail frame aerial."""
    k.extrude(ellipse_fp(1.85, 2.2, 18, cy=0.05), zr + 0.02, zr + 0.8, "paint", scale=(0.94, 0.94), smooth=True, centre=(0, 0.05))
    k.box((1.1, 0.8, 0.62), (0, -1.1, zr + 0.4), "paint", top=(0.95, 0.9))
    for s in (-1, 1):
        k.hatch((0.42, 0.55), (s * 0.3, -0.2, zr + 0.8), "paint", open_deg=95 if ko else 0, hinge="front")
    k.star(0.36, (0, 0.45, zr + 0.845))
    # handrail aerial: a ring of posts and rail around the turret top
    n = 16
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p0 = (1.05 * math.cos(a0), -0.15 + 1.25 * math.sin(a0), zr + 1.02)
        p1 = (1.05 * math.cos(a1), -0.15 + 1.25 * math.sin(a1), zr + 1.02)
        k.tube(p0, p1, 0.015, "steel", seg=4)
        if i % 4 == 0:
            k.tube((p0[0] * 0.85, p0[1] * 0.85, zr + 0.75), p0, 0.014, "steel", seg=4)
    if proxy:
        return
    k.box((0.7, 0.3, 0.45), (0, 1.1, zr + 0.4), "paint", top=(0.85, 0.8))
    barrel(k, 1.2, 1.85, 0.065, zr + 0.4, sleeve=(0.5, 0.11))


def sherman76(k, d, ko):
    """M4A2(76)W: VVSS bogies, straight 47-degree glacis, sponsons over the tracks, rounded rear."""
    L, W = d["L"], d["W"]
    tw, top = 0.42, 0.95
    gear(k, L - 0.3, W, tw, top, 6, 0.27, cy=0.05, rs=0.3, ri=0.3, zs=0.7, zi=0.5, rollers=0)
    for s in (-1, 1):
        for i in range(3):                                                                       # bogie brackets
            y = -L / 2 + 0.95 + i * (L - 2.0) / 2
            k.box((0.18, 0.55, 0.35), (s * (W / 2 - tw - 0.02), y, 0.5), "paint2")
            k.cyl(0.1, tw * 0.7, (s * (W / 2 - tw / 2), y - 0.1, top - 0.1), "rubber", axis="X", seg=8)   # return roller
    zr = 1.85
    wb = W - 2 * tw + 0.06
    k.prism([(-L / 2 + 0.45, 0.45), (-L / 2 + 0.2, 1.0), (-L / 2 + 0.3, zr - 0.05), (L / 2 - 1.55, zr), (L / 2 - 0.15, 0.95), (L / 2 - 0.5, 0.45)], wb, "paint")
    yb0, yb1 = -L / 2 + 0.3, L / 2 - 1.55
    fp = rounded_fp(W - 0.04, yb1 - yb0, 0.3, seg=3, cy=(yb0 + yb1) / 2, r_front=0.02)
    k.extrude(fp, top + 0.02, zr, "paint", centre=(0, (yb0 + yb1) / 2))
    k.prism([(L / 2 - 1.55, zr), (L / 2 - 0.15, top + 0.02), (L / 2 - 1.55, top + 0.02)], W - 0.04, "paint")        # glacis
    for s in (-1, 1):
        k.box((0.55, 0.62, 0.14), (s * 0.55, L / 2 - 1.75, zr + 0.05), "paint", top=(0.9, 0.7))       # driver's hoods
        k.hatch((0.48, 0.52), (s * 0.55, L / 2 - 2.2, zr), "paint", open_deg=90 if ko else 0, hinge="rear", round_seg=0)
        k.cyl(0.06, 0.45, (s * 0.5, -L / 2 + 0.15, 1.35), "rust", axis="Z", seg=8)
        tools(k, s * (W / 2 - 0.2), -0.7, zr, 1.2, s)
    k.cyl(0.12, 0.14, (0.55, L / 2 - 1.0, 1.42), "paint", axis="Y", seg=10, rot=(-90 + 43, 0, 0))   # bow MG ball
    k.grille((1.4, 1.0), (0, -L / 2 + 0.95, zr), "paint")
    k.hatch((0.55, 0.5), (0, -0.55, zr), "paint")
    k.box((W - 0.5, 0.35, 0.3), (0, -L / 2 + 0.05, 1.25), "paint", rot=(20, 0, 0))                     # exhaust deflector
    return (0.0, 0.25), zr


def sherman76_turret(k, d, ko, zr, proxy):
    """T23 turret: rounded, rear bustle, commander's cupola right, loader's hatch left."""
    fp = rounded_fp(1.95, 2.55, 0.8, seg=5, cy=-0.25, r_front=0.55)
    k.extrude(fp, zr + 0.02, zr + 0.78, "paint", scale=(0.86, 0.9), smooth=True, centre=(0, -0.25))
    cupola(k, 0.42, -0.5, zr + 0.74, 0.36, 0.22, ko)
    k.hatch((0.46, 0.46), (-0.45, -0.45, zr + 0.78), "paint", open_deg=95 if ko else 0, hinge="rear", round_seg=12)
    k.star(0.36, (0.0, 0.35, zr + 0.8))
    if proxy:
        return
    k.box((1.05, 0.3, 0.55), (0, 1.0, zr + 0.4), "paint", top=(0.95, 0.85))
    barrel(k, 1.1, 3.95, 0.065, zr + 0.4, sleeve=(0.4, 0.11))
    k.tube((0.3, 1.0, zr + 0.4), (0.3, 1.45, zr + 0.4), 0.022, "gunmetal", seg=6)


def bm13(k, d, ko):
    """BM-13 on the Studebaker US6: bonnet, cab, and the M-13 rail rack over the bed, travelling flat."""
    L, W = d["L"], d["W"]
    wr = 0.45
    yf = L / 2 - 1.05
    for s in (-1, 1):
        k.cyl(wr, 0.26, (s * (W / 2 - 0.18), yf, wr), "rubber", axis="X", seg=16)
        k.cyl(wr * 0.5, 0.28, (s * (W / 2 - 0.18), yf, wr), "paint2", axis="X", seg=10)
        for y in (-L / 2 + 1.25, -L / 2 + 2.3):
            k.cyl(wr, 0.46, (s * (W / 2 - 0.26), y, wr), "rubber", axis="X", seg=16)          # dual wheels
            k.cyl(wr * 0.5, 0.48, (s * (W / 2 - 0.26), y, wr), "paint2", axis="X", seg=10)
        # front wings sweeping into the running boards
        k.box((0.42, 1.1, 0.03), (s * (W / 2 - 0.2), yf + 0.05, 1.02), "paint", rot=(8, 0, 0))
        k.box((0.3, 1.0, 0.03), (s * (W / 2 - 0.15), yf - 1.05, 0.62), "paint")
    k.box((0.15, L - 1.0, 0.25), (0.42, -0.3, 0.72), "gunmetal")                                  # chassis rails
    k.box((0.15, L - 1.0, 0.25), (-0.42, -0.3, 0.72), "gunmetal")
    # bonnet + grille
    k.box((0.95, 1.25, 0.5), (0, L / 2 - 0.75, 1.15), "paint", top=(0.9, 0.95))
    k.box((0.85, 0.05, 0.55), (0, L / 2 - 0.1, 1.1), "grille")
    # cab
    yc = L / 2 - 1.85
    k.box((W - 0.25, 1.0, 1.0), (0, yc, 1.55), "paint", top=(0.95, 0.85), shift=(0, -0.05))
    k.box((W - 0.4, 0.04, 0.35), (0, yc + 0.47, 1.9), "black", rot=(-12, 0, 0))                 # windscreen
    k.star(0.3, (0, yc - 0.05, 2.06))
    # launcher: rack frame on the bed, 8 rails pointing forward over the cab (travelling position)
    y0 = -L / 2 + 0.2
    k.box((W - 0.3, 2.3, 0.2), (0, y0 + 1.15, 0.95), "paint")                                    # bed / base
    k.box((0.9, 0.6, 0.45), (0, y0 + 0.9, 1.25), "paint2")                                      # turntable, gear
    rl = 5.0
    zr0, zr1 = 1.7, 2.15
    for i in range(8):
        x = -0.72 + i * (1.44 / 7)
        k.tube((x, y0 + 0.15, zr0), (x, y0 + 0.15 + rl, zr1), 0.035, "steel", seg=4)
        if i % 2 == 0 or not ko:
            k.tube((x, y0 + 0.7, zr0 + 0.12), (x, y0 + 2.1, zr0 + 0.25), 0.065, "paint2", seg=8)   # rocket on the rail
    for t in (0.1, 0.55, 0.95):
        yy = y0 + 0.15 + rl * t
        k.box((1.6, 0.06, 0.08), (0, yy, zr0 + (zr1 - zr0) * t - 0.05), "gunmetal")                # cross frames
    k.box((0.08, rl, 0.08), (-0.82, y0 + 0.15 + rl / 2, (zr0 + zr1) / 2 - 0.05), "gunmetal", rot=(-math.degrees(math.atan2(zr1 - zr0, rl)), 0, 0))
    k.box((0.08, rl, 0.08), (0.82, y0 + 0.15 + rl / 2, (zr0 + zr1) / 2 - 0.05), "gunmetal", rot=(-math.degrees(math.atan2(zr1 - zr0, rl)), 0, 0))
    k.box((0.7, 0.4, 0.5), (W / 2 - 0.4, y0 + 2.2, 1.1), "paint2")                              # fuel tank / locker
    return None, 1.2



VEHICLES = {
    # id: (hull_fn, turret_fn, base paint, camo, engine-deck soot centre y as a fraction of L)
    "pz3j": (lambda k, d, ko: german_medium(k, d, ko, "pz3j"), lambda k, d, ko, z, p: german_medium_turret(k, d, ko, "pz3j", z, p), GREY, None, -0.3),
    "pz4f1": (lambda k, d, ko: german_medium(k, d, ko, "pz4f1"), lambda k, d, ko, z, p: german_medium_turret(k, d, ko, "pz4f1", z, p), GREY, None, -0.3),
    "pz4gh": (lambda k, d, ko: german_medium(k, d, ko, "pz4gh"), lambda k, d, ko, z, p: (german_medium_turret(k, d, ko, "pz4gh", z, p), pz4_turret_skirt(k, z)), DYEL, CAMO_A, -0.3),
    "stug3g": (stug3g, None, DYEL, CAMO_B, -0.3),
    "panther": (panther, panther_turret, DYEL, CAMO_A, -0.33),
    "tiger": (tiger, tiger_turret, DYEL, CAMO_C, -0.33),
    "sdkfz251": (sdkfz251, None, GREY, None, 0.3),
    "marder3": (marder3, None, DYEL, CAMO_B, -0.35),
    "t26": (t26, t26_turret, SOVG, None, -0.3),
    "bt7": (bt7, bt7_turret, SOVG, None, -0.3),
    "t34_76": (t34_76, t34_76_turret, SOVG, None, -0.3),
    "kv1": (kv1, kv1_turret, SOVG, None, -0.3),
    "t70": (t70, t70_turret, SOVG, None, -0.3),
    "t34_85": (t34_85, t34_85_turret, SOVG, None, -0.3),
    "is2": (is2, is2_turret, SOVG, None, -0.3),
    "su76": (su76, None, SOVG, None, 0.15),
    "su85": (su85, None, SOVG, None, -0.3),
    # 2026-09-25 additions
    "tiger2": (tiger2, tiger2_turret, DYEL, CAMO_A, -0.33),
    "pantherD": (lambda k, d, ko: panther(k, d, ko, "D"), lambda k, d, ko, z, p: panther_turret(k, d, ko, z, p, "D"), DYEL, CAMO_B, -0.33),
    "pantherA": (lambda k, d, ko: panther(k, d, ko, "A"), panther_turret, DYEL, CAMO_A2, -0.33),
    "pz4g": (lambda k, d, ko: german_medium(k, d, ko, "pz4g"), lambda k, d, ko, z, p: german_medium_turret(k, d, ko, "pz4g", z, p), GREY, None, -0.3),
    "stug4": (lambda k, d, ko: stug3g(k, d, ko, pz4=True), None, DYEL, CAMO_A, -0.3),
    "hetzer": (hetzer, None, DYEL, CAMO_C, -0.3),
    "flammpanzer3": (lambda k, d, ko: german_medium(k, dict(d, L=5.6), ko, "flammpanzer3"),
                     lambda k, d, ko, z, p: german_medium_turret(k, d, ko, "flammpanzer3", z, p), DYEL, CAMO_B, -0.3),
    "sdkfz251_rocket": (sdkfz251_rocket, None, DYEL, CAMO_B, 0.3),
    "kubelwagen": (kubelwagen, None, DYEL, None, -0.35),
    "kettenkrad": (kettenkrad, None, DYEL, None, 0.0),
    "is1": (is1, lambda k, d, ko, z, p: is2_turret(k, d, ko, z, p, "85"), SOVG, None, -0.3),
    "is3": (is3, is3_turret, SOVG, None, -0.3),
    "ot34": (ot34, t34_76_turret, SOVG, None, -0.3),
    "su100": (lambda k, d, ko: su85(k, d, ko, "su100"), None, SOVG, None, -0.3),
    "su122": (lambda k, d, ko: su85(k, d, ko, "su122"), None, SOVG, None, -0.3),
    "su152": (su152, None, SOVG, None, -0.33),
    "t28": (t28, t28_turret, SOVG, None, -0.3),
    "sherman76": (sherman76, sherman76_turret, OD, None, -0.33),
    "bm13": (bm13, None, SOVG, None, 0.3),
}
# wheeled vehicles: no track to throw (the game falls back to the ok hull)
NO_TRACK = ("kubelwagen", "bm13")


WASH = "#b4b2a8"          # winter lime wash
WINTER_STATES = ("ok", "trackL", "trackR")   # a burnt-out wreck has lost its wash: winter reuses the summer ko / blown
# the Dunkelgrau 1941 vehicles fought the first winter (Moscow) unwashed: no winter atlas, the game
# draws them grey on the snow
NO_WASH = ("pz3j", "pz4f1", "sdkfz251")


def atlas_name(vid, scale, season="summer"):
    return "vehicles_%s%s_%d" % (vid, "_winter" if season == "winter" else "", scale)


def materials(vid, d, ko, season="summer"):
    base, camo, soot = VEHICLES[vid][2:5]
    mats = {}
    VC.common_materials(mats, burnt=ko)
    mats["thrown"] = VC.track_material("thrown", base="#24221f", dust="#3a352c")
    if ko:
        for nm, g in (("paint", 1.0), ("paint2", 0.8)):
            mats[nm] = VC.paint_material(nm + "_ko", base, camo=camo, scorch=("#2a2622", "#4d3526"),
                                         soot_at=(0.0, soot * d["L"], d["L"] * 0.42), mottle=0.35, gain=g)
    else:
        wash = WASH if season == "winter" else None
        dust = "#6e685c" if season == "winter" else "#8a7d60"
        mats["paint"] = VC.paint_material("paint", base, camo=camo, whitewash=wash, dust=dust)
        mats["paint2"] = VC.paint_material("paint2", base, camo=camo, gain=0.78, whitewash=wash, dust=dust)
    return mats


HULL_STATES = ("ok", "ko", "blown", "trackL", "trackR")     # blown only for turreted vehicles
TURRET_STATES = ("ok", "ko", "blown")


def build(vid, d, state, part, season="summer"):
    """One sprite subject.  hull: ok / ko / blown (burnt, turret ring an open hole) / trackL, trackR
    (intact paint, the vehicle's own left/right track thrown).  turret: ok / ko (askew) / blown (the
    burnt turret lying on the ground, rendered with its own ground shadow)."""
    hull_fn, turret_fn = VEHICLES[vid][0:2]
    ko = state in ("ko", "blown")
    mats = materials(vid, d, ko, season)
    k = Kit(vid + "_hull")
    k.broken = {"trackL": -1, "trackR": 1}.get(state, 0)
    pivot, zr = hull_fn(k, d, ko)
    if part == "hull":
        if turret_fn:
            probe = Kit("probe")
            turret_fn(probe, d, False, zr, True)
            xs = [abs(p[0]) for p in probe.v]
            ys = [abs(p[1]) for p in probe.v if p[1] > 0]
            ztop = max(p[2] for p in probe.v)
            rr = 0.72 * min(max(xs), max(ys))
            if state == "blown":
                k.cyl(rr * 1.1, 0.05, (pivot[0], pivot[1], zr + 0.025), "paint2", axis="Z", seg=20)
                k.cyl(rr * 0.95, 0.02, (pivot[0], pivot[1], zr + 0.055), "hole", axis="Z", seg=20)
            else:
                # turret ring drum: always covered by the turret sprite whatever its facing; gives the
                # hull sprite the turret's short shadow on the deck
                # (it casts no shadow of its own: the turret sprite brings its shadow along)
                drum = Kit(vid + "_drum")
                drum.cyl(rr, (ztop - zr) * 0.6, (pivot[0], pivot[1], zr + (ztop - zr) * 0.3), "paint", axis="Z", seg=20)
                ob = drum.build(mats)
                ob.visible_shadow = False
                return [(k.build(mats), True), (ob, True)], pivot, k
        return [(k.build(mats), True)], pivot, k
    kt = Kit(vid + "_turret")
    if state == "blown":
        kt.xform = Matrix.Translation(Vector((0, 0, -zr + 0.12))) @ \
            Euler((math.radians(-5), math.radians(13), 0), "XYZ").to_matrix().to_4x4()
    else:
        ko_xform(kt, ko)
    turret_fn(kt, d, ko, zr, False)
    return [(kt.build(mats), True)], pivot, kt


def deck_z(vid, d):
    """Height of the turret ring (the hull roof the turret's shadow falls on)."""
    k = Kit("probe_z")
    return VEHICLES[vid][0](k, d, False)[1]


def extent(vid, d):
    """Generous half-size (m) of the render cell: horizontal reach + shadow length + margin."""
    import bpy  # noqa: F401
    hull_fn, turret_fn = VEHICLES[vid][0:2]
    k = Kit("probe")
    k.broken = 1
    pivot, zr = hull_fn(k, d, False)
    r, h = k.bounds()
    if turret_fn:
        kt = Kit("probe_t")
        turret_fn(kt, d, False, zr, False)
        rt, ht = kt.bounds()
        r, h = max(r, rt + 0.1), max(h, ht)
    return r + h * 1.0 + 0.4, pivot


def render_vehicle(vid, d, scale, args, log):
    ppm = 10 * scale
    half, pivot = extent(vid, d)
    cell = int(math.ceil(half * ppm)) * 2
    anchor = (cell // 2, cell // 2)
    entries = {}
    turreted = bool(VEHICLES[vid][1])
    todo = [("hull", st) for st in HULL_STATES if (turreted or st != "blown") and not (vid in NO_TRACK and st.startswith("track"))]
    if turreted:
        todo += [("turret", st) for st in TURRET_STATES]
    if args.season == "winter":
        todo = [(p, st) for (p, st) in todo if st in WINTER_STATES]
    if args.states:
        todo = [(p, st) for (p, st) in todo if st in args.states.split(",")]
    cdir = os.path.join(os.environ.get("VEH_OUT") or os.path.join(VC.ROOT, "tools", "blender"), ".cache",
                        "vehicles_%s%d" % ("winter_" if args.season == "winter" else "", scale))
    os.makedirs(cdir, exist_ok=True)
    for part, st in todo:
        key = "%s.%s.%s" % (vid, part, st)
        path = os.path.join(cdir, "%s_%d_c%d.npz" % (key, args.dirs, cell))
        if os.path.exists(path) and not args.force:
            entries[key] = list(np.load(path)["f"])
            log("  %s  (cached)" % key)
            continue
        t0 = time.time()
        # the turret throws its shadow (gun tube included) onto the deck it sits on
        frames = VC.render_dirs(lambda ctx: build(vid, d, st, part, args.season)[0], args.dirs, ppm, cell, anchor,
                                shadow=True, engine=args.engine, samples=args.samples, device=args.device,
                                supersample=SUPERSAMPLE[scale], filter_width=FILTER_W,
                                catcher_z=0.0 if (part == "hull" or st == "blown") else deck_z(vid, d))
        np.savez_compressed(path, f=np.stack(frames))
        entries[key] = frames
        log("  %s  %.1fs" % (key, time.time() - t0))
    entries, (cw, ch), anc = VC.crop_union(entries, anchor, outline=OUTLINE, sharpen=SHARPEN)
    columns = 16
    packer = C.AtlasPacker(scale, cw, ch, anc, args.dirs, columns=columns)
    for key, frames in entries.items():
        packer.add(key, [[f] for f in frames], fps=0, loop=False)
    base = os.path.join(VC.SPRITES, atlas_name(vid, scale, args.season))
    piv = {"x": round(pivot[0], 3), "y": round(pivot[1], 3)} if pivot else None
    extra = {"frame": FRAME, "vehicle": vid, "season": args.season, "hasTurret": bool(VEHICLES[vid][1]), "lengthM": d["L"], "widthM": d["W"]}
    if piv:
        extra["turretPivotM"] = piv
    packer.save(base, extra=extra, webp="lossy")
    return base


def write_index(scale, dirs):
    idx = {"scale": scale, "dirs": dirs, "frame": FRAME, "vehicles": {}}
    for vid in VEHICLES:
        p = os.path.join(VC.SPRITES, "vehicles_%s_%d.json" % (vid, scale))
        if not os.path.exists(p):
            continue
        m = json.load(open(p))
        idx["dirs"] = m["dirs"]
        idx["vehicles"][vid] = {"file": "vehicles_%s_%d" % (vid, scale), "cell": m["cell"], "anchor": m["anchor"],
                                "columns": m["columns"], "hasTurret": m["hasTurret"],
                                "turretPivotM": m.get("turretPivotM"), "entries": m["entries"]}
    with open(os.path.join(VC.SPRITES, "vehicles_%d.json" % scale), "w") as fh:
        json.dump(idx, fh, indent=1)


def main():
    import argparse
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--scale", type=int, default=0, help="1 or 2 (default both)")
    ap.add_argument("--dirs", type=int, default=64)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--engine", default="CYCLES")
    ap.add_argument("--device", default="GPU")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--season", default="summer", choices=["summer", "winter"],
                    help="winter: whitewashed ok / trackL / trackR entries in vehicles_<id>_winter_<scale>")
    ap.add_argument("--states", default="", help="look-dev: only these states (e.g. ok); the atlas holds just them")
    args = ap.parse_args(argv)
    defs = read_defs()
    missing = [v for v in defs if v not in VEHICLES]
    assert not missing, "no model for %s" % missing
    ids = [i for i in args.only.split(",") if i] or list(VEHICLES.keys())
    if args.season == "winter":
        ids = [i for i in ids if i not in NO_WASH]
    scales = [args.scale] if args.scale else [1, 2]

    def log(s):
        print("[vehicles] " + s, flush=True)
    t_all = time.time()
    for scale in scales:
        for vid in ids:
            t0 = time.time()
            log("%s scale %d" % (vid, scale))
            render_vehicle(vid, defs[vid], scale, args, log)
            log("%s scale %d done in %.1fs" % (vid, scale, time.time() - t0))
        if args.season == "summer":
            write_index(scale, args.dirs)
    log("all done in %.1fs" % (time.time() - t_all))


if __name__ == "__main__":
    main()
