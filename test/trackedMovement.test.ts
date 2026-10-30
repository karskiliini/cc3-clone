import * as hullPhysics from '@/sim/hullPhysics';
import { hullParams } from '@/data/vehiclePhysics';
import { ensureDamage } from '@/sim/vehicleDamage';
import { groundProbe } from '@/sim/hullGround';
import { placeVehicleBody } from '@/sim/vehicle';
import { expect, it, vi } from 'vitest';
import * as vehicleCrew from '@/sim/vehicleCrew';
import { makeState, addTank } from './vehicleDamageHelpers';
import { takeHullDrive } from '@/sim/hullDrive';
import { stepVehicles, turnHull, hullTurnNow } from '@/sim/vehicle';
import { VEHICLE_DEFS } from '@/data/units';
import { Rng } from '@/shared/rng';

it('stops its own movement yaw when the final actual-distance waypoint completes', () => {
  const state = makeState(), { v, team } = addTank(state, 'pz4gh', { x: 20, y: 20 });
  const target = { x: 20.02, y: 19.8 }; v.path = [target]; team.order = { type: 'move', target, issuedAt: 0 };
  stepVehicles(state, new Rng(3), .1);
  expect(v.path).toHaveLength(0);
  expect(takeHullDrive(v)).toEqual({ speedMs: 0, yawRateRadS: 0, brake: true });
});

it('completion preserves an independent yaw owner from earlier in the current tick', () => {
  const state = makeState(), { v, team } = addTank(state, 'pz4gh', { x: 20, y: 20 });
  const target = { x: 20.02, y: 19.8 }; v.path = [target]; team.order = { type: 'move', target, issuedAt: 0 };
  const realCrews = vehicleCrew.stepVehicleCrews;
  // Inject a real independent turn request at the existing pre-driver phase, not a mocked result.
  const owner = vi.spyOn(vehicleCrew, 'stepVehicleCrews').mockImplementation((...args) => {
    realCrews(...args); turnHull(state, v, VEHICLE_DEFS.pz4gh, -.5, .1);
  });
  try {
    const cap = hullTurnNow(state, v, VEHICLE_DEFS.pz4gh).rate;
    stepVehicles(state, new Rng(3), .1);
    expect(v.path).toHaveLength(0);
    expect(takeHullDrive(v)).toEqual({ speedMs: 0, yawRateRadS: -cap, brake: false });
    expect(v.hullFacing).toBeLessThan(0);
  } finally { owner.mockRestore(); }
});


it('restores only the prior owner pull ledger on completion and resets after relocation and a fresh tick', () => {
  const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20,y:20});
  const target={x:19.98,y:19.8};v.path=[target];team.order={type:'move',target,issuedAt:0};
  ensureDamage(v).trackL='damaged';
  const real=vehicleCrew.stepVehicleCrews, physics=vi.spyOn(hullPhysics,'stepHullBody');
  const owner=vi.spyOn(vehicleCrew,'stepVehicleCrews').mockImplementation((...args)=>{real(...args);turnHull(state,v,VEHICLE_DEFS.pz4gh,-.0005,.1);});
  try{
    stepVehicles(state,new Rng(3),.1);expect(v.path).toHaveLength(0);
    expect(takeHullDrive(v).yawRateRadS).toBeCloseTo(-.005,12);
    const p=hullParams(VEHICLE_DEFS.pz4gh),c=p.contacts.filter(c=>!c.horn);
    const gain=c.reduce((s,c)=>s+c.local.x**2,0)/c.reduce((s,c)=>s+c.local.x**2+c.local.y**2,0);
    expect(physics.mock.calls[0][2].yawRateRadS).toBeCloseTo(-.005/gain,12);
    owner.mockRestore();physics.mockClear();
    placeVehicleBody(v,VEHICLE_DEFS.pz4gh,{x:25,y:25},0,groundProbe(state.map));
    stepVehicles(state,new Rng(3),.1);
    expect(takeHullDrive(v)).toEqual({speedMs:0,yawRateRadS:0,brake:true});
    expect(physics.mock.calls[0][2]).toEqual(takeHullDrive(v));
  }finally{owner.mockRestore();physics.mockRestore();}
});

it('brakes carried yaw using the accepted unclipped target while retaining original speed policy',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20,y:20});const target={x:20.2,y:10};v.path=[target];team.order={type:'move',target,issuedAt:0};
 placeVehicleBody(v,VEHICLE_DEFS.pz4gh,v.pos,0,groundProbe(state.map));v.body!.angularVelocity.z=.3;
 stepVehicles(state,new Rng(3),.1);expect(takeHullDrive(v).yawRateRadS).toBeLessThan(0);expect(takeHullDrive(v).speedMs).toBe(5);expect(v.body!.angularVelocity.z).toBeLessThan(.3);
});


it('keeps physical target error relative to accepted heading when an earlier owner advanced policy preview',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20,y:20}),target={x:20.2,y:10};v.path=[target];team.order={type:'move',target,issuedAt:0};
 const real=vehicleCrew.stepVehicleCrews,cap=hullTurnNow(state,v,VEHICLE_DEFS.pz4gh).rate;
 const owner=vi.spyOn(vehicleCrew,'stepVehicleCrews').mockImplementation((...args)=>{real(...args);turnHull(state,v,VEHICLE_DEFS.pz4gh,1,.1);});
 const physics=vi.spyOn(hullPhysics,'stepHullBody');
 try{stepVehicles(state,new Rng(3),.1);expect(takeHullDrive(v).yawRateRadS).toBeGreaterThan(cap);
  const p=hullParams(VEHICLE_DEFS.pz4gh),c=p.contacts.filter(c=>!c.horn),gain=c.reduce((s,c)=>s+c.local.x**2,0)/c.reduce((s,c)=>s+c.local.x**2+c.local.y**2,0);
  expect(physics).toHaveBeenCalledTimes(1);expect(physics.mock.calls[0][2].yawRateRadS).toBeCloseTo(cap/gain,12);
 }finally{owner.mockRestore();physics.mockRestore();}
});
