import { expect, it } from 'vitest';
import { limitMovingTwist, terminalSpeed, finishLocalDriver, localDriverOwner, type TwistInput, type LocalDriverSample } from '@/sim/localDriver';
import { deriveTrackedYawModel } from '@/sim/hullActuation';
import { hullParams } from '@/data/vehiclePhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { makeState, addTank } from './vehicleDamageHelpers';
const model = deriveTrackedYawModel(hullParams(VEHICLE_DEFS.pz4gh))!;
const input = (over: Partial<TwistInput> = {}): TwistInput => ({speed:3,yaw:.3,forward:2,lateral:.1,rate:.05,priorYaw:0,priorPull:0,pull:0,model,envelope:{turnCapRadS:.35,onlyDir:0,appliedPullRadS:0},...over});
it('bounds independent nominal ten-substep coasting/forward/reverse twist including clamp and pull',()=>{
 for(const gear of [-1,1] as const) for(const speed of [0,3]) for(const rate of [-.2,.2]) {
  const x=input({speed:gear*speed,forward:gear*2,lateral:gear*.08,rate,priorYaw:.04,priorPull:.02,pull:-.01});
  const out=limitMovingTwist(x);expect(out.status).toBe('admitted');
  const F=Math.max(-.35,Math.min(.35,x.priorYaw-x.priorPull+out.yaw))+x.priorPull+x.pull;
  // Independent nominal isotropic planar damping and discrete yaw recurrence, no production integrator/helper.
  const b=model.memory**.1; let r=rate,h=0,vx=x.lateral,vy=x.forward,dx=0,dy=0;
  for(let j=0;j<10;j++){ r=b*r+(1-b)*F; h+=2*Math.atan(.005*r); vx=.975*vx+.025*out.speed*Math.sin(h);vy=.975*vy+.025*out.speed*Math.cos(h);dx+=.01*vx;dy+=.01*vy; }
  for(const [xv,yv] of [[vx,vy],[dx,dy]]) { const lateral=xv*Math.cos(h)-yv*Math.sin(h),f=xv*Math.sin(h)+yv*Math.cos(h);expect(Math.abs(Math.atan2(gear*lateral,gear*f))).toBeLessThan(8*Math.PI/180); }
 }
});

it('retains reversed-flow counterthrust and suppresses only its own yaw outside the proof',()=>{
 const out=limitMovingTwist(input({speed:3,forward:-2,lateral:1}));expect(out).toEqual({speed:3,yaw:0,status:'counterthrust'});
 expect(limitMovingTwist(input({forward:2,lateral:1})).status).toBe('correctiveOutside');
 expect(limitMovingTwist(input({rate:10})).status).toBe('infeasible');
 const x=input({priorYaw:1,priorPull:.2,pull:.2,rate:1});expect(limitMovingTwist(x).yaw).toBe(0);expect(x.priorYaw).toBe(1);expect(x.priorPull).toBe(.2);
 expect(Object.is(limitMovingTwist(input({speed:-0,forward:0,lateral:0,rate:Infinity})).speed,0)).toBe(true);
});

it('contracts independent fixed-heading stopping error without overshoot, including counterflow',()=>{
 for(const initial of [-2,0,2]){let p=0,v=initial;const goal=6,Tb=.39;let before=goal-p-Tb*v;
  for(let i=0;i<120;i++){const S=terminalSpeed(5,{x:0,y:-p},{x:0,y:-v},0,{x:0,y:-goal},1);for(let j=0;j<10;j++){v=.975*v+.025*S;p+=.01*v;}
   const e=goal-p-Tb*v;expect(e).toBeGreaterThanOrEqual(-1e-12);expect(e).toBeLessThanOrEqual(before+1e-12);before=e;}
  expect(Math.abs(goal-p)).toBeLessThan(.01);
 }
 expect(terminalSpeed(-0,{x:0,y:0},{x:0,y:0},0,{x:0,y:1},-1)).toBe(0);
});

it('rechecks the original strict scalar cone at a rounded interval endpoint',()=>{
 const beta=8*Math.PI/180-model.carriedAngleSeconds*.02-(.1-model.carriedAngleSeconds)*.2;
 const x=input({lateral:2*Math.tan(beta),rate:.02});const out=limitMovingTwist(x);
 const F=Math.max(-.35,Math.min(.35,x.priorYaw-x.priorPull+out.yaw))+x.priorPull+x.pull;
 expect(Math.abs(Math.atan2(x.lateral,x.forward))+model.carriedAngleSeconds*Math.abs(x.rate)+(.1-model.carriedAngleSeconds)*Math.abs(F)).toBeLessThan(8*Math.PI/180);
 expect(out.yaw).toBeLessThan(x.yaw);
});

it('counterthrust crosses the longitudinal sign while lateral momentum stays physical',()=>{
 const out=limitMovingTwist(input({forward:-.1,lateral:.2,speed:3}));let s=-.1,l=.2;
 for(let j=0;j<10;j++){s=.975*s+.025*out.speed;l*=.975;}
 expect(out.status).toBe('counterthrust');expect(out.speed).toBe(3);expect(out.yaw).toBe(0);expect(s).toBeGreaterThan(0);expect(l).toBeGreaterThan(0);
});

it('admits against the aggregate one-sided clamp and explicitly retains infeasible independent yaw',()=>{
 for(const direction of [-1,1] as const){const x=input({yaw:direction*.3,priorYaw:direction*.4,priorPull:direction*.02,pull:direction*.01,envelope:{turnCapRadS:.1,onlyDir:direction,appliedPullRadS:0}});const out=limitMovingTwist(x);expect(out.status).toBe('admitted');
  const F=(direction===1?Math.max(0,Math.min(.1,x.priorYaw-x.priorPull+out.yaw)):Math.max(-.1,Math.min(0,x.priorYaw-x.priorPull+out.yaw)))+x.priorPull+x.pull;
  const bound=Math.abs(Math.atan2(x.lateral,x.forward))+model.carriedAngleSeconds*Math.abs(x.rate)+(.1-model.carriedAngleSeconds)*Math.abs(F);expect(bound).toBeLessThan(8*Math.PI/180);
 }
 const beta=8*Math.PI/180-(.1-model.carriedAngleSeconds)*.2;const x=input({lateral:2*Math.tan(beta),rate:0,priorYaw:.3});expect(limitMovingTwist(x)).toMatchObject({yaw:0,status:'infeasible',speed:3});expect(x.priorYaw).toBe(.3);
});

it('uses strict planar standstill admission only for zero requested translation without changing measured velocity',()=>{
 const cases=[{forward:0,lateral:.049,speed:0,standstill:true},{forward:0,lateral:.05,speed:0,standstill:false},{forward:0,lateral:.051,speed:0,standstill:false},{forward:-.049,lateral:0,speed:0,standstill:true},{forward:-1,lateral:0,speed:0,standstill:false},{forward:.03,lateral:.04,speed:0,standstill:false},{forward:.029,lateral:.039,speed:0,standstill:true},{forward:0,lateral:.049,speed:3,standstill:false},{forward:0,lateral:0,speed:0,standstill:true}];
 for(const c of cases){const x=Object.freeze(input({...c}));const before=structuredClone(x);const out=limitMovingTwist(x);expect(out.status==='standstill',JSON.stringify(c)).toBe(c.standstill);if(c.standstill){expect(out.yaw).toBe(x.yaw);expect(out.speed).toBe(0);}expect(x).toEqual(before);}
});
