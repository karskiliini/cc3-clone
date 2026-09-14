import type { BattleState, Soldier, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, dist, facingFromAngle, pointInRect, vadd, vnorm, vscale, vsub } from '@/shared/math';
import { coverAt, tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';
import { findPath } from './path';
import { isFirstFireFrozen } from './mind';
import { stepCrewWeapons, isHeldForPacking } from './crewWeapon';
import { stepOrderWaypoints } from './orders';

const SPEEDS: Record<string, number> = {
  moving: 1.4,
  movingFast: 3.0,
  sneaking: 0.5,
  panicked: 3.2,
  routed: 3.0,
};

const REPATH_INTERVAL_S = 3;
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
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated') continue;

    if (s.vehicleId != null) {
      const veh = state.vehicles.get(s.vehicleId);
      if (veh) s.pos = { x: veh.pos.x, y: veh.pos.y };
      continue;
    }

    s.cover = coverAt(state.map, s.pos);

    // First-fire shock (spec §11): frozen soldiers do not move at all.
    if (isFirstFireFrozen(state, s.id)) continue;

    if (s.activity === 'panicked') handleFleeing(state, s, dt);
    else if (s.activity === 'routed') handleRouting(state, s, dt);

    applyMindStanceAndFacing(state, s);

    const speed = SPEEDS[s.activity];
    if (speed != null && s.path.length > 0 && !isHeldForPacking(state, s)) {
      const fatigueFast = s.mind.state !== 'panicked' && s.mind.state !== 'broken' && s.fatigue > 70 && s.activity === 'movingFast';
      moveAlongPath(state, s, fatigueFast ? SPEEDS.moving : speed, dt);
      if (Math.floor(state.time / 0.3) % 2 === 0) s.animFrame = 0; else s.animFrame = 1;
    }

    if (s.activity === 'movingFast') s.fatigue = Math.min(100, s.fatigue + 2 * dt);
    else if (s.activity === 'moving') s.fatigue = Math.min(100, s.fatigue + 0.5 * dt);
    else if (s.activity === 'idle') s.fatigue = Math.max(0, s.fatigue - 1 * dt);
  }
  separateSoldiers(state);
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

function moveAlongPath(state: BattleState, s: Soldier, speedMs: number, dt: number): void {
  const tile = tileAt(state.map, Math.floor(s.pos.x), Math.floor(s.pos.y));
  let mul = TERRAIN_PROPS[tile].speedMul;
  if (s.fatigue > 70) mul *= 0.5;
  if (s.health === 'wounded') mul *= 0.7;
  let remaining = (speedMs * mul * dt) / TILE_M;

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

  if (s.path.length === 0) onArrive(state, s);
}

function onArrive(state: BattleState, s: Soldier): void {
  const team = state.teams.get(s.teamId);
  const orderType = team?.order?.type;
  if (orderType === 'defend') {
    s.activity = 'defending';
    s.stance = s.cover < 0.2 ? 'prone' : 'crouching';
  } else {
    s.activity = 'idle';
    s.stance = isEnemyNear(state, s) ? 'crouching' : 'standing';
  }
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

function separateSoldiers(state: BattleState): void {
  const buckets = new Map<string, Soldier[]>();
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
    const key = `${Math.floor(s.pos.x)},${Math.floor(s.pos.y)}`;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(s);
  }
  for (const arr of buckets.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const d = dist(a.pos, b.pos);
        if (d < 0.3) {
          const dir = d > 1e-4 ? vnorm(vsub(b.pos, a.pos)) : { x: 1, y: 0 };
          a.pos = clampToMap(state, vsub(a.pos, vscale(dir, 0.05)));
          b.pos = clampToMap(state, vadd(b.pos, vscale(dir, 0.05)));
        }
      }
    }
  }
}
