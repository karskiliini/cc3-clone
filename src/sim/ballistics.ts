import type { Health, Soldier, Stance, Vec2, Vehicle, WeaponDef } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, wrapAngle, angleTo } from '@/shared/math';

const DEG60 = (60 * Math.PI) / 180;
const DEG135 = (135 * Math.PI) / 180;

function stanceFactor(stance: Stance): number {
  switch (stance) {
    case 'standing': return 1;
    case 'crouching': return 0.7;
    case 'prone': return 0.45;
  }
}

/** rangeFactor: 1 at <=100m, (100/dist)^0.8 beyond, 0 beyond weapon.rangeM. */
function rangeFactor(weapon: WeaponDef, distM: number): number {
  if (distM > weapon.rangeM) return 0;
  if (distM <= 100) return 1;
  return Math.pow(100 / distM, 0.8);
}

function shooterFactor(shooter: Soldier): number {
  const suppressionTerm = 1 - shooter.suppression / 150;
  const expTerm = 0.7 + shooter.experience / 300;
  const fatigueTerm = shooter.fatigue > 70 ? 0.8 : 1;
  const mindState = shooter.mind?.state;
  // spec §3 state effects: shaken accuracy x0.7, berserk x1.2 (and ignores suppression, handled
  // by the caller bypassing the suppression fire-rate throttle for berserk soldiers).
  const stateTerm = mindState === 'shaken' ? 0.7 : mindState === 'berserk' || shooter.activity === 'berserk' ? 1.2 : 1;
  // first-fire shock (spec §11): a green soldier fires wildly once shaken by it.
  const wildFireTerm = mindState === 'shaken' && shooter.experience < 30 ? 0.5 : 1;
  return suppressionTerm * expTerm * fatigueTerm * stateTerm * wildFireTerm;
}

/** Expectation of `penetrates()` (spec §10 "danger"): probability the round beats the armour,
 * derived from the same pen*(1+gauss()*0.12) > armour model via the normal CDF. */
export function expectedPenetrationChance(weapon: WeaponDef, distM: number, armorMm: number): number {
  if (weapon.penetrationMm <= 0) return 0;
  const pen = weapon.penetrationMm * Math.max(0.4, 1 - distM / 1000);
  if (pen <= 0) return 0;
  const z = (armorMm / pen - 1) / 0.12;
  return clamp(1 - normalCdf(z), 0, 1);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * hitChance = acc * rangeFactor * (1 - cover*0.8) * stanceFactor * shooterFactor
 *   * (targetMoving ? 0.6 : 1) * (shooter moving/movingFast ? 0.4 : 1), clamped 0.02..0.95.
 */
export function hitChance(
  weapon: WeaponDef,
  distM: number,
  targetCover: number,
  targetStance: Stance,
  shooter: Soldier,
  targetMoving: boolean,
): number {
  const rf = rangeFactor(weapon, distM);
  if (rf <= 0) return 0;
  const coverTerm = 1 - targetCover * 0.8;
  const st = stanceFactor(targetStance);
  const sf = shooterFactor(shooter);
  const movingTargetTerm = targetMoving ? 0.6 : 1;
  // Balance fix (suspect b follow-up): 'movingFast' shooters never reach this function at all
  // (pickTarget returns null for that activity), so this penalty only ever hits 'moving' soldiers —
  // the attacker's normal advance-under-fire state. 0.4 made their return fire close to
  // decorative; loosened to 0.6 so advancing infantry can still meaningfully threaten a defender,
  // not just soak up the defender's free fire.
  const movingShooterTerm = shooter.activity === 'moving' || shooter.activity === 'movingFast' ? 0.6 : 1;
  const p = weapon.accuracy * rf * coverTerm * st * sf * movingTargetTerm * movingShooterTerm;
  // Balance fix (suspect a): directional cover (up to ~0.85-1.0) stacked with prone (x0.45) and the
  // suppression/experience shooterFactor could push p toward the 0.02 global floor at almost any
  // range <=100m, making dug-in defenders effectively untouchable and stalling the attacker's whole
  // suppression/attrition loop. Floor close-range hit chance at 25% of raw accuracy*rangeFactor
  // (ignoring cover/stance/shooter-state reductions) so a defender in the best cover is still hittable
  // at a meaningful rate, while cover/stance/suppression still matter well above that floor.
  const closeFloor = distM <= 100 ? weapon.accuracy * rf * 0.25 : 0;
  return clamp(Math.max(p, closeFloor), 0.02, 0.95);
}

/** pen = penetrationMm * max(0.4, 1 - dist/1000); spread = gauss()*0.12; penetrates if pen*(1+spread) > armorMm. */
export function penetrates(weapon: WeaponDef, distM: number, armorMm: number, rng: Rng): boolean {
  const pen = weapon.penetrationMm * Math.max(0.4, 1 - distM / 1000);
  const spread = rng.gauss() * 0.12;
  return pen * (1 + spread) > armorMm;
}

export type ArmorFacing = 'front' | 'side' | 'rear';

/** Angle between hull facing and direction to the shooter -> front (+/-60deg), rear (+/-45deg behind), else side. */
export function armorFacingFor(vehicle: Vehicle, shooterPos: Vec2): ArmorFacing {
  const angleToShooter = angleTo(vehicle.pos, shooterPos);
  const diff = Math.abs(wrapAngle(angleToShooter - vehicle.hullFacing));
  if (diff <= DEG60) return 'front';
  if (diff >= DEG135) return 'rear';
  return 'side';
}

/** Called once a hit has already been determined. Rolls lethality to decide the outcome. */
export function damageRoll(weapon: WeaponDef, cover: number, rng: Rng): Health | null {
  const lethal = weapon.lethality * (1 - cover * 0.5);
  if (rng.chance(lethal)) {
    return rng.chance(0.6) ? 'dead' : 'incapacitated';
  }
  return 'wounded';
}
