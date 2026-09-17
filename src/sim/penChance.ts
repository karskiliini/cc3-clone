import type { BattleState, RoundCounts, RoundType, Soldier, Team, Vec2, Vehicle, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { dist } from '@/shared/math';
import { roundPenetrationMm } from '@/sim/ballistics';
import { SKILL_ACE, chooseAimPoint, gunnerSkill, soldierRounds, vehicleRounds } from '@/sim/aimPoint';
import { crewEffects, expectedArmorMm, mainGunUsable } from '@/sim/vehicleDamage';

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf), accurate to ~1e-7. */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Probability that a hit penetrates: the closed form of `penetrates()` in ballistics.ts
 * (pen = roundPenetrationMm: for AP penetrationMm * max(0.4, 1 - dist/1000), APCR with its own
 * falloff; multiplied by 1 + 0.12 * gauss). Keep in step. */
export function penetrationChance(weapon: WeaponDef, distM: number, armorMm: number, round: RoundType = 'ap'): number {
  const pen = roundPenetrationMm(weapon, distM, round);
  if (pen <= 0) return 0;
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

interface ArmedMan { weapon: WeaponDef; counts: RoundCounts | null; skill: number }

/** The team's anti-armour weapons with the man who lays each and the rounds he has left. */
function teamArmourShooters(state: BattleState, team: Team): ArmedMan[] {
  const out: ArmedMan[] = [];
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    const id = v ? VEHICLE_DEFS[v.defId]?.mainWeaponId : null;
    const w = id ? WEAPONS[id] : undefined;
    if (!v || !w || w.penetrationMm <= 0 || !mainGunUsable(v)) return out;
    const gunner = crewEffects(state, v).gunner;
    const counts = w.rounds ? { ...vehicleRounds(state, v) } : null;
    if (counts && v.loadedRound) counts[v.loadedRound]++;
    out.push({ weapon: w, counts, skill: gunner ? gunnerSkill(gunner) : 0 });
    return out;
  }
  const seen = new Set<WeaponDef>();
  for (const sid of team.soldierIds) {
    const s: Soldier | undefined = state.soldiers.get(sid);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const w = WEAPONS[s.weaponId];
    if (!w || w.penetrationMm <= 0 || seen.has(w)) continue;
    seen.add(w);
    const counts = w.rounds ? { ...soldierRounds(state, s) } : null;
    const cw = team.crewWeapon;
    if (counts && cw && cw.gunnerId === s.id && cw.chambered && cw.chamberedType) counts[cw.chamberedType]++;
    out.push({ weapon: w, counts, skill: gunnerSkill(s) });
  }
  return out;
}

/** Best chance any of the team's weapons has to penetrate `target` from `from`: with the best round
 * the team would actually load at that range (AP or APCR; year-gated, some left) against the plate
 * the gunner would aim at given his skill (0 beyond the weapon's range). */
export function teamPenetrationChance(state: BattleState, team: Team, from: Vec2, target: Vehicle): number {
  const def = VEHICLE_DEFS[target.defId];
  if (!def) return 0;
  const distM = dist(from, target.pos) * TILE_M;
  const year = state.config?.year;
  let best = 0;
  for (const m of teamArmourShooters(state, team)) {
    if (distM > m.weapon.rangeM) continue;
    const choice = chooseAimPoint(m.weapon, m.counts, m.skill, from, target, year);
    const armorMm = expectedArmorMm(target, def, from, choice.aimPoint, m.skill > SKILL_ACE);
    const rounds: RoundType[] = ['ap', 'apcr'];
    for (const r of rounds) {
      if (m.counts && m.counts[r] <= 0) continue;
      if (r === 'apcr' && !m.weapon.apcr) continue;
      if (r === 'apcr' && !m.counts && m.weapon.apcr!.from != null && year != null && year < m.weapon.apcr!.from) continue;
      best = Math.max(best, penetrationChance(m.weapon, distM, armorMm, r));
    }
  }
  return best;
}
