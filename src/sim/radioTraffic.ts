import type {BattleState,RadioPayload,RadioTransmission,Side,Soldier,PendingContactReport,Order} from '@/shared/types';
import {commandRoute} from './commandRoute';
import {commandRecipient,conscious} from './perception';
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
 const hop=commandRoute(state,side,teamId)?.find(h=>h.channel==='radio');
 return hop?state.soldiers.get(hop.from)??null:null;
}
export function emitTelephone(state:BattleState,side:Side,payload:RadioPayload):void{
 const net=state.telephoneTraffic??={nextId:0,messages:[]};net.messages.push({id:net.nextId++,at:state.time,senderSide:side,payload:structuredClone(payload)});if(net.messages.length>256)net.messages.splice(0,net.messages.length-256);
}
export function emitCommandTraffic(state:BattleState,side:Side,teamId:number,order:Order):void{
 const route=commandRoute(state,side,teamId);if(!route)return;
 const payload:RadioPayload={kind:'message',text:order.illumination?'Illumination order':`${order.type} order`,target:order.target};
 if(route.some(h=>h.channel==='radio'))emitRadio(state,side,payload);
 if(route.some(h=>h.channel==='telephone'))emitTelephone(state,side,payload);
}
/** Evidence coordinates are permitted; exact caller/source positions and identity are not. */
export function emitContactRadio(state:BattleState,side:Side,r:PendingContactReport,automatic=false):void{
 if(r.channel!=='radio'&&r.channel!=='telephone')return;
 // Observation-memory synchronization is not an order spoken into a radio.
 // Explicit observer/fire-support reports can still be transmitted by their real call sites.
 if(automatic&&r.channel==='radio')return;
 let payload:RadioPayload|undefined;
 if(r.contact)payload={kind:'report',text:`Contact report: ${r.contact.vehicleDefId?VEHICLE_DEFS[r.contact.vehicleDefId]?.name??'tank':r.contact.entity}`,target:r.contact.pos};
 else if(r.casualty)payload={kind:'report',text:`Casualty report: ${r.casualty.health}`,target:r.casualty.pos};
 else if(r.objective)payload={kind:'report',text:`Objective ${r.objective.id}: ${r.objective.owner??'uncontrolled'}`};
 else if(r.leadership)payload={kind:'report',text:'Leadership succession report'};
 // Bulk cell/belief synchronization is not a separate spoken human utterance.
 if(!payload)return;
 const identity=r.contact?`contact:${r.contact.entity}:${r.contact.id}:${r.contact.vehicleState??r.contact.health??'seen'}`:r.casualty?`casualty:${r.casualty.id}:${r.casualty.health}`:r.objective?`objective:${r.objective.id}:${r.objective.owner}`:'leadership';
 const base=`${r.channel}:${side}:${identity}`,area='target' in payload&&payload.target?`${Math.round(payload.target.x/5)},${Math.round(payload.target.y/5)}`:'none';
 const key=`${base}:${area}:${'text' in payload?payload.text:payload.kind}`,spoken=state.spokenReports??={};
 // A relayed observation is one announcement, not one voice per receiver/frame.
 if(spoken[base]!=null&&state.time-spoken[base]<12||spoken[key]!=null&&state.time-spoken[key]<60)return;
 spoken[base]=state.time;spoken[key]=state.time;
 for(const [key,at] of Object.entries(spoken))if(state.time-at>120)delete spoken[key];
 if(r.channel==='radio')emitRadio(state,side,payload);
 else emitTelephone(state,side,payload);
}
/** Global player headset access; this does not deliver knowledge to soldiers. */
export function headsetTraffic(state:BattleState){
 return [...(state.radioTraffic?.messages??[]).map(m=>({id:m.id*2,at:m.at,side:m.senderSide,channel:'radio' as const,payload:m.payload})),
 ...(state.telephoneTraffic?.messages??[]).map(m=>({id:m.id*2+1,at:m.at,side:m.senderSide,channel:'telephone' as const,payload:m.payload}))].sort((a,b)=>a.at-b.at||a.id-b.id);
}

/** Operational HQ radio endpoint, without requiring successful friendly reception. */
export function radioCommandSender(state:BattleState,side:Side):Soldier|null{
 const s=commandRecipient(state,side);if(!s||!conscious(s,state.time)||s.mind.state==='panicked'||s.mind.state==='broken')return null;
 const t=state.teams.get(s.teamId);if(!t||t.leaderId!==s.id)return null;
 if(t.type==='command'||t.type==='mortar'||t.type==='rocket')return s;
 const v=t.vehicleId!=null?state.vehicles.get(t.vehicleId):undefined,def=v?VEHICLE_DEFS[v.defId]:undefined;
 return v&&def&&s.vehicleId===v.id&&(v.state==='ok'||v.state==='immobilized')&&def.layout?.radio!==false&&v.damage?.radio!=='destroyed'?s:null;
}
