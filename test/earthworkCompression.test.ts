import { expect,it } from 'vitest';
import { makeState,addTank } from './vehicleDamageHelpers';
import { buildHeightField,getHeightField,heightAt,compressEarthworks,earthworkCoverScale,editedEarthworkHeight,applyCrater } from '@/sim/heightField';
import { createHullBody,stepHullBody } from '@/sim/hullPhysics';
import { hullParams } from '@/data/vehiclePhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { hashState } from '@/sim/stateHash';
import { Rng } from '@/shared/rng';
import { omniCoverAt } from '@/sim/cover';
import { stepVehicles } from '@/sim/vehicle';
import { EarthField,fillFoxhole,applyEarthworkSurface,shadeField } from '@/render/craterArt';
function scene(){
 const state=makeState(),m=state.map;m.width=m.height=40;m.tiles=Array(1600).fill('open');m.buildingId=new Int16Array(1600).fill(-1);m.windows=new Uint8Array(1600);m.smoke=new Float32Array(1600);
 m.tiles[15*40+15]='trench';m.def={...m.def,width:40,height:40,decor:[{kind:'foxhole',x:15.5,y:15.5,angle:0,variant:0}]};
 m.heightField=buildHeightField(m);return{state,map:m,field:m.heightField};
}
const load=(mass:number)=>[{point:{x:31,y:31,z:0},loadNs:mass*9.81*.1}];
it('one heavy pass fills more of the same pit and repeated passes continue flattening',()=>{
 const light=scene(),heavy=scene(),z0=heightAt(light.field,15.5,15.5);
 compressEarthworks(light.map,load(hullParams(VEHICLE_DEFS.t70).massKg));compressEarthworks(heavy.map,load(hullParams(VEHICLE_DEFS.kv1).massKg));
 const zl=heightAt(light.field,15.5,15.5),zh=heightAt(heavy.field,15.5,15.5);expect(zl).toBeGreaterThan(z0);expect(zh).toBeGreaterThan(zl);
 for(let i=0;i<20;i++)compressEarthworks(heavy.map,load(hullParams(VEHICLE_DEFS.kv1).massKg));
 expect(heightAt(heavy.field,15.5,15.5)).toBeGreaterThan(zh);expect(heightAt(heavy.field,15.5,15.5)).toBeLessThan(0);
});
it('spoil subsides, pit cover falls, and untouched ordinary terrain remains exact',()=>{
 const{map,field}=scene(),before=omniCoverAt(map,{x:15.5,y:15.5}),dig=[...field.dig],flat=heightAt(field,4,4);
 const loads=[];for(let y=14;y<18;y+=.5)for(let x=14;x<18;x+=.5)loads.push({point:{x:x*2,y:y*2,z:0},loadNs:80000});
 compressEarthworks(map,loads);expect(omniCoverAt(map,{x:15.5,y:15.5})).toBeLessThan(before);expect(earthworkCoverScale(map,15,15)).toBeLessThan(1);
 expect(dig.some((z,i)=>z>0&&field.dig[i]<z)).toBe(true);expect(heightAt(field,4,4)).toBe(flat);
 expect(map.dirtyTiles!.length).toBeGreaterThan(0);
});
it('restores canonical edits and hashes them independently of render dirtiness',()=>{
 const{state,map,field}=scene(),rng=new Rng(1);compressEarthworks(map,load(45000));const h=hashState({state,rng}),z=heightAt(field,15.5,15.5);
 map.dirtyTiles=[];expect(hashState({state,rng})).toBe(h);map.heightField=structuredClone(field);expect(getHeightField(map)).toBe(map.heightField);expect(heightAt(map.heightField,15.5,15.5)).toBe(z);
 expect(hashState({state,rng})).toBe(h);map.heightField=buildHeightField(map);expect(heightAt(map.heightField,15.5,15.5)).toBe(z);
 const e=map.heightField.earthworkEdits!.values().next().value!;const before=hashState({state,rng});e.dig+=1e-12;expect(hashState({state,rng})).not.toBe(before);
});
it('a later blast deepens compressed soil and survives rebuilding',()=>{
 const{map,field}=scene();compressEarthworks(map,load(45000));const before=heightAt(field,15.5,15.5);applyCrater(field,{x:15.5,y:15.5},3);const after=heightAt(field,15.5,15.5);expect(after).toBeLessThan(before);
 map.heightField=buildHeightField(map);expect(heightAt(map.heightField,15.5,15.5)).toBe(after);
});
it('airborne and wholly rejected candidate contacts cannot compress remote earthworks',()=>{
 const{map,field}=scene(),def=VEHICLE_DEFS.kv1,body=createHullBody(def,{x:10,y:15.5},0,()=>({heightM:0,normal:{x:0,y:0,z:1}}));
 const before=[...field.dig],loads:Parameters<typeof compressEarthworks>[1][number][]=[];body.position.z+=20;
 stepHullBody(body,def,{speedMs:3,yawRateRadS:0,brake:false},()=>({heightM:0,normal:{x:0,y:0,z:1}}),.1,1,undefined,c=>{if(c.loadN)loads.push({point:c.point,loadNs:c.loadN*.01});});
 expect(loads).toHaveLength(0);compressEarthworks(map,loads);expect([...field.dig]).toEqual(before);
 body.position.z-=20;body.velocity={x:100,y:0,z:0};
 stepHullBody(body,def,{speedMs:3,yawRateRadS:0,brake:false},()=>({heightM:0,normal:{x:0,y:0,z:1}}),.1,1,()=>false,c=>{if(c.loadN)loads.push({point:c.point,loadNs:c.loadN*.01});});
 expect(loads.length).toBeGreaterThan(0);compressEarthworks(map,loads);expect([...field.dig]).toEqual(before);
});
it('production vehicle movement commits actual loaded track compression',()=>{
 const{state,map,field}=scene(),{v,team}=addTank(state,'kv1',{x:15.5,y:16.8});team.order={type:'move',target:{x:15.5,y:10},issuedAt:0};v.path=[{x:15.5,y:10}];
 const rng=new Rng(3);for(let i=0;i<70;i++){state.time+=.1;stepVehicles(state,rng,.1);}
 expect(field.earthworkEdits?.size).toBeGreaterThan(0);expect(map.heightField).toBe(field);expect([...field.earthworkEdits!.values()].some(e=>e.dig!==e.original)).toBe(true);
});
it('the procedural shaded earthwork uses the physical changed height and rendering is read-only',()=>{
 const{map,field}=scene();compressEarthworks(map,load(45000));const f=new EarthField();f.reset(88,88,1,15.5*20-44,15.5*20-44);
 const o=fillFoxhole(f,{x:310,y:310,angle:0,variant:0,men:1,seed:1},'summer'),before=new Uint8ClampedArray(f.w*f.h*4);shadeField(f,'summer',o,before);
 const canonical=[...field.dig],edits=JSON.stringify([...field.earthworkEdits!]);applyEarthworkSurface(f,(x,y,h)=>editedEarthworkHeight(field,x,y,h));
 const after=new Uint8ClampedArray(before.length);shadeField(f,'summer',o,after);expect(after).not.toEqual(before);expect([...field.dig]).toEqual(canonical);expect(JSON.stringify([...field.earthworkEdits!])).toBe(edits);
});

it('a real heavy-tank crossing compresses shallow shell holes more than a light-tank crossing',()=>{
 const crossing=(id:string)=>{
  const {state,map}=scene();map.def.decor=[];map.tiles.fill('open');map.heightField=buildHeightField(map);const field=map.heightField;
  for(const x of [14.5,15.5,16.5])applyCrater(field,{x,y:15.5},1.2);
  const initial=[...field.dig],{v,team}=addTank(state,id,{x:15.5,y:21});team.order={type:'move',target:{x:15.5,y:10},issuedAt:0};v.path=[{x:15.5,y:10}];const rng=new Rng(3);
  for(let i=0;i<160;i++){state.time+=.1;stepVehicles(state,rng,.1);}
  expect(v.pos.y).toBeLessThan(14);
  return initial.reduce((sum,z,i)=>sum+(z<0?field.dig[i]-z:0),0);
 };
 const light=crossing('t70'),heavy=crossing('kv1');expect(light).toBeGreaterThan(0);expect(heavy).toBeGreaterThan(light);
});

it('preserves the procedural outline while scaling relief by the canonical remaining fraction',()=>{
 const{map,field}=scene();compressEarthworks(map,load(45000));
 const raw=-.123456,scaled=editedEarthworkHeight(field,15.5,15.5,raw);expect(scaled).toBeGreaterThan(raw);expect(scaled).toBeLessThan(0);
 expect(editedEarthworkHeight(field,4,4,raw)).toBe(raw);
});
