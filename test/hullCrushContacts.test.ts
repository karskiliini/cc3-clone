import { expect, it } from 'vitest';
import { makeState, addTank } from './vehicleDamageHelpers';
import { prepareCrushableLineInterest, crushableLineSourcesAt, getHeightField, buildHeightField, setTileProfile, refreshTile, HF_RES } from '@/sim/heightField';
import { crushTile } from '@/sim/structures';
import { stepVehicles } from '@/sim/vehicle';
import { createHullBody, stepHullBody } from '@/sim/hullPhysics';
import { groundProbe } from '@/sim/hullGround';
import { hullParams } from '@/data/vehiclePhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { add, rotate } from '@/sim/hullMath';
import { Rng } from '@/shared/rng';
import { rig } from './hullPhysicsHelpers';
import { TERRAIN_PROPS } from '@/sim/terrain';
import type { Vec3 } from '@/shared/types';

function fenceMap(diagonal = false) {
  const state = makeState(), map = state.map;
  map.def = { ...map.def, vectors: [{ kind: 'line', terrain: 'fence', width: 1, points: diagonal
    ? [{ x: 10, y: 10 }, { x: 12, y: 12 }] : [{ x: 4, y: 10 }, { x: 18, y: 10 }] }] };
  if (diagonal) for (let i = 10; i <= 12; i++) map.tiles[i * map.width + i] = 'fence';
  else for (let x = 4; x <= 18; x++) map.tiles[10 * map.width + x] = 'fence';
  return state;
}

it('crushes the winning fence source from actual contact before the accepted box reaches its tile', () => {
  const state = fenceMap(), { v, team } = addTank(state, 'pz4gh', { x: 10.5, y: 7 }, Math.PI);
  const goal = { x: 10.5, y: 15 }; team.order = { type: 'move', target: goal, issuedAt: 0 }; v.path = [goal];
  const rng = new Rng(3), p = hullParams(VEHICLE_DEFS.pz4gh); let firstCrushFront = Infinity;
  for (let i = 0; i < 100; i++) {
    state.time += .1; stepVehicles(state, rng, .1);
    if (state.map.tiles[10 * state.map.width + 10] !== 'fence') {
      firstCrushFront = -Infinity;
      for (const x of [p.solidBox.min.x,p.solidBox.max.x]) for (const y of [p.solidBox.min.y,p.solidBox.max.y]) for (const z of [p.solidBox.min.z,p.solidBox.max.z])
        firstCrushFront = Math.max(firstCrushFront, add(v.body!.position, rotate(v.body!.orientation,{x,y,z})).y / 2);
      break;
    }
  }
  expect(firstCrushFront).toBeLessThan(10);
  expect(firstCrushFront).toBeGreaterThan(9.5);
});

it('observes only positively loaded or supported accepted contacts, never airborne or rejected candidate positions', () => {
  const probe = () => ({heightM:0, normal:{x:0,y:0,z:1}});
  const r = rig('pz4gh', probe), observations: Vec3[] = [];
  const observe = (contact: { point: Vec3 }) => observations.push({...contact.point});
  r.body.position.z += 100;
  stepHullBody(r.body,r.def,{speedMs:0,yawRateRadS:0,brake:true},probe,.1,1,undefined,observe);
  expect(observations).toEqual([]);
  r.body.position.z -= 100; r.body.velocity = {x:100,y:0,z:0};
  const startX = r.body.position.x;
  for(let i=0;i<5;i++) stepHullBody(r.body,r.def,{speedMs:2,yawRateRadS:0,brake:false},probe,.1,1,()=>false,observe);
  expect(observations.length).toBeGreaterThan(0);
  expect(observations.every(p=>Math.abs(p.x-startX)<2)).toBe(true);
  expect(r.body.position.x).toBe(startX);
});

it('identifies only positively weighted winning line sources, and remains fresh after edits/rebuilds', () => {
  const {map} = fenceMap(), point={x:10.5,y:9.8};
  const source=crushableLineSourcesAt(map,[point]);
  expect(source).toContain(10*map.width+10);
  expect(source.every(i=>map.tiles[i]==='fence')).toBe(true);
  const height=groundProbe(map)(point.x*2,point.y*2).heightM;
  for(const i of source) crushTile(map,i%map.width,Math.floor(i/map.width));
  expect(groundProbe(map)(point.x*2,point.y*2).heightM).toBeLessThan(height);
  expect(crushableLineSourcesAt(map,[point])).toEqual([]);
  map.heightField=buildHeightField(map);
  expect(crushableLineSourcesAt(map,[point])).toEqual([]);
});

it('does not attribute dominant noncrushable or explicit profile samples to a nearby fence', () => {
  const {map}=fenceMap(); map.tiles[9*map.width+10]='buildingStone'; map.buildingId[9*map.width+10]=1;
  expect(crushableLineSourcesAt(map,[{x:10.5,y:9.8}])).toEqual([]);
  setTileProfile(getHeightField(map),10,9,100);
  expect(crushableLineSourcesAt(map,[{x:10.5,y:9.8}])).toEqual([]);
});

it('retains diagonal source clipping and excludes a clipped-away line continuation', () => {
  const {map}=fenceMap(true);
  expect(crushableLineSourcesAt(map,[{x:10.6,y:10.6}]).length).toBeGreaterThan(0);
  expect(crushableLineSourcesAt(map,[{x:13.1,y:13.1}])).toEqual([]);
  const source=crushableLineSourcesAt(map,[{x:10.6,y:10.6}]);
  for(const i of source) crushTile(map,i%map.width,Math.floor(i/map.width));
  expect(crushableLineSourcesAt(map,[{x:10.6,y:10.6}])).toEqual([]);
});

it('treats bit-identical whole profiles equally and suppresses a one-sample mismatch until refresh', () => {
  const {map}=fenceMap(), field=getHeightField(map), point={x:10.5,y:9.8};
  const expected=crushableLineSourcesAt(map,[point]), profile=new Float32Array(HF_RES*HF_RES);
  expect(expected.length).toBeGreaterThan(0);
  for(let y=0;y<HF_RES;y++)for(let x=0;x<HF_RES;x++) profile[y*HF_RES+x]=field.base[(9*HF_RES+y)*field.w+10*HF_RES+x];
  setTileProfile(field,10,9,profile);
  expect(crushableLineSourcesAt(map,[point])).toEqual(expected);
  profile[0]+=.1; // Outside this point's stencil: whole-profile agreement still matters.
  setTileProfile(field,10,9,profile);
  expect(crushableLineSourcesAt(map,[point])).toEqual([]);
  refreshTile(map,10,9);
  expect(crushableLineSourcesAt(map,[point])).toEqual(expected);
  setTileProfile(field,10,9,100);
  expect(crushableLineSourcesAt(map,[point])).toEqual([]);
  refreshTile(map,10,9);
  expect(crushableLineSourcesAt(map,[point])).toEqual(expected);
});

it('observing accepted support leaves every solver state bit unchanged, including roof contact', () => {
  const probe=()=>({heightM:0,normal:{x:0,y:0,z:1}}), control=rig('t34_76',probe);
  const p=hullParams(control.def);control.body.orientation={x:1,y:0,z:0,w:0};control.body.position.z=p.solidBox.max.z+.5;
  const observed=structuredClone(control.body),contacts:{point:Vec3;kind:string}[]=[];
  for(let i=0;i<100;i++){
    control.step();stepHullBody(observed,control.def,{speedMs:0,yawRateRadS:0,brake:true},probe,.1,1,undefined,c=>contacts.push(c));
    expect(observed).toEqual(control.body);
  }
  expect(contacts.some(c=>c.kind==='solid')).toBe(true);
  expect(contacts.filter(c=>c.kind==='solid').every(c=>Math.abs(c.point.z)<.02)).toBe(true);
});

it('finds winning crushable sources at clipped map boundaries and excludes a stonewall winner', () => {
  const state=makeState(),map=state.map;
  map.tiles[0]='fence';
  expect(crushableLineSourcesAt(map,[{x:.375,y:.375}])).toEqual([0]);
  expect(crushableLineSourcesAt(map,[{x:2.5,y:2.5}])).toEqual([]);
  map.tiles[0]='stonewall';refreshTile(map,0,0);
  expect(crushableLineSourcesAt(map,[{x:.375,y:.375}])).toEqual([]);
});

it('filters observation work only on exact negative line-source eligibility and stays fresh', () => {
  const {map}=fenceMap(true), possible=prepareCrushableLineInterest(map);
  for(let y=-.5;y<=15.5;y+=.25)for(let x=-.5;x<=15.5;x+=.25){
    const p={x,y},expected=crushableLineSourcesAt(map,[p]);
    expect(crushableLineSourcesAt(map,possible(x,y)?[p]:[])).toEqual(expected);
  }
  expect(possible(1.375,1.375)).toBe(false);
  map.tiles[map.width+1]='fence';refreshTile(map,1,1);
  expect(possible(1.375,1.375)).toBe(true);
  map.tiles[map.width+1]='open';map.heightField=buildHeightField(map);
  expect(possible(1.375,1.375)).toBe(false);
  const probe=()=>({heightM:0,normal:{x:0,y:0,z:1}}),a=rig('pz4gh',probe),b=structuredClone(a.body);
  let events=0,probes=0;
  stepHullBody(b,a.def,{speedMs:0,yawRateRadS:0,brake:true},(x,y)=>{probes++;return probe();},.1,1,undefined,()=>events++,()=>false);
  const filteredProbes=probes;probes=0;
  stepHullBody(a.body,a.def,{speedMs:0,yawRateRadS:0,brake:true},(x,y)=>{probes++;return probe();},.1,1,undefined,()=>{});
  expect(events).toBe(0);expect(filteredProbes).toBeLessThan(probes);expect(b).toEqual(a.body);
});

it('preserves filtered/unfiltered actual sources, fields and body through contact effects', () => {
  for(const mode of ['fence','diagonal','boundary','building','manual','rejected']){
    const states=[fenceMap(mode==='diagonal'),fenceMap(mode==='diagonal')];
    for(const {map} of states){
      if(mode==='boundary')map.tiles[0]='fence';
      if(mode==='building'){map.tiles[9*map.width+10]='buildingStone';map.buildingId[9*map.width+10]=1;}
      map.heightField=buildHeightField(map);
      if(mode==='boundary')expect(crushableLineSourcesAt(map,[{x:.375,y:.375}])).toEqual([0]);
      if(mode==='building'){expect(groundProbe(map)(21,19).heightM).toBeGreaterThan(1);expect(crushableLineSourcesAt(map,[{x:10.5,y:9.8}])).toEqual([]);}
      if(mode==='diagonal')expect(crushableLineSourcesAt(map,[{x:10.6,y:10.6}]).length).toBeGreaterThan(0);
      if(mode==='manual')setTileProfile(getHeightField(map),10,9,100);
    }
    const start=mode==='boundary'?{x:.5,y:.5}:mode==='diagonal'?{x:10.5,y:10}:{x:10.5,y:9.5};
    const rigs=states.map(st=>addTank(st,'pz4gh',start,Math.PI).v),def=VEHICLE_DEFS.pz4gh;
    for(let j=0;j<2;j++)rigs[j].body=createHullBody(def,rigs[j].pos,rigs[j].hullFacing,groundProbe(states[j].map));
    for(let tick=0;tick<20;tick++){
      const sourceSets=states.map((st,j)=>{
        const interest=prepareCrushableLineInterest(st.map),points:{x:number;y:number}[]=[];
        stepHullBody(rigs[j].body!,def,{speedMs:2,yawRateRadS:.1,brake:false},groundProbe(st.map),.1,1,
          mode==='rejected'?()=>false:undefined,c=>points.push({x:c.point.x/2,y:c.point.y/2}),j===1?p=>interest(p.x/2,p.y/2):undefined);
        return crushableLineSourcesAt(st.map,points);
      });
      expect(sourceSets[1]).toEqual(sourceSets[0]);expect(rigs[1].body).toEqual(rigs[0].body);
      for(let j=0;j<2;j++)for(const key of sourceSets[j])crushTile(states[j].map,key%states[j].map.width,Math.floor(key/states[j].map.width));
    }
    const a=getHeightField(states[0].map),b=getHeightField(states[1].map);
    for(const key of ['ground','base','dig','height','canopy'] as const)expect(Buffer.from(b[key].buffer,b[key].byteOffset,b[key].byteLength).equals(Buffer.from(a[key].buffer,a[key].byteOffset,a[key].byteLength))).toBe(true);
    expect(states[1].map.tiles).toEqual(states[0].map.tiles);
  }
});

// Independent eligibility oracle: original four weighted samples and their
// neighbouring line sources, without the source-free region shortcut.
it('matches exact line eligibility across source halos, boundaries and terrain edits', () => {
  const {map} = fenceMap(true), rng = new Rng(481);
  map.width = 32; map.height = 32; map.tiles = new Array(32 * 32).fill('open');
  const sources = ['fence', 'hedge', 'stonewall'] as const;
  for (let i = 0; i < 25; i++) map.tiles[rng.int(0, map.tiles.length - 1)] = sources[i % sources.length];
  map.heightField = buildHeightField(map);
  const possible = prepareCrushableLineInterest(map);
  const reference = (x: number, y: number) => {
    const f = getHeightField(map), fx = x*f.res-.5, fy = y*f.res-.5;
    const x0 = Math.max(0, Math.min(f.w-1, Math.floor(fx))), y0 = Math.max(0, Math.min(f.h-1, Math.floor(fy)));
    const x1 = Math.min(f.w-1,x0+1), y1 = Math.min(f.h-1,y0+1);
    const ax = Math.max(0,Math.min(1,fx-x0)), ay = Math.max(0,Math.min(1,fy-y0));
    return [[x0,y0,(1-ax)*(1-ay)],[x1,y0,ax*(1-ay)],[x0,y1,(1-ax)*ay],[x1,y1,ax*ay]].some(([sx,sy,weight]) => {
      if (weight <= 0) return false;
      const tx = Math.floor(sx/f.res), ty = Math.floor(sy/f.res);
      for (let yy = Math.max(0,ty-1); yy <= Math.min(map.height-1,ty+1); yy++) {
        for (let xx = Math.max(0,tx-1); xx <= Math.min(map.width-1,tx+1); xx++) {
          const t = map.tiles[yy*map.width+xx];
          if ((t === 'fence' || t === 'hedge' || t === 'stonewall') && TERRAIN_PROPS[t].crushable) return true;
        }
      }
      return false;
    });
  };
  const check = () => {
    for (let i=0;i<4000;i++) {
      const x=rng.range(-1,map.width+1),y=rng.range(-1,map.height+1);
      expect(possible(x,y)).toBe(reference(x,y));
    }
    for (let y=-.5;y<=map.height+.5;y+=.125) for (const x of [-.5,-0,0,.125,.875,1,1.125,map.width-.125,map.width,map.width+.5])
      expect(possible(x,y)).toBe(reference(x,y));
  };
  check();
  map.tiles[map.width+1]='fence';refreshTile(map,1,1);check();
  map.tiles.fill('open');map.heightField=buildHeightField(map);check();
  map.tiles.fill('fence');map.heightField=buildHeightField(map);check();
  map.tiles[map.width+1]='open';refreshTile(map,1,1);check();
});
