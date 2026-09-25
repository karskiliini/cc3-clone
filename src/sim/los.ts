import type { GameMap, Stance, Terrain, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { TERRAIN_PROPS } from './terrain';
import { idx, inBounds } from './map';
import { GROWTH_HEIGHT_M, tileStanding } from './growth';

export interface LosResult {
  clear: boolean;
  blockedAt: Vec2 | null;
  visibility: number;
}

// ---------------------------------------------------------------- eye heights (metres)
export const EYE_STANDING_M = 1.7;
export const EYE_CROUCHING_M = 1.1;
export const EYE_PRONE_M = 0.4;
export const EYE_VEHICLE_M = 2.2;
/** The vehicle main gun's muzzle height (m above the vehicle's own ground) - below the commander's
 * 2.2 m eye: a tank in defilade behind a crest sees over it (the eye) while the gun line is still
 * masked (the muzzle), which is what the hull-down creep engages on (item 038). */
export const VEHICLE_GUN_M = 1.5;

/** Eye height above the ground for a dismounted soldier in this stance. */
export function eyeHeightM(stance: Stance): number {
  switch (stance) {
    case 'standing': return EYE_STANDING_M;
    case 'crouching': return EYE_CROUCHING_M;
    case 'prone': return EYE_PRONE_M;
  }
}

/** Observer eye height / target silhouette height above their own ground, in metres. Omitted
 * values default to a standing man (1.7 m) at both ends — the pre-elevation behaviour on a flat
 * map, and the neutral choice for callers that don't track stance. */
export interface LosHeights { eyeM?: number; targetM?: number }

/** Tolerance (m) on the terrain-masking test. A soldier's own tile is sampled at its centre, so
 * on a uniform slope the intervening tile heights sit exactly on the sight line; without a small
 * slack, floating point (and the half-tile offset of the endpoints) would make every slope
 * self-blocking. */
const GROUND_MASK_SLACK_M = 0.2;

/** 1 at 0m, 0.5 at 200m, 0.2 at 400m, linear piecewise, clamped >= 0 beyond. */
export function losDistanceFactor(distM: number): number {
  if (distM <= 0) return 1;
  if (distM <= 200) return 1 + (0.5 - 1) * (distM / 200);
  if (distM <= 400) return 0.5 + (0.2 - 0.5) * ((distM - 200) / 200);
  // extrapolate the same slope beyond 400m, clamped at 0
  const beyond = 0.2 + (0.2 - 0.5) * ((distM - 400) / 200);
  return Math.max(0, beyond);
}

/** Height (m) of ground-level growth and clutter that conceals only a sight line passing below
 * its top. Terrain not listed (scattered trees, floors, smoke) conceals at any line height. */
export const LOW_GROWTH_HEIGHT_M: Partial<Record<Terrain, number>> = {
  grass: 0.3, tallgrass: 1.0, crops: 1.2, hedge: 2.0, fence: 1.2, rubble: 0.9,
  snow: 0.15, mud: 0.15, crater: 0, trench: 0,
};

export function bresenhamTiles(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  const pts: Vec2[] = [];
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x1 >= x0 ? 1 : -1;
  const sy = y1 >= y0 ? 1 : -1;
  let err = dx - dy;
  // safety cap on iterations
  const maxSteps = dx + dy + 4;
  for (let i = 0; i <= maxSteps; i++) {
    pts.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return pts;
}

function chebyshevAdjacent(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

export function losTrace(map: GameMap, from: Vec2, to: Vec2, heights?: LosHeights, ignoreConcealment = false, endBlocksSolid = false): LosResult {
  const fx = Math.floor(from.x), fy = Math.floor(from.y);
  const tx = Math.floor(to.x), ty = Math.floor(to.y);
  const startTile: Vec2 = { x: fx, y: fy };
  const endTile: Vec2 = { x: tx, y: ty };
  const distM = Math.hypot(to.x - from.x, to.y - from.y) * TILE_M;

  const startTerrain = inBounds(map, fx, fy) ? map.tiles[idx(map, fx, fy)] : 'open';
  const startIsWoods = startTerrain === 'woods';

  // ---- terrain masking setup. `ground` is the map's per-tile elevation (no allocation, one
  // array read per Bresenham step); on a flat map it is undefined and this whole path is skipped,
  // so an elevation-less map costs exactly what it did before.
  const ground = map.ground;
  const W = map.width, H = map.height;
  let eyeZ = 0, dz = 0, ax = 0, ay = 0, invLen2 = 0;
  if (ground) {
    const cfx = fx < 0 ? 0 : fx >= W ? W - 1 : fx, cfy = fy < 0 ? 0 : fy >= H ? H - 1 : fy;
    const ctx2 = tx < 0 ? 0 : tx >= W ? W - 1 : tx, cty = ty < 0 ? 0 : ty >= H ? H - 1 : ty;
    eyeZ = ground[cfy * W + cfx] + (heights?.eyeM ?? EYE_STANDING_M);
    const tgtZ = ground[cty * W + ctx2] + (heights?.targetM ?? EYE_STANDING_M);
    dz = tgtZ - eyeZ;
    ax = tx - fx; ay = ty - fy;
    const len2 = ax * ax + ay * ay;
    invLen2 = len2 > 0 ? 1 / len2 : 0;
  }

  const tiles = bresenhamTiles(fx, fy, tx, ty);
  let accumulated = 0;

  for (let i = 1; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.x === tx && t.y === ty) {
      // end tile reached: visible (subject to accumulated concealment already tallied).
      // The target's own tile never blocks or conceals itself.
      if (endBlocksSolid) {
        // Near-miss suppression gate: a solid end tile stops the round at its face, so a man
        // standing inside a wall tile just beyond the impact is not pressured by it. Woods
        // stays soft — rounds and sight both pass through vegetation.
        const iEnd = inBounds(map, tx, ty) ? idx(map, tx, ty) : -1;
        const endTerrain = iEnd >= 0 ? map.tiles[iEnd] : 'open';
        if (endTerrain !== 'woods' && TERRAIN_PROPS[endTerrain].blocksLOS) {
          const isWindow = map.windows[iEnd] === 1;
          if (!(isWindow && (chebyshevAdjacent(t, startTile) || chebyshevAdjacent(t, endTile)))) {
            return { clear: false, blockedAt: { x: t.x + 0.5, y: t.y + 0.5 }, visibility: 0 };
          }
        }
      }
      const visibility = Math.max(0, 1 - accumulated) * losDistanceFactor(distM);
      return { clear: true, blockedAt: null, visibility };
    }
    if (!inBounds(map, t.x, t.y)) {
      const center = { x: t.x + 0.5, y: t.y + 0.5 };
      return { clear: false, blockedAt: center, visibility: 0 };
    }
    const i2 = idx(map, t.x, t.y);

    // ---- terrain masking: the ground between rises above the straight line from the observer's
    // eye to the target's silhouette top. This is what puts a unit in dead ground behind a crest.
    if (ground && invLen2 > 0) {
      const f = ((t.x - fx) * ax + (t.y - fy) * ay) * invLen2;
      if (ground[i2] > eyeZ + dz * f + GROUND_MASK_SLACK_M) {
        return { clear: false, blockedAt: { x: t.x + 0.5, y: t.y + 0.5 }, visibility: 0 };
      }
    }

    const terrain = map.tiles[i2];
    const tp = TERRAIN_PROPS[terrain];

    if (terrain === 'woods') {
      if (ignoreConcealment) continue;
      if (startIsWoods) {
        // units inside woods can see ~2 tiles out: concealment instead of hard block
        accumulated += 0.5;
        if (accumulated >= 1.0) {
          return { clear: false, blockedAt: { x: t.x + 0.5, y: t.y + 0.5 }, visibility: 0 };
        }
      } else {
        return { clear: false, blockedAt: { x: t.x + 0.5, y: t.y + 0.5 }, visibility: 0 };
      }
    } else if (tp.blocksLOS) {
      const isWindow = map.windows[i2] === 1;
      const adjacentToEnd = chebyshevAdjacent(t, endTile);
      const adjacentToStart = chebyshevAdjacent(t, startTile);
      if (isWindow && (adjacentToStart || adjacentToEnd)) {
        // pass through: shooting from/into a window
      } else {
        return { clear: false, blockedAt: { x: t.x + 0.5, y: t.y + 0.5 }, visibility: 0 };
      }
    } else {
      if (ignoreConcealment) continue;
      // Low growth only hides what the sight line actually passes through: a standing man or a
      // tank commander looks over a field of tall grass, while the line down to a prone man dips
      // into it near him. Holes (craters, trenches) hide their occupants, never the ground beyond.
      let vegM = LOW_GROWTH_HEIGHT_M[terrain];
      let conceal = tp.concealment;
      // Tall grass and crops pressed down by vehicles or blasts: what is left standing in the tile
      // sets both how high the screen is and how much it hides.
      if (vegM !== undefined && GROWTH_HEIGHT_M[terrain]) {
        const standing = tileStanding(map, i2);
        if (standing < 1) { vegM *= standing; conceal *= standing; }
      }
      if (vegM !== undefined) {
        const eyeM = heights?.eyeM ?? EYE_STANDING_M;
        const tgtM = heights?.targetM ?? EYE_STANDING_M;
        let lineAboveGroundM: number;
        if (ground && invLen2 > 0) {
          const f = ((t.x - fx) * ax + (t.y - fy) * ay) * invLen2;
          lineAboveGroundM = eyeZ + dz * f - ground[i2];
        } else {
          const n = tiles.length - 1;
          lineAboveGroundM = eyeM + (tgtM - eyeM) * (n > 0 ? i / n : 0);
        }
        if (lineAboveGroundM >= vegM) conceal = 0;
      }
      accumulated += conceal + (map.smoke[i2] ?? 0) * 1.5;
      if (accumulated >= 1.0) {
        return { clear: false, blockedAt: { x: t.x + 0.5, y: t.y + 0.5 }, visibility: 0 };
      }
    }
  }

  // Bresenham should have reached (tx,ty); if not (degenerate), treat as visible from here.
  const visibility = Math.max(0, 1 - accumulated) * losDistanceFactor(distM);
  return { clear: true, blockedAt: null, visibility };
}

export function hasLOS(map: GameMap, from: Vec2, to: Vec2, heights?: LosHeights): boolean {
  return losTrace(map, from, to, heights).clear;
}

/** An estimated aim can pass through smoke/leaves, but never through a hill or a solid wall.
 * Actual rounds still collide with vegetation (shotTrace.ts). This does not grant visibility. */
export function hasLineOfFire(map: GameMap, from: Vec2, to: Vec2, heights?: LosHeights): boolean {
  return losTrace(map, from, to, heights, true).clear;
}

/** Could a round fired from `from` actually arrive at a man standing at `to`? Like
 * hasLineOfFire, but the man's own tile counts as solid when it is a hard LOS block
 * (a wall face already stopped the round) — woods stays pass-through. */
export function roundCanReach(map: GameMap, from: Vec2, to: Vec2, heights?: LosHeights): boolean {
  return losTrace(map, from, to, heights, true, true).clear;
}
