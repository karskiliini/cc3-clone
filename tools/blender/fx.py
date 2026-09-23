"""Combat FX flipbooks: explosions, fire, smoke, impact puffs (our own renders, no third-party art).

  blender -b -P tools/blender/fx.py -- [--only key,key] [--samples 16] [--force] [--pack-only] [--list]

Writes public/sprites/fx_<group>.png/.json (atlas contract, dirs = 1, one frame per cell). Groups
share a cell size: `s` 64 px, `m` 128 px, `l` 256 px, all at 10 px/m (the game's ground scale),
anchored on the cell centre (the burst's ground point). Each entry is one flipbook with `fps`
and `loop`; the game (src/render/fxSprites.ts) plays it from the effect's start time.

Look: shader-driven volumes (4D noise over a shaped density field, blackbody-ish emission ramp for
the fire) lit by the pipeline's NW sun and sky, plus a few mesh clods for the thrown earth. The
camera is the pipeline camera (12 deg tilt), so a burst is seen almost straight down: a bright
core, a ragged ring of flame, then a lit, rolling smoke cap with thrown earth and a ground dust ring.

Entries are cached as strips in tools/blender/.cache/fx/<key>.png; without --force/--only a
cached entry is reused, so `--pack-only` just re-packs.
"""
import argparse
import json
import math
import os
import random
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(ROOT, "public", "sprites")
CACHE = os.path.join(HERE, ".cache", "fx")
PPM = 10
GROUPS = {"s": 64, "m": 128, "l": 256}


# ----------------------------------------------------------------------------- node helpers
class NT:
    """Tiny node-graph builder for one material."""

    def __init__(self, name):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        self.m = m
        self.nt = m.node_tree
        for n in list(self.nt.nodes):
            self.nt.nodes.remove(n)
        self.out = self.nt.nodes.new("ShaderNodeOutputMaterial")

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def math(self, op, a, b=None, clamp=False):
        n = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = float(v)
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

    def vmath(self, op, a, b=None):
        n = self.node("ShaderNodeVectorMath", operation=op)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (tuple, list)):
                n.inputs[i].default_value = tuple(float(x) for x in v)
            else:
                self.link(v, n.inputs[i])
        return n.outputs["Value"] if op in ("LENGTH", "DOT_PRODUCT", "DISTANCE") else n.outputs["Vector"]

    def noise(self, vec, w, scale, detail=5.0, rough=0.6, distortion=0.0):
        n = self.node("ShaderNodeTexNoise", noise_dimensions="4D")
        self.link(vec, n.inputs["Vector"])
        n.inputs["W"].default_value = w
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        n.inputs["Distortion"].default_value = distortion
        return n.outputs["Fac"]

    def ramp(self, fac, stops):
        n = self.node("ShaderNodeValToRGB")
        cr = n.color_ramp
        cr.interpolation = "LINEAR"
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[-1])
        for i, (pos, col) in enumerate(stops):
            e = cr.elements[0] if i == 0 else cr.elements.new(pos)
            e.position = pos
            c = C._rgb(col)
            e.color = tuple(C._srgb_to_lin(x) for x in c) + (1.0,)
        self.link(fac, n.inputs["Fac"])
        return n.outputs["Color"]

    def coords(self):
        return self.node("ShaderNodeTexCoord").outputs["Object"]


def lin(col):
    return tuple(C._srgb_to_lin(x) for x in C._rgb(col))


def domain(name, half, location, mat):
    """A box of half-extents `half` (m) standing on `location` (its ground point); object coords are
    metres from that ground point, z up."""
    mesh = bpy.data.meshes.new(name)
    hx, hy, hz = half
    v = [(sx * hx, sy * hy, sz * hz) for sx in (-1, 1) for sy in (-1, 1) for sz in (0, 2)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh.from_pydata(v, [], f)
    o = bpy.data.objects.new(name, mesh)
    o.location = location
    mesh.materials.append(mat)
    bpy.context.scene.collection.objects.link(o)
    return o


def sphere(name, loc, r, mat, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    o.data.materials.append(mat)
    return o


# ----------------------------------------------------------------------------- volume "puffball"
def puff_material(name, *, R, Rz, cz, seed, t, noise_scale, amp, density, smoke, emit=None, spikes=0.0,
                  drift=(0.0, 0.0), soft=2.5, loop=None, erode=0.0, ambient=0.0):
    """A lumpy ball of smoke, optionally with a hot emissive core.

    R, Rz     horizontal / vertical radius (m); cz: centre height above the ground point (m)
    amp       how far the noise pushes the edge (in units of R)
    density   smoke density scale; smoke: sRGB albedo colour
    emit      None or dict(Rcore=fraction of R that glows, heat=0..1, strength, amp)
    spikes    angular noise on the edge (flame fingers / lobes), in units of R
    drift     (x, y) offset of the ball centre (wind)
    soft      edge sharpness (higher = harder edge)
    loop      None or (phase 0..1, period in W): the noise cross-fades so the last frame meets the first
    erode     raises the noise threshold: the cloud breaks up into wisps and holes as it goes
    ambient   self-emission in the albedo colour (keeps snow / white smoke reading white where the
              single-scatter lighting would leave it grey)
    """
    g = NT(name)
    co = g.coords()
    p = g.vmath("SUBTRACT", co, (drift[0], drift[1], cz))
    q = g.vmath("MULTIPLY", p, (1.0 / R, 1.0 / R, 1.0 / Rz))
    r = g.vmath("LENGTH", q)

    def nz(vec, w, sc, det, rough, dist):
        if loop is None:
            return g.noise(vec, w, sc, det, rough, dist)
        ph, per = loop
        a = g.noise(vec, w + ph * per, sc, det, rough, dist)
        b = g.noise(vec, w + (ph - 1.0) * per, sc, det, rough, dist)
        return g.math("ADD", g.math("MULTIPLY", a, 1.0 - ph), g.math("MULTIPLY", b, ph))

    tw = 0.0 if loop else t
    if spikes > 0:
        nd = nz(g.vmath("NORMALIZE", q), seed * 2.3 + tw * 0.8, 2.2, 3.0, 0.55, 0.0)
        r = g.math("DIVIDE", r, g.math("ADD", 1.0, g.math("MULTIPLY", g.math("SUBTRACT", nd, 0.45), spikes * 2.0), clamp=False))
    n = nz(co, seed + tw * 1.6, noise_scale, 6.0, 0.62, 0.25)
    n2 = nz(co, seed * 1.7 + 3.1 + tw * 1.1, noise_scale * 2.7, 3.0, 0.5, 0.0)
    nn = g.math("ADD", g.math("SUBTRACT", n, 0.5), g.math("MULTIPLY", g.math("SUBTRACT", n2, 0.5), 0.45))
    edge = g.math("ADD", g.math("SUBTRACT", 1.0, r), g.math("MULTIPLY", nn, amp * 2.0))
    if erode > 0:
        edge = g.math("SUBTRACT", edge, g.math("MULTIPLY", g.math("ADD", n2, 0.3), erode))
    dens = g.math("MULTIPLY", g.math("MULTIPLY", edge, soft, clamp=True), density)
    vol = g.node("ShaderNodeVolumePrincipled")
    vol.inputs["Color"].default_value = lin(smoke) + (1.0,)
    vol.inputs["Anisotropy"].default_value = 0.15
    g.link(dens, vol.inputs["Density"])
    if ambient > 0 and not emit:
        vol.inputs["Emission Color"].default_value = lin(smoke) + (1.0,)
        g.link(g.math("MULTIPLY", dens, ambient), vol.inputs["Emission Strength"])
    if emit:
        core = g.math("ADD", g.math("SUBTRACT", 1.0, g.math("MULTIPLY", r, 1.0 / emit["Rcore"])),
                      g.math("MULTIPLY", nn, emit.get("amp", 1.2)))
        heat = g.math("MULTIPLY", g.math("MULTIPLY", core, 1.6, clamp=True), emit["heat"])
        col = g.ramp(heat, [(0.0, "#000000"), (0.12, "#3a0a02"), (0.35, "#b83208"), (0.6, "#ff7a14"),
                            (0.82, "#ffc24a"), (1.0, "#fff4d8")])
        g.link(col, vol.inputs["Emission Color"])
        g.link(g.math("MULTIPLY", g.math("POWER", heat, 1.5), emit["strength"]), vol.inputs["Emission Strength"])
    g.link(vol.outputs[0], g.out.inputs["Volume"])
    return g.m


def ring_material(name, *, R, w, h, seed, t, density, col, ambient=0.0):
    """A flat ground dust / snow ring at radius R (m), half width w, hugging the ground up to h."""
    g = NT(name)
    co = g.coords()
    rxy = g.vmath("LENGTH", g.vmath("MULTIPLY", co, (1.0, 1.0, 0.0)))
    band = g.math("SUBTRACT", 1.0, g.math("MULTIPLY", g.math("ABSOLUTE", g.math("SUBTRACT", rxy, R)), 1.0 / w))
    sep = g.node("ShaderNodeSeparateXYZ")
    g.link(co, sep.inputs[0])
    hz = g.math("SUBTRACT", 1.0, g.math("MULTIPLY", sep.outputs[2], 1.0 / h), clamp=True)
    n = g.noise(co, seed + t, 1.4, 4.0, 0.6, 0.3)
    bn = g.math("ADD", band, g.math("MULTIPLY", g.math("SUBTRACT", n, 0.5), 2.0))
    dens = g.math("MULTIPLY", g.math("MULTIPLY", g.math("MULTIPLY", bn, 2.0, clamp=True), hz), density)
    vol = g.node("ShaderNodeVolumePrincipled")
    vol.inputs["Color"].default_value = lin(col) + (1.0,)
    g.link(dens, vol.inputs["Density"])
    if ambient > 0:
        vol.inputs["Emission Color"].default_value = lin(col) + (1.0,)
        g.link(g.math("MULTIPLY", dens, ambient), vol.inputs["Emission Strength"])
    g.link(vol.outputs[0], g.out.inputs["Volume"])
    return g.m


def box(name, lo, hi, origin, mat):
    """A box from local corner `lo` to `hi` (m) whose object origin (= material coords 0) is the
    ground point `origin`; used to keep each volume lobe's domain small."""
    mesh = bpy.data.meshes.new(name)
    v = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh.from_pydata(v, [], f)
    o = bpy.data.objects.new(name, mesh)
    o.location = origin
    mesh.materials.append(mat)
    bpy.context.scene.collection.objects.link(o)
    return o


def solid_material(name, col, emit=0.0):
    return C.make_material(name, col, roughness=0.95, emission=emit)


# ----------------------------------------------------------------------------- entries
def ease_out(x, k=3.0):
    x = min(1.0, max(0.0, x))
    return 1.0 - (1.0 - x) ** k


def frame_time(spec, i, n):
    """Seconds after detonation that frame i of n shows (eased: many frames early, few late)."""
    return spec["dur"] * (i / (n - 1)) ** spec.get("ease", 1.6)


def build_burst(ctx, col, row, i, n, spec):
    """One frame of a ground burst (grenade / shell / mortar / ammo detonation / smoke round).

    Built from volume lobes, each in its own small domain: the fireball (emissive, early), an
    earth fountain (summer: brown earth thrown up that falls back; winter: snow, with some dark
    earth for the bigger rounds) and several offset smoke lobes that roll outward, rise, drift
    with the wind and break up (noise erosion) instead of fading as a disc. Plus a ground dust /
    snow ring and ballistic clods."""
    x0, y0 = ctx.cell_origin(col, row, exact=True)
    T = frame_time(spec, i, n)               # seconds since detonation
    dur = spec["dur"]
    Rmax = spec["R"]
    grow = ease_out(T / spec["grow_s"], 2.4)
    heat = max(0.0, 1.0 - T / spec["fire_s"]) ** 1.3 if spec["fire_s"] > 0 else 0.0
    halfc = ctx.cell_w / PPM / 2.0 * 0.97
    win = spec.get("winter", False)
    wind = spec.get("wind", 0.35)
    wx, wy = wind * T, wind * T * 0.8
    smoke_col = spec.get("smoke_w", spec["smoke"]) if win else spec["smoke"]
    amb_w = spec.get("ambient", 0.55 if win else 0.0)
    # erosion: the cloud starts breaking up at `erode_from` and is gone by the end
    e0 = spec.get("erode_from", 0.35)
    erode = 1.6 * max(0.0, (T / dur - e0) / (1 - e0)) ** 1.3

    def lobe(name, cx, cy, R, Rz, cz, mat_kw):
        m = puff_material(f"{name}_{col}_{row}", R=R, Rz=Rz, cz=cz, drift=(cx, cy), t=T, **mat_kw)
        pad = 1.35 + mat_kw.get("amp", 0.4)
        lo = [cx - R * pad, cy - R * pad, 0.0]
        hi = [cx + R * pad, cy + R * pad, cz + Rz * pad]
        lo[0], lo[1] = max(lo[0], -halfc), max(lo[1], -halfc)
        hi[0], hi[1] = min(hi[0], halfc), min(hi[1], halfc)
        if hi[0] > lo[0] and hi[1] > lo[1]:
            box(f"{name}dom_{col}_{row}", lo, hi, (x0, y0, 0.0), m)

    # --- fireball
    if heat > 0.01:
        Rf = Rmax * spec.get("fire_R", 0.75) * (0.3 + 0.7 * grow)
        lobe("fire", 0.0, 0.0, Rf, Rf * 0.7, Rf * 0.4, dict(
            seed=spec["seed"], noise_scale=spec["noise"] / Rmax, amp=spec["amp"], density=spec["density"] * 0.8,
            smoke="#4a4038", spikes=spec.get("spikes", 0.0), soft=2.5,
            emit=dict(Rcore=0.95, heat=heat, strength=spec["emit"])))
    # --- earth / snow fountain: thrown up fast, falls back within ~1 s
    fo = spec.get("fountain")
    t0f = fo.get("delay", 0.06) if fo else 0.0
    if fo and t0f <= T < fo["life"]:
        k = (T - t0f) / (fo["life"] - t0f)
        Rt = Rmax * fo["R"] * (0.35 + 0.65 * ease_out(T / 0.12, 2.0)) * (1 + 0.3 * k)
        Tf = T - t0f
        hgt = max(0.2, fo["v"] * Tf - 4.9 * Tf * Tf)
        cols = [(fo["col_w"] if win else fo["col"], 1.0, 0.0)]
        if win and fo.get("earth_w"):
            cols.append((fo["col"], 0.55, 0.9))   # dark earth mixed into the snow for big rounds
        for j, (c, rs, off) in enumerate(cols):
            lobe(f"fount{j}", off * Rt * 0.5, -off * Rt * 0.3, Rt * rs, Rt * 1.3 * rs, hgt * 0.6, dict(
                seed=spec["seed"] + 13 + j * 3, noise_scale=spec["noise"] * 1.3 / Rmax, amp=0.5,
                density=fo["density"] * min(1.0, k * 4) * (1 - k) ** 0.7, smoke=c, soft=3.0, erode=1.4 * k ** 2,
                ambient=0.28 if (win and j == 0) else 0.0))
    # --- smoke lobes: asymmetric, rolling out from the burst, rising and drifting
    R = Rmax * (0.25 + 0.75 * grow) * (1.0 + spec.get("spread", 0.3) * T / dur)
    kr = random.Random(int(spec["seed"] * 101))
    nl = spec.get("lobes", 5)
    for j in range(nl):
        a = kr.uniform(0, 2 * math.pi)
        d = kr.uniform(0.35, 0.85) if j else 0.0
        rr = kr.uniform(0.38, 0.6) if j else 0.62
        rise_j = kr.uniform(0.6, 1.4)
        out = d * R * (0.7 + 0.5 * T / dur)
        cx, cy = math.cos(a) * out + wx * rise_j, math.sin(a) * out + wy * rise_j
        Rl = R * rr
        dens = spec["density"] * (1.1 if j == 0 else 0.9) * min(1.0, T / 0.08 + 0.2)
        lobe(f"smoke{j}", cx, cy, Rl, Rl * spec.get("flat", 0.6), Rl * 0.35 + spec.get("rise", 1.0) * T * rise_j, dict(
            seed=spec["seed"] + j * 7.7, noise_scale=spec["noise"] / Rmax, amp=spec["amp"], density=dens,
            smoke=smoke_col, soft=spec.get("soft", 3.5), erode=erode, ambient=amb_w * 0.35))
    # --- ground dust / snow ring
    rr_ = spec.get("ring")
    if rr_ and T < rr_["s"] * 2.5:
        life = rr_["s"] * 2.5
        rg = ease_out(T / rr_["s"], 2.0)
        rm = ring_material(f"ring_{col}_{row}", R=rr_["R"] * (0.2 + 0.8 * rg), w=rr_["w"] * (0.5 + 0.8 * rg),
                           h=rr_["h"], seed=spec["seed"] + 7, t=T, col=rr_["col_w"] if win else rr_["col"],
                           density=rr_["density"] * (1.0 - T / life) ** 1.3, ambient=0.8 if win else 0.0)
        domain(f"ringdom_{col}_{row}", (halfc, halfc, rr_["h"] * 1.5), (x0, y0, 0.0), rm)
    # --- thrown earth (snow in winter; bigger rounds throw dark earth in winter too)
    cm = "clod_w" if win else "clod"
    clod = bpy.data.materials.get(cm) or solid_material(cm, spec.get("clod_w", "#e8ecef") if win else spec.get("clod", "#3b3024"))
    dark = bpy.data.materials.get("clod") or solid_material("clod", spec.get("clod", "#3b3024"))
    k = random.Random(spec["seed"])
    for j in range(spec.get("clods", 0)):
        a = k.uniform(0, 2 * math.pi)
        v = k.uniform(0.35, 1.0) * spec["clod_v"]
        up = k.uniform(0.6, 1.4) * spec["clod_v"] * 0.9
        sz = k.uniform(0.09, 0.2) * spec.get("clod_size", 1.0)
        tf = 2 * up / 9.81
        if T > tf or T <= 0:
            continue
        d = v * T
        if d > halfc * 0.95:
            continue
        z = up * T - 4.9 * T * T
        mat = dark if (win and spec.get("fountain", {}).get("earth_w") and j % 3 == 0) else clod
        sphere(f"clod_{col}_{row}_{j}", (x0 + math.cos(a) * d, y0 + math.sin(a) * d, max(0.05, z)), sz, mat,
               scale=(1.0 + 0.8 * (1 - T / tf), 1.0, 1.0))
        bpy.context.active_object.rotation_euler = (0, 0, a)


def build_fire(ctx, col, row, i, n, spec):
    """One frame of a looping fire patch (burning wreck, burning tree): flames and a hot smoky top."""
    x0, y0 = ctx.cell_origin(col, row, exact=True)
    ph = i / n
    half = ctx.cell_w / PPM / 2.0 * 0.98
    R = spec["R"]
    mat = puff_material(
        f"fire_{col}_{row}", R=R, Rz=R * 1.4, cz=R * 0.8, seed=spec["seed"], t=0.0, noise_scale=spec["noise"] / R,
        amp=0.7, density=spec["density"], smoke=spec["smoke"], spikes=0.6, soft=2.0, loop=(ph, spec["period"]),
        emit=dict(Rcore=0.7, heat=0.85, strength=spec["emit"], amp=2.2))
    domain(f"dom_{col}_{row}", (half, half, R * 3.0), (x0, y0, 0.0), mat)


def build_puff(ctx, col, row, i, n, spec):
    """Variant i of a single lit smoke puff (the game builds columns and trails out of these)."""
    x0, y0 = ctx.cell_origin(col, row, exact=True)
    half = ctx.cell_w / PPM / 2.0 * 0.98
    R = spec["R"]
    mat = puff_material(
        f"puff_{col}_{row}", R=R, Rz=R * 0.8, cz=R, seed=spec["seed"] + i * 5.3, t=0.0,
        noise_scale=spec["noise"] / R, amp=0.5, density=spec["density"], smoke=spec["smoke"], soft=spec.get("soft", 4.0))
    domain(f"dom_{col}_{row}", (half, half, R * 2.2), (x0, y0, 0.0), mat)


EARTH = dict(clod="#3b3024", clod_w="#eef1f3")
DUST_RING = dict(col="#9c8a6c", col_w="#f4f6f8")
FOUNTAIN = dict(col="#6e5236", col_w="#f2f4f6")
BURSTS = {
    # hand grenade / AT rocket: a short hard white-orange pop, a spurt of earth, a grey-brown puff
    "grenade": dict(group="s", frames=16, fps=16, dur=1.8, grow_s=0.1, fire_s=0.14, fire_R=0.95, R=1.3, noise=3.0,
                    amp=0.4, density=2.2, smoke="#8a8274", smoke_w="#9a9a98", emit=120.0, seed=11.0, rise=0.5,
                    flat=0.6, spikes=0.3, clods=16, clod_v=7.5, clod_size=0.9, wind=0.3, lobes=4, erode_from=0.3,
                    bounces=2, spp=1.0,
                    fountain=dict(FOUNTAIN, R=0.6, v=6.0, life=0.7, density=6.0),
                    ring=dict(DUST_RING, R=2.3, w=0.45, h=0.4, s=0.3, density=2.0), **EARTH),
    # HE shell / mortar bomb on open ground: flash, an earth fountain falling back, thrown clods, a
    # lumpy lit smoke cap that rolls out, drifts and breaks up, a dust ring
    "he": dict(group="m", frames=24, fps=16, dur=3.2, grow_s=0.2, fire_s=0.45, R=2.8, noise=4.0, amp=0.42,
               density=3.0, smoke="#948a7c", smoke_w="#9a9a98", emit=45.0, bounces=2, spp=1.0, seed=3.0, rise=0.8,
               flat=0.6, spikes=0.3, clods=26, clod_v=11.0, lobes=6, erode_from=0.35,
               fountain=dict(FOUNTAIN, R=0.55, v=9.0, life=1.1, density=5.0, earth_w=True),
               ring=dict(DUST_RING, R=4.6, w=0.7, h=0.6, s=0.45, density=2.2), **EARTH),
    # a vehicle's ammunition going up: a big fireball, a black cap, a wide shock ring
    "he.big": dict(group="l", frames=20, fps=14, dur=3.6, grow_s=0.45, fire_s=1.0, fire_R=0.8, R=6.0, noise=4.5,
                   amp=0.42, density=2.6, smoke="#6a625a", smoke_w="#6e6a66", emit=70.0, bounces=2, spp=1.0,
                   seed=21.0, rise=1.0, flat=0.55, spikes=0.35, clods=40, clod_v=16.0, clod_size=1.8, wind=0.5,
                   spread=0.35, lobes=7, erode_from=0.4,
                   fountain=dict(FOUNTAIN, R=0.4, v=14.0, life=1.5, density=4.0, earth_w=True),
                   ring=dict(DUST_RING, R=10.5, w=1.2, h=1.0, s=0.6, density=2.2), **EARTH),
    # smoke round (mortar / grenade): a white bloom that builds into a cloud; the map's smoke takes over
    "smoke": dict(group="m", frames=20, fps=10, dur=3.0, grow_s=1.4, fire_s=0.0, R=4.2, noise=3.2, amp=0.45,
                  density=2.4, smoke="#e6e6e0", emit=0.0, seed=31.0, rise=0.4, flat=0.5, ease=1.2, ambient=0.5,
                  erode_from=0.8, wind=0.25, spread=0.3, clods=0, lobes=6,
                  ring=dict(DUST_RING, R=2.5, w=0.5, h=0.4, s=0.3, density=1.0), **EARTH),
    # bullet / splinter strike on soft ground: a crisp little spurt of dust (snow) and grit
    "impact": dict(group="s", frames=8, fps=16, dur=0.5, grow_s=0.08, fire_s=0.0, R=0.45, noise=2.4, amp=0.4,
                   density=5.0, soft=4.0, smoke="#a8977a", smoke_w="#f2f4f6", emit=0.0, seed=41.0, rise=0.6,
                   flat=0.8, ease=1.3, erode_from=0.25, wind=0.2, clods=9, clod_v=4.5, clod_size=0.5, lobes=3,
                   fountain=dict(FOUNTAIN, col="#8a7454", R=0.7, v=4.0, life=0.4, density=7.0), **EARTH),
}
OTHERS = {
    # looping fire (burning wreck / tree), 1 s loop
    "fire": dict(group="s", frames=16, fps=16, loop=True, R=1.5, noise=3.2, density=1.0, smoke="#4a423a",
                 emit=14.0, bounces=2, seed=51.0, period=1.3, builder=build_fire),
    # single smoke puffs, 6 variants each (frame = variant): dark (wrecks) and light (dust / smoke)
    "puff.dark": dict(group="s", frames=6, fps=0, R=1.4, noise=2.6, density=4.0, soft=2.5, bounces=4, spp=4, smoke="#5a544e", seed=61.0,
                      builder=build_puff),
    "puff.light": dict(group="s", frames=6, fps=0, R=1.4, noise=2.6, density=4.0, soft=2.5, bounces=4, spp=4, smoke="#eeebe4", seed=71.0,
                       builder=build_puff),
}


THREADS = 5


def render_entry(key, spec, samples):
    size = GROUPS[spec["group"]]
    n = spec["frames"]
    cols = min(n, max(1, 2048 // size))
    rows = -(-n // cols)
    ctx = C.setup_scene(PPM, size, size, anchor=(size // 2, size // 2), grid=(cols, rows), shadow=False,
                        samples=samples)
    sc = ctx.scene
    sc.render.threads_mode = "FIXED"
    sc.render.threads = THREADS
    sc.cycles.volume_bounces = spec.get("bounces", 2)
    sc.cycles.max_bounces = max(4, spec.get("bounces", 2) + 2)
    sc.cycles.samples = int(samples * spec.get("spp", 1.0))
    sc.cycles.transparent_max_bounces = 8
    try:
        sc.cycles.volume_step_rate = 1.0
    except Exception:
        pass
    for i in range(n):
        spec["builder"](ctx, i % cols, i // cols, i, n, spec)
    cells = C.render_grid(ctx)
    return [cells[i // cols][i % cols] for i in range(n)]


def all_entries():
    out = {}
    for k, s in BURSTS.items():
        out[k] = dict(s, builder=build_burst)
        if "smoke_w" in s or s.get("clods"):
            out[k + ".w"] = dict(s, builder=build_burst, winter=True)   # winter: snow thrown, white ring
    out.update(OTHERS)
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="fx.py")
    ap.add_argument("--only", default="")
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--threads", type=int, default=5)
    ap.add_argument("--pack-only", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)
    global THREADS
    THREADS = a.threads
    ents = all_entries()
    if a.list:
        for k, s in ents.items():
            print(k, s["group"], s["frames"], s["fps"])
        return
    only = [x for x in a.only.split(",") if x]
    os.makedirs(CACHE, exist_ok=True)
    for key, spec in ents.items():
        path = os.path.join(CACHE, key + ".png")
        want = (key in only) if only else (a.force or not os.path.exists(path))
        if a.pack_only or not want:
            continue
        t0 = time.time()
        frames = render_entry(key, spec, a.samples)
        C.save_png(path, np.concatenate(frames, axis=1))
        print(f"[fx] {key}: {len(frames)} frames in {time.time() - t0:.1f}s", flush=True)
    # pack every cached entry into its group's atlas
    for g, size in GROUPS.items():
        keys = [k for k, s in ents.items() if s["group"] == g and os.path.exists(os.path.join(CACHE, k + ".png"))]
        if not keys:
            continue
        packer = C.AtlasPacker(1, size, size, (size // 2, size // 2), 1, columns=max(1, 4096 // size))
        for k in keys:
            strip = C.load_png(os.path.join(CACHE, k + ".png"))
            n = strip.shape[1] // size
            frames = [strip[:, j * size:(j + 1) * size] for j in range(n)]
            s = ents[k]
            extra = {}
            if s.get("builder") is build_burst:
                # frames are spaced by an ease curve (dense at the flash): the game picks the frame by time
                extra["times"] = [round(frame_time(s, i, n), 3) for i in range(n)]
            packer.add(k, [frames], fps=s["fps"], loop=bool(s.get("loop", False)), **extra)
        packer.save(os.path.join(OUT_DIR, f"fx_{g}"), extra=dict(pxPerM=PPM, fx=True))
        print(f"[fx] packed fx_{g}: {len(keys)} entries", flush=True)


if __name__ == "__main__":
    main()
