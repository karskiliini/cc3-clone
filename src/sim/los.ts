import type { GameMap, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { TERRAIN_PROPS } from './terrain';
import { idx, inBounds } from './map';

export interface LosResult {
  clear: boolean;
  blockedAt: Vec2 | null;
  visibility: number;
}

/** 1 at 0m, 0.5 at 200m, 0.2 at 400m, linear piecewise, clamped >= 0 beyond. */
export function losDistanceFactor(distM: number): number {
  if (distM <= 0) return 1;
  if (distM <= 200) return 1 + (0.5 - 1) * (distM / 200);
  if (distM <= 400) return 0.5 + (0.2 - 0.5) * ((distM - 200) / 200);
  // extrapolate the same slope beyond 400m, clamped at 0
  const beyond = 0.2 + (0.2 - 0.5) * ((distM - 400) / 200);
  return Math.max(0, beyond);
}

function bresenhamTiles(x0: number, y0: number, x1: number, y1: number): Vec2[] {
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

export function losTrace(map: GameMap, from: Vec2, to: Vec2): LosResult {
  const fx = Math.floor(from.x), fy = Math.floor(from.y);
  const tx = Math.floor(to.x), ty = Math.floor(to.y);
  const startTile: Vec2 = { x: fx, y: fy };
  const endTile: Vec2 = { x: tx, y: ty };
  const distM = Math.hypot(to.x - from.x, to.y - from.y) * TILE_M;

  const startTerrain = inBounds(map, fx, fy) ? map.tiles[idx(map, fx, fy)] : 'open';
  const startIsWoods = startTerrain === 'woods';

  const tiles = bresenhamTiles(fx, fy, tx, ty);
  let accumulated = 0;

  for (let i = 1; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.x === tx && t.y === ty) {
      // end tile reached: visible (subject to accumulated concealment already tallied)
      const visibility = Math.max(0, 1 - accumulated) * losDistanceFactor(distM);
      return { clear: true, blockedAt: null, visibility };
    }
    if (!inBounds(map, t.x, t.y)) {
      const center = { x: t.x + 0.5, y: t.y + 0.5 };
      return { clear: false, blockedAt: center, visibility: 0 };
    }
    const i2 = idx(map, t.x, t.y);
    const terrain = map.tiles[i2];
    const tp = TERRAIN_PROPS[terrain];

    if (terrain === 'woods') {
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
      accumulated += tp.concealment + (map.smoke[i2] ?? 0) * 1.5;
      if (accumulated >= 1.0) {
        return { clear: false, blockedAt: { x: t.x + 0.5, y: t.y + 0.5 }, visibility: 0 };
      }
    }
  }

  // Bresenham should have reached (tx,ty); if not (degenerate), treat as visible from here.
  const visibility = Math.max(0, 1 - accumulated) * losDistanceFactor(distM);
  return { clear: true, blockedAt: null, visibility };
}

export function hasLOS(map: GameMap, from: Vec2, to: Vec2): boolean {
  return losTrace(map, from, to).clear;
}
