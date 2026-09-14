import type { BattleState, Team, Order, Soldier, Vec2 } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist, facingTo, vadd, vnorm, vscale, vsub } from '@/shared/math';
import { findPath, isPassable } from './path';
import { teamHasSmoke } from './team';
import { isFirstFireFrozen, isLeaderless } from './mind';
import { angleTo } from '@/shared/math';
import { formationBaseHeading, rotateOffset } from './spawn';
import { settleTile } from './coverSeek';

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
  if (INCAPABLE_ACTIVITIES.has(s.activity) || isFirstFireFrozen(state, s.id) || s.mind.hesitation > 0) {
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
  const from = leader && leader.health !== 'dead' && leader.health !== 'incapacitated' ? leader.pos : team.pos;
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
function followerPathFromLeader(state: BattleState, s: Soldier, leaderPath: Vec2[], shift: Vec2, rng: Rng): Vec2[] | null {
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
    const base = vadd(w, shift);
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
    if (s.id === team.leaderId) {
      path = leaderPath ?? findPath(state.map, s.pos, order.target, 'infantry');
    } else {
      if (leaderPath) path = followerPathFromLeader(state, s, leaderPath, offset, rng) ?? followLeaderRoute(state, s, leaderPath, dest);
      if (!path) {
        path = findPath(state.map, s.pos, dest, 'infantry');
        if (path.length === 0) path = findPath(state.map, s.pos, order.target, 'infantry');
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
export function applyOrder(state: BattleState, team: Team, order: Order, rng: Rng): void {
  if (team.outOfAction) return;

  const isVehicleTeam = team.vehicleId != null;
  // team.outOfAction lags a tick behind a kill (morale.ts refreshes it); a burning/knocked-out/
  // abandoned hull and its crew must not take a movement order in that window.
  const deadHull = isVehicleTeam ? state.vehicles.get(team.vehicleId!) : undefined;
  if (deadHull && (deadHull.state === 'knockedOut' || deadHull.state === 'burning' || deadHull.state === 'abandoned')) return;
  team.order = order;
  const type = effectiveType(team, order);

  if (type === 'fire' || type === 'defend' || type === 'ambush') {
    team.facing = facingTo(team.pos, order.target);
  }

  const vehicle = isVehicleTeam ? state.vehicles.get(team.vehicleId!) : undefined;
  let leaderPath: Vec2[] | undefined;

  if (type === 'move' || type === 'moveFast' || type === 'sneak') {
    if (isVehicleTeam) {
      if (vehicle) vehicle.path = findPath(state.map, vehicle.pos, order.target, 'vehicle');
    } else {
      const leader = state.soldiers.get(team.leaderId);
      leaderPath = leader ? findPath(state.map, leader.pos, order.target, 'infantry') : [];
    }
  } else if (type === 'fire') {
    let targetTeamId: number | undefined;
    for (const other of state.teams.values()) {
      if (other.side === team.side || other.outOfAction) continue;
      const spottedSet = state.spotted[team.side];
      const spottedHere = other.soldierIds.some((id) => spottedSet.has(id));
      if (!spottedHere) continue;
      if (dist(other.pos, order.target) <= 1.5) { targetTeamId = other.id; break; }
    }
    if (targetTeamId != null) order.targetTeamId = targetTeamId;
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
}
