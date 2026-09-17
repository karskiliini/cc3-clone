import type { BattleState, Team, Vec2, Vehicle, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { dist } from '@/shared/math';
import { armorFacingFor } from '@/sim/ballistics';

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf), accurate to ~1e-7. */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Probability that a hit penetrates: the closed form of `penetrates()` in ballistics.ts
 * (pen = penetrationMm * max(0.4, 1 - dist/1000), multiplied by 1 + 0.12 * gauss). Keep in step. */
export function penetrationChance(weapon: WeaponDef, distM: number, armorMm: number): number {
  if (weapon.penetrationMm <= 0) return 0;
  const pen = weapon.penetrationMm * Math.max(0.4, 1 - distM / 1000);
  return 1 - phi((armorMm / pen - 1) / 0.12);
}

/** Anti-armour weapons a team can bring to bear: a vehicle's main gun, or its living men's weapons. */
export function teamArmourWeapons(state: BattleState, team: Team): WeaponDef[] {
  const out: WeaponDef[] = [];
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    const id = v ? VEHICLE_DEFS[v.defId]?.mainWeaponId : null;
    const w = id ? WEAPONS[id] : undefined;
    if (w && w.penetrationMm > 0) out.push(w);
    return out;
  }
  for (const sid of team.soldierIds) {
    const s = state.soldiers.get(sid);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const w = WEAPONS[s.weaponId];
    if (w && w.penetrationMm > 0 && !out.includes(w)) out.push(w);
  }
  return out;
}

export type PenRating = 'none' | 'maybe' | 'likely';
export const PEN_MAYBE_FROM = 0.1;
export const PEN_LIKELY_FROM = 0.6;

export function penRating(chance: number): PenRating {
  return chance >= PEN_LIKELY_FROM ? 'likely' : chance >= PEN_MAYBE_FROM ? 'maybe' : 'none';
}

/** Best chance any of the team's weapons has to penetrate `target` from `from`, given the armour
 * face the target presents to that position and the range (0 beyond the weapon's range). */
export function teamPenetrationChance(state: BattleState, team: Team, from: Vec2, target: Vehicle): number {
  const def = VEHICLE_DEFS[target.defId];
  if (!def) return 0;
  const armorMm = def.armor[armorFacingFor(target, from)];
  const distM = dist(from, target.pos) * TILE_M;
  let best = 0;
  for (const w of teamArmourWeapons(state, team)) {
    if (distM > w.rangeM) continue;
    best = Math.max(best, penetrationChance(w, distM, armorMm));
  }
  return best;
}
