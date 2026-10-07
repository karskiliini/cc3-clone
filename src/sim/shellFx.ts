// What a gun shell does after it misses or bounces, VISUAL ONLY: the dirt (snow, water) it throws
// up where it strikes the ground, the AP shot skipping on off the ground, and the glowing ricochet
// off a plate it failed to pierce. Variation comes from a position/time hash, never the sim RNG,
// so a battle resolves the same with or without these effects. Drawn by render/effects.ts.
import type { BattleState, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp, dist } from '@/shared/math';
import { hash2 } from '@/shared/rng';
import * as dm from '@/shared/dmath';

/** Speed a skipping or glancing shot is SHOWN at, m/s: far below the real ~600, or it would be
 * gone in a frame or two (like the AT rocket's, a legibility choice). */
const SKIP_MS = 130;
const GLANCE_MS = 150;

function h(p: Vec2, t: number, k: number): number {
  return hash2(Math.floor(p.x * 16), Math.floor(p.y * 16), Math.floor(t * 60) * 13 + k);
}
function along(p: Vec2, dirRad: number, tiles: number, state: BattleState): Vec2 {
  return {
    x: clamp(p.x + dm.sin(dirRad) * tiles, 0.01, state.map.width - 0.01),
    y: clamp(p.y - dm.cos(dirRad) * tiles, 0.01, state.map.height - 0.01),
  };
}

/** Muzzle height, height of the hull top, and the gunner's aim point on it (m). */
const MUZZLE_M = 2.0;
const HULL_TOP_M = 2.4;
const AIM_M = 1.2;
const G = 9.81;

/** Where a round that missed a vehicle strikes the ground, from its trajectory: it passed the
 * target's range beside the hull (wide), above it (over) or below its aim, into the ground in
 * front (short). `halfM` is half the silhouette the target shows the shooter, `speedMs` the
 * round's speed. A flat, fast round that cleared the hull top keeps flying for hundreds of metres;
 * only a wide one can land close behind the target. Clipped to the map along the line of fire. */
export function missPoint(state: BattleState, from: Vec2, target: Vec2, t: number, halfM: number, speedMs: number): Vec2 {
  const rangeM = Math.max(1, dist(from, target) * TILE_M);
  const mode = h(target, t, 1), u = h(target, t, 2), side = h(target, t, 3) < 0.5 ? -1 : 1;
  // the miss at the target's range: height z (m) and sideways offset (m) from the aim line
  let z: number, sideM: number;
  if (mode < 0.45) { z = AIM_M + (u - 0.5) * 1.6; sideM = side * (halfM + 0.4 + 3 * u); }
  else if (mode < 0.8) { z = HULL_TOP_M + 0.3 + 2.5 * u; sideM = (u - 0.5) * halfM; }
  else { z = -(0.3 + 1.7 * u); sideM = (u - 0.5) * halfM; }
  // y(x) = MUZZLE + s·x − k·x² through (rangeM, z); it lands where y(x) = 0
  const k = G / (2 * speedMs * speedMs);
  const s = (z - MUZZLE_M + k * rangeM * rangeM) / rangeM;
  const landM = (s + Math.sqrt(s * s + 4 * k * MUZZLE_M)) / (2 * k);
  const dir = angleTo(from, target) + dm.atan2(sideM, rangeM);
  const fullM = landM * dm.hypot(1, sideM / rangeM);
  return { x: from.x + dm.sin(dir) * clipTiles(state, from, dir, fullM / TILE_M), y: from.y - dm.cos(dir) * clipTiles(state, from, dir, fullM / TILE_M) };
}

/** `tiles`, shortened so the point that far from `p` along `dirRad` stays on the map. */
function clipTiles(state: BattleState, p: Vec2, dirRad: number, tiles: number): number {
  const dx = dm.sin(dirRad), dy = -dm.cos(dirRad), lo = 0.01;
  let t = tiles;
  if (dx > 0) t = Math.min(t, (state.map.width - lo - p.x) / dx); else if (dx < 0) t = Math.min(t, (lo - p.x) / dx);
  if (dy > 0) t = Math.min(t, (state.map.height - lo - p.y) / dy); else if (dy < 0) t = Math.min(t, (lo - p.y) / dy);
  return Math.max(0, t);
}

/** A solid shot has struck the ground at `at` (showing at battle time `t`, flying along `dirRad`):
 * a fountain of dirt, and the shot skips on, low and fast, to splash again further off. An HE
 * shell bursts there instead (its burst is the caller's), so it does not skip. */
export function groundStrike(state: BattleState, at: Vec2, dirRad: number, t: number, weapon: WeaponDef): void {
  state.sparks.push({ pos: { ...at }, t, kind: 'groundSplash' });
  if (weapon.heRadiusM > 0) return;
  const dir = dirRad + (h(at, t, 3) - 0.5) * 0.5;
  const lenM = 20 + 45 * h(at, t, 4);
  const to = along(at, dir, lenM / TILE_M, state);
  const flightS = lenM / SKIP_MS;
  state.projectiles.push({
    kind: 'ricochet', weaponId: weapon.id, from: { ...at }, to, t0: t, flightS, dirRad: dir,
    arcM: 0, hitKind: 'impact', preResolved: true,
  });
  state.sparks.push({ pos: to, t: t + flightS, kind: 'dust' });
}

/** A plate the shot failed to pierce throws it off, glowing hot, to one side: usually into the
 * ground some way off (a splash), sometimes up and away out of sight. */
export function armourRicochet(state: BattleState, at: Vec2, dirRad: number, t: number, weapon: WeaponDef): void {
  if (weapon.heRadiusM > 0) return; // an HE shell bursts on the plate
  const side = h(at, t, 5) < 0.5 ? -1 : 1;
  const dir = dirRad + side * (0.45 + 0.8 * h(at, t, 6));
  const skyward = h(at, t, 7) < 0.35;
  const lenM = 25 + 55 * h(at, t, 8);
  const to = along(at, dir, lenM / TILE_M, state);
  const flightS = lenM / GLANCE_MS;
  state.projectiles.push({
    kind: 'ricochet', weaponId: weapon.id, from: { ...at }, to, t0: t, flightS, dirRad: dir,
    arcM: skyward ? 1 : 0, hitKind: 'ricochet', preResolved: true,
  });
  if (!skyward) state.sparks.push({ pos: to, t: t + flightS, kind: 'groundSplash' });
}
