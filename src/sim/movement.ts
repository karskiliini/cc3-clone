import type { BattleState, GameMap, Soldier, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, dist, facingAngle, facingFromAngle, pointInRect, vadd, vnorm, vscale, vsub } from '@/shared/math';
import { coverAt, groundHeightAt, inBounds, tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';
import { findPath, isPassable } from './path';
import { isFirstFireFrozen } from './mind';
import { soldierMineCheck, clearMineNear } from './mines';
import { cutWireNear, wireSpeedMul } from './wire';
import { stepCrewWeapons, isHeldForPacking, isHaulingGun } from './crewWeapon';
import { stepOrderWaypoints } from './orders';
import { isDazed, stepDazed } from './daze';
import { INFANTRY_PACE, infantrySpeedMs } from './infantryPace';
import { stepHitTheDirt } from './hitTheDirt';

const SPEEDS: Record<string, number> = {
  moving: INFANTRY_PACE.walk,
  movingFast: INFANTRY_PACE.run,
  sneaking: INFANTRY_PACE.crouch,
  panicked: INFANTRY_PACE.flee,
  routed: INFANTRY_PACE.run,
};

/** Slope speed model. grade = rise/run along the direction of travel. Uphill costs
 * `1 - grade*GRADE_UPHILL` down to GRADE_FLOOR (a 46% climb halves you); downhill gives back a
 * little, capped at GRADE_MAX. Vehicles use a harsher coefficient (see vehicle.ts). */
export const GRADE_FLOOR = 0.45;
export const GRADE_MAX = 1.1;
export const GRADE_UPHILL_INFANTRY = 1.2;
export const GRADE_UPHILL_VEHICLE = 1.9;

/** Speed multiplier for travelling `distTiles` from `a` to `b` over the map's relief. Returns 1
 * on a flat map (no `map.ground`), so nothing changes there. */
export function gradeSpeedMul(map: GameMap, a: Vec2, b: Vec2, coeff = GRADE_UPHILL_INFANTRY): number {
  if (!map.ground) return 1;
  const runM = Math.hypot(b.x - a.x, b.y - a.y) * TILE_M;
  if (runM < 1e-3) return 1;
  const grade = (groundHeightAt(map, b) - groundHeightAt(map, a)) / runM;
  const m = 1 - grade * coeff;
  return m < GRADE_FLOOR ? GRADE_FLOOR : m > GRADE_MAX ? GRADE_MAX : m;
}

const REPATH_INTERVAL_S = 3;
/** Sprint of a man throwing himself clear of a vehicle, m/s. */
const DODGE_SPEED_MS = INFANTRY_PACE.dodge;
const NEAR_ENEMY_RADIUS_TILES = 15;

/** Advances all soldiers along their current paths, drives panicked/routed flight behaviour,
 * updates facing/animation/fatigue/cover, and gently separates overlapping soldiers. */
export function stepMovement(state: BattleState, rng: Rng, dt: number): void {
  // Crew-served weapons: set-up/packing transitions and the fire gate (before anyone moves, so a
  // crew that has just been ordered off holds still while it packs).
  stepCrewWeapons(state, dt);
  // Move orders with Shift-click waypoints: drop the ones the team has reached (paths were routed
  // through every waypoint in turn by orders.ts, so this only keeps order.waypoints current).
  stepOrderWaypoints(state);
  // dazed by a blast (sim/daze.ts): the self-preservation crawl; nobody else moves these men
  stepDazed(state, rng, dt);
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated') continue;

    if (s.vehicleId != null) {
      const veh = state.vehicles.get(s.vehicleId);
      if (veh) s.pos = { x: veh.pos.x, y: veh.pos.y };
      continue;
    }

    // on a hatch, half out of the vehicle (sim/vehicleCrew.ts, spec 2026-09-17 §10): exposed, and
    // moved by the climb itself
    if (s.hatch) { s.cover = 0; s.animFrame = 0; continue; }

    s.cover = coverAt(state.map, s.pos);
    // just out of a vehicle in a panic: a short dash clear of it before his mind takes over again
    if (s.bailRun) {
      if (state.time >= s.bailRun.until || dist(s.pos, s.bailRun.to) < 0.2 || (s.stunnedUntil != null && state.time < s.stunnedUntil)) s.bailRun = undefined;
      else { s.path = [s.bailRun.to]; s.stance = 'standing'; moveAlongPath(state, s, SPEEDS.panicked, dt, rng); s.animFrame = Math.floor(state.time / 0.15) % 2; continue; }
    }
    // knocked down by a blast (spec 2026-09-17 §4): lies where he landed until the stun ends
    if (s.stunnedUntil != null && state.time < s.stunnedUntil) { s.animFrame = 0; continue; }
    // ...and then dazed: moved only by his own crawl for cover (stepDazed above)
    if (isDazed(s, state.time)) continue;

    // stooping over an item on the ground (sim/pickup.ts, spec 2026-09-17 §9): holds still
    if (s.pickup?.until != null) { s.animFrame = 0; continue; }

    // First-fire shock (spec §11): frozen soldiers do not move at all.
    if (isFirstFireFrozen(state, s.id)) continue;

    // leaping out of a vehicle's way (spec 2026-09-17 §7): a short sprint whatever else he was doing
    if (s.dodgeUntil != null) {
      if (state.time >= s.dodgeUntil || s.path.length === 0) s.dodgeUntil = undefined;
      else { moveAlongPath(state, s, DODGE_SPEED_MS, dt, rng); s.animFrame = Math.floor(state.time / 0.15) % 2; continue; }
    }

    // Pause the movement order while the man raises and steadies his weapon. Keeping his path
    // and activity lets him continue the bound after combat releases the aim.
    if (s.aiming || (s.smgBurst && state.time < s.smgBurst.until)) { s.animFrame = 0; continue; }

    if (s.activity === 'panicked') handleFleeing(state, s, dt);
    else if (s.activity === 'routed') handleRouting(state, s, dt);

    applyMindStanceAndFacing(state, s);

    // Move Fast under fire (hitTheDirt.ts): he drops and crawls on along the same path, and gets
    // up to run again on his own judgement; still while dropping / getting up
    const downHold = stepHitTheDirt(state, s);

    const speed = SPEEDS[s.activity];
    if (downHold) s.animFrame = 0;
    else if (speed != null && s.path.length > 0 && !isHeldForPacking(state, s) && !isHaulingGun(state, s)) {
      const fatigueFast = s.mind.state !== 'panicked' && s.mind.state !== 'broken' && s.fatigue > 70 && s.activity === 'movingFast';
      moveAlongPath(state, s, fatigueFast ? SPEEDS.moving : speed, dt, rng);
      if (Math.floor(state.time / 0.3) % 2 === 0) s.animFrame = 0; else s.animFrame = 1;
    }

    // a man crawling under a Move Fast order tires like a walker, not a sprinter
    if (s.activity === 'movingFast' && s.mind?.downAt == null) s.fatigue = Math.min(100, s.fatigue + 2 * dt);
    else if (s.activity === 'movingFast') s.fatigue = Math.min(100, s.fatigue + 0.5 * dt);
    else if (s.activity === 'moving') s.fatigue = Math.min(100, s.fatigue + 0.5 * dt);
    else if (s.activity === 'idle') s.fatigue = Math.max(0, s.fatigue - 1 * dt);

    // G7: engineers hold still and work — cut wire, dig mines (defending/idle only)
    stepEngineerWork(state, s, rng);
  }
  separateSoldiers(state, dt);
}

/** State effects on stance/facing (spec §3): wary crouches/sneaks near a belief and faces the
 * threat when idle; shaken may drop to crouching. */
function applyMindStanceAndFacing(state: BattleState, s: Soldier): void {
  const mind = s.mind;
  if (mind.state === 'wary') {
    const nearBelief = mind.beliefs.some((b) => dist(b.pos, s.pos) * TILE_M <= 60);
    if (nearBelief && s.path.length === 0) s.stance = 'crouching';
    if (mind.threatDir != null && (s.activity === 'idle' || s.activity === 'defending')) {
      s.facing = facingFromAngle(mind.threatDir);
    }
  } else if (mind.state === 'shaken' && s.stance === 'standing' && s.path.length === 0) {
    s.stance = 'crouching';
  }
}
/** User rule: soldiers are never STATIONED on top of each other. A man in motion is never blocked
 * or shoved — he may pass another man in the open (only in emergencies may he crawl over a prone
 * comrade, or vault a crawled one at the run) — but when he COMES TO REST on top of a live
 * comrade, he is nudged sideways off him (perpendicular to his travel, never back the way he
 * came). Bodies (dead) never block anything. */
const SOLDIER_BODY_RADIUS_TILES = 0.45;

function resolveSoldierOverlap(state: BattleState, s: Soldier, rng: Rng): void {
  if (s.vehicleId != null) return;
  if (s.path.length > 0) return; // in motion: passing is allowed, only rest is resolved
  for (const o of state.soldiers.values()) {
    if (o.id === s.id || o.vehicleId != null) continue;
    if (o.health === 'dead') continue; // bodies can be crawled over freely
    if (o.path.length > 0) continue; // the other man is walking: he will move off himself
    const d = dist(s.pos, o.pos);
    if (d >= SOLDIER_BODY_RADIUS_TILES * 2) continue;
    // nudge the resting mover sideways off the man he stopped on: perpendicular to the direction
    // he was travelling (his facing), so he steps ASIDE rather than back the way he came
    const side = rng.chance(0.5) ? 1 : -1;
    const travelRad = facingAngle(s.facing);
    const perp = { x: -Math.cos(travelRad) * side, y: -Math.sin(travelRad) * side };
    let spot = vadd(s.pos, vscale(perp, SOLDIER_BODY_RADIUS_TILES * 2));
    const tx = Math.floor(spot.x), ty = Math.floor(spot.y);
    if (!inBounds(state.map, tx, ty) || !isPassable(state.map, tx, ty, 'infantry')) {
      spot = vadd(s.pos, vscale(perp, -SOLDIER_BODY_RADIUS_TILES * 2));
    }
    s.pos = spot;
    return; // one resolution per step: the next tick sorts any further pair
  }
}

/** Test hook: the overlap resolver is private to the movement step. */
export const resolveSoldierOverlapForTest = resolveSoldierOverlap;

function moveAlongPath(state: BattleState, s: Soldier, speedMs: number, dt: number, rng: Rng): void {
  const tile = tileAt(state.map, Math.floor(s.pos.x), Math.floor(s.pos.y));
  let mul = TERRAIN_PROPS[tile].speedMul;
  // G7: intact wire is a crawl (CC3); cut wire is normal ground
  mul *= wireSpeedMul(state.map, s.pos.x, s.pos.y);
  // slope: slower up, a touch faster down, judged on the leg currently being walked
  if (s.path.length > 0) mul *= gradeSpeedMul(state.map, s.pos, s.path[0]);
  let remaining = (infantrySpeedMs(s, speedMs) * mul * dt) / TILE_M;

  while (remaining > 0 && s.path.length > 0) {
    const wp = s.path[0];
    const d = dist(s.pos, wp);
    s.facing = facingFromAngle(angleTo(s.pos, wp));
    if (d <= remaining || d < 1e-4) {
      s.pos = { x: wp.x, y: wp.y };
      remaining -= d;
      s.path.shift();
    } else {
      const dir = vnorm(vsub(wp, s.pos));
      s.pos = vadd(s.pos, vscale(dir, remaining));
      remaining = 0;
    }
  }

  resolveSoldierOverlap(state, s, rng);
  soldierMineCheck(state, s, rng);
  stepEngineerWork(state, s, rng);
  if (s.path.length === 0) onArrive(state, s);
}

/** G7: engineer teams standing still (or arriving) cut wire and clear mines, one tile
 * per call; the caller repeats each step so ~1 tile/second. */
function stepEngineerWork(state: BattleState, s: Soldier, rng: Rng): void {
  const team = state.teams.get(s.teamId);
  if (!team || team.type !== 'engineer') return;
  if (s.health === 'dead' || s.health === 'incapacitated') return;
  if (s.activity === 'moving' || s.activity === 'movingFast') return;
  if (cutWireNear(state, s)) return;
  if (rng.chance(0.05)) clearMineNear(state, s); // slower work: a dig per couple of seconds
}

function onArrive(state: BattleState, s: Soldier): void {
  const team = state.teams.get(s.teamId);
  const orderType = team?.order?.type;
  if (orderType === 'defend') {
    s.activity = 'defending';
    s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
  } else {
    s.activity = 'idle';
    // got there crawling under fire (hitTheDirt.ts): he stays down where he arrived
    s.stance = s.mind?.downAt != null ? 'prone' : isEnemyNear(state, s) ? 'crouching' : 'standing';
  }
  if (s.mind) { s.mind.downAt = undefined; s.mind.downHoldUntil = undefined; }
}

function isEnemyNear(state: BattleState, s: Soldier): boolean {
  const spotted = state.spotted[s.side];
  for (const eid of spotted) {
    const e = state.soldiers.get(eid);
    if (e && dist(e.pos, s.pos) < NEAR_ENEMY_RADIUS_TILES) return true;
  }
  return false;
}

/** Panicked soldiers run directly away from the nearest threat (coverSeek.ts sets a path toward
 * cover >= 0.4 first, per spec §9; this is only the fallback when no such cover was found — a
 * single flee-and-freeze, not a repeated repath). */
function handleFleeing(state: BattleState, s: Soldier, dt: number): void {
  if (s.path.length > 0) return;
  const last = s.reloadTimer;
  s.reloadTimer = 0; // repurposed as a one-shot "already tried to flee" guard for panicked soldiers
  if (last <= -999) return; // already froze once with no destination
  let nearest: Vec2 | null = null;
  let nd = Infinity;
  for (const eid of state.spotted[s.side]) {
    const e = state.soldiers.get(eid);
    if (!e) continue;
    const d = dist(s.pos, e.pos);
    if (d < nd) { nd = d; nearest = e.pos; }
  }
  const dir = nearest ? vnorm(vsub(s.pos, nearest)) : { x: s.side === 'german' ? -1 : 1, y: 0 };
  const dest = vadd(s.pos, vscale(dir, 20));
  s.path = findPath(state.map, s.pos, dest, 'infantry');
  s.reloadTimer = s.path.length > 0 ? 0 : -1000;
}

/** Routed soldiers run for their own deploy-zone edge; once inside, they hide prone. */
function handleRouting(state: BattleState, s: Soldier, dt: number): void {
  const zone = state.map.def.deployZones[s.side];
  if (pointInRect(s.pos, zone)) {
    s.activity = 'hiding';
    s.stance = 'prone';
    s.path = [];
    return;
  }
  s.reloadTimer -= dt;
  if (s.path.length === 0 || s.reloadTimer <= 0) {
    s.reloadTimer = REPATH_INTERVAL_S;
    const centre = { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 };
    s.path = findPath(state.map, s.pos, centre, 'infantry');
  }
}

/** Keep a nudged position inside the map (separation near an edge could push a soldier off it). */
function clampToMap(state: BattleState, p: { x: number; y: number }): { x: number; y: number } {
  const m = state.map;
  return { x: Math.min(Math.max(p.x, 0.05), m.width - 0.05), y: Math.min(Math.max(p.y, 0.05), m.height - 0.05) };
}

function separateSoldiers(state: BattleState, dt: number): void {
  const buckets = new Map<string, Soldier[]>();
  const budgets = new Map<number, number>();
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
    const key = `${Math.floor(s.pos.x)},${Math.floor(s.pos.y)}`;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(s);
    // One small sidestep budget per man and update, shared by all neighbours. Otherwise a dense
    // group multiplies the correction, and increasing the update rate makes men slide faster.
    const held = s.aiming || (s.smgBurst && state.time < s.smgBurst.until) || s.hatch || (s.stunnedUntil != null && state.time < s.stunnedUntil)
      || isDazed(s, state.time) || s.pickup?.until != null || isFirstFireFrozen(state, s.id)
      || (s.crewTask && !s.crewTask.walking) || isHaulingGun(state, s) || isHeldForPacking(state, s);
    budgets.set(s.id, held ? 0 : infantrySpeedMs(s, 0.3) * dt / TILE_M);
  }
  for (const arr of buckets.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const d = dist(a.pos, b.pos);
        if (d < 0.3) {
          const dir = d > 1e-4 ? vnorm(vsub(b.pos, a.pos)) : { x: 1, y: 0 };
          const aLeft = budgets.get(a.id)!, bLeft = budgets.get(b.id)!;
          const total = aLeft + bLeft;
          if (total <= 0) continue;
          const correction = Math.min(0.3 - d, total);
          const aStep = correction * aLeft / total, bStep = correction * bLeft / total;
          if (aStep) a.pos = clampToMap(state, vsub(a.pos, vscale(dir, aStep)));
          if (bStep) b.pos = clampToMap(state, vadd(b.pos, vscale(dir, bStep)));
          budgets.set(a.id, Math.max(0, aLeft - aStep));
          budgets.set(b.id, Math.max(0, bLeft - bStep));
        }
      }
    }
  }
}
