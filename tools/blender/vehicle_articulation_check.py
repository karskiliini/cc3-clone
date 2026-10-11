"""Lightweight source-geometry contract/parity check (no render or texture bake).
blender -b -P tools/blender/vehicle_articulation_check.py -- --out <json>
"""
import hashlib
import argparse
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicles as V
import vehicles_lowpoly as LP


def inspect_sources():
    guns, armor, fingerprints = LP.shared_geometry()
    out = {'fingerprints': fingerprints, 'exporterSHA256': hashlib.sha256(open(LP.__file__,'rb').read()).hexdigest(), 'vehicles': {}}
    for vid, d in V.read_defs().items():
        if vid not in V.VEHICLES:
            continue
        kit = V.Kit(vid)
        pv, zr = V.VEHICLES[vid][0](kit, d, False)
        barrel_kit = kit
        if d['hasTurret']:
            barrel_kit = V.Kit(vid + '_turret')
            V.VEHICLES[vid][1](barrel_kit, d, False, zr, False)
        gun = guns.get(vid)
        if bool(gun) != bool(barrel_kit.gun):
            raise ValueError('%s barrel ownership mismatch' % vid)
        if gun:
            actual = LP.sim_point(barrel_kit.gun['pivot'])
            for i, axis in enumerate(('x','y','z')):
                if abs(actual[axis] - gun['pivot'][i]) > 1e-10:
                    raise ValueError('%s pivot mismatch %r %r' % (vid,actual,gun))
            if abs(barrel_kit.gun['barrelM'] - gun['barrelM']) > 1e-10:
                raise ValueError('%s barrel length mismatch' % vid)
            if d['hasTurret'] and any(abs(gun['ring'][i] - (pv[0],-pv[1],0)[i]) > 1e-10 for i in range(3)):
                raise ValueError('%s ring mismatch' % vid)
        for source in (kit, barrel_kit) if d['hasTurret'] else (kit,):
            fragments = [source.extract(tag) for tag in ('fixed','gun','wheels_L','wheels_R')]
            if sum(len(fragment.f) for fragment in fragments) != len(source.f):
                raise ValueError('%s source face conservation failed' % vid)
            original = sorted((tuple(source.v[v] for v in face), source.mats[source.mi[i]]) for i, face in enumerate(source.f))
            split = sorted((tuple(frag.v[v] for v in face), frag.mats[frag.mi[i]]) for frag in fragments for i, face in enumerate(frag.f))
            if original != split:
                raise ValueError('%s source-space material/coordinate conservation failed' % vid)
            if len(source.tags) != len(source.f):
                raise ValueError('%s unowned source faces' % vid)
        variants = []
        # Damage/winter topology must conserve the actual transformed source too.
        for season in ('summer','winter'):
            if season == 'winter' and vid in V.NO_WASH: continue
            for part,state in LP.entries(vid,season):
                objects,_pv,source = V.build(vid,d,state,part,season)
                fragments = [source.extract(tag) for tag in ('fixed','gun','wheels_L','wheels_R')]
                original = sorted((tuple(source.v[v] for v in face),source.mats[source.mi[i]]) for i,face in enumerate(source.f))
                split = sorted((tuple(frag.v[v] for v in face),frag.mats[frag.mi[i]]) for frag in fragments for i,face in enumerate(frag.f))
                if original != split or len(source.tags) != len(source.f):
                    raise ValueError('%s %s/%s/%s transformed source conservation failed' % (vid,season,part,state))
                variants.append({'season':season,'part':part,'state':state,'faces':len(source.f),
                    'splitFaces':sum(len(frag.f) for frag in fragments),'wheels':len(source.wheels)})
                LP.clear_scene()
        out['vehicles'][vid] = {'ring': pv, 'gun': barrel_kit.gun, 'hullFaces': len(kit.f),
            'turretFaces': len(barrel_kit.f) if d['hasTurret'] else 0,
            'wheels': kit.wheels, 'armor': armor.get(vid), 'variants': variants}
    return out


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(); parser.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    with open(args.out,'w') as file:
        json.dump(inspect_sources(),file,sort_keys=True,indent=1)
    print('source articulation contract passed')
