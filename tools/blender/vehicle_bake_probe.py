"""Bounded legacy joined vs split full-source albedo fidelity probe, mini only.
blender -b -P tools/blender/vehicle_bake_probe.py -- --out <run directory>
"""
import argparse
import hashlib
import json
import math
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
import vehicles as V
import vehicles_lowpoly as LP


def capture(objects, output, view, subject):
    for ob in bpy.data.objects: ob.hide_render = ob not in objects
    for ob in objects:
        for mat in ob.data.materials:
            nodes = mat.node_tree.nodes
            image = next(nd.image for nd in nodes if nd.type == 'TEX_IMAGE')
            nodes.clear()
            tex = nodes.new('ShaderNodeTexImage'); tex.image = image
            emission = nodes.new('ShaderNodeEmission')
            dest = nodes.new('ShaderNodeOutputMaterial')
            mat.node_tree.links.new(tex.outputs['Color'],emission.inputs['Color'])
            mat.node_tree.links.new(emission.outputs[0],dest.inputs['Surface'])
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new('probe_camera'); camera_data.type = 'ORTHO'
    camera = bpy.data.objects.new('probe_camera',camera_data); scene.collection.objects.link(camera)
    points = [ob.matrix_world @ vertex.co for ob in objects for vertex in ob.data.vertices]
    lo = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    hi = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    target = (lo + hi) / 2
    camera.location = target + Vector((10,8,7) if view == 'oblique' else (-12,0,0.3))
    camera.rotation_euler = (target-camera.location).to_track_quat('-Z','Y').to_euler()
    inverse = camera.rotation_euler.to_matrix().transposed()
    projected = [inverse @ (point-target) for point in points]
    span_x = max(point.x for point in projected)-min(point.x for point in projected)
    span_y = max(point.y for point in projected)-min(point.y for point in projected)
    camera_data.ortho_scale = max(span_x,span_y * 1000/650) * 1.2
    scene.camera = camera
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 1000; scene.render.resolution_y = 650; scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'; scene.render.filepath = output
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'; scene.view_settings.exposure = 0; scene.view_settings.gamma = 1
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera); bpy.data.cameras.remove(camera_data)


def probe(output):
    cases = [('summer-hull','hull','ok','summer'),('winter-turret','turret','ok','winter'),('damaged-turret','turret','ko','summer'),('blown-turret','turret','blown','summer')]
    guns,_armor,_fingerprints=LP.shared_geometry()
    records = []
    for name,part,state,season in cases:
        LP.clear_scene(); LP.setup_cycles()
        defs = V.read_defs(); objects,pivot,kit = V.build('panther',defs['panther'],state,part,season)
        full = objects[0][0]
        for extra,_vis in objects[1:]: bpy.data.objects.remove(extra)
        materials = dict(zip(kit.mats,full.data.materials))
        size = LP.TEX_STATE.get(state) or LP.TEX[part]
        legacy = LP.lowpoly(full,'legacy_'+name,LP.BUDGET[part],size)
        corrected = []
        for assembly in ('fixed','gun','wheels_L','wheels_R'):
            fragment=kit.extract(assembly)
            if not fragment.f: continue
            target=fragment.build(materials)
            baked=LP.lowpoly(target,assembly+'_'+state,LP.BUDGET[part],size,bake_source=full)
            bpy.data.objects.remove(target)
            if assembly.startswith('wheels_'):
                wheels=LP.split_wheels(baked,kit,state)
                for wheel in wheels:
                    index=int(wheel.name.split('_')[2]); wheel.location=kit.wheels[index]['sourceCentre']
                corrected.extend(wheels)
            elif assembly == 'gun':
                point=guns['panther']['pivot']; point=Vector((point[0],-point[1],point[2]))
                for vertex in baked.data.vertices: vertex.co -= point
                baked.location=point; corrected.append(baked)
            else: corrected.append(baked)
        for view in ('oblique','side'):
            capture([legacy],os.path.join(output,name+'-'+view+'-legacy.png'),view,part)
            capture(corrected,os.path.join(output,name+'-'+view+'-split.png'),view,part)
        records.append({'case':name,'legacyTriangles':sum(len(p.vertices)-2 for p in legacy.data.polygons),
            'splitTriangles':sum(sum(len(p.vertices)-2 for p in ob.data.polygons) for ob in corrected),
            'texturePx':size,'samples':LP.SAMPLES,'completeSourceFaces':len(full.data.polygons),
            'splitNodes':len(corrected),'exporterSHA256':hashlib.sha256(open(LP.__file__,'rb').read()).hexdigest()})
    with open(os.path.join(output,'probe.json'),'w') as file: json.dump(records,file,indent=1,sort_keys=True)


if __name__ == '__main__':
    argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser=argparse.ArgumentParser(); parser.add_argument('--out',required=True)
    args=parser.parse_args(argv); os.makedirs(args.out,exist_ok=True); probe(args.out)
