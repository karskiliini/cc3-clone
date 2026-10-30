import { expect, it } from 'vitest';
import * as driver from '@/sim/localDriver';
import { deriveTrackedYawModel } from '@/sim/hullActuation';
import { hullParams } from '@/data/vehiclePhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { makeState,addTank } from './vehicleDamageHelpers';
import { createHullBody } from '@/sim/hullPhysics';
const model=deriveTrackedYawModel(hullParams(VEHICLE_DEFS.pz4gh))!;
const N=Math.ceil((model.carriedAngleSeconds/(1-model.memory)+.01)/.1);
const tank=()=>{const v=addTank(makeState(),'pz4gh',{x:0,y:0}).v;v.body=createHullBody(VEHICLE_DEFS.pz4gh,v.pos,0,()=>({heightM:0,normal:{x:0,y:0,z:1},material:'dirt'}));return v;};
const sample=(over:any={}):any=>({owner:1,goal:{x:10,y:-10},gear:1,fullSpeed:3,heading:0,initialRate:.005,error:Math.PI/4,ownYaw:.3,legacyYaw:.3,signedDemand:2,onlyDir:0,frontAvailable:true,position:{x:0,y:0},velocity:{x:0,y:-.02},priorYaw:0,priorPull:0,recovery:false,eligible:true,translationIntent:true,model,...over});
const actual=(over:any={}):any=>({position:{x:0,y:0},velocity:{x:0,y:-.02},heading:0,finalRate:.005,length:5.9,experience:0,terrainRejects:0,effectiveYaw:.3,straightRad:4*Math.PI/180,...over});
it('one goal window survives alternating admission, zero crossings and gate zeros, then arms its last allowed attempt',()=>{
 const v=tank();for(let i=0;i<N;i++)driver.finishLocalDriver(v,sample({ownYaw:i%2?.3:0,initialRate:i%2?-.005:.005}),actual({finalRate:i%2?.005:-.005,effectiveYaw:i%2?.3:0}));
 expect(v.localDriver?.episode).toMatchObject({attempts:1,limit:1,exhausted:true});expect((v.localDriver as any)?.recovery).toMatchObject({phase:'pending',budgetTicks:0,elapsedTicks:0,gear:-1});
 expect(Object.keys(v.localDriver!.episode!.anchorM)).toEqual(['x','y']);
});
it('nominal large opposing angular and longitudinal momentum earns net response credit without a zero-cross deadline',()=>{
 for(const channel of ['angular','travel']){const v=tank();let r=-20,s=-20;
  for(let i=0;i<N;i++){const nr=model.memory*r+(1-model.memory)*.3,ns=(.975**10)*s+(1-.975**10)*2;
   driver.finishLocalDriver(v,sample({initialRate:channel==='angular'?r:0,velocity:{x:0,y:channel==='travel'?-s:-.02}}),actual({finalRate:channel==='angular'?nr:0,velocity:{x:0,y:channel==='travel'?-ns:-.02},heading:-.01}));r=nr;s=ns;}
  expect(v.localDriver?.episode).toBeNull();expect(v.localDriver?.window).toBeNull();expect(channel==='angular'?r:s).toBeLessThan(0);
 }
});
it('zero intent never auto-passes a zero reference and front-unavailable cannot spend or arm',()=>{
 const idle=tank();driver.finishLocalDriver(idle,sample({legacyYaw:0,signedDemand:0}),actual());expect(idle.localDriver?.window).toBeNull();
 const excluded=tank();for(let i=0;i<N+1;i++)driver.finishLocalDriver(excluded,sample({frontAvailable:false}),actual());expect(excluded.localDriver?.episode).toBeNull();expect(excluded.localDriver?.window).toBeNull();
});
it('live goal, gear, damage rule and owner restart observation; crossing/controller category alone do not',()=>{
 const v=tank();driver.finishLocalDriver(v,sample(),actual());driver.finishLocalDriver(v,sample({initialRate:-.005,ownYaw:0}),actual());expect(v.localDriver?.window?.ticks).toBe(2);
 for(const over of [{goal:{x:11,y:-10}},{gear:-1},{onlyDir:1},{owner:2}]){driver.finishLocalDriver(v,sample(over),actual());expect(v.localDriver?.window?.ticks).toBe(1);}
});
it('box extrema match an independent eight-corner rotation under tilt and offset',()=>{
 const box={min:{x:-2,y:-3,z:-1},max:{x:1,y:4,z:2}},q={x:.2,y:.3,z:.1,w:Math.sqrt(.86)},body={position:{x:7,y:-2,z:5},orientation:q},axis={x:.6,y:.8},anchor={x:1,y:2};
 const values:number[]=[];for(const x of [-2,1])for(const y of [-3,4])for(const z of [-1,2]){
  const xx=(1-2*q.y*q.y-2*q.z*q.z)*x+2*(q.x*q.y-q.z*q.w)*y+2*(q.x*q.z+q.y*q.w)*z;
  const yy=2*(q.x*q.y+q.z*q.w)*x+(1-2*q.x*q.x-2*q.z*q.z)*y+2*(q.y*q.z-q.x*q.w)*z;
  values.push((7+xx-1)*.6+(-2+yy-2)*.8);
 }
 const got=(driver as any).boxProjection(body,box,axis,anchor);expect(got.min).toBeCloseTo(Math.min(...values),12);expect(got.max).toBeCloseTo(Math.max(...values),12);
});
it('reverse command and forward coasting cannot finish recovery or refill episode; finite budget ends it',()=>{
 const v=tank();for(let i=0;i<N;i++)driver.finishLocalDriver(v,sample(),actual());const s:any=v.localDriver;
 v.body!.velocity={x:0,y:-2,z:0};expect((driver as any).initLocalRecovery(v,-2)).toBe(true);const box=hullParams(VEHICLE_DEFS.pz4gh).solidBox,cornerNorms:number[]=[];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z])cornerNorms.push(Math.sqrt(x*x+y*y+z*z));
 const expected=Math.ceil(((s.recovery.entryMaxProjection+Math.max(...cornerNorms))/2+.39*(1+2/2))/.1);expect(s.recovery.budgetTicks).toBe(expected);const budget=s.recovery.budgetTicks;
 // Displacement in the original forward direction exceeds the episode length but is NOT retreat.
 v.body!.position.y=-10;driver.finishLocalDriver(v,sample({recovery:true}),actual({position:{x:0,y:-10},velocity:{x:0,y:-1}}));
 expect(s.episode?.attempts).toBe(1);expect(s.recovery?.phase).toBe('braking');expect(s.recovery?.budgetTicks).toBe(budget);
 v.body!.position.y=0;s.recovery.elapsedTicks=budget-1;driver.finishLocalDriver(v,sample({recovery:true}),actual({position:{x:0,y:0},velocity:{x:0,y:-1}}));expect(s.recovery).toBeNull();expect(s.episode.exhausted).toBe(true);
 driver.finishLocalDriver(v,sample(),actual());expect(s.recovery).toBeNull();expect(s.window).toBeNull();
});
it('unavailable initialization consumes its armed attempt and cannot rearm that frame',()=>{
 const v=tank();for(let i=0;i<N;i++)driver.finishLocalDriver(v,sample(),actual());expect((driver as any).initLocalRecovery(v,0)).toBe(false);
 driver.finishLocalDriver(v,sample({recovery:true}),actual());expect((v.localDriver as any).recovery).toBeNull();expect(v.localDriver?.window).toBeNull();expect(v.localDriver?.episode?.attempts).toBe(1);
});
it('actual box clearance succeeds and post-termination net-length reset is atomic, including owner0 interruption',()=>{
 const v=tank();for(let i=0;i<N;i++)driver.finishLocalDriver(v,sample(),actual());(driver as any).initLocalRecovery(v,-2);
 v.body!.position.y=20;driver.finishLocalDriver(v,sample({recovery:true}),actual({position:{x:0,y:20},velocity:{x:0,y:1}}));expect(v.localDriver).toMatchObject({episode:null,recovery:null,window:null});
 v.body!.position.y=0;for(let i=0;i<N;i++)driver.finishLocalDriver(v,sample(),actual());driver.localDriverOwner(v,0);driver.finishLocalDriver(v,undefined,actual({position:{x:0,y:20}}));expect(v.localDriver).toBeUndefined();
});

it('front interruption cancels active work without refund or same-frame observation',()=>{
 const v=tank();for(let i=0;i<N;i++)driver.finishLocalDriver(v,sample(),actual());
 driver.finishLocalDriver(v,sample({frontAvailable:false,recovery:true}),actual());expect((v.localDriver as any).recovery).toBeNull();expect(v.localDriver?.window).toBeNull();expect(v.localDriver?.episode?.attempts).toBe(1);
});


it('finishes a turn recovery on accepted original-route alignment without refunding attempts', () => {
  for (const turning of [false, true]) {
    const v = tank();
    for (let i = 0; i < N; i++) driver.finishLocalDriver(v, sample(), actual());
    const state = v.localDriver!;
    state.recovery!.turning = turning;
    driver.initLocalRecovery(v, -2);
    driver.finishLocalDriver(v, sample({ recovery: true }), actual({ heading: Math.PI / 4 }));
    expect(state.recovery === null).toBe(turning);
    expect(state.episode!.attempts).toBe(1);
    expect(state.episode!.exhausted).toBe(true);
  }
});
