// What a gun shell does after it misses or bounces, VISUAL ONLY: the dirt (snow, water) it throws
// up where it strikes the ground, the AP shot skipping on off the ground, and the glowing ricochet
// off a plate it failed to pierce. Variation comes from a position/time hash, never the sim RNG,
// so a battle resolves the same with or without these effects. Drawn by render/effects.ts.
import type { BattleState, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, clamp } from '@/shared/math';
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

/** Where a round that missed a vehicle strikes the ground: a few metres past it on the line of
 * fire, a little to one side (an over, never a hit on the hull it missed). */
export function missPoint(state: BattleState, from: Vec2, target: Vec2, t: number): Vec2 {
  const dir = angleTo(from, target);
  const over = along(target, dir, (4 + 10 * h(target, t, 1)) / TILE_M, state);
  return along(over, dir + Math.PI / 2, ((h(target, t, 2) - 0.5) * 7) / TILE_M, state);
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
