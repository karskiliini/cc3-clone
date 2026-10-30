import type { BattleState, HullDrive, Vehicle } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { clamp } from '@/shared/math';
import type { Rng } from '@/shared/rng';
import { hullAngles } from './hullMath';
import { bailOut, crewEffects, hurtCrewman, hurtPassenger, isImmobile, worsen } from './vehicleDamage';
import { passengersAboard, startUnload } from './transport';

// Approved simulation balancing heuristics, not historical recovery rates.
// One request per 0.1 s tick samples this boundary (first cycle: 0.8 s
// reverse / 0.7 s forward); logical cycles remain exactly 1.5 s.
const ROCK_HALF_S = 0.75;
const ROCK_CYCLE_S = 2 * ROCK_HALF_S;
const recoveryTries = (experience: number): number => 1 + Math.floor(clamp(experience, 0, 100) / 25);

/** Pure current-tick override. Exhausted recovery holds the driver stopped. */
export function hullRecoveryDrive(v: Vehicle, experience: number): HullDrive | null {
  const b = v.body;
  if (!b?.hungUp || b.overturned) return null;
  if (b.rockTries >= recoveryTries(experience)) return { speedMs: 0, yawRateRadS: 0, brake: true };
  return { speedMs: b.rockPhaseS < ROCK_HALF_S ? -1 : 1, yawRateRadS: 0, brake: false };
}

/** After the accepted physical step. Only a recovery request actually applied this
 * tick can advance the powered cycle; contact and overturn consequences always run. */
export function stepHullGameplay(state: BattleState, rng: Rng, v: Vehicle, dt: number, recoveryApplied = false): void {
  const b = v.body, def = VEHICLE_DEFS[v.defId];
  if (!b || !def || b.overturned) return;
  const a = hullAngles(b.orientation);
  const tipped = Math.abs(a.roll) > 75 * Math.PI / 180 || Math.abs(a.pitch) > 80 * Math.PI / 180;
  b.tippedS = tipped ? b.tippedS + dt : 0;
  if (b.tippedS >= 2 - 1e-9) {
    b.overturned = true;
    b.rockPhaseS = 0; b.rockTries = 0;
    v.path = [];
    // Capture everyone before bailOut starts hatch exits. Soldier id is the RNG order,
    // independent of crew-seat or passenger-list ordering (including wounded men).
    const aboard = [...state.soldiers.values()].filter(s => s.vehicleId === v.id && s.health !== 'dead')
      .sort((x, y) => x.id - y.id);
    const team = state.teams.get(v.teamId);
    const enemy = v.side === 'german' ? 'soviet' : 'german';
    for (const s of aboard) {
      const r = rng.next(), injury = r < 0.05 ? 'incapacitated' : r < 0.25 ? 'wounded' : null;
      if (!injury) continue;
      if (s.seat === 'passenger') hurtPassenger(state, v, s, injury, enemy);
      else {
        const crewTeam = state.teams.get(s.teamId);
        if (crewTeam) hurtCrewman(state, v, s, injury, enemy, crewTeam);
      }
    }
    if (team) bailOut(state, v, team, 'knockedOut', def.name + ' overturned');
    else { v.state = 'knockedOut'; delete v.localDriver; }
    if (passengersAboard(state, v).length > 0) startUnload(state, v, true);
    return;
  }
  if (!b.hungUp) {
    b.rockPhaseS = 0; b.rockTries = 0;
    return;
  }
  if (!recoveryApplied || (v.state !== 'ok' && v.state !== 'immobilized') || isImmobile(v)
    || !crewEffects(state, v).canDrive) return;
  const maxTries = recoveryTries(state.teams.get(v.teamId)?.experience ?? 0);
  if (b.rockTries >= maxTries) return;
  b.rockPhaseS += dt;
  if (b.rockPhaseS >= ROCK_CYCLE_S - 1e-9) {
    b.rockPhaseS = Math.max(0, b.rockPhaseS - ROCK_CYCLE_S);
    b.rockTries++;
    // One loss roll per completed cycle; the second draw belongs only to a loss.
    if (rng.next() < 0.02) worsen(v, rng.next() < 0.5 ? 'trackL' : 'trackR', 'destroyed');
  }
}
