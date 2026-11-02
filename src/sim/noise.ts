/** Immutable physical sound stimuli; independent of renderer-drained UI events. */
import type {BattleEvent,BattleState,Side,Vec2} from '@/shared/types';
import {WEAPONS} from '@/data/weapons';
export function emitNoise(state:BattleState,pos:Vec2,kind:'shot'|'engine'|'blast'|'voice',rangeM:number,sourceKey:string,side?:Side):void{
 const n=state.noise??={nextId:0,sources:{},events:[]},serial=kind==='blast'?0:(n.sources[sourceKey]??0)+1;if(kind!=='blast')n.sources[sourceKey]=serial;
 n.events.push({id:n.nextId++,key:`${sourceKey}:${serial}`,at:state.time,pos:{...pos},kind,rangeM,side});if(n.events.length>1024)n.events.shift();
}
export function emitShot(state:BattleState,event:{kind:'shot';pos:Vec2;weaponId:string;side:Side;singleRound?:boolean},sourceKey:string):void{
 state.events.push(event);const cls=WEAPONS[event.weaponId]?.cls;
 emitNoise(state,event.pos,'shot',cls==='tankgun'||cls==='atgun'||cls==='mortar'||cls==='rocket'?600:250,`${sourceKey}:${event.weaponId}`,event.side);
}
