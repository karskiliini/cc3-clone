/** Small exact-output 056 trace, runnable in Node and browser after esbuild bundling.
 * Deliberately exercises personal sound/report/condition/geometry state and a
 * mid-run data restoration; no camera or renderer owns a simulation input. */
import {fixture} from '../test/fixtures/personalBattle';
import {Battle} from '@/sim/battle';
import {hashState} from '@/sim/stateHash';
import {emitShot} from '@/sim/noise';
import {explainIndividual} from '@/sim/humanCondition';
import {planningMap,rememberCell} from '@/sim/navigationKnowledge';
import type {BattleState} from '@/shared/types';
function clone<T>(v:T):T{
 if(v==null||typeof v!=='object')return v;
 if(ArrayBuffer.isView(v))return (v as unknown as {slice():T}).slice();
 if(v instanceof Map)return new Map([...v].map(([k,x])=>[k,clone(x)])) as T;
 if(v instanceof Set)return new Set(v) as T;
 if(Array.isArray(v))return v.map(clone) as T;
 return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clone(x)])) as T;
}
export function runPersonalTrace(){
 const {b,state,a,isolated:mate,enemy}=fixture();mate.pos={x:22,y:21};
 a.health='wounded';a.condition={breath:65,sweat:35,hearingLoss:.1,at:0,lastPos:{...a.pos}};a.fatigue=25;
 enemy.pos={x:55,y:20};for(let y=0;y<state.map.height;y++)state.map.tiles[y*state.map.width+30]='stonewall';
 rememberCell(a,{index:20*400+21,tile:'rubble',window:0,buildingId:-1,bunkerId:-1,wire:0,smoke:0,observedAt:0,sourceId:a.id,hops:0});
 let restored:Battle|undefined;const frames=[];
 for(let i=0;i<60;i++){
  for(const current of restored?[b,restored]:[b]){
   if(i===2||i===25)emitShot(current.state,{kind:'shot',pos:{...enemy.pos},weaponId:'kar98k',side:'soviet'},'s101');
   if(i===12)current.state.soldiers.get(a.id)!.dazedUntil=current.state.time+1;
   const before=hashState(current),rng=current.rng.state();explainIndividual(current.state.soldiers.get(a.id)!,current.state.time);planningMap(current.state,current.state.soldiers.get(a.id));
   if(hashState(current)!==before||current.rng.state()!==rng)throw new Error('Read-only query changed state');
   current.advanceTick();current.drainEvents();
  }
  if(restored&&hashState(restored)!==hashState(b))throw new Error(`Restoration differs at tick ${i}`);
  const s=b.state.soldiers.get(a.id)!;
  frames.push({hash:hashState(b),condition:s.condition,evidence:s.perception,explanation:explainIndividual(s,b.state.time)});
  // Freeze snapshots before future in-place condition updates.
  frames[frames.length-1]=structuredClone(frames[frames.length-1]);
  if(i===20){restored=new Battle(structuredClone(b.state.config));restored.state=clone(b.state) as BattleState;restored.rng.setState(b.rng.state());}
 }
 return frames;
}
export const result=runPersonalTrace();
console.log(JSON.stringify(result));
