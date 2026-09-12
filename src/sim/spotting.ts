import type { BattleState, Side, Soldier, Stance, Vec2 } from '@/shared/types';
import { SIDES, otherSide, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { losTrace } from './los';

const SOLDIER_SPOT_RANGE_M = 300;
const VEHICLE_SPOT_RANGE_M = 400;
const ALWAYS_SPOT_RANGE_M = 10;

function stanceFactor(stance: Stance): number {
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

export function updateSpotting(state: BattleState, rng: Rng): void {
  const soldiers = Array.from(state.soldiers.values());
  const vehicles = Array.from(state.vehicles.values());

  for (const side of SIDES) {
    const enemySide = otherSide(side);

    const spottersS: Vec2[] = [];
    for (const s of soldiers) {
      if (s.side !== side) continue;
      if (s.health === 'dead' || s.health === 'incapacitated') continue;
      if (s.vehicleId !== null) continue;
      spottersS.push(s.pos);
    }
    for (const v of vehicles) {
      if (v.side !== side) continue;
      if (v.state === 'knockedOut') continue;
      spottersS.push(v.pos);
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

    for (const e of soldiers) {
      if (e.side !== enemySide) continue;
      if (e.health === 'dead') continue;
      if (e.vehicleId !== null) continue; // crewed soldiers not spotted individually

      let bestP = 0;
      let anyClearLOS = false;
      let alwaysSpotted = false;

      for (const fpos of spottersS) {
        const dsq = distSqTiles(fpos, e.pos);
        if (dsq > rangeSq) continue;
        const visibility = losFor(fpos, e.pos);
        if (visibility <= 0) continue;
        if (visibility > 0.05) anyClearLOS = true;
        if (dsq <= alwaysSq && visibility > 0) alwaysSpotted = true;

        const p = visibility * stanceFactor(e.stance) * (isMoving(e.activity) ? 1.5 : 1) *
          (isFiringRecently(e, state.time) ? 3 : 1);
        if (p > bestP) bestP = p;
      }

      let spot = alwaysSpotted || bestP >= 0.5 || rng.chance(bestP * 0.5);
      if (!spot && prevSpotted.has(e.id) && anyClearLOS) spot = true;

      if (spot) newSpotted.add(e.id);
    }
    state.spotted[side] = newSpotted;

    // ---- vehicle targets ----
    const newSpottedVehicles = new Set<number>();
    const vRangeSq = (VEHICLE_SPOT_RANGE_M / TILE_M) ** 2;
    for (const ev of vehicles) {
      if (ev.side !== enemySide) continue;
      let clear = false;
      for (const fpos of spottersS) {
        const dsq = distSqTiles(fpos, ev.pos);
        if (dsq > vRangeSq) continue;
        const visibility = losFor(fpos, ev.pos);
        if (visibility > 0) { clear = true; break; }
      }
      if (clear) newSpottedVehicles.add(ev.id);
    }
    state.spottedVehicles[side] = newSpottedVehicles;
  }
}
