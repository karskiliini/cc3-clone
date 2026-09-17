import type {
  BattleState, Order, OrderType, Rect, Side, Soldier, Team, Vec2, Vehicle, VictoryLocation,
} from '@/shared/types';
import { otherSide, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, dist } from '@/shared/math';
import { inBounds, coverAt, concealmentAt, groundAtTile } from './map';
import { isPassable } from './path';
import { spaceOutVehicles } from './spawn';
import { mainGunUsable } from './vehicleDamage';
import { hasLOS } from './los';
import { VEHICLE_DEFS } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { mortarBeliefAimFor } from './combat';
import { canTeamMount, passengerCapacity, passengersAboard, roomLeft } from './transport';

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
    if (!v || v.state === 'knockedOut') continue;
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
    const x = Math.floor(from.x + Math.cos(ang) * r);
    const y = Math.floor(from.y + Math.sin(ang) * r);
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

function tryIssueOrder(state: BattleState, battle: AIBattle, track: Map<number, OrderRecord>, team: Team, order: Order): void {
  const key = `${order.type}:${Math.round(order.target.x)},${Math.round(order.target.y)}`;
  const last = track.get(team.id);
  if (last && last.key === key && state.time - last.at < 15) return;
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
      const score = isVehicle ? nearRoadTile(state, x, y) : coverAt(state.map, pos) >= 0.3 ? 1 + coverAt(state.map, pos) : coverAt(state.map, pos);
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
export function stepAI(state: BattleState, rng: Rng, battle: AIBattle, side: Side): void {
  let counters = callCounters.get(state);
  if (!counters) { counters = new Map(); callCounters.set(state, counters); }
  const n = (counters.get(side) ?? 0) + 1;
  counters.set(side, n);
  if (state.config.difficulty === 'easy' && n % 2 === 0) return;

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

  /** Team `preferredIdx` picks its primary target at a fixed slot in the invariant `allVLsSorted`
   * list, then walks forward (wrapping) to the nearest slot matching `wantOwnedBySide` — so a
   * team's objective only moves when ITS OWN target's ownership changes, not whenever some other
   * VL elsewhere on the map is captured/lost. */
  function pickVL(preferredIdx: number, wantOwnedBySide: boolean): VictoryLocation | null {
    const n = allVLsSorted.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i++) {
      const vl = allVLsSorted[(preferredIdx + i) % n];
      if ((vl.owner === side) === wantOwnedBySide) return vl;
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
      if (vehicle) {
        tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...vehicle.pos }, issuedAt: state.time });
      } else {
        const pos = goodCoverNearRoad(state, enemyZoneCentre, rng);
        team.aiObjective = pos;
        tryIssueOrder(state, battle, track, team, { type: 'ambush', target: enemyZoneCentre, issuedAt: state.time });
      }
      continue;
    }

    if (team.type === 'mortar') {
      const cluster = findClusterTarget(state, enemy);
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
    if (defenders.has(team.id)) {
      const dIdx = defenderTeams.indexOf(team);
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
        tryIssueOrder(state, battle, track, team, { type: 'move', target: pos, issuedAt: state.time });
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

  // vehicles move with nearest attacking infantry team and engage
  for (const team of vehicleTeams) {
    const vehicle = state.vehicles.get(team.vehicleId!);
    if (!vehicle || vehicle.state === 'knockedOut' || vehicle.state === 'burning' || vehicle.state === 'abandoned') continue;
    if (passengerCapacity(vehicle) > 0 && stepTransportAI(state, battle, track, side, team, vehicle, attackerTeams, enemyZoneCentre, rng)) continue;

    const enemyVehicle = nearestSpottedVehicle(state, side, 300, vehicle.pos);
    const enemySoldier = nearestSpottedSoldier(state, side, vehicle.pos);
    const target = enemyVehicle ?? enemySoldier;

    if (vehicle.state === 'immobilized') {
      if (target) tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...target.pos }, issuedAt: state.time });
      continue;
    }

    // a tank whose main gun is destroyed is pulled back out of the fight (it keeps its MG for
    // self-defence on the way)
    if (VEHICLE_DEFS[vehicle.defId]?.mainWeaponId && !mainGunUsable(vehicle)) {
      if (dist(vehicle.pos, ownZoneCentre) > 6) tryIssueOrder(state, battle, track, team, { type: 'moveFast', target: ownZoneCentre, issuedAt: state.time });
      continue;
    }

    if (target && dist(vehicle.pos, target.pos) * TILE_M <= 300) {
      tryIssueOrder(state, battle, track, team, { type: 'fire', target: { ...target.pos }, issuedAt: state.time });
      continue;
    }

    // Balance round 4: with no direct enemy vehicle/soldier target, put HE on a defended VL that's
    // still out of our attacking infantry's 150 m contact range, rather than only advancing — a
    // tank's main gun is exactly the kind of asset that should suppress/damage a held position
    // before infantry have to cross open ground into it.
    const def = VEHICLE_DEFS[vehicle.defId];
    const mainWeapon = def?.mainWeaponId ? WEAPONS[def.mainWeaponId] : null;
    if (mainWeapon) {
      const defended = findDefendedObjective(state, side, allVLsSorted);
      if (defended) {
        const point = { x: defended.x, y: defended.y };
        const distM = dist(vehicle.pos, point) * TILE_M;
        const attackersFar = nearestAttackerDistToPoint(attackerTeams, point) > 150;
        if (attackersFar && distM <= mainWeapon.rangeM) {
          // Balance fix: same precision-targeting fix as the mortar's prep fire above — aim at the
          // spotted defenders near the VL, not the bare VL tile.
          const preciseTarget = preciseFireTarget(state, side, point, 10);
          tryIssueOrder(state, battle, track, team, { type: 'fire', target: preciseTarget, issuedAt: state.time });
          continue;
        }
      }
    }

    const infTeam = nearestAttackingInfantryTeam(myTeams, team);
    const objective = infTeam?.aiObjective ?? enemyZoneCentre;
    team.aiObjective = objective;
    // Balance round 3: tanks lead the advance rather than plod at infantry pace — a vehicle can
    // only ever be routed over terrain it's already allowed on (woods/buildings are impassable to
    // it), so there's no risk of moveFast rushing it somewhere infantry-only cover would matter.
    // This used to only apply on 'hard' difficulty; mechanized forces should press forward on any
    // difficulty when they have no immediate target.
    tryIssueOrder(state, battle, track, team, { type: 'moveFast', target: objective, issuedAt: state.time });
  }
}
