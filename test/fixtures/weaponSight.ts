import type {BattleState} from '@/shared/types';
import {perception,recordVisual} from '@/sim/perception';
import {stepCombat as combat} from '@/sim/combat';
import type {Rng} from '@/shared/rng';
/** Legacy weapon unit fixtures explicitly declare which targets every test
 * shooter can currently see. This is fixture input, not production acquisition
 * or communication; sensory-boundary tests call the real combat step directly. */
export function refreshWeaponSight(state:BattleState):void{
 for(const s of state.soldiers.values()){
  perception(s).visual=[];
  for(const id of state.spotted[s.side]){const e=state.soldiers.get(id);if(e&&e.side!==s.side&&(e.vehicleId==null||e.hatch))recordVisual(state,s,e,'soldier');}
  for(const id of state.spottedVehicles[s.side]){const e=state.vehicles.get(id);if(e&&e.side!==s.side)recordVisual(state,s,e,'vehicle');}
 }
}
export function withWeaponSight<F extends (state:BattleState,...args:any[])=>any>(fn:F):F{
 return ((state:BattleState,...args:any[])=>{refreshWeaponSight(state);return fn(state,...args);}) as F;
}
export function stepCombatWithSight(state:BattleState,rng:Rng,dt:number):void{
 refreshWeaponSight(state);
 // The unit fixture's seed now seeds each shooter's own saved streams. Subsequent
 // calls keep their positions; production initialization remains config/id keyed.
 for(const s of state.soldiers.values()){const streams=s.randomStreams??={};for(const channel of ['weapon','ballistics','grenade','vehicleWeapon','indirect'])streams[channel]??=rng.state();}
 combat(state,rng,dt);
}
