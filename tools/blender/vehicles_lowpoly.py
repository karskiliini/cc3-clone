"""Low-poly glTF vehicles for the real-time 3D renderer (BACKLOG 050, P1).

  blender -b -P tools/blender/vehicles_lowpoly.py -- [--only t34_76,kv1] [--season summer|winter|both]

Every atlas entry of tools/blender/vehicles.py (hull.ok/ko/blown/trackL/trackR, turret.ok/ko/blown)
is built from the same procedural model, collapse-decimated to its budget, smart-UV unwrapped, and
split before baking (Cycles, CPU) selected-to-active from the complete original same-part source
into one albedo texture per fixed/gun/side assembly (the paint
materials already darken cavities with their own AO node, so no separate AO pass).  One GLB per vehicle (public/models/<id>.glb, whitewashed live looks in <id>_winter.glb),
nodes retain hull_ok ... turret_blown and add gun and independently centred wheels (underscores:
three.js strips dots from node names); hull nodes
are built about the hull centre, turret nodes about their turret-ring centre (vehicles.FRAME axes).  public/models/vehicles.json is the manifest the game reads.
"""
import json
import math
import os
import re
import hashlib
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


def bake_image(lo, src, name, size, bake_operator=None):
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
    (bake_operator or bpy.ops.object.bake)(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                        cage_extrusion=0.03, max_ray_distance=0.12, margin=4)
    return img


def linear_to_srgb(a):
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * np.power(np.clip(a, 0, None), 1 / 2.4) - 0.055)


def lowpoly(src, name, budget, size, bake_source=None, bake_operator=None):
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
    albedo = bake_image(lo, bake_source or src, name + "_albedo", size, bake_operator=bake_operator)
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


def shared_geometry():
    """Read the existing deterministic TS authorities; refuse mismatched source frames."""
    gun_path = os.path.join(VC.ROOT, 'src/data/vehicleGunGeometry.ts')
    armor_path = os.path.join(VC.ROOT, 'src/data/vehicleArmorGeometry.ts')
    guns = {}
    for match in re.finditer(r'(\w+): g\(([^)]+)\)', open(gun_path).read()):
        rx, forward, x, gun_forward, z, length = map(float, match[2].split(','))
        guns[match[1]] = {'ring': (rx, -forward, 0), 'pivot': (x, -gun_forward, z), 'barrelM': length}
    armor = {}
    for match in re.finditer(r"(\w+): box\('[^']+', ([^)]+)\)", open(armor_path).read()):
        x0,y0,z0,x1,y1,z1 = map(float, match[2].split(','))
        armor[match[1]] = {'min': {'x': x0, 'y': -y1, 'z': z0}, 'max': {'x': x1, 'y': -y0, 'z': z1}}
    return guns, armor, {'gun': hashlib.sha256(open(gun_path,'rb').read()).hexdigest(),
                          'armor': hashlib.sha256(open(armor_path,'rb').read()).hexdigest()}


def sim_point(p):
    return {'x': p[0], 'y': -p[1], 'z': p[2]}


def split_wheels(lo, kit, state):
    """One side bake/material, individual wheel meshes with preserved UVs and own origins."""
    import bmesh
    out = []
    for index, wheel in enumerate(kit.wheels):
        side = wheel['side']
        if not lo.name.startswith('wheels_' + side + '_'):
            continue
        if not any(tag == ('wheels_' + side, index) for tag in kit.tags):
            continue
        me = lo.data.copy()
        bm = bmesh.new(); bm.from_mesh(me)
        layer = bm.faces.layers.int.get('wheel_id')
        if layer is None:
            raise ValueError('wheel source ownership lost during bake')
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != index], context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        centre = wheel['sourceCentre']
        for v in bm.verts:
            v.co -= VC.Vector(centre)
        bm.to_mesh(me); bm.free(); me.update()
        if not len(me.polygons):
            raise ValueError('wheel source faces lost during bake')
        ob = bpy.data.objects.new('wheels_%s_%d_%s' % (side,index,state), me)
        bpy.context.scene.collection.objects.link(ob); out.append(ob)
    bpy.data.objects.remove(lo)
    return out


def export_vehicle(vid, d, season):
    clear_scene(); setup_cycles()
    out, pivot, metadata = [], None, None
    guns, armor, fingerprints = shared_geometry()
    geometry = guns.get(vid)
    for part, st in entries(vid, season):
        objs, pv, kit = V.build(vid, d, st, part, season)
        pivot = pivot or pv
        bake_source = objs[0][0]
        # Same complete original part as the legacy selected-to-active bake: paint AO
        # sees all neighboring source primitives, while each target topology is split.
        for obj, _vis in objs[1:]:
            bpy.data.objects.remove(obj)
        source_materials = dict(zip(kit.mats, bake_source.data.materials))
        if st == 'ok' and part == ('turret' if d['hasTurret'] else 'hull'):
            if bool(kit.gun) != bool(geometry):
                raise ValueError('%s shared barrel ownership mismatch' % vid)
            if geometry:
                actual = sim_point(kit.gun['pivot'])
                if any(abs(actual[a]-geometry['pivot'][i]) > 1e-10 for i,a in enumerate(('x','y','z'))) or abs(kit.gun['barrelM']-geometry['barrelM']) > 1e-10:
                    raise ValueError('%s shared trunnion/barrel mismatch: %r vs %r' % (vid, actual, geometry))
        if st == 'ok' and part == 'hull':
            ring = (pv[0], -pv[1], 0) if pv and d['hasTurret'] else None
            if geometry and d['hasTurret'] and any(abs(ring[i]-geometry['ring'][i]) > 1e-10 for i in range(3)):
                raise ValueError('%s shared turret ring mismatch' % vid)
            metadata = {'modelOriginM': {'x':0,'y':0,'z':0},
                'turretPivot3M': dict(zip(('x','y','z'),ring)) if ring else None,
                'gunTrunnionM': dict(zip(('x','y','z'),geometry['pivot'])) if geometry else None,
                'wheels': [{'centreM': sim_point(w['sourceCentre']), 'radiusM': w['radiusM'], 'side': w['side'], 'index': i} for i,w in enumerate(kit.wheels)],
                'armorProxy': armor.get(vid), 'geometryFingerprints': fingerprints}
        budget = BUDGET_OVERRIDE.get(vid, {}).get(part, BUDGET[part])
        size = TEX_STATE.get(st) or TEX_OVERRIDE.get(vid, {}).get(part, TEX[part])
        for assembly in ('fixed', 'gun', 'wheels_L', 'wheels_R'):
            fragment = kit.extract(assembly)
            if not fragment.f:
                continue
            # Preserve the already bent/askew wreck shape; articulate only live elevation/recoil.
            src = fragment.build(source_materials)
            name = '%s_%s' % (part if assembly == 'fixed' else assembly, st)
            lo = lowpoly(src, name, budget, size, bake_source=bake_source)
            bpy.data.objects.remove(src)
            if assembly == 'gun':
                # Bake in original coordinates so procedural camouflage/dust is unchanged.
                p = geometry['pivot']
                source_p = VC.Vector((p[0], -p[1], p[2]))
                for vertex in lo.data.vertices:
                    vertex.co -= source_p
            out.extend(split_wheels(lo, kit, st) if assembly.startswith('wheels_') else [lo])
        bpy.data.objects.remove(bake_source)
    fname = '%s%s.glb' % (vid, '_winter' if season == 'winter' else '')
    select_only(*out); os.makedirs(MODELS, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(MODELS, fname), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_image_format='WEBP', export_materials='EXPORT', export_texcoords=True, export_normals=True)
    return {'file': fname, 'nodes': [o.name for o in out]}, pivot, metadata


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
            entry["summer"], pv, metadata = export_vehicle(vid, d, "summer")
            entry.update(metadata)
            entry["turretPivotM"] = {"x": round(pv[0], 3), "y": round(pv[1], 3)} if (pv and entry["hasTurret"]) else None
        if args.season in ("winter", "both"):
            if vid in V.NO_WASH:
                entry["winter"] = None
            else:
                log("%s winter" % vid)
                entry["winter"], _, _metadata = export_vehicle(vid, d, "winter")
        entry.setdefault("winter", None)
        manifest["vehicles"][vid] = entry
        with open(mpath, "w") as fh:          # written after every vehicle: an interrupted run keeps its work
            json.dump(manifest, fh, indent=1, sort_keys=True)
    log("done: %d vehicles" % len(ids))


if __name__ == "__main__":
    main()
