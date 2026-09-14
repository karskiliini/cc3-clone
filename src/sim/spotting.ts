import type { BattleState, Side, Soldier, Stance, Vec2 } from '@/shared/types';
import { SIDES, otherSide, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { losTrace } from './los';
import { angleTo, facingAngle, wrapAngle, dist } from '@/shared/math';
import { onSpotted } from './mind';

export const SOLDIER_SPOT_RANGE_M = 300;
export const VEHICLE_SPOT_RANGE_M = 400;
export const ALWAYS_SPOT_RANGE_M = 10;
const DEG15 = (15 * Math.PI) / 180;
const DEG90 = (90 * Math.PI) / 180;

/** Visual-signature multiplier by stance. Deliberately differs from ballistics.ts's
 * exposureStanceFactor (prone 0.4 here vs 0.45 there); see that comment. */
function visibilityStanceFactor(stance: Stance): number {
  switch (stance) {
    case 'standing': return 1;
    case 'crouching': return 0.7;
    case 'prone': return 0.4;
  }
}

function isMoving(activity: Soldier['activity']): boolean {
  return activity === 'moving' || activity === 'movingFast';
}

function isFiringRecently(s: Soldier, time: number): boolean {
  return s.activity === 'firing' || time - s.lastFiredAt < 5;
}

function distSqTiles(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Spotting bonus for `spotter` looking at `enemyPos` (spec §6): x1.5 within 15deg of his
 * threatDir or within 6 tiles of one of his beliefs; x0.6 if the enemy is >90deg off his facing. */
function mindSpotFactor(spotter: Soldier, enemyPos: Vec2): number {
  const mind = spotter.mind;
  const toEnemy = angleTo(spotter.pos, enemyPos);
  if (mind.threatDir != null && Math.abs(wrapAngle(toEnemy - mind.threatDir)) <= DEG15) return 1.5;
  for (const b of mind.beliefs) {
    if (dist(b.pos, enemyPos) <= 6) return 1.5;
  }
  const facingDiff = Math.abs(wrapAngle(toEnemy - facingAngle(spotter.facing)));
  if (facingDiff > DEG90) return 0.6;
  return 1;
}

/** An eye on the battlefield: a dismounted soldier (with his mind's spotting bonuses) or a
 * vehicle (crew spot from the vehicle's position; `soldier` null, no mind bonus). */
export interface Spotter { pos: Vec2; soldier: Soldier | null }

export type LosVisibilityFn = (from: Vec2, to: Vec2) => number;

/** Is this soldier an eligible spotter (alive, conscious, dismounted)? */
function soldierCanSpot(s: Soldier): boolean {
  return s.health !== 'dead' && s.health !== 'incapacitated' && s.vehicleId === null;
}

/** The spotters `updateSpotting` uses for one side, optionally restricted to some teams. */
export function collectSpotters(state: BattleState, side: Side, teamIds?: ReadonlySet<number>): Spotter[] {
  const spotters: Spotter[] = [];
  for (const s of state.soldiers.values()) {
    if (s.side !== side) continue;
    if (!soldierCanSpot(s)) continue;
    if (teamIds && !teamIds.has(s.teamId)) continue;
    spotters.push({ pos: s.pos, soldier: s });
  }
  for (const v of state.vehicles.values()) {
    if (v.side !== side) continue;
    if (v.state === 'knockedOut') continue;
    if (teamIds && !teamIds.has(v.teamId)) continue;
    spotters.push({ pos: v.pos, soldier: null });
  }
  return spotters;
}

/** Tile-keyed losTrace visibility cache — the same memo updateSpotting uses per side per tick. */
export function makeLosVisibilityCache(state: BattleState): LosVisibilityFn {
  const losCache = new Map<string, number>();
  return (from: Vec2, to: Vec2): number => {
    const key = `${Math.floor(from.x)},${Math.floor(from.y)}|${Math.floor(to.x)},${Math.floor(to.y)}`;
    let v = losCache.get(key);
    if (v === undefined) {
      v = losTrace(state.map, from, to).visibility;
      losCache.set(key, v);
    }
    return v;
  };
}

/**
 * Pure line-of-sight visibility of `targetPos` for `observer`, exactly as updateSpotting evaluates
 * it: 0 when beyond `rangeM` (soldier targets 300 m, vehicle targets 400 m) or when losTrace is
 * blocked; otherwise losTrace's 0..1 visibility (concealment along the line x distance falloff).
 */
export function observerVisibility(
  state: BattleState, observer: Spotter, targetPos: Vec2,
  rangeM: number = SOLDIER_SPOT_RANGE_M, losFor?: LosVisibilityFn,
): number {
  const rangeTiles = rangeM / TILE_M;
  if (distSqTiles(observer.pos, targetPos) > rangeTiles * rangeTiles) return 0;
  const v = losFor ? losFor(observer.pos, targetPos) : losTrace(state.map, observer.pos, targetPos).visibility;
  return v > 0 ? v : 0;
}

/**
 * Per-tick spot score (updateSpotting's `p`) of `observer` for a soldier target standing still in
 * the open at `targetPos` (stance factor 1, not moving, not firing), including the observer's mind
 * bonus; a target within ALWAYS_SPOT_RANGE_M with any LOS returns 1. Score >= 0.5 means the target
 * is spotted for certain; 0 < score < 0.5 means a per-tick chance of score/2; 0 means never.
 */
export function observerStandingSpotScore(
  state: BattleState, observer: Spotter, targetPos: Vec2, losFor?: LosVisibilityFn,
): number {
  const visibility = observerVisibility(state, observer, targetPos, SOLDIER_SPOT_RANGE_M, losFor);
  if (visibility <= 0) return 0;
  const alwaysTiles = ALWAYS_SPOT_RANGE_M / TILE_M;
  if (distSqTiles(observer.pos, targetPos) <= alwaysTiles * alwaysTiles) return 1;
  return visibility * (observer.soldier ? mindSpotFactor(observer.soldier, targetPos) : 1);
}

export function updateSpotting(state: BattleState, rng: Rng): void {
  const soldiers = Array.from(state.soldiers.values());
  const vehicles = Array.from(state.vehicles.values());

  for (const side of SIDES) {
    const enemySide = otherSide(side);

    const spotters = collectSpotters(state, side);
    const losFor = makeLosVisibilityCache(state);

    // ---- soldier targets ----
    const prevSpotted = state.spotted[side];
    const newSpotted = new Set<number>();
    const alwaysSq = (ALWAYS_SPOT_RANGE_M / TILE_M) ** 2;

    // For belief clustering (spec §5): count how many currently-visible enemies of this side sit
    // within 4 tiles of each other, computed once per enemy-of-this-side (not per spotter).
    const clusterCache = new Map<number, number>();

    for (const e of soldiers) {
      if (e.side !== enemySide) continue;
      if (e.health === 'dead') continue;
      if (e.vehicleId !== null) continue; // crewed soldiers not spotted individually

      let bestP = 0;
      let bestSpotter: Soldier | null = null;
      let anyClearLOS = false;
      let alwaysSpotted = false;

      for (const sp of spotters) {
        const visibility = observerVisibility(state, sp, e.pos, SOLDIER_SPOT_RANGE_M, losFor);
        if (visibility <= 0) continue;
        const dsq = distSqTiles(sp.pos, e.pos);
        if (visibility > 0.05) anyClearLOS = true;
        if (dsq <= alwaysSq && visibility > 0) alwaysSpotted = true;

        const mindFactor = sp.soldier ? mindSpotFactor(sp.soldier, e.pos) : 1;
        const p = visibility * visibilityStanceFactor(e.stance) * (isMoving(e.activity) ? 1.5 : 1) *
          (isFiringRecently(e, state.time) ? 3 : 1) * mindFactor;
        if (p > bestP) { bestP = p; bestSpotter = sp.soldier; }
      }

      let spot = alwaysSpotted || bestP >= 0.5 || rng.chance(bestP * 0.5);
      if (!spot && prevSpotted.has(e.id) && anyClearLOS) spot = true;

      if (spot) {
        newSpotted.add(e.id);
        if (bestSpotter) {
          let count = clusterCache.get(e.id);
          if (count === undefined) {
            count = 1;
            for (const e2 of soldiers) {
              if (e2 === e || e2.side !== enemySide || e2.health === 'dead') continue;
              if (dist(e.pos, e2.pos) <= 4) count++;
            }
            clusterCache.set(e.id, count);
          }
          onSpotted(state, bestSpotter, e, count);
        }
      }
    }
    state.spotted[side] = newSpotted;

    // ---- vehicle targets ----
    const newSpottedVehicles = new Set<number>();
    for (const ev of vehicles) {
      if (ev.side !== enemySide) continue;
      let clear = false;
      for (const sp of spotters) {
        const visibility = observerVisibility(state, sp, ev.pos, VEHICLE_SPOT_RANGE_M, losFor);
        if (visibility > 0) { clear = true; break; }
      }
      if (clear) newSpottedVehicles.add(ev.id);
    }
    state.spottedVehicles[side] = newSpottedVehicles;
  }
}
