import {recordVisual,vehicleObserver} from '@/sim/perception';
import {ensureSeats} from '@/sim/vehicleDamage';
import { expect,it,vi } from 'vitest';
import { makeState,addTank } from './vehicleDamageHelpers';
import { stepVehicles,placeVehicleBody } from '@/sim/vehicle';
import { groundProbe } from '@/sim/hullGround';
import { VEHICLE_DEFS } from '@/data/units';
import { Rng } from '@/shared/rng';
import * as path from '@/sim/path';
it('actual tracked pursuit retains a nearby mandatory corner when its successor crosses a fractional water wedge',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20.7,y:20.4});placeVehicleBody(v,VEHICLE_DEFS.pz4gh,v.pos,0,groundProbe(state.map));state.map.tiles[20*state.map.width+21]='water';
 const corner={x:20.75,y:20.45};v.path=[corner,{x:21.4,y:21.3}];team.order={type:'move',target:v.path[1],waypoints:[corner],issuedAt:0};
 const pass=vi.spyOn(path,'isPassable');try{stepVehicles(state,new Rng(3),.1);expect(v.path[0]).toBe(corner);expect(pass.mock.calls.some(a=>a[1]===21&&a[2]===20&&a[4]===VEHICLE_DEFS.pz4gh)).toBe(true);}finally{pass.mockRestore();}
});
it('actual straight shortcut retains vehicle grade/profile and traffic vetoes',()=>{
 for(const veto of ['grade','traffic']){const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20.5,y:20.5});placeVehicleBody(v,VEHICLE_DEFS.pz4gh,v.pos,0,groundProbe(state.map));const corner={x:22.5,y:20.5};v.path=[corner,{x:22.5,y:18.5}];team.order={type:'move',target:v.path[1],issuedAt:0};
  const grade=vi.spyOn(path,'vehicleSlopeCost');if(veto==='grade')grade.mockReturnValue(Infinity);
  if(veto==='traffic'){const obstacle=addTank(state,'pz4gh',{x:21.5,y:19.5});obstacle.v.state='knockedOut';ensureSeats(state,v);recordVisual(state,vehicleObserver(state,v,'driver')!,obstacle.v,'vehicle');for(const id of obstacle.team.soldierIds)state.soldiers.delete(id);}
  try{stepVehicles(state,new Rng(3),.1);expect(v.path[0]).toBe(corner);expect(grade.mock.calls.length).toBeGreaterThan(2);}finally{grade.mockRestore();}
 }
});

it('replans known traffic beyond an already reached corner without inventing a collision or skipping the next player waypoint',()=>{
 const state=makeState(),{v,team}=addTank(state,'pz4gh',{x:20.5,y:20.5}),obstacle=addTank(state,'pz4gh',{x:24.5,y:20.5});obstacle.v.state='knockedOut';
 ensureSeats(state,v);const driver=vehicleObserver(state,v,'driver')!;recordVisual(state,driver,obstacle.v,'vehicle');
 const corner={x:20.5001,y:20.5},pin={x:28.5,y:25.5},goal={x:30.5,y:25.5};v.path=[corner,{x:26.5,y:20.5},pin,goal];team.order={type:'move',target:goal,waypoints:[corner,pin],issuedAt:0};
 const rng=new Rng(3);for(let i=0;i<11;i++){state.time+=.1;recordVisual(state,driver,obstacle.v,'vehicle');stepVehicles(state,rng,.1);}
 expect(v.path.at(-1)).toEqual(goal);expect(v.path.some(p=>Math.hypot(p.x-pin.x,p.y-pin.y)<.5)).toBe(true);expect(v.path.some(p=>p.y!==20.5)).toBe(true);expect(v.path[0]).not.toBe(corner);
 expect(Object.keys(driver.perception?.navigation?.hulls??{}).some(id=>+id<0)).toBe(false);
});
