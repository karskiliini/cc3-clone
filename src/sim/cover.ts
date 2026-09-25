// ============================================================================
// cover.ts — directional cover model (spec §9). A tile's protection against
// fire depends on the direction the fire is coming from: omnidirectional
// terrain cover (trench/crater/building interior/rubble/woods) plus linear
// cover from a wall/hedge/fence/wreck on the threat side.
// ============================================================================
import type { GameMap, Terrain, Vec2 } from '@/shared/types';
import { inBounds, tileAt } from './map';
import { TERRAIN_PROPS } from './terrain';

const OMNI_COVER: Partial<Record<Terrain, number>> = {
  trench: 0.8, crater: 0.5, buildingStone: 0.5, buildingWood: 0.5, floor: 0.5, rubble: 0.5, woods: 0.45,
};

/** Occupants of a bunker interior get near-immunity to small arms (G7). */
export const BUNKER_COVER = 0.85;

function omniCoverOf(map: GameMap, tx: number, ty: number, t: Terrain): number {
  if (map.bunkerId && map.bunkerId[ty * map.width + tx] >= 0) return BUNKER_COVER;
  return OMNI_COVER[t] ?? TERRAIN_PROPS[t].cover;
}

/** Omnidirectional cover value at a tile (spec §9's list), for display and tie-breaking. */
export function omniCoverAt(map: GameMap, tile: Vec2): number {
  const tx = Math.floor(tile.x), ty = Math.floor(tile.y);
  if (!inBounds(map, tx, ty)) return 0;
  return omniCoverOf(map, tx, ty, tileAt(map, tx, ty));
}

const LINEAR_COVER: Partial<Record<Terrain, number>> = {
  stonewall: 0.7, buildingStone: 0.85, buildingWood: 0.6, hedge: 0.3, fence: 0.05, rubble: 0.4, scatteredtrees: 0.25,
};

export interface CoverContext {
  /** tile keys ("x,y") treated as a knocked-out vehicle hull (linear cover 0.6). */
  wreckTiles?: Set<string>;
}

function linearCoverOf(map: GameMap, x: number, y: number, ctx?: CoverContext): number {
  if (!inBounds(map, x, y)) return 0;
  const t = tileAt(map, x, y);
  const lc = LINEAR_COVER[t];
  if (lc !== undefined) return lc;
  if (ctx?.wreckTiles?.has(`${x},${y}`)) return 0.6;
  return 0;
}

/** Extra protection from a REVERSE SLOPE: ground between this tile and the threat that rises
 * above it masks the firer's view of the lower body/legs and eats grazing fire. Looks 1-4 tiles
 * (2-8 m) toward the threat and scores the largest rise above the tile itself — a full 1.5 m
 * crest is worth CREST_MAX. Costs at most four Float32Array reads and is skipped entirely on a
 * flat map. (Hard masking — the crest blocking the shot outright — is losTrace's job; this is the
 * partial-defilade case where the firer can still see the head and shoulders.) */
const CREST_FULL_M = 1.5;
const CREST_MAX = 0.35;
function crestProtection(map: GameMap, tx: number, ty: number, stepX: number, stepY: number): number {
  const g = map.ground;
  if (!g) return 0;
  const here = g[ty * map.width + tx];
  let rise = 0;
  for (let k = 1; k <= 4; k++) {
    const nx = tx + stepX * k, ny = ty + stepY * k;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) break;
    const d = g[ny * map.width + nx] - here;
    if (d > rise) rise = d;
  }
  return clamp01(rise / CREST_FULL_M) * CREST_MAX;
}

/** Directional protection 0..1 against fire arriving FROM `dirRad` (radians, 0 = north, clockwise,
 * matching angleTo's convention): the tile's own omni cover plus linear cover from the neighbouring
 * tile toward the threat (full weight) and the two diagonal neighbours (half weight each). */
export function coverFrom(map: GameMap, tile: Vec2, dirRad: number, ctx?: CoverContext): number {
  const tx = Math.floor(tile.x), ty = Math.floor(tile.y);
  if (!inBounds(map, tx, ty)) return 0;
  const omni = omniCoverOf(map, tx, ty, tileAt(map, tx, ty));

  const stepX = Math.round(Math.sin(dirRad));
  const stepY = Math.round(-Math.cos(dirRad));
  let diag1 = { dx: 0, dy: 0 };
  let diag2 = { dx: 0, dy: 0 };
  if (stepX !== 0 && stepY !== 0) {
    diag1 = { dx: stepX, dy: 0 };
    diag2 = { dx: 0, dy: stepY };
  } else if (stepX !== 0) {
    diag1 = { dx: stepX, dy: 1 };
    diag2 = { dx: stepX, dy: -1 };
  } else if (stepY !== 0) {
    diag1 = { dx: 1, dy: stepY };
    diag2 = { dx: -1, dy: stepY };
  }

  const primaryCover = linearCoverOf(map, tx + stepX, ty + stepY, ctx);
  const diagCover = Math.max(
    linearCoverOf(map, tx + diag1.dx, ty + diag1.dy, ctx),
    linearCoverOf(map, tx + diag2.dx, ty + diag2.dy, ctx),
  );
  const rawLinear = Math.min(1, primaryCover + diagCover * 0.5);

  const c = omni + rawLinear * (1 - omni);
  const crest = crestProtection(map, tx, ty, stepX, stepY);
  return clamp01(c + crest * (1 - c));
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export interface ThreatWeighted { dirRad: number; weight: number }

/** Weighted average directional cover against up to 4 threats (spec §9), ties broken by omni cover
 * (callers compare that separately when scores are close). */
export function coverScore(map: GameMap, tile: Vec2, threats: ThreatWeighted[], ctx?: CoverContext): number {
  if (threats.length === 0) return omniCoverAt(map, tile);
  const capped = threats.slice(0, 4);
  const totalW = capped.reduce((sum, th) => sum + th.weight, 0) || 1;
  let score = 0;
  for (const th of capped) score += (th.weight / totalW) * coverFrom(map, tile, th.dirRad, ctx);
  return score;
}
