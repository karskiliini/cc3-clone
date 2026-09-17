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

GREY = "#4f565b"
DYEL = "#9e8a52"
SOVG = "#3f4c2b"
BARREL_K = 1.6       # gun tubes are drawn a little fat so they survive at 10 px/m
CAMO_A = [("#56613a", 0.52, 0.60, 0.0), ("#70452f", 0.56, 0.64, 7.3)]
CAMO_B = [("#56613a", 0.50, 0.58, 3.1)]
CAMO_C = [("#70452f", 0.50, 0.58, 5.2), ("#56613a", 0.58, 0.66, 1.4)]


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
    """Pz III J / Pz IV F1 / Pz IV H: tub between the tracks, box superstructure over the fenders,
    lower engine deck, near-vertical plates."""
    L, W = d["L"], d["W"]
    skirt = v == "pz4gh"
    Wh = W - (0.0 if not skirt else 0.0)
    tw = 0.38 if v != "pz3j" else 0.36
    top = 0.92
    pz4 = v != "pz3j"
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
    pz4 = v != "pz3j"
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
    elif v == "pz4f1":
        barrel(k, l * 0.42 + 0.1, 1.05, 0.105, zr + 0.34, sleeve=(0.4, 0.15), taper=1.0)
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


def panther(k, d, ko):
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
    k.cyl(0.12, 0.12, (0.8, L / 2 - 1.1, 1.45), "paint", axis="Y", seg=10, rot=(-90 + 35, 0, 0))   # ball MG
    k.cross(0.46, (W / 2 * 0.89 + 0.01, -0.2, (zr + top) / 2), rot=(90 - 16, 0, 90))
    k.cross(0.46, (-W / 2 * 0.89 - 0.01, -0.2, (zr + top) / 2), rot=(90 - 16, 0, -90))
    return (0.0, 0.3), zr


def panther_turret(k, d, ko, zr, proxy):
    w, l, h = 2.3, 2.55, 0.78
    fp = [(-w / 2, -l / 2 + 0.2), (-w * 0.38, -l / 2), (w * 0.38, -l / 2), (w / 2, -l / 2 + 0.2), (w * 0.32, l / 2 - 0.2), (-w * 0.32, l / 2 - 0.2)]
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.74, 0.88), shift=(0, -0.1), centre=(0, 0))
    cupola(k, -0.45, -0.55, zr + h - 0.02, 0.4, 0.25, ko)
    k.hatch((0.3, 0.3), (0.35, 0.3, zr + h - 0.01), "paint", round_seg=10)
    if proxy:
        return
    k.cyl(0.36, 1.55, (0, l / 2 - 0.12, zr + 0.4), "paint", axis="X", seg=12)        # rounded mantlet
    barrel(k, l / 2 + 0.1, 4.3, 0.085, zr + 0.4, sleeve=(0.7, 0.15), brake=(0.45, 0.15))


def stug3g(k, d, ko):
    L, W = d["L"], d["W"]
    tw, top = 0.38, 0.9
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
    k.box((1.15, 0.04, 0.6), (0, 0.72, gz + 0.02), wall, rot=(-14, 0, 0))
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
        k.box((0.3, 1.1, 0.03), (s * (W / 2 - 0.16), L / 2 - 0.95, 0.92), "paint", rot=(0, 0, 0))   # mudguard
        k.box((0.3, 0.35, 0.03), (s * (W / 2 - 0.16), L / 2 - 0.28, 0.82), "paint", rot=(-38, 0, 0))
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
def t34_hull(k, d, ko, su85=False):
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
    k.star(0.3, (w * 0.4 + 0.0, -0.45, zr + 0.33), rot=(90 - 20, 0, 90 + 12))
    k.star(0.3, (-w * 0.4 - 0.0, -0.45, zr + 0.33), rot=(90 - 20, 0, -90 - 12))
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
    k.star(0.32, (w * 0.415, -0.5, zr + 0.36), rot=(90 - 17, 0, 90))
    k.star(0.32, (-w * 0.415, -0.5, zr + 0.36), rot=(90 - 17, 0, -90))
    if proxy:
        return
    k.cyl(0.33, 0.9, (0, l / 2 - 0.42, zr + 0.36), "paint", axis="X", seg=12)
    k.cyl(0.19, 0.7, (0, l / 2 + 0.05, zr + 0.36), "paint", axis="Y", seg=10, r2=0.14)
    barrel(k, l / 2 - 0.1, 4.0, 0.078, zr + 0.36)


def su85(k, d, ko):
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
    cupola(k, 0.62, 0.35, zc - 0.02, 0.3, 0.2, ko)
    k.hatch((0.5, 0.6), (-0.4, y0 + 0.55, zc), "paint", open_deg=80 if ko else 0, hinge="left")
    k.box((0.22, 0.22, 0.1), (-0.3, 0.6, zc + 0.05), "paint")
    # gun: ball mantlet right of centre, long tube
    gx, gy, gz = 0.28, y1 + 0.35, 1.5
    k.cyl(0.42, 0.5, (gx, gy, gz), "paint", axis="Y", seg=12, r2=0.3, rot=(-90 + 8, 0, 0))
    k.cyl(0.24, 0.8, (gx, gy + 0.55, gz), "paint", axis="Y", seg=10, r2=0.17)
    barrel(k, gy + 0.4, 3.6, 0.078, gz, x=gx)
    k.star(0.34, ((W - 0.06) / 2 * 0.87 + 0.0, 0.2, 1.47), rot=(90 - 22, 0, 90))
    k.star(0.34, (-(W - 0.06) / 2 * 0.87 - 0.0, 0.2, 1.47), rot=(90 - 22, 0, -90))
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
    k.cyl(0.12, 0.2, (0, -l / 2 - 0.22, zr + 0.5), "paint", axis="Y", seg=8)            # rear MG ball
    k.star(0.36, (w / 2 * 0.95 + 0.01, -0.4, zr + 0.45), rot=(90 - 4, 0, 90))
    k.star(0.36, (-w / 2 * 0.95 - 0.01, -0.4, zr + 0.45), rot=(90 - 4, 0, -90))
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


def is2_turret(k, d, ko, zr, proxy):
    w, l, h = 2.2, 3.0, 0.8
    fp = rounded_fp(w, l, 0.9, seg=5, cy=-0.35, r_front=0.7)
    k.extrude(fp, zr + 0.02, zr + h, "paint", scale=(0.78, 0.86), shift=(0, -0.02), smooth=True, centre=(0, -0.35))
    cupola(k, -0.48, -0.5, zr + h - 0.03, 0.42, 0.24, ko, hinge="front")
    k.hatch((0.5, 0.5), (0.45, -0.6, zr + h - 0.01), "paint", open_deg=95 if ko else 0, hinge="front", round_seg=12)
    k.cyl(0.13, 0.08, (0.2, 0.35, zr + h), "paint", axis="Z", seg=8)
    k.cyl(0.1, 0.25, (0.35, -l / 2 - 0.4, zr + 0.5), "paint", axis="Y", seg=8)           # rear MG
    k.star(0.34, (w * 0.425, -0.5, zr + 0.4), rot=(90 - 15, 0, 90))
    k.star(0.34, (-w * 0.425, -0.5, zr + 0.4), rot=(90 - 15, 0, -90))
    if proxy:
        return
    k.cyl(0.4, 1.15, (0, l / 2 - 0.62, zr + 0.4), "paint", axis="X", seg=12)
    k.box((1.0, 0.5, 0.62), (0, l / 2 - 0.45, zr + 0.4), "paint", top=(0.8, 0.8))
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
    k.star(0.22, (0.475 + 0.012, -0.8, zr + 0.36), rot=(90 - 3, 0, 90))
    k.star(0.22, (-0.475 - 0.012, -0.8, zr + 0.36), rot=(90 - 3, 0, -90))
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
    k.star(0.22, (0.57, -0.25, zr + 0.3), rot=(90 - 21, 0, 90))
    k.star(0.22, (-0.57, -0.25, zr + 0.3), rot=(90 - 21, 0, -90))
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
    k.star(0.18, (0.53, -0.05, zr + 0.28), rot=(90 - 20, 0, 90))
    k.star(0.18, (-0.53, -0.05, zr + 0.28), rot=(90 - 20, 0, -90))
    if proxy:
        return
    k.box((0.6, 0.3, 0.36), (0, 0.55, zr + 0.28), "paint", top=(0.85, 0.7))
    barrel(k, 0.6, 1.5, 0.045, zr + 0.28, sleeve=(0.35, 0.08))


def su76(k, d, ko):
    L, W = d["L"], d["W"]
    zr, wb, top = t70_hull(k, d, ko, n=6, su76=True)
    k.grille((0.5, 1.0), (0.55, 0.55, zr), "paint")
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
    k.star(0.3, ((W / 2 - 0.3) + 0.11, cy, zc), rot=(90 - 11, 0, 90))
    k.star(0.3, (-(W / 2 - 0.3) - 0.11, cy, zc), rot=(90 - 11, 0, -90))
    return None, zr


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
}


def materials(vid, d, ko):
    base, camo, soot = VEHICLES[vid][2:5]
    mats = {}
    VC.common_materials(mats, burnt=ko)
    mats["thrown"] = VC.track_material("thrown", base="#24221f", dust="#3a352c")
    if ko:
        for nm, g in (("paint", 1.0), ("paint2", 0.8)):
            mats[nm] = VC.paint_material(nm + "_ko", base, camo=camo, scorch=("#2a2622", "#4d3526"),
                                         soot_at=(0.0, soot * d["L"], d["L"] * 0.42), mottle=0.35, gain=g)
    else:
        mats["paint"] = VC.paint_material("paint", base, camo=camo)
        mats["paint2"] = VC.paint_material("paint2", base, camo=camo, gain=0.78)
    return mats


HULL_STATES = ("ok", "ko", "blown", "trackL", "trackR")     # blown only for turreted vehicles
TURRET_STATES = ("ok", "ko", "blown")


def build(vid, d, state, part):
    """One sprite subject.  hull: ok / ko / blown (burnt, turret ring an open hole) / trackL, trackR
    (intact paint, the vehicle's own left/right track thrown).  turret: ok / ko (askew) / blown (the
    burnt turret lying on the ground, rendered with its own ground shadow)."""
    hull_fn, turret_fn = VEHICLES[vid][0:2]
    ko = state in ("ko", "blown")
    mats = materials(vid, d, ko)
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
                k.cyl(rr, (ztop - zr) * 0.6, (pivot[0], pivot[1], zr + (ztop - zr) * 0.3), "paint", axis="Z", seg=20)
        return [(k.build(mats), True)], pivot, k
    kt = Kit(vid + "_turret")
    if state == "blown":
        kt.xform = Matrix.Translation(Vector((0, 0, -zr + 0.12))) @ \
            Euler((math.radians(-5), math.radians(13), 0), "XYZ").to_matrix().to_4x4()
    else:
        ko_xform(kt, ko)
    turret_fn(kt, d, ko, zr, False)
    return [(kt.build(mats), True)], pivot, kt


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
    todo = [("hull", st) for st in HULL_STATES if turreted or st != "blown"]
    if turreted:
        todo += [("turret", st) for st in TURRET_STATES]
    cdir = os.path.join(VC.ROOT, "node_modules", ".cache", "sprites", "vehicles_%d" % scale)
    os.makedirs(cdir, exist_ok=True)
    for part, st in todo:
        key = "%s.%s.%s" % (vid, part, st)
        path = os.path.join(cdir, "%s_%d_c%d.npz" % (key, args.dirs, cell))
        if os.path.exists(path) and not args.force:
            entries[key] = list(np.load(path)["f"])
            log("  %s  (cached)" % key)
            continue
        t0 = time.time()
        frames = VC.render_dirs(lambda ctx: build(vid, d, st, part)[0], args.dirs, ppm, cell, anchor,
                                shadow=(part == "hull" or st == "blown"), engine=args.engine,
                                samples=args.samples, device=args.device)
        np.savez_compressed(path, f=np.stack(frames))
        entries[key] = frames
        log("  %s  %.1fs" % (key, time.time() - t0))
    entries, (cw, ch), anc = VC.crop_union(entries, anchor)
    columns = 16
    packer = C.AtlasPacker(scale, cw, ch, anc, args.dirs, columns=columns)
    for key, frames in entries.items():
        packer.add(key, [[f] for f in frames], fps=0, loop=False)
    base = os.path.join(VC.SPRITES, "vehicles_%s_%d" % (vid, scale))
    piv = {"x": round(pivot[0], 3), "y": round(pivot[1], 3)} if pivot else None
    extra = {"frame": FRAME, "vehicle": vid, "hasTurret": bool(VEHICLES[vid][1]), "lengthM": d["L"], "widthM": d["W"]}
    if piv:
        extra["turretPivotM"] = piv
    packer.save(base, extra=extra)
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
    args = ap.parse_args(argv)
    defs = read_defs()
    missing = [v for v in defs if v not in VEHICLES]
    assert not missing, "no model for %s" % missing
    ids = [i for i in args.only.split(",") if i] or list(VEHICLES.keys())
    scales = [args.scale] if args.scale else [1, 2]

    def log(s):
        print("[vehicles] " + s, flush=True)
    t_all = time.time()
    for scale in scales:
        for vid in ids:
            base = os.path.join(VC.SPRITES, "vehicles_%s_%d" % (vid, scale))
            t0 = time.time()
            log("%s scale %d" % (vid, scale))
            render_vehicle(vid, defs[vid], scale, args, log)
            log("%s scale %d done in %.1fs" % (vid, scale, time.time() - t0))
        write_index(scale, args.dirs)
    log("all done in %.1fs" % (time.time() - t_all))


if __name__ == "__main__":
    main()
