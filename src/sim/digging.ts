import type { BattleState, Soldier, Terrain } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { dist } from '@/shared/math';
import { tileAt, coverAt } from './map';
import { deepenPersonalFoxhole } from './heightField';
import { isTreating,isReceivingTreatment } from './medic';

export const DIG_FULL_WORK_S=180, DIG_FULL_DEPTH_M=1.2;
const SOFT=new Set<Terrain>(['open','grass','tallgrass','crops','dirtroad','woods','scatteredtrees','snow','mud','crater','trench','rubble']);
export function diggingRate(state:BattleState,s:Soldier):number {
 const t=tileAt(state.map,Math.floor(s.pos.x),Math.floor(s.pos.y));
 if(!SOFT.has(t))return 0;
 if(state.map.def.decor?.some(d=>d.kind==='rocks'&&dist(d,s.pos)<.6))return 0;
 return (state.map.def.season==='winter'?.25:1)*(t==='rubble'?.2:1)*(s.health==='wounded'?.5:1)*Math.max(.25,1-s.fatigue/100);
}
export function canDig(state:BattleState,s:Soldier):boolean {
 const team=state.teams.get(s.teamId),m=s.mind;
 return state.phase==='running'&&(s.health==='healthy'||s.health==='wounded')&&s.vehicleId==null
  &&!s.path.length&&['idle','defending'].includes(s.activity)&&!s.aiming&&!s.smgBurst
  &&s.targetSoldierId==null&&s.targetVehicleId==null&&!s.targetPoint
  &&!s.hatch&&!s.bailRun&&!s.crewTask&&!s.carrying&&!s.carryingMgMount&&!s.pickup
  &&!(s.bandageUntil!=null&&state.time<s.bandageUntil)&&!isTreating(s,state.time)&&!isReceivingTreatment(state,s)
  &&(s.lastToolWorkAt==null||state.time-s.lastToolWorkAt>=1)
  &&!(s.dazedUntil!=null&&state.time<s.dazedUntil)&&!(s.stunnedUntil!=null&&state.time<s.stunnedUntil)
  &&s.fatigue<80&&s.suppression<15&&['calm','wary','alert'].includes(m.state)&&m.stress<35&&m.fear<30
  &&m.hesitation<=0&&m.pendingOrderAt==null&&state.time-m.lastIncomingAt>12&&state.time-s.lastFiredAt>5
  &&!m.beliefs.some(b=>b.confidence>.35&&state.time-b.time<12&&dist(b.pos,s.pos)<40)
  &&(!team?.order||state.time-team.order.issuedAt>=1)
  &&!(team?.crewWeapon&&!team.crewWeapon.abandoned)&&!(team?.vehicleId!=null)&&diggingRate(state,s)>0;
}
/** Runs after combat/medical work; a new job or incoming fire cancels the shovel in the same tick. */
export function stepDigging(state:BattleState,dt:number):void {
 if(dt!==SIM_DT)throw new Error('Digging requires fixed SIM_DT');
 for(const s of state.soldiers.values()) {
  if(!canDig(state,s)){delete s.digging;continue;}
  let site=s.digging&&state.map.foxholes?.get(s.digging.siteId);
  if(site&&dist(site.pos,s.pos)>.25){delete s.digging;site=undefined;}
  if(!site) {
   site=[...(state.map.foxholes?.values()??[])].find(h=>dist(h.pos,s.pos)<.25);
   if(!site) {
    if(coverAt(state.map,s.pos)>=.75){delete s.digging;continue;}
    site={id:state.nextId++,pos:{...s.pos},angle:s.facing*Math.PI/4-Math.PI/2,depthM:0,workS:0,appliedWorkS:0};
    (state.map.foxholes??=new Map()).set(site.id,site);
   }
   if(site.depthM>=DIG_FULL_DEPTH_M&&!deepenPersonalFoxhole(state.map,site,0)){delete s.digging;continue;}
   s.digging={siteId:site.id,startedAt:state.time};
  }
  site.workS+=dt*diggingRate(state,s);
  const work=site.workS-site.appliedWorkS;
  if(work>=1||site.appliedWorkS===0) {
   const increment=work*DIG_FULL_DEPTH_M/DIG_FULL_WORK_S;
   site.depthM=Math.min(DIG_FULL_DEPTH_M,site.depthM+increment);
   const more=deepenPersonalFoxhole(state.map,site,increment);site.appliedWorkS=site.workS;
   if(!more){delete s.digging;continue;}
  }
  s.stance='crouching';
  s.cover=coverAt(state.map,s.pos);
 }
}
