import type { BattleState, Team, Order, Soldier, Vec2 } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist, facingTo, vadd, vnorm, vscale, vsub } from '@/shared/math';
import { findPath } from './path';
import { teamHasSmoke } from './team';

const INCAPABLE_ACTIVITIES = new Set(['pinned', 'cowering', 'panicked', 'routed', 'surrendered']);

function canObey(s: Soldier): boolean {
  if (s.health === 'dead' || s.health === 'incapacitated') return false;
  return !INCAPABLE_ACTIVITIES.has(s.activity);
}

function stopSoldier(s: Soldier): void {
  s.path = [];
}

/** Validate and apply an order to a team: sets team.order, computes paths, and updates each
 * soldier's (or the team's vehicle's) activity/stance/facing per spec §6.3. */
export function applyOrder(state: BattleState, team: Team, order: Order, rng: Rng): void {
  if (team.outOfAction) return;

  const isVehicleTeam = team.vehicleId != null;
  let type = order.type;
  if (isVehicleTeam && (type === 'sneak' || type === 'moveFast')) type = 'move';

  team.order = order;

  if (type === 'fire' || type === 'defend' || type === 'ambush') {
    team.facing = facingTo(team.pos, order.target);
  }

  const vehicle = isVehicleTeam ? state.vehicles.get(team.vehicleId!) : undefined;

  if (type === 'move' || type === 'moveFast' || type === 'sneak') {
    const activity = type === 'move' ? 'moving' : type === 'moveFast' ? 'movingFast' : 'sneaking';
    const stance = type === 'sneak' ? 'prone' : 'standing';

    if (isVehicleTeam) {
      if (vehicle) {
        vehicle.path = findPath(state.map, vehicle.pos, order.target, 'vehicle');
      }
      for (const sid of team.soldierIds) {
        const s = state.soldiers.get(sid);
        if (s && canObey(s)) s.activity = activity === 'sneaking' ? 'moving' : (activity as Soldier['activity']);
      }
      return;
    }

    const leader = state.soldiers.get(team.leaderId);
    const leaderPath = leader ? findPath(state.map, leader.pos, order.target, 'infantry') : [];
    for (const sid of team.soldierIds) {
      const s = state.soldiers.get(sid);
      if (!s || !canObey(s)) continue;
      let path: Vec2[];
      if (s.id === team.leaderId) {
        path = leaderPath;
      } else {
        const offsetTarget = vadd(order.target, s.formationOffset);
        path = findPath(state.map, s.pos, offsetTarget, 'infantry');
        if (path.length === 0) path = findPath(state.map, s.pos, order.target, 'infantry');
      }
      s.path = path;
      s.activity = activity as Soldier['activity'];
      s.stance = stance;
    }
    return;
  }

  if (type === 'fire') {
    let targetTeamId: number | undefined;
    for (const other of state.teams.values()) {
      if (other.side === team.side || other.outOfAction) continue;
      const spottedSet = state.spotted[team.side];
      const spottedHere = other.soldierIds.some((id) => spottedSet.has(id));
      if (!spottedHere) continue;
      if (dist(other.pos, order.target) <= 1.5) { targetTeamId = other.id; break; }
    }
    if (targetTeamId != null) order.targetTeamId = targetTeamId;

    if (isVehicleTeam) {
      if (vehicle) {
        vehicle.path = [];
        vehicle.targetPoint = order.target;
        vehicle.targetVehicleId = null;
        vehicle.targetSoldierId = null;
      }
      for (const sid of team.soldierIds) {
        const s = state.soldiers.get(sid);
        if (s && canObey(s)) s.activity = 'firing';
      }
      return;
    }

    for (const sid of team.soldierIds) {
      const s = state.soldiers.get(sid);
      if (!s || !canObey(s)) continue;
      stopSoldier(s);
      s.activity = 'firing';
      s.targetPoint = order.target;
      s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
    }
    return;
  }

  if (type === 'smoke') {
    if (isVehicleTeam) {
      if (vehicle) {
        vehicle.path = [];
        vehicle.targetPoint = order.target;
      }
      for (const sid of team.soldierIds) {
        const s = state.soldiers.get(sid);
        if (s && canObey(s)) s.activity = 'firing';
      }
      return;
    }
    if (team.type === 'mortar') {
      for (const sid of team.soldierIds) {
        const s = state.soldiers.get(sid);
        if (!s || !canObey(s)) continue;
        stopSoldier(s);
        s.activity = 'firing';
        s.targetPoint = order.target;
      }
      return;
    }
    if (teamHasSmoke(state, team)) {
      const rangeTiles = 30 / 2; // 30 m in tiles
      const d = dist(team.pos, order.target);
      for (const sid of team.soldierIds) {
        const s = state.soldiers.get(sid);
        if (!s || !canObey(s)) continue;
        if (d <= rangeTiles) {
          stopSoldier(s);
          s.activity = 'firing';
          s.targetPoint = order.target;
          s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
        } else {
          const dir = vnorm(vsub(order.target, team.pos));
          const shortM = 25 / 2;
          const approach = vadd(team.pos, vscale(dir, Math.max(0, d - shortM)));
          s.path = findPath(state.map, s.pos, vadd(approach, s.formationOffset), 'infantry');
          s.activity = 'moving';
          s.stance = 'standing';
          s.targetPoint = order.target;
        }
      }
    }
    return;
  }

  if (type === 'defend') {
    if (isVehicleTeam) {
      if (vehicle) vehicle.path = [];
      for (const sid of team.soldierIds) {
        const s = state.soldiers.get(sid);
        if (s && canObey(s)) s.activity = 'defending';
      }
      return;
    }
    for (const sid of team.soldierIds) {
      const s = state.soldiers.get(sid);
      if (!s || !canObey(s)) continue;
      stopSoldier(s);
      s.activity = 'defending';
      s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
    }
    return;
  }

  if (type === 'ambush') {
    if (isVehicleTeam) {
      if (vehicle) vehicle.path = [];
      for (const sid of team.soldierIds) {
        const s = state.soldiers.get(sid);
        if (s && canObey(s)) s.activity = 'ambushing';
      }
      return;
    }
    for (const sid of team.soldierIds) {
      const s = state.soldiers.get(sid);
      if (!s || !canObey(s)) continue;
      stopSoldier(s);
      s.activity = 'ambushing';
      s.stance = 'prone';
    }
    return;
  }
}
