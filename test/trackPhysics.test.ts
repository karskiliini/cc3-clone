import { expect,it } from 'vitest';
import { makeState,addTank } from './vehicleDamageHelpers';
import { createHullBody } from '@/sim/hullPhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { severTrack,stepTrackPhysics,trackHasDrive,trackHullParams } from '@/sim/trackPhysics';
function scene(){const state=makeState(),{v}=addTank(state,'pz3j',{x:30,y:30});v.body=createHullBody(VEHICLE_DEFS.pz3j,v.pos,0,()=>({heightM:0,normal:{x:0,y:0,z:1}}));return{state,v};}
it('opens the nearest struck link and keeps two independent free ends',()=>{
 const{v}=scene(),c=severTrack(v,-1,{x:58,y:59,z:.1})!;
 expect(c.points.length).toBeGreaterThan(20);expect(c.points.length).toBeLessThanOrEqual(80);
 expect(c.points[0].index).toBe((c.cutLink+1)%c.points.length);expect(c.points.at(-1)!.index).toBe(c.cutLink);
});
it('moving over an open chain eventually loses sprocket contact and leaves the run behind',()=>{
 const{state,v}=scene(),c=severTrack(v,-1)!;v.speed=1;v.body!.velocity={x:0,y:-1,z:0};const initial=c.points.map(p=>({...p.position}));
 for(let i=0;i<150;i++){state.time+=.1;v.body!.position.y-=.1;v.pos.y-=.05;stepTrackPhysics(state,v,.1);}
 expect(c.points.every(p=>Object.values(p.position).every(Number.isFinite))).toBe(true);
 expect(c.engaged).toBe(false);
 expect(c.points.some((p,i)=>Math.abs(p.position.y-initial[i].y)>1)).toBe(true);
});

import { worsen, isImmobile } from '@/sim/vehicleDamage';
import { hullParams } from '@/data/vehiclePhysics';
import { stepHullBody } from '@/sim/hullPhysics';
import { flat } from './hullPhysicsHelpers';
import { vehicleLook } from '@/render/vehicle3d/look';
import { TrackScene } from '@/render/vehicle3d/trackScene';
import { vehicleMineCheck, setMineAt, MINE_AT, mineAt, MINE_NONE } from '@/sim/mines';
import { Rng } from '@/shared/rng';
it('damage severs a chain without freezing the hull, then removes that side drive on disengagement',()=>{
 const {state,v}=scene();worsen(v,'trackL','destroyed');
 expect(v.state).toBe('ok');expect(isImmobile(v)).toBe(false);expect(trackHasDrive(v,-1)).toBe(true);
 const params=hullParams(VEHICLE_DEFS[v.defId]);expect(trackHullParams(v,params)).toBe(params);
 v.trackChains!.L!.engaged=false;
 const detached=trackHullParams(v,params);
 expect(detached.contacts.filter(c=>c.side<0&&!c.steer).every(c=>!c.driven&&c.brake===false)).toBe(true);
 expect(detached.contacts.filter(c=>c.side>0).map(c=>c.driven)).toEqual(params.contacts.filter(c=>c.side>0).map(c=>c.driven));
 worsen(v,'trackR','destroyed');v.trackChains!.R!.engaged=false;expect(isImmobile(v)).toBe(true);
});
it('couples an open run to the production hull solver without teleports or nonfinite state',()=>{
 const {state,v}=scene(),def=VEHICLE_DEFS[v.defId],p=hullParams(def);worsen(v,'trackL','destroyed');
 const start={...v.body!.position};let firstLost=-1;
 for(let i=0;i<180;i++){
  stepHullBody(v.body!,def,{speedMs:2,yawRateRadS:0,brake:false},flat,.1,1,undefined,undefined,undefined,trackHullParams(v,p));
  v.pos={x:v.body!.position.x/2,y:v.body!.position.y/2};v.speed=Math.sqrt(v.body!.velocity.x**2+v.body!.velocity.y**2);
  stepTrackPhysics(state,v,.1);if(!trackHasDrive(v,-1)&&firstLost<0)firstLost=i;
 }
 expect(firstLost).toBeGreaterThan(1);expect(firstLost).toBeLessThan(179);
 expect(Math.hypot(v.body!.position.x-start.x,v.body!.position.y-start.y)).toBeGreaterThan(1);
 expect(v.trackChains!.L!.points.every(p=>Object.values(p.position).every(Number.isFinite))).toBe(true);
});
it('AT mines cut the struck side instead of imposing an instant tracked-hull stop',()=>{
 const {state,v}=scene();setMineAt(state.map,30,30,MINE_AT);
 vehicleMineCheck(state,v,new Rng(1));
 expect(mineAt(state.map,30,30)).toBe(MINE_NONE);expect(v.trackChains).toBeDefined();expect(v.state).toBe('ok');
});
it('renders copied world-space links, hides culled chains and never mutates simulation',()=>{
 const {state,v}=scene();severTrack(v,-1);const before=JSON.stringify(v),look=vehicleLook(v,state),scene3d=new TrackScene();
 scene3d.begin();scene3d.add(look);scene3d.end();expect(scene3d.group.children[0].visible).toBe(true);
 const mesh=scene3d.group.children[0].children[0],a=look.trackChains![0].points[0],b=look.trackChains![0].points[1];
 expect(mesh.position.x).toBe((a.x+b.x)/2);expect(mesh.position.y).toBe((a.z+b.z)/2);
 expect(JSON.stringify(v)).toBe(before);look.trackChains![0].points[0].x+=1;expect(JSON.stringify(v)).toBe(before);
 scene3d.begin();scene3d.end();expect(scene3d.group.children[0].visible).toBe(false);scene3d.reset();expect(scene3d.group.children).toHaveLength(0);
});

import { BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import { withoutBrokenRuns } from '@/render/vehicle3d/trackGeometry';
it('removes only the broken run and excludes baked thrown decoration, regardless of UV/index order',()=>{
 const triangle=(x:number)=>[x,0,0,x+1,0,0,x,1,0];
 const mesh=(xs:number[])=>{const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(xs.flatMap(triangle),3));return new Mesh(g);};
 const intact=mesh([0,10,20]),leftBroken=mesh([20,0,30]),rightBroken=mesh([0,10,40]);
 const left=withoutBrokenRuns(intact,[leftBroken]);expect(left.geometry.index!.array).toEqual(new Uint16Array([0,1,2,6,7,8]));
 const both=withoutBrokenRuns(intact,[leftBroken,rightBroken]);expect(both.geometry.index!.count).toBe(3);
 expect(intact.geometry.index).toBe(null);expect(intact.geometry.getAttribute('position').count).toBe(9);
});

import { resolveVehicleHit } from '@/sim/vehicleDamage';
import { WEAPONS } from '@/data/weapons';
it('a penetrating running-gear shot creates a chain without the former instant immobilization',()=>{
 const {state,v}=scene();const rng=new Rng(1);
 for(let i=0;i<10&&!v.trackChains;i++)resolveVehicleHit(state,rng,v,{weapon:WEAPONS.kwk42_75,round:'ap',shooterPos:{x:20,y:30},shooterSide:'soviet',distM:20,location:{zone:'runningGearL',face:'side',incidenceCos:1}});
 expect(v.trackChains?.L).toBeDefined();expect(v.trackChains?.R).toBeUndefined();expect(v.state).toBe('ok');
});
