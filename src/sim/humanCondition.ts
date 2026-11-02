/** Gameplay physiology, not a medical simulation. One owner integrates exertion;
 * all capability consumers use the same read-only evaluation. */
import type {BattleState,Soldier} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import {hash2} from '@/shared/rng';
import {clamp,dist} from '@/shared/math';
export const PAIN_MILD_FACTOR = 0.85;
export const PAIN_BOUT_FACTOR = 0.35;
export const PAIN_BOUT_FACTOR_LOW_MORALE = 0.2;
export const PAIN_BOUT_FACTOR_VETERAN = 0.5;
const PAIN_PERIOD_MIN_S = 12, PAIN_PERIOD_RANGE_S = 13; // bouts recur every 12-25 s
const PAIN_BOUT_MIN_S = 3, PAIN_BOUT_RANGE_S = 3;       // each bout lasts 3-6 s
/** Below this experience, or this morale, a wounded man's pain bouts hit him hardest (green troops
 * and men who have had enough); at/above VETERAN experience he grits his teeth instead. */
const PAIN_LOW_EXPERIENCE = 35, PAIN_LOW_MORALE = 30, PAIN_VETERAN_EXPERIENCE = 65;

/** Spotting-factor multiplier from pain: 1 for every healthy (or dead/incapacitated — moot, they
 * don't spot) man. A wounded man is at PAIN_MILD_FACTOR most of the time, dropping into a strong,
 * recurring bout (PAIN_BOUT_FACTOR, harder on green/shaken troops, easier on veterans) roughly
 * 15-35% of the time. Also usable directly by combat code (e.g. a wounded gunner's aim) — exported
 * for exactly that. Pure: same inputs, same answer, every time. */
export function painBoutActive(soldier: Soldier, time: number): boolean {
  if (soldier.health !== 'wounded') return false;
  const id = soldier.id;
  const period = PAIN_PERIOD_MIN_S + hash2(id, 0, 11) * PAIN_PERIOD_RANGE_S;
  const boutLen = PAIN_BOUT_MIN_S + hash2(id, 0, 23) * PAIN_BOUT_RANGE_S;
  const phase = hash2(id, 0, 37) * period;
  const t = ((time + phase) % period + period) % period;
  return t < boutLen;
}

export function painVisionFactor(soldier: Soldier, time: number): number {
  if (soldier.health !== 'wounded') return 1;
  if (!painBoutActive(soldier, time)) return PAIN_MILD_FACTOR;
  if (soldier.experience >= PAIN_VETERAN_EXPERIENCE) return PAIN_BOUT_FACTOR_VETERAN;
  if (soldier.experience < PAIN_LOW_EXPERIENCE || soldier.morale < PAIN_LOW_MORALE) return PAIN_BOUT_FACTOR_LOW_MORALE;
  return PAIN_BOUT_FACTOR;
}

export function humanCapability(s:Soldier,time=s.condition?.at??0){
 const c=s.condition,breath=clamp(c?.breath??0,0,100)/100,sweat=clamp(c?.sweat??0,0,100)/100,exhaustion=clamp(s.fatigue,0,100)/100;
 const pain=1-painVisionFactor(s,time),stress=clamp(s.mind?.stress??0,0,100)/100;
 const dazed=time<(s.dazedUntil??-Infinity),shakenEnd=s.shakenUntil??-Infinity,dazeEnd=s.dazedUntil??time;
 const shock=dazed?1:time<shakenEnd?clamp((shakenEnd-time)/Math.max(1,shakenEnd-dazeEnd),0,1):0;
 const tremor=clamp(breath*.35+exhaustion*.2+stress*.25+pain*.3+shock*.5,0,1);
 const able=s.health!=='dead'&&s.health!=='incapacitated',incapable=dazed||time<(s.stunnedUntil??-Infinity)||['pinned','cowering','panicked','broken'].includes(s.mind.state),work=able&&!incapable?Math.max(.15,1-breath*.25-exhaustion*.25-pain*.35-sweat*.1):0;
 return {pain,breath,sweat,exhaustion,shock,tremor,
  pace:able?Math.max(.15,(1-exhaustion*.5)*(1-breath*.3)*(1-pain*.35)):0,
  sensing:able?painVisionFactor(s,time)*(dazed?.25:1)*(1-breath*.25)*(1-sweat*.15):0,
  accuracy:able?Math.max(.15,1-tremor*.6-sweat*.12):0,
  settle:1+breath*.7+exhaustion*.8+pain*.8+tremor*.6+sweat*.2,
  decision:1+breath*.8+pain*1.4+tremor+shock*.8,
  canDrive:able&&!dazed&&time>=(s.stunnedUntil??-Infinity)&&!['pinned','cowering','broken'].includes(s.mind.state),canOperate:able&&!incapable,canFire:able&&!incapable,work,hearing:able?Math.max(0,1-(c?.hearingLoss??0))*(dazed?.35:1)*(1-pain*.2):0};
}
export function stepHumanCondition(state:BattleState,dt:number):void{
 for(const s of state.soldiers.values()){
  const c=s.condition??={breath:0,sweat:0,hearingLoss:0,at:state.time,lastPos:{...s.pos}};
  if(s.health==='dead'||s.health==='incapacitated'){c.at=state.time;continue;}
  const moved=s.vehicleId==null?dist(c.lastPos,s.pos)*TILE_M/Math.max(dt,.001):0;
  const sprint=moved>1.5&&s.activity==='movingFast'&&s.mind.downAt==null;
  const v=s.vehicleId!=null?state.vehicles.get(s.vehicleId):null;
  const loading=!!v&&v.mainFireTimer>0&&(v.seats?.loader===s.id||v.seats?.loader==null&&v.seats?.commander===s.id);
  const walking=moved>.05,working=loading||!!s.digging||!!s.crewTask&&!s.crewTask.walking||s.activity==='reloading';
  const effort=sprint?1:walking?.3:working?.22:0;
  c.breath=clamp(c.breath+(effort?12*effort:-8)*dt,0,100);
  s.fatigue=clamp(s.fatigue+(sprint?2:walking?.5:working?.35:-1)*dt,0,100);
  const cold=state.map.def.season==='winter';
  c.sweat=clamp(c.sweat+((effort*.9+c.breath*.004)*(cold?.4:1)-.12)*dt,0,100);
  c.hearingLoss=clamp(c.hearingLoss-dt/30,0,1);
  c.at=state.time;c.lastPos={...s.pos};
 }
}
/** Read-only explanation uses already stored evidence; never acquires or draws RNG. */
export function explainIndividual(s:Soldier,time:number){return{decision:{activity:s.activity,stance:s.stance,targetSoldierId:s.targetSoldierId,targetVehicleId:s.targetVehicleId,targetPoint:s.targetPoint?{...s.targetPoint}:null,nextWaypoint:s.path[0]?{...s.path[0]}:null,hesitation:s.mind.hesitation},order:s.mind.pendingOrderAt,mentalState:s.mind.state,trait:s.mind.trait,beliefs:structuredClone(s.mind.beliefs),perception:structuredClone(s.perception),capability:humanCapability(s,time)};}
