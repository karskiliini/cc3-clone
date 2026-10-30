import { expect, it } from 'vitest';
import { deriveTrackedYawModel, projectedRate, trackedActuation, trackedMovementYaw, turnIntent } from '@/sim/hullActuation';
import { hullParams } from '@/data/vehiclePhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { createHullBody, stepHullBody } from '@/sim/hullPhysics';
import { hullAngles, multiply, normalize } from '@/sim/hullMath';
import { SIM_DT } from '@/shared/types';
import { wrapAngle } from '@/shared/math';
const flat = () => ({heightM:0,normal:{x:0,y:0,z:1}});
const def=VEHICLE_DEFS.t34_76, envelope={turnCapRadS:.3,onlyDir:0 as -1|0|1,appliedPullRadS:0};

it('derives supported catalogue geometry and explicitly rejects unsupported fallback geometry',()=>{
 for(const d of Object.values(VEHICLE_DEFS)){const p=hullParams(d);if(p.driveKind==='tracked'&&d.turnRadiusM==null)expect(deriveTrackedYawModel(p),d.id).not.toBeNull();}
 const p=hullParams(def);expect(deriveTrackedYawModel(hullParams(VEHICLE_DEFS.sdkfz251))).toBeNull();
 expect(deriveTrackedYawModel({...p,contacts:p.contacts.map(c=>({...c,driven:false}))})).toBeNull();
 expect(deriveTrackedYawModel({...p,inertia:{...p.inertia,z:0}})).toBeNull();
});

it('has independent frozen-plant closed-loop trace 2A and determinant A squared',()=>{
 // T34: twelve x=±1.26, y=±2.412,±1.4472,±.4824, independent of builder.
 const rr=12*1.26**2+4*(2.412**2+1.4472**2+.4824**2),gain=12*1.26**2/rr;
 const inertia=26000*(6.7**2+3**2)/12,tau=inertia/(26000/(12*.4)*rr),b=1-.01/tau,A=b**10;
 let C=0;for(let j=1;j<=10;j++)C+=.01*b**j;
 const model=deriveTrackedYawModel(hullParams(def))!;
 expect(model.gain).toBeCloseTo(gain,12);expect(model.memory).toBeCloseTo(A,12);expect(model.carriedAngleSeconds).toBeCloseTo(C,12);
 // Assemble columns by evolving the independent open-loop plant under actual helper control.
 const evolve=(e:number,r:number)=>{const u=trackedMovementYaw(e,r,model,{...envelope,turnCapRadS:100})/gain;return [e-C*r-gain*(.1-C)*u,A*r+gain*(1-A)*u];};
 const a=evolve(1,0),z=evolve(0,1);
 expect(a[0]+z[1]).toBeCloseTo(2*A,12);expect(a[0]*z[1]-z[0]*a[1]).toBeCloseTo(A*A,12);
 let e=1,r=.4;for(let i=0;i<200;i++)[e,r]=evolve(e,r);expect(Math.abs(e)+Math.abs(r)).toBeLessThan(1e-10);
});

it('uses full projected quaternion rate and distinguishes unclipped target error from legacy preview',()=>{
 const body=createHullBody(def,{x:10,y:10},0,flat);body.orientation=normalize({x:.2,y:.3,z:-.1,w:.9});body.angularVelocity={x:.4,y:-.3,z:.2};
 const h=1e-6,w=body.angularVelocity,next=normalize(multiply(normalize({x:w.x*h/2,y:w.y*h/2,z:w.z*h/2,w:1}),body.orientation));
 expect(projectedRate(body)!).toBeCloseTo(wrapAngle(hullAngles(next).heading-hullAngles(body.orientation).heading)/h,5);
 const m=deriveTrackedYawModel(hullParams(def))!,intent=turnIntent(1,0,.3,0,.1);
 expect(trackedMovementYaw(intent.error,0,m,envelope)).toBe(.3);
 expect(trackedMovementYaw(intent.step,0,m,envelope)).toBeLessThan(.1);
 const braking=trackedMovementYaw(0,.01,m,envelope);expect(braking).toBeCloseTo(-m.carriedAngleSeconds*.01/.1,14);
 expect(braking).toBeGreaterThan(-.01); // excludes an endpoint reset or continuous-law cascade
 body.orientation={x:.5,y:.5,z:.5,w:.5};expect(projectedRate(body)).toBeNull(); // exact vertical forward
 body.orientation={x:0,y:0,z:0,w:1};body.angularVelocity.x=Infinity;expect(projectedRate(body)).toBeNull();
});

it('maps the desired envelope and only actually appended pull once, preserving reverse and brake',()=>{
 const m=deriveTrackedYawModel(hullParams(def))!;
 for(const speed of [-3,3])for(const dir of [-1,0,1] as const){
  const cap={...envelope,onlyDir:dir,appliedPullRadS:.02};
  const request={speedMs:speed,yawRateRadS:-20,brake:false};const a=trackedActuation(request,cap,m);
  expect(a.differentialYawRadS).toBeCloseTo(((dir===1?0:-.3)+.02)/m.gain,12);expect(a.speedMs).toBe(speed);expect(request.yawRateRadS).toBe(-20);
 }
 expect(trackedActuation({speedMs:3,yawRateRadS:2,brake:true},envelope,m)).toEqual({speedMs:0,differentialYawRadS:0,brake:true});
 for(const dir of [-1,1] as const){expect(Math.sign(turnIntent(-dir*.5,0,.3,dir,.1).error)).toBe(dir);expect(trackedMovementYaw(0,dir,m,{...envelope,onlyDir:dir})).toBe(0);}
});

it('observes the actual first solver substep and restores nominal sustained flat yaw without changing raw physics',()=>{
 const p=hullParams(def),m=deriveTrackedYawModel(p)!,body=createHullBody(def,{x:10,y:10},0,flat),desired=.02;
 const converted=trackedActuation({speedMs:0,yawRateRadS:desired,brake:false},envelope,m);
 let first:number|undefined;
 stepHullBody(body,def,{speedMs:0,yawRateRadS:converted.differentialYawRadS,brake:false},flat,SIM_DT,1,()=>{first??=body.angularVelocity.z;return true;});
 const x=1.26,Iz=26000*(6.7**2+3**2)/12;
 expect(first).toBeCloseTo(.01*(26000/(12*.4))*12*x*x*converted.differentialYawRadS/Iz,12);
 for(let i=1;i<50;i++)stepHullBody(body,def,{speedMs:0,yawRateRadS:converted.differentialYawRadS,brake:false},flat,SIM_DT);
 expect(body.angularVelocity.z).toBeCloseTo(desired,4);
});
