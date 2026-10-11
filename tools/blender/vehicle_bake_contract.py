"""Small non-rendering bake ownership proof; no asset output and no real texture bake.
blender -b -P tools/blender/vehicle_bake_contract.py -- --out <json>
"""
import argparse
import hashlib
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import vehicles as V
import vehicles_lowpoly as LP


def prove():
    results = []
    for vid, part, state, season, assembly in [
        ('t34_76','turret','ok','summer','gun'), ('t34_76','turret','blown','summer','gun'),
        ('stug3g','hull','ok','winter','gun'), ('sdkfz251_rocket','hull','ok','winter','wheels_L'),
    ]:
        LP.clear_scene()
        objects, _pivot, kit = V.build(vid,V.read_defs()[vid],state,part,season)
        full = objects[0][0]
        for extra,_vis in objects[1:]: bpy.data.objects.remove(extra)
        material_map = dict(zip(kit.mats, full.data.materials))
        source_signature = [(tuple(v.co),) for v in full.data.vertices]
        source_materials = tuple(full.data.materials)
        fragment = kit.extract(assembly)
        target_source = fragment.build(material_map)
        observations = []
        def capture_operator(**arguments):
            selected = set(bpy.context.selected_objects)
            active = bpy.context.view_layer.objects.active
            visible = {ob for ob in bpy.data.objects if not ob.hide_render}
            if visible != {full,active} or selected != {full,active}:
                raise ValueError('bake visibility/selection failed')
            if target_source in visible or active is full:
                raise ValueError('fragment duplicated or full source used as target')
            if [(tuple(v.co),) for v in full.data.vertices] != source_signature or tuple(full.data.materials) != source_materials:
                raise ValueError('source coordinates/material identities mutated')
            if not any(node.type == 'AMBIENT_OCCLUSION' for mat in full.data.materials if mat.use_nodes for node in mat.node_tree.nodes):
                raise ValueError('original source AO graph missing')
            if arguments['type'] != 'DIFFUSE' or arguments['pass_filter'] != {'COLOR'} or not arguments['use_selected_to_active']:
                raise ValueError('legacy bake mode changed')
            observations.append({'source': full.name, 'sourceFaces':len(full.data.polygons), 'targetFaces':len(active.data.polygons),
                'visible':sorted(ob.name for ob in visible), 'sourceAO':True, 'unchangedSourceCoordinatesMaterials':True})
            return {'FINISHED'}
        baked = LP.lowpoly(target_source,assembly+'_'+state,10000,64,bake_source=full,bake_operator=capture_operator)
        if assembly.startswith('wheels_'):
            side_uvs = sorted(tuple(loop.uv) for loop in baked.data.uv_layers.active.data)
            material = baked.data.materials[0]
            wheels = LP.split_wheels(baked,kit,state)
            individual_uvs = sorted(tuple(loop.uv) for wheel in wheels for loop in wheel.data.uv_layers.active.data)
            if side_uvs != individual_uvs or any(wheel.data.materials[0] is not material for wheel in wheels):
                raise ValueError('shared side bake/material/UV conservation failed')
            observations[0].update({'individualWheels':len(wheels),'sharedMaterialIdentity':True,'allSideUVsConserved':True})
        results.append({'vehicle':vid,'part':part,'state':state,'season':season,'assembly':assembly,'observations':observations})
    return {'exporterSHA256':hashlib.sha256(open(LP.__file__,'rb').read()).hexdigest(), 'results':results}


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(); parser.add_argument('--out',required=True)
    args = parser.parse_args(argv)
    with open(args.out,'w') as file: json.dump(prove(),file,indent=1,sort_keys=True)
    print('original AO source/visibility and shared-side individual-wheel bake contract passed')
