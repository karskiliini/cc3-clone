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
  if(veto==='traffic'){const obstacle=addTank(state,'pz4gh',{x:21.5,y:19.5});obstacle.v.state='knockedOut';for(const id of obstacle.team.soldierIds)state.soldiers.delete(id);}
  try{stepVehicles(state,new Rng(3),.1);expect(v.path[0]).toBe(corner);expect(grade.mock.calls.length).toBeGreaterThan(2);}finally{grade.mockRestore();}
 }
});
