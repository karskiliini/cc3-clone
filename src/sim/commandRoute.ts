import type {BattleState,Side} from '@/shared/types';
import {commandRecipient,communicationLink,conscious} from './perception';

export type CommandLink=NonNullable<ReturnType<typeof communicationLink>>;
export interface CommandHop extends CommandLink {from:number;to:number}
/** Prefer an actual local/wired command path; radio is a fallback, not a broadcast switch. */
export function commandRoute(state:BattleState,side:Side,teamId:number):CommandHop[]|null{
 const sender=commandRecipient(state,side),team=state.teams.get(teamId),recipient=team?state.soldiers.get(team.leaderId):undefined;
 if(!sender||!recipient||team?.side!==side||!conscious(sender,state.time)||!conscious(recipient,state.time))return null;
 if(sender.id===recipient.id)return [];
 const direct=communicationLink(state,sender,recipient);
 if(direct&&direct.channel!=='radio')return [{from:sender.id,to:recipient.id,...direct}];
 const candidates=[...state.teams.values()].filter(t=>t.side===side&&!t.outOfAction)
  .map(t=>state.soldiers.get(t.leaderId)).filter(s=>conscious(s,state.time)).sort((a,b)=>a.id-b.id);
 const search=(radio:boolean):CommandHop[]|null=>{
  const queue:{id:number;path:CommandHop[];delay:number;radios:number}[]=[{id:sender.id,path:[],delay:0,radios:0}],visited=new Set<number>();
  while(queue.length){
   queue.sort((a,b)=>a.radios-b.radios||a.delay-b.delay||a.id-b.id);
   const current=queue.shift()!;if(visited.has(current.id))continue;visited.add(current.id);
   if(current.id===recipient.id)return current.path;
   if(current.path.length>=6)continue;
   const from=state.soldiers.get(current.id)!;
   for(const next of candidates){
    if(visited.has(next.id))continue;const link=communicationLink(state,from,next);
    if(!link||!radio&&link.channel==='radio')continue;
    queue.push({id:next.id,path:[...current.path,{from:from.id,to:next.id,...link}],delay:current.delay+link.delay,radios:current.radios+(link.channel==='radio'?1:0)});
   }
  }return null;
 };
 return search(false)??(direct?[{from:sender.id,to:recipient.id,...direct}]:search(true));
}
