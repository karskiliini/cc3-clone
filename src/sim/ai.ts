import type {
  BattleState, Order, OrderType, Rect, Side, Soldier, Team, Vec2, Vehicle, VictoryLocation,
} from '@/shared/types';
import { otherSide, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, dist } from '@/shared/math';
import { inBounds, coverAt, concealmentAt, groundAtTile } from './map';
import { isPassable } from './path';
import { spaceOutVehicles } from './spawn';
import { hasLOS, hasLineOfFire, EYE_VEHICLE_M } from './los';
import { mainGunUsable } from './vehicleDamage';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { mortarBeliefAimFor, vehicleAreaTarget } from './combat';
import { canTeamMount, passengerCapacity, passengersAboard, roomLeft } from './transport';
import { growthHeightAt } from './growth';
import { armorFacingFor, bestRoundAgainst } from './ballistics';
import { timeToFirstShotS } from './gunTiming';

export interface AIBattle {
  issueOrder(teamId: number, order: Order): void;
  deployTeam?(teamId: number, pos: Vec2): boolean;
}

// ------------------------------------------------------------------ helpers
function zoneCentre(zone: Rect): Vec2 {
  return { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 };
}

function teamsCentre(state: BattleState, side: Side): Vec2 {
  const teams = Array.from(state.teams.values()).filter((t) => t.side === side);
  if (!teams.length) return zoneCentre(state.map.def.deployZones[side]);
  const sum = teams.reduce((acc, t) => ({ x: acc.x + t.pos.x, y: acc.y + t.pos.y }), { x: 0, y: 0 });
  return { x: sum.x / teams.length, y: sum.y / teams.length };
}

function nearestSpottedVehicle(state: BattleState, side: Side, rangeM: number, from?: Vec2): Vehicle | null {
  const centre = from ?? teamsCentre(state, side);
  let best: Vehicle | null = null;
  let bestD = Infinity;
  for (const id of state.spottedVehicles[side]) {
    const v = state.vehicles.get(id);
    // (a burning or abandoned hull is no target: tanks used to keep a Fire order on a wreck the
    // crew had left while a live enemy tank picked them off)
    if (!v || (v.state !== 'ok' && v.state !== 'immobilized')) continue;
    const d = dist(centre, v.pos) * TILE_M;
    if (d > rangeM) continue;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

function nearestSpottedSoldier(state: BattleState, side: Side, from?: Vec2): Soldier | null {
  const centre = from ?? teamsCentre(state, side);
  let best: Soldier | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const d = dist(centre, s.pos);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

function findClusterTarget(state: BattleState, side: Side): Vec2 | null {
  const ids = Array.from(state.spotted[side]);
  let best: Vec2 | null = null;
  let bestCount = 0;
  for (const id of ids) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead') continue;
    let count = 0;
    for (const id2 of ids) {
      const s2 = state.soldiers.get(id2);
      if (!s2 || s2.health === 'dead') continue;
      if (dist(s.pos, s2.pos) <= 5) count++;
    }
    if (count > bestCount) { bestCount = count; best = s.pos; }
  }
  // Reverted along with combat.ts's findEnemyCluster — see that comment.
  return bestCount >= 3 ? best : null;
}

/** The nearest enemy-owned VL (from `sorted`, so preference order matches the attack priority)
 * that has an enemy soldier spotted within 15 tiles (30m) of it — i.e. worth screening with smoke
 * before our attackers cross the open ground into it. */
function findDefendedObjective(state: BattleState, side: Side, sorted: VictoryLocation[]): VictoryLocation | null {
  const enemySoldiers: Vec2[] = [];
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (s && s.health !== 'dead' && s.health !== 'incapacitated') enemySoldiers.push(s.pos);
  }
  if (enemySoldiers.length === 0) return null;
  for (const vl of sorted) {
    if (vl.owner === side) continue;
    const p = { x: vl.x, y: vl.y };
    if (enemySoldiers.some((ep) => dist(ep, p) <= 15)) return vl;
  }
  return null;
}

/** Nearest spotted enemy-of-`side` soldier position within `radiusTiles` of `point`, or `point`
 * itself if none — used so mortar/tank prep fire on a defended VL lands on the actual defenders
 * near it rather than the bare VL coordinate, which is often a few tiles off from where the
 * defending team's cover position (bestCoverWithin) actually put them. */
function preciseFireTarget(state: BattleState, side: Side, point: Vec2, radiusTiles: number): Vec2 {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    const d = dist(s.pos, point);
    if (d <= radiusTiles && d < bestD) { bestD = d; best = s.pos; }
  }
  return best ?? point;
}

/** Count of enemy-of-`side` soldiers spotted within `radiusM` of `point` (for flanking decisions). */
function countSpottedEnemiesNear(state: BattleState, side: Side, point: Vec2, radiusM: number): number {
  let n = 0;
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    if (dist(s.pos, point) * TILE_M <= radiusM) n++;
  }
  return n;
}

/** Closest any attacking team is currently to `point`, in metres (Infinity if there are none). */
function nearestAttackerDistToPoint(attackerTeams: Team[], point: Vec2): number {
  let best = Infinity;
  for (const t of attackerTeams) {
    const d = dist(t.pos, point) * TILE_M;
    if (d < best) best = d;
  }
  return best;
}

function teamHasLOSToEnemy(state: BattleState, team: Team, enemyPos: Vec2): boolean {
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated') continue;
    if (hasLOS(state.map, s.pos, enemyPos)) return true;
  }
  return false;
}

/** How much a metre of height advantage over the enemy approach is worth against a point of
 * terrain cover when picking a defensive position ("high ground" in the CC3 manual: better fields
 * of fire, harder to assault from below). Two metres of command ~= 0.36 cover, i.e. it breaks ties
 * between comparable positions without overriding a genuinely good hedge/building. */
const HEIGHT_DEFENCE_WEIGHT = 0.18;

/** Ground height (m) at a tile — 0 on a flat map, so every score below collapses to the old one. */
function groundAtPos(state: BattleState, p: Vec2): number {
  return groundAtTile(state.map, Math.floor(p.x), Math.floor(p.y));
}

/** Picks a defensive fire position near `centre`: best cover, but preferring ground that stands
 * above where the enemy will come from (`approachFrom`, typically the enemy deploy zone). */
function bestCoverWithin(state: BattleState, centre: Vec2, radiusTiles: number, rng: Rng, approachFrom?: Vec2): Vec2 {
  const approachH = approachFrom ? groundAtPos(state, approachFrom) : 0;
  const useHeight = approachFrom !== undefined && state.map.ground !== undefined;
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 30; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(0, radiusTiles);
    const x = Math.floor(centre.x + Math.cos(ang) * r);
    const y = Math.floor(centre.y + Math.sin(ang) * r);
    if (!inBounds(state.map, x, y)) continue;
    if (!isPassable(state.map, x, y, 'infantry')) continue;
    const pos = { x: x + 0.5, y: y + 0.5 };
    let score = coverAt(state.map, pos);
    if (useHeight) score += (groundAtTile(state.map, x, y) - approachH) * HEIGHT_DEFENCE_WEIGHT;
    if (score > bestScore) { bestScore = score; best = pos; }
  }
  return best ?? centre;
}

function nearRoadTile(state: BattleState, x: number, y: number): number {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(state.map, nx, ny)) continue;
      const t = state.map.tiles[ny * state.map.width + nx];
      if (t === 'dirtroad' || t === 'pavedroad') return 1;
    }
  }
  return 0;
}

function goodCoverNearRoad(state: BattleState, centre: Vec2, rng: Rng): Vec2 {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 30; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 15);
    const x = Math.floor(centre.x + Math.cos(ang) * r);
    const y = Math.floor(centre.y + Math.sin(ang) * r);
    if (!inBounds(state.map, x, y)) continue;
    if (!isPassable(state.map, x, y, 'infantry')) continue;
    const pos = { x: x + 0.5, y: y + 0.5 };
    const score = coverAt(state.map, pos) + nearRoadTile(state, x, y) * 0.5;
    if (score > bestScore) { bestScore = score; best = pos; }
  }
  return best ?? centre;
}

/** Bonus for a candidate step that sits in DEAD GROUND relative to the objective — out of sight
 * of whoever is holding it, because a fold or a reverse slope masks it. Worth a few tiles of
 * progress, so an attacker will take a slightly longer covered route but never stall. Only
 * evaluated when already closing (preferConcealment), so the extra LOS traces stay off the hot
 * path, and only on a map with relief (on a flat map the sample would only ever find woods/walls,
 * which `cover`/`concealment` already score). */
const DEAD_GROUND_BONUS = 4;

function chooseWaypoint(
  state: BattleState, from: Vec2, objective: Vec2, rng: Rng, preferConcealment = false, flankBiasRad = 0,
): Vec2 {
  // Sample within a forward cone toward the objective (not a full 0..2pi circle) and weight net
  // progress far more heavily than cover. The old formula (cover*2 - dObj/50) let a ~1.0 cover
  // bonus at a random nearby tile outweigh tens of tiles of distance-to-objective difference, so
  // "best of 30 random points anywhere nearby" almost always just picked whichever nearby tile had
  // the best cover, regardless of direction — teams cover-hopped in place instead of advancing, so
  // opposing infantry never closed to engagement range (see harness.test.ts: smallArmsFired stuck
  // at 0 on several maps). Biasing the sample cone toward the objective and re-weighting so
  // progress dominates (cover only breaks ties among similarly-forward tiles) fixes that while
  // still preferring covered ground when the forward options are comparable.
  const toObjective = dist(from, objective);
  if (toObjective < 1) return objective;
  // Balance fix (suspect e): flankBiasRad shifts the approach cone off the direct line to the
  // objective (spec ask: ±45deg when 2+ defenders are spotted there) so attackers don't all funnel
  // straight down the defender's prepared line of fire — the cone width stays the same, just
  // re-centred on the flanking bearing.
  const bearing = angleTo(from, objective) + flankBiasRad;
  const maxR = Math.min(25, Math.max(4, toObjective));
  const useDeadGround = preferConcealment && state.map.ground !== undefined;
  const objectiveH = useDeadGround ? groundAtPos(state, objective) : 0;
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 30; i++) {
    const ang = bearing + (rng.next() - 0.5) * (Math.PI / 2); // +/- 45 deg cone toward the objective
    const r = rng.range(3, maxR);
    // angleTo is 0 = north, clockwise: the unit vector of a bearing is (sin, -cos). (This used to
    // be (cos, sin), which pointed the "forward cone" 90 degrees off the objective.)
    const x = Math.floor(from.x + Math.sin(ang) * r);
    const y = Math.floor(from.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y)) continue;
    if (!isPassable(state.map, x, y, 'infantry')) continue;
    const pos = { x: x + 0.5, y: y + 0.5 };
    const cover = coverAt(state.map, pos);
    // Balance round 4: when closing on a defended objective, bias toward concealment (hedges,
    // woods edges, tallgrass/crops) rather than just open-ground cover — hugging concealed terrain
    // on the approach is what should let an attacker close distance without being spotted/shot at
    // every step, per the coordinator's "sneak along hedges/woods when available" ask.
    const concealment = preferConcealment ? concealmentAt(state.map, pos) : 0;
    const dObj = dist(pos, objective);
    const progress = toObjective - dObj; // positive = closer to objective than `from`
    // cheap gate first: you can only be in dead ground if you are BELOW the objective, so the
    // LOS trace is only paid for on candidates that could possibly qualify
    const deadGround = useDeadGround && groundAtTile(state.map, x, y) < objectiveH - 0.5
      && !hasLOS(state.map, objective, pos) ? DEAD_GROUND_BONUS : 0;
    const score = progress + cover * 0.5 + concealment * 1.5 + deadGround;
    if (score > bestScore) { bestScore = score; best = pos; }
  }
  return best ?? objective;
}

function nearestAttackingInfantryTeam(teams: Team[], vehicleTeam: Team): Team | null {
  let best: Team | null = null;
  let bestD = Infinity;
  for (const t of teams) {
    if (t.vehicleId != null) continue;
    const d = dist(t.pos, vehicleTeam.pos);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// -------------------------------------------------------------- order gate
interface OrderRecord { key: string; at: number }
const lastOrderTracks = new WeakMap<BattleState, Map<number, OrderRecord>>();
const callCounters = new WeakMap<BattleState, Map<Side, number>>();

function getOrderTrack(state: BattleState): Map<number, OrderRecord> {
  let t = lastOrderTracks.get(state);
  if (!t) { t = new Map(); lastOrderTracks.set(state, t); }
  return t;
}

/** Issues `order` unless the same one was given a moment ago. An order that still stands on the
 * team (same type, same place or same tracked target) is not repeated for a minute: repeating a
 * Fire order makes a crew-served weapon lay afresh, and repeating a Move re-plans every man's path.
 * One the sim has dropped or replaced (smoke fired, target destroyed, men who would not obey) comes
 * again after 15 s. */
function tryIssueOrder(state: BattleState, battle: AIBattle, track: Map<number, OrderRecord>, team: Team, order: Order): void {
  const key = order.targetTeamId != null
    ? `${order.type}:t${order.targetTeamId}`
    : `${order.type}:${Math.round(order.target.x)},${Math.round(order.target.y)}`;
  const last = track.get(team.id);
  if (last && last.key === key) {
    const cur = team.order;
    const standing = !!cur && cur.type === order.type
      && (order.targetTeamId != null ? cur.targetTeamId === order.targetTeamId : dist(cur.target, order.target) < 1);
    if (state.time - last.at < (standing ? 60 : 15)) return;
  }
  battle.issueOrder(team.id, order);
  track.set(team.id, { key, at: state.time });
}

// ---------------------------------------------------------------- halftracks
/** Squads a halftrack has already carried forward (they are not picked up again). */
const carriedTeams = new WeakMap<BattleState, Set<number>>();
const DISMOUNT_SHORT_M = 110;   // set down this far short of the objective ...
const DISMOUNT_ENEMY_M = 150;   // ... or as soon as known enemy is this close
const PICKUP_RANGE_M = 70;
const WORTH_RIDING_M = 220;

function knownAtGunSees(state: BattleState, side: Side, p: Vec2): boolean {
  for (const id of state.spotted[side]) {
    const e = state.soldiers.get(id);
    if (!e || e.health === 'dead' || e.health === 'incapacitated') continue;
    const cls = WEAPONS[e.weaponId]?.cls;
    if (cls !== 'atgun' && cls !== 'atrocket') continue;
    if (dist(e.pos, p) * TILE_M <= 600 && hasLOS(state.map, e.pos, p)) return true;
  }
  for (const id of state.spottedVehicles[side]) {
    const ev = state.vehicles.get(id);
    if (!ev || (ev.state !== 'ok' && ev.state !== 'immobilized') || !VEHICLE_DEFS[ev.defId]?.mainWeaponId) continue;
    if (dist(ev.pos, p) * TILE_M <= 600 && hasLOS(state.map, ev.pos, p)) return true;
  }
  return false;
}

/** A halftrack carries a squad forward to a covered point short of the objective (80-150 m from
 * known or suspected enemy, never into a known AT gun's line of fire), sets it down, and then
 * supports with its MG from where it stands. Returns true when it has dealt with the vehicle. */
function stepTransportAI(
  state: BattleState, battle: AIBattle, track: Map<number, OrderRecord>, side: Side, team: Team, vehicle: Vehicle,
  attackerTeams: Team[], enemyZoneCentre: Vec2, rng: Rng,
): boolean {
  if (vehicle.state !== 'ok') return false;
  let carried = carriedTeams.get(state);
  if (!carried) { carried = new Set(); carriedTeams.set(state, carried); }
  const riders = passengersAboard(state, vehicle).filter((s) => s.health !== 'dead' && s.health !== 'incapacitated');
  const boarding = attackerTeams.find((t) => t.transportId === vehicle.id && t.order?.mountVehicleId === vehicle.id);
  const enemy = nearestSpottedSoldier(state, side, vehicle.pos);
  const enemyM = enemy ? dist(enemy.pos, vehicle.pos) * TILE_M : Infinity;

  if (riders.length > 0 && !boarding) {
    const riderTeam = state.teams.get(riders[0].teamId);
    const objective = riderTeam?.aiObjective ?? enemyZoneCentre;
    const toObjM = dist(vehicle.pos, objective) * TILE_M;
    const setDown = (): void => {
      for (const s of riders) carried!.add(s.teamId);
      battle.issueOrder(team.id, { type: 'defend', target: objective, issuedAt: state.time, dismount: true });
    };
    const suspectM = state.map.victoryLocations.reduce((m, vl) => (vl.owner !== side ? Math.min(m, dist(vehicle.pos, { x: vl.x, y: vl.y }) * TILE_M) : m), Infinity);
    if (enemyM <= DISMOUNT_ENEMY_M || toObjM <= DISMOUNT_SHORT_M + 10 || suspectM <= 90 || knownAtGunSees(state, side, vehicle.pos)) { setDown(); return true; }
    // a covered point short of the objective, pulled back while a known gun looks at it
    const ang = angleTo(objective, vehicle.pos);
    let point: Vec2 = objective;
    for (let back = DISMOUNT_SHORT_M; back <= DISMOUNT_SHORT_M + 120; back += 40) {
      const c = { x: objective.x + (Math.sin(ang) * back) / TILE_M, y: objective.y + (-Math.cos(ang) * back) / TILE_M };
      point = c;
      if (!knownAtGunSees(state, side, c)) break;
    }
    const prev = team.aiObjective;
    const dest = prev && dist(prev, point) <= 12 ? prev : bestCoverWithin(state, point, 5, rng, vehicle.pos);
    team.aiObjective = dest;
    if (dist(vehicle.pos, dest) * TILE_M <= 12) { setDown(); return true; }
    tryIssueOrder(state, battle, track, team, { type: 'moveFast', target: dest, issuedAt: state.time });
    return true;
  }
  if (boarding) {
    // wait for them; if the enemy turns up meanwhile the ordinary vehicle logic (fire) takes over
    if (enemyM <= 200) return false;
    tryIssueOrder(state, battle, track, team, { type: 'defend', target: enemyZoneCentre, issuedAt: state.time });
    return true;
  }
  // empty: pick up a squad that still has a long way to go — never where the enemy is known or
  // suspected (an objective we do not hold) to be close
  const suspectClose = state.map.victoryLocations.some((vl) => vl.owner !== side && dist(vehicle.pos, { x: vl.x, y: vl.y }) * TILE_M < 180);
  if (enemyM > 250 && !suspectClose && roomLeft(state, vehicle) > 0) {
    let pick: Team | null = null, bd = Infinity;
    for (const t of attackerTeams) {
      if (carried.has(t.id) || t.transportId != null || !canTeamMount(t) || t.crewWeapon) continue;
      if (t.status === 'Pinned' || t.status === 'Cowering' || t.status === 'Broken' || t.status === 'Panicked' || t.status === 'Routed') continue;
      const d = dist(t.pos, vehicle.pos) * TILE_M;
      const toGo = t.aiObjective ? dist(t.pos, t.aiObjective) * TILE_M : 0;
      // worth it only with a real ride ahead of the pick-up point itself
      const rideM = t.aiObjective ? dist(vehicle.pos, t.aiObjective) * TILE_M - DISMOUNT_SHORT_M : 0;
      if (d > PICKUP_RANGE_M || toGo < WORTH_RIDING_M || rideM < 100 || d >= bd) continue;
      pick = t; bd = d;
    }
    if (pick) {
      battle.issueOrder(pick.id, { type: 'moveFast', target: { ...vehicle.pos }, issuedAt: state.time, mountVehicleId: vehicle.id });
      tryIssueOrder(state, battle, track, team, { type: 'defend', target: enemyZoneCentre, issuedAt: state.time });
      return true;
    }
  }
  // it has delivered its squad: support from a standoff position instead of driving onto the objective
  if (carried.size > 0 && !enemy) {
    tryIssueOrder(state, battle, track, team, { type: 'defend', target: enemyZoneCentre, issuedAt: state.time });
    return true;
  }
  return false;
}

// -------------------------------------------------------------------- deploy
export function aiDeploy(state: BattleState, side: Side, rng: Rng, battle: AIBattle): void {
  const zone = state.map.def.deployZones[side];
  const teams = Array.from(state.teams.values()).filter((t) => t.side === side);
  const placed: Vec2[] = [];
  // The attacker forms up out of sight: every victory location starts in the defender's hands and
  // most of them look straight into the attacker's zone, so a squad placed in view of one is
  // under tank and machine-gun fire before the battle has properly begun.
  // The defender does the same against the attacker's forming-up area (it used to stand in plain
  // view of it on the maps where the two zones face each other across open ground).
  const ez = state.map.def.deployZones[otherSide(side)];
  const lookouts: Vec2[] = state.map.def.attacker === side
    ? [...state.map.victoryLocations.map((vl) => ({ x: vl.x, y: vl.y })), zoneCentre(ez)]
    : [zoneCentre(ez), { x: ez.x + ez.w * 0.2, y: ez.y + ez.h * 0.2 }, { x: ez.x + ez.w * 0.8, y: ez.y + ez.h * 0.8 },
      { x: ez.x + ez.w * 0.2, y: ez.y + ez.h * 0.8 }, { x: ez.x + ez.w * 0.8, y: ez.y + ez.h * 0.2 }];

  for (const team of teams) {
    const isVehicle = team.vehicleId != null;
    const mover = isVehicle ? 'vehicle' : 'infantry';
    let best: Vec2 | null = null;
    let bestScore = -Infinity;

    // Keep anchors off the MAP edge: natural formations (spawn.ts naturalFormation) spread several
    // tiles around the anchor; deployTeam lays each man out on his own passable, in-map tile, but an
    // anchor on the map's edge rows would still squash the shape against the edge.
    // Interior zone edges are left alone (restricting those shifted AI deployment and harness
    // balance for no benefit; deployTeam also clamps each soldier into the map).
    const W = state.map.width, H = state.map.height;
    const zx0 = Math.max(zone.x, 0), zx1 = Math.min(zone.x + zone.w, W);
    const zy0 = Math.max(zone.y, 0), zy1 = Math.min(zone.y + zone.h, H);
    const xLo = Math.max(zx0, 3), xHi = Math.min(zx1, W - 3);
    const yHi = Math.min(zy1, H - 5);
    const sx0 = xHi > xLo ? xLo : zx0, sx1 = xHi > xLo ? xHi : zx1;
    const sy0 = zy0, sy1 = yHi > zy0 ? yHi : zy1;

    for (let i = 0; i < 40; i++) {
      const x = Math.floor(rng.range(sx0, sx1));
      const y = Math.floor(rng.range(sy0, sy1));
      if (!inBounds(state.map, x, y)) continue;
      if (!isPassable(state.map, x, y, mover)) continue;
      const pos = { x: x + 0.5, y: y + 0.5 };
      if (!isVehicle) {
        const spread = placed.length ? Math.min(...placed.map((p) => dist(p, pos))) : 999;
        if (spread < 4) continue;
      }
      let score = isVehicle ? nearRoadTile(state, x, y) : coverAt(state.map, pos) >= 0.3 ? 1 + coverAt(state.map, pos) : coverAt(state.map, pos);
      if (lookouts.length && score + 0.001 >= bestScore - 1.5) {
        let seen = 0;
        for (const l of lookouts) if (dist(l, pos) * TILE_M <= 400 && hasLOS(state.map, l, pos, isVehicle ? undefined : { eyeM: 1.7, targetM: 0.5 })) seen++;
        score -= Math.min(3, seen) * 0.5;
      }
      if (score > bestScore) { bestScore = score; best = pos; }
    }

    if (!best) {
      for (let i = 0; i < 60 && !best; i++) {
        const x = Math.floor(rng.range(sx0, sx1));
        const y = Math.floor(rng.range(sy0, sy1));
        if (isPassable(state.map, x, y, mover)) best = { x: x + 0.5, y: y + 0.5 };
      }
    }

    if (best) {
      placed.push(best);
      battle.deployTeam?.(team.id, best);
    }
  }
  // vehicles are scored only by road proximity above, so several used to land on top of each
  // other: spread them out (hull length + 4 m, staggered) and face them at the enemy
  spaceOutVehicles(state, side);
}

// ------------------------------------------------------------------ step ai
/** One AI decision for `side` (called every AI_INTERVAL by the battle loop). The side attacking
 * on this map runs the phased attack plan below; the side holding the victory locations runs the
 * defence. Both only use what the side has spotted or believes. */
export function stepAI(state: BattleState, rng: Rng, battle: AIBattle, side: Side): void {
  let counters = callCounters.get(state);
  if (!counters) { counters = new Map(); callCounters.set(state, counters); }
  const n = (counters.get(side) ?? 0) + 1;
  counters.set(side, n);
  if (state.config.difficulty === 'easy' && n % 2 === 0) return;
  const mem = getMemory(state, side);
  updateContacts(state, side, mem);
  if (state.map.def.attacker === side) stepAttackAI(state, rng, battle, side, mem);
  else stepDefenceAI(state, rng, battle, side, n, mem);
}

// ------------------------------------------------------------------ the defence
function stepDefenceAI(state: BattleState, rng: Rng, battle: AIBattle, side: Side, n: number, mem: SideMemory): void {
  const track = getOrderTrack(state);
  const enemy = otherSide(side);
  const myTeams = Array.from(state.teams.values()).filter((t) => t.side === side && !t.outOfAction);
  if (myTeams.length === 0) return;

  const enemyZoneCentre = zoneCentre(state.map.def.deployZones[enemy]);
  const ownZoneCentre = zoneCentre(state.map.def.deployZones[side]);

  // Sorted over ALL VLs (never filtered by current ownership) so the order is a pure function of
  // static value/distance and therefore invariant across ticks — unlike a list filtered by
  // ownership, whose length/contents change every time any VL flips hands anywhere on the map,
  // which used to reshuffle every attacking team's assigned index (see the note above `vlIdx`).
  const allVLsSorted = state.map.victoryLocations.slice().sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return dist(ownZoneCentre, { x: a.x, y: a.y }) - dist(ownZoneCentre, { x: b.x, y: b.y });
  });
  const ownedVLs = allVLsSorted.filter((vl) => vl.owner === side);
  const enemyZone = state.map.def.deployZones[enemy];
  const inEnemyZone = (vl: VictoryLocation): boolean =>
    vl.x >= enemyZone.x && vl.x <= enemyZone.x + enemyZone.w &&
    vl.y >= enemyZone.y && vl.y <= enemyZone.y + enemyZone.h;

  /** Team `preferredIdx` picks its primary target at a fixed slot in the invariant `allVLsSorted`
   * list, then walks forward (wrapping) to the nearest slot matching `wantOwnedBySide` — so a
   * team's objective only moves when ITS OWN target's ownership changes, not whenever some other
   * VL elsewhere on the map is captured/lost. Defenders additionally never garrison a VL that
   * sits inside the enemy's deployment zone: that is a walk-in kill box (korsun's Orchard
   * Crossroads sat inside the German jump-off ground and defenders marched 100+ tiles of open
   * snow to die there before contact), so hold everything ELSE and let the attacker have it. */
  function pickVL(preferredIdx: number, wantOwnedBySide: boolean): VictoryLocation | null {
    const n = allVLsSorted.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i++) {
      const vl = allVLsSorted[(preferredIdx + i) % n];
      if ((vl.owner === side) !== wantOwnedBySide) continue;
      if (wantOwnedBySide && inEnemyZone(vl)) continue;
      return vl;
    }
    return null;
  }

  const defendersCount = Math.max(1, Math.round(myTeams.length / 3));
  const priorityDefend = myTeams.filter((t) => t.type === 'mg' || t.type === 'atgun' || t.type === 'mortar');
  const defenders = new Set<number>();
  for (const t of priorityDefend) { if (defenders.size < defendersCount) defenders.add(t.id); }
  for (const t of myTeams) { if (defenders.size < defendersCount) defenders.add(t.id); }

  // Stable, order-independent VL-objective assignment per team. This used to be a single mutable
  // `vlIdx` counter incremented while iterating myTeams — but it was skipped for mortar/atgun teams
  // and for any team that happened to be pinned/cowering *this tick*, so a given team's assigned
  // index (and therefore its target VL) drifted almost every 5s AI tick. Since tryIssueOrder's
  // dedup key includes the target position, a drifting objective meant a brand-new moveFast order
  // toward a different VL every tick — infantry walked in circles and never converged into contact,
  // so small-arms combat almost never happened (see harness.test.ts: smallArmsFired stuck at 0).
  // Indexing into a list keyed by team.id instead keeps each team's assignment fixed across ticks.
  const defenderTeams = myTeams.filter((t) => defenders.has(t.id)).sort((a, b) => a.id - b.id);
  const attackerTeams = myTeams
    .filter((t) => t.vehicleId == null && t.type !== 'atgun' && t.type !== 'atteam' && t.type !== 'mortar' && !defenders.has(t.id))
    .sort((a, b) => a.id - b.id);
  const vehicleTeams: Team[] = [];

  for (const team of myTeams) {
    if (team.status === 'Pinned' || team.status === 'Cowering') continue;
    // boarding or riding in a halftrack: the halftrack's plan is theirs until they are set down
    if (team.vehicleId == null && team.transportId != null) continue;

    if (team.status === 'Broken' || team.status === 'Panicked' || team.status === 'Routed') {
      tryIssueOrder(state, battle, track, team, { type: 'move', target: ownZoneCentre, issuedAt: state.time });
      continue;
    }

    if (team.type === 'atgun' || team.type === 'atteam') {
      const vehicle = nearestSpottedVehicle(state, side, 9999, team.pos);
      if (vehicle && hasLOS(state.map, team.pos, vehicle.pos)) {
        tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...vehicle.pos }, issuedAt: state.time });
      } else {
        const pos = goodCoverNearRoad(state, enemyZoneCentre, rng);
        team.aiObjective = pos;
        tryIssueOrder(state, battle, track, team, { type: 'ambush', target: enemyZoneCentre, issuedAt: state.time });
      }
      continue;
    }

    if (team.type === 'mortar') {
      // (this used to pass `enemy`, i.e. the soldiers the ENEMY had spotted: our own men)
      const cluster = findClusterTarget(state, side);
      if (cluster) {
        tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...cluster }, issuedAt: state.time });
      } else {
        // Balance round 4: a mortar with no direct cluster target supports the attack in two
        // phases against a defended objective (an enemy-owned VL with enemies spotted near it) —
        // (a) while our own attackers are still >150m out, keep dropping real HE on the VL itself
        // (pickTarget/stepMortarTeam fire at an empty point still resolves suppression via
        // resolveRound's point branch, and here there ARE defenders there so it can also land real
        // hits), suppressing the defenders before the attackers are exposed; (b) once our nearest
        // attacker is inside 150m, switch to smoke to screen the final approach instead, since more
        // HE at that range risks our own troops. Falls back to screening our own best VL if nothing
        // is contested (previous behaviour).
        const defended = findDefendedObjective(state, side, allVLsSorted);
        let beliefAim: Vec2 | null = null;
        if (defended) {
          const distToDefended = nearestAttackerDistToPoint(attackerTeams, { x: defended.x, y: defended.y });
          if (distToDefended > 150) {
            // Balance fix: aim at the actual defenders spotted near the VL, not the bare VL tile —
            // defending teams' cover position (bestCoverWithin, up to 8 tiles from the VL) rarely
            // sits exactly on it, so HE aimed at the VL coordinate was landing on empty ground most
            // of the time (harness: avgDefSuppr(<=150m) stayed ~0 even with mortarHE rounds fired).
            const preciseTarget = preciseFireTarget(state, side, { x: defended.x, y: defended.y }, 10);
            tryIssueOrder(state, battle, track, team, { type: 'fire', target: preciseTarget, issuedAt: state.time });
          } else {
            tryIssueOrder(state, battle, track, team, { type: 'smoke', target: { x: defended.x, y: defended.y }, issuedAt: state.time });
          }
        } else if ((beliefAim = mortarBeliefAimFor(state, team))) {
          // indirect fire on what the crew / its leader believes is out there (suppression)
          tryIssueOrder(state, battle, track, team, { type: 'fire', target: { x: beliefAim.x, y: beliefAim.y }, issuedAt: state.time });
        } else if (ownedVLs.length) {
          const contested = ownedVLs.reduce((best, vl) => (!best || vl.value > best.value ? vl : best));
          tryIssueOrder(state, battle, track, team, { type: 'smoke', target: { x: contested.x, y: contested.y }, issuedAt: state.time });
        }
      }
      continue;
    }

    if (team.vehicleId != null) {
      vehicleTeams.push(team);
      continue;
    }

    // infantry: defenders vs attackers
    // Sanity fix: while the side still holds every victory location there is nothing to retake,
    // and the two thirds of the infantry meant for counter-attacks used to march on the ENEMY'S
    // DEPLOYMENT ZONE instead. They now man the victory locations too (spread over all of them by
    // their own index) until one is lost, and only then go and take it back.
    const counterAttackIdx = attackerTeams.indexOf(team);
    const nothingToRetake = ownedVLs.length === allVLsSorted.length;
    if (defenders.has(team.id) || (counterAttackIdx >= 0 && nothingToRetake && allVLsSorted.length > 0)) {
      const dIdx = defenders.has(team.id) ? defenderTeams.indexOf(team) : defenderTeams.length + counterAttackIdx;
      let vl = pickVL(dIdx, true);

      // Balance round 4: a defender under 40 morale withdraws to a different owned VL instead of
      // holding the same ground forever — per the coordinator's ask. Falls back to its own zone
      // if there's nowhere else owned to go.
      if (team.morale < 40 && ownedVLs.length > 1 && vl) {
        const fallback = ownedVLs.find((v) => v.id !== vl!.id);
        if (fallback) vl = fallback;
      }

      // Reuse the previously-assigned cover point as long as it's still near the (possibly new)
      // target VL, instead of resampling bestCoverWithin's 30 random candidates every single tick
      // — that resampling made a "defend" order's target position jitter tile-to-tile even though
      // the team wasn't actually moving there anyway (see below), and would otherwise fight the
      // "already in position" distance check with noise.
      const prev = team.aiObjective;
      const pos = vl && (!prev || dist(prev, { x: vl.x, y: vl.y }) > 10)
        ? bestCoverWithin(state, { x: vl.x, y: vl.y }, 8, rng, enemyZoneCentre)
        : (prev ?? team.pos);
      team.aiObjective = pos;

      // Balance round 4 — the actual mechanism fix: a `defend` order never moves anyone (see
      // orders.ts), it only holds the CURRENT position and faces `enemyZoneCentre`. So a defender
      // that was simply deployed near its own zone edge (aiDeploy has no idea which VL it'll be
      // assigned to defend) would just camp there forever, never actually covering the VL it was
      // supposedly guarding — while still racking up kills on approaching attackers from a safe,
      // unintended position. Defenders must first MOVE to their assigned cover point; only once
      // they're actually there do they switch to holding it.
      const distToPosM = dist(team.pos, pos) * TILE_M;
      if (distToPosM > 15) {
        // Sanity fix: not at a walk across open ground in full view of the enemy. With an enemy in
        // sight the squad fights from where it lies; the last stretch (or a move nobody can see)
        // is done at the double.
        const watcher = nearestSpottedSoldier(state, side, team.pos);
        const watched = !!watcher && dist(watcher.pos, team.pos) * TILE_M <= 250 && teamHasLOSToEnemy(state, team, watcher.pos);
        if (watched && distToPosM > 60) {
          tryIssueOrder(state, battle, track, team, { type: 'defend', target: { ...watcher!.pos }, issuedAt: state.time });
          continue;
        }
        tryIssueOrder(state, battle, track, team, { type: watched ? 'moveFast' : 'move', target: pos, issuedAt: state.time });
        continue;
      }

      // Occasional counterattack (balance round 4): a healthy, in-position defender that spots a
      // weak, close attacker sometimes pushes out briefly to press the advantage instead of always
      // passively holding — rather than every defender being a pure turret forever.
      const nearbyEnemy = nearestSpottedSoldier(state, side, team.pos);
      const nearbyEnemyDistM = nearbyEnemy ? dist(team.pos, nearbyEnemy.pos) * TILE_M : Infinity;
      if (team.morale >= 60 && nearbyEnemy && nearbyEnemyDistM <= 40 && teamHasLOSToEnemy(state, team, nearbyEnemy.pos) && rng.chance(0.15)) {
        tryIssueOrder(state, battle, track, team, { type: 'moveFast', target: { ...nearbyEnemy.pos }, issuedAt: state.time });
        continue;
      }

      tryIssueOrder(state, battle, track, team, { type: 'defend', target: enemyZoneCentre, issuedAt: state.time });
      continue;
    }

    const aIdx = attackerTeams.indexOf(team);
    const targetVL = pickVL(aIdx, false);
    const objective = targetVL ? { x: targetVL.x, y: targetVL.y } : enemyZoneCentre;
    team.aiObjective = objective;

    // Use THIS team's own position, not the side-wide average of every team's position — on a
    // spread-out map the side centroid can be far from any given team, which made the 120 m
    // engagement gate below almost never fire and left infantry marching past each other with
    // only tanks/mortars actually fighting (see harness: smallArmsFired stayed at 0 in most runs).
    const nearestEnemy = nearestSpottedSoldier(state, side, team.pos);
    const nearestEnemyDistM = nearestEnemy ? dist(team.pos, nearestEnemy.pos) * TILE_M : Infinity;

    // Balance regression fix: this used to permanently lock a team into defend/fire the instant an
    // enemy came within 120m, with NO way back into advancing — VL capture needs the team within
    // 10m of the VL, so a team that stops to fight 100m+ short of the objective can win every
    // firefight and still never capture anything (harness showed attacker VLs held stuck at 0 even
    // in runs where the attacker out-shot the defender). Only true close-quarters contact (<=30m)
    // gets an unconditional hold; everything out to 250m uses the SAME bounding-overwatch split as
    // before (half hold and suppress, half keep pushing toward the objective, not just the enemy).
    const DANGER_CLOSE_M = 30;
    if (nearestEnemy && nearestEnemyDistM <= DANGER_CLOSE_M && teamHasLOSToEnemy(state, team, nearestEnemy.pos)) {
      if (rng.chance(0.3)) {
        tryIssueOrder(state, battle, track, team, { type: 'defend', target: { ...nearestEnemy.pos }, issuedAt: state.time });
      } else {
        tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...nearestEnemy.pos }, issuedAt: state.time });
      }
      continue;
    }

    // Bounding overwatch: from danger-close out to 250m, alternate which half of the attacking
    // teams advance toward the OBJECTIVE each 5s AI tick and which half halts and covers them with
    // fire at the nearest visible enemy — instead of every team either freezing forever or all
    // closing the whole distance at once with nobody providing suppression. `n` (this side's
    // stepAI call count) flips the two halves every tick so they leapfrog each other.
    // Tried shifting this to a 1-in-3 advance/2-in-3 hold split (more return fire per tick) but the
    // harness showed it made things WORSE (attacker win rate 31%->19%): slowing the advance kept
    // attacker infantry exposed in the open for longer against defenders who are almost always
    // stationary and free to fire at full range, and the extra time in the open outweighed the extra
    // return-fire volume. Reverted to the original 50/50 leapfrog.
    if (nearestEnemy && nearestEnemyDistM <= 250 && teamHasLOSToEnemy(state, team, nearestEnemy.pos)) {
      const bounding = (aIdx + n) % 2 === 0;
      if (!bounding) {
        tryIssueOrder(state, battle, track, team, { type: 'defend', target: { ...nearestEnemy.pos }, issuedAt: state.time });
        continue;
      }
    }

    // Balance round 4: hug concealed terrain (hedges/woods/tallgrass) on the approach, per the
    // coordinator's "sneak along hedges/woods when available" ask — not just when already
    // sneaking, but for the whole final approach band where being seen matters.
    const preferConcealment = nearestEnemyDistM <= 150;
    // Balance fix (suspect e): when the objective has 2+ defenders spotted, approach off a ±45deg
    // flanking bearing instead of walking straight down their prepared line of fire. The sign is
    // fixed per team (by id parity) so a team commits to one flank rather than oscillating tick to
    // tick between left/right.
    const defendersSpotted = countSpottedEnemiesNear(state, side, objective, 60);
    const flankBiasRad = defendersSpotted >= 2 ? (team.id % 2 === 0 ? 1 : -1) * (Math.PI / 4) : 0;
    const waypoint = chooseWaypoint(state, team.pos, objective, rng, preferConcealment, flankBiasRad);
    let orderType: OrderType = 'move';
    if (nearestEnemyDistM > 150) orderType = 'moveFast';
    else if (nearestEnemyDistM <= 60) orderType = 'sneak';
    if (state.config.difficulty === 'hard' && orderType === 'move') orderType = 'moveFast';
    tryIssueOrder(state, battle, track, team, { type: orderType, target: waypoint, issuedAt: state.time });
  }

  // vehicles
  const defenceStations: Vec2[] = [];
  for (const team of vehicleTeams) {
    const vehicle = state.vehicles.get(team.vehicleId!);
    if (!vehicle || vehicle.state === 'knockedOut' || vehicle.state === 'burning' || vehicle.state === 'abandoned') continue;
    if (passengerCapacity(vehicle) > 0 && stepTransportAI(state, battle, track, side, team, vehicle, attackerTeams, enemyZoneCentre, rng)) continue;

    // The defence's armour fights by the same rules as the attack's (stepAttackVehicle): it takes
    // station on the victory location its nearest squad is holding, a hull apart from the others
    // (they used to pile up on one tile), with a line of fire to where the enemy has been seen and
    // out of sight of guns that beat it; it turns on known enemy armour from a position that can
    // hurt it instead of sitting still while it is outflanked.
    // (only the squads with a victory-location job count: an AT gun's or a mortar's `aiObjective`
    // is a point near the ENEMY zone or nothing at all, and used to send the tanks charging there)
    const infTeam = nearestAttackingInfantryTeam([...defenderTeams, ...attackerTeams], team);
    const guard = infTeam?.aiObjective ?? (ownedVLs.length ? { x: ownedVLs[0].x, y: ownedVLs[0].y } : ownZoneCentre);
    if (!mem.plan) { mem.plan = newPlan(state, []); mem.plan.phase = 'hold'; }
    let guardVl = -1, gd = Infinity;
    for (const vl of state.map.victoryLocations) { const d = dist(guard, { x: vl.x, y: vl.y }); if (d < gd) { gd = d; guardVl = vl.id; } }
    mem.plan.objectiveId = guardVl;
    const guns = vehicleTeams.filter((t) => { const v = state.vehicles.get(t.vehicleId!); return !!v && !!VEHICLE_DEFS[v.defId]?.mainWeaponId; });
    stepAttackVehicle(state, rng, battle, track, side, mem, mem.plan, team, vehicle, Math.max(0, guns.indexOf(team)), Math.max(1, guns.length),
      [], guard, null, guard, ownZoneCentre, defenceStations);
  }
}

// =====================================================================================
// SIDE MEMORY — what this side has SEEN (never the true enemy state): the last known position of
// every enemy team a friendly soldier or crew spotted, kept for a couple of minutes. The attack
// plan fires at, screens and routes around these contacts.
// =====================================================================================
/** A contact is forgotten this long after it was last seen. */
export const CONTACT_KEEP_S = 150;

export interface Contact {
  teamId: number;
  pos: Vec2;
  /** battle seconds it was last spotted */
  at: number;
  vehicleId: number | null;
  /** team type as it was recognised when spotted */
  type: Team['type'];
  /** carries an AT gun / rocket / rifle */
  antiTank: boolean;
  /** a vehicle's hull facing when it was last seen (which plate it shows to where) */
  hullFacing?: number;
}

export type AttackPhase = 'prep' | 'advance' | 'assault' | 'allIn' | 'consolidate' | 'hold';

interface BoundState { mover: 0 | 1; since: number; targets: Map<number, Vec2>; settled: boolean }
interface FireMission { pos: Vec2; until: number; smoke: boolean; teamId: number | null; suspected?: boolean }

export interface AttackPlan {
  phase: AttackPhase;
  phaseSince: number;
  /** VL id of the main effort: every assault squad works on this one objective */
  objectiveId: number | null;
  objectiveSince: number;
  /** seconds this objective may take before the push goes all-in (then is called off) */
  budgetS: number;
  /** forming-up place short of the objective, on the chosen axis (null = close enough already) */
  fup: Vec2 | null;
  bound: BoundState;
  /** which of the two bounding elements a squad belongs to */
  element: Map<number, 0 | 1>;
  /** objectives called off (VL id -> battle time) */
  failed: Map<number, number>;
  /** overwatch posts / stations by team id, valid for one objective */
  posts: Map<number, { objectiveId: number; pos: Vec2; at: number }>;
  missions: Map<number, FireMission>;
  smoked: Set<string>;
  /** men in the assault squads at the start (the attack is called off when too few are left) */
  startMen: number;
  objectivesTaken: number;
  /** squads left behind to hold a captured victory location (VL id -> team id) */
  garrison: Map<number, number>;
  /** since when each vehicle has had nothing it can fight or fire at (item 038 blind loop) */
  blind: Map<number, number>;
}

interface SideMemory { contacts: Map<number, Contact>; plan: AttackPlan | null }
const memories = new WeakMap<BattleState, Partial<Record<Side, SideMemory>>>();

function getMemory(state: BattleState, side: Side): SideMemory {
  let m = memories.get(state);
  if (!m) { m = {}; memories.set(state, m); }
  let s = m[side];
  if (!s) { s = { contacts: new Map(), plan: null }; m[side] = s; }
  return s;
}

/** Read-only view of the attack plan (tests, harness instrumentation, debug overlays). */
export function getAttackPlan(state: BattleState, side: Side): Readonly<AttackPlan> | null {
  return memories.get(state)?.[side]?.plan ?? null;
}
/** The side's remembered contacts (tests / instrumentation). */
export function getContacts(state: BattleState, side: Side): Contact[] {
  return Array.from(memories.get(state)?.[side]?.contacts.values() ?? []);
}

const AT_CLASSES = new Set(['atgun', 'atrocket', 'atrifle']);

function updateContacts(state: BattleState, side: Side, mem: SideMemory): void {
  const sum = new Map<number, { x: number; y: number; n: number; at: boolean }>();
  for (const id of state.spotted[side]) {
    const s = state.soldiers.get(id);
    if (!s || s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered') continue;
    if (s.vehicleId != null) continue;
    let e = sum.get(s.teamId);
    if (!e) { e = { x: 0, y: 0, n: 0, at: false }; sum.set(s.teamId, e); }
    e.x += s.pos.x; e.y += s.pos.y; e.n++;
    if (AT_CLASSES.has(WEAPONS[s.weaponId]?.cls ?? '')) e.at = true;
  }
  for (const [teamId, e] of sum) {
    const team = state.teams.get(teamId);
    if (!team) continue;
    mem.contacts.set(teamId, { teamId, pos: { x: e.x / e.n, y: e.y / e.n }, at: state.time, vehicleId: null, type: team.type, antiTank: e.at });
  }
  for (const id of state.spottedVehicles[side]) {
    const v = state.vehicles.get(id);
    if (!v) continue;
    if (v.state === 'knockedOut' || v.state === 'burning' || v.state === 'abandoned') { mem.contacts.delete(v.teamId); continue; }
    const team = state.teams.get(v.teamId);
    mem.contacts.set(v.teamId, { teamId: v.teamId, pos: { ...v.pos }, at: state.time, vehicleId: v.id, type: team?.type ?? 'tank', antiTank: !!VEHICLE_DEFS[v.defId]?.mainWeaponId, hullFacing: v.hullFacing });
  }
  for (const [k, c] of mem.contacts) {
    if (state.time - c.at > CONTACT_KEEP_S) { mem.contacts.delete(k); continue; }
    // a team that is seen to be finished (its men lie where we last saw them) is struck off
    const t = state.teams.get(c.teamId);
    if (!t || t.outOfAction) mem.contacts.delete(k);
  }
}

function isSpottedNow(c: Contact, state: BattleState): boolean { return c.at >= state.time - 0.01; }

// ------------------------------------------------------------------ geometry helpers
const PRONE = { eyeM: 1.1, targetM: 0.5 } as const;

function alive(s: Soldier | undefined): s is Soldier { return !!s && s.health !== 'dead' && s.health !== 'incapacitated'; }

function teamMen(state: BattleState, t: Team): number {
  let n = 0;
  for (const id of t.soldierIds) if (alive(state.soldiers.get(id))) n++;
  return n;
}

function isShaken(t: Team): boolean { return t.status === 'Broken' || t.status === 'Panicked' || t.status === 'Routed'; }
function isPinned(t: Team): boolean { return t.status === 'Pinned' || t.status === 'Cowering' || t.status === 'Stunned'; }

function centroidOf(teams: Team[], fallback: Vec2): Vec2 {
  if (!teams.length) return fallback;
  let x = 0, y = 0;
  for (const t of teams) { x += t.pos.x; y += t.pos.y; }
  return { x: x / teams.length, y: y / teams.length };
}

function friendlyWithin(teams: Team[], p: Vec2, tiles: number): boolean {
  for (const t of teams) if (dist(t.pos, p) <= tiles) return true;
  return false;
}

/** How many of `threats` could see a man lying at `p` (dead ground and standing crops hide him). */
function seenBy(state: BattleState, threats: Vec2[], p: Vec2): number {
  let n = 0;
  for (const th of threats) if (dist(th, p) * TILE_M <= 400 && hasLOS(state.map, th, p, PRONE)) n++;
  return n;
}

/** Positions the enemy is known or suspected to hold around the objective: fresh contacts first,
 * then the objective itself (its owner is assumed to be sitting on it). Capped for LOS cost. */
function threatPoints(mem: SideMemory, state: BattleState, objective: Vec2, max = 4): Vec2[] {
  const cs = Array.from(mem.contacts.values())
    .filter((c) => state.time - c.at <= 90)
    // armour and machine guns first (they do the killing at range), then whatever is nearest the objective
    .sort((a, b) => Number(b.vehicleId != null || b.type === 'mg') - Number(a.vehicleId != null || a.type === 'mg')
      || dist(a.pos, objective) - dist(b.pos, objective) || a.teamId - b.teamId)
    .slice(0, max - 1)
    .map((c) => c.pos);
  cs.push(objective);
  return cs;
}

/** Likely defender cover around a VL: the best cover tiles within `r` tiles, a few apart. A pure
 * function of the map (no rng), so prep fire does not wander. */
function suspectedPositions(state: BattleState, vl: Vec2, r = 6, max = 3): Vec2[] {
  const cand: { p: Vec2; s: number }[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.floor(vl.x) + dx, y = Math.floor(vl.y) + dy;
      if (!inBounds(state.map, x, y) || dx * dx + dy * dy > r * r) continue;
      if (!isPassable(state.map, x, y, 'infantry')) continue;
      const p = { x: x + 0.5, y: y + 0.5 };
      const s = coverAt(state.map, p);
      if (s >= 0.3) cand.push({ p, s: s - Math.hypot(dx, dy) * 0.02 });
    }
  }
  cand.sort((a, b) => b.s - a.s || a.p.y - b.p.y || a.p.x - b.p.x);
  const out: Vec2[] = [];
  for (const c of cand) {
    if (out.every((o) => dist(o, c.p) >= 4)) out.push(c.p);
    if (out.length >= max) break;
  }
  if (!out.length) out.push({ x: vl.x, y: vl.y });
  return out;
}

// ------------------------------------------------------------------ objective, axis, budgets
function pickObjective(state: BattleState, side: Side, plan: AttackPlan, mem: SideMemory, from: Vec2): VictoryLocation | null {
  const enemyZone = zoneCentre(state.map.def.deployZones[otherSide(side)]);
  let best: VictoryLocation | null = null;
  let bestScore = -Infinity;
  for (const vl of state.map.victoryLocations) {
    if (vl.owner === side) continue;
    const p = { x: vl.x, y: vl.y };
    const dM = dist(from, p) * TILE_M;
    let score = vl.value * 45 - dM * 0.5 + Math.min(200, dist(p, enemyZone) * TILE_M) * 0.2;
    for (const c of mem.contacts.values()) {
      const dM2 = dist(c.pos, p) * TILE_M;
      // known defenders make an objective dearer, armour sitting on it much dearer
      if (c.vehicleId != null && c.type !== 'halftrack' ? dM2 <= 90 : dM2 <= 60) score -= c.vehicleId != null && c.type !== 'halftrack' ? 30 : 6;
    }
    const failedAt = plan.failed.get(vl.id);
    if (failedAt != null && state.time - failedAt < 400) score -= 120;
    if (score > bestScore || (score === bestScore && best && vl.id < best.id)) { bestScore = score; best = vl; }
  }
  return best;
}

/** Forming-up place: a covered spot about 100-120 m short of the objective, preferably out of its
 * sight, on an axis near the line from where the squads are now (so the whole force masses on
 * one approach instead of arriving from everywhere). Null when the squads are that close already. */
function chooseFup(state: BattleState, rng: Rng, from: Vec2, objective: Vec2, threats: Vec2[]): Vec2 | null {
  const d = dist(from, objective);
  if (d * TILE_M <= 140) return null;
  const back = angleTo(objective, from);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 36; i++) {
    const ang = back + (rng.next() - 0.5) * (Math.PI * 0.7);
    const r = rng.range(45, 60);
    const x = Math.floor(objective.x + Math.sin(ang) * r), y = Math.floor(objective.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'infantry')) continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    let cover = 0;
    for (let k = 0; k < 5; k++) {
      const q = { x: p.x + [0, 2, -2, 0, 0][k], y: p.y + [0, 0, 0, 2, -2][k] };
      cover += coverAt(state.map, q) + concealmentAt(state.map, q) * 0.5;
    }
    const score = cover * 1.2 - seenBy(state, threats, p) * 3 - dist(from, p) * 0.12;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// ------------------------------------------------------------------ bounds
/** `plan.posts` keys for a team's other remembered spots (team ids are far below these). */
const FOLLOW_KEY = 100000, FINAL_KEY = 200000, HUNT_KEY = 300000, REFUGE_KEY = 400000;
const BOUND_MAX_S = 40;
const FINAL_ASSAULT_TILES = 22;

/** Where a squad halts at the end of its next bound towards `goal`: forward progress, but into
 * cover, dead ground (not seen from the known enemy positions) or standing crops, and not on top
 * of another squad. `maxTiles` is the length of the rush. */
function chooseBoundPoint(
  state: BattleState, rng: Rng, from: Vec2, goal: Vec2, threats: Vec2[], taken: Vec2[], maxTiles: number, armour: Vec2[] = [],
): Vec2 | null {
  const toGoal = dist(from, goal);
  if (toGoal <= 5) return goal;
  const seenByArmour = (p: Vec2): boolean => armour.some((a) => dist(a, p) * TILE_M <= 300 && hasLOS(state.map, a, p, PRONE));
  const bearing = angleTo(from, goal);
  const maxR = Math.min(maxTiles, toGoal);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  let bestArmourSeen = false;
  for (let i = 0; i < 28; i++) {
    const ang = bearing + (rng.next() - 0.5) * (Math.PI * 0.55);
    const r = rng.range(Math.min(6, maxR), maxR);
    const x = Math.floor(from.x + Math.sin(ang) * r), y = Math.floor(from.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'infantry')) continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    const progress = toGoal - dist(p, goal);
    if (progress < 2) continue;
    // where the rush ENDS matters more than a few metres of ground: a halt in cover, in standing
    // crops or out of the enemy's sight is worth half a bound of progress
    let score = progress * 0.6 + coverAt(state.map, p) * 14 + concealmentAt(state.map, p) * 5;
    if (growthHeightAt(state.map, p.x, p.y) >= 0.8) score += 3;
    for (const o of taken) if (dist(o, p) < 5) score -= 8;
    best = best ?? p;
    if (score + 8 < bestScore) continue; // cannot win even if unseen: skip the LOS traces
    score += 8 - Math.min(3, seenBy(state, threats, p)) * 3;
    if (score <= bestScore) continue;
    const underArmour = armour.length > 0 && seenByArmour(p);
    if (underArmour) score -= 15;
    if (score > bestScore) { bestScore = score; best = p; bestArmourSeen = underArmour; }
  }
  // every halt ahead is under the guns of a tank we cannot hurt, and here we are out of its
  // sight: stay until it has been blinded, driven off or killed (the objective's clock still runs)
  if (best && bestArmourSeen && !seenByArmour(from)) return null;
  return best ?? goal;
}

/** A place within a few tiles to lie up in: cover, out of sight of the known enemy positions. */
function chooseHide(state: BattleState, rng: Rng, from: Vec2, threats: Vec2[]): Vec2 {
  let best = from;
  let bestScore = coverAt(state.map, from) * 7 + concealmentAt(state.map, from) * 3 - Math.min(3, seenBy(state, threats, from)) * 3 + 1;
  for (let i = 0; i < 20; i++) {
    const ang = rng.range(0, Math.PI * 2), r = rng.range(1, 9);
    const x = Math.floor(from.x + Math.sin(ang) * r), y = Math.floor(from.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'infantry')) continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    let score = coverAt(state.map, p) * 7 + concealmentAt(state.map, p) * 3 - r * 0.2;
    if (growthHeightAt(state.map, p.x, p.y) >= 0.8) score += 2.5;
    if (score + 0.01 < bestScore) continue;
    score -= Math.min(3, seenBy(state, threats, p)) * 3;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

function nearestSpottedSoldierWithin(state: BattleState, side: Side, from: Vec2, rangeM: number): boolean {
  const e = nearestSpottedSoldier(state, side, from);
  return !!e && dist(e.pos, from) * TILE_M <= rangeM;
}

function teamHasAntiTank(state: BattleState, t: Team): boolean {
  for (const id of t.soldierIds) {
    const s = state.soldiers.get(id);
    if (!alive(s)) continue;
    const w = WEAPONS[s.weaponId];
    if (w && (AT_CLASSES.has(w.cls) || w.penetrationMm >= 60)) return true;
  }
  return false;
}

function leaderFatigue(state: BattleState, t: Team): number {
  const l = state.soldiers.get(t.leaderId);
  return l ? l.fatigue : 0;
}

// ------------------------------------------------------------------ armour judgement
/** Odds that a round from `v`'s gun, fired from `from`, goes through the plate `ev` shows to that
 * spot (its hull facing as we see it: a flank or rear shot is a different matter from the front). */
function penOdds(state: BattleState, v: Vehicle, from: Vec2, ev: Vehicle): number {
  const def = VEHICLE_DEFS[v.defId], edef = VEHICLE_DEFS[ev.defId];
  const w = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : undefined;
  if (!w || !edef) return 0;
  const dM = Math.max(50, dist(from, ev.pos) * TILE_M);
  return bestRoundAgainst(w, dM, edef.armor[armorFacingFor(ev, from)], state.config.year).chance;
}

/** Would `v`, standing at `from` and facing `ev`, lose a gun duel with it? Penetration odds both
 * ways, and between comparable guns who gets the first aimed round off (gunTiming). */
function losesDuel(state: BattleState, v: Vehicle, ev: Vehicle, from: Vec2 = v.pos): boolean {
  const def = VEHICLE_DEFS[v.defId], edef = VEHICLE_DEFS[ev.defId];
  const ew = edef?.mainWeaponId ? WEAPONS[edef.mainWeaponId] : undefined;
  if (!def || !edef || !ew || ev.state === 'abandoned' || ev.state === 'burning' || ev.state === 'knockedOut') return false;
  const dM = Math.max(50, dist(from, ev.pos) * TILE_M);
  const theirs = bestRoundAgainst(ew, dM, def.armor.front, state.config.year).chance;
  if (theirs < 0.3) return false;
  const ours = penOdds(state, v, from, ev);
  if (ours < 0.25) return true;
  if (ours >= theirs) return false;
  // comparable guns: the one who lays first wins
  return timeToFirstShotS(state, v, ev.pos) > timeToFirstShotS(state, ev, v.pos) + 3;
}

/** The enemy vehicle of a contact AS IT WAS LAST SEEN (place and hull facing), for the duel and
 * fire-position sums: the AI never reads where an unseen vehicle really is now. */
function asSeen(state: BattleState, c: Contact): Vehicle | null {
  const ev = c.vehicleId != null ? state.vehicles.get(c.vehicleId) : undefined;
  if (!ev) return null;
  return { ...ev, pos: c.pos, hullFacing: c.hullFacing ?? ev.hullFacing };
}

/** Known enemy guns that would beat this vehicle (fresh contacts only). */
function duelThreats(state: BattleState, mem: SideMemory, v: Vehicle): Vec2[] {
  const out: Vec2[] = [];
  for (const c of mem.contacts.values()) {
    if (state.time - c.at > 90) continue;
    if (c.vehicleId != null) {
      const ev = asSeen(state, c);
      if (ev && losesDuel(state, v, ev)) out.push(c.pos);
    } else if (c.type === 'atgun' && dist(c.pos, v.pos) * TILE_M <= 500) {
      const def = VEHICLE_DEFS[v.defId];
      // a gun that has been seen is dangerous to thin plate only; heavy tanks shell it instead
      if (def && def.armor.front < 60) out.push(c.pos);
    }
  }
  return out;
}

/** A vehicle station near `anchor`: passable, out of sight of guns that beat it, with a line of
 * fire to `watch` (where the squads' fight is, or the objective). */
function chooseStation(state: BattleState, rng: Rng, anchor: Vec2, watch: Vec2[], avoid: Vec2[], others: Vec2[], maxR = 12): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 20; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = i === 0 ? 0 : rng.range(0, maxR);
    const x = Math.floor(anchor.x + Math.sin(ang) * r), y = Math.floor(anchor.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'vehicle')) continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    let score = -r * 0.4;
    if (others.some((o) => dist(o, p) < 2.5)) continue; // item 038: never station on a neighbour's spot
    if (score + 14 < bestScore) continue;
    let exposed = 0;
    for (const a of avoid) if (hasLOS(state.map, a, p)) exposed++;
    score -= exposed * 14;
    let sees = 0;
    for (const w of watch) if (hasLOS(state.map, p, w)) sees++;
    score += Math.min(2, sees) * 7;
    if (sees === 0) score -= 20; // item 038: a station that sees nothing is dead ground
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/** The nearest ground out of sight of every gun in `avoid`, preferring the way back. */
function chooseRefuge(state: BattleState, rng: Rng, from: Vec2, home: Vec2, avoid: Vec2[]): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  const homeward = angleTo(from, home);
  for (let i = 0; i < 30; i++) {
    const ang = i < 15 ? homeward + (rng.next() - 0.5) * Math.PI : rng.range(0, Math.PI * 2);
    const r = rng.range(3, 25);
    const x = Math.floor(from.x + Math.sin(ang) * r), y = Math.floor(from.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'vehicle')) continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    const score = -r;
    if (score <= bestScore) continue;
    if (avoid.some((a) => hasLOS(state.map, a, p))) continue;
    bestScore = score; best = p;
  }
  return best;
}

/** A fire position against the known enemy vehicle `ev`: a line of fire, decent odds of going
 * through the plate it shows to that spot (so a tank that cannot hurt it from the front works
 * round to its flank), out of sight of the other guns in `avoid`, clear of the other vehicles. */
function wrapAngleLocal(a: number): number { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

export const OUTCLASSED_DASH_TILES = 15;
/** A hunt/fire position may be this far from the vehicle (item 038): beyond that the tank advances
 * toward contact rather than driving half the map for one shot. */
export const HUNT_MAX_TRAVEL_TILES = 40;
/** Item 038: a vehicle that has had nothing it can fight or fire at for this long moves to a
 * position that restores sight instead of sitting blind. */
export const BLIND_REPOSITION_S = 12;
export const TANK_HUNT_LEASH_TILES = 40; // 80 m from the nearest friendly squad (the defence: from the point it guards)
function chooseFirePosition(state: BattleState, rng: Rng, v: Vehicle, ev: Vehicle, avoid: Vec2[], others: Vec2[], friends: Vec2[], maxTravelTiles = Infinity): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 28; i++) {
    // half the samples near where it stands now, half on a ring round the target
    const near = i % 2 === 0;
    const c = near ? v.pos : ev.pos;
    const ang = rng.range(0, Math.PI * 2), r = near ? rng.range(2, 20) : rng.range(30, 90);
    const x = Math.floor(c.x + Math.sin(ang) * r), y = Math.floor(c.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'vehicle')) continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    if (dist(p, v.pos) > maxTravelTiles) continue;
    // armour does not go off on its own: a fire position is within reach of the infantry
    if (friends.length && !friends.some((f) => dist(f, p) <= TANK_HUNT_LEASH_TILES)) continue;
    const odds = penOdds(state, v, p, ev);
    if (odds < 0.5) continue;
    let score = odds * 10 - dist(p, v.pos) * 0.25;
    for (const o of others) {
      if (dist(o, p) < 6) score -= 8;
      // it can only face one of us: come at it from another side than the tank already placed
      else if (dist(o, ev.pos) <= 100) score += Math.min(Math.PI / 2, Math.abs(wrapAngleLocal(angleTo(ev.pos, p) - angleTo(ev.pos, o)))) * 3;
    }
    if (score < bestScore) continue;
    if (!hasLOS(state.map, p, ev.pos)) continue;
    for (const a of avoid) if (dist(a, ev.pos) > 2 && hasLOS(state.map, a, p)) score -= 12;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/** Overwatch post for a support weapon: cover with a line of fire to the objective, 80-260 m out
 * and no further forward than the squads' forming-up distance. */
function chooseOverwatch(state: BattleState, rng: Rng, from: Vec2, objective: Vec2, minTiles: number, opts?: { vehicleMover?: boolean }): Vec2 | null {
  const dNow = dist(from, objective);
  const sightOk = (p: Vec2) => opts?.vehicleMover
    ? hasLineOfFire(state.map, p, objective, { eyeM: EYE_VEHICLE_M })
    : hasLOS(state.map, p, objective);
  if (dNow >= minTiles && dNow * TILE_M <= 320 && sightOk(from)) return from;
  const back = angleTo(objective, from);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 32; i++) {
    const ang = back + (rng.next() - 0.5) * (Math.PI * 0.8);
    const r = rng.range(minTiles, Math.max(minTiles + 10, Math.min(130, dNow)));
    const x = Math.floor(objective.x + Math.sin(ang) * r), y = Math.floor(objective.y - Math.cos(ang) * r);
    if (!inBounds(state.map, x, y) || !isPassable(state.map, x, y, 'infantry')) continue;
    const p = { x: x + 0.5, y: y + 0.5 };
    let score = coverAt(state.map, p) * 5 - dist(from, p) * 0.15;
    if (score + 8 < bestScore) continue;
    if (!sightOk(p)) continue;
    score += 8;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// ------------------------------------------------------------------ the attack
// The side attacking on a map (map.def.attacker) fights to a plan, one objective at a time:
//
//   prep         mortars, MGs and tank guns take the objective under fire — known contacts first,
//                else the likely cover on it — while the squads lie up out of sight (or move to a
//                forming-up place short of it). Lasts ~1 min; while enemy armour is seen near the
//                objective the tanks and AT guns fight that first, up to a fifth of the battle.
//   advance      the squads close to the forming-up place by bounds.
//   assault      two elements, one rushing from halt to halt (cover, dead ground, standing crops,
//                out of the known enemy's sight) while the other lies and covers; the mover starts
//                only on the decision AFTER the other has gone to ground. Mortar smoke covers the
//                last stretch; tanks keep station just behind the leading squad.
//   allIn        the objective has used up its time budget: everybody goes in together; if that
//                fails within ~2 min the objective is called off and the next one taken up.
//   consolidate  a minute on a captured objective (weakest squad stays as its garrison).
//   hold         the squads are spent (under 30 % of their men): they dig in; the gun tanks go on
//                to the objectives alone.
//
// Everything is decided from the side's own knowledge: `state.spotted*` and the contact memory.
// Decisions stay throttled to the battle's AI interval, and the costly choices (halts, stations,
// fire positions) are made once per bound / per objective, not every tick.
function newPlan(state: BattleState, assault: Team[]): AttackPlan {
  let men = 0;
  for (const t of assault) men += teamMen(state, t);
  return {
    phase: 'prep', phaseSince: state.time, objectiveId: null, objectiveSince: state.time, budgetS: 0, fup: null,
    bound: { mover: 0, since: state.time, targets: new Map(), settled: false },
    element: new Map(), failed: new Map(), posts: new Map(), missions: new Map(), smoked: new Set(),
    startMen: Math.max(1, men), objectivesTaken: 0, garrison: new Map(), blind: new Map(),
  };
}

function setPhase(plan: AttackPlan, state: BattleState, phase: AttackPhase): void {
  if (plan.phase === phase) return;
  plan.phase = phase;
  plan.phaseSince = state.time;
  plan.bound = { mover: plan.bound.mover, since: state.time, targets: new Map(), settled: false };
}

/** Preparation: support weapons and tank guns work the objective over before anybody crosses open
 * ground. Long enough for a mortar to lay and drop a few rounds, short against the battle clock. */
export const PREP_MAX_FRACTION = 0.2;
/** Pause on a captured objective before the next one: squads in cover, support brought up. */
export const CONSOLIDATE_S = 60;
function prepSeconds(state: BattleState): number { return Math.min(70, state.config.durationS * 0.06); }

function stepAttackAI(state: BattleState, rng: Rng, battle: AIBattle, side: Side, mem: SideMemory): void {
  const track = getOrderTrack(state);
  const enemy = otherSide(side);
  const myTeams = Array.from(state.teams.values()).filter((t) => t.side === side && !t.outOfAction).sort((a, b) => a.id - b.id);
  if (!myTeams.length) return;
  const ownZone = zoneCentre(state.map.def.deployZones[side]);
  const enemyZone = zoneCentre(state.map.def.deployZones[enemy]);
  const D = state.config.durationS;

  // ---- who does what
  const onFoot = myTeams.filter((t) => t.vehicleId == null && t.transportId == null);
  let assault = onFoot.filter((t) => t.type === 'rifle' || t.type === 'smg' || t.type === 'engineer');
  let support = onFoot.filter((t) => t.type === 'mg' || t.type === 'sniper' || t.type === 'command' || t.type === 'atteam');
  if (!assault.length) { assault = support.filter((t) => t.type !== 'mg'); support = support.filter((t) => t.type === 'mg'); }
  const mortars = onFoot.filter((t) => t.type === 'mortar');
  const atGuns = onFoot.filter((t) => t.type === 'atgun');
  const vehicleTeams = myTeams.filter((t) => t.vehicleId != null);
  if (!mem.plan) mem.plan = newPlan(state, assault);
  const plan = mem.plan;
  // squads holding what has been taken are out of the assault for as long as they can hold
  for (const [vlId, teamId] of plan.garrison) {
    const g = assault.find((t) => t.id === teamId);
    if (!g || isShaken(g)) plan.garrison.delete(vlId);
  }
  const garrisonIds = new Set(plan.garrison.values());
  const fit = assault.filter((t) => !isShaken(t) && !garrisonIds.has(t.id));

  // ---- objective: one at a time, for everybody
  const groupAt = centroidOf(fit.length ? fit : assault, ownZone);
  let objectiveVL = plan.objectiveId != null ? state.map.victoryLocations.find((v) => v.id === plan.objectiveId) ?? null : null;
  if (objectiveVL && objectiveVL.owner === side) {
    plan.objectivesTaken++;
    // consolidate: the weakest squad stays on the objective against the counter-attack
    if (fit.length >= 3 && plan.garrison.size < 2) {
      const weakest = fit.reduce((b, t) => (teamMen(state, t) < teamMen(state, b) ? t : b));
      plan.garrison.set(objectiveVL.id, weakest.id);
      fit.splice(fit.indexOf(weakest), 1);
    }
    objectiveVL = null;
  }
  if (!objectiveVL) {
    objectiveVL = pickObjective(state, side, plan, mem, groupAt);
    plan.objectiveId = objectiveVL ? objectiveVL.id : null;
    plan.objectiveSince = state.time;
    plan.smoked.clear();
    plan.missions.clear();
    if (objectiveVL) {
      const obj = { x: objectiveVL.x, y: objectiveVL.y };
      plan.fup = chooseFup(state, rng, groupAt, obj, threatPoints(mem, state, obj));
      plan.budgetS = Math.min(D * 0.45, Math.max(240, (dist(groupAt, obj) * TILE_M) / 0.8 + 200));
      // the first objective gets a preparation; later ones are attacked out of the last one,
      // after a pause on it to reorganise and meet the counter-attack from cover
      setPhase(plan, state, state.time < prepSeconds(state) ? 'prep' : plan.objectivesTaken > 0 && D - state.time > 240 ? 'consolidate' : 'advance');
    }
  }
  let men = 0;
  for (const t of assault) men += teamMen(state, t);
  if (!objectiveVL || men < plan.startMen * 0.3) setPhase(plan, state, 'hold');
  const objective = objectiveVL ? { x: objectiveVL.x, y: objectiveVL.y } : enemyZone;
  const threats = threatPoints(mem, state, objective);
  const lead = fit.length ? fit.reduce((b, t) => (dist(t.pos, objective) < dist(b.pos, objective) ? t : b)) : null;
  const leadDistM = lead ? dist(lead.pos, objective) * TILE_M : Infinity;

  // ---- phases on a clock: an attack that waits forever loses when time runs out
  // The preparation lasts until the enemy armour seen near the objective has been dealt with (the
  // tanks and the AT gun fight it, the mortars blind it) — but never beyond a fifth of the battle.
  if (plan.phase === 'prep' && state.time >= prepSeconds(state)) {
    const armourAbout = vehicleTeams.length + atGuns.length > 0 && Array.from(mem.contacts.values())
      .some((c) => c.vehicleId != null && c.type !== 'halftrack' && state.time - c.at <= 60 && dist(c.pos, objective) * TILE_M <= 300);
    if (!armourAbout || state.time >= D * PREP_MAX_FRACTION) { plan.phase = 'advance'; plan.phaseSince = state.time; }
  }
  if (plan.phase === 'consolidate' && state.time - plan.phaseSince >= CONSOLIDATE_S) setPhase(plan, state, 'advance');
  // with the squads spent the armour carries on alone against one objective at a time
  if (plan.phase === 'hold' && plan.objectiveId != null && state.time - plan.objectiveSince > 300) { plan.failed.set(plan.objectiveId, state.time); plan.objectiveId = null; }
  if (plan.phase === 'advance') {
    const fup = plan.fup;
    const there = fup ? fit.filter((t) => dist(t.pos, fup) <= 14 || dist(t.pos, objective) <= dist(fup, objective)).length : fit.length;
    if (!fup || there * 2 >= fit.length || state.time - plan.objectiveSince > 170) setPhase(plan, state, 'assault');
  }
  if (plan.phase === 'assault' && state.time - plan.objectiveSince > plan.budgetS) {
    if (leadDistM <= 160 && men >= plan.startMen * 0.5) setPhase(plan, state, 'allIn');
    else { plan.failed.set(plan.objectiveId!, state.time); plan.objectiveId = null; }
  }
  if (plan.phase === 'allIn' && state.time - plan.phaseSince > 130) { plan.failed.set(plan.objectiveId!, state.time); plan.objectiveId = null; }

  for (const t of assault) t.aiObjective = objective;

  // ---- shaken teams fall back; pinned ones are left to their own devices
  // (not a walk home across the ground they were just shot off: the nearest cover out of the
  // enemy's sight, where the men can pull themselves together)
  for (const t of onFoot) {
    if (!isShaken(t)) continue;
    let h = plan.posts.get(t.id);
    if (!h || h.objectiveId !== -6 || state.time - h.at > 40) { h = { objectiveId: -6, pos: chooseHide(state, rng, t.pos, threats), at: state.time }; plan.posts.set(t.id, h); }
    if (dist(h.pos, t.pos) > 2) tryIssueOrder(state, battle, track, t, { type: 'move', target: h.pos, issuedAt: state.time });
  }

  // ---- the assault squads: two elements, one moves while the other covers
  stepAssaultSquads(state, rng, battle, track, side, mem, plan, fit, objective, threats);

  for (const [vlId, teamId] of plan.garrison) {
    const g = assault.find((t) => t.id === teamId);
    const vl = state.map.victoryLocations.find((v) => v.id === vlId);
    if (!g || !vl || isPinned(g)) continue;
    let post = plan.posts.get(g.id);
    if (!post || post.objectiveId !== -10 - vlId) { post = { objectiveId: -10 - vlId, pos: bestCoverWithin(state, { x: vl.x, y: vl.y }, 3, rng, enemyZone), at: state.time }; plan.posts.set(g.id, post); }
    g.aiObjective = post.pos;
    if (dist(g.pos, post.pos) > 3) tryIssueOrder(state, battle, track, g, { type: 'move', target: post.pos, issuedAt: state.time });
    else tryIssueOrder(state, battle, track, g, { type: 'defend', target: enemyZone, issuedAt: state.time });
  }

  // ---- support weapons on overwatch
  const fupDistTiles = plan.fup ? dist(plan.fup, objective) : 45;
  for (const t of support) {
    if (isShaken(t) || isPinned(t)) continue;
    const near = nearestSpottedSoldier(state, side, t.pos);
    if (near && teamHasLOSToEnemy(state, t, near.pos) && dist(near.pos, t.pos) * TILE_M <= 400) {
      tryIssueOrder(state, battle, track, t, { type: 'fire', target: { ...near.pos }, targetTeamId: near.teamId, issuedAt: state.time });
      continue;
    }
    if (plan.phase === 'hold') { tryIssueOrder(state, battle, track, t, { type: 'defend', target: objective, issuedAt: state.time }); continue; }
    // MGs and snipers take a fire position onto the objective (chosen once per objective: an HMG
    // takes time to pack and set up); command and AT teams — and an MG for which no position with
    // a line of fire can be found — go with the squads, 30 m behind them, from cover to cover.
    let post = plan.posts.get(t.id);
    if ((!post || post.objectiveId !== plan.objectiveId) && t.type !== 'command' && t.type !== 'atteam') {
      const pos = chooseOverwatch(state, rng, t.pos, objective, Math.max(40, fupDistTiles));
      post = { objectiveId: plan.objectiveId ?? -1, pos: pos ?? t.pos, at: pos ? state.time : -1 };
      plan.posts.set(t.id, post);
    }
    let dest: Vec2;
    if (post && post.objectiveId === plan.objectiveId && post.at >= 0) dest = post.pos;
    else if (plan.phase === 'prep') dest = t.pos;
    else {
      const ang = angleTo(objective, groupAt);
      const behind = { x: groupAt.x + Math.sin(ang) * 15, y: groupAt.y - Math.cos(ang) * 15 };
      const prev = plan.posts.get(FOLLOW_KEY + t.id);
      if (prev && prev.objectiveId === plan.objectiveId && dist(prev.pos, behind) <= 12) dest = prev.pos;
      else { dest = bestCoverWithin(state, behind, 5, rng, objective); plan.posts.set(FOLLOW_KEY + t.id, { objectiveId: plan.objectiveId ?? -1, pos: dest, at: state.time }); }
    }
    t.aiObjective = dest;
    if (dist(t.pos, dest) > 6) { tryIssueOrder(state, battle, track, t, { type: 'move', target: dest, issuedAt: state.time }); continue; }
    // in position: an MG works over a fresh contact it can see the ground of, else watches
    if (t.type === 'mg') {
      const c = Array.from(mem.contacts.values())
        .filter((k) => k.vehicleId == null && state.time - k.at <= 60 && !friendlyWithin(fit, k.pos, 12) && teamHasLOSToEnemy(state, t, k.pos))
        .sort((a, b) => dist(a.pos, objective) - dist(b.pos, objective) || a.teamId - b.teamId)[0];
      if (c) { tryIssueOrder(state, battle, track, t, { type: 'fire', target: { ...c.pos }, issuedAt: state.time }); continue; }
    }
    tryIssueOrder(state, battle, track, t, { type: 'defend', target: objective, issuedAt: state.time });
  }

  // ---- AT guns cover the armour from where they are
  for (const t of atGuns) {
    if (isShaken(t) || isPinned(t)) continue;
    const v = nearestSpottedVehicle(state, side, 9999, t.pos);
    if (v && hasLOS(state.map, t.pos, v.pos)) tryIssueOrder(state, battle, track, t, { type: 'fire', target: { ...v.pos }, targetTeamId: v.teamId, issuedAt: state.time });
    else {
      const c = Array.from(mem.contacts.values()).filter((k) => k.vehicleId != null).sort((a, b) => b.at - a.at || a.teamId - b.teamId)[0];
      tryIssueOrder(state, battle, track, t, { type: 'defend', target: c ? { ...c.pos } : objective, issuedAt: state.time });
    }
  }

  // ---- mortars: HE on what is known or suspected, smoke for the last stretch
  for (const t of mortars) {
    if (isShaken(t) || isPinned(t)) continue;
    stepAttackMortar(state, battle, track, mem, plan, t, myTeams, fit, objective, leadDistM, lead);
  }

  // ---- vehicles: with the infantry, not ahead of it
  const stations: Vec2[] = [];
  const gunTeams = vehicleTeams.filter((t) => { const v = state.vehicles.get(t.vehicleId!); return v && VEHICLE_DEFS[v.defId]?.mainWeaponId; });
  for (const team of vehicleTeams) {
    const vehicle = state.vehicles.get(team.vehicleId!);
    if (!vehicle || vehicle.state === 'knockedOut' || vehicle.state === 'burning' || vehicle.state === 'abandoned') continue;
    if (passengerCapacity(vehicle) > 0 && plan.phase !== 'hold'
      && stepTransportAI(state, battle, track, side, team, vehicle, fit, enemyZone, rng)) continue;
    stepAttackVehicle(state, rng, battle, track, side, mem, plan, team, vehicle, gunTeams.indexOf(team), Math.max(1, gunTeams.length), fit, groupAt, lead, objective, ownZone, stations);
  }
}

function stepAssaultSquads(
  state: BattleState, rng: Rng, battle: AIBattle, track: Map<number, OrderRecord>, side: Side, mem: SideMemory,
  plan: AttackPlan, fit: Team[], objective: Vec2, threats: Vec2[],
): void {
  if (!fit.length) return;
  // stable elements; rebalanced only when one of them has nobody left
  for (const t of fit) if (!plan.element.has(t.id)) plan.element.set(t.id, (plan.element.size % 2) as 0 | 1);
  if (fit.length >= 2 && (fit.every((t) => plan.element.get(t.id) === 0) || fit.every((t) => plan.element.get(t.id) === 1))) {
    fit.forEach((t, i) => plan.element.set(t.id, (i % 2) as 0 | 1));
  }
  const b = plan.bound;
  const able = fit.filter((t) => !isPinned(t));

  const fightClose = (t: Team): boolean => {
    const e = nearestSpottedSoldier(state, side, t.pos);
    if (!e || dist(e.pos, t.pos) * TILE_M > 30 || !teamHasLOSToEnemy(state, t, e.pos)) return false;
    tryIssueOrder(state, battle, track, t, { type: 'fire', target: { ...e.pos }, targetTeamId: e.teamId, issuedAt: state.time });
    return true;
  };
  // enemy armour seen in the last few seconds, close enough to machine-gun a squad
  const armour = Array.from(mem.contacts.values())
    .filter((c) => c.vehicleId != null && c.type !== 'halftrack' && state.time - c.at <= 15)
    .map((c) => c.pos);
  const armourWide = Array.from(mem.contacts.values())
    .filter((c) => c.vehicleId != null && c.type !== 'halftrack' && state.time - c.at <= 40)
    .map((c) => c.pos);
  /** A squad with a tank looking at it from under 150 m, and nothing to hurt it with, gets out of
   * its sight (a wall, a fold, a house) instead of lying there to be shot. True when it is moving. */
  const duckArmour = (t: Team): boolean => {
    if (!armour.length || teamHasAntiTank(state, t)) return false;
    const seeing = armour.filter((a) => dist(a, t.pos) * TILE_M <= 150 && hasLOS(state.map, a, t.pos, PRONE));
    const prev = plan.posts.get(t.id);
    if (prev && prev.objectiveId === -4 && state.time - prev.at <= 25) {
      if (dist(t.pos, prev.pos) > 2) { tryIssueOrder(state, battle, track, t, { type: 'moveFast', target: prev.pos, issuedAt: state.time }); return true; }
      if (!seeing.length) return false;
    }
    if (!seeing.length) return false;
    const pos = chooseHide(state, rng, t.pos, seeing);
    if (dist(pos, t.pos) <= 2) return false;
    plan.posts.set(t.id, { objectiveId: -4, pos, at: state.time });
    tryIssueOrder(state, battle, track, t, { type: 'moveFast', target: pos, issuedAt: state.time });
    return true;
  };
  const cover = (t: Team): void => {
    if (duckArmour(t)) return;
    const e = nearestSpottedSoldier(state, side, t.pos);
    if (e && dist(e.pos, t.pos) * TILE_M <= 300 && teamHasLOSToEnemy(state, t, e.pos)) {
      tryIssueOrder(state, battle, track, t, { type: 'fire', target: { ...e.pos }, targetTeamId: e.teamId, issuedAt: state.time });
    } else tryIssueOrder(state, battle, track, t, { type: 'defend', target: objective, issuedAt: state.time });
  };

  if ((plan.phase === 'prep' && !plan.fup) || plan.phase === 'hold' || plan.phase === 'consolidate') {
    for (const t of able) {
      if (fightClose(t)) continue;
      if (plan.phase === 'prep') {
        // wait out the preparation lying in cover out of the enemy's sight, not standing about
        let w = plan.posts.get(t.id);
        if (!w || w.objectiveId !== -3) { w = { objectiveId: -3, pos: chooseHide(state, rng, t.pos, threats), at: state.time }; plan.posts.set(t.id, w); }
        if (dist(t.pos, w.pos) > 3) { tryIssueOrder(state, battle, track, t, { type: 'moveFast', target: w.pos, issuedAt: state.time }); continue; }
      }
      if (plan.phase === 'hold' || plan.phase === 'consolidate') {
        // hold what has been taken: the nearest cover, facing the enemy
        const prev = plan.posts.get(t.id);
        const pos = prev && prev.objectiveId === -2 && dist(prev.pos, t.pos) <= 8 ? prev.pos : bestCoverWithin(state, t.pos, 6, rng, objective);
        plan.posts.set(t.id, { objectiveId: -2, pos, at: state.time });
        if (dist(t.pos, pos) > 4) { tryIssueOrder(state, battle, track, t, { type: 'move', target: pos, issuedAt: state.time }); continue; }
      }
      // lying up before the attack: hold fire and stay down unless somebody comes close
      if (plan.phase === 'prep' && !nearestSpottedSoldierWithin(state, side, t.pos, 120)) tryIssueOrder(state, battle, track, t, { type: 'ambush', target: objective, issuedAt: state.time });
      else cover(t);
    }
    return;
  }

  if (plan.phase === 'allIn') {
    // the clock has run out on this objective: everybody goes in together, support firing
    for (const t of able) {
      if (fightClose(t)) continue;
      let tgt = b.targets.get(t.id);
      if (!tgt) { tgt = bestCoverWithin(state, objective, 3, rng, t.pos); b.targets.set(t.id, tgt); }
      tryIssueOrder(state, battle, track, t, { type: dist(t.pos, tgt) * TILE_M > 60 && leaderFatigue(state, t) < 60 ? 'moveFast' : 'move', target: tgt, issuedAt: state.time });
    }
    return;
  }

  // ---- advance / assault by bounds
  const goal = (plan.phase === 'advance' || plan.phase === 'prep') && plan.fup ? plan.fup : objective;
  const movers = able.filter((t) => plan.element.get(t.id) === b.mover);
  const coverers = able.filter((t) => plan.element.get(t.id) !== b.mover);
  const single = fit.length < 2;

  // is the bound over? (every mover has made its halt, or it has taken too long)
  if (b.targets.size > 0) {
    const done = movers.every((t) => { const tg = b.targets.get(t.id); return !tg || dist(t.pos, tg) <= 3; });
    if (done || state.time - b.since > BOUND_MAX_S || !movers.length) {
      plan.bound = { mover: single ? b.mover : ((1 - b.mover) as 0 | 1), since: state.time, targets: new Map(), settled: false };
      // the element that just arrived goes to ground and covers; the other one starts on the
      // NEXT decision, once these are down and firing
      for (const t of able) { if (!fightClose(t)) cover(t); }
      return;
    }
  } else if (!movers.length && state.time - b.since > 10) {
    plan.bound = { mover: (1 - b.mover) as 0 | 1, since: state.time, targets: new Map(), settled: false };
  }

  for (const t of coverers) { if (!fightClose(t)) cover(t); }

  const nb = plan.bound;
  const taken: Vec2[] = Array.from(nb.targets.values());
  for (const t of movers) {
    if (fightClose(t)) continue;
    let tgt = nb.targets.get(t.id);
    if (!tgt) {
      const toObj = dist(t.pos, objective);
      const contactNear = Array.from(mem.contacts.values()).some((c) => state.time - c.at <= 60 && dist(c.pos, t.pos) * TILE_M <= 220);
      if (goal === objective && toObj <= FINAL_ASSAULT_TILES) {
        // the last rush: onto the objective, each squad to one spot on it (kept while the fight
        // for it lasts, so that they do not mill about on it bound after bound)
        const key = FINAL_KEY + t.id;
        let on = plan.posts.get(key);
        if (!on || on.objectiveId !== plan.objectiveId) { on = { objectiveId: plan.objectiveId ?? -1, pos: bestCoverWithin(state, objective, 3, rng, t.pos), at: state.time }; plan.posts.set(key, on); }
        tgt = on.pos;
      }
      else {
        const bp = chooseBoundPoint(state, rng, t.pos, goal, threats, taken, contactNear ? 14 : 24, teamHasAntiTank(state, t) ? [] : armourWide);
        if (!bp) { cover(t); continue; }
        tgt = bp;
      }
      nb.targets.set(t.id, tgt);
      taken.push(tgt);
      if (nb.targets.size === 1) nb.since = state.time;
    }
    // short rushes: a running man is a poor target and is up for half the time of a walking one
    const type: OrderType = leaderFatigue(state, t) < 65 ? 'moveFast' : 'move';
    tryIssueOrder(state, battle, track, t, { type, target: tgt, issuedAt: state.time });
  }
}

function mortarRoundsLeft(state: BattleState, t: Team): number {
  let n = 0;
  for (const id of t.soldierIds) {
    const s = state.soldiers.get(id);
    if (alive(s) && WEAPONS[s.weaponId]?.cls === 'mortar') n += s.ammo + s.ammoReserve;
  }
  return n;
}

function stepAttackMortar(
  state: BattleState, battle: AIBattle, track: Map<number, OrderRecord>, mem: SideMemory, plan: AttackPlan,
  t: Team, myTeams: Team[], fit: Team[], objective: Vec2, leadDistM: number, lead: Team | null,
): void {
  const SAFE_TILES = 25; // 50 m from any of our own
  const cur = plan.missions.get(t.id);
  const stillGood = cur && state.time < cur.until && !friendlyWithin(myTeams, cur.pos, cur.smoke ? 8 : SAFE_TILES)
    && (cur.teamId == null || mem.contacts.has(cur.teamId));
  let mission: FireMission | null = stillGood ? cur! : null;
  const armourSeen = Array.from(mem.contacts.values()).some((c) => c.vehicleId != null && c.type !== 'halftrack' && state.time - c.at <= 45);
  if (mission && !mission.smoke && armourSeen) mission = null; // look again: blinding a tank comes first
  // shelling likely cover stops the moment there is something real to shoot at
  if (mission?.suspected && Array.from(mem.contacts.values()).some((c) => c.vehicleId == null && state.time - c.at <= 120)) mission = null;

  if (!mission) {
    const defenders = Array.from(mem.contacts.values()).filter((c) => c.vehicleId == null && state.time - c.at <= 120 && dist(c.pos, objective) * TILE_M <= 90);
    // smoke once per objective, when the squads are about to cross the last stretch under observed fire
    const smokeKey = `${t.id}:${plan.objectiveId}`;
    // lead within 25-130 m: the old 45 m floor meant a lead squad already at the trench lip
    // (or, on korsun, one dead inside the belt) starved the FOLLOWING squads of smoke, so the
    // assault crossed the last 45 m of open snow bare and was shredded (smokeRounds=0 in 2 of 3
    // korsun runs). 25 m keeps a screen in front of the close-in squads too.
    if ((plan.phase === 'assault' || plan.phase === 'allIn') && lead && leadDistM <= 130 && leadDistM >= 25 && defenders.length && !plan.smoked.has(smokeKey)) {
      const c = defenders.sort((a, b) => dist(a.pos, lead.pos) - dist(b.pos, lead.pos) || a.teamId - b.teamId)[0];
      const ang = angleTo(c.pos, lead.pos);
      const p = { x: c.pos.x + Math.sin(ang) * 8, y: c.pos.y - Math.cos(ang) * 8 }; // 16 m in front of them
      if (!friendlyWithin(myTeams, p, 8)) { mission = { pos: p, until: state.time + 40, smoke: true, teamId: null }; plan.smoked.add(smokeKey); }
    }
    if (!mission) {
      // enemy armour with its guns on our squads, that our own tanks cannot deal with from the
      // front: blind it (a screen just on our side of it)
      const tank = Array.from(mem.contacts.values())
        .filter((c) => c.vehicleId != null && state.time - c.at <= 45 && c.type !== 'halftrack' && dist(c.pos, t.pos) * TILE_M >= 70)
        .filter((c) => fit.some((f) => dist(f.pos, c.pos) * TILE_M <= 350 && hasLOS(state.map, c.pos, f.pos)))
        .sort((a, b) => dist(a.pos, objective) - dist(b.pos, objective) || a.teamId - b.teamId)[0];
      const busy = Array.from(plan.missions.values()).filter((m) => m.smoke && m.teamId === tank?.teamId && state.time < m.until).length;
      if (tank && busy < 1) {
        const from = centroidOf(fit, t.pos);
        const ang = angleTo(tank.pos, from);
        const p = { x: tank.pos.x + Math.sin(ang) * 6, y: tank.pos.y - Math.cos(ang) * 6 };
        if (!friendlyWithin(myTeams, p, 8)) mission = { pos: p, until: state.time + 50, smoke: true, teamId: tank.teamId };
      }
    }
    if (!mission) {
      const rank = (c: Contact): number => (isSpottedNow(c, state) ? 0 : 40) + (state.time - c.at) * 0.3
        + dist(c.pos, objective) * TILE_M * 0.15 - (c.type === 'mg' || c.type === 'atgun' || c.type === 'mortar' ? 25 : 0);
      const c = Array.from(mem.contacts.values())
        .filter((k) => k.vehicleId == null && state.time - k.at <= 120 && !friendlyWithin(myTeams, k.pos, SAFE_TILES) && dist(k.pos, t.pos) * TILE_M >= 70)
        .sort((a, b) => rank(a) - rank(b) || a.teamId - b.teamId)[0];
      if (c) mission = { pos: { ...c.pos }, until: state.time + 45, smoke: false, teamId: isSpottedNow(c, state) ? c.teamId : null };
    }
    if (!mission && plan.phase !== 'hold' && mortarRoundsLeft(state, t) > 18) {
      // nothing seen yet: the likely cover on the objective gets the preparation. The old
      // `leadDistM > 90` gate meant a close objective (the relief's first, the crossroads 20
      // tiles from the German line) got no prep at all: the mortar sat on 39 rounds all battle
      // while the squads walked into an un-blinded trench belt and died in the first 200 s
      // (korsun harness: mortarShots A=0, smokeRounds 0, all 34-37 attacker falls by 200 s).
      // SAFE_TILES (25 = 50 m) is right for aimed fire missions, but the suspected spots sit on
      // the objective itself, which the assault's own squads often approach to within 20-45 m
      // (korsun: the crossroads lay inside the German zone) — at 50 m every spot got filtered
      // away and the mortar sat on its full rack all battle. 20 tiles (40 m) keeps the rounds
      // off the squads' heads while letting the prep land on the objective.
      const spots = suspectedPositions(state, objective).filter((p) => !friendlyWithin(myTeams, p, 20));
      if (spots.length) mission = { pos: spots[(t.id + Math.floor(state.time / 60)) % spots.length], until: state.time + 60, smoke: false, teamId: null, suspected: true };
    }
    if (mission) plan.missions.set(t.id, mission); else plan.missions.delete(t.id);
  }
  if (!mission) {
    const belief = mortarBeliefAimFor(state, t);
    if (belief && !friendlyWithin(myTeams, belief, SAFE_TILES)) tryIssueOrder(state, battle, track, t, { type: 'fire', target: { x: belief.x, y: belief.y }, issuedAt: state.time });
    else tryIssueOrder(state, battle, track, t, { type: 'defend', target: objective, issuedAt: state.time });
    return;
  }
  if (mission.smoke) tryIssueOrder(state, battle, track, t, { type: 'smoke', target: mission.pos, issuedAt: state.time });
  else tryIssueOrder(state, battle, track, t, { type: 'fire', target: mission.pos, targetTeamId: mission.teamId ?? undefined, issuedAt: state.time });
}

/** Tanks and guns on tracks: fight what they can see (and can beat), shell the objective before
 * the squads cross, and otherwise keep station just behind the leading squads. */
export const TANK_STATION_BEHIND_TILES = 8;
export const TANK_STATION_SPREAD_TILES = 9;

function stepAttackVehicle(
  state: BattleState, rng: Rng, battle: AIBattle, track: Map<number, OrderRecord>, side: Side, mem: SideMemory, plan: AttackPlan,
  team: Team, vehicle: Vehicle, idx: number, count: number, fit: Team[], groupAt: Vec2, lead: Team | null,
  objective: Vec2, ownZone: Vec2, stations: Vec2[],
): void {
  const def = VEHICLE_DEFS[vehicle.defId];
  const weapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
  const canMove = vehicle.state === 'ok';

  if (weapon && !mainGunUsable(vehicle)) {
    if (canMove && dist(vehicle.pos, ownZone) > 6) tryIssueOrder(state, battle, track, team, { type: 'moveFast', target: ownZone, issuedAt: state.time });
    return;
  }
  const avoid = weapon ? duelThreats(state, mem, vehicle) : Array.from(mem.contacts.values()).filter((c) => c.antiTank && state.time - c.at <= 90).map((c) => c.pos);
  const exposedTo = avoid.filter((a) => hasLOS(state.map, a, vehicle.pos));

  // item 038: the sight of enemy armour is needed both by the fight branch below and by the
  // blind-reposition loop further down; compute it once.
  const spottedArmour = weapon && weapon.penetrationMm > 0 ? nearestSpottedVehicle(state, side, weapon.rangeM, vehicle.pos) : null;
  const seesArmour = !!spottedArmour && hasLOS(state.map, vehicle.pos, spottedArmour.pos);

  // 1. enemy armour in sight that it can fight: halt and fight it
  if (weapon && weapon.penetrationMm > 0) {
    const ev = spottedArmour;
    // (not while another gun that beats it has it in its sights: then it gets out of that first)
    if (ev && seesArmour && (!canMove || (!losesDuel(state, vehicle, ev) && !exposedTo.length))) {
      plan.posts.delete(HUNT_KEY + team.id);
      tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...ev.pos }, targetTeamId: ev.teamId, issuedAt: state.time });
      return;
    }
  }
  if (!canMove) {
    const e = nearestSpottedSoldier(state, side, vehicle.pos);
    if (e && hasLOS(state.map, vehicle.pos, e.pos)) tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...e.pos }, targetTeamId: e.teamId, issuedAt: state.time });
    return;
  }

  // ---- station: just behind the leading squads, abreast of the other vehicles
  // (with the squads spent — phase 'hold' — the gun tanks go on to the objective themselves: a
  // vehicle takes a victory location as well as a rifleman does)
  const exploiting = plan.phase === 'hold' && plan.objectiveId != null && !!weapon;
  const anchorBase = exploiting ? objective : lead && plan.phase !== 'prep' ? lead.pos : groupAt;
  const back = angleTo(objective, exploiting ? ownZone : anchorBase);
  const lateral = (idx - (count - 1) / 2) * (exploiting ? 3 : TANK_STATION_SPREAD_TILES) * (weapon ? 1 : 0.5);
  const behind = exploiting ? 0 : TANK_STATION_BEHIND_TILES + (weapon ? 0 : 10);
  const anchor = {
    x: anchorBase.x + Math.sin(back) * behind + Math.cos(back) * lateral,
    y: anchorBase.y - Math.cos(back) * behind + Math.sin(back) * lateral,
  };
  let post = plan.posts.get(team.id);
  const stale = !post || post.objectiveId !== plan.objectiveId || dist(post.pos, anchor) > 10 || state.time - post.at > 60
    || avoid.some((a) => hasLOS(state.map, a, post!.pos));
  if (stale) {
    const watch = Array.from(mem.contacts.values())
      .filter((c) => c.vehicleId == null && state.time - c.at <= 60)
      .sort((a, b) => dist(a.pos, anchorBase) - dist(b.pos, anchorBase) || a.teamId - b.teamId)
      .slice(0, 2).map((c) => c.pos);
    watch.push(objective);
    // item 038: the tank also wants sight of enemy armour — those are the contacts that kill it
    for (const c of mem.contacts.values()) if (c.vehicleId != null && state.time - c.at <= 60) watch.push(c.pos);
    const p = chooseStation(state, rng, anchor, watch, avoid, stations, exploiting ? 4 : 12);
    if (p) { post = { objectiveId: plan.objectiveId ?? -1, pos: p, at: state.time }; plan.posts.set(team.id, post); }
  }
  const station = post?.pos ?? vehicle.pos;
  stations.push(station);
  team.aiObjective = station;
  const atStation = dist(vehicle.pos, station) <= 5;

  // 1b. known enemy armour with no line of fire from here (or none that would go through): work
  // round to a position from which the gun can hurt it. Every tank that can does so together.
  if (weapon && weapon.penetrationMm > 0) {
    const prey = Array.from(mem.contacts.values())
      .filter((c) => c.vehicleId != null && state.time - c.at <= 75 && dist(c.pos, vehicle.pos) * TILE_M <= 450)
      .map((c) => asSeen(state, c))
      .filter((ev): ev is Vehicle => !!ev && ev.state !== 'abandoned' && !!VEHICLE_DEFS[ev.defId]?.mainWeaponId)
      .sort((a, b) => dist(a.pos, vehicle.pos) - dist(b.pos, vehicle.pos) || a.id - b.id)[0];
    if (prey) {
      let hunt = plan.posts.get(HUNT_KEY + team.id);
      if (!hunt || hunt.objectiveId !== prey.teamId || state.time - hunt.at > 45 || penOdds(state, vehicle, hunt.pos, prey) < 0.4
        || (dist(hunt.pos, vehicle.pos) <= 2 && !hasLOS(state.map, vehicle.pos, prey.pos))) {
        const friends = fit.length ? fit.map((f) => f.pos) : [groupAt];
        // a tank that cannot hurt it from the front does not drive round it in the open: it takes a
        // flank shot only from a position a short dash away (the enemy comes past; it lies in wait)
        const frontal = bestRoundAgainst(weapon, Math.max(50, dist(vehicle.pos, prey.pos) * TILE_M), VEHICLE_DEFS[prey.defId]!.armor.front, state.config.year).chance;
        const p = chooseFirePosition(state, rng, vehicle, prey, avoid.filter((a) => dist(a, prey.pos) > 2), stations, friends, frontal < 0.25 ? OUTCLASSED_DASH_TILES : HUNT_MAX_TRAVEL_TILES);
        hunt = p ? { objectiveId: prey.teamId, pos: p, at: state.time } : undefined;
        if (hunt) plan.posts.set(HUNT_KEY + team.id, hunt); else plan.posts.delete(HUNT_KEY + team.id);
      }
      if (hunt) {
        stations.push(hunt.pos);
        team.aiObjective = hunt.pos;
        if (dist(hunt.pos, vehicle.pos) > 2) tryIssueOrder(state, battle, track, team, { type: 'move', target: hunt.pos, issuedAt: state.time });
        else tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...prey.pos }, targetTeamId: prey.teamId, issuedAt: state.time });
        return;
      }
    }
  }

  // 2. in the sights of a gun that beats it: get out of its line of fire — to the station if that
  // is out of its sight, else to the nearest ground that is (a wider search, back the way it came)
  if (exposedTo.length) {
    const stationSafe = !avoid.some((a) => hasLOS(state.map, a, station));
    if (stationSafe && !atStation) {
      tryIssueOrder(state, battle, track, team, { type: 'moveFast', target: station, issuedAt: state.time });
      return;
    }
    if (!stationSafe) {
      let refuge = plan.posts.get(REFUGE_KEY + team.id);
      if (!refuge || state.time - refuge.at > 30 || avoid.some((a) => hasLOS(state.map, a, refuge!.pos))) {
        const p = chooseRefuge(state, rng, vehicle.pos, ownZone, avoid);
        refuge = p ? { objectiveId: -8, pos: p, at: state.time } : undefined;
        if (refuge) plan.posts.set(REFUGE_KEY + team.id, refuge);
      }
      if (refuge && dist(refuge.pos, vehicle.pos) > 2) {
        team.aiObjective = refuge.pos;
        tryIssueOrder(state, battle, track, team, { type: 'moveFast', target: refuge.pos, issuedAt: state.time });
        return;
      }
    }
  }

  // 3. infantry in sight: shoot from the halt when on station, on the move otherwise
  const e = nearestSpottedSoldier(state, side, vehicle.pos);
  const eM = e ? dist(e.pos, vehicle.pos) * TILE_M : Infinity;
  const farBehind = dist(vehicle.pos, station) > 14;
  if (e && eM <= 350 && !farBehind && hasLOS(state.map, vehicle.pos, e.pos)) {
    tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...e.pos }, targetTeamId: e.teamId, issuedAt: state.time });
    return;
  }

  // 4. on station with nothing in sight: shell known positions, then likely cover on the
  // objective, while the squads are still short of it (keeping rounds for what turns up)
  if (weapon && atStation && plan.phase !== 'hold' && weapon.heRadiusM > 0 && vehicle.mainAmmo > (def?.mainAmmo ?? 0) * 0.45) {
    const known = Array.from(mem.contacts.values())
      .filter((c) => c.vehicleId == null && state.time - c.at <= 90)
      .sort((a, b) => a.at === b.at ? a.teamId - b.teamId : b.at - a.at)
      .map((c) => c.pos);
    const suspected = plan.phase === 'prep' || dist(groupAt, objective) * TILE_M > 80 ? suspectedPositions(state, objective) : [];
    for (const p of [...known, ...suspected].slice(0, 5)) {
      if (dist(p, vehicle.pos) * TILE_M > Math.min(weapon.rangeM, 500) || friendlyWithin(fit, p, 15)) continue;
      if (!hasLOS(state.map, vehicle.pos, p)) continue;
      tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...p }, issuedAt: state.time });
      return;
    }
  }

  // 4b. item 038: a vehicle that can neither fight what it sees nor fire at anything it believes
  // in does not sit in dead ground. After a while it moves to a position that restores sight —
  // overwatch toward the freshest known contact, else toward the objective (advance to contact).
  const canFight = seesArmour || (!!e && eM <= 350 && hasLOS(state.map, vehicle.pos, e.pos));
  const canShell = !canFight && !!vehicleAreaTarget(state, vehicle, weapon?.rangeM ?? 400);
  if (canFight || canShell) plan.blind.delete(team.id);
  else if (canMove && plan.phase !== 'hold') {
    const since = plan.blind.get(team.id);
    if (since == null) plan.blind.set(team.id, state.time);
    else if (state.time - since >= BLIND_REPOSITION_S && atStation && vehicle.path.length === 0) {
      const fresh = Array.from(mem.contacts.values())
        .filter((c) => state.time - c.at <= 60)
        .sort((a, b) => b.at - a.at || a.teamId - b.teamId);
      const watchPoint = fresh[0]?.pos ?? objective;
      // item 038: an armoured overwatch post is only worth holding with a clear gun line (the
      // tank can see but not shoot = hull-down): require the gun to reach the watch point.
      const post = chooseOverwatch(state, rng, vehicle.pos, watchPoint, 6, { vehicleMover: true });
      if (post && dist(post, vehicle.pos) > 4) {
        plan.blind.delete(team.id);
        team.aiObjective = post;
        tryIssueOrder(state, battle, track, team, { type: 'move', target: post, issuedAt: state.time });
        return;
      }
    }
  }

  // 5. keep station
  if (!atStation) {
    const near = Array.from(mem.contacts.values()).some((c) => state.time - c.at <= 60 && dist(c.pos, vehicle.pos) * TILE_M <= 250);
    tryIssueOrder(state, battle, track, team, { type: near ? 'move' : 'moveFast', target: station, issuedAt: state.time });
  } else {
    tryIssueOrder(state, battle, track, team, { type: 'defend', target: objective, issuedAt: state.time });
  }
}
