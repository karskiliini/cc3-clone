"""Validate completed production GLBs against every original procedural source variant.
No texture bake/render: blender -b -P tools/blender/vehicle_asset_check.py -- --out <json>
"""
import argparse
import hashlib
import json
import os
import struct
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicles as V
import vehicles_lowpoly as LP


def inspect_assets():
    manifest = json.load(open(os.path.join(LP.MODELS, 'vehicles.json')))['vehicles']
    guns, armor, fingerprints = LP.shared_geometry()
    defs = V.read_defs()
    if set(manifest) != set(V.VEHICLES): raise ValueError('catalog ids mismatch')
    result = {'models': {}, 'gunModels': len(guns), 'armorModels': len(armor), 'fingerprints': fingerprints}
    for vid, entry in manifest.items():
        if entry.get('modelOriginM') != {'x':0,'y':0,'z':0}: raise ValueError(vid+' missing origin')
        if entry.get('gunTrunnionM') != (dict(zip(('x','y','z'),guns[vid]['pivot'])) if vid in guns else None):
            raise ValueError(vid+' trunnion mismatch')
        if entry.get('armorProxy') != armor.get(vid) or entry.get('geometryFingerprints') != fingerprints:
            raise ValueError(vid+' authority mismatch')
        record = []
        for season in ('summer','winter'):
            variant = entry[season]
            if variant is None: continue
            filename = os.path.join(LP.MODELS,variant['file'])
            data = open(filename,'rb').read()
            magic,version,length = struct.unpack_from('<III',data)
            if magic != 0x46546c67 or version != 2 or length != len(data): raise ValueError(filename+' corrupt GLB')
            json_size = struct.unpack_from('<I',data,12)[0]
            gltf = json.loads(data[20:20+json_size])
            nodes = {node['name']:node for node in gltf['nodes'] if 'mesh' in node}
            if set(nodes) != set(variant['nodes']): raise ValueError(filename+' node names mismatch')
            for node in nodes.values():
                if node.get('translation',[0,0,0]) != [0,0,0] or 'rotation' in node or 'matrix' in node:
                    raise ValueError(filename+' transformed node origin')
            variants = []
            for part,state in LP.entries(vid,season):
                objects,_pivot,kit = V.build(vid,defs[vid],state,part,season)
                source_triangles = sum(len(face)-2 for face in kit.f)
                names = [part+'_'+state]
                if kit.gun: names += ['gun_'+state]
                if part == 'hull':
                    names += ['wheels_%s_%d_%s' % (wheel['side'],index,state) for index,wheel in enumerate(kit.wheels)]
                if any(name not in nodes for name in names): raise ValueError(filename+' missing split target '+str(names))
                exported_triangles = sum(gltf['accessors'][primitive['indices']]['count']//3
                    for name in names for primitive in gltf['meshes'][nodes[name]['mesh']]['primitives'])
                if exported_triangles != source_triangles:
                    raise ValueError('%s %s/%s triangle conservation failed %d != %d' % (filename,part,state,exported_triangles,source_triangles))
                if part == 'hull':
                    for side in ('L','R'):
                        material_ids = {primitive['material'] for name in names if name.startswith('wheels_'+side+'_')
                            for primitive in gltf['meshes'][nodes[name]['mesh']]['primitives']}
                        if len(material_ids) != 1: raise ValueError(filename+' individual wheels lost shared side material')
                    expected_wheels = [{'centreM':LP.sim_point(w['sourceCentre']),'radiusM':w['radiusM'],'side':w['side'],'index':i} for i,w in enumerate(kit.wheels)]
                    if expected_wheels != entry['wheels']: raise ValueError(filename+' source wheel centre/radius/ownership mismatch')
                variants.append({'part':part,'state':state,'sourceTriangles':source_triangles,'exportedTriangles':exported_triangles,'nodes':len(names)})
                LP.clear_scene()
            record.append({'season':season,'file':variant['file'],'sha256':hashlib.sha256(data).hexdigest(),
                'bytes':len(data),'nodes':len(nodes),'textures':len(gltf.get('textures',[])),'variants':variants})
        result['models'][vid] = record
    return result


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(); parser.add_argument('--out',required=True)
    args = parser.parse_args(argv)
    with open(args.out,'w') as file: json.dump(inspect_assets(),file,indent=1,sort_keys=True)
    print('completed catalog: exact source triangles, individual wheel/shared side materials, authorities and GLB frames passed')
