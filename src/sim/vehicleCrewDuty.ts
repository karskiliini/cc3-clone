import type { BattleState, Soldier, Vehicle } from '@/shared/types';
import { bowGunner, crewEffects, crewRoleOf, vehicleLoader, mainGunUsable } from './vehicleDamage';

export type VehicleCrewDuty = 'driving' | 'loading' | 'aiming' | 'firing' | 'watching' | 'waiting' | 'changingSeat';

/** One physical job per man, shared by simulation activity and the soldier monitor. */
export function vehicleCrewDuty(state: BattleState, v: Vehicle, s: Soldier): VehicleCrewDuty | null {
  if (s.vehicleId !== v.id || s.seat === 'passenger' || s.hatch || s.health === 'dead' || s.health === 'incapacitated') return null;
  if (v.seatSwap?.soldierId === s.id) return 'changingSeat';
  const role = crewRoleOf(state, v, s.id);
  if (v.state === 'burning' || v.state === 'knockedOut' || v.state === 'abandoned') return 'waiting';
  if (role === 'driver') return Math.abs(v.speed) > 0.1 ? 'driving'
    : bowGunner(state, v)?.id === s.id && state.time - s.lastFiredAt < 0.3 ? 'firing' : 'waiting';
  if (v.mainFireTimer > 0 && v.gunState === 'loading' && vehicleLoader(state, v)?.id === s.id) return 'loading';
  if (state.time - s.lastFiredAt < 0.3) return 'firing';
  if (mainGunUsable(v) && crewEffects(state, v).gunner?.id === s.id && v.gunLay && (v.layProgress ?? 0) < 1) return 'aiming';
  return role ? 'watching' : 'waiting';
}

/** Mounted crew never inherit infantry aiming/reloading or a whole team's firing activity.
 * Passengers retain their separate open-vehicle small-arms rules. */
export function syncVehicleCrewDuties(state: BattleState, v: Vehicle): void {
  for (const id of state.teams.get(v.teamId)?.soldierIds ?? []) {
    const s = state.soldiers.get(id);
    if (!s) continue;
    const duty = vehicleCrewDuty(state, v, s);
    if (!duty) continue;
    s.aiming = undefined; s.smgBurst = undefined; s.crewTask = undefined; s.reloadTimer = 0;
    s.targetSoldierId = null; s.targetVehicleId = null; s.targetPoint = null;
    s.activity = duty === 'driving' ? 'moving' : duty === 'loading' ? 'reloading'
      : duty === 'firing' || duty === 'aiming' ? 'firing' : 'idle';
  }
}
