import type {BattleState,RadioPayload,RadioTransmission,Side,Soldier,PendingContactReport} from '@/shared/types';
import {communicationLink,commandRecipient,conscious} from './perception';
import {VEHICLE_DEFS} from '@/data/units';
export const RADIO_TRAFFIC_LIMIT=256;
/** Public wire content only: never attach live senders or private plans. */
export function emitRadio(state:BattleState,senderSide:Side,payload:RadioPayload):RadioTransmission{
 const traffic=state.radioTraffic??={nextId:0,messages:[]};
 const clean:RadioPayload=payload.kind==='signal'?{kind:'signal',signalId:payload.signalId}:
 payload.kind==='message'||payload.kind==='report'?{kind:payload.kind,text:payload.text,...(payload.target?{target:{...payload.target}}:{})}:
 {kind:payload.kind,missionId:payload.missionId,target:{...payload.target}};
 const message:RadioTransmission={id:traffic.nextId++,at:state.time,senderSide,payload:clean};
 traffic.messages.push(message);if(traffic.messages.length>RADIO_TRAFFIC_LIMIT)traffic.messages.splice(0,traffic.messages.length-RADIO_TRAFFIC_LIMIT);return message;
}
export function interceptedRadio(state:BattleState,side:Side):readonly RadioTransmission[]{return(state.radioTraffic?.messages??[]).filter(m=>m.senderSide!==side);}
export function radioOrderSender(state:BattleState,side:Side,teamId:number):Soldier|null{
 const sender=commandRecipient(state,side),team=state.teams.get(teamId),recipient=team?state.soldiers.get(team.leaderId):undefined;
 return sender&&recipient&&communicationLink(state,sender,recipient)?.channel==='radio'?sender:null;
}
/** Evidence coordinates are permitted; exact caller/source positions and identity are not. */
export function emitContactRadio(state:BattleState,side:Side,r:PendingContactReport):void{
 if(r.channel!=='radio')return;
 if(r.contact)emitRadio(state,side,{kind:'report',text:`Contact report: ${r.contact.entity}`,target:r.contact.pos});
 else if(r.belief)emitRadio(state,side,{kind:'report',text:'Enemy activity report',target:r.belief.pos});
 else if(r.casualty)emitRadio(state,side,{kind:'report',text:`Casualty report: ${r.casualty.health}`,target:r.casualty.pos});
 else if(r.navigationCell)emitRadio(state,side,{kind:'report',text:'Terrain report'});
 else if(r.navigationHull)emitRadio(state,side,{kind:'report',text:'Vehicle obstruction report'});
 else if(r.objective)emitRadio(state,side,{kind:'report',text:`Objective ${r.objective.id}: ${r.objective.owner??'uncontrolled'}`});
 else if(r.leadership)emitRadio(state,side,{kind:'report',text:'Leadership succession report'});
}

/** Operational HQ radio endpoint, without requiring successful friendly reception. */
export function radioCommandSender(state:BattleState,side:Side):Soldier|null{
 const s=commandRecipient(state,side);if(!s||!conscious(s,state.time)||s.mind.state==='panicked'||s.mind.state==='broken')return null;
 const t=state.teams.get(s.teamId);if(!t||t.leaderId!==s.id)return null;
 if(t.type==='command'||t.type==='mortar'||t.type==='rocket')return s;
 const v=t.vehicleId!=null?state.vehicles.get(t.vehicleId):undefined,def=v?VEHICLE_DEFS[v.defId]:undefined;
 return v&&def&&s.vehicleId===v.id&&(v.state==='ok'||v.state==='immobilized')&&def.layout?.radio!==false&&v.damage?.radio!=='destroyed'?s:null;
}
