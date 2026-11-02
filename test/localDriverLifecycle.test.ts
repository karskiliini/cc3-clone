import { boxProjection } from '@/sim/localDriver';
import { hullParams } from '@/data/vehiclePhysics';
import { MINE_AT, setMineAt } from '@/sim/mines';
import { expect, it, vi } from 'vitest';
import type { LocalDriverReflex, Vehicle } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { hashState } from '@/sim/stateHash';
import { applyOrder, stepAttackOrders } from '@/sim/orders';
import { bailOut, ensureDamage, worsen, RADIO_OUT_ORDER_DELAY_S } from '@/sim/vehicleDamage';
import { groundProbe } from '@/sim/hullGround';
import { placeVehicleBody, stepVehicles, syncVehicleFromBody, turnHull } from '@/sim/vehicle';
import { stepHullGameplay } from '@/sim/hullGameplay';
import { takeHullDrive } from '@/sim/hullDrive';
import * as hullPhysics from '@/sim/hullPhysics';
import * as crewSteps from '@/sim/vehicleCrew';
import { makeState, addTank } from './vehicleDamageHelpers';
const history=():LocalDriverReflex=>({owner:1,episode:{anchorM:{x:0,y:0},attempts:1,limit:3,exhausted:false},
 recovery:{gear:-1,capMs:2,anchorM:{x:0,y:0},axis:{x:0,y:1},entryMaxProjection:3,turning:false,phase:'pending',budgetTicks:0,elapsedTicks:0},
 window:{goal:{x:30,y:20},gear:1,onlyDir:0,direction:-1,ticks:1,startDistanceM:20,startAbsError:.2,startRate:0,axis:{x:0,y:-1},startFlow:0,minimumYaw:.2,minimumSpeed:1}});

it('hashes every presence/scalar independently, last bits and signed zero, and retains enumerable history in clones',()=>{
 const state=makeState(),{v}=addTank(state,'pz4gh',{x:20,y:20}),rng=new Rng(3);const h=()=>hashState({state,rng});
 const absent=h();v.localDriver=history();const present=h();expect(present).not.toBe(absent);expect(h()).toBe(present);
 const original=history();
 const floats=[['episode','anchorM','x'],['episode','anchorM','y'],['recovery','capMs'],['recovery','anchorM','x'],['recovery','anchorM','y'],['recovery','axis','x'],['recovery','axis','y'],['recovery','entryMaxProjection'],['window','goal','x'],['window','goal','y'],['window','startDistanceM'],['window','startAbsError'],['window','startRate'],['window','axis','x'],['window','axis','y'],['window','startFlow'],['window','minimumYaw'],['window','minimumSpeed']];
 const bits=new DataView(new ArrayBuffer(8));
 for(const path of floats){v.localDriver=structuredClone(original);let obj:any=v.localDriver;for(const k of path.slice(0,-1))obj=obj[k];const key=path.at(-1)!;const before=obj[key];bits.setFloat64(0,before);bits.setBigUint64(0,bits.getBigUint64(0)+1n);obj[key]=bits.getFloat64(0);expect(h(),path.join('.')).not.toBe(present);
  v.localDriver=structuredClone(original);obj=v.localDriver;for(const k of path.slice(0,-1))obj=obj[k];delete obj[key];expect(h(),'missing '+path.join('.')).not.toBe(present);
  if(before===0){v.localDriver=structuredClone(original);obj=v.localDriver;for(const k of path.slice(0,-1))obj=obj[k];obj[key]=-0;expect(h(),'signed zero '+path.join('.')).not.toBe(present);}}
 const mutations:((s:LocalDriverReflex)=>void)[]=[s=>s.owner=2,s=>s.episode=null,s=>s.episode!.attempts=2,s=>s.episode!.limit=4,s=>s.episode!.exhausted=true,s=>s.recovery=null,s=>s.recovery!.gear=1,s=>s.recovery!.turning=true,s=>s.recovery!.phase='braking',s=>s.recovery!.phase='retreat',s=>s.recovery!.budgetTicks=1,s=>s.recovery!.budgetTicks=4294967296,s=>s.recovery!.elapsedTicks=1,s=>s.recovery!.elapsedTicks=4294967296,s=>s.window=null,s=>s.window!.gear=-1,s=>s.window!.onlyDir=1,s=>delete (s.window as any).onlyDir,s=>s.window!.direction=1,s=>s.window!.ticks=2];
 for(const mutate of mutations){v.localDriver=structuredClone(original);mutate(v.localDriver);expect(h(),String(mutate)).not.toBe(present);}
 v.localDriver=history();v.localDriver.window!.startRate=-0;const clone=structuredClone(v);expect(clone.localDriver).toEqual(v.localDriver);expect(Object.is(clone.localDriver!.window!.startRate,-0)).toBe(true);
});
it('resets on actual accepted orders and placement, retaining history for refused and deferred orders',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20,y:20}),rng=new Rng(3);v.localDriver=history();team.outOfAction=true;
 const order={type:'move' as const,target:{x:20,y:10},issuedAt:0};applyOrder(state,team,order,rng);expect(v.localDriver).toEqual(history());
 team.outOfAction=false;ensureDamage(v).radio='destroyed';applyOrder(state,team,order,rng);expect(v.localDriver).toEqual(history());
 state.time=RADIO_OUT_ORDER_DELAY_S;stepAttackOrders(state,rng);expect(v.localDriver).toBeUndefined();
 v.localDriver=history();applyOrder(state,team,{...order,issuedAt:state.time},rng,true);expect(v.localDriver).toBeUndefined();
 v.localDriver=history();placeVehicleBody(v,VEHICLE_DEFS.pz4gh,v.pos,0,groundProbe(state.map));expect(v.localDriver).toBeUndefined();
});
it('death clears immediately and real post-step overturn cannot retain canonical history',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20,y:20});v.localDriver=history();bailOut(state,v,team,'abandoned',null);expect(v.localDriver).toBeUndefined();
 const second=addTank(state,'pz4gh',{x:30,y:30}).v;placeVehicleBody(second,VEHICLE_DEFS.pz4gh,second.pos,0,groundProbe(state.map));second.localDriver=history();
 second.body!.orientation={x:0,y:Math.sin(.7),z:0,w:Math.cos(.7)};second.body!.tippedS=1.9;
 stepHullGameplay(state,new Rng(3),second,.1);expect(second.body!.overturned).toBe(true);expect(second.localDriver).toBeUndefined();
});
it('ordinary completion and real earlier yaw ownership cancel a recovery without replenishing its episode',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20,y:20});placeVehicleBody(v,VEHICLE_DEFS.pz4gh,v.pos,0,groundProbe(state.map));
 v.localDriver=history();v.localDriver.episode!.anchorM={x:40,y:40};v.path=[{x:20,y:10}];team.order={type:'move',target:v.path[0],issuedAt:0};
 const real=crewSteps.stepVehicleCrews;const owner=vi.spyOn(crewSteps,'stepVehicleCrews').mockImplementation((...args)=>{real(...args);turnHull(state,v,VEHICLE_DEFS.pz4gh,-.5,.1);});
 try{stepVehicles(state,new Rng(3),.1);expect(v.localDriver!.recovery).toBeNull();expect(v.localDriver!.episode!.attempts).toBe(1);expect(takeHullDrive(v).yawRateRadS).toBeLessThan(0);}finally{owner.mockRestore();}
 v.path=[{x:v.pos.x,y:v.pos.y-.1}];stepVehicles(state,new Rng(3),.1);expect(v.path).toHaveLength(0);expect(v.localDriver?.recovery).toBeNull();expect(v.localDriver?.window).toBeNull();expect(v.localDriver?.episode?.attempts).toBe(1);
});

// Measured failed-O1 pocket tick34 accepted body. Reuse this finite physical contact state,
// then exercise current production steering/terrain acceptance; no mocked physical result.
const bankBody={"position":{"x":401.9999997245278,"y":403.74928912280365,"z":0.7736852585050932},"orientation":{"x":0.023130569681346868,"y":0.0979374401809896,"z":-0.060840966563324696,"w":0.9930617359180909},"velocity":{"x":0,"y":0,"z":-0.002735272133975958},"angularVelocity":{"x":-0.0018385685814062815,"y":-0.004747226020114607,"z":0.026753229135238043},"suspensionTravel":[0.1535160445588445,0.12459971991025187,0.09568339526165914,0.06676707061306653,0.03785074596447369,0.00893442131588118,0,0,0.13419105371831713,0.10541440620868237,0.07649808156008975,0.04758175691149691,0.01866543226290429,0.015881172176416814,0,0.259607849754128],"asleep":false,"hungUp":false,"overturned":false,"quietS":0,"tippedS":0,"hungS":0,"rockPhaseS":0,"rockTries":0,"groundVersion":1};
function bank(){const state=makeState();for(let y=200;y<=202;y++)for(let x=201;x<=203;x++)if(x!==202||y!==201)state.map.tiles[y*400+x]='water';state.map.tiles[200*400+202]='buildingStone';
 const {v,team}=addTank(state,'pz4gh',{x:200.5,y:200.5});v.body=structuredClone(bankBody);syncVehicleFromBody(v);v.path=[{x:200.5,y:203.5}];team.order={type:'move',target:v.path[0],issuedAt:0};return{state,v};}
it('observes a bank-gated translation then initializes one fixed recovery budget after real gates and roll',()=>{
 const {state,v}=bank(),rng=new Rng(3);let translations=0;const real=hullPhysics.stepHullBody;
 const solver=vi.spyOn(hullPhysics,'stepHullBody').mockImplementation((body,def,drive,probe,dt,going,accept,...rest)=>real(body,def,drive,probe,dt,going,(from,to)=>{const ok=accept!(from,to);if(Math.hypot(to.x-from.x,to.y-from.y)>0)translations++;return ok;},...rest));
 try {stepVehicles(state,rng,.1);expect(translations).toBe(10);
  // Steering requests translation, but the real bank gate vetoes it before the
  // solver. A physical pivot need not produce the old uncompensated gravity slip.
  expect(v.localDriver?.window?.minimumSpeed).toBeGreaterThan(0);
  expect(takeHullDrive(v).speedMs).toBe(0);
  expect(v.body!.position.x).toBeLessThan(402); // accepted centre stays west of water
  expect(v.localDriver?.recovery).toBeNull();expect(v.localDriver?.window).toMatchObject({ticks:1});expect(v.localDriver?.episode).toBeNull();
  // A separately active canonical recovery still uses the same real terrain/solver pipeline.
  v.localDriver!.episode={anchorM:{x:v.body!.position.x,y:v.body!.position.y},attempts:1,limit:3,exhausted:false};v.localDriver!.window=null;v.localDriver!.recovery={gear:1,capMs:2.5,anchorM:{x:v.body!.position.x,y:v.body!.position.y},axis:{x:Math.sin(v.hullFacing),y:-Math.cos(v.hullFacing)},entryMaxProjection:boxProjection(v.body!,hullParams(VEHICLE_DEFS.pz4gh).solidBox,{x:Math.sin(v.hullFacing),y:-Math.cos(v.hullFacing)},{x:v.body!.position.x,y:v.body!.position.y}).max,turning:false,phase:'pending',budgetTicks:0,elapsedTicks:0};
  let budget=0;for(let i=0;i<4;i++){const before=solver.mock.calls.length;stepVehicles(state,rng,.1);expect(solver.mock.calls.length-before).toBe(1);expect(takeHullDrive(v).speedMs).toBeGreaterThan(0);expect(v.localDriver?.recovery?.elapsedTicks).toBe(i+1);if(i===0)budget=v.localDriver!.recovery!.budgetTicks;expect(v.localDriver?.recovery?.budgetTicks).toBe(budget);}
  expect(v.localDriver?.episode?.attempts).toBe(1);
 }finally{solver.mockRestore();}
});

it('real remount and immobility cancel recovery/window while keeping the consumed budget',()=>{
 const state=makeState(),{v}=addTank(state,'pz4gh',{x:20,y:20});v.state='abandoned';v.remount={since:0,ordered:true};v.localDriver=history();
 crewSteps.stepVehicleCrews(state,new Rng(3),.1);expect(v.state).toBe('ok');expect(v.localDriver).toEqual({...history(),owner:0,recovery:null,window:null});
 v.localDriver=history();worsen(v,'engine','destroyed');expect(v.state).toBe('immobilized');expect(v.localDriver?.recovery).toBeNull();expect(v.localDriver?.window).toBeNull();expect(v.localDriver?.episode?.attempts).toBe(1);
});

it('an accepted mine cancels recovery without refunding its episode while a cut track still carries the hull',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20.5,y:20.5});placeVehicleBody(v,VEHICLE_DEFS.pz4gh,v.pos,0,groundProbe(state.map));
 v.localDriver=history();v.localDriver.recovery!.gear=1;v.localDriver.episode!.anchorM={x:41,y:41};v.path=[{x:20.5,y:10}];team.order={type:'move',target:v.path[0],issuedAt:0};setMineAt(state.map,20,20,MINE_AT);
 stepVehicles(state,new Rng(3),.1);expect([v.damage?.trackL,v.damage?.trackR]).toContain('destroyed');expect(Object.values(v.trackChains??{}).some(c=>c.cutLink>=0)).toBe(true);expect(v.state).toBe('ok');expect(v.localDriver?.owner).toBe(1);expect(v.localDriver?.recovery).toBeNull();expect(v.localDriver?.window).toBeNull();expect(v.localDriver?.episode?.attempts).toBe(1);
});
