import type {BattleState,Order,PlanTrigger,Side} from '@/shared/types';
import {communicationLink,conscious} from './perception';
import {emitRadio,radioCommandSender} from './radioTraffic';
import {addMessage} from './messages';

export function plans(state:BattleState){return state.battlePlans??={german:{orders:[],signals:[]},soviet:{orders:[],signals:[]}};}
export function setPlannedOrder(state:BattleState,side:Side,teamId:number,order:Order,trigger:PlanTrigger):boolean{
 const team=state.teams.get(teamId);
 if(state.phase!=='deploy'||!team||team.side!==side)return false;
 if(trigger.kind==='signal'&&![1,2,3].includes(trigger.signal)||trigger.kind==='time'&&(!Number.isFinite(trigger.at)||trigger.at<0||trigger.at>state.config.durationS))return false;
 const p=plans(state)[side];p.orders=p.orders.filter(o=>o.teamId!==teamId||o.trigger.kind!==trigger.kind||
  (o.trigger.kind==='signal'&&trigger.kind==='signal'?o.trigger.signal!==trigger.signal:o.trigger.kind==='time'&&trigger.kind==='time'&&o.trigger.at!==trigger.at));
 const briefed=structuredClone(order);delete briefed.prebriefed;
 p.orders.push({teamId,order:briefed,trigger:{...trigger},status:'waiting'});
 addMessage(state,`${team.name}: advance order prepared (${trigger.kind==='signal'?`Signal ${trigger.signal}`:`H+${trigger.at}s`}).`,'info',side);return true;
}
export function cancelPlannedOrder(state:BattleState,side:Side,teamId:number):void{
 if(state.phase==='deploy')plans(state)[side].orders=plans(state)[side].orders.filter(o=>o.teamId!==teamId);
}
export function sendPlanSignal(state:BattleState,side:Side,signal:1|2|3):boolean{
 const sender=radioCommandSender(state,side);
 if(state.phase!=='running'||![1,2,3].includes(signal)||!sender)return false;
 const p=plans(state)[side];if(p.signals.some(s=>s.signal===signal))return false;
 const deliveries=p.orders.filter(o=>o.status==='waiting'&&o.trigger.kind==='signal'&&o.trigger.signal===signal).flatMap(o=>{
  const team=state.teams.get(o.teamId),recipient=team?state.soldiers.get(team.leaderId):undefined;
  const link=recipient?communicationLink(state,sender,recipient):null;
  return recipient&&(recipient.id===sender.id||link)?[{teamId:o.teamId,recipientId:recipient.id,channel:recipient.id===sender.id?'self' as const:link!.channel,at:state.time+(recipient.id===sender.id?0:link!.delay)}]:[];
 });
 p.signals.push({signal,sentAt:state.time,senderId:sender.id,deliveries});emitRadio(state,side,{kind:'signal',signalId:String(signal)});
 addMessage(state,`Signal ${signal} transmitted.`,'info',side);return true;
}
export function stepBattlePlan(state:BattleState,issue:(teamId:number,order:Order)=>void):void{
 if(!state.battlePlans||state.phase!=='running')return;
 for(const side of ['german','soviet'] as const)for(const p of state.battlePlans[side].orders){
  if(p.status!=='waiting')continue;
  const team=state.teams.get(p.teamId),leader=team?state.soldiers.get(team.leaderId):undefined;
  if(!team||team.outOfAction){p.status='failed';continue;}
  if(p.trigger.kind==='time'){if(state.time<p.trigger.at||!conscious(leader,state.time))continue;}
  else{
   const trigger=p.trigger,signal=state.battlePlans[side].signals.find(s=>s.signal===trigger.signal);if(!signal)continue;
   const delivery=signal.deliveries?.find(d=>d.teamId===p.teamId);
   if(!delivery||delivery.delivered||state.time<delivery.at)continue;
   delivery.delivered=true;
   const sender=state.soldiers.get(signal.senderId!),link=sender&&leader?communicationLink(state,sender,leader):null;
   // A missed emission is not delivered retroactively on later reconnection.
   if(!sender||!conscious(leader,state.time)||leader!.id!==delivery.recipientId||sender.id!==leader!.id&&link?.channel!==delivery.channel){p.status='failed';continue;}
  }
  issue(p.teamId,{...structuredClone(p.order),prebriefed:true,issuedAt:state.time});p.status='executed';p.executedAt=state.time;
  addMessage(state,`${team.name}: advance order activated.`,'info',side);
 }
}
