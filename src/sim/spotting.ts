import type { BattleState, Side, Soldier, Stance, Vec2 } from '@/shared/types';
import { SIDES, otherSide, TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { hash2 } from '@/shared/rng';
import { losTrace, eyeHeightM, EYE_STANDING_M, EYE_VEHICLE_M } from './los';
import { groundAtTile } from './map';
import { angleTo, facingAngle, wrapAngle, dist } from '@/shared/math';
import { onSpotted } from './mind';
import { VEHICLE_DEFS } from '@/data/units';
import { vehicleEyes, type VehicleEye } from './vehicleVision';

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

// ------------------------------------------------------------------ pain vision (wounded men)
// A wounded man's visibility suffers periodically, not steadily: most of the time a mild penalty
// (he is favouring the wound but still watching), and in recurring bouts of real pain a much
// stronger one. Bout timing (phase, period, length) is derived from the soldier's id via hash2 —
// deterministic and NOT drawn from the seeded Rng stream, so calling this never perturbs any other
// random draw, and the same (soldier, time) always answers the same way (repeatable, no state).
export const PAIN_MILD_FACTOR = 0.85;
export const PAIN_BOUT_FACTOR = 0.35;
export const PAIN_BOUT_FACTOR_LOW_MORALE = 0.2;
export const PAIN_BOUT_FACTOR_VETERAN = 0.5;
const PAIN_PERIOD_MIN_S = 12, PAIN_PERIOD_RANGE_S = 13; // bouts recur every 12-25 s
const PAIN_BOUT_MIN_S = 3, PAIN_BOUT_RANGE_S = 3;       // each bout lasts 3-6 s
/** Below this experience, or this morale, a wounded man's pain bouts hit him hardest (green troops
 * and men who have had enough); at/above VETERAN experience he grits his teeth instead. */
const PAIN_LOW_EXPERIENCE = 35, PAIN_LOW_MORALE = 30, PAIN_VETERAN_EXPERIENCE = 65;

/** Spotting-factor multiplier from pain: 1 for every healthy (or dead/incapacitated — moot, they
 * don't spot) man. A wounded man is at PAIN_MILD_FACTOR most of the time, dropping into a strong,
 * recurring bout (PAIN_BOUT_FACTOR, harder on green/shaken troops, easier on veterans) roughly
 * 15-35% of the time. Also usable directly by combat code (e.g. a wounded gunner's aim) — exported
 * for exactly that. Pure: same inputs, same answer, every time. */
export function painVisionFactor(soldier: Soldier, time: number): number {
  if (soldier.health !== 'wounded') return 1;
  const id = soldier.id;
  const period = PAIN_PERIOD_MIN_S + hash2(id, 0, 11) * PAIN_PERIOD_RANGE_S;
  const boutLen = PAIN_BOUT_MIN_S + hash2(id, 0, 23) * PAIN_BOUT_RANGE_S;
  const phase = hash2(id, 0, 37) * period;
  const t = ((time + phase) % period + period) % period;
  if (t >= boutLen) return PAIN_MILD_FACTOR;
  if (soldier.experience >= PAIN_VETERAN_EXPERIENCE) return PAIN_BOUT_FACTOR_VETERAN;
  if (soldier.experience < PAIN_LOW_EXPERIENCE || soldier.morale < PAIN_LOW_MORALE) return PAIN_BOUT_FACTOR_LOW_MORALE;
  return PAIN_BOUT_FACTOR;
}

/** painVisionFactor of whichever soldier is behind this spotter (himself, or — for a vehicle
 * eye — the crewman whose eye it is); 1 for the no-crew-data fallback spotter. */
function spotterPainFactor(state: BattleState, sp: Spotter): number {
  const s = sp.soldier ?? (sp.vehicleEye ? state.soldiers.get(sp.vehicleEye.soldierId) : undefined);
  return s ? painVisionFactor(s, state.time) : 1;
}

/** An eye on the battlefield: a dismounted soldier (with his mind's spotting bonuses), or one of a
 * vehicle's living crew (`soldier` null, no mind bonus, but its own `vehicleEye` — position, eye
 * height, facing arc, range and spotting factor — from sim/vehicleVision.ts `vehicleEyes`). A
 * vehicle spotter without `vehicleEye` is the pre-crew-vision fallback for an unrecognised
 * `defId` (test fixtures): the vehicle's own position at commander height, no arc restriction. */
export interface Spotter { pos: Vec2; soldier: Soldier | null; vehicleEye?: VehicleEye }

/** Eye height (m) of a spotter: his stance, his vehicle eye's height, or a vehicle commander at
 * 2.2 m (the no-crew-data fallback). */
export function spotterEyeM(sp: Spotter): number {
  if (sp.vehicleEye) return sp.vehicleEye.eyeM;
  return sp.soldier ? eyeHeightM(sp.soldier.stance) : EYE_VEHICLE_M;
}

/** Is `targetPos` inside this eye's facing arc? (2*PI arcs are always true, cheaply.) */
function withinEyeArc(eye: VehicleEye, from: Vec2, targetPos: Vec2): boolean {
  if (eye.arcRad >= Math.PI * 2 - 1e-6) return true;
  const toTarget = angleTo(from, targetPos);
  return Math.abs(wrapAngle(toTarget - eye.facing)) <= eye.arcRad / 2;
}

/** Height-advantage spotting factor: +10% per 5 m the observer stands above the target, capped
 * at +30%, and the mirror image (down to x0.7) when looking up at higher ground. 1 on a flat map. */
export const HEIGHT_SPOT_PER_M = 0.1 / 5;
export const HEIGHT_SPOT_CAP = 0.3;
export function heightSpotFactor(state: BattleState, from: Vec2, to: Vec2): number {
  const map = state.map;
  if (!map.ground) return 1;
  const dh = groundAtTile(map, Math.floor(from.x), Math.floor(from.y))
    - groundAtTile(map, Math.floor(to.x), Math.floor(to.y));
  let f = dh * HEIGHT_SPOT_PER_M;
  if (f > HEIGHT_SPOT_CAP) f = HEIGHT_SPOT_CAP; else if (f < -HEIGHT_SPOT_CAP) f = -HEIGHT_SPOT_CAP;
  return 1 + f;
}

export type LosVisibilityFn = (from: Vec2, to: Vec2, eyeM?: number, targetM?: number) => number;

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
    const eyes = vehicleEyes(state, v);
    if (eyes.length > 0) {
      for (const eye of eyes) spotters.push({ pos: eye.pos, soldier: null, vehicleEye: eye });
    } else if (!VEHICLE_DEFS[v.defId]) {
      // unrecognised defId (test fixtures): fall back to the old single blind-arc-less point spot
      spotters.push({ pos: v.pos, soldier: null });
    }
    // a recognised def with no living crew eyes (every seat dead/empty) is truly blind: no spotter
  }
  return spotters;
}

/** Tile-keyed losTrace visibility cache — the same memo updateSpotting uses per side per tick.
 * The key carries the eye/target heights too, since terrain masking (a crest between) depends on
 * them: two observers in the same tile but different stances can genuinely differ. Vehicle eyes
 * (sim/vehicleVision.ts) reuse this same cache correctly without any key change: their heights
 * (1.4-1.6 m hull crew, 2.0-2.7 m turret/casemate crew) fall into eyeClass's existing buckets, and
 * their facing-arc restriction is checked before this cache is ever consulted (observerVisibility's
 * arc gate), so it never needs to be part of the trace key — a blocked-by-arc eye just never asks. */
export function makeLosVisibilityCache(state: BattleState): LosVisibilityFn {
  const losCache = new Map<number, number>();
  const W = state.map.width;
  const tiles = W * state.map.height;
  return (from: Vec2, to: Vec2, eyeM = EYE_STANDING_M, targetM = EYE_STANDING_M): number => {
    // numeric key (exact well inside 2^53 for any map we ship): from-tile, to-tile, and the two
    // height classes, since terrain masking makes the trace depend on eye/silhouette height too.
    const a = Math.floor(from.y) * W + Math.floor(from.x);
    const b = Math.floor(to.y) * W + Math.floor(to.x);
    const key = ((a * tiles + b) * 4 + eyeClass(eyeM)) * 4 + eyeClass(targetM);
    let v = losCache.get(key);
    if (v === undefined) {
      v = losTrace(state.map, from, to, { eyeM, targetM }).visibility;
      losCache.set(key, v);
    }
    return v;
  };
}

/** 0..3 bucket for an eye/silhouette height (prone, crouching, standing, vehicle). */
function eyeClass(m: number): number {
  return m <= 0.7 ? 0 : m <= 1.4 ? 1 : m <= 1.95 ? 2 : 3;
}

/**
 * Pure line-of-sight visibility of `targetPos` for `observer`, exactly as updateSpotting evaluates
 * it: 0 when beyond `rangeM` (soldier targets 300 m, vehicle targets 400 m) or when losTrace is
 * blocked; otherwise losTrace's 0..1 visibility (concealment along the line x distance falloff).
 */
export function observerVisibility(
  state: BattleState, observer: Spotter, targetPos: Vec2,
  rangeM: number = SOLDIER_SPOT_RANGE_M, losFor?: LosVisibilityFn, targetM: number = EYE_STANDING_M,
): number {
  const eye = observer.vehicleEye;
  if (eye) {
    if (!withinEyeArc(eye, observer.pos, targetPos)) return 0;
    if (eye.rangeM < rangeM) rangeM = eye.rangeM;
  }
  const rangeTiles = rangeM / TILE_M;
  if (distSqTiles(observer.pos, targetPos) > rangeTiles * rangeTiles) return 0;
  const eyeM = spotterEyeM(observer);
  const v = losFor
    ? losFor(observer.pos, targetPos, eyeM, targetM)
    : losTrace(state.map, observer.pos, targetPos, { eyeM, targetM }).visibility;
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
  const eyeFactor = observer.soldier ? mindSpotFactor(observer.soldier, targetPos) : observer.vehicleEye?.factor ?? 1;
  return visibility * eyeFactor * spotterPainFactor(state, observer) * heightSpotFactor(state, observer.pos, targetPos);
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

      // the target's own silhouette top: a prone man behind a crest is masked where a standing
      // one is not, so the LOS trace needs his stance as well as the observer's
      const targetTopM = eyeHeightM(e.stance);
      for (const sp of spotters) {
        const visibility = observerVisibility(state, sp, e.pos, SOLDIER_SPOT_RANGE_M, losFor, targetTopM);
        if (visibility <= 0) continue;
        const dsq = distSqTiles(sp.pos, e.pos);
        if (visibility > 0.05) anyClearLOS = true;
        if (dsq <= alwaysSq && visibility > 0) alwaysSpotted = true;

        const mindFactor = sp.soldier ? mindSpotFactor(sp.soldier, e.pos) : sp.vehicleEye?.factor ?? 1;
        const p = visibility * visibilityStanceFactor(e.stance) * (isMoving(e.activity) ? 1.5 : 1) *
          (isFiringRecently(e, state.time) ? 3 : 1) * mindFactor * spotterPainFactor(state, sp) *
          heightSpotFactor(state, sp.pos, e.pos);
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
        const visibility = observerVisibility(state, sp, ev.pos, VEHICLE_SPOT_RANGE_M, losFor, EYE_VEHICLE_M);
        if (visibility > 0) { clear = true; break; }
      }
      if (clear) newSpottedVehicles.add(ev.id);
    }
    state.spottedVehicles[side] = newSpottedVehicles;
  }
}
