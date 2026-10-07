"""Low-poly glTF vehicles for the real-time 3D renderer (BACKLOG 050, P1).

  blender -b -P tools/blender/vehicles_lowpoly.py -- [--only t34_76,kv1] [--season summer|winter|both]

Every atlas entry of tools/blender/vehicles.py (hull.ok/ko/blown/trackL/trackR, turret.ok/ko/blown)
is built from the same procedural model, collapse-decimated to its budget, smart-UV unwrapped, and
baked (Cycles, CPU) selected-to-active from the full-detail model into one albedo texture (the paint
materials already darken cavities with their own AO node, so no separate AO pass).  One GLB per vehicle (public/models/<id>.glb, whitewashed live looks in <id>_winter.glb),
nodes named hull_ok ... turret_blown (underscores: three.js strips dots from node names); hull nodes
are built about the hull centre, turret nodes about their turret-ring centre (vehicles.FRAME axes).  public/models/vehicles.json is the manifest the game reads.
"""
import json
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicles as V  # noqa: E402
import vehicles_common as VC  # noqa: E402

MODELS = os.path.join(VC.ROOT, "public", "models")
BUDGET = {"hull": 4000, "turret": 2000}     # triangles per node: above every source model, so nothing is decimated
                                            # (collapse decimation warped decks: a pale triangle on the Panther)
BUDGET_OVERRIDE = {"t28": {"hull": 4400}}    # the T-28 wreck hulls are ~4200 triangles
TEX = {"hull": 1024, "turret": 1024}        # baked texture size (px): 256 and 512 blurred camo, hatches, fans
TEX_OVERRIDE = {}                           # {"<defId>": {"turret": n}}
TEX_STATE = {"ko": 512, "blown": 512}       # burnt looks: dark, rarely studied; quarter the VRAM of 1024
SAMPLES = 16


def log(s):
    print("[lowpoly] " + s, flush=True)


def clear_scene():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for it in list(coll):
            coll.remove(it)


def setup_cycles():
    sc = bpy.context.scene
    try:
        sc.render.engine = "CYCLES"
    except TypeError as e:
        raise SystemExit("Cycles not available: %s" % e)
    sc.cycles.device = "CPU"          # a GPU OOM once crashed a long bake (dune-cc-hybrid exporter)
    sc.cycles.samples = SAMPLES
    sc.render.bake.margin = 4


def select_only(*objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[-1]


def tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def bake_image(lo, src, name, size):
    """Bake the colour of src into a fresh float image on lo (selected-to-active).  Only the two
    objects taking part are renderable."""
    for o in bpy.data.objects:
        o.hide_render = o not in (lo, src)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=True)
    mat = bpy.data.materials.new("bake_" + name)
    mat.use_nodes = True
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    mat.node_tree.nodes.active = node
    lo.data.materials.clear()
    lo.data.materials.append(mat)
    lo.data.polygons.foreach_set("material_index", [0] * len(lo.data.polygons))
    select_only(src, lo)
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                        cage_extrusion=0.03, max_ray_distance=0.12, margin=4)
    return img


def linear_to_srgb(a):
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(np.clip(a, 0, None), 1 / 2.4) - 0.055)


def lowpoly(src, name, budget, size):
    """Decimated, unwrapped copy of src with one baked albedo material."""
    lo = bpy.data.objects.new(name, src.data.copy())
    bpy.context.scene.collection.objects.link(lo)
    n = tri_count(lo.data)
    if n > budget:
        mod = lo.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = budget / n * 0.97
        select_only(lo)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    select_only(lo)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.quads_convert_to_tris()
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.03)
    bpy.ops.object.mode_set(mode="OBJECT")
    albedo = bake_image(lo, src, name + "_albedo", size)
    a = np.array(albedo.pixels[:], dtype=np.float32).reshape(-1, 4)
    a[:, :3] = linear_to_srgb(a[:, :3])
    a[:, 3] = 1.0
    final = bpy.data.images.new(name, size, size, alpha=False)       # byte image, sRGB
    final.pixels[:] = np.clip(a, 0, 1).ravel()
    final.pack()
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(nd for nd in mat.node_tree.nodes if nd.type == "BSDF_PRINCIPLED")
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = final
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Metallic"].default_value = 0.0
    lo.data.materials.clear()
    lo.data.materials.append(mat)
    for o_ in bpy.data.objects:
        o_.hide_render = False
    log("  %s: %d -> %d tris" % (name, n, tri_count(lo.data)))
    return lo


def entries(vid, season):
    turreted = bool(V.VEHICLES[vid][1])
    todo = [("hull", st) for st in V.HULL_STATES
            if (turreted or st != "blown") and not (vid in V.NO_TRACK and st.startswith("track"))]
    if turreted:
        todo += [("turret", st) for st in V.TURRET_STATES]
    if season == "winter":
        todo = [(p, st) for (p, st) in todo if st in V.WINTER_STATES]
    return todo


def export_vehicle(vid, d, season):
    clear_scene()
    setup_cycles()
    out, pivot = [], None
    for part, st in entries(vid, season):
        objs, pv, _k = V.build(vid, d, st, part, season)
        pivot = pivot or pv
        src = objs[0][0]
        for extra, _vis in objs[1:]:          # the hull's turret-ring drum: only the sprites need it
            bpy.data.objects.remove(extra)
        budget = BUDGET_OVERRIDE.get(vid, {}).get(part, BUDGET[part])
        size = TEX_STATE.get(st) or TEX_OVERRIDE.get(vid, {}).get(part, TEX[part])
        out.append(lowpoly(src, "%s_%s" % (part, st), budget, size))
        bpy.data.objects.remove(src)
    fname = "%s%s.glb" % (vid, "_winter" if season == "winter" else "")
    select_only(*out)
    os.makedirs(MODELS, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(MODELS, fname), export_format="GLB", use_selection=True,
                              export_yup=True, export_apply=True, export_image_format="WEBP",
                              export_materials="EXPORT", export_texcoords=True, export_normals=True)
    return {"file": fname, "nodes": [o.name for o in out]}, pivot


def main():
    import argparse
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--season", default="both", choices=["summer", "winter", "both"])
    args = ap.parse_args(argv)
    defs = V.read_defs()
    ids = [i for i in args.only.split(",") if i] or list(V.VEHICLES.keys())
    mpath = os.path.join(MODELS, "vehicles.json")
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {"version": 1, "frame": V.FRAME, "vehicles": {}}
    for vid in ids:
        d = defs[vid]
        entry = manifest["vehicles"].get(vid, {})
        entry.update({"hasTurret": bool(V.VEHICLES[vid][1]), "lengthM": d["L"], "widthM": d["W"]})
        if args.season in ("summer", "both"):
            log("%s summer" % vid)
            entry["summer"], pv = export_vehicle(vid, d, "summer")
            entry["turretPivotM"] = {"x": round(pv[0], 3), "y": round(pv[1], 3)} if (pv and entry["hasTurret"]) else None
        if args.season in ("winter", "both"):
            if vid in V.NO_WASH:
                entry["winter"] = None
            else:
                log("%s winter" % vid)
                entry["winter"], _ = export_vehicle(vid, d, "winter")
        entry.setdefault("winter", None)
        manifest["vehicles"][vid] = entry
        with open(mpath, "w") as fh:          # written after every vehicle: an interrupted run keeps its work
            json.dump(manifest, fh, indent=1, sort_keys=True)
    log("done: %d vehicles" % len(ids))


if __name__ == "__main__":
    main()
