import { expect, it } from 'vitest';
import { finishLocalDriver, limitMovingTwist, localDriverOwner, type LocalDriverSample, type TwistInput } from '@/sim/localDriver';
import { deriveTrackedYawModel } from '@/sim/hullActuation';
import { hullParams } from '@/data/vehiclePhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { hashState } from '@/sim/stateHash';
import { Rng } from '@/shared/rng';
import { makeState, addTank } from './vehicleDamageHelpers';
const model=deriveTrackedYawModel(hullParams(VEHICLE_DEFS.pz4gh))!;
const N=Math.ceil((model.carriedAngleSeconds/(1-model.memory)+.01)/.1);
const input=(over:Partial<TwistInput>={}):TwistInput=>({speed:3,yaw:.3,forward:2,lateral:1,rate:.05,priorYaw:0,priorPull:0,pull:0,model,envelope:{turnCapRadS:.35,onlyDir:0,appliedPullRadS:0},...over});
const mapped=(x:TwistInput,M:number)=>Math.max(x.envelope.onlyDir===1?0:-x.envelope.turnCapRadS,Math.min(x.envelope.onlyDir===-1?0:x.envelope.turnCapRadS,x.priorYaw-x.priorPull+M))+x.priorPull+x.pull;
it('admits only selected-flow corrective yaw in both gears/signs, retaining opposite inherited-rate and damage exclusions',()=>{
 for(const gear of [-1,1])for(const d of [-1,1]){
  const x=input({speed:gear*3,forward:gear*2,lateral:gear*d,rate:d*.05,yaw:d*.3});const out=limitMovingTwist(x);
  expect(out).toEqual({speed:x.speed,yaw:x.yaw,status:'correctiveOutside'});
  expect(limitMovingTwist({...x,rate:-d*.05})).toMatchObject({yaw:0,status:'outsideCone'});
  expect(limitMovingTwist({...x,rate:d*10})).toMatchObject({yaw:0,status:'outsideCone'});
  const damaged={...x,envelope:{turnCapRadS:.35,onlyDir:-d as -1|1,appliedPullRadS:0}};expect(mapped(damaged,limitMovingTwist(damaged).yaw)).toBe(0);
 }
});

it('intersects aggregate clamp/pull intervals without replacing prior owners, including zero-width feasibility',()=>{
 for(const d of [-1,1] as const){const x=input({yaw:d*.3,lateral:d,rate:d*.05,priorYaw:d*.2,priorPull:d*.04,pull:d*.02,envelope:{turnCapRadS:.1,onlyDir:d,appliedPullRadS:0}});const copy=structuredClone(x),out=limitMovingTwist(x);
  expect(out.status).toBe('correctiveOutside');expect(mapped(x,out.yaw)*d).toBeCloseTo(.16);expect(x).toEqual(copy);
  expect(limitMovingTwist({...x,priorPull:d*100}).yaw).toBe(0);
 }
 const av=.975**10,betaD=Math.atan2(av,2*av+(1-av)*3),x=input({rate:betaD/model.carriedAngleSeconds});
 expect(limitMovingTwist(x)).toMatchObject({yaw:0,status:'correctiveOutside'});
});

it('uses damped velocity angle rather than initial slip alone in an independent nominal recurrence',()=>{
 const x=input({speed:100,yaw:100,rate:0,envelope:{turnCapRadS:100,onlyDir:0,appliedPullRadS:0}}),out=limitMovingTwist(x),av=.975**10;
 const betaD=Math.atan2(av,2*av+(1-av)*100),F=mapped(x,out.yaw);
 expect(out.status).toBe('correctiveOutside');expect(model.carriedAngleSeconds*Math.abs(x.rate)+(.1-model.carriedAngleSeconds)*F).toBeLessThanOrEqual(betaD);
 const simulate=(f:number)=>{let r=0,h=0,s=2,l=1;const pole=model.memory**.1;for(let i=0;i<10;i++){r=pole*r+(1-pole)*f;h+=.01*r;l=.975*l+.025*100*Math.sin(h);s=.975*s+.025*100*Math.cos(h);}return Math.atan2(l,s)-h;};
 expect(simulate(F)).toBeGreaterThanOrEqual(-1e-12);
 const oldInitialBetaBound=Math.atan2(1,2)/(.1-model.carriedAngleSeconds);expect(simulate(oldInitialBetaBound)).toBeLessThan(0);
});
