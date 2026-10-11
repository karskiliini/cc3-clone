import { crewEffects } from './vehicleDamage';
import { chooseAimPointAt, gunnerSkill, splitRounds } from './aimPoint';
import type { BattleState, Order, Soldier, Vec2, Vehicle, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { angleTo, dist } from '@/shared/math';
import { coverFrom, omniCoverAt } from './cover';
import { tileAt } from './map';
import { hasLOS } from './los';
import { attackPhase } from './orders';
import { behindGunShield } from './crewWeapon';
import { bowMgUsable, coaxUsable } from './vehicleDamage';
import { gunTarget, vehicleAimTarget, vehicleGunRay, type GunTarget } from './hullAim';

export type VehicleGunTarget =
  | { kind: 'soldier'; soldier: Soldier }
  | { kind: 'vehicle'; vehicle: Vehicle }
  | { kind: 'point'; pos: Vec2 };

export const BOW_MG_AMMO = 250;

export function exposureScore(state: BattleState, shooterPos: Vec2, victim: Soldier): number {
  const cover = coverFrom(state.map, victim.pos, angleTo(victim.pos, shooterPos));
  const st = victim.stance === 'standing' ? 1 : victim.stance === 'crouching' ? 0.7 : 0.45;
  const moving = victim.activity === 'moving' || victim.activity === 'movingFast' || victim.activity === 'sneaking';
  const dM = dist(shooterPos, victim.pos) * TILE_M;
  return (1 - cover * 0.8) * st * (moving ? 1.2 : 1) / (1 + dM / 100);
}

/** Main-gun HE is for real infantry targets, not for one man: a tank's machine guns (coax, bow)
 * engage infantry first; the main gun joins only for (a) a GROUP — several spotted men of the
 * same team clustered within GROUP_RADIUS_TILES of one another — (b) both MGs out of usable
 * ammo, or (c) the MGs not doing the job: the team not pinned after MG_ESCALATE_S (5 s when the
 * man is close enough to hurt the tank), or pinned but still there after MG_ESCALATE_PINNED_S.
 * Men in strong cover (trench, stone building, bunker interior: omni cover >= STRONG_COVER) are
 * not worth main-gun HE as a mere group, only through (b)/(c). AP is never chosen against infantry (aimPoint.ts already routes soft
 * targets to HE; the gates here keep a lone rifleman from even being laid on). */
export const MG_GROUP_MIN = 3;
export const MG_GROUP_RADIUS_TILES = 6;
/** Trench/bunker/stone-building strength: at or above this omni cover, main-gun HE is wasted. */
export const MG_STRONG_COVER = 0.8;
/** An MG engagement unresolved (the team not pinned) for this long unlocks the main gun: one man
 * must not hold a tank up — standing still is dangerous for the tank itself. */
export const MG_ESCALATE_S = 12;
/** A man this close (an AT grenade's or a Panzerfaust's reach) gets the HE much sooner. */
export const MG_CLOSE_M = 40;
export const MG_ESCALATE_CLOSE_S = 5;
/** Pinned is not done: men the MGs keep down but cannot finish (a trench, a stone house) get the
 * HE after this long anyway. */
export const MG_ESCALATE_PINNED_S = 25;
/** Pinned: suppression at or above this stops the escalation clock (the MGs did their job). */
export const MG_SUPPRESS_LEVEL = 60;

/** Why the main gun may (or may not) fire at an infantryman. */
export function mainGunAtInfantry(state: BattleState, vehicle: Vehicle, s: Soldier): 'group' | 'mgOut' | 'escalated' | null {
  const def = VEHICLE_DEFS[vehicle.defId];
  // MGs "unusable" covers damage, not just ammo: a destroyed coax mount or a destroyed bow mount
  // both leave the vehicle MG-less (vehicleDamage.ts systemState)
  const mgOut = (!def?.coaxWeaponId || vehicle.coaxAmmo <= 0 || !coaxUsable(vehicle))
    && (!def?.bowWeaponId || (vehicle.bowAmmo ?? BOW_MG_AMMO) <= 0 || !bowMgUsable(vehicle));
  if (mgOut) return 'mgOut';
  // Strong cover for the doctrine: omni cover (trench, bunker interior, stone-building floor) OR
  // the tile is a stone building (the 0.85 value is directional/linear cover only, omniCoverAt
  // sees 0.5) OR the man stands behind an AT gun's shield plate (a casemate crewman).
  const strongCover = omniCoverAt(state.map, s.pos) >= MG_STRONG_COVER
    || tileAt(state.map, Math.floor(s.pos.x), Math.floor(s.pos.y)) === 'buildingStone'
    || behindGunShield(state, s, vehicle.pos);
  // group (not worth it against men in strong cover until the MGs have shown they can't do the job): several spotted living men of this team within GROUP_RADIUS_TILES of the target man
  const team = state.teams.get(s.teamId);
  if (team) {
    let clustered = 0;
    for (const id of team.soldierIds) {
      const m = state.soldiers.get(id);
      if (!m || m.health === 'dead' || m.health === 'incapacitated' || m.activity === 'surrendered') continue;
      if (!state.spotted[vehicle.side].has(id)) continue;
      if (dist(m.pos, s.pos) <= MG_GROUP_RADIUS_TILES) clustered++;
    }
    if (clustered >= MG_GROUP_MIN && !strongCover) return 'group';
  }
  // escalation: the machine guns have worked this team for MG_ESCALATE_S and it is still not pinned
  // (quickly when he is close enough to hurt the tank), or has pinned it but not finished it
  const close = dist(vehicle.pos, s.pos) * TILE_M <= MG_CLOSE_M;
  const engagedS = vehicle.mgTargetKey === `t${s.teamId}` && vehicle.mgSince != null ? state.time - vehicle.mgSince : 0;
  if (engagedS >= MG_ESCALATE_PINNED_S) return 'escalated';
  if (engagedS >= (close ? MG_ESCALATE_CLOSE_S : MG_ESCALATE_S)) {
    let bestSupp = 0;
    if (team) {
      for (const id of team.soldierIds) {
        const m = state.soldiers.get(id);
        if (!m || m.health === 'dead' || m.health === 'incapacitated' || m.activity === 'surrendered') continue;
        if (!state.spotted[vehicle.side].has(id)) continue;
        bestSupp = Math.max(bestSupp, m.suppression);
      }
    }
    if (bestSupp < MG_SUPPRESS_LEVEL) return 'escalated';
  }
  return null;
}

/** Main-gun target for a vehicle on an attack-unit Fire order: AP at the target vehicle, HE at the
 * best visible member of a target infantry team, HE on the tracked/last known position otherwise. */
export function pickVehicleAttackTarget(state: BattleState, vehicle: Vehicle, weapon: WeaponDef | null, order: Order): VehicleGunTarget | null | 'free' | 'mg' {
  const phase = attackPhase(state, order);
  if (phase === 'hold') return 'free';
  const tgt = state.teams.get(order.targetTeamId!);
  if (!tgt) return 'free';
  const rangeM = weapon ? weapon.rangeM : 400;
  if (phase === 'tracking') {
    if (tgt.vehicleId != null) {
      const v = state.vehicles.get(tgt.vehicleId);
      // item 038: the target may have ducked behind a bank or driven out of sight since the order
      // was issued; the gun keeps pointing at the ordered (last-known) point instead of going
      // silent — when it re-spots, the vehicle branch takes over again.
      if (v && v.state !== 'knockedOut' && state.spottedVehicles[vehicle.side].has(v.id) && dist(vehicle.pos, v.pos) * TILE_M <= rangeM) return { kind: 'vehicle', vehicle: v };
    }
    let best: Soldier | null = null;
    let bestScore = -Infinity;
    for (const id of tgt.soldierIds) {
      if (!state.spotted[vehicle.side].has(id)) continue;
      const e = state.soldiers.get(id);
      if (!e || e.health === 'dead' || e.health === 'incapacitated' || e.activity === 'surrendered') continue;
      if (dist(vehicle.pos, e.pos) * TILE_M > rangeM || !hasLOS(state.map, vehicle.pos, e.pos)) continue;
      const sc = exposureScore(state, vehicle.pos, e);
      if (sc > bestScore) { bestScore = sc; best = e; }
    }
    if (best) {
      // an ordered attack on infantry follows the same doctrine as free fire: the machine guns
      // mow the men; the main gun's HE joins for a real group, when the MGs are out, or when their
      // fire has not pinned the team (mainGunAtInfantry). Otherwise the gun stays silent and the
      // coax (pickCoaxTarget: the ordered team first) brings the turret round.
      if (!weapon || mainGunAtInfantry(state, vehicle, best)) return { kind: 'soldier', soldier: best };
      return 'mg';
    }
  }
  if (weapon && weapon.heRadiusM > 0 && dist(vehicle.pos, order.target) * TILE_M <= rangeM) return { kind: 'point', pos: order.target };
  return null;
}

/** Resolve only this order's main-gun target, never an unrelated free-fire target. Live
 * positions are eligible only through the firing vehicle's side and observer/range policy. */
export function orderedVehicleGunTarget(state: BattleState, vehicle: Vehicle, order: Order): VehicleGunTarget | null {
  const def = VEHICLE_DEFS[vehicle.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
  if (order.targetTeamId != null) {
    const target = pickVehicleAttackTarget(state, vehicle, weapon, order);
    return target === 'free' || target === 'mg' ? null : target;
  }
  // Legacy direct vehicle-id previews without a team id still obey side visibility.
  if (order.targetVehicleId != null && state.spottedVehicles[vehicle.side].has(order.targetVehicleId)) {
    const target = state.vehicles.get(order.targetVehicleId);
    if (target && target.state !== 'knockedOut') return { kind: 'vehicle', vehicle: target };
  }
  return { kind: 'point', pos: order.target };
}

/** Diagnostic geometry for this order. A null picker result means impossible ordered fire,
 * so report against its known point; it does not make that point a combat target. Hold/free
 * and MG-only outcomes deliberately have no main-gun diagnostic. */
export function orderedGunDiagnosticTarget(state: BattleState, vehicle: Vehicle, order: Order): GunTarget | null {
  if (order.targetTeamId != null) {
    const def = VEHICLE_DEFS[vehicle.defId];
    const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
    const target = pickVehicleAttackTarget(state, vehicle, weapon, order);
    if (target === 'free' || target === 'mg') return null;
    return resolvedGunTarget(state, target ?? { kind: 'point', pos: order.target }, vehicle);
  }
  const target = orderedVehicleGunTarget(state, vehicle, order);
  return target ? resolvedGunTarget(state, target, vehicle) : null;
}

export function resolvedGunTarget(state: BattleState, target: VehicleGunTarget, shooter?: Vehicle): GunTarget {
  switch (target.kind) {
    case 'vehicle': {
      const mass = gunTarget(state, target.vehicle.pos, target.vehicle);
      const def = shooter ? VEHICLE_DEFS[shooter.defId] : undefined;
      const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
      const gunner = shooter ? crewEffects(state, shooter).gunner : undefined;
      if (!shooter || !def || !weapon || !gunner) return mass;
      const ray = vehicleGunRay(state, shooter, def, mass);
      const counts = shooter.rounds ? { ...shooter.rounds } : splitRounds(weapon, shooter.mainAmmo, state.config.year);
      if (shooter.loadedRound) counts[shooter.loadedRound]++;
      const choice = chooseAimPointAt(state, weapon, weapon.rounds ? counts : null, gunnerSkill(gunner), ray.from, target.vehicle, ray.origin);
      return vehicleAimTarget(state, target.vehicle, VEHICLE_DEFS[target.vehicle.defId], choice.aimPoint, ray.origin);
    }
    case 'soldier': return gunTarget(state, target.soldier.pos, undefined, target.soldier);
    case 'point': return gunTarget(state, target.pos);
  }
}
