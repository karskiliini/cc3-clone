import { describe, it, expect } from 'vitest';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { bothTracksGeometry } from '@/render/vehicle3d/models';
import { grenadeFragments, markVehicleStrike } from '@/sim/impactMarks';
import { resolveVehicleHit, vehicleDamageView } from '@/sim/vehicleDamage';
import { WEAPONS } from '@/data/weapons';
import { Rng } from '@/shared/rng';
import { makeState, addTank, soldier } from './vehicleDamageHelpers';

describe('independent track damage and persistent strikes', () => {
  it('can destroy both tracks through real running-gear hits', () => {
    const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 30, y: 30 });
    for (const zone of ['runningGearL', 'runningGearR'] as const) {
      for (let i = 0; i < 40; i++) resolveVehicleHit(state, new Rng(i + 1), v, { weapon: WEAPONS.panzerfaust, shooterPos: { x: 32, y: 30 }, shooterSide: 'soviet', distM: 2, location: { zone, face: 'side' } });
    }
    expect(vehicleDamageView(v).brokenTrack).toBe('both');
  });
  it('records bounced small arms and penetrating gun hits on the correct part, without render RNG', () => {
    const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 30, y: 30 });
    resolveVehicleHit(state, new Rng(9), v, { weapon: WEAPONS.mp40, shooterPos: { x: 30, y: 20 }, shooterSide: 'soviet', distM: 20, location: { zone: 'turretFront', face: 'front' } });
    expect(v.strikeMarks).toHaveLength(1); expect(v.strikeMarks![0]).toMatchObject({ part: 'turret', penetrated: false });
    const first = { ...v.strikeMarks![0] }; v.pos = { x: 90, y: 90 }; v.turretFacing = 1.5;
    expect(v.strikeMarks![0]).toEqual(first);
    for (let i = 0; i < 100; i++) markVehicleStrike(v, null, false, true, 0.2);
    expect(v.strikeMarks).toHaveLength(64); expect(v.strikeMarks!.at(-1)!.penetrated).toBe(true);
  });
  it('combines damaged mesh halves with separate texture groups and retains vertex attributes', () => {
    function geometry(uv: number) {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([-2,0,0,-1,0,1,-1,1,0, 1,0,0,2,0,1,2,1,0],3));
      g.setAttribute('uv', new Float32BufferAttribute(Array(12).fill(uv),2)); return g;
    }
    const l = geometry(0.1), r = geometry(0.9), g = bothTracksGeometry(l,r);
    expect(g.getAttribute('position').count).toBe(6); expect(g.groups).toEqual([{ start:0,count:3,materialIndex:0 },{start:3,count:3,materialIndex:1}]);
    expect(g.getAttribute('uv').getX(0)).toBeCloseTo(0.1); expect(g.getAttribute('uv').getX(5)).toBeCloseTo(0.9);
    expect(l.getAttribute('position').count).toBe(6);
  });
  it('clips indexed triangles on the seam instead of dropping crossing faces', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-1,0,0,1,0,0,0,1,0],3));
    g.setAttribute('uv', new Float32BufferAttribute([0,0,1,0,0.5,1],2));g.setIndex([0,1,2]);
    const joined=bothTracksGeometry(g,g), pos=joined.getAttribute('position');
    for(const group of joined.groups)for(let i=group.start;i<group.start+group.count;i++){
      if(group.materialIndex===0)expect(pos.getX(i)).toBeLessThanOrEqual(0);else expect(pos.getX(i)).toBeGreaterThanOrEqual(0);
    }
    expect([...joined.getAttribute('uv').array].every(Number.isFinite)).toBe(true);
    expect(joined.boundingSphere!.radius).toBeGreaterThan(0);
  });

});

describe('grenade fragments', () => {
  it('leave deterministic ground scars, short flights, metal strikes and shattered glass; stop at solid surfaces', () => {
    const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 23, y: 20 });
    for (let y = 10; y <= 30; y++) { const i = y * state.map.width + 18; state.map.tiles[i] = 'buildingWood'; state.map.windows[i] = 1; }
    grenadeFragments(state, { x:20,y:20 }, WEAPONS.grenade);
    expect(state.map.fragmentMarks).toHaveLength(40); expect(state.map.fragmentFlights).toHaveLength(40);
    expect(state.map.shatteredWindows!.size).toBeGreaterThan(0); expect(v.strikeMarks!.length).toBeGreaterThan(0);
    expect(state.map.fragmentMarks!.every(m => m.pos.x >= 18)).toBe(true);
    expect(state.map.fragmentMarks!.some(m => m.material === 'dust')).toBe(true);
    expect(state.map.fragmentMarks!.some(m => m.material === 'wood' && m.glass)).toBe(true);
    const again = makeState(); addTank(again, 'pz4gh', { x:23,y:20 }); again.map.tiles = [...state.map.tiles]; again.map.windows.set(state.map.windows);
    grenadeFragments(again,{x:20,y:20},WEAPONS.grenade); expect(again.map.fragmentMarks).toEqual(state.map.fragmentMarks);
  });
  it('bounds persistent lists and does not create grenade fragments for small arms or demolition charges', () => {
    const s = makeState(); grenadeFragments(s,{x:20,y:20},WEAPONS.mp40); grenadeFragments(s,{x:20,y:20},WEAPONS.satchel); expect(s.map.fragmentMarks).toBeUndefined();
    for(let i=0;i<40;i++){s.time=i;grenadeFragments(s,{x:20,y:20},WEAPONS.grenade);}
    expect(s.map.fragmentMarks).toHaveLength(1200); expect(s.map.fragmentFlights).toHaveLength(40);
  });
  it('does not double-hit men inside HE radius, mounted crew or casualties', () => {
    const s=makeState(), a=soldier(100,1,'german',{x:20.2,y:20},'mp40'); s.soldiers.set(a.id,a);
    let hits=0; grenadeFragments(s,{x:20,y:20},WEAPONS.grenade,()=>hits++); expect(hits).toBe(0);
  });
  it('hits exposed men beyond the blast radius, respects posture and cannot pass a solid wall', () => {
    function scene(prone: boolean, walls: boolean) {
      const s = makeState(); grenadeFragments(s,{x:20,y:20},WEAPONS.grenade);
      const rays = s.map.fragmentFlights!;
      for (const [i,ray] of rays.entries()) {
        const dx=ray.to.x-20,dy=ray.to.y-20,len=Math.hypot(dx,dy);
        const man=soldier(100+i,1,'german',{x:20+dx/len*3,y:20+dy/len*3},'mp40');
        man.stance=prone?'prone':'standing';s.soldiers.set(man.id,man);
      }
      if(walls)for(let y=18;y<=22;y++)for(let x=18;x<=22;x++)if(x===18||x===22||y===18||y===22)s.map.tiles[y*s.map.width+x]='stonewall';
      const hitIds:number[]=[];grenadeFragments(s,{x:20,y:20},WEAPONS.grenade,man=>hitIds.push(man.id));
      expect(new Set(hitIds).size).toBe(hitIds.length);return hitIds.length;
    }
    const standing=scene(false,false);expect(standing).toBeGreaterThan(0);
    expect(scene(true,false)).toBeLessThan(standing);expect(scene(false,true)).toBe(0);
  });

});
