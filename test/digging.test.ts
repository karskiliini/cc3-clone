import { expect,it } from 'vitest';
import { makeState,soldier,mkTeam } from './vehicleDamageHelpers';
import { stepDigging,canDig,diggingRate } from '@/sim/digging';
import { heightAt,buildHeightField,compressEarthworks } from '@/sim/heightField';
import { coverAt } from '@/sim/map';
import { omniCoverAt } from '@/sim/cover';
import { applyOrder } from '@/sim/orders';
import { Rng } from '@/shared/rng';
import { hashState } from '@/sim/stateHash';
import { diggingAnimation } from '@/render/soldierAnim';
import { settleTile } from '@/sim/coverSeek';
function scene(){const state=makeState(),map=state.map;map.width=map.height=30;map.tiles=Array(900).fill('grass');map.buildingId=new Int16Array(900).fill(-1);map.windows=new Uint8Array(900);map.smoke=new Float32Array(900);map.def={...map.def,width:30,height:30};map.heightField=buildHeightField(map);
 const s=soldier(1,7,'german',{x:10.5,y:10.5},'kar98k',{lastFiredAt:-999,fatigue:0});const t=mkTeam(7,'rifle',[1],'german',s.pos);state.soldiers.set(1,s);state.teams.set(7,t);state.time=20;return{state,map,s,t};}
function tick(x:ReturnType<typeof scene>,seconds:number){for(let i=0;i<seconds*10;i++){x.state.time=Math.round((x.state.time+.1)*1000)/1000;stepDigging(x.state,.1);}}
it('starts at once, grows depth/spoil over minutes, and gives intermediate then full physical cover',()=>{
 const x=scene(),c0=coverAt(x.map,x.s.pos);tick(x,.1);expect(x.s.digging).toBeDefined();expect(x.map.foxholes?.size).toBe(1);const z0=heightAt(x.map.heightField!,10.5,10.5);
 tick(x,89.9);const half=coverAt(x.map,x.s.pos),zh=heightAt(x.map.heightField!,10.5,10.5);expect(zh).toBeLessThan(z0);expect(half).toBeGreaterThan(c0);expect(half).toBeLessThan(.8);
 tick(x,100);expect(coverAt(x.map,x.s.pos)).toBeGreaterThan(half);expect(coverAt(x.map,x.s.pos)).toBeCloseTo(.8,2);expect(x.s.digging).toBeUndefined();expect([...x.map.heightField!.dig].some(z=>z>0)).toBe(true);
});
it('a new order cancels the animation immediately and the site persists and can be resumed',()=>{
 const x=scene();tick(x,20);const site=[...x.map.foxholes!.values()][0],depth=site.depthM;applyOrder(x.state,x.t,{type:'move',target:{x:14,y:10},issuedAt:x.state.time},new Rng(1));expect(x.s.digging).toBeUndefined();tick(x,2);expect(site.depthM).toBe(depth);
 x.s.path=[];x.s.activity='idle';x.s.mind.pendingOrderAt=undefined;x.s.mind.hesitation=0;x.t.order=null;x.s.pos={...site.pos};tick(x,3);expect(x.s.digging?.siteId).toBe(site.id);expect(site.depthM).toBeGreaterThan(depth);expect(x.map.foxholes!.size).toBe(1);
});
it('fire, medical, carry, movement and personal threat reactions pre-empt digging',()=>{
 const variants:((s:ReturnType<typeof scene>['s'])=>void)[]=[s=>{s.activity='firing';},s=>{s.path=[{x:12,y:10}];},s=>{s.bandageUntil=100;},s=>{s.carrying={patientId:2,since:0};},s=>{s.mind.lastIncomingAt=21;},s=>{s.mind.state='panicked';},s=>{s.crewTask={id:'digLeft',progress:0,walking:false};}];
 for(const change of variants){const x=scene();tick(x,1);change(x.s);tick(x,.1);expect(x.s.digging).toBeUndefined();}
});
it('uses personal observations; unseen enemy changes do not stop an idle man from digging',()=>{
 const a=scene(),b=scene();b.state.soldiers.set(2,soldier(2,9,'soviet',{x:12,y:12},'mosin'));
 tick(a,10);tick(b,10);expect(a.map.foxholes!.get(a.s.digging!.siteId)).toEqual(b.map.foxholes!.get(b.s.digging!.siteId));
 a.s.mind.beliefs=[{pos:{x:12,y:12},count:1,confidence:.8,kind:'seen',time:a.state.time,deadSeen:0}];tick(a,.1);expect(a.s.digging).toBeUndefined();
});
it('frozen ground and rubble are slower; rock, pavement and interiors reject excavation',()=>{
 const x=scene(),normal=diggingRate(x.state,x.s);x.map.def.season='winter';expect(diggingRate(x.state,x.s)).toBeLessThan(normal);x.map.def.season='summer';x.map.tiles[10*30+10]='rubble';expect(diggingRate(x.state,x.s)).toBeLessThan(normal);
 for(const terrain of ['pavedroad','buildingStone','floor','water'] as const){x.map.tiles[10*30+10]=terrain;expect(canDig(x.state,x.s)).toBe(false);}x.map.tiles[10*30+10]='grass';x.map.def.decor=[{kind:'rocks',x:10.5,y:10.5}];expect(canDig(x.state,x.s)).toBe(false);
});
it('a vehicle can collapse a completed personal hole, reducing all cover paths, and the soldier repairs it gradually',()=>{
 const x=scene();tick(x,190);const full=coverAt(x.map,x.s.pos);compressEarthworks(x.map,[{point:{x:21,y:21,z:0},loadNs:500000}]);const crushed=coverAt(x.map,x.s.pos);expect(crushed).toBeLessThan(full);expect(omniCoverAt(x.map,x.s.pos)).toBeCloseTo(crushed,8);
 tick(x,1);expect(x.s.digging).toBeDefined();expect(coverAt(x.map,x.s.pos)).toBeLessThan(full);tick(x,40);expect(coverAt(x.map,x.s.pos)).toBeGreaterThan(crushed);
});
it('cover seeking prefers an existing personal hole and animation is read-only with different individual phases',()=>{
 const x=scene();tick(x,190);const other=soldier(2,7,'german',{x:11.5,y:10.5},'kar98k');x.state.soldiers.delete(x.s.id);x.state.soldiers.set(2,other);x.t.soldierIds=[2];
 const tile=settleTile(x.state,other,{x:11.5,y:10.5},0,2,()=>false);expect(tile).toEqual({x:10.5,y:10.5});
 other.digging={siteId:1,startedAt:0};const rng=new Rng(1),before=hashState({state:x.state,rng});const pose=diggingAnimation(other,1);expect(pose?.keys[0]).toBe('crew.dig');expect(diggingAnimation({...other,id:3},1)?.progress).not.toBe(pose?.progress);expect(hashState({state:x.state,rng})).toBe(before);
 const site=[...x.map.foxholes!.values()][0];site.workS+=1e-12;expect(hashState({state:x.state,rng})).not.toBe(before);
});

import { stepMedic } from '@/sim/medic';
it('neither a bandaging man nor his patient digs during treatment, and other tool work takes priority',()=>{
 const x=scene();x.s.health='wounded';const medic=soldier(2,7,'german',{x:10.8,y:10.5},'kar98k');x.state.soldiers.set(2,medic);x.t.soldierIds.push(2);
 const rng=new Rng(1);stepMedic(x.state,rng,.1);x.state.time+=.1;stepMedic(x.state,rng,.1);stepDigging(x.state,.1);
 expect(x.s.digging).toBeUndefined();expect(medic.digging).toBeUndefined();
 const y=scene();y.s.lastToolWorkAt=y.state.time;expect(canDig(y.state,y.s)).toBe(false);y.state.time+=2;expect(canDig(y.state,y.s)).toBe(true);
});

it('restored canonical sites resume identically while cover caches and render dirtiness stay derived',()=>{
 const x=scene();tick(x,40);coverAt(x.map,x.s.pos);
 const restored={...x.state,map:{...x.map,heightField:structuredClone(x.map.heightField),foxholes:structuredClone(x.map.foxholes),dirtyTiles:[]},soldiers:new Map([...x.state.soldiers].map(([id,s])=>[id,structuredClone(s)])),teams:new Map([...x.state.teams].map(([id,t])=>[id,structuredClone(t)]))};
 const rng=new Rng(1);expect(coverAt(restored.map,x.s.pos)).toBe(coverAt(x.map,x.s.pos));
 for(let i=0;i<100;i++){x.state.time+=.1;restored.time+=.1;stepDigging(x.state,.1);stepDigging(restored,.1);expect(hashState({state:x.state,rng})).toBe(hashState({state:restored,rng}));}
});

import { stepMorale } from '@/sim/morale';
it('shows the ongoing individual work in the team status',()=>{const x=scene();tick(x,1);stepMorale(x.state,new Rng(1),.1);expect(x.t.status).toBe('Digging in');});
