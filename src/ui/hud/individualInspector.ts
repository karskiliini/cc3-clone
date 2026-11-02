import type {BattleState,Order,Soldier} from '@/shared/types';
import {humanCapability} from '@/sim/humanCondition';
import {directContacts,knownContacts,recipientOrder} from '@/sim/perception';
/** Read-only view of this person's evidence, rather than the viewer's spotted union. */
export function drawIndividualInspector(ctx:CanvasRenderingContext2D,state:BattleState,s:Soldier,order:Order|null):void{
 const c=humanCapability(s,state.time),own=recipientOrder(state,s,order),seen=directContacts(state,s),known=knownContacts(state,s),latest=known.slice().sort((a,b)=>b.observedAt-a.observedAt)[0],sound=s.perception?.sounds.at(-1);
 const pct=(n:number)=>`${Math.round(n*100)}%`;
 const lines=[`${s.rank} ${s.name} · own evidence [I]`,`Order: ${own?.type??'none'} · ${s.activity} · ${s.mind.state}${s.mind.trait?' / '+s.mind.trait:''}`,`Seen ${seen.length} · remembered/reported ${known.length}`,
 latest?`${latest.sourceId===s.id?'Own sight':'Report'}: ${(state.time-latest.observedAt).toFixed(1)}s old · ±${Math.round(latest.uncertaintyM)}m`:'No identified enemy contact',sound?`Heard ${sound.kind}: ±${Math.round(sound.uncertaintyM)}m · ${(state.time-sound.observedAt).toFixed(1)}s`:'No recent audible cue',
 `Pain ${pct(c.pain)} · breath ${pct(c.breath)} · shock ${pct(c.shock)}`,`Fatigue ${pct(c.exhaustion)} · sweat ${pct(c.sweat)} · tremor ${pct(c.tremor)}`,`Pace ${pct(c.pace)} · accuracy ${pct(c.accuracy)}`,`Settle ×${c.settle.toFixed(2)} · decision ×${c.decision.toFixed(2)}`,c.canOperate?'Able to act within role and weapon limits':'Cannot operate: injury, shock or mental state'];
 ctx.save();ctx.fillStyle='rgba(19,17,13,.94)';ctx.fillRect(644,78,366,220);ctx.strokeStyle='#9b8a63';ctx.strokeRect(644.5,78.5,365,219);ctx.font='12px Arial';ctx.textBaseline='top';ctx.fillStyle='#e7ddc2';lines.forEach((text,i)=>ctx.fillText(text,655,90+i*19,345));ctx.restore();
}
