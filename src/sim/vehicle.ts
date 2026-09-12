import type { BattleState, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, dist, turnTowards, vadd, vnorm, vscale, vsub, wrapAngle } from '@/shared/math';
import { idx, setTile, tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';
import { VEHICLE_DEFS } from '@/data/units';

const HEADING_ALIGN_RAD = 0.35;
const BURN_TO_KO_S = 30;

/** Turns hulls/turrets towards targets or waypoints, drives vehicles, crushes crushable
 * terrain, and progresses burning vehicles towards knocked-out. */
export function stepVehicles(state: BattleState, rng: Rng, dt: number): void {
  const map = state.map;
  for (const v of state.vehicles.values()) {
    if (v.state === 'burning') {
      v.burnTimer += dt;
      if (v.burnTimer >= BURN_TO_KO_S) v.state = 'knockedOut';
    }

    const def = VEHICLE_DEFS[v.defId];
    if (!def) continue;

    let targetPos: Vec2 | null = null;
    if (v.targetSoldierId != null) {
      const t = state.soldiers.get(v.targetSoldierId);
      if (t) targetPos = t.pos;
    } else if (v.targetVehicleId != null) {
      const t = state.vehicles.get(v.targetVehicleId);
      if (t) targetPos = t.pos;
    } else if (v.targetPoint) {
      targetPos = v.targetPoint;
    }

    if (v.state === 'knockedOut' || v.state === 'abandoned') continue;

    if (def.hasTurret) {
      const turretTargetAngle = targetPos ? angleTo(v.pos, targetPos) : v.hullFacing;
      v.turretFacing = turnTowards(v.turretFacing, turretTargetAngle, def.turnRateRad * 2 * dt);
    } else {
      v.turretFacing = v.hullFacing;
    }

    if (v.path.length === 0 || v.state === 'immobilized') {
      v.speed = 0;
      continue;
    }

    const wp = v.path[0];
    const desired = angleTo(v.pos, wp);
    v.hullFacing = turnTowards(v.hullFacing, desired, def.turnRateRad * dt);
    const aligned = Math.abs(wrapAngle(desired - v.hullFacing)) <= HEADING_ALIGN_RAD;

    if (!aligned) {
      v.speed = 0;
      continue;
    }

    const tx = Math.floor(v.pos.x), ty = Math.floor(v.pos.y);
    const tile = tileAt(map, tx, ty);
    const props = TERRAIN_PROPS[tile];
    const onRoad = tile === 'dirtroad' || tile === 'pavedroad' || tile === 'bridge';
    const baseSpeed = onRoad ? def.speedRoadMs : def.speedOffroadMs;
    const speedMs = onRoad ? baseSpeed : baseSpeed * props.speedMul;
    v.speed = speedMs;

    const distTiles = (speedMs * dt) / TILE_M;
    const d = dist(v.pos, wp);
    if (d <= distTiles || d < 1e-4) {
      v.pos = { x: wp.x, y: wp.y };
      v.path.shift();
    } else {
      const dir = vnorm(vsub(wp, v.pos));
      v.pos = vadd(v.pos, vscale(dir, distTiles));
    }

    if (props.crushable) {
      setTile(map, tx, ty, 'open');
      if (!map.dirtyTiles) map.dirtyTiles = [];
      map.dirtyTiles.push(idx(map, tx, ty));
    }
  }
}
