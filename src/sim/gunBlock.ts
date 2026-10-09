// ============================================================================
// Why a vehicle's main gun cannot engage a target, or null when it can. One rule for the sim and
// for the player: the crew obeys it, the order report, the team's status word and the target
// cursor all say it (item: "show the reasoning"). Laying, loading, waiting for a flank or driving
// to a firing spot are work in progress, not reasons — only what the crew cannot overcome here.
// ============================================================================
import type { BattleState, Order, Vec2, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { angleTo, dist, wrapAngle } from '@/shared/math';
import { crewEffects, isImmobile, mainGunUsable, SIGHT_DESTROYED_MAX_M, systemState, turretFrozen } from './vehicleDamage';
import { gunArcRad } from './gunTiming';

export type GunBlock = 'gunDestroyed' | 'noGunner' | 'sightOut' | 'noAmmo' | 'outOfRange' | 'cantBear';

/** A gun fixed in a jammed turret still bears this far either side of where it points. */
const FROZEN_ARC_RAD = (3 * Math.PI) / 180;

export function mainGunBlock(state: BattleState, v: Vehicle, target: Vec2): GunBlock | null {
  const def = VEHICLE_DEFS[v.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  if (!def || !weapon || !mainGunUsable(v)) return 'gunDestroyed';
  if (!crewEffects(state, v).gunner) return 'noGunner';
  if (v.mainAmmo <= 0 && !v.loadedRound) return 'noAmmo';
  const distM = dist(v.pos, target) * TILE_M;
  if (distM > weapon.rangeM) return 'outOfRange';
  if (systemState(v, 'sight') === 'destroyed' && distM > SIGHT_DESTROYED_MAX_M) return 'sightOut';
  if (isImmobile(v)) {
    const bearing = angleTo(v.pos, target);
    const frozen = def.hasTurret && turretFrozen(v);
    const off = Math.abs(wrapAngle(bearing - (frozen ? v.turretFacing : v.hullFacing)));
    if (frozen ? off > FROZEN_ARC_RAD : !def.hasTurret && off > gunArcRad(def)) return 'cantBear';
  }
  return null;
}

/** Why a vehicle cannot fire on the target of its Fire order (the hull it was set on, else the
 * ordered point), or null. */
export function orderedGunBlock(state: BattleState, vehicle: Vehicle, order: Order): GunBlock | null {
  const hull = order.targetVehicleId != null ? state.vehicles.get(order.targetVehicleId) : undefined;
  return mainGunBlock(state, vehicle, hull ? hull.pos : order.target);
}

const TEXT: Record<GunBlock, string> = {
  gunDestroyed: 'main gun destroyed',
  noGunner: 'no one to man the gun',
  sightOut: `sight destroyed: ${SIGHT_DESTROYED_MAX_M} m max`,
  noAmmo: 'out of ammunition',
  outOfRange: 'out of range',
  cantBear: "immobilised: gun can't bear",
};
export function gunBlockText(b: GunBlock): string { return TEXT[b]; }
