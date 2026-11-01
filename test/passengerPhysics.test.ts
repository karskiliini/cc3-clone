import { expect, it } from 'vitest';
import { makeState, addTank, soldier } from './vehicleDamageHelpers';
import { VEHICLE_DEFS } from '@/data/units';
import { SIM_DT } from '@/shared/types';
import { onPassengerBoarded, roomLeft } from '@/sim/transport';
import { stepPassengerPhysics, riderLocal, constrainCompartment, RIDER_RADIUS_M, reserveRiderSeat } from '@/sim/passengerPhysics';
import { hurtPassenger } from '@/sim/vehicleDamage';
import { createHullBody } from '@/sim/hullPhysics';
import { hashState } from '@/sim/stateHash';
import { Rng } from '@/shared/rng';
import { vehicleLook, vehiclePose } from '@/render/vehicle3d/look';
import { LightTransportScene } from '@/render/vehicle3d/lightTransportScene';
import { Group, Vector3 } from 'three';
import { seatForSoldier, transportLayout, boardingWorld, localWorld } from '@/render/lightTransport';

function scene(count=1){
 const state=makeState(),{v}=addTank(state,'sdkfz251',{x:30,y:30});
 v.body=createHullBody(VEHICLE_DEFS.sdkfz251,v.pos,0,()=>({heightM:0,normal:{x:0,y:0,z:1}}));
 const men=Array.from({length:count},(_,i)=>soldier(700+i,7,'german',v.pos,'kar98k'));
 for(const s of men){state.soldiers.set(s.id,s);onPassengerBoarded(state,v,s);}return{state,v,men,rng:new Rng(7)};
}
it('assigns ten distinct canonical seats and preserves casualty capacity',()=>{
 const {state,v,men}=scene(10);expect(new Set(men.map(s=>s.rider!.seatIndex)).size).toBe(10);
 men[3].health='dead';stepPassengerPhysics(state,SIM_DT);
 expect(roomLeft(state,v)).toBe(0);expect(men[3].vehicleId).toBe(v.id);expect(men[3].rider!.body).toHaveLength(7);
});
it('reserves the same boarding endpoint before and after a climb, independent of render calls',()=>{
 const{state,v,men}=scene(2);const s=soldier(999,7,'german',v.pos,'kar98k');state.soldiers.set(s.id,s);
 reserveRiderSeat(state,v,s);s.hatch={vehicleId:v.id,hatch:0,kind:'mount',from:s.pos,to:v.pos,start:0,until:1.5,panicked:false,passenger:true,passengerSeatIndex:s.rider!.seatIndex};
 const index=s.rider!.seatIndex,before=seatForSoldier(v,s,transportLayout(VEHICLE_DEFS.sdkfz251)!);
 s.hatch=undefined;onPassengerBoarded(state,v,s);expect(s.rider!.seatIndex).toBe(index);
 expect(seatForSoldier(v,s,transportLayout(VEHICLE_DEFS.sdkfz251)!)).toEqual(before);expect(index).toBe(2);
});
it('crouches while moving or suppressed and exposes only a calm halted shooter',()=>{
 const{state,v,men:[s]}=scene();state.time=10;s.lastFiredAt=9.9;
 v.speed=2;stepPassengerPhysics(state,SIM_DT);expect(s.rider!.posture).toBe('crouched');
 v.speed=0;s.suppression=60;stepPassengerPhysics(state,SIM_DT);expect(s.rider!.posture).toBe('crouched');
 s.suppression=0;s.mind.state='calm';stepPassengerPhysics(state,SIM_DT);expect(s.rider!.posture).toBe('firing');
 state.time=12;stepPassengerPhysics(state,SIM_DT);expect(s.rider!.posture).toBe('crouched');
});
it('projects against the sloping walls, floor and benches but leaves the top open',()=>{
 const c=VEHICLE_DEFS.sdkfz251.passengerCompartment!;
 const low=constrainCompartment({x:4,y:9,z:.5},c);expect(low.z).toBeGreaterThanOrEqual(c.floorZ+RIDER_RADIUS_M);expect(low.x).toBeLessThan(c.lowerHalfWidth);expect(low.y).toBeLessThan(c.rearY);
 const bench=constrainCompartment({x:.54,y:1.5,z:1.33},c);expect(bench.z).toBeGreaterThanOrEqual(1.34+RIDER_RADIUS_M-1e-12);
 expect(constrainCompartment({x:4,y:9,z:3},c)).toEqual({x:4,y:9,z:3});
});
it('keeps articulated dead riders finite against a pitched and rolled compartment',()=>{
 const{state,v,men:[s]}=scene();s.health='dead';v.body!.position.z+=3;
 const a=.42;v.body!.orientation={x:Math.sin(a/2),y:0,z:0,w:Math.cos(a/2)};
 for(let i=0;i<60;i++){state.time+=SIM_DT;stepPassengerPhysics(state,SIM_DT);}
 expect(s.vehicleId).toBe(v.id);expect(s.rider!.attached).toBe(true);
 for(const p of s.rider!.body!){expect(Object.values(p.position).every(Number.isFinite)).toBe(true);const local=riderLocal(state,v,p.position);expect(local.z).toBeGreaterThanOrEqual(VEHICLE_DEFS.sdkfz251.passengerCompartment!.floorZ+RIDER_RADIUS_M-1e-9);}
});
it('a corpse can fall out of the open top of an overturned hull, rather than sticking to an invisible lid',()=>{
 const{state,v,men:[s]}=scene();s.health='dead';stepPassengerPhysics(state,SIM_DT);
 v.body!.position.z+=5;v.body!.orientation={x:1,y:0,z:0,w:0};
 for(let i=0;i<60;i++){state.time+=SIM_DT;stepPassengerPhysics(state,SIM_DT);}
 expect(s.rider!.attached).toBe(false);expect(s.vehicleId).toBeNull();expect(v.passengerIds).not.toContain(s.id);
});
it('simulation bodies replay exactly and rendering is read-only, including dead riders',()=>{
 const a=scene(),b=scene();a.men[0].health='dead';b.men[0].health='dead';
 for(let i=0;i<20;i++){a.state.time+=SIM_DT;b.state.time+=SIM_DT;stepPassengerPhysics(a.state,SIM_DT);stepPassengerPhysics(b.state,SIM_DT);expect(hashState(a)).toBe(hashState(b));}
 const before=hashState(a),look=vehicleLook(a.v,a.state);expect(look.lightTransport!.occupants[0].body).toHaveLength(7);expect(hashState(a)).toBe(before);
 a.men[0].rider!.body![0].position.x+=1e-12;expect(hashState(a)).not.toBe(before);
});

it('draws every casualty joint at its canonical world position through the pitched hull transform',()=>{
 const{state,v,men:[s]}=scene();s.health='dead';v.body!.position.z+=3;
 const a=.42;v.body!.orientation={x:Math.sin(a/2),y:0,z:0,w:Math.cos(a/2)};
 stepPassengerPhysics(state,SIM_DT);
 const look=vehicleLook(v,state),pose=vehiclePose(look,false,null),parent=new Group(),transport=new LightTransportScene();
 parent.position.fromArray(pose.hullPos);parent.quaternion.fromArray(pose.hullQuaternion);parent.add(transport.group);
 transport.update(look.lightTransport);parent.updateMatrixWorld(true);
 const body=transport.group.getObjectByName(`passenger_body_${s.id}`)!;expect(body.visible).toBe(true);
 s.rider!.body!.forEach((particle,i)=>{const world=body.children[i].getWorldPosition(new Vector3());expect(world.x).toBeCloseTo(particle.position.x,10);expect(world.y).toBeCloseTo(particle.position.z,10);expect(world.z).toBeCloseTo(particle.position.y,10);});
 transport.dispose();
});

it('vaults the rear rim on entry and exit rather than passing through closed armour',()=>{
 const{state,v,men:[s]}=scene(),look=vehicleLook(v,state),layout=transportLayout(VEHICLE_DEFS.sdkfz251)!;
 s.hatch={vehicleId:v.id,hatch:0,kind:'mount',from:{x:30,y:34},to:v.pos,start:0,until:2,panicked:false,passenger:true,passengerSeatIndex:s.rider!.seatIndex};
 const expected=localWorld(look,{...layout.boardingVia!,x:layout.passengerSeats[s.rider!.seatIndex].x});
 expect(boardingWorld(s,v,look,layout,1)).toEqual(expected);
 s.hatch.kind='bailout';expect(boardingWorld(s,v,look,layout,1)).toEqual(expected);
});

it('creates the casualty at the hit pose and inherits hull angular momentum immediately',()=>{
 const{state,v,men:[s]}=scene();v.body!.angularVelocity={x:0,y:0,z:1};
 hurtPassenger(state,v,s,'dead','soviet');
 expect(s.rider!.body).toHaveLength(7);expect(s.rider!.posture).toBe('casualty');
 expect(Math.abs(s.rider!.body![0].velocity.x)+Math.abs(s.rider!.body![0].velocity.y)).toBeGreaterThan(.1);
});
