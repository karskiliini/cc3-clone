import { tryRemountOrder } from './vehicleCrew';
import { transportOrderHook } from './transport';
import type { BattleState, Team, Order, Side, Soldier, Vec2 } from '@/shared/types';
import { TILE_M, otherSide } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { addMessage } from './messages';
import type { Rng } from '@/shared/rng';
import { clamp, dist, facingTo, vadd, vnorm, vscale, vsub } from '@/shared/math';
import { findPath, isPassable, type TileCostFn } from './path';
import { fireHazards, nearFireHazard } from './vehicleExplosion';
import { teamHasSmoke } from './team';
import { isFirstFireFrozen, isLeaderless } from './mind';
import { angleTo } from '@/shared/math';
import { formationBaseHeading, rotateOffset } from './spawn';
import { settleTile } from './coverSeek';
import { isDazed } from './daze';
import { onCrewOrder } from './crewWeapon';
import { RADIO_OUT_ORDER_DELAY_S, radioOut } from './vehicleDamage';

const INCAPABLE_ACTIVITIES = new Set(['pinned', 'cowering', 'panicked', 'routed', 'surrendered']);

/** Obedience probability (spec §4): clamp(0.5 + motivation/200 + experience/400 - fear/150), with a
 * `brave` bonus and a "who's in charge?" penalty while the team has no living leader (spec §11). On
 * success, sets `mind.anchor` to the ordered position (used by coverSeek.ts). On failure, the
 * soldier hesitates 1-3 s before he would retry.
 *
 * Balance regression fix: fear/150 alone can crush p to near 0.02 for a soldier under the
 * sustained fire that's normal for the whole span of an assault — combined with hesitation
 * lasting up to 5s and orders only being re-rolled when the AI actually reissues one, this could
 * leave an attacker's soldiers failing to obey moveFast/fire/defend for most of an approach,
 * collapsing attacker shot volume to a fraction of the defender's (harness: attacker win rate
 * 41%->0%). Floor raised from 0.02 to 0.15 and hesitation capped at 1-3s uniformly (previously
 * 2-5s for low-experience troops) so a scared soldier is still slow to respond, never permanently
 * frozen. */
function canObey(state: BattleState, rng: Rng, s: Soldier, team: Team, target: Vec2): boolean {
  if (s.health === 'dead' || s.health === 'incapacitated') return false;
  const issuedAt = team.order?.issuedAt ?? 0;
  // Any refusal by a living soldier leaves the order pending; mind.ts retries it once hesitation
  // has run out (and the order has not been replaced), so a failed roll is never permanent.
  // A man dazed by a blast (sim/daze.ts) takes no order either; it stays pending the same way and
  // he picks it up when his head clears.
  if (INCAPABLE_ACTIVITIES.has(s.activity) || isFirstFireFrozen(state, s.id) || s.mind.hesitation > 0 || isDazed(s, state.time)) {
    s.mind.pendingOrderAt = issuedAt;
    return false;
  }

  let p = 0.5 + s.mind.motivation / 200 + s.experience / 400 - s.mind.fear / 150;
  if (s.mind.trait === 'brave') p += 0.15;
  if (isLeaderless(state, team)) p -= 0.2;
  p = clamp(p, 0.15, 0.98);

  if (!rng.chance(p)) {
    s.mind.hesitation = rng.range(1, 3);
    s.mind.pendingOrderAt = issuedAt;
    return false;
  }
  s.mind.pendingOrderAt = undefined;
  s.mind.anchor = { ...target };
  return true;
}

function stopSoldier(s: Soldier): void {
  s.path = [];
}

type OrderKind = Order['type'];

function effectiveType(team: Team, order: Order): OrderKind {
  if (team.vehicleId != null && (order.type === 'sneak' || order.type === 'moveFast')) return 'move';
  return order.type;
}

// ------------------------------------------------------------------ formation geometry
/** Radius (tiles) around a soldier's formation slot in which he settles onto the best cover tile. */
const SETTLE_RADIUS = 2;
/** Per-axis cap on a follower's wandering drift while moving (slot + drift stays within ~4 tiles). */
const DRIFT_MAX = 1.8;

/** Direction of travel for each move order, fixed when the order is first applied so hesitant
 * soldiers who obey later rotate the formation the same way. */
const orderHeading = new WeakMap<Order, number>();
/** Destination tiles already claimed under an order (soldier id -> tile index): no two teammates
 * settle onto the same tile. */
const orderClaims = new WeakMap<Order, Map<number, number>>();

function headingFor(state: BattleState, team: Team, order: Order): number {
  const known = orderHeading.get(order);
  if (known != null) return known;
  const leader = state.soldiers.get(team.leaderId);
  const wps = order.waypoints;
  // with waypoints, the formation (and a following Defend/Ambush) faces along the LAST leg
  const from = wps && wps.length > 0 ? wps[wps.length - 1]
    : leader && leader.health !== 'dead' && leader.health !== 'incapacitated' ? leader.pos : team.pos;
  const h = dist(from, order.target) > 0.5 ? angleTo(from, order.target) : formationBaseHeading(state.map, team.side);
  orderHeading.set(order, h);
  return h;
}

/** A soldier's formation offset rotated so the formation's front faces the order's direction of
 * travel (wedge point forward, skirmish line perpendicular). Stored offsets are baked at the deploy
 * heading, so the rotation is by the difference. */
export function orderSlotOffset(state: BattleState, team: Team, s: Soldier, order: Order): Vec2 {
  return rotateOffset(s.formationOffset, headingFor(state, team, order) - formationBaseHeading(state.map, team.side));
}

// ------------------------------------------------------------------ waypoints
/** Move/MoveFast/Sneak: the points still to visit, in order — remaining waypoints, then the target. */
export function orderRoutePoints(order: Order): Vec2[] {
  return order.waypoints && order.waypoints.length > 0 ? [...order.waypoints, order.target] : [order.target];
}

/** Per-point heading (radians) of the leg each point of a routed path belongs to. */
const pathLegHeadings = new WeakMap<Vec2[], number[]>();

/** Path cost added per tile within FIRE_HAZARD_M of a burning vehicle: enough that a route bends
 * up to ~100 m out of its way round the fire, but still a cost — with no way round, it goes through. */
export const FIRE_HAZARD_PATH_COST = 4;

/** The extra path cost for routes while something burns, or undefined when nothing does (the usual
 * case: findPath then runs exactly as before). Men on foot and open-topped vehicles (halftracks)
 * keep clear of a hulk that may cook off; closed-up armour does not care. */
export function fireHazardCost(state: BattleState, mover: 'infantry' | 'vehicle', softVehicle = false): TileCostFn | undefined {
  if (mover === 'vehicle' && !softVehicle) return undefined;
  const hazards = fireHazards(state);
  if (hazards.length === 0) return undefined;
  const p = { x: 0, y: 0 };
  return (x, y) => { p.x = x + 0.5; p.y = y + 0.5; return nearFireHazard(hazards, p) ? FIRE_HAZARD_PATH_COST : 0; };
}

/** A* path from `from` through each of `points` in turn. Burning vehicles are gone round
 * (`fireHazardCost`; `softVehicle`: an open-topped vehicle, which avoids them like infantry).
 * An unreachable intermediate point is
 * skipped (the route goes on to the next one). Records per-point leg headings for followers. */
export function routeVia(state: BattleState, from: Vec2, points: readonly Vec2[], mover: 'infantry' | 'vehicle', softVehicle = false): Vec2[] {
  const hazardCost = fireHazardCost(state, mover, softVehicle);
  if (points.length === 1) {
    const path = findPath(state.map, from, points[0], mover, undefined, hazardCost);
    if (path.length > 0) pathLegHeadings.set(path, new Array(path.length).fill(dist(from, points[0]) > 1e-6 ? angleTo(from, points[0]) : 0));
    return path;
  }
  let path: Vec2[] = [];
  const headings: number[] = [];
  let cur = from;
  for (const p of points) {
    const leg = findPath(state.map, cur, p, mover, undefined, hazardCost);
    if (leg.length === 0) continue;
    const h = dist(cur, p) > 1e-6 ? angleTo(cur, p) : (headings.length ? headings[headings.length - 1] : 0);
    path = path.concat(leg);
    for (let i = 0; i < leg.length; i++) headings.push(h);
    cur = leg[leg.length - 1];
  }
  pathLegHeadings.set(path, headings);
  return path;
}

/** Waypoint reached radius (tiles). */
export const WAYPOINT_REACHED_TILES = 2;

/** Per sim step: drop waypoints the team has reached (leader, or its vehicle, within
 * WAYPOINT_REACHED_TILES), so `order.waypoints` always holds only the points still ahead. */
export function stepOrderWaypoints(state: BattleState): void {
  for (const team of state.teams.values()) {
    const order = team.order;
    const wps = order?.waypoints;
    if (!order || !wps || wps.length === 0) continue;
    if (order.type !== 'move' && order.type !== 'moveFast' && order.type !== 'sneak') continue;
    let ref: Vec2 = team.pos;
    let route: Vec2[] | null = null;
    if (team.vehicleId != null) {
      const v = state.vehicles.get(team.vehicleId);
      if (v) { ref = v.pos; route = v.path; }
    } else {
      const leader = state.soldiers.get(team.leaderId);
      if (leader && leader.health !== 'dead' && leader.health !== 'incapacitated') { ref = leader.pos; route = leader.path; }
    }
    while (wps.length > 0 && dist(ref, wps[0]) <= WAYPOINT_REACHED_TILES) wps.shift();
    // a leg the path had to skip (unreachable waypoint): once the route no longer comes near it, drop it
    if (wps.length > 0 && route && route.length > 0 && state.time - order.issuedAt > 1) {
      const w = wps[0];
      if (!route.some((p) => dist(p, w) <= WAYPOINT_REACHED_TILES + 1)) wps.shift();
    }
  }
}

/** Whether a team's order still has something to show: Fire/Smoke/Defend/Ambush while they stand;
 * a move order while anyone of the team is still on the way (or yet to obey it). */
export function isOrderActive(state: BattleState, team: Team): boolean {
  const order = team.order;
  if (!order || team.outOfAction) return false;
  if (order.type !== 'move' && order.type !== 'moveFast' && order.type !== 'sneak') return true;
  if (state.time - order.issuedAt < 0.5) return true;
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    return !!v && v.path.length > 0;
  }
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    if (s.path.length > 0 || s.mind?.pendingOrderAt === order.issuedAt) return true;
  }
  return false;
}

const tileEq = (a: Vec2, b: Vec2) => Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y);

/** The soldier's rotated slot at the order target, settled onto the best directional cover tile
 * within SETTLE_RADIUS that no teammate has claimed. */
function destinationFor(state: BattleState, team: Team, s: Soldier, order: Order, slotOffset: Vec2): Vec2 {
  const map = state.map;
  const slot = {
    x: clamp(order.target.x + slotOffset.x, 0.5, map.width - 0.5),
    y: clamp(order.target.y + slotOffset.y, 0.5, map.height - 0.5),
  };
  let claims = orderClaims.get(order);
  if (!claims) { claims = new Map(); orderClaims.set(order, claims); }
  claims.delete(s.id);
  const taken = new Set<number>();
  for (const [id, tile] of claims) {
    const o = state.soldiers.get(id);
    if (o && o.health !== 'dead' && o.health !== 'incapacitated') taken.add(tile);
  }
  const dest = settleTile(state, s, slot, headingFor(state, team, order), SETTLE_RADIUS, (tx, ty) => taken.has(ty * map.width + tx)) ?? slot;
  return dest;
}

function claim(state: BattleState, order: Order, s: Soldier, p: Vec2): void {
  const claims = orderClaims.get(order);
  if (claims) claims.set(s.id, Math.floor(p.y) * state.map.width + Math.floor(p.x));
}

/** Extend `path` (or a soldier standing at `from`) with a short hop onto `dest`, ending exactly on
 * the destination point so men do not all stop on tile centres. Returns the end point reached. */
function withArrivalHop(state: BattleState, from: Vec2, path: Vec2[], dest: Vec2): { path: Vec2[]; end: Vec2 } {
  const end = path.length > 0 ? path[path.length - 1] : from;
  if (tileEq(end, dest)) {
    if (path.length === 0) return { path, end: from };
    const out = path.slice(0, -1);
    out.push({ x: dest.x, y: dest.y });
    return { path: out, end: dest };
  }
  const tail = findPath(state.map, end, dest, 'infantry', 120);
  if (tail.length === 0 || !tileEq(tail[tail.length - 1], dest)) return { path, end };
  tail[tail.length - 1] = { x: dest.x, y: dest.y };
  return { path: path.concat(tail), end: dest };
}

/** Follower path derived from the leader's path shifted by the (rotated) formation offset, plus a
 * small per-soldier drift that wanders over the route (a damped random walk, tapering to zero over
 * the last waypoints) so the squad does not march in lockstep. One short A* to join it instead of
 * a full A* per soldier. Returns null when the shifted path is not usable. */
function followerPathFromLeader(state: BattleState, s: Soldier, leaderPath: Vec2[], shift: Vec2 | ((i: number) => Vec2), rng: Rng): Vec2[] | null {
  if (leaderPath.length === 0) return null;
  const map = state.map;
  const shifted: Vec2[] = [];
  let dx = 0, dy = 0;
  const n = leaderPath.length;
  for (let i = 0; i < n; i++) {
    const w = leaderPath[i];
    dx = clamp(dx * 0.85 + rng.range(-0.45, 0.45), -DRIFT_MAX, DRIFT_MAX);
    dy = clamp(dy * 0.85 + rng.range(-0.45, 0.45), -DRIFT_MAX, DRIFT_MAX);
    const taper = Math.min(1, (n - 1 - i) / 4);
    const base = vadd(w, typeof shift === 'function' ? shift(i) : shift);
    let p = { x: base.x + dx * taper, y: base.y + dy * taper };
    if (!isPassable(map, Math.floor(p.x), Math.floor(p.y), 'infantry')) {
      dx = 0; dy = 0;
      p = base;
      if (!isPassable(map, Math.floor(p.x), Math.floor(p.y), 'infantry')) return null;
    }
    shifted.push(p);
  }
  const first = shifted[0];
  const sameTile = Math.floor(first.x) === Math.floor(s.pos.x) && Math.floor(first.y) === Math.floor(s.pos.y);
  if (sameTile) return shifted;
  const join = findPath(map, s.pos, first, 'infantry', 400);
  if (join.length === 0) return null;
  const last = join[join.length - 1];
  if (Math.floor(last.x) !== Math.floor(first.x) || Math.floor(last.y) !== Math.floor(first.y)) return null;
  join.pop(); // the join point duplicates the shifted path's first waypoint
  return join.concat(shifted);
}

/** Fallback when the shifted route crosses impassable ground (bridges, gaps in hedges): join the
 * leader's own route and follow it in file, then a short hop to the formation slot at the end.
 * Two bounded A* searches instead of an unbounded one that can exhaust its node budget. */
function followLeaderRoute(state: BattleState, s: Soldier, leaderPath: Vec2[], slot: Vec2): Vec2[] | null {
  if (leaderPath.length === 0) return null;
  const map = state.map;
  const first = leaderPath[0];
  let route: Vec2[];
  if (tileEq(first, s.pos)) route = leaderPath.slice();
  else {
    const join = findPath(map, s.pos, first, 'infantry', 400);
    if (join.length === 0 || !tileEq(join[join.length - 1], first)) return null;
    join.pop();
    route = join.concat(leaderPath);
  }
  const end = route[route.length - 1];
  if (!tileEq(end, slot) && isPassable(map, Math.floor(slot.x), Math.floor(slot.y), 'infantry')) {
    const tail = findPath(map, end, slot, 'infantry', 200);
    if (tail.length > 0 && tileEq(tail[tail.length - 1], slot)) route = route.concat(tail);
  }
  return route;
}

/** Apply the team's current order to one soldier (rolling obedience). Used by applyOrder for the
 * initial issue and by mind.ts to retry a refused order after hesitation. `leaderPath`, when
 * given, is the leader's freshly computed path to the target (shared by followers). */
export function applyOrderToSoldier(state: BattleState, team: Team, s: Soldier, rng: Rng, leaderPath?: Vec2[]): void {
  const order = team.order;
  if (!order || team.outOfAction) { if (s.mind) s.mind.pendingOrderAt = undefined; return; }
  const type = effectiveType(team, order);
  const isVehicleTeam = team.vehicleId != null;
  if (type === 'smoke' && !isVehicleTeam && team.type !== 'mortar' && !teamHasSmoke(state, team)) { s.mind.pendingOrderAt = undefined; return; }
  if (!canObey(state, rng, s, team, order.target)) return;

  if (type === 'move' || type === 'moveFast' || type === 'sneak') {
    const activity = type === 'move' ? 'moving' : type === 'moveFast' ? 'movingFast' : 'sneaking';
    if (isVehicleTeam) {
      s.activity = activity === 'sneaking' ? 'moving' : (activity as Soldier['activity']);
      return;
    }
    const offset = orderSlotOffset(state, team, s, order);
    const dest = destinationFor(state, team, s, order, offset);
    let path: Vec2[] | null = null;
    const wps = order.waypoints && order.waypoints.length > 0 ? order.waypoints : null;
    if (s.id === team.leaderId) {
      path = leaderPath ?? routeVia(state, s.pos, orderRoutePoints(order), 'infantry');
    } else {
      if (leaderPath) {
        // formation offset turned to each leg's direction of travel (the last leg's = the slot's)
        const legs = wps ? pathLegHeadings.get(leaderPath) : undefined;
        const base = formationBaseHeading(state.map, team.side);
        const shift = legs ? (i: number) => rotateOffset(s.formationOffset, (legs[i] ?? headingFor(state, team, order)) - base) : offset;
        path = followerPathFromLeader(state, s, leaderPath, shift, rng) ?? followLeaderRoute(state, s, leaderPath, dest);
      }
      if (!path) {
        path = wps ? routeVia(state, s.pos, [...wps, dest], 'infantry') : findPath(state.map, s.pos, dest, 'infantry', undefined, fireHazardCost(state, 'infantry'));
        if (path.length === 0) path = routeVia(state, s.pos, orderRoutePoints(order), 'infantry');
      }
    }
    const hop = withArrivalHop(state, s.pos, path, dest);
    path = hop.path;
    claim(state, order, s, hop.end);
    s.mind.anchor = { x: hop.end.x, y: hop.end.y };
    s.path = path;
    s.activity = activity as Soldier['activity'];
    s.stance = type === 'sneak' ? 'prone' : 'standing';
    return;
  }

  if (type === 'fire') {
    if (isVehicleTeam) { s.activity = 'firing'; return; }
    stopSoldier(s);
    s.activity = 'firing';
    s.targetPoint = order.target;
    s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
    return;
  }

  if (type === 'smoke') {
    if (isVehicleTeam) { s.activity = 'firing'; return; }
    if (team.type === 'mortar') {
      stopSoldier(s);
      s.activity = 'firing';
      s.targetPoint = order.target;
      return;
    }
    const rangeTiles = 30 / 2; // 30 m in tiles
    const d = dist(team.pos, order.target);
    if (d <= rangeTiles) {
      stopSoldier(s);
      s.activity = 'firing';
      s.targetPoint = order.target;
      s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
    } else {
      const dir = vnorm(vsub(order.target, team.pos));
      const shortM = 25 / 2;
      const approach = vadd(team.pos, vscale(dir, Math.max(0, d - shortM)));
      s.path = findPath(state.map, s.pos, vadd(approach, orderSlotOffset(state, team, s, order)), 'infantry');
      s.activity = 'moving';
      s.stance = 'standing';
      s.targetPoint = order.target;
    }
    return;
  }

  if (type === 'defend') {
    if (isVehicleTeam) { s.activity = 'defending'; return; }
    stopSoldier(s);
    s.activity = 'defending';
    s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
    return;
  }

  if (type === 'ambush') {
    if (isVehicleTeam) { s.activity = 'ambushing'; return; }
    stopSoldier(s);
    s.activity = 'ambushing';
    s.stance = 'prone';
  }
}

/** Validate and apply an order to a team: sets team.order, computes paths, and updates each
 * soldier's (or the team's vehicle's) activity/stance/facing per spec §6.3. */
const delayedOrders = new WeakMap<BattleState, Map<number, { order: Order; at: number }>>();
let releasingDelayed = false;
/** An order waiting to reach a vehicle without a radio (HUD / tests). */
export function delayedOrderOf(state: BattleState, teamId: number): Order | null {
  return delayedOrders.get(state)?.get(teamId)?.order ?? null;
}
function releaseDelayedOrders(state: BattleState, rng: Rng): void {
  const m = delayedOrders.get(state);
  if (!m || m.size === 0) return;
  for (const [teamId, rec] of Array.from(m.entries()).sort((a, b) => a[0] - b[0])) {
    if (state.time < rec.at) continue;
    m.delete(teamId);
    const team = state.teams.get(teamId);
    if (!team) continue;
    releasingDelayed = true;
    try { applyOrder(state, team, { ...rec.order, issuedAt: state.time }, rng); } finally { releasingDelayed = false; }
  }
}

export function applyOrder(state: BattleState, team: Team, order: Order, rng: Rng, own = false): void {
  // a Move order onto the team's own abandoned vehicle sends the crew back into it, or is refused
  // while they are too shaken (spec 2026-09-17 §10)
  if (tryRemountOrder(state, team, order)) return;
  if (team.outOfAction) return;
  // a Move order onto a friendly transport is a mount order; any other order gets a riding team
  // out first; a transport's Dismount order unloads it (sim/transport.ts)
  if (transportOrderHook(state, team, order) === 'handled') return;

  const isVehicleTeam = team.vehicleId != null;
  // team.outOfAction lags a tick behind a kill (morale.ts refreshes it); a burning/knocked-out/
  // abandoned hull and its crew must not take a movement order in that window.
  const deadHull = isVehicleTeam ? state.vehicles.get(team.vehicleId!) : undefined;
  if (deadHull && (deadHull.state === 'knockedOut' || deadHull.state === 'burning' || deadHull.state === 'abandoned')) return;
  // a vehicle whose radio is shot away gets its orders by hand signal or runner: they are acted on
  // RADIO_OUT_ORDER_DELAY_S later (released by stepAttackOrders)
  if (deadHull && !own && !releasingDelayed && radioOut(deadHull)) {
    let m = delayedOrders.get(state);
    if (!m) { m = new Map(); delayedOrders.set(state, m); }
    const prev = m.get(team.id);
    const same = !!prev && prev.order.type === order.type && dist(prev.order.target, order.target) <= 1 && prev.order.targetTeamId === order.targetTeamId;
    m.set(team.id, { order, at: same ? prev!.at : state.time + RADIO_OUT_ORDER_DELAY_S });
    return;
  }
  // never share the waypoint list with the UI or other teams: it is consumed as they are reached
  if (order.waypoints) {
    if (order.type === 'move' || order.type === 'moveFast' || order.type === 'sneak') order.waypoints = order.waypoints.map((w) => ({ x: w.x, y: w.y }));
    else delete order.waypoints;
  }
  team.order = order;
  const type = effectiveType(team, order);

  if (type === 'fire' || type === 'defend' || type === 'ambush') {
    team.facing = facingTo(team.pos, order.target);
  }

  const vehicle = isVehicleTeam ? state.vehicles.get(team.vehicleId!) : undefined;
  let leaderPath: Vec2[] | undefined;

  if (type === 'move' || type === 'moveFast' || type === 'sneak') {
    if (isVehicleTeam) {
      if (vehicle) vehicle.path = routeVia(state, vehicle.pos, orderRoutePoints(order), 'vehicle', VEHICLE_DEFS[vehicle.defId]?.layout?.openTop === true);
    } else {
      const leader = state.soldiers.get(team.leaderId);
      leaderPath = leader ? routeVia(state, leader.pos, orderRoutePoints(order), 'infantry') : [];
    }
  } else if (type === 'fire') {
    initAttackOrder(state, team, order);
    if (vehicle) {
      vehicle.path = [];
      vehicle.targetPoint = order.target;
      vehicle.targetVehicleId = null;
      vehicle.targetSoldierId = null;
    }
  } else if (type === 'smoke') {
    if (vehicle) {
      vehicle.path = [];
      vehicle.targetPoint = order.target;
    }
    // infantry without smoke (and not a mortar) cannot execute the order at all
    if (!isVehicleTeam && team.type !== 'mortar' && !teamHasSmoke(state, team)) return;
  } else if (type === 'defend' || type === 'ambush') {
    if (vehicle) vehicle.path = [];
  }

  for (const sid of team.soldierIds) {
    const s = state.soldiers.get(sid);
    if (!s) continue;
    applyOrderToSoldier(state, team, s, rng, leaderPath);
  }
  // crew-served weapons: a move order starts the pack-up tasks, a fire order the chain onto the
  // new target (spec 2026-09-17 §6)
  if (!isVehicleTeam) onCrewOrder(state, team, type);
}

// ------------------------------------------------------------------ attack-unit fire orders
/** Soldier click tolerance (tiles) for an attack-unit Fire order. */
export const ATTACK_PICK_SOLDIER_TILES = 1.2;
/** Extra tolerance (tiles) beyond a vehicle's half-length. */
export const ATTACK_PICK_VEHICLE_PAD_TILES = 0.5;
/** Seconds of suppressive fire at the last known position after the target is lost. */
export const ATTACK_LOST_SUPPRESS_S = 12;

export type AttackPhase = 'tracking' | 'suppress' | 'hold';

const livingActive = (s: Soldier | undefined): s is Soldier =>
  !!s && s.health !== 'dead' && s.health !== 'incapacitated' && s.activity !== 'surrendered' && s.activity !== 'routed';

/** The enemy team (of `enemySide`) the viewing side can target at `p`: the nearest soldier SPOTTED by
 * the viewer within ATTACK_PICK_SOLDIER_TILES, or a spotted vehicle whose hull (+ pad) contains the
 * point. Unspotted enemies are never returned, so a click can't leak hidden positions. */
export function spottedEnemyTeamAt(state: BattleState, p: Vec2, enemySide: Side): Team | null {
  const viewer = otherSide(enemySide);
  let best: Team | null = null;
  let bd = Infinity;
  for (const id of state.spotted[viewer]) {
    const s = state.soldiers.get(id);
    if (!s || s.side !== enemySide || s.vehicleId != null) continue;
    if (s.health === 'dead' || s.health === 'incapacitated') continue;
    const d = dist(s.pos, p);
    if (d <= ATTACK_PICK_SOLDIER_TILES && d < bd) {
      const t = state.teams.get(s.teamId);
      if (t && !t.outOfAction) { bd = d; best = t; }
    }
  }
  for (const vid of state.spottedVehicles[viewer]) {
    const v = state.vehicles.get(vid);
    if (!v || v.side !== enemySide) continue;
    if (v.state === 'knockedOut' || v.state === 'burning' || v.state === 'abandoned') continue;
    const def = VEHICLE_DEFS[v.defId];
    const half = def ? def.lengthM / TILE_M / 2 : 1;
    const d = dist(v.pos, p);
    if (d <= half + ATTACK_PICK_VEHICLE_PAD_TILES && d < bd) {
      const t = state.teams.get(v.teamId);
      if (t && !t.outOfAction) { bd = d; best = t; }
    }
  }
  return best;
}

/** Current centre of the target team as seen by `viewer`, or null when nothing of it is spotted. */
export function spottedTargetCentre(state: BattleState, viewer: Side, target: Team): Vec2 | null {
  if (target.vehicleId != null) {
    const v = state.vehicles.get(target.vehicleId);
    if (!v || !state.spottedVehicles[viewer].has(v.id)) return null;
    return { x: v.pos.x, y: v.pos.y };
  }
  let x = 0, y = 0, n = 0;
  for (const id of target.soldierIds) {
    if (!state.spotted[viewer].has(id)) continue;
    const s = state.soldiers.get(id);
    if (!livingActive(s)) continue;
    x += s.pos.x; y += s.pos.y; n++;
  }
  return n > 0 ? { x: x / n, y: y / n } : null;
}

/** True when nothing of the target team can fight any more (all dead/incapacitated/surrendered/
 * routed, or its vehicle knocked out/burning/abandoned). */
export function attackTargetDestroyed(state: BattleState, target: Team | undefined): boolean {
  if (!target) return true;
  if (target.vehicleId != null) {
    const v = state.vehicles.get(target.vehicleId);
    if (!v || v.state === 'knockedOut' || v.state === 'burning' || v.state === 'abandoned') return true;
  }
  return !target.soldierIds.some((id) => livingActive(state.soldiers.get(id)));
}

/** Tracking while spotted; suppressing the last known position for ATTACK_LOST_SUPPRESS_S after
 * losing it; then holding and watching. Area-fire orders are always 'tracking'. */
export function attackPhase(state: BattleState, order: Order): AttackPhase {
  if (order.targetTeamId == null || order.lastSeenAt == null) return 'tracking';
  const lost = state.time - order.lastSeenAt;
  if (lost <= 1e-6) return 'tracking';
  return lost <= ATTACK_LOST_SUPPRESS_S ? 'suppress' : 'hold';
}

/** Validates/infers the attack-unit target of a freshly issued Fire order: a given targetTeamId is
 * kept only if that enemy team is currently spotted by the ordering side; otherwise the order becomes
 * area fire unless a spotted enemy stands at the clicked point. */
function initAttackOrder(state: BattleState, team: Team, order: Order): void {
  order.target = { x: order.target.x, y: order.target.y }; // never share the click point between teams
  const enemySide = otherSide(team.side);
  let target: Team | null = null;
  if (order.targetTeamId != null) {
    const t = state.teams.get(order.targetTeamId);
    if (t && t.side === enemySide && !t.outOfAction && !attackTargetDestroyed(state, t) && spottedTargetCentre(state, team.side, t)) target = t;
  }
  if (!target) target = spottedEnemyTeamAt(state, order.target, enemySide);
  delete order.targetTeamId;
  delete order.targetVehicleId;
  delete order.lastSeenAt;
  delete order.lastKnownPos;
  if (!target) return;
  const centre = spottedTargetCentre(state, team.side, target);
  if (!centre) return;
  order.targetTeamId = target.id;
  if (target.vehicleId != null) order.targetVehicleId = target.vehicleId;
  order.target = centre;
  order.lastKnownPos = { ...centre };
  order.lastSeenAt = state.time;
}

/** Per sim step: attack-unit Fire orders follow their target while it is spotted, keep the last
 * known position when it is lost, and complete (Defend facing it, "Target destroyed.") once the
 * target is out of the fight. */
export function stepAttackOrders(state: BattleState, rng: Rng): void {
  releaseDelayedOrders(state, rng);
  for (const team of state.teams.values()) {
    const order = team.order;
    if (!order || order.type !== 'fire' || order.targetTeamId == null || team.outOfAction) continue;
    const target = state.teams.get(order.targetTeamId);
    const last = order.lastKnownPos ?? order.target;
    if (attackTargetDestroyed(state, target)) {
      if (team.side === state.config.playerSide) addMessage(state, `${team.name}\nTarget destroyed.`, 'good');
      applyOrder(state, team, { type: 'defend', target: { x: last.x, y: last.y }, issuedAt: state.time }, rng, true);
      continue;
    }
    const centre = spottedTargetCentre(state, team.side, target!);
    if (centre) {
      // mutate in place: soldiers' targetPoint shares this object
      order.target.x = centre.x; order.target.y = centre.y;
      order.lastKnownPos = { ...centre };
      order.lastSeenAt = state.time;
      team.facing = facingTo(team.pos, centre);
      const v = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
      if (v) v.targetPoint = order.target;
    } else if (order.lastKnownPos) {
      order.target.x = order.lastKnownPos.x; order.target.y = order.lastKnownPos.y;
    }
  }
}
