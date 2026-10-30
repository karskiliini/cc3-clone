import type { HullBody, LocalDriverReflex, Vec2, Vehicle } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { clamp, wrapAngle } from '@/shared/math';
import * as dm from '@/shared/dmath';
import { turnIntent, type TrackedYawModel, type YawEnvelope } from './hullActuation';
import { inverseRotate } from './hullMath';
import { hullParams, type HullParams } from '@/data/vehiclePhysics';
import { VEHICLE_DEFS } from '@/data/units';
import { HULL_CONTACT_RESPONSE_S, HULL_SUBSTEPS } from './hullActuationConstants';

export const CONE_RAD = 8 * Math.PI / 180;
export const STANDSTILL_MS = 0.05;
const PLANAR_MEMORY = (() => {
  const q = 1 - SIM_DT / HULL_SUBSTEPS / HULL_CONTACT_RESPONSE_S;
  let value = 1;
  for (let i = 0; i < HULL_SUBSTEPS; i++) value *= q;
  return value;
})();
const bits = new DataView(new ArrayBuffer(8));
function belowPositive(x: number): number {
  bits.setFloat64(0, x); bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
  return bits.getFloat64(0);
}
export interface TwistInput {
  speed: number; yaw: number; forward: number; lateral: number; rate: number;
  priorYaw: number; priorPull: number; pull: number;
  model: TrackedYawModel; envelope: YawEnvelope;
}
export interface LimitedTwist { speed: number; yaw: number; status: 'standstill' | 'admitted' | 'counterthrust' | 'outsideCone' | 'correctiveOutside' | 'infeasible' | 'unsupported' }
/** Nominal flat same-flow cone admission. Counterthrust and existing owners retain authority. */
export function limitMovingTwist(x: TwistInput): LimitedTwist {
  const { speed, yaw, forward, lateral, rate, priorYaw, priorPull, pull, model, envelope } = x;
  const result = (y: number, status: LimitedTwist['status'], s = speed): LimitedTwist => ({ speed: s === 0 ? 0 : s, yaw: y === 0 ? 0 : y, status });
  if (![speed,yaw,forward,lateral,rate,priorYaw,priorPull,pull,model.gain,model.memory,model.carriedAngleSeconds,envelope.turnCapRadS].every(Number.isFinite)
    || !(model.gain > 0 && model.memory >= 0 && model.memory < 1 && model.carriedAngleSeconds >= 0 && model.carriedAngleSeconds < SIM_DT))
    return result(0, 'unsupported', 0);
  if (speed === 0 && dm.hypot(forward, lateral) < STANDSTILL_MS) return result(yaw, 'standstill');
  const gear = speed !== 0 ? Math.sign(speed) : forward < 0 ? -1 : 1;
  if (speed !== 0 && gear * forward < 0) return result(0, 'counterthrust');
  const beta = forward === 0 && lateral === 0 ? 0 : dm.atan2(gear * lateral, gear * forward);
  if (Math.abs(beta) >= CONE_RAD) {
    const d = Math.sign(beta), S = Math.abs(speed);
    if (!(d * rate >= 0 && d * yaw > 0 && Math.abs(beta) <= Math.PI / 2)) return result(0, 'outsideCone');
    const betaD = dm.atan2(PLANAR_MEMORY * Math.abs(lateral), PLANAR_MEMORY * gear * forward + (1 - PLANAR_MEMORY) * S);
    const U = (betaD - model.carriedAngleSeconds * Math.abs(rate)) / (SIM_DT - model.carriedAngleSeconds);
    if (!(U >= 0 && Number.isFinite(U))) return result(0, 'outsideCone');
    const L = priorPull + pull, base = priorYaw - priorPull;
    const a = envelope.onlyDir === 1 ? 0 : -envelope.turnCapRadS, b = envelope.onlyDir === -1 ? 0 : envelope.turnCapRadS;
    const lo = Math.max((d > 0 ? 0 : -U) - L, a), hi = Math.min((d > 0 ? U : 0) - L, b);
    if (lo > hi) return result(0, 'outsideCone');
    const mlo = Math.max(Math.min(0, yaw), lo === a ? -Infinity : lo - base);
    const mhi = Math.min(Math.max(0, yaw), hi === b ? Infinity : hi - base);
    if (mlo > mhi) return result(0, 'outsideCone');
    const selected = clamp(yaw, mlo, mhi), F = clamp(base + selected, a, b) + L;
    return d * F >= 0 && d * F <= U && model.carriedAngleSeconds * Math.abs(rate) + (SIM_DT - model.carriedAngleSeconds) * d * F <= betaD
      ? result(selected, 'correctiveOutside') : result(0, 'outsideCone');
  }
  const budget = (CONE_RAD - Math.abs(beta) - model.carriedAngleSeconds * Math.abs(rate)) / (SIM_DT - model.carriedAngleSeconds);
  if (!(budget > 0 && Number.isFinite(budget))) return result(0, 'infeasible');
  const B = belowPositive(budget), L = priorPull + pull;
  const a = envelope.onlyDir === 1 ? 0 : -envelope.turnCapRadS;
  const b = envelope.onlyDir === -1 ? 0 : envelope.turnCapRadS;
  const lo = Math.max(-B - L, a), hi = Math.min(B - L, b), base = priorYaw - priorPull;
  if (lo > hi) return result(0, 'infeasible');
  const mlo = Math.max(Math.min(0, yaw), lo === a ? -Infinity : lo - base);
  const mhi = Math.min(Math.max(0, yaw), hi === b ? Infinity : hi - base);
  if (mlo > mhi) return result(0, 'infeasible');
  const selected = clamp(yaw, mlo, mhi), effective = clamp(base + selected, a, b) + L;
  const variation = Math.abs(beta) + model.carriedAngleSeconds * Math.abs(rate) + (SIM_DT - model.carriedAngleSeconds) * Math.abs(effective);
  return Math.abs(effective) < budget && variation < CONE_RAD ? result(selected, 'admitted') : result(0, 'infeasible');
}

/** One current live waypoint, metres, accepted heading. No goal or stopping-point history. */
export function terminalSpeed(speed: number, position: Vec2, velocity: Vec2, heading: number, goal: Vec2, gear: -1 | 1): number {
  const fx = gear * dm.sin(heading), fy = -gear * dm.cos(heading), Tb = HULL_CONTACT_RESPONSE_S - SIM_DT / HULL_SUBSTEPS;
  const a = (goal.x - position.x) * fx + (goal.y - position.y) * fy, s = velocity.x * fx + velocity.y * fy;
  const cap = Math.max(0, (a - Tb * s) / (Tb + SIM_DT));
  const out = Math.min(Math.abs(speed), cap);
  return out === 0 ? 0 : gear * out;
}

/** Owner/priority interruption never replenishes the episode budget. */
export function localDriverOwner(v: Vehicle, owner: LocalDriverReflex['owner']): void {
  let s = v.localDriver;
  if (!s && owner !== 0) s = v.localDriver = { owner, episode: null, recovery: null, window: null };
  if (!s) return;
  if (owner === 0 || s.owner !== owner) { s.recovery = null; s.window = null; }
  s.owner = owner;
  if (owner === 0 && !s.episode && !s.recovery && !s.window) delete v.localDriver;
}
export interface LocalDriverSample {
  owner: 1 | 2; goal: Vec2; gear: -1 | 1; fullSpeed: number;
  position: Vec2; velocity: Vec2; heading: number; initialRate: number; error: number; ownYaw: number;
  legacyYaw: number; signedDemand: number; onlyDir: -1 | 0 | 1; frontAvailable: boolean;
  priorYaw: number; priorPull: number; recovery: boolean; eligible: boolean; translationIntent: boolean;
  model: TrackedYawModel;
}
export interface LocalDriverAccepted {
  position: Vec2; velocity: Vec2; heading: number; finalRate: number | null; length: number; experience: number;
  terrainRejects: number; effectiveYaw: number; straightRad: number;
}
type Box = HullParams['solidBox'];
/** Exact support of the accepted oriented box along one horizontal world axis, no probes. */
export function boxProjection(body: Pick<HullBody,'position'|'orientation'>, box: Box, axis: Vec2, anchor: Vec2): {min:number;max:number} {
  const u=inverseRotate(body.orientation,{x:axis.x,y:axis.y,z:0});
  const centre=(body.position.x-anchor.x)*axis.x+(body.position.y-anchor.y)*axis.y;
  let min=centre,max=centre;
  for(const k of ['x','y','z'] as const){min+=u[k]*(u[k]>=0?box.min[k]:box.max[k]);max+=u[k]*(u[k]>=0?box.max[k]:box.min[k]);}
  return {min,max};
}
const planarResponse=(()=>{const h=SIM_DT/HULL_SUBSTEPS,q=1-h/HULL_CONTACT_RESPONSE_S;let A=1,C=0;
  for(let i=0;i<HULL_SUBSTEPS;i++){A*=q;C+=h*A;}return {A,C};})();
function boxRadius(box:Box):number {
  const x=Math.max(Math.abs(box.min.x),Math.abs(box.max.x)),y=Math.max(Math.abs(box.min.y),Math.abs(box.max.y)),z=Math.max(Math.abs(box.min.z),Math.abs(box.max.z));
  return Math.sqrt(x*x+y*y+z*z);
}
/** Called only at the final post-gate/roll request, before its first actual integration. */
export function initLocalRecovery(v:Vehicle,speedMs:number):boolean {
  const r=v.localDriver?.recovery;if(!r)return false;if(r.phase!=='pending')return true;
  const body=v.body,def=VEHICLE_DEFS[v.defId],V=Math.abs(speedMs);
  if(!body||!def||!(V>0&&Number.isFinite(V))){v.localDriver!.recovery=null;return false;}
  const w=Math.max(0,-(body.velocity.x*r.axis.x+body.velocity.y*r.axis.y));
  const B=r.entryMaxProjection+boxRadius(hullParams(def).solidBox),Tb=HULL_CONTACT_RESPONSE_S-SIM_DT/HULL_SUBSTEPS;
  const budget=Math.max(1,Math.ceil((B/V+Tb*(1+w/V))/SIM_DT));
  if(!Number.isSafeInteger(budget)||!Number.isFinite(B)||!Number.isFinite(w)){v.localDriver!.recovery=null;return false;}
  r.budgetTicks=budget;r.phase=w>0||body.velocity.x*r.axis.x+body.velocity.y*r.axis.y<=0?'braking':'retreat';return true;
}
function goalError(goal:Vec2,position:Vec2,heading:number,gear:-1|1,onlyDir:-1|0|1):number {
  const desired=dm.atan2(goal.x*TILE_M-position.x,position.y-goal.y*TILE_M)+(gear<0?Math.PI:0);
  return turnIntent(desired,heading,0,onlyDir,0).error;
}
/** Actual post-gameplay response only; never query terrain/threats or simulate future motion. */
export function finishLocalDriver(v: Vehicle, sample: LocalDriverSample | undefined, actual: LocalDriverAccepted): void {
  const owner=sample?.owner??0;localDriverOwner(v,owner);const s=v.localDriver;if(!s)return;
  const reset=()=>{
    if(!s.recovery&&s.episode&&dm.hypot(actual.position.x-s.episode.anchorM.x,actual.position.y-s.episode.anchorM.y)>=actual.length){
      s.episode=null;s.window=null;localDriverOwner(v,owner);return true;
    }return false;
  };
  const valid=!!sample&&sample.eligible&&sample.frontAvailable&&sample.priorYaw===0&&sample.priorPull===0
    &&actual.finalRate!=null&&Number.isFinite(actual.finalRate)&&!!v.body&&!v.body.overturned
    &&[sample.initialRate,sample.heading,sample.legacyYaw,sample.signedDemand,sample.fullSpeed,sample.position.x,sample.position.y,
      sample.velocity.x,sample.velocity.y,sample.goal.x,sample.goal.y,sample.error,actual.position.x,actual.position.y,actual.velocity.x,actual.velocity.y,actual.heading,actual.length,actual.experience,actual.straightRad,
      v.body.orientation.x,v.body.orientation.y,v.body.orientation.z,v.body.orientation.w].every(Number.isFinite)
    &&(sample.onlyDir===-1||sample.onlyDir===0||sample.onlyDir===1)&&actual.length>0&&sample.model&&sample.model.gain>0&&Number.isFinite(sample.model.gain)&&sample.model.memory>=0&&sample.model.memory<1
    &&sample.model.carriedAngleSeconds>=0&&sample.model.carriedAngleSeconds<SIM_DT;
  if(!valid){s.recovery=null;s.window=null;reset();return;}
  if(sample.recovery){
    const r=s.recovery;
    if(r){
      r.elapsedTicks++;
      if(actual.velocity.x*r.axis.x+actual.velocity.y*r.axis.y>0)r.phase='retreat';
      const clearance=boxProjection(v.body!,hullParams(VEHICLE_DEFS[v.defId]).solidBox,r.axis,r.anchorM).min;
      const aligned = r.turning && Math.abs(goalError(sample.goal, actual.position,
        actual.heading, sample.gear, sample.onlyDir)) <= actual.straightRad;
      if(aligned||clearance>=r.entryMaxProjection||r.elapsedTicks>=r.budgetTicks)s.recovery=null;
    }
    s.window=null;reset();return;
  }
  if(reset())return;
  if(s.episode?.exhausted){s.window=null;return;}
  if(sample.legacyYaw===0&&sample.signedDemand===0){s.window=null;return;}
  const error=goalError(sample.goal,sample.position,sample.heading,sample.gear,sample.onlyDir);
  let w=s.window;
  if(!w||w.goal.x!==sample.goal.x||w.goal.y!==sample.goal.y||w.gear!==sample.gear||w.onlyDir!==sample.onlyDir){
    const axis={x:sample.gear*dm.sin(sample.heading),y:-sample.gear*dm.cos(sample.heading)};
    w=s.window={goal:{x:sample.goal.x,y:sample.goal.y},gear:sample.gear,onlyDir:sample.onlyDir,
      direction:Math.abs(error)>actual.straightRad?Math.sign(error) as -1|1:0,ticks:0,
      startDistanceM:dm.hypot(sample.goal.x*TILE_M-sample.position.x,sample.goal.y*TILE_M-sample.position.y),
      startAbsError:Math.abs(error),startRate:sample.initialRate,axis,startFlow:sample.velocity.x*axis.x+sample.velocity.y*axis.y,
      minimumYaw:0,minimumSpeed:0};
  }
  w.ticks++;
  if(w.direction*sample.legacyYaw>0)w.minimumYaw=w.minimumYaw===0?Math.abs(sample.legacyYaw):Math.min(w.minimumYaw,Math.abs(sample.legacyYaw));
  if(Math.abs(sample.signedDemand)>0)w.minimumSpeed=w.minimumSpeed===0?Math.abs(sample.signedDemand):Math.min(w.minimumSpeed,Math.abs(sample.signedDemand));
  const {memory:A,carriedAngleSeconds:C}=sample.model,N=Math.max(1,Math.ceil((C/(1-A)+SIM_DT/HULL_SUBSTEPS)/SIM_DT));
  if(w.ticks<N)return;
  const distance=dm.hypot(sample.goal.x*TILE_M-actual.position.x,sample.goal.y*TILE_M-actual.position.y);
  const absError=Math.abs(goalError(sample.goal,actual.position,actual.heading,sample.gear,sample.onlyDir));
  const Y=w.minimumYaw,S=w.minimumSpeed,d=w.direction,r0=w.startRate,flow=actual.velocity.x*w.axis.x+actual.velocity.y*w.axis.y;
  // The cone gate may brake before admitting a pivot. Nominal deceleration is
  // progress during that wait, just as cancelling opposing travel momentum is.
  const success=(S===0&&Math.abs(w.startFlow)>=STANDSTILL_MS
      &&Math.abs(w.startFlow)-Math.abs(flow)>=(1-planarResponse.A)*Math.abs(w.startFlow))
    ||(S>0&&w.startDistanceM-distance>=(SIM_DT-planarResponse.C)*S)
    ||(d!==0&&Y>0&&w.startAbsError-absError>=(SIM_DT-C)*Y)
    ||(d!==0&&Y>0&&d*r0<0&&d*(actual.finalRate!-r0)>=(1-A)*(Y-d*r0))
    ||(S>0&&w.startFlow<0&&flow-w.startFlow>=(1-planarResponse.A)*(S-w.startFlow));
  s.window=null;if(success)return;
  const e=s.episode??={anchorM:{x:actual.position.x,y:actual.position.y},attempts:0,limit:1+Math.floor(clamp(actual.experience,0,100)/25),exhausted:false};
  if(e.exhausted||e.attempts>=e.limit)return;
  e.attempts++;e.exhausted=e.attempts>=e.limit;
  const gear=sample.gear===1?-1:1,axis={x:gear*dm.sin(actual.heading),y:-gear*dm.cos(actual.heading)},anchorM={x:actual.position.x,y:actual.position.y};
  const E=boxProjection(v.body!,hullParams(VEHICLE_DEFS[v.defId]).solidBox,axis,anchorM).max;
  s.recovery={gear,capMs:sample.fullSpeed,anchorM,axis,entryMaxProjection:E,turning:w.direction!==0,phase:'pending',budgetTicks:0,elapsedTicks:0};
}
