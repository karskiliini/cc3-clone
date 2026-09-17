"""Reusable, original low-poly kit models (weapons, helmets, packs, props) built from primitives.

The SAME builder functions make the gear the soldier wears/carries (soldiers.py) and the ground
items (items.py), so a dropped MG looks like the one the gunner carried.  Every kit function adds
geometry to a MeshB around its own natural origin; callers position it with `b.xf`.
Weapons: origin at the grip, muzzle +Y, up +Z.  Materials are palette roles ("wood", "metal", ...);
MeshB.finish() binds them to materials named <prefix><role>.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

def Rx(d): return Matrix.Rotation(math.radians(d), 4, "X")
def Ry(d): return Matrix.Rotation(math.radians(d), 4, "Y")
def Rz(d): return Matrix.Rotation(math.radians(d), 4, "Z")
def T(v): return Matrix.Translation(Vector(v))
def S(x, y=None, z=None):
    y = x if y is None else y
    z = x if z is None else z
    return Matrix.Diagonal((x, y, z, 1.0))


class MeshB:
    """Accumulates primitives into one mesh with material slots named by palette role."""

    def __init__(self, name, prefix="sol_"):
        self.name, self.bm, self.roles, self.prefix = name, bmesh.new(), [], prefix
        self.xf = Matrix.Identity(4)      # placement applied to everything added next

    def _mi(self, role):
        if role not in self.roles:
            self.roles.append(role)
        return self.roles.index(role)

    def _tag(self, verts, role, smooth=True):
        mi = self._mi(role)
        faces = set()
        for v in verts:
            faces.update(v.link_faces)
        for f in faces:
            f.material_index = mi
            f.smooth = smooth

    def box(self, role, size, loc, rot=(0, 0, 0), bevel=0.012):
        m = self.xf @ T(loc) @ Rz(rot[2]) @ Ry(rot[1]) @ Rx(rot[0])
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m @ S(*size))
        verts = r["verts"]
        if bevel > 0:
            edges = set()
            for v in verts:
                edges.update(v.link_edges)
            rb = bmesh.ops.bevel(self.bm, geom=list(edges), offset=min(bevel, min(size) * 0.3),
                                 segments=1, affect="EDGES", profile=0.5)
            verts = rb["verts"]
        self._tag(verts, role, smooth=False)

    def ball(self, role, radius, loc, rot=(0, 0, 0), segs=12, rings=8):
        if not isinstance(radius, (tuple, list)):
            radius = (radius,) * 3
        m = self.xf @ T(loc) @ Rz(rot[2]) @ Ry(rot[1]) @ Rx(rot[0]) @ S(*radius)
        r = bmesh.ops.create_uvsphere(self.bm, u_segments=segs, v_segments=rings, radius=1.0, matrix=m)
        self._tag(r["verts"], role)

    def tube(self, role, r1, r2, p0, p1, sxy=(1, 1), segs=10, yaw=0.0):
        """Tapered (elliptical) cylinder from point p0 (radius r1) to p1 (radius r2)."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        L = d.length
        q = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        m = self.xf @ T((p0 + p1) / 2) @ q @ Rz(yaw) @ S(sxy[0], sxy[1], 1)
        r = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                  radius1=r1, radius2=r2, depth=L, matrix=m)
        self._tag(r["verts"], role)

    def limb(self, role, r1, r2, length, role2=None, split=0.0):
        """Capsule along +Z from the origin; optional second material from `split` fraction on."""
        if role2 and 0 < split < 1:
            rm = r1 + (r2 - r1) * split
            self.tube(role, r1, rm, (0, 0, 0), (0, 0, length * split))
            self.tube(role2, rm * 1.12, r2 * 1.12, (0, 0, length * split), (0, 0, length))
            self.ball(role2, r2 * 1.12, (0, 0, length), segs=10, rings=6)
        else:
            self.tube(role, r1, r2, (0, 0, 0), (0, 0, length))
            self.ball(role, r2, (0, 0, length), segs=10, rings=6)
        self.ball(role, r1, (0, 0, 0), segs=10, rings=6)

    def lathe(self, role, profile, segs=20, loc=(0, 0, 0)):
        """profile(theta) -> list of (rx, ry, z) rings from top to bottom; theta=0 is +Y (front)."""
        bm = self.bm
        rings = []
        n = len(profile(0.0))
        for i in range(segs):
            th = 2 * math.pi * i / segs
            pr = profile(th)
            rings.append([bm.verts.new(self.xf @ Vector((loc[0] + math.sin(th) * rx, loc[1] + math.cos(th) * ry, loc[2] + z)))
                          for rx, ry, z in pr])
        top = bm.verts.new(self.xf @ Vector((loc[0], loc[1], loc[2] + profile(0.0)[0][2] + 0.004)))
        verts = [top]
        for i in range(segs):
            a, b = rings[i], rings[(i + 1) % segs]
            bm.faces.new((top, b[0], a[0]))
            for k in range(n - 1):
                bm.faces.new((a[k], b[k], b[k + 1], a[k + 1]))
            verts += a
        # underside cap so the rim looks solid from low angles
        bm.faces.new([rings[i][n - 1] for i in range(segs)])
        self._tag(verts, role)

    def torus(self, role, R, r, loc, rot=(0, 0, 0), sxy=(1, 1), seg=18, sides=8):
        bm = self.bm
        m = self.xf @ T(loc) @ Rz(rot[2]) @ Ry(rot[1]) @ Rx(rot[0])
        rings = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring = []
            for k in range(sides):
                b = 2 * math.pi * k / sides
                rr = R + r * math.cos(b)
                ring.append(bm.verts.new(m @ Vector((math.cos(a) * rr * sxy[0], math.sin(a) * rr * sxy[1],
                                                     r * math.sin(b)))))
            rings.append(ring)
        vs = []
        for i in range(seg):
            a, b = rings[i], rings[(i + 1) % seg]
            for k in range(sides):
                bm.faces.new((a[k], b[k], b[(k + 1) % sides], a[(k + 1) % sides]))
            vs += a
        self._tag(vs, role)

    def finish(self, scale=1.0):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        if scale != 1.0:
            bmesh.ops.scale(self.bm, vec=(scale,) * 3, verts=self.bm.verts[:])
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for role in self.roles:
            me.materials.append(bpy.data.materials.get(self.prefix + role))
        return me




# ------------------------------------------------------------------------------------------
# worn kit
# ------------------------------------------------------------------------------------------
def k_helmet(b, g):
    """Helmet shell, origin at the head-part origin (neck pivot); german = flared, soviet = rounder."""
    if g:
        def prof(th):
            c = math.cos(th)                       # 1 front, -1 back
            s = min(1.0, max(0.0, (0.55 - c) / 0.6))
            s = s * s * (3 - 2 * s)                # 0 over the brow, 1 on sides and back
            drop = 0.028 + 0.052 * s
            flare = 0.030 + 0.020 * s + (0.012 if c < -0.5 else 0.0)
            a, bb, h = 0.122, 0.142, 0.105
            out = [(a * math.cos(math.radians(p)), bb * math.cos(math.radians(p)), h * math.sin(math.radians(p)))
                   for p in (72, 52, 34, 16, 0)]
            out.append((a + 0.004, bb + 0.004, -drop * 0.55))
            out.append((a + flare, bb + flare + (0.012 if c > 0.6 else 0.0), -drop))
            return out
        b.lathe("helmet", prof, segs=24, loc=(0, 0.005, 0.145))
    else:
        def prof(th):
            a, bb, h = 0.122, 0.138, 0.125
            out = [(a * math.cos(math.radians(p)), bb * math.cos(math.radians(p)), h * math.sin(math.radians(p)))
                   for p in (72, 52, 34, 16, 0)]
            out.append((a + 0.006, bb + 0.006, -0.03))
            out.append((a + 0.02, bb + 0.02 + (0.008 if math.cos(th) > 0.6 else 0), -0.048))
            return out
        b.lathe("helmet", prof, segs=24, loc=(0, 0.005, 0.14))


def k_breadbag(b):
    b.box("pack", (0.19, 0.075, 0.16), (0, 0, 0), bevel=0.02)
    b.box("leather", (0.03, 0.08, 0.10), (-0.05, 0.002, 0.03), bevel=0.004)
    b.box("leather", (0.03, 0.08, 0.10), (0.05, 0.002, 0.03), bevel=0.004)


def k_canteen(b, g):
    b.ball("wood" if g else "metal", (0.065, 0.045, 0.085), (0, 0, 0))
    b.tube("metal", 0.022, 0.018, (0, 0, 0.07), (0, 0, 0.11), segs=6)


def k_canister(b):
    b.tube("metal", 0.055, 0.055, (0, 0, -0.10), (0, 0, 0.10), segs=10)


def k_tool(b):
    """Entrenching tool: short handle and a square blade."""
    b.tube("wood", 0.018, 0.018, (0, 0, 0.0), (0, 0, 0.30), segs=6)
    b.box("metal", (0.15, 0.02, 0.19), (0, 0, -0.09), bevel=0.01)


def k_pouch(b, g):
    if g:
        for x in (-0.04, 0.0, 0.04):
            b.box("leather", (0.04, 0.05, 0.08), (x, 0, 0), bevel=0.008)
    else:
        b.box("leather", (0.11, 0.05, 0.085), (0, 0, 0), bevel=0.01)


def k_gasbag(b):
    b.box("pack", (0.14, 0.065, 0.17), (0, 0, 0), bevel=0.02)


def k_pack(b, g):
    """Back pack, origin at the middle of the back (chest-part coords origin 0,0,0 = chest pivot)."""
    if g:
        b.tube("roll", 0.062, 0.062, (-0.17, -0.155, 0.34), (0.17, -0.155, 0.34), segs=10)     # rolled shelter
        b.box("pack", (0.26, 0.08, 0.18), (0, -0.15, 0.20), bevel=0.025)                        # assault pack
        b.ball("metal", (0.075, 0.045, 0.06), (0.0, -0.205, 0.17))                              # mess tin
    else:
        b.ball("pack", (0.15, 0.085, 0.13), (0.0, -0.16, 0.17), segs=12)                        # sack
        b.tube("pack", 0.035, 0.05, (0.0, -0.16, 0.30), (0.0, -0.16, 0.345), segs=8)


def k_greatcoat_roll(b):
    """Rolled greatcoat worn across the body, left shoulder to right hip (chest-part coords)."""
    b.torus("roll", 0.27, 0.058, (0.0, 0.0, 0.20), rot=(0, 52, 0), sxy=(1.0, 0.62), seg=20, sides=8)


def k_binoculars(b):
    for sx in (-1, 1):
        b.tube("leather", 0.03, 0.038, (sx * 0.04, -0.06, 0), (sx * 0.04, 0.07, 0), segs=8)
    b.box("metal", (0.06, 0.03, 0.03), (0, 0, 0), bevel=0.005)


def k_mapcase(b):
    b.box("leather", (0.24, 0.17, 0.035), (0, 0, 0), bevel=0.01)
    b.box("metal", (0.03, 0.03, 0.04), (0, -0.06, 0), bevel=0.004)


# ------------------------------------------------------------------------------------------
# weapons (grip at the origin, muzzle +Y, up +Z), slightly fattened so they read at 10 px/m
# ------------------------------------------------------------------------------------------
def w_rifle(b, kind="kar98k"):
    long_ = 0.06 if kind == "mosin" else 0.0
    b.box("wood", (0.075, 0.30, 0.12), (0, -0.23, -0.035), rot=(-7, 0, 0), bevel=0.02)
    b.box("wood", (0.07, 0.62 + long_, 0.065), (0, 0.23 + long_ / 2, 0.0), bevel=0.015)
    b.box("metal", (0.06, 0.22, 0.05), (0, 0.04, 0.045), bevel=0.01)
    b.tube("metal", 0.026, 0.022, (0, 0.50, 0.015), (0, 0.84 + long_, 0.015), segs=8)
    if kind == "svt40":
        b.box("metal", (0.05, 0.08, 0.12), (0, 0.10, -0.08), bevel=0.008)                       # box magazine
        b.tube("metal", 0.034, 0.034, (0, 0.80, 0.015), (0, 0.88, 0.015), segs=8)               # muzzle brake
    else:
        b.ball("metal", 0.024, (0.05, -0.02, 0.05), segs=6, rings=4)                            # bolt handle
    if kind.endswith("scoped"):
        b.tube("metal", 0.024, 0.024, (0, -0.04, 0.10), (0, 0.22, 0.10), segs=8)


def w_smg(b, g):
    if g:
        b.box("metal", (0.07, 0.42, 0.07), (0, 0.13, 0.01), bevel=0.015)
        b.tube("metal", 0.022, 0.022, (0, 0.34, 0.015), (0, 0.50, 0.015), segs=8)
        b.box("metal", (0.045, 0.06, 0.24), (0, 0.19, -0.13), rot=(8, 0, 0), bevel=0.008)       # stick magazine
        b.box("leather", (0.05, 0.07, 0.10), (0, -0.04, -0.06), rot=(15, 0, 0), bevel=0.01)     # grip
        b.box("metal", (0.035, 0.27, 0.03), (0, -0.20, -0.005), bevel=0.006)                    # folding stock
        b.box("metal", (0.06, 0.03, 0.09), (0, -0.335, -0.02), bevel=0.006)
    else:
        b.box("wood", (0.075, 0.34, 0.11), (0, -0.20, -0.03), rot=(-6, 0, 0), bevel=0.02)
        b.box("metal", (0.068, 0.26, 0.065), (0, 0.06, 0.015), bevel=0.012)
        b.tube("metal", 0.036, 0.034, (0, 0.18, 0.02), (0, 0.47, 0.02), segs=8)                 # barrel jacket
        b.tube("metal", 0.085, 0.085, (0, 0.12, -0.10), (0, 0.12, -0.04), segs=12)              # drum


def w_lmg(b, g):
    if g:
        b.box("wood", (0.07, 0.26, 0.11), (0, -0.27, -0.01), rot=(-4, 0, 0), bevel=0.025)
        b.box("metal", (0.085, 0.46, 0.085), (0, 0.10, 0.01), bevel=0.015)
        b.tube("metal", 0.036, 0.034, (0, 0.33, 0.015), (0, 0.82, 0.015), segs=8)
        b.tube("metal", 0.026, 0.04, (0, 0.82, 0.015), (0, 0.90, 0.015), segs=8)
        b.tube("metal", 0.07, 0.07, (-0.115, 0.13, -0.04), (-0.045, 0.13, -0.04), segs=10)      # belt drum
        by = 0.70
    else:
        b.box("wood", (0.075, 0.30, 0.12), (0, -0.26, -0.03), rot=(-6, 0, 0), bevel=0.025)
        b.box("metal", (0.08, 0.40, 0.08), (0, 0.08, 0.01), bevel=0.015)
        b.tube("metal", 0.034, 0.03, (0, 0.28, 0.015), (0, 0.80, 0.015), segs=8)
        b.tube("metal", 0.03, 0.05, (0, 0.80, 0.015), (0, 0.90, 0.015), segs=8)                 # flash hider
        b.tube("metal", 0.14, 0.14, (0, 0.10, 0.055), (0, 0.10, 0.095), segs=14)                # pan magazine
        b.ball("metal", (0.05, 0.05, 0.02), (0, 0.10, 0.10), segs=8, rings=4)
        by = 0.66
    for sx in (-1, 1):
        b.tube("metal", 0.016, 0.014, (0, by, 0.0), (sx * 0.17, by + 0.04, -0.27), segs=6)


def w_pistol(b):
    b.box("metal", (0.05, 0.20, 0.055), (0, 0.06, 0.03), bevel=0.01)
    b.box("leather", (0.05, 0.07, 0.13), (0, -0.01, -0.05), rot=(14, 0, 0), bevel=0.01)


def w_stick_grenade(b):
    b.tube("wood", 0.022, 0.022, (0, -0.16, 0), (0, 0.10, 0), segs=8)
    b.tube("gear", 0.045, 0.045, (0, 0.10, 0), (0, 0.22, 0), segs=10)


def w_egg_grenade(b):
    b.ball("gear", (0.042, 0.06, 0.042), (0, 0, 0), segs=10, rings=6)
    b.tube("metal", 0.016, 0.016, (0, 0.05, 0), (0, 0.09, 0), segs=6)


def w_panzerfaust(b):
    b.tube("gear", 0.03, 0.03, (0, -0.45, 0), (0, 0.35, 0), segs=8)
    b.tube("gear", 0.035, 0.085, (0, 0.35, 0), (0, 0.47, 0), segs=10)
    b.tube("gear", 0.085, 0.03, (0, 0.47, 0), (0, 0.62, 0), segs=10)


def w_panzerschreck(b):
    b.tube("gear", 0.055, 0.055, (0, -0.80, 0), (0, 0.80, 0), segs=10)
    b.box("gear", (0.30, 0.02, 0.24), (0, 0.30, 0.03), bevel=0.004)                             # blast shield
    b.box("metal", (0.04, 0.10, 0.10), (0, -0.05, -0.08), bevel=0.008)


def w_ptrd(b):
    b.box("wood", (0.07, 0.30, 0.11), (0, -0.30, -0.02), bevel=0.02)
    b.box("metal", (0.07, 0.40, 0.075), (0, 0.05, 0.01), bevel=0.012)
    b.tube("metal", 0.028, 0.024, (0, 0.25, 0.015), (0, 1.32, 0.015), segs=8)
    b.box("metal", (0.06, 0.09, 0.05), (0, 1.34, 0.015), bevel=0.006)                           # muzzle brake
    for sx in (-1, 1):
        b.tube("metal", 0.016, 0.014, (0, 0.95, 0.0), (sx * 0.16, 0.98, -0.25), segs=6)


def w_satchel(b):
    b.box("pack", (0.26, 0.20, 0.10), (0, 0, 0), bevel=0.02)
    b.torus("leather", 0.10, 0.012, (0, 0.10, 0.03), rot=(0, 0, 0), sxy=(1.0, 0.8), seg=12, sides=5)


def w_ammo_box(b):
    b.box("gear", (0.36, 0.17, 0.15), (0, 0, 0), bevel=0.012)
    b.box("metal", (0.10, 0.03, 0.02), (0, 0, 0.085), bevel=0.004)


def w_belt_box(b):
    """MG belt box with a length of belt (origin at its base)."""
    b.box("gear", (0.22, 0.12, 0.14), (0, 0, 0.07), bevel=0.015)
    b.box("brass", (0.05, 0.30, 0.02), (0.0, 0.20, 0.13), bevel=0.004)


def w_mortar_bomb(b):
    """Long axis +Z, nose up."""
    b.ball("gear", (0.05, 0.05, 0.12), (0, 0, 0.0))
    b.tube("gear", 0.025, 0.02, (0, 0, -0.20), (0, 0, -0.08), segs=8)
    b.tube("metal", 0.045, 0.045, (0, 0, -0.22), (0, 0, -0.17), segs=8)


def w_shell(b):
    b.tube("brass", 0.05, 0.05, (0, 0, -0.26), (0, 0, 0.08), segs=10)
    b.tube("metal", 0.048, 0.012, (0, 0, 0.08), (0, 0, 0.27), segs=10)


def w_mortar_tube(b):
    b.tube("gear", 0.06, 0.055, (0, 0, -0.55), (0, 0, 0.55), segs=10)
    b.tube("metal", 0.064, 0.064, (0, 0, 0.50), (0, 0, 0.56), segs=10)


def w_baseplate(b):
    b.tube("gear", 0.27, 0.25, (0, 0, -0.03), (0, 0, 0.03), segs=14)
    b.box("metal", (0.10, 0.10, 0.05), (0, 0, 0.05), bevel=0.01)


def w_tripod(b):
    for k, x in enumerate((-0.07, 0.0, 0.07)):
        b.tube("gear", 0.026, 0.022, (x, 0.02 * (k == 1), -0.38), (x * 1.6, 0, 0.38), segs=6)
    b.box("metal", (0.18, 0.08, 0.10), (0, 0, 0.36), bevel=0.015)
