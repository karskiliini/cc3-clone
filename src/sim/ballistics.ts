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
  const berserkTerm = shooter.activity === 'berserk' ? 1.2 : 1;
  return suppressionTerm * expTerm * fatigueTerm * berserkTerm;
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
  const movingShooterTerm = shooter.activity === 'moving' || shooter.activity === 'movingFast' ? 0.4 : 1;
  const p = weapon.accuracy * rf * coverTerm * st * sf * movingTargetTerm * movingShooterTerm;
  return clamp(p, 0.02, 0.95);
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
