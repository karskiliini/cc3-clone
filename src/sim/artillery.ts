import type {BattleState,Side,Vec2} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import {dist} from '@/shared/math';
import {Rng} from '@/shared/rng';
import {WEAPONS} from '@/data/weapons';
import {applyHESplash} from './combat';
import {onBlastNearVehicle} from './vehicleDamage';
import {emitRadio,radioCommandSender} from './radioTraffic';
import {conscious} from './perception';
import {addMessage} from './messages';

/** Explicit gameplay calibration, not a claim of universal historical response times.
 * Preparation is separate from message travel, loading, service and shell flight. */
export const ARTILLERY_TIMING={messageS:2,firstPreparationS:60,repeatPreparationS:20,loadS:6,flightS:22,serviceS:15,largeRecoveryS:180,registrationS:600};
export function initializeArtillery(state:BattleState):void{
 if(state.artillery)return;
 state.artillery={batteries:[],missions:[],shells:[]};
 if(state.config.artillerySupport===false)return;
 for(const side of ['german','soviet'] as const){
  const allocation=state.config.artillerySupport?.[side];
  const ammo=Math.max(0,Math.floor(allocation?.shells??(state.config.artillerySupport?0:48)));
  if(ammo)state.artillery.batteries.push({id:state.nextId++,side,name:side==='german'?'105mm field battery':'122mm field battery',weaponId:side==='german'?'field_105':'field_122',guns:Math.max(1,Math.min(6,Math.floor(allocation?.guns??4))),ammo,readyAt:allocation?.availableAtS??0});
 }
}
export function requestArtillery(state:BattleState,side:Side,target:Vec2,size:'small'|'large'):boolean{
 initializeArtillery(state);const sender=radioCommandSender(state,side),a=state.artillery!;
 if(state.phase!=='running'||!sender||!Number.isFinite(target.x)||!Number.isFinite(target.y)||target.x<0||target.y<0||target.x>=state.map.width||target.y>=state.map.height||!['small','large'].includes(size))return false;
 const battery=a.batteries.find(b=>b.side===side&&b.ammo>0&&(!b.assignedTeamId||b.assignedTeamId===sender.teamId));
 if(!battery||a.missions.filter(m=>m.batteryId===battery.id&&!['complete','cancelled'].includes(m.phase)).length>=4)return false;
 const rounds=Math.min(battery.ammo,size==='small'?battery.guns:Math.max(12,battery.guns*6));
 if(size==='large'&&rounds<12)return false;
 const id=state.nextId++,acceptedAt=state.time+ARTILLERY_TIMING.messageS;
 battery.ammo-=rounds; // reservation; cancellation returns only rounds not fired
 a.missions.push({id,batteryId:battery.id,side,target:{...target},size,phase:'requested',calledAt:state.time,acceptedAt,readyAt:Infinity,nextShotAt:Infinity,roundsLeft:rounds,repeat:false,requesterId:sender.id});
 emitRadio(state,side,{kind:'fireRequest',missionId:id,target});
 addMessage(state,`${battery.name}: ${size} fire request sent, ${rounds} rounds reserved.`,'info',side);return true;
}
export function cancelArtillery(state:BattleState,side:Side,id:number):void{
 const a=state.artillery,m=a?.missions.find(m=>m.id===id&&m.side===side&&!['complete','cancelled'].includes(m.phase));
 const sender=radioCommandSender(state,side);if(!a||!m||!sender||m.cancelAt!=null)return;
 m.cancelAt=state.time+ARTILLERY_TIMING.messageS;m.cancelRequesterId=sender.id;emitRadio(state,side,{kind:'fireCancellation',missionId:id,target:m.target});
 addMessage(state,'Fire cancellation transmitted; awaiting battery receipt.','info',side);
}
export function stepArtillery(state:BattleState,rng:Rng):void{
 const a=state.artillery;if(!a)return;
 // Receipt is independent of battery service/availability. Once received, the
 // battery retains its instruction even when the requesting HQ later falls.
 for(const m of a.missions){
  const battery=a.batteries.find(b=>b.id===m.batteryId);if(!battery)continue;
  if(m.cancelAt!=null&&state.time>=m.cancelAt){
   const delivered=radioCommandSender(state,m.side)?.id===m.cancelRequesterId;
   delete m.cancelAt;delete m.cancelRequesterId;
   if(delivered&&!['complete','cancelled'].includes(m.phase)){
    battery.ammo+=m.roundsLeft;m.roundsLeft=0;m.phase='cancelled';
    addMessage(state,'Battery received cancellation; airborne shells remain in flight.','info',m.side);
   }
  }
  if(m.phase!=='requested'||state.time<m.acceptedAt)continue;
  const sender=state.soldiers.get(m.requesterId);
  if(!conscious(sender,state.time)||radioCommandSender(state,m.side)?.id!==m.requesterId){battery.ammo+=m.roundsLeft;m.roundsLeft=0;m.phase='cancelled';continue;}
  m.phase='queued';
 }
 for(const battery of a.batteries){
  const m=a.missions.find(m=>m.batteryId===battery.id&&!['complete','cancelled'].includes(m.phase));if(!m)continue;
  if(m.phase==='requested')continue;
  if(m.phase==='queued'){
   if(state.time<battery.readyAt)continue;
   const registrations=battery.registrations??(battery.registration?[battery.registration]:[]);
   const conditions=JSON.stringify([state.config.weather,state.config.timeOfDay]);
   m.repeat=registrations.some(r=>r.weaponId===battery.weaponId&&r.conditions===conditions&&state.time-r.at<=ARTILLERY_TIMING.registrationS&&dist(r.target,m.target)*TILE_M<=10);
   m.readyAt=state.time+(m.repeat?ARTILLERY_TIMING.repeatPreparationS:ARTILLERY_TIMING.firstPreparationS);m.nextShotAt=m.readyAt+ARTILLERY_TIMING.loadS;m.phase='preparing';
   addMessage(state,`${battery.name}: ${m.repeat?'registered target':'new target'}, preparing fire.`,'info',m.side);
  }
  if(state.time<m.nextShotAt)continue;
  m.phase='firing';const count=Math.min(battery.guns,m.roundsLeft);
  for(let i=0;i<count;i++){
   // Blind area fire has fixed dispersion, never selects hidden concentrations.
   const target={x:Math.max(0,Math.min(state.map.width-.001,m.target.x+rng.range(-10,10)/TILE_M)),y:Math.max(0,Math.min(state.map.height-.001,m.target.y+rng.range(-10,10)/TILE_M))};
   a.shells.push({id:state.nextId++,missionId:m.id,side:m.side,target,weaponId:battery.weaponId,firedAt:state.time,impactAt:state.time+ARTILLERY_TIMING.flightS});m.roundsLeft--;
  }
  const registrations=battery.registrations??(battery.registration?[battery.registration]:[]);
  const conditions=JSON.stringify([state.config.weather,state.config.timeOfDay]);
  battery.registration={target:{...m.target},at:state.time,weaponId:battery.weaponId,conditions};
  battery.registrations=[...registrations.filter(r=>state.time-r.at<=ARTILLERY_TIMING.registrationS&&!(r.weaponId===battery.weaponId&&r.conditions===conditions&&dist(r.target,m.target)*TILE_M<=10)),battery.registration].slice(-16);
  m.nextShotAt=state.time+ARTILLERY_TIMING.loadS;
  if(!m.roundsLeft){m.phase='complete';battery.readyAt=state.time+(m.size==='large'?ARTILLERY_TIMING.largeRecoveryS:ARTILLERY_TIMING.serviceS);}
 }
 const pending=[];
 for(const shell of a.shells){
  if(state.time<shell.impactAt){pending.push(shell);continue;}
  const weapon={...WEAPONS.m30_122,id:shell.weaponId,name:shell.weaponId==='field_105'?'105mm HE':'122mm HE',heRadiusM:shell.weaponId==='field_105'?8:9};
  applyHESplash(state,rng,shell.target,weapon,shell.side);
  for(const v of state.vehicles.values())if(v.side===shell.side)onBlastNearVehicle(state,rng,v,shell.target,weapon,shell.side,true);
 }
 a.shells=pending;
 // Keep active entries and a bounded history, without discarding airborne shells.
 if(a.missions.length>128)a.missions=a.missions.filter(m=>!['complete','cancelled'].includes(m.phase)||a.shells.some(s=>s.missionId===m.id)).concat(a.missions.filter(m=>['complete','cancelled'].includes(m.phase)&&!a.shells.some(s=>s.missionId===m.id)).slice(-64));
}
