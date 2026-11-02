import type {BattleState,Soldier} from '@/shared/types';
import {hash2,Rng} from '@/shared/rng';
/** Per-person event streams: unrelated hidden activity cannot shift another
 * person's obedience, reaction or weapon-handling randomness. Saved as data. */
export function openHumanRng(state:BattleState,s:Soldier,channel:string){
 const streams=s.randomStreams??={},salt=[...channel].reduce((n,c)=>Math.imul(n,31)+c.charCodeAt(0),0),rng=new Rng(streams[channel]??Math.floor(hash2(s.id,state.config.seed,salt)*4294967296));
 return{rng,save:()=>{streams[channel]=rng.state();}};
}
export function withHumanRng<T>(state:BattleState,s:Soldier,channel:string,fn:(rng:Rng)=>T):T{
 const local=openHumanRng(state,s,channel);try{return fn(local.rng);}finally{local.save();}
}
export function withCommandRng<T>(state:BattleState,side:Soldier['side'],fn:(rng:Rng)=>T):T{
 const store=state.aiRuntime??={},key=`random:${side}`,rng=new Rng(typeof store[key]==='number'?store[key] as number:Math.floor(hash2(state.config.seed,side==='german'?1:2,4711)*4294967296));
 try{return fn(rng);}finally{store[key]=rng.state();}
}
