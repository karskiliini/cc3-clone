import type { BattleState, TrackChainState, Vec3, Vehicle } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams, type HullParams } from '@/data/vehiclePhysics';
import { add, cross, dot, inverseRotate, rotate, yawQuat } from './hullMath';
import { groundProbe } from './hullGround';
import * as dm from '@/shared/dmath';

const SHOE_M=.04;
function frame(v:Vehicle){
 const p=hullParams(VEHICLE_DEFS[v.defId]),q=v.body?.orientation??yawQuat(v.hullFacing);
 const centre=v.body?.position??{x:v.pos.x*TILE_M,y:v.pos.y*TILE_M,z:p.cgHeightM};
 return{q,centre,origin:add(centre,rotate(q,p.modelOriginLocal)),p};
}
type Frame=ReturnType<typeof frame>;
const world=(f:Frame,p:Vec3)=>add(f.origin,rotate(f.q,p));
const local=(f:Frame,p:Vec3)=>inverseRotate(f.q,{x:p.x-f.origin.x,y:p.y-f.origin.y,z:p.z-f.origin.z});
const distance=(a:Vec3,b:Vec3)=>Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y)+(a.z-b.z)*(a.z-b.z));
function loopPoint(c:TrackChainState,s:number):Vec3{
 const straight=c.rearY-c.frontY,arc=Math.PI*c.radiusM;
 if(s<straight)return{x:c.trackX,y:c.frontY+s,z:c.wheelZ+c.radiusM};s-=straight;
 if(s<arc){const a=s/c.radiusM;return{x:c.trackX,y:c.rearY+dm.sin(a)*c.radiusM,z:c.wheelZ+dm.cos(a)*c.radiusM};}s-=arc;
 if(s<straight)return{x:c.trackX,y:c.rearY-s,z:c.wheelZ-c.radiusM};s-=straight;
 const a=s/c.radiusM;return{x:c.trackX,y:c.frontY-dm.sin(a)*c.radiusM,z:c.wheelZ-dm.cos(a)*c.radiusM};
}
/** Create an open chain at the struck link. No world/RNG/camera side state. */
export function severTrack(v:Vehicle,side:-1|1,hit?:Vec3):TrackChainState|null{
 const f=frame(v);if(f.p.driveKind==='wheeled')return null;
 const key=side<0?'L':'R',old=v.trackChains?.[key];if(old)return old;
 const support=f.p.contacts.filter(c=>c.side===side&&!c.steer),radius=Math.min(.45,Math.max(.25,f.p.widthM*.12));
 const c:TrackChainState={side,cutLink:0,pitchM:.25,radiusM:radius,trackX:side*.42*f.p.widthM,
  frontY:Math.min(...support.map(p=>p.local.y))+radius,rearY:Math.max(...support.map(p=>p.local.y))-radius,
  wheelZ:radius+.05,driveAt:f.p.layout?.transmission??'front',engaged:true,tears:[],points:[]};
 if(c.rearY-c.frontY<.5){c.frontY=-f.p.lengthM*.3;c.rearY=f.p.lengthM*.3;}
 const total=2*(c.rearY-c.frontY)+2*Math.PI*radius,count=Math.max(20,Math.min(80,Math.ceil(total/.25)));
 c.pitchM=total/count;
 const initial=Array.from({length:count},(_,index)=>world(f,loopPoint(c,index*c.pitchM)));
 if(hit){let nearest=Infinity;initial.forEach((p,index)=>{const d=distance(p,hit);if(d<nearest){nearest=d;c.cutLink=index;}});}
 const v0=v.body?.velocity??{x:0,y:0,z:0},w=v.body?.angularVelocity??{x:0,y:0,z:0};
 c.points=initial.map((_,i)=>{const index=(c.cutLink+1+i)%count,position=initial[index];return{index,position,velocity:add(v0,cross(w,{x:position.x-f.centre.x,y:position.y-f.centre.y,z:position.z-f.centre.z}))};});
 (v.trackChains??={})[key]=c;return c;
}
export function trackHasDrive(v:Vehicle,side:-1|1):boolean{
 const key=side<0?'L':'R',chain=v.trackChains?.[key];
 return chain?chain.engaged:v.damage?.[side<0?'trackL':'trackR']!=='destroyed';
}
/** Step one physically open run against running-gear cylinders and the terrain. */
function chainStep(v:Vehicle,c:TrackChainState,f:Frame,probe:ReturnType<typeof groundProbe>,dt:number):void{
 const h=dt/4,driveY=c.driveAt==='front'?c.frontY:c.rearY;
 const wheels=Array.from({length:6},(_,i)=>c.frontY+(c.rearY-c.frontY)*i/5);
 let driveContacts=0;
 for(let sub=0;sub<4;sub++){
  const previous=c.points.map(p=>({...p.position}));
  for(const p of c.points){p.velocity.z-=9.81*h;p.position=add(p.position,{x:p.velocity.x*h,y:p.velocity.y*h,z:p.velocity.z*h});}
  for(let pass=0;pass<7;pass++){
   for(let i=0;i<c.points.length-1;i++){
    if(c.tears.includes(i))continue;
    const a=c.points[i].position,b=c.points[i+1].position,d=distance(a,b);if(d===0)continue;
    const k=(d-c.pitchM)/(2*d),x=(b.x-a.x)*k,y=(b.y-a.y)*k,z=(b.z-a.z)*k;
    a.x+=x;a.y+=y;a.z+=z;b.x-=x;b.y-=y;b.z-=z;
   }
   for(const p of c.points){
    const q=local(f,p.position);
    if(Math.abs(q.x-c.trackX)<.32){
     for(const y of wheels){const dy=q.y-y,dz=q.z-c.wheelZ,d=Math.sqrt(dy*dy+dz*dz),r=c.radiusM+SHOE_M;
      if(d>0&&d<r){q.y=y+dy*r/d;q.z=c.wheelZ+dz*r/d;}
     }
     p.position=world(f,q);
    }
    p.position.z=Math.max(p.position.z,probe(p.position.x,p.position.y).heightM+SHOE_M);
   }
  }
  driveContacts=0;
  for(let i=0;i<c.points.length;i++){
   const p=c.points[i],old=previous[i];p.velocity={x:(p.position.x-old.x)/h*.985,y:(p.position.y-old.y)/h*.985,z:(p.position.z-old.z)/h*.985};
   const q=local(f,p.position),dy=q.y-driveY,dz=q.z-c.wheelZ,d=Math.sqrt(dy*dy+dz*dz);
   if(Math.abs(q.x-c.trackX)<.25&&Math.abs(d-(c.radiusM+SHOE_M))<.10){
    driveContacts++;
    if(c.engaged&&d>0){
     const tangent=rotate(f.q,{x:0,y:-dz/d*v.speed,z:dy/d*v.speed});
     const body=v.body,base=body?add(body.velocity,cross(body.angularVelocity,{x:p.position.x-f.centre.x,y:p.position.y-f.centre.y,z:p.position.z-f.centre.z})):{x:0,y:0,z:0};
     const goal=add(base,tangent);p.velocity={x:p.velocity.x*.35+goal.x*.65,y:p.velocity.y*.35+goal.y*.65,z:p.velocity.z*.35+goal.z*.65};
    }
   }
   const ground=probe(p.position.x,p.position.y).heightM+SHOE_M;
   if(p.position.z<=ground+.005){p.velocity.x*=.8;p.velocity.y*=.8;if(p.velocity.z<0)p.velocity.z=0;}
   const speed=Math.sqrt(dot(p.velocity,p.velocity));if(speed>30){const k=30/speed;p.velocity={x:p.velocity.x*k,y:p.velocity.y*k,z:p.velocity.z*k};}
  }
 }
 // Once no link bears on the drive sprocket, a broken run cannot magically reconnect.
 if(driveContacts===0)c.engaged=false;
 for(let i=0;i<c.points.length-1;i++)if(!c.tears.includes(i)&&distance(c.points[i].position,c.points[i+1].position)>c.pitchM*2.5)c.tears.push(i);
}
export function stepTrackPhysics(state:BattleState,v:Vehicle,dt:number):void{
 if(dt!==SIM_DT)throw new Error('Track physics requires fixed SIM_DT');
 if(!v.trackChains)return;
 const f=frame(v),probe=groundProbe(state.map,'tick');
 for(const c of [v.trackChains.L,v.trackChains.R])if(c)chainStep(v,c,f,probe,dt);
}

/** Remove longitudinal drive/braking on a run physically off its sprocket. */
export function trackHullParams(v:Vehicle,p:HullParams):HullParams {
 if(!v.trackChains)return p;
 const left=trackHasDrive(v,-1),right=trackHasDrive(v,1);
 if(left&&right)return p;
 return {...p,contacts:p.contacts.map(c=>!c.steer&&!(c.side<0?left:right)?{...c,driven:false,brake:false}:c)};
}
