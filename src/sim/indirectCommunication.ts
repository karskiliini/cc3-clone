/** Mission requests and observed corrections travel along actual communication hops.
 * Merely seeing the map or launching more bombs never improves walk-in. */
import type {BattleState,IndirectMessage,IndirectObservation,PersonalContact,Soldier,Team,Vec2} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import {clamp,dist} from '@/shared/math';
import {WEAPONS} from '@/data/weapons';
import {VEHICLE_DEFS} from '@/data/units';
import {collectSpotters,observerVisibility} from './spotting';
import {communicationLink,conscious,directContacts,teamObserver,vehicleObserver} from './perception';
import {humanCapability} from './humanCondition';
import {emitRadio} from './radioTraffic';

function operator(state:BattleState,team:Team):Soldier|null{
 if(team.vehicleId!=null){const v=state.vehicles.get(team.vehicleId);return v?vehicleObserver(state,v):null;}
 for(const id of team.soldierIds){const s=state.soldiers.get(id);if(conscious(s,state.time)&&['mortar','rocket'].includes(WEAPONS[s.weaponId]?.cls??''))return s;}
 return null;
}
function route(state:BattleState,from:Soldier,to:Soldier):number[]|null{
 if(from.id===to.id)return[from.id];
 const candidates=[from,to,teamObserver(state,from.teamId),teamObserver(state,to.teamId),...Array.from(state.teams.values()).filter(t=>t.side===from.side&&t.type==='command').map(t=>teamObserver(state,t.id))].filter((s):s is Soldier=>!!s);
 const ids=new Set<number>([from.id]),queue:number[][]=[[from.id]];
 while(queue.length){const path=queue.shift()!;if(path.length>5)continue;const a=state.soldiers.get(path.at(-1)!)!;
  for(const b of candidates){if(ids.has(b.id)||!communicationLink(state,a,b))continue;const next=[...path,b.id];if(b.id===to.id)return next;ids.add(b.id);queue.push(next);}
 }
 return null;
}
function net(state:BattleState){return state.indirectCommunication??={queue:[],tasks:[]};}
/** Requirement 068 gameplay calibration: first/repeat mortar 30/10s, rocket 60/20s.
 * Only fire-data preparation is discounted; crew service and flight remain separate. */
function firingContext(state:BattleState,team:Team){
 const v=team.vehicleId==null?undefined:state.vehicles.get(team.vehicleId),gunner=operator(state,team);
 return {origin:v?.pos??team.crewWeapon?.pos??gunner?.pos??team.pos,
  weaponId:(v?VEHICLE_DEFS[v.defId]?.mainWeaponId:undefined)??team.crewWeapon?.weaponId??gunner?.weaponId??'',
  conditions:JSON.stringify([state.config.weather,state.config.timeOfDay])};
}
export function beginIndirectMission(state:BattleState,team:Team,aim:Vec2):void{
 const context=firingContext(state,team),c=team.indirectControl;
 const unchanged=c&&c.weaponId===context.weaponId&&c.conditions===context.conditions&&c.origin&&dist(c.origin,context.origin)*TILE_M<=2;
 if(unchanged&&dist(c.aim,aim)<3&&c.orderAt===team.order?.issuedAt)return;
 const registrations=team.indirectRegistrations??(team.indirectRegistration?[team.indirectRegistration]:[]);
 const repeat=registrations.some(r=>r.weaponId===context.weaponId&&r.conditions===context.conditions&&state.time-r.registeredAt<=600&&dist(r.origin,context.origin)*TILE_M<=2&&dist(r.aim,aim)*TILE_M<=10);
 const rocket=WEAPONS[context.weaponId]?.cls==='rocket',preparationS=rocket?(repeat?20:60):(repeat?10:30);
 team.indirectControl={aim:{...aim},startedAt:state.time,orderAt:team.order?.issuedAt,nextRequestAt:state.time,rounds:0,lastImpactAt:-Infinity,
  readyAt:state.time+preparationS,preparationS,repeat,origin:{...context.origin},weaponId:context.weaponId,conditions:context.conditions};
 const own=operator(state,team);if(own)net(state).tasks.push({teamId:team.id,missionAt:state.time,aim:{...aim},observerId:own.id,nextReportAt:state.time});
}
export function indirectPreparationWait(state:BattleState,team:Team):number{
 return Math.max(0,(team.indirectControl?.readyAt??state.time)-state.time);
}
/** Remember actual firing, without requiring a casualty or an observed impact. */
export function registerIndirectLaunch(state:BattleState,team:Team):void{
 const c=team.indirectControl;if(!c?.origin||!c.weaponId||c.conditions==null)return;
 const registrations=team.indirectRegistrations??(team.indirectRegistration?[team.indirectRegistration]:[]);
 team.indirectRegistration={aim:{...c.aim},origin:{...c.origin},weaponId:c.weaponId,conditions:c.conditions,registeredAt:state.time};
 team.indirectRegistrations=[...registrations.filter(r=>state.time-r.registeredAt<=600&&!(r.weaponId===c.weaponId&&r.conditions===c.conditions&&dist(r.origin,c.origin!)*TILE_M<=2&&dist(r.aim,c.aim)*TILE_M<=10)),team.indirectRegistration].slice(-16);
}

function sees(state:BattleState,s:Soldier,p:Vec2):boolean{
 if(!conscious(s,state.time)||['panicked','broken','cowering'].includes(s.mind.state))return false;
 return collectSpotters(state,s.side,new Set([s.teamId])).filter(sp=>sp.soldier?.id===s.id).some(sp=>observerVisibility(state,sp,p,600)>0.05/humanCapability(s,state.time).sensing);
}
function observation(state:BattleState,s:Soldier,aim:Vec2,impactAt?:number):IndirectObservation{
 const target=directContacts(state,s).some(c=>c.entity==='soldier'&&c.health!=='dead'&&dist(c.pos,aim)*TILE_M<=25);
 let quality=1+clamp((dist(s.pos,aim)*TILE_M-150)/450,0,1)*.25;
 quality*=1+humanCapability(s,state.time).tremor*.2;
 if(s.mind.state==='pinned')quality*=1.3;else if(s.mind.state==='shaken')quality*=1.15;
 return{observerId:s.id,observedAt:state.time,receivedAt:state.time,aim:{...aim},tier:target?'spotted':'area',quality,impactAt};
}
function adopt(state:BattleState,msg:IndirectMessage):void{
 const team=state.teams.get(msg.teamId),c=team?.indirectControl;if(!c||c.startedAt!==msg.missionAt||dist(c.aim,msg.aim)>3)return;
 const n=net(state);
 if(msg.kind==='request'){
  const id=msg.route.at(-1)!;if(!n.tasks.some(t=>t.teamId===msg.teamId&&t.missionAt===msg.missionAt&&t.observerId===id))n.tasks.push({teamId:msg.teamId,missionAt:msg.missionAt,aim:{...msg.aim},observerId:id,nextReportAt:state.time});
 }else if(msg.observation){
  const report={...msg.observation,receivedAt:state.time};
  if(!c.report||report.observedAt>c.report.observedAt||report.observedAt===c.report.observedAt&&report.quality<c.report.quality)c.report=report;
  if(report.impactAt!=null&&report.impactAt>c.lastImpactAt){c.lastImpactAt=report.impactAt;c.rounds++;}
 }
}
function transmit(state:BattleState,msg:Pick<IndirectMessage,'kind'|'teamId'|'missionAt'|'aim'|'observation'>):void{
 if(msg.kind==='observation'&&msg.observation?.impactAt==null)return;
 const key=`indirect-call:${msg.teamId}:${msg.missionAt}:${msg.kind}:${msg.observation?.impactAt??'request'}`,sent=state.spokenReports??={};
 if(sent[key]!=null)return;
 const team=state.teams.get(msg.teamId);if(team){sent[key]=state.time;emitRadio(state,team.side,{kind:msg.kind==='request'?'fireRequest':'fireCorrection',missionId:msg.teamId,target:msg.aim});}
}
function send(state:BattleState,msg:Omit<IndirectMessage,'hop'|'deliverAt'|'channel'>):void{
 const n=net(state);if(n.queue.length>=2048)return;
 if(msg.route.length===1){adopt(state,{...msg,hop:0,deliverAt:state.time,channel:'intercom'});return;}
 const a=state.soldiers.get(msg.route[0]),b=state.soldiers.get(msg.route[1]);if(!a||!b)return;const link=communicationLink(state,a,b);if(link){if(link.channel==='radio')transmit(state,msg);n.queue.push({...msg,hop:0,deliverAt:state.time+link.delay,channel:link.channel});}
}
export function stepIndirectCommunication(state:BattleState):void{
 const n=net(state),later:IndirectMessage[]=[];
 for(const msg of n.queue){
  if(msg.deliverAt>state.time){later.push(msg);continue;}
  const a=state.soldiers.get(msg.route[msg.hop]),b=state.soldiers.get(msg.route[msg.hop+1]);if(!a||!b||communicationLink(state,a,b)?.channel!==msg.channel)continue;
  if(msg.hop+1===msg.route.length-1)adopt(state,msg);
  else{const next=state.soldiers.get(msg.route[msg.hop+2]),link=next?communicationLink(state,b,next):null;if(link){if(link.channel==='radio')transmit(state,msg);later.push({...msg,hop:msg.hop+1,deliverAt:state.time+link.delay,channel:link.channel});}}
 }
 n.queue=later;n.tasks=n.tasks.filter(t=>state.teams.get(t.teamId)?.indirectControl?.startedAt===t.missionAt);
 for(const team of state.teams.values()){
  const c=team.indirectControl,gunner=operator(state,team);if(!c||!gunner||state.time<c.nextRequestAt)continue;c.nextRequestAt=state.time+5;
  // Explicit requests go only to reachable observers. Without a delivered request,
  // an unrelated soldier cannot magically correct this mission.
  for(const s of state.soldiers.values())if(s.side===team.side&&s.id!==gunner.id&&conscious(s,state.time)){
   if(n.tasks.some(t=>t.teamId===team.id&&t.missionAt===c.startedAt&&t.observerId===s.id))continue;
   const path=route(state,gunner,s);if(path)send(state,{kind:'request',teamId:team.id,missionAt:c.startedAt,aim:{...c.aim},route:path});
  }
 }
 for(const t of n.tasks){
  if(state.time<t.nextReportAt)continue;t.nextReportAt=state.time+2;
  const team=state.teams.get(t.teamId),s=state.soldiers.get(t.observerId),gunner=team?operator(state,team):null;
  if(!s||!gunner||!sees(state,s,t.aim))continue;const path=route(state,s,gunner);if(path)send(state,{kind:'observation',teamId:t.teamId,missionAt:t.missionAt,aim:{...t.aim},route:path,observation:observation(state,s,t.aim)});
 }
}
export function reportIndirectImpact(state:BattleState,teamId:number,missionAt:number,pos:Vec2,impactAt:number):void{
 const team=state.teams.get(teamId),gunner=team?operator(state,team):null;if(!team||!gunner||team.indirectControl?.startedAt!==missionAt)return;
 for(const t of net(state).tasks)if(t.teamId===teamId&&t.missionAt===missionAt){const s=state.soldiers.get(t.observerId);if(!s||!sees(state,s,pos))continue;const path=route(state,s,gunner);if(path)send(state,{kind:'observation',teamId,missionAt,aim:{...t.aim},route:path,observation:observation(state,s,t.aim,impactAt)});}
}
export function deliveredObservation(state:BattleState,team:Team,aim:Vec2):IndirectObservation|null{
 const c=team.indirectControl,r=c?.report;return r&&state.time-r.observedAt<=15&&dist(r.aim,aim)<3?r:null;
}
