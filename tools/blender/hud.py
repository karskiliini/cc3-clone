"""HUD icons rendered headless with Cycles (multiplayer).

    blender -b -P tools/blender/hud.py -- [--samples 64]     # npm run sprites:hud

Writes public/hud/net_disconnected.png (36x36, straight alpha): the red "disconnected" sign the
battle view shows in its top-right corner while the network is in trouble (src/ui/hud/
netIndicator.ts). A pulled plug and its socket, apart, with a spark between them, on a dark disc
with a red rim — modelled as simple procedural shapes (boxes, cylinders, a bevelled curve for each
cable), rendered at 4x and box-filtered down so the 1:1 icon stays crisp.

Scene: metres, camera looks along +Y at the disc in the XZ plane, slightly from above.
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
OUT = os.path.join(ROOT, "public", "hud", "net_disconnected.png")
SIZE = 36      # final icon size (px)
SS = 4         # supersample


def args():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return int(a[a.index("--samples") + 1]) if "--samples" in a else 64


def link(name, me, mat):
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    return o


def box(name, center, size, mat, bevel=0.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=2, affect="EDGES")
    bm.to_mesh(me)
    bm.free()
    return link(name, me, mat)


def cyl(name, center, radius, depth, axis, mat, segs=32):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=radius, radius2=radius, depth=depth)
    rot = {"x": Matrix.Rotation(math.pi / 2, 3, "Y"), "y": Matrix.Rotation(math.pi / 2, 3, "X"), "z": Matrix.Identity(3)}[axis]
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=rot, verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    return link(name, me, mat)


def torus(name, radius, minor, mat):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    seg, ring = 64, 12
    verts = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        row = []
        for j in range(ring):
            b = 2 * math.pi * j / ring
            r = radius + minor * math.cos(b)
            row.append(bm.verts.new((r * math.cos(a), minor * math.sin(b) - 0.02, r * math.sin(a))))
        verts.append(row)
    for i in range(seg):
        for j in range(ring):
            bm.faces.new((verts[i][j], verts[(i + 1) % seg][j], verts[(i + 1) % seg][(j + 1) % ring], verts[i][(j + 1) % ring]))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    return link(name, me, mat)


def cable(name, pts, radius, mat):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = 4
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    o = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(o)
    cu.materials.append(mat)
    return o


def build():
    red = make_material("red", "#ff2a1a", roughness=0.35, emission=0.9)
    red_dark = make_material("red_dark", "#5a0804", roughness=0.5)
    metal = make_material("metal", "#d7d2c8", roughness=0.25, metallic=1.0)
    disc = make_material("disc", "#100a09", roughness=0.6)
    hole = make_material("hole", "#080302", roughness=0.9)
    spark = make_material("spark", "#ffd678", emission=6.0)
    rim = make_material("rim", "#ff281a", roughness=0.3, emission=1.2)

    # the disc and its red rim, facing the camera
    cyl("disc", (0, 0.06, 0), 0.92, 0.04, "y", disc, segs=96)
    torus("rim", 0.9, 0.065, rim)

    # left: the plug body, its two prongs pointing right at the gap, the cable to the lower left
    box("plug", (-0.36, -0.08, 0.0), (0.30, 0.22, 0.40), red, bevel=0.03)
    box("plug_grip", (-0.55, -0.08, 0.0), (0.10, 0.18, 0.26), red, bevel=0.02)
    for z in (0.1, -0.1):
        cyl(f"prong{z}", (-0.11, -0.08, z), 0.05, 0.24, "x", metal)
    cable("plug_cable", [(-0.6, -0.08, 0.0), (-0.74, -0.08, -0.26), (-0.5, -0.08, -0.66)], 0.075, red)

    # right: the socket with its two holes, the cable to the upper right
    box("socket", (0.38, -0.08, 0.0), (0.30, 0.22, 0.44), red, bevel=0.03)
    for z in (0.1, -0.1):
        cyl(f"hole{z}", (0.225, -0.08, z), 0.055, 0.02, "x", hole)
    box("socket_back", (0.56, -0.08, 0.0), (0.08, 0.2, 0.3), red_dark, bevel=0.02)
    cable("socket_cable", [(0.6, -0.08, 0.0), (0.74, -0.08, 0.26), (0.5, -0.08, 0.66)], 0.075, red)

    # the spark in the gap: two short bright strokes
    for i, (x0, z0, x1, z1) in enumerate(((0.02, 0.38, -0.04, 0.22), (-0.02, -0.38, 0.04, -0.22))):
        cable(f"spark{i}", [(x0, -0.12, z0), (x1, -0.12, z1)], 0.022, spark)


def render(samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.device = "CPU"
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = SIZE * SS
    scene.view_settings.view_transform = "Standard"

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.0
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, -4, 0.35)
    cam.rotation_euler = (math.radians(90 - 5), 0, 0)
    scene.camera = cam

    key = bpy.data.lights.new("key", "AREA")
    key.energy = 60
    key.size = 2.0
    k = bpy.data.objects.new("key", key)
    scene.collection.objects.link(k)
    k.location = (-1.6, -3.0, 2.2)
    k.rotation_euler = Vector((1.6, 3.0, -2.2)).to_track_quat("-Z", "Y").to_euler()

    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[1].default_value = 0.15

    path = os.path.join(bpy.app.tempdir, "hud_net.png")
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    a = buf.reshape(h, w, 4)[::-1]
    # box-filter down SSxSS with premultiplied colour, back to straight alpha
    pre = a.copy()
    pre[..., :3] *= pre[..., 3:4]
    small = pre.reshape(SIZE, SS, SIZE, SS, 4).mean(axis=(1, 3))
    alpha = small[..., 3:4]
    rgb = np.where(alpha > 1e-4, small[..., :3] / np.maximum(alpha, 1e-4), 0)
    out = np.concatenate([np.clip(rgb, 0, 1), alpha], axis=-1)
    return (out * 255 + 0.5).astype(np.uint8)


def main():
    samples = args()
    clear_scene()
    build()
    save_png(OUT, render(samples))
    print("wrote", OUT)


main()
