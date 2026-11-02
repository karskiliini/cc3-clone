import {vehicleEyes} from './vehicleVision';
import {observerVisibility} from './spotting';
import {rememberCell,rememberHull} from './navigationKnowledge';
import {emitNoise} from './noise';
import type {AcousticCue,BattleState,CrewRole,PersonalContact,PersonalPerception,Soldier,Vec2,Vehicle} from '@/shared/types';
import {TILE_M} from '@/shared/types';
import {hash2} from '@/shared/rng';
import {angleTo,clamp,dist} from '@/shared/math';
import * as dm from '@/shared/dmath';
import {hasLOS} from './los';
import {painBoutActive,humanCapability} from './humanCondition';
import {VEHICLE_DEFS} from '@/data/units';
import {WEAPONS} from '@/data/weapons';

export const CONTACT_FRESH_S=1.1,REPORT_KEEP_S=120;
export function perception(s:Soldier):PersonalPerception{return s.perception??={visual:[],reports:[],sounds:[],nextReportAt:0,lastSounds:{},casualties:{}};}
export function conscious(s:Soldier|undefined,time:number):s is Soldier{return !!s&&s.health!=='dead'&&s.health!=='incapacitated'&&s.activity!=='surrendered'&&time>=(s.stunnedUntil??-Infinity)&&time>=(s.dazedUntil??-Infinity);}
/** Local comrade awareness respects the observer's eyes and closed hulls.
 * Occupants of one compartment can notice each other locally; outside observers
 * cannot read a casualty through armor merely because the map ray is clear. */
export function canObserveComrade(state:BattleState,s:Soldier,target:Soldier,maxM=30):boolean{
 if(!conscious(s,state.time)||humanCapability(s,state.time).sensing<.1)return false;
 if(s.vehicleId!=null&&s.vehicleId===target.vehicleId)return true;
 if(target.vehicleId!=null){const v=state.vehicles.get(target.vehicleId);const def=v?VEHICLE_DEFS[v.defId]:undefined,open=def?.layout?.openTop??(def?.kind==='halftrack'||(def?.armor.top??1)<=0);if(v&&!open&&!target.hatch)return false;}
 if(dist(s.pos,target.pos)*TILE_M>maxM*humanCapability(s,state.time).sensing)return false;
 if(s.vehicleId!=null){const v=state.vehicles.get(s.vehicleId);return !!v&&vehicleEyes(state,v).filter(e=>e.soldierId===s.id).some(e=>observerVisibility(state,{pos:e.pos,soldier:s,vehicleEye:e},target.pos,maxM)>.05);}
 return hasLOS(state.map,s.pos,target.pos);
}
export function directContacts(state:BattleState,s:Soldier|null|undefined):readonly PersonalContact[]{return s?.perception?.visual.filter(c=>state.time-c.observedAt<=CONTACT_FRESH_S)??[];}
export function knownContacts(state:BattleState,s:Soldier|null|undefined):PersonalContact[]{
 const out=new Map<string,PersonalContact>();
 for(const c of [...(s?.perception?.memory??[]),...(s?.perception?.reports??[]),...directContacts(state,s)])if(state.time-c.observedAt<=REPORT_KEEP_S&&c.confidence>=.1){const k=`${c.entity}:${c.id}`,old=out.get(k);if(!old||c.observedAt>=old.observedAt)out.set(k,c);}
 return [...out.values()];
}
export function visualIds(state:BattleState,s:Soldier|null|undefined,entity:PersonalContact['entity']='soldier'):Set<number>{return new Set(directContacts(state,s).filter(c=>c.entity===entity).map(c=>c.id));}
export function knowsDirectly(state:BattleState,s:Soldier|null|undefined,id:number,entity:PersonalContact['entity']='soldier'):boolean{return directContacts(state,s).some(c=>c.id===id&&c.entity===entity);}
/** A vacant role is blind. Unrecognised fixture vehicles can use their real leader. */
export function vehicleObserver(state:BattleState,v:Vehicle,role:CrewRole='gunner'):Soldier|null{
 const id=v.seats?.[role];if(id!=null){const s=state.soldiers.get(id);return conscious(s,state.time)&&s.vehicleId===v.id?s:null;}
 if(v.seats&&Object.hasOwn(v.seats,role))return null;
 const team=state.teams.get(v.teamId);const leader=team?state.soldiers.get(team.leaderId):undefined;return conscious(leader,state.time)?leader:null;
}
export function vehicleVisualIds(state:BattleState,v:Vehicle,entity:PersonalContact['entity']='soldier',role:CrewRole='gunner'):Set<number>{return visualIds(state,vehicleObserver(state,v,role),entity);}
export function teamObserver(state:BattleState,teamId:number):Soldier|null{const t=state.teams.get(teamId),s=t?state.soldiers.get(t.leaderId):undefined;return conscious(s,state.time)?s:null;}
export function recordVisual(state:BattleState,s:Soldier,target:Soldier|Vehicle,entity:PersonalContact['entity']):void{
 const c:PersonalContact={id:target.id,entity,teamId:target.teamId,pos:{...target.pos},observedAt:state.time,receivedAt:state.time,confidence:1,uncertaintyM:0,sourceId:s.id,teamType:state.teams.get(target.teamId)?.type};
 if(entity==='soldier'){const t=target as Soldier;c.health=t.health;c.weaponId=t.weaponId;c.activity=t.activity;c.stance=t.stance;c.facing=t.facing;}
 else{const t=target as Vehicle;c.vehicleState=t.state;c.vehicleDefId=t.defId;c.hullFacing=t.hullFacing;c.turretFacing=t.turretFacing;}
 const p=perception(s),memory=p.memory??=[];const remembered=memory.findIndex(o=>o.entity===entity&&o.id===target.id);if(remembered>=0)memory[remembered]=structuredClone(c);else memory.push(structuredClone(c));if(memory.length>64)memory.shift();const i=p.visual.findIndex(o=>o.entity===entity&&o.id===target.id);if(i>=0)p.visual[i]=c;else p.visual.push(c);
}
/** Explicit voice/intercom/radio endpoints, with no no-HQ radio fallback. */
export function communicationLink(state:BattleState,a:Soldier,b:Soldier):{channel:'voice'|'intercom'|'radio';delay:number}|null{
 if(a.side!==b.side||a.id===b.id||!conscious(a,state.time)||!conscious(b,state.time)||humanCapability(b,state.time).hearing<.1)return null;
 if(a.mind.state==='panicked'||a.mind.state==='broken'||b.mind.state==='panicked'||b.mind.state==='broken')return null;
 if(a.vehicleId!=null&&a.vehicleId===b.vehicleId)return{channel:'intercom',delay:.5};
 const dM=dist(a.pos,b.pos)*TILE_M,at=state.teams.get(a.teamId),bt=state.teams.get(b.teamId);
 const voice=(a.activity==='ambushing'||a.activity==='hiding'?5:at?.leaderId===a.id?30:10)*humanCapability(b,state.time).hearing;
 if(a.vehicleId==null&&b.vehicleId==null&&dM<=voice&&hasLOS(state.map,a.pos,b.pos))return{channel:'voice',delay:.7+dM/340};
 const endpoint=(s:Soldier,t:typeof at)=>{
  if(t?.leaderId!==s.id)return false;if(t.type==='command'||t.type==='mortar'||t.type==='rocket')return true;
  const v=t.vehicleId!=null?state.vehicles.get(t.vehicleId):undefined,def=v?VEHICLE_DEFS[v.defId]:null;
  return !!v&&!!def&&s.vehicleId===v.id&&(v.state==='ok'||v.state==='immobilized')&&def.layout?.radio!==false&&v.damage?.radio!=='destroyed';
 };
 if(endpoint(a,at)&&endpoint(b,bt)&&dM<=300)return{channel:'radio',delay:2};
 return null;
}
function deliverContact(state:BattleState,s:Soldier,c:PersonalContact):void{
 const p=perception(s),old=p.reports.find(x=>x.entity===c.entity&&x.id===c.id);
 if(old&&old.observedAt>=c.observedAt)return;
 if(old)p.reports.splice(p.reports.indexOf(old),1);
 p.reports.push(c);if(p.reports.length>32)p.reports.shift();
 const belief={pos:{...c.pos},count:1,confidence:c.confidence,kind:'reported' as const,time:c.observedAt,deadSeen:0,uncertaintyM:c.uncertaintyM,sourceId:c.sourceId,modality:'visual' as const};
 const prior=s.mind.beliefs.find(b=>dist(b.pos,c.pos)<4);
 if(!prior){s.mind.beliefs.push(belief);if(s.mind.beliefs.length>8)s.mind.beliefs.shift();}
 else if(prior.time<c.observedAt)Object.assign(prior,belief);
}
function deliverBelief(s:Soldier,report:NonNullable<import('@/shared/types').PendingContactReport['belief']>):void{
 const prior=s.mind.beliefs.find(b=>dist(b.pos,report.pos)<4);
 if(prior&&prior.time>=report.time)return;
 const belief={...report,pos:{...report.pos},kind:'reported' as const,confidence:report.confidence*.7};
 if(prior)Object.assign(prior,belief);else{s.mind.beliefs.push(belief);if(s.mind.beliefs.length>8)s.mind.beliefs.shift();}
}
export function learnCasualty(state:BattleState,s:Soldier,id:number,evidence:PersonalPerception['casualties'][string]):void{
 const p=perception(s),old=p.casualties[id];if(old&&old.observedAt>=evidence.observedAt)return;
 if(old?.health!==evidence.health&&evidence.health!=='healthy'){
  const own=state.soldiers.get(id)?.teamId===s.teamId;
  if(own)s.morale=clamp(s.morale-(evidence.health==='wounded'?8:15)*(evidence.isLeader?2:1),0,100);
  if(evidence.sourceId!==s.id)s.mind.stress=clamp(s.mind.stress+(evidence.health==='wounded'?4:8),0,100);
 }
 p.casualties[id]={...evidence,pos:{...evidence.pos}};
}
export function knownLeader(state:BattleState,s:Soldier):{leader:Soldier|undefined;alive:boolean;near:boolean}{
 const id=s.perception?.leaderId??state.teams.get(s.teamId)?.leaderId,leader=id!=null?state.soldiers.get(id):undefined;
 const near=!!leader&&canObserveComrade(state,s,leader);
 const health=near?leader!.health:id!=null?s.perception?.casualties[id]?.health:undefined;
 return{leader,alive:health!=='dead'&&health!=='incapacitated',near};
}
/** Delivery precedes emission: no iteration-order-dependent same-tick relay loops. */
export function stepCommunication(state:BattleState):void{
 const net=state.communication??={queue:[]},keep:typeof net.queue=[];
 for(const s of state.soldiers.values())if(conscious(s,state.time))perception(s).leaderId??=state.teams.get(s.teamId)?.leaderId;
 for(const r of net.queue){
  if(r.deliverAt>state.time){keep.push(r);continue;}const a=state.soldiers.get(r.from),b=state.soldiers.get(r.to);
  if(!a||!b||communicationLink(state,a,b)?.channel!==r.channel)continue;
  if(r.navigationCell)rememberCell(b,r.navigationCell);
  if(r.navigationHull)rememberHull(b,r.navigationHull);
  if(r.objective){const p=perception(b),known=(p.objectives??={})[r.objective.id];if(!known||known.observedAt<r.objective.observedAt)p.objectives![r.objective.id]={owner:r.objective.owner,observedAt:r.objective.observedAt,sourceId:r.objective.sourceId};}
  if(r.belief)deliverBelief(b,r.belief);
  if(r.contact)deliverContact(state,b,{...r.contact,receivedAt:state.time});
  if(r.casualty)learnCasualty(state,b,r.casualty.id,r.casualty);
  if(r.leadership&&a.teamId===b.teamId){const p=perception(b);if(!p.leadership||p.leadership.observedAt<r.leadership.observedAt){p.leaderId=r.leadership.leaderId;p.leadership={...r.leadership};}}
 }
 net.queue=keep;
 for(const s of state.soldiers.values()){
  if(!conscious(s,state.time))continue;const p=perception(s);p.reports=p.reports.filter(c=>state.time-c.observedAt<=REPORT_KEEP_S);if(p.memory)p.memory=p.memory.filter(c=>state.time-c.observedAt<=REPORT_KEEP_S);
  if(state.time<p.nextReportAt)continue;p.nextReportAt=state.time+2;
  const contacts=knownContacts(state,s).filter(c=>(c.hops??0)<4).slice(0,32),beliefs=s.mind.beliefs.filter(b=>(b.hops??0)<4&&state.time-b.time<=120),casualties=Object.entries(p.casualties).filter(([,e])=>e.health!=='healthy'&&state.time-e.observedAt<120);
  const sent=p.sentReports??={};for(const [key,time] of Object.entries(sent))if(state.time-time>120)delete sent[key];
  const sentKeys=Object.keys(sent);let sentHead=0;
  const navCells=Object.values(p.navigation?.cells??{}).filter(c=>c.hops<4).sort((a,b)=>a.observedAt-b.observedAt||a.index-b.index),navHulls=Object.values(p.navigation?.hulls??{}).filter(h=>h.hops<4).sort((a,b)=>a.observedAt-b.observedAt||a.id-b.id);
  if(!navCells.length&&!navHulls.length&&!contacts.length&&!beliefs.length&&!casualties.length&&!p.leadership&&!Object.keys(p.objectives??{}).length)continue;
  let spoke=false;
  for(const b of state.soldiers.values()){
   const link=communicationLink(state,s,b);if(!link)continue;
   const before=net.queue.length;
   const base={from:s.id,to:b.id,sentAt:state.time,deliverAt:state.time+link.delay,channel:link.channel};
   const fresh=(key:string,at:number)=>{const k=`${b.id}:${key}`;if(sent[k]!=null&&sent[k]>=at)return false;if(!Object.hasOwn(sent,k))sentKeys.push(k);sent[k]=at;if(sentKeys.length-sentHead>512)delete sent[sentKeys[sentHead++]];return true;};
   for(const c of contacts){if(net.queue.length>=8192)break;if(c.sourceId===b.id||!fresh(`${c.entity}:${c.id}`,c.observedAt))continue;net.queue.push({...base,contact:{...c,pos:{...c.pos},confidence:c.confidence*.7,hops:(c.hops??0)+1,uncertaintyM:Math.max(c.uncertaintyM,link.channel==='intercom'?2:5)}});}
   for(const belief of beliefs){if(net.queue.length>=8192)break;const source=belief.sourceId??s.id;if(source===b.id||!fresh(`belief:${source}:${belief.pos.x}:${belief.pos.y}`,belief.time))continue;net.queue.push({...base,belief:{...belief,pos:{...belief.pos},hops:(belief.hops??0)+1,sourceId:source,uncertaintyM:Math.max(5,belief.uncertaintyM??0)}});}
   for(const [id,e] of casualties){if(net.queue.length>=8192)break;if(e.sourceId===b.id||!fresh(`casualty:${id}`,e.observedAt))continue;net.queue.push({...base,casualty:{id:Number(id),...e,pos:{...e.pos}}});}
   let cellsSent=0,hullsSent=0;
   for(const cell of navCells)if(cellsSent<8&&net.queue.length<8192&&cell.sourceId!==b.id&&fresh(`nav:${cell.index}`,cell.observedAt)){net.queue.push({...base,navigationCell:{...structuredClone(cell),hops:cell.hops+1}});cellsSent++;}
   for(const hull of navHulls)if(hullsSent<8&&net.queue.length<8192&&hull.sourceId!==b.id&&fresh(`hull:${hull.id}`,hull.observedAt)){net.queue.push({...base,navigationHull:{...structuredClone(hull),hops:hull.hops+1}});hullsSent++;}
   for(const [id,e] of Object.entries(p.objectives??{}))if(net.queue.length<8192&&e.sourceId!==b.id&&fresh(`objective:${id}`,e.observedAt))net.queue.push({...base,objective:{id:Number(id),...e}});
   if(s.teamId===b.teamId&&p.leadership&&net.queue.length<8192&&fresh('leadership',p.leadership.observedAt))net.queue.push({...base,leadership:{...p.leadership}});
   if(!spoke&&link.channel==='voice'&&net.queue.length>before){spoke=true;emitNoise(state,s.pos,'voice',s.activity==='ambushing'||s.activity==='hiding'?5:s.id===state.teams.get(s.teamId)?.leaderId?40:15,`voice:${s.id}`,s.side);}
  }
 }
}
function auditoryMasking(state:BattleState,s:Soldier):number{
 let masking=1;for(const e of state.noise?.events??[])if(e.kind==='blast'&&state.time-e.at<1&&dist(e.pos,s.pos)*TILE_M<40)masking=.3;
 if(state.time-s.lastFiredAt<.8)masking=Math.min(masking,.5);return masking;
}
/** Physical noise becomes uncertain sampled evidence once, with no source identity. */
export function hearNoise(state:BattleState,s:Soldier,source:Vec2,eventKey:string,kind:AcousticCue['kind'],rangeM:number,maskingForPass?:number):void{
 if(!conscious(s,state.time))return;const p=perception(s);const eventHash=eventKey.split('').reduce((a,c)=>Math.imul(a,31)+c.charCodeAt(0),0);const dedupKey=String(Math.floor(hash2(eventHash,17,811)*4294967296));if(p.lastSounds[dedupKey]!=null)return;
 const dM=dist(s.pos,source)*TILE_M,cap=humanCapability(s,state.time);
 // Occlusion and masking can only reduce range. Distant inaudible events
 // require no LOS ray, and masking is shared across this listener's pass.
 if(dM>rangeM*cap.hearing)return;
 const occlusion=hasLOS(state.map,s.pos,source)?1:.4,masking=maskingForPass??auditoryMasking(state,s);
 const audibleRange=rangeM*cap.hearing*occlusion*masking;if(dM>audibleRange)return;
 const key=hash2(s.id,Math.floor(state.time*10),eventHash);
 const sector=Math.PI/6,bearing=Math.round(angleTo(s.pos,source)/sector)*sector+(key-.5)*sector;
 const estimateM=Math.max(15,Math.round(dM/40)*40+(key-.5)*30),uncertaintyM=Math.max(15,estimateM*.4);
 const pos={x:clamp(s.pos.x+dm.sin(bearing)*estimateM/TILE_M,0,state.map.width-.01),y:clamp(s.pos.y-dm.cos(bearing)*estimateM/TILE_M,0,state.map.height-.01)};
 const cue:AcousticCue={pos,bearing,uncertaintyM,confidence:.35,observedAt:state.time,kind};p.sounds.push(cue);if(p.sounds.length>8)p.sounds.shift();p.lastSounds[dedupKey]=state.time;
 s.mind.threatDir=bearing;s.mind.threatLevel=Math.max(s.mind.threatLevel,.35);
 const b=s.mind.beliefs.find(b=>b.kind==='heard'&&dist(b.pos,pos)<6);if(b)Object.assign(b,{pos,time:state.time,uncertaintyM});else{s.mind.beliefs.push({pos,count:1,confidence:.35,kind:'heard',time:state.time,deadSeen:0,uncertaintyM,modality:'acoustic'});if(s.mind.beliefs.length>8)s.mind.beliefs.shift();}
}
export function stepHearing(state:BattleState):void{
 const n=state.noise??={nextId:0,sources:{},events:[]};n.events=n.events.filter(e=>state.time-e.at<=2);
 for(const v of state.vehicles.values())if(Math.abs(v.speed)>.3&&state.time-(v.lastEngineNoiseAt??-Infinity)>=3){v.lastEngineNoiseAt=state.time;emitNoise(state,v.pos,'engine',160,`engine:${v.id}`,v.side);}
 for(const s of state.soldiers.values())if(s.health==='wounded'&&painBoutActive(s,state.time)&&state.time-(s.lastMoanAt??-Infinity)>4){s.lastMoanAt=state.time;emitNoise(state,s.pos,'voice',30,`moan:${s.id}`,s.side);}
 for(const s of state.soldiers.values()){
  if(!conscious(s,state.time))continue;const p=perception(s);for(const [k,t] of Object.entries(p.lastSounds))if(state.time-t>3)delete p.lastSounds[k];p.sounds=p.sounds.filter(c=>state.time-c.observedAt<15);
  const masking=auditoryMasking(state,s);
  for(const event of n.events){const own=event.key.startsWith(`s${s.id}:`)||event.key.startsWith(`voice:${s.id}:`)||event.key.startsWith(`moan:${s.id}:`)||s.vehicleId!=null&&(event.key.startsWith(`v${s.vehicleId}:`)||event.key.startsWith(`engine:${s.vehicleId}:`));if(!own&&state.time-event.at>=dist(s.pos,event.pos)*TILE_M/340)hearNoise(state,s,event.pos,event.key,event.kind,event.rangeM,masking);}
 }
}

/** Nominal enemy descriptors for planning. Never spread a live enemy object here. */
export function observedVehicle(c:PersonalContact,side:Vehicle['side']):Vehicle{
 return {id:c.id,teamId:c.teamId,side,defId:c.vehicleDefId??'',pos:{...c.pos},hullFacing:c.hullFacing??0,turretFacing:c.turretFacing??c.hullFacing??0,state:c.vehicleState??'ok',mainAmmo:1,coaxAmmo:1,path:[],speed:0,targetVehicleId:null,targetSoldierId:null,targetPoint:null,mainFireTimer:0,coaxFireTimer:0,burnTimer:0,hits:0};
}
export function observedSoldier(c:PersonalContact,side:Soldier['side']):Soldier{
 return {id:c.id,teamId:c.teamId,side,pos:{...c.pos},name:'Observed contact',rank:'',weaponId:c.weaponId??'kar98k',ammo:1,ammoReserve:1,grenades:0,health:c.health??'healthy',morale:50,fatigue:0,suppression:c.activity==='pinned'?70:0,experience:50,stance:c.stance??'crouching',activity:c.activity??'defending',facing:c.facing??0,targetSoldierId:null,targetVehicleId:null,targetPoint:null,path:[],reloadTimer:0,fireTimer:0,animFrame:0,isLeader:false,vehicleId:null,formationOffset:{x:0,y:0},lastFiredAt:c.activity==='firing'?c.observedAt:-999,cover:0,kills:0,mind:{state:'calm',motivation:50,stress:0,fear:0,beliefs:[],threatDir:null,threatLevel:0,lastIncomingAt:-999,hesitation:0,surrounded:false,helpless:false,stateSince:0,anchor:null,lastCoverSeekAt:-999}};
}
/** Knowledge recipients exist only where a live command endpoint exists. */
export function commandRecipient(state:BattleState,side:Soldier['side']):Soldier|null{
 for(const t of state.teams.values())if(t.side===side&&t.type==='command'){const s=state.soldiers.get(t.leaderId);if(conscious(s,state.time))return s;}
 const local=[...state.teams.values()].filter(t=>t.side===side&&t.supportForTeamId==null);return local.length===1?teamObserver(state,local[0].id):null;
}
/** Only frozen personally acquired descriptors cross into decision code. */
export function directSoldier(state:BattleState,s:Soldier|null|undefined,id:number):Soldier|undefined{
 const c=directContacts(state,s).find(c=>c.entity==='soldier'&&c.id===id);return c&&s?observedSoldier(c,s.side==='german'?'soviet':'german'):undefined;
}
export function directVehicle(state:BattleState,s:Soldier|null|undefined,id:number):Vehicle|undefined{
 const c=directContacts(state,s).find(c=>c.entity==='vehicle'&&c.id===id);return c&&s?observedVehicle(c,s.side==='german'?'soviet':'german'):undefined;
}
/** A shared order conveys its original point. Later tracking is personal knowledge. */
export function recipientOrder(state:BattleState,s:Soldier|null|undefined,order:import('@/shared/types').Order|null|undefined):import('@/shared/types').Order|null{
 if(!order)return null;if(order.type!=='fire'||order.targetTeamId==null||!s)return order;
 const contacts=knownContacts(state,s).filter(c=>c.teamId===order.targetTeamId);
 const evidence=contacts.filter(c=>c.health!=='dead'&&c.health!=='incapacitated'&&c.vehicleState!=='knockedOut'&&c.vehicleState!=='burning');
 if(contacts.length&&!evidence.length)return{...order,type:'defend',target:{...(s.targetPoint??order.target)}};
 if(!evidence.length)return{...order,target:{...(s.targetPoint??order.target)}};
 return{...order,target:{x:evidence.reduce((n,c)=>n+c.pos.x,0)/evidence.length,y:evidence.reduce((n,c)=>n+c.pos.y,0)/evidence.length},lastSeenAt:Math.max(...evidence.map(c=>c.observedAt))};
}
