import type { BattleState, Side, Soldier, Stance, Vec2 } from '@/shared/types';
import { SIDES, otherSide, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { losTrace } from './los';
import { angleTo, facingAngle, wrapAngle, dist } from '@/shared/math';
import { onSpotted } from './mind';

const SOLDIER_SPOT_RANGE_M = 300;
const VEHICLE_SPOT_RANGE_M = 400;
const ALWAYS_SPOT_RANGE_M = 10;
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

export function updateSpotting(state: BattleState, rng: Rng): void {
  const soldiers = Array.from(state.soldiers.values());
  const vehicles = Array.from(state.vehicles.values());

  for (const side of SIDES) {
    const enemySide = otherSide(side);

    const spotters: { pos: Vec2; soldier: Soldier | null }[] = [];
    for (const s of soldiers) {
      if (s.side !== side) continue;
      if (s.health === 'dead' || s.health === 'incapacitated') continue;
      if (s.vehicleId !== null) continue;
      spotters.push({ pos: s.pos, soldier: s });
    }
    for (const v of vehicles) {
      if (v.side !== side) continue;
      if (v.state === 'knockedOut') continue;
      spotters.push({ pos: v.pos, soldier: null });
    }

    const losCache = new Map<string, number>();
    const losFor = (from: Vec2, to: Vec2): number => {
      const key = `${Math.floor(from.x)},${Math.floor(from.y)}|${Math.floor(to.x)},${Math.floor(to.y)}`;
      let v = losCache.get(key);
      if (v === undefined) {
        v = losTrace(state.map, from, to).visibility;
        losCache.set(key, v);
      }
      return v;
    };

    // ---- soldier targets ----
    const prevSpotted = state.spotted[side];
    const newSpotted = new Set<number>();
    const rangeSq = (SOLDIER_SPOT_RANGE_M / TILE_M) ** 2;
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
        const dsq = distSqTiles(sp.pos, e.pos);
        if (dsq > rangeSq) continue;
        const visibility = losFor(sp.pos, e.pos);
        if (visibility <= 0) continue;
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
    const vRangeSq = (VEHICLE_SPOT_RANGE_M / TILE_M) ** 2;
    for (const ev of vehicles) {
      if (ev.side !== enemySide) continue;
      let clear = false;
      for (const sp of spotters) {
        const dsq = distSqTiles(sp.pos, ev.pos);
        if (dsq > vRangeSq) continue;
        const visibility = losFor(sp.pos, ev.pos);
        if (visibility > 0) { clear = true; break; }
      }
      if (clear) newSpottedVehicles.add(ev.id);
    }
    state.spottedVehicles[side] = newSpottedVehicles;
  }
}
