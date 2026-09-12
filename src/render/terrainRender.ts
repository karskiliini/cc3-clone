// ============================================================================
// terrainRender.ts — bakes the painted CC3-style terrain into offscreen chunk
// canvases and blits them each frame. Also draws craters/blood/smoke overlays.
//
// Technique: ground + crops + roads + water + rubble are all resolved in one
// per-pixel ImageData pass, using fractal value noise (see noise.ts) sampled
// in world PIXEL space so texture is continuous across chunk boundaries. Every
// ground terrain has a 4-shade ramp (dark -> light); a per-pixel noise value
// picks a fractional position along that ramp and RGB-interpolates, giving
// soft mottled hand-painted colour instead of flat vector fills. A low-
// frequency height field adds gentle relief shading (NW light). Coverage
// fields (roads/crops/water/rubble, sampled at tile centres, bilinearly
// interpolated at pixel resolution) are blended across a feathered band
// rather than hard-thresholded, so borders look brushed.
//
// Memory/perf: chunks are 16x16 tiles (320x320 px) and are LAZILY baked on
// first use, kept in an LRU cache capped at 48 canvases. `draw()` bakes at
// most 2 new chunks per call (each bake is budgeted to stay under ~25ms);
// chunks not yet baked are filled in from a cheap whole-map low-res (2px per
// tile) canvas scaled up, so scrolling never stalls. `thumbnail()` never
// bakes full-res chunks at all — it only ever scales that low-res canvas.
// ============================================================================
import type { Camera, GameMap, BattleState, MapVectorFeature, Terrain, Season, Vec2 } from '@/shared/types';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { fbm, fbm64, fbm14, heightField } from '@/render/noise';
import { idx, tileAt, inBounds } from '@/sim/map';
import { TERRAIN_COLORS } from '@/render/palette';
import { getTreeSprite, getSmokePuff } from '@/render/sprites';
import { drawDecorItem } from '@/render/decorSprites';
import { worldToScreen } from '@/engine/camera';

const CHUNK_TILES = 16;
const CHUNK_PX = CHUNK_TILES * TILE_PX; // 320
const MAX_CACHED_CHUNKS = 48;
const BAKES_PER_DRAW = 2;
const LOWRES_PX_PER_TILE = 2;

const BUILDING_TERRAINS = new Set<Terrain>(['buildingWood', 'buildingStone', 'floor']);
/** Terrain a pixel "falls back to" when the tile itself is a feature (road/water/crops/rubble/wall). */
const SOFT_GROUND = new Set<Terrain>(['open', 'grass', 'tallgrass', 'snow', 'mud']);

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
// hashStr is called a couple of times per pixel with one of ~19 Terrain strings — memoize.
const hashStrCacheMap = new Map<string, number>();
function hashStrCached(s: string): number {
  let v = hashStrCacheMap.get(s);
  if (v === undefined) { v = hashStr(s); hashStrCacheMap.set(s, v); }
  return v;
}

interface BuildingBBox {
  minX: number; minY: number; maxX: number; maxY: number;
  kind: 'wood' | 'stone';
  id: number;
}

interface FieldInfo { horiz: boolean }

// ============================================================================
// color ramps — 4-shade dark->light ramps for the painterly ground pass.
// Overrides live here (palette.ts is owned by another agent); anything not
// listed falls back to palette.ts's TERRAIN_COLORS (still ramp-lerped, so it
// still gets the fbm mottling treatment even without a bespoke ramp).
// ============================================================================
const ROAD_RAMP = ['#8b7b56', '#a08e62', '#b09e6f', '#bdab7b'];
const PAVED_RAMP = ['#4f4f4a', '#5f5f58', '#6f6f66', '#7c7b70'];
const MUD_RAMP = ['#4b3d2b', '#5b4a33', '#6b593d', '#78664a'];
const CROPS_RAMP = ['#8f7d3a', '#b09a47', '#c9b255', '#d9c465'];
const WATER_RAMP = ['#3c5566', '#4a6578', '#5a7688', '#6a8698'];
const ICE_RAMP = ['#b8c4cc', '#c8d2d9', '#d6dee4'];

const LOCAL_RAMPS: Partial<Record<Season, Partial<Record<Terrain, string[]>>>> = {
  summer: {
    open: ['#7d7250', '#928660', '#a3976c', '#b0a479'],
    grass: ['#4f5e2b', '#66743a', '#7a8748', '#8d9a56'],
    tallgrass: ['#6f7d3a', '#8a9648', '#a1ac57', '#b5bd66'],
    crops: CROPS_RAMP,
    mud: MUD_RAMP,
    dirtroad: ROAD_RAMP,
    pavedroad: PAVED_RAMP,
    water: WATER_RAMP,
  },
  autumn: {
    open: ['#8a7a48', '#93844f', '#847338', '#9c8c52'],
    grass: ['#6b6a32', '#847f3c', '#9a9348', '#ada55a'],
    tallgrass: ['#847a34', '#948a3e', '#726a2a', '#a4993f'],
    crops: CROPS_RAMP,
    mud: MUD_RAMP,
    dirtroad: ROAD_RAMP,
    pavedroad: PAVED_RAMP,
    water: WATER_RAMP,
  },
  winter: {
    snow: ['#c4c9d1', '#d6dae0', '#e6e9ee', '#f2f4f7'],
    dirtroad: ['#7c7264', '#8c8072', '#98897a', '#a49484'],
    pavedroad: ['#48484a', '#585858', '#666664', '#727068'],
    mud: ['#3a352e', '#4a4238', '#585044', '#635a4c'],
    water: ICE_RAMP,
  },
};
function rampFor(season: Season, t: Terrain): string[] {
  return LOCAL_RAMPS[season]?.[t] ?? TERRAIN_COLORS[season][t];
}

// ============================================================================
// color helpers
// ============================================================================
interface RGB { r: number; g: number; b: number }
const hexCache = new Map<string, RGB>();
function hexToRgb(hex: string): RGB {
  let c = hexCache.get(hex);
  if (!c) {
    c = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
    hexCache.set(hex, c);
  }
  return c;
}
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp255(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : v; }
function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}
function shade(c: RGB, amt: number): RGB { // amt: -1..1, fraction of brightness to add/remove
  return { r: clamp255(c.r * (1 + amt)), g: clamp255(c.g * (1 + amt)), b: clamp255(c.b * (1 + amt)) };
}
function shadeHex(hex: string, amt: number): string {
  const s = shade(hexToRgb(hex), amt);
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(s.r)}${h(s.g)}${h(s.b)}`;
}

const rampRgbCache = new Map<string, RGB[]>();
function rampRgb(season: Season, t: Terrain): RGB[] {
  const key = season + '|' + t;
  let r = rampRgbCache.get(key);
  if (!r) { r = rampFor(season, t).map(hexToRgb); rampRgbCache.set(key, r); }
  return r;
}
/** RGB-interpolate across an N-colour ramp at fractional position t (0..1). */
function rampLerp(ramp: RGB[], t: number): RGB {
  const n = ramp.length - 1;
  if (n <= 0) return ramp[0];
  const tt = clamp01(t) * n;
  let i = Math.floor(tt);
  if (i >= n) i = n - 1;
  return lerpRGB(ramp[i], ramp[i + 1], tt - i);
}

/**
 * Painterly ground colour for terrain `t` at world PIXEL coords (X,Y): two
 * fbm octave-bands (large ~6m mottling + medium) plus per-pixel grain pick a
 * fractional position along the terrain's dark->light ramp.
 */
function groundColorFbm(t: Terrain, season: Season, X: number, Y: number, seed: number): RGB {
  const ramp = rampRgb(season, t);
  const th = hashStrCached(t);
  const f64 = fbm64(X, Y, seed + th);
  const f14 = fbm14(X, Y, seed + th);
  const g = hash2(X, Y, seed + 31);
  const tt = clamp01(0.5 + 0.9 * (f64 - 0.5) + 0.5 * (f14 - 0.5) + 0.18 * (g - 0.5));
  return rampLerp(ramp, tt);
}

/** Smooth low-frequency relief shading factor (NW light), 0.85..1.15.
 * heightField's wavelength (~400px) is far larger than a pixel, so this is
 * computed once per 4x4-pixel block and cached for the life of a chunk bake
 * (reset per bakeChunk call) rather than resampled every pixel. */
let reliefCache: Map<number, number> | null = null;
function reliefFactor(X: number, Y: number, seed: number): number {
  const bx = X >> 2, by = Y >> 2;
  const key = (bx & 0xffff) * 100003 + (by & 0xffff);
  const cache = reliefCache;
  if (cache) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  const h1 = heightField(X - 4, Y - 4, seed);
  const h2 = heightField(X + 4, Y + 4, seed);
  let f = 1 + 0.18 * (h1 - h2) * 8;
  f = f < 0.85 ? 0.85 : f > 1.15 ? 1.15 : f;
  if (cache) cache.set(key, f);
  return f;
}

function setPixel(data: Uint8ClampedArray, w: number, x: number, y: number, c: RGB): void {
  const i = (y * w + x) * 4;
  data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = 255;
}

// ============================================================================
// coverage-field sampling: a boolean classifier over terrain, sampled at tile
// centres and bilinearly interpolated at pixel resolution. Grids are built
// once per chunk (with 1 tile of padding) so pixel-loop sampling is pure
// array lookups plus a small amount of noise.
// ============================================================================
interface Grid { data: Float32Array; size: number; any: boolean }

function buildGrid(map: GameMap, x0: number, y0: number, tiles: number, classify: (t: Terrain) => boolean): Grid {
  const size = tiles + 3;
  const data = new Float32Array(size * size);
  let any = false;
  for (let gy = 0; gy < size; gy++) {
    const ty = y0 - 1 + gy;
    for (let gx = 0; gx < size; gx++) {
      const tx = x0 - 1 + gx;
      const v = classify(tileAt(map, tx, ty)) ? 1 : 0;
      data[gy * size + gx] = v;
      if (v) any = true;
    }
  }
  return { data, size, any };
}

/** Bilinear sample of `grid` at the pixel (tx,px,ty,py) local to the chunk, plus hash noise.
 * Skips straight to 0 (no array/hash work at all) when the whole chunk has none of this
 * feature — a common case (e.g. a chunk deep in a forest has no roads/crops/water/rubble). */
function sampleGrid(grid: Grid, tx: number, px: number, ty: number, py: number, wpx: number, wpy: number, seed: number, noiseAmt = 0.08): number {
  if (!grid.any) return 0;
  const { data, size } = grid;
  const gx0 = tx + (px < 5 ? 0 : 1);
  const fx = px < 5 ? 0.5 + px / TILE_PX : px / TILE_PX - 0.5;
  const gy0 = ty + (py < 5 ? 0 : 1);
  const fy = py < 5 ? 0.5 + py / TILE_PX : py / TILE_PX - 0.5;
  const v00 = data[gy0 * size + gx0];
  const v10 = data[gy0 * size + gx0 + 1];
  const v01 = data[(gy0 + 1) * size + gx0];
  const v11 = data[(gy0 + 1) * size + gx0 + 1];
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  let v = a + (b - a) * fy;
  v += (hash2(wpx, wpy, seed) - 0.5) * 2 * noiseAmt;
  return v;
}

/** Ad-hoc (non-grid) coverage sample for sparse callers (tree placement) — a handful of calls
 * per tile, so plain tileAt lookups are fine here. */
function coverageAt(map: GameMap, classify: (t: Terrain) => boolean, tileXf: number, tileYf: number, seed: number, noiseAmt = 0.08): number {
  const x0 = Math.floor(tileXf), y0 = Math.floor(tileYf);
  const fx = tileXf - x0, fy = tileYf - y0;
  const v00 = classify(tileAt(map, x0, y0)) ? 1 : 0;
  const v10 = classify(tileAt(map, x0 + 1, y0)) ? 1 : 0;
  const v01 = classify(tileAt(map, x0, y0 + 1)) ? 1 : 0;
  const v11 = classify(tileAt(map, x0 + 1, y0 + 1)) ? 1 : 0;
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  let v = a + (b - a) * fy;
  v += (hash2(Math.round(tileXf * 100), Math.round(tileYf * 100), seed) - 0.5) * 2 * noiseAmt;
  return v;
}

// ============================================================================
// vector geometry rendering (roads/rivers) — signed-distance-to-polyline
// coverage instead of tile-grid rasterization, so edges are smooth ribbons
// rather than 1-tile stair-steps. Only used when the map declares
// `def.vectors`; tile-grid coverage (above) remains the fallback.
// ============================================================================
const VEC_FEATHER_PX = 6;

interface VecSegW { ax: number; ay: number; bx: number; by: number; halfW: number }
interface VecAreaField { segs: VecSegW[] }

/** Builds a segment list (in world PIXEL coords) for every vector of `kind`+`terrain`, clipped
 * to segments whose (width+feather+wobble)-expanded bbox actually overlaps this chunk. */
function buildAreaField(
  vectors: MapVectorFeature[] | undefined, kind: 'road' | 'river', terrain: Terrain,
  x0: number, y0: number, tilesW: number, tilesH: number,
): VecAreaField | null {
  if (!vectors || !vectors.length) return null;
  const pad = TILE_PX * 3; // generous margin for half-width + feather + fbm wobble
  const minX = x0 * TILE_PX - pad, maxX = (x0 + tilesW) * TILE_PX + pad;
  const minY = y0 * TILE_PX - pad, maxY = (y0 + tilesH) * TILE_PX + pad;
  const segs: VecSegW[] = [];
  for (const v of vectors) {
    if (v.kind !== kind || v.terrain !== terrain) continue;
    const halfW = (v.width * TILE_PX) / 2;
    for (let i = 0; i < v.points.length - 1; i++) {
      const a = v.points[i], b = v.points[i + 1];
      const ax = a.x * TILE_PX, ay = a.y * TILE_PX, bx = b.x * TILE_PX, by = b.y * TILE_PX;
      const sminX = Math.min(ax, bx) - halfW, smaxX = Math.max(ax, bx) + halfW;
      const sminY = Math.min(ay, by) - halfW, smaxY = Math.max(ay, by) + halfW;
      if (smaxX < minX || sminX > maxX || smaxY < minY || sminY > maxY) continue;
      segs.push({ ax, ay, bx, by, halfW });
    }
  }
  return segs.length ? { segs } : null;
}

interface VecSample { cov: number; dist: number; halfW: number }
const VEC_SAMPLE_NONE: VecSample = { cov: 0, dist: 0, halfW: 1 };

/** Coverage of a road/river vector field at world pixel (wpx,wpy): signed distance to the nearest
 * polyline segment (round joins, since it's a min over segments), smoothstep-feathered over
 * VEC_FEATHER_PX at a half-width modulated by low-amplitude coherent fbm so shoulders wander. */
function sampleVecArea(field: VecAreaField, wpx: number, wpy: number, seed: number): VecSample {
  let bestCov = 0, bestDist = 0, bestHalfW = 1;
  for (const s of field.segs) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-6 ? ((wpx - s.ax) * dx + (wpy - s.ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = s.ax + t * dx, cy = s.ay + t * dy;
    const ddx = wpx - cx, ddy = wpy - cy;
    // wobble amplitude is +-TILE_PX*0.25 and the feather band is VEC_FEATHER_PX either side of
    // that, so anything further than half-width + ~12px can never affect coverage — reject early.
    const margin = s.halfW + TILE_PX * 0.25 + VEC_FEATHER_PX + 2;
    const dist2 = ddx * ddx + ddy * ddy;
    if (dist2 > margin * margin) continue; // cheap reject before paying for fbm
    const dist = Math.sqrt(dist2);
    const wobble = (fbm(wpx / 40, wpy / 40, 2, seed) - 0.5) * TILE_PX * 0.5;
    const effHalf = s.halfW + wobble;
    const cov = clamp01(0.5 - (dist - effHalf) / VEC_FEATHER_PX);
    if (cov > bestCov) { bestCov = cov; bestDist = dist; bestHalfW = s.halfW; }
  }
  return bestCov > 0 ? { cov: bestCov, dist: bestDist, halfW: bestHalfW } : VEC_SAMPLE_NONE;
}

const isCrops = (t: Terrain) => t === 'crops';
const isPaved = (t: Terrain) => t === 'pavedroad';
const isDirtRoad = (t: Terrain) => t === 'dirtroad';
const isWater = (t: Terrain) => t === 'water';
const isRubble = (t: Terrain) => t === 'rubble';
const isDirtySource = (t: Terrain) => t === 'pavedroad' || t === 'dirtroad' || t === 'rubble';
const isWoody = (t: Terrain) => t === 'woods' || t === 'scatteredtrees';

// ---------------------------------------------------------------- base fill
function paintGroundAndFeatures(
  data: Uint8ClampedArray, bufW: number, map: GameMap, season: Season, seed: number,
  x0: number, y0: number, tilesW: number, tilesH: number,
  groundUnder: Terrain[], mapW: number, mapH: number,
  fieldId: Int32Array, fieldAxis: Map<number, FieldInfo>,
  cropsGrid: Grid, pavedGrid: Grid, dirtGrid: Grid, waterGrid: Grid, rubbleGrid: Grid, dirtyGrid: Grid,
  pavedVec: VecAreaField | null, dirtVec: VecAreaField | null, waterVec: VecAreaField | null,
): void {
  const groundAt = (tx: number, ty: number): Terrain => {
    const cx = tx < 0 ? 0 : tx >= mapW ? mapW - 1 : tx;
    const cy = ty < 0 ? 0 : ty >= mapH ? mapH - 1 : ty;
    return groundUnder[cy * mapW + cx];
  };

  for (let ty = 0; ty < tilesH; ty++) {
    const wy = y0 + ty;
    if (wy >= mapH) continue;
    for (let tx = 0; tx < tilesW; tx++) {
      const wx = x0 + tx;
      if (wx >= mapW) continue;

      for (let py = 0; py < TILE_PX; py++) {
        const wpy = wy * TILE_PX + py;
        for (let px = 0; px < TILE_PX; px++) {
          const wpx = wx * TILE_PX + px;

          // -------------------------------------------------------- coverage samples (cheap:
          // a handful of array lookups + one hash2 each — always computed first so the far
          // more expensive fbm ground blend below can be skipped entirely for pixels deep
          // inside a feature, since one of the branches further down will overwrite `color`
          // unconditionally in that case anyway). Roads/rivers prefer the smooth vector
          // distance field when the map declares one (see MapDef.vectors); tile-grid coverage
          // is the fallback (and always used for crops/rubble, which aren't vectorized).
          const covCrop = sampleGrid(cropsGrid, tx, px, ty, py, wpx, wpy, seed + 3001);
          const pavedRes = pavedVec ? sampleVecArea(pavedVec, wpx, wpy, seed + 3101) : null;
          const covPaved = pavedRes ? pavedRes.cov : sampleGrid(pavedGrid, tx, px, ty, py, wpx, wpy, seed + 3101);
          const dirtRes = dirtVec ? sampleVecArea(dirtVec, wpx, wpy, seed + 3201) : null;
          const covDirt = dirtRes ? dirtRes.cov : sampleGrid(dirtGrid, tx, px, ty, py, wpx, wpy, seed + 3201);
          const waterRes = waterVec ? sampleVecArea(waterVec, wpx, wpy, seed + 3301) : null;
          const covWater = waterRes ? waterRes.cov : sampleGrid(waterGrid, tx, px, ty, py, wpx, wpy, seed + 3301);
          const covRubble = sampleGrid(rubbleGrid, tx, px, ty, py, wpx, wpy, seed + 3401);
          const deepFeature = covCrop > 0.85 || covPaved > 0.85 || covDirt > 0.85 || covWater > 0.85 || covRubble > 0.85;

          // -------------------------------------------------- smoothed ground (feathered blend)
          let groundT: Terrain = 'grass';
          let color: RGB;
          if (!deepFeature) {
            const cx0 = px < 5 ? wx - 1 : wx, cx1 = cx0 + 1;
            const cy0 = py < 5 ? wy - 1 : wy, cy1 = cy0 + 1;
            const tA = groundAt(cx0, cy0), tB = groundAt(cx1, cy0), tC = groundAt(cx0, cy1), tD = groundAt(cx1, cy1);
            // coherent low-frequency fbm wobble of the sample position (not per-pixel white
            // noise) so tile-to-tile ground borders wander like a brushed edge rather than
            // staying tile-aligned — applies uniformly to every soft-ground class (grass,
            // open, tallgrass, snow, mud all flow through this same code path).
            const wobX = (fbm(wpx / 24, wpy / 24, 1, seed + 8801) - 0.5) * (VEC_FEATHER_PX * 1.6);
            const wobY = (fbm(wpx / 24, wpy / 24, 1, seed + 8802) - 0.5) * (VEC_FEATHER_PX * 1.6);
            const fxx = clamp01((px < 5 ? 0.5 + px / TILE_PX : px / TILE_PX - 0.5) + wobX / TILE_PX);
            const fyy = clamp01((py < 5 ? 0.5 + py / TILE_PX : py / TILE_PX - 0.5) + wobY / TILE_PX);
            const sA = (1 - fxx) * (1 - fyy), sB = fxx * (1 - fyy), sC = (1 - fxx) * fyy, sD = fxx * fyy;
            const nA = sA + (hash2(wpx, wpy, seed + hashStrCached(tA)) - 0.5) * 0.06;
            const nB = sB + (hash2(wpx, wpy, seed + hashStrCached(tB)) - 0.5) * 0.06;
            const nC = sC + (hash2(wpx, wpy, seed + hashStrCached(tC)) - 0.5) * 0.06;
            const nD = sD + (hash2(wpx, wpy, seed + hashStrCached(tD)) - 0.5) * 0.06;
            let bestT: Terrain, bestS: number, secondT: Terrain, secondS: number;
            if (nA >= nB) { bestT = tA; bestS = nA; secondT = tB; secondS = nB; } else { bestT = tB; bestS = nB; secondT = tA; secondS = nA; }
            if (nC > bestS) { secondT = bestT; secondS = bestS; bestT = tC; bestS = nC; } else if (nC > secondS) { secondT = tC; secondS = nC; }
            if (nD > bestS) { secondT = bestT; secondS = bestS; bestT = tD; bestS = nD; } else if (nD > secondS) { secondT = tD; secondS = nD; }
            groundT = bestT;
            color = groundColorFbm(bestT, season, wpx, wpy, seed);
            // feathered 6px-ish blend band near borders (only pay for a second sample when close)
            if (secondT !== bestT && bestS - secondS < 0.3) {
              const blend = clamp01(0.5 - (bestS - secondS) / 0.6) * 0.85;
              color = lerpRGB(color, groundColorFbm(secondT, season, wpx, wpy, seed), blend);
            }
          } else {
            color = { r: 0, g: 0, b: 0 }; // overwritten unconditionally by a covX>0.5 branch below
          }

          // ------------------------------------------------- wear: worn shoulders near roads
          if (!deepFeature && (groundT === 'grass' || groundT === 'open' || groundT === 'tallgrass') && covCrop <= 0.5 && covWater <= 0.5) {
            const roadProx = Math.max(covDirt, covPaved * 0.7);
            if (roadProx > 0.02 && roadProx < 0.55) {
              const wearAmt = clamp01(roadProx / 0.55) * 0.4;
              color = lerpRGB(color, groundColorFbm('dirtroad', season, wpx, wpy, seed), wearAmt);
            }
          }

          // -------------------------------------------------------- crops
          if (covCrop > 0.5) {
            const fid = fieldId[wy * mapW + wx];
            const info = fid >= 0 ? fieldAxis.get(fid) : undefined;
            const horiz = info ? info.horiz : true;
            const cropBase = groundColorFbm('crops', season, wpx, wpy, seed);
            const stripe = horiz ? Math.floor(wpy / 2) % 2 : Math.floor(wpx / 2) % 2;
            const ragged = hash2(wpx, wpy, seed + 909) < 0.1;
            color = ragged ? cropBase : shade(cropBase, stripe === 0 ? 0.1 : -0.1);
            if (covCrop < 0.6) color = shade(color, -0.12); // headland darker near edge
          }

          // -------------------------------------------------------- roads
          if (covPaved > 0.5) {
            let rc = groundColorFbm('pavedroad', season, wpx, wpy, seed);
            const nearEdge = pavedRes ? pavedRes.dist > pavedRes.halfW * 0.82 : covPaved < 0.58;
            if (nearEdge) rc = shade(rc, -0.16); // kerb
            const crackBlockX = Math.floor(wpx / 3), crackBlockY = Math.floor(wpy / 3);
            if (hash2(crackBlockX, crackBlockY, seed + 4501) < 0.02) rc = shade(rc, -0.24);
            color = rc;
          } else if (covDirt > 0.5) {
            let rc = groundColorFbm('dirtroad', season, wpx, wpy, seed);
            // softened, worn ruts: two shallow bands either side of the centreline, with hash
            // breaks so they read as worn, not painted-on. From vector geometry this is a
            // proper distance iso-band at +-0.35*halfwidth; from the tile-grid fallback it's
            // an approximation via the coverage value itself.
            if (dirtRes) {
              const rutBand = Math.abs(dirtRes.dist - 0.35 * dirtRes.halfW);
              if (rutBand < 1.6 && hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 4602) > 0.2) rc = shade(rc, -0.1);
            } else if (covDirt >= 0.6 && covDirt <= 0.72 && hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 4602) > 0.2) {
              rc = shade(rc, -0.1);
            }
            if (hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 4610) < 0.02) rc = shade(rc, -0.2); // sparse stones
            color = rc;
          }

          // -------------------------------------------------------- water
          if (covWater > 0.5) {
            let wc = groundColorFbm('water', season, wpx, wpy, seed);
            const bankRatio = waterRes ? waterRes.dist / waterRes.halfW : null;
            if (season === 'winter') {
              const crackBlockX = Math.floor(wpx / 5), crackBlockY = Math.floor(wpy / 5);
              if (hash2(crackBlockX, crackBlockY, seed + 4801) < 0.03) wc = shade(wc, -0.18);
              const atBank = bankRatio !== null ? bankRatio > 0.66 : covWater < 0.66;
              if (atBank) wc = lerpRGB(wc, { r: 236, g: 240, b: 244 }, 0.5); // snow drift at the bank
            } else if (bankRatio !== null) {
              if (bankRatio > 0.82) wc = shade(wc, -0.3); // dark bank line
              else if (bankRatio > 0.62) wc = shade(wc, 0.18); // bank highlight band
            } else {
              if (covWater < 0.62) wc = shade(wc, -0.3);
              else if (covWater < 0.72) wc = shade(wc, 0.18);
            }
            color = wc;
          }

          // -------------------------------------------------------- rubble
          if (covRubble > 0.5) {
            let rb = groundColorFbm('rubble', season, wpx, wpy, seed);
            const bx = Math.floor(wpx / 2), by = Math.floor(wpy / 2);
            const fragH = hash2(bx, by, seed + 3501);
            if (fragH < 0.08) {
              rb = fragH < 0.04 ? { r: 138, g: 74, b: 58 } : { r: 116, g: 112, b: 104 };
            } else {
              rb = shade(rb, -0.06); // dust
            }
            color = rb;
          }

          // ---------------------------------------------------- dirty snow near roads/rubble
          if (season === 'winter' && groundT === 'snow' && covPaved <= 0.5 && covDirt <= 0.5 && covRubble <= 0.5) {
            const covDirty = sampleGrid(dirtyGrid, tx, px, ty, py, wpx, wpy, seed + 3601, 0.05);
            const blend = clamp01(covDirty) * 0.55;
            if (blend > 0.01) color = lerpRGB(color, groundColorFbm('mud', season, wpx, wpy, seed), blend);
          }

          // -------------------------------------------------------- relief + grain + brush
          const rf = reliefFactor(wpx, wpy, seed);
          color = shade(color, rf - 1);
          const grain = (hash2(wpx, wpy, seed + 9001) - 0.5) * 8;
          color = { r: clamp255(color.r + grain), g: clamp255(color.g + grain), b: clamp255(color.b + grain) };
          const brush = 0.97 + 0.06 * hash2(Math.floor(wpx / 2), Math.floor(wpy / 3), seed + 9002);
          color = { r: clamp255(color.r * brush), g: clamp255(color.g * brush), b: clamp255(color.b * brush) };

          setPixel(data, bufW, tx * TILE_PX + px, ty * TILE_PX + py, color);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ crater
function craterRimColor(season: Season): string { return season === 'winter' ? '#8a8f92' : '#a08f68'; }

function paintCraterAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, seed: number, season: Season): void {
  const steps = 10;
  ctx.save();
  ctx.beginPath();
  for (let a = 0; a <= steps; a++) {
    const ang = (a / steps) * Math.PI * 2;
    const rr = r * (0.85 + hash2(a, Math.round(cx * 3), seed) * 0.3);
    const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
    if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.clip();
  const grad = ctx.createRadialGradient(cx - r * 0.15, cy - r * 0.15, r * 0.08, cx, cy, r);
  grad.addColorStop(0, '#221d16');
  grad.addColorStop(0.55, '#3a2f22');
  grad.addColorStop(0.85, craterRimColor(season));
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = grad;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  // NW highlight / SE shadow for a raised-rim look
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.ellipse(cx - r * 0.3, cy - r * 0.3, r * 0.55, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.ellipse(cx + r * 0.3, cy + r * 0.3, r * 0.55, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function paintCraterTile(ctx: CanvasRenderingContext2D, ox: number, oy: number, seed: number, season: Season): void {
  const cx = ox + TILE_PX / 2, cy = oy + TILE_PX / 2, r = TILE_PX / 2 - 1;
  paintCraterAt(ctx, cx, cy, r, seed, season);
}

function paintMud(ctx: CanvasRenderingContext2D, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  for (let i = 0; i < 3; i++) {
    const px = Math.floor(hash2(wx * 9 + i, wy * 9 + i, seed + 61) * TILE_PX);
    const py = Math.floor(hash2(wx * 9 + i + 4, wy * 9 + i + 4, seed + 63) * TILE_PX);
    ctx.fillStyle = 'rgba(60,55,30,0.35)';
    ctx.fillRect(ox + px, oy + py, 1, 1);
  }
}

function paintBridge(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const horiz = tileAt(map, wx, wy - 1) !== 'bridge' && tileAt(map, wx, wy + 1) !== 'bridge';
  if (horiz) {
    for (let px = 0; px < TILE_PX; px += 3) { ctx.fillStyle = px % 6 === 0 ? '#7a5f3a' : '#5a4626'; ctx.fillRect(ox + px, oy, 2, TILE_PX); }
  } else {
    for (let py = 0; py < TILE_PX; py += 3) { ctx.fillStyle = py % 6 === 0 ? '#7a5f3a' : '#5a4626'; ctx.fillRect(ox, oy + py, TILE_PX, 2); }
  }
}

// ---------------------------------------------- ground texture (tufts/pebbles)
function paintGroundTexture(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number): void {
  const t = tileAt(map, wx, wy);
  if (season !== 'winter' && (t === 'grass' || t === 'tallgrass')) {
    const n = t === 'tallgrass' ? 4 : 2;
    for (let i = 0; i < n; i++) {
      if (hash2(wx * 7 + i, wy * 7 + i, seed + 7001) > 0.55) continue; // sparsify to ~6% of area overall
      const sx = ox + hash2(wx * 11 + i, wy * 11 + i, seed + 7002) * TILE_PX;
      const sy = oy + hash2(wx * 13 + i, wy * 13 + i, seed + 7003) * TILE_PX;
      const len = 2 + hash2(wx * 17 + i, wy * 17 + i, seed + 7004) * 3;
      const ang = -Math.PI / 2 + (hash2(wx * 19 + i, wy * 19 + i, seed + 7005) - 0.5) * (Math.PI / 3);
      const lighter = hash2(wx * 23 + i, wy * 23 + i, seed + 7006) > 0.4;
      ctx.strokeStyle = lighter ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
      ctx.stroke();
    }
  } else if (season !== 'winter' && t === 'open') {
    if (hash2(wx, wy, seed + 7101) < 0.3) {
      const sx = ox + hash2(wx * 29, wy * 29, seed + 7102) * TILE_PX;
      const sy = oy + hash2(wx * 31, wy * 31, seed + 7103) * TILE_PX;
      const lighter = hash2(wx * 37, wy * 37, seed + 7104) > 0.5;
      ctx.fillStyle = lighter ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
      ctx.fillRect(sx, sy, 1, 1);
    }
  }
}

// ------------------------------------------------- thin connected linear features
/** Shared skeleton for stonewall/hedge/fence/trench: draws a band centred in the tile that
 * stubs out toward every same-class 8-neighbour that shares the class, so straight runs,
 * corners and junctions are all continuous rather than a per-tile fat rectangle. */
function linearStubs(map: GameMap, wx: number, wy: number, sameClass: (t: Terrain) => boolean): { r: boolean; l: boolean; d: boolean; u: boolean; any: boolean } {
  const r = sameClass(tileAt(map, wx + 1, wy));
  const l = sameClass(tileAt(map, wx - 1, wy));
  const d = sameClass(tileAt(map, wx, wy + 1));
  const u = sameClass(tileAt(map, wx, wy - 1));
  return { r, l, d, u, any: r || l || d || u };
}

function drawBand(ctx: CanvasRenderingContext2D, ox: number, oy: number, width: number, stubs: ReturnType<typeof linearStubs>, color: string): void {
  const half = width / 2;
  const c = TILE_PX / 2;
  ctx.fillStyle = color;
  ctx.fillRect(ox + c - half, oy + c - half, width, width); // hub
  if (stubs.r) ctx.fillRect(ox + c, oy + c - half, TILE_PX - c, width);
  if (stubs.l) ctx.fillRect(ox, oy + c - half, c, width);
  if (stubs.d) ctx.fillRect(ox + c - half, oy + c, width, TILE_PX - c);
  if (stubs.u) ctx.fillRect(ox + c - half, oy, width, c);
  if (!stubs.any) ctx.fillRect(ox, oy + c - half, TILE_PX, width);
}

function paintStonewall(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const stubs = linearStubs(map, wx, wy, (t) => t === 'stonewall');
  // shadow on S/E side of the band
  ctx.globalAlpha = 0.28;
  drawBand(ctx, ox + 1, oy + 1, 4, stubs, '#101008');
  ctx.globalAlpha = 1;
  drawBand(ctx, ox, oy, 4, stubs, '#9a9a92');
  // joints every 3px along the run + a 1px darker shadow edge
  ctx.fillStyle = '#5a5a52';
  const c = TILE_PX / 2;
  if (stubs.r || stubs.l) { for (let x = 0; x < TILE_PX; x += 3) ctx.fillRect(ox + x, oy + c - 2, 1, 4); }
  else { for (let y = 0; y < TILE_PX; y += 3) ctx.fillRect(ox + c - 2, oy + y, 4, 1); }
}

function paintHedge(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  const stubs = linearStubs(map, wx, wy, (t) => t === 'hedge');
  ctx.globalAlpha = 0.25;
  drawBand(ctx, ox + 1, oy + 1, 6, stubs, '#0a1408');
  ctx.globalAlpha = 1;
  drawBand(ctx, ox, oy, 6, stubs, '#2c3d22');
  // lighter bumpy top pixels
  const c = TILE_PX / 2;
  ctx.fillStyle = '#4c6a34';
  for (let i = 0; i < TILE_PX; i += 2) {
    const bump = hash2(wx * 4 + i, wy * 4 + i, seed + 71) > 0.5 ? 1 : 0;
    if (stubs.r || stubs.l) ctx.fillRect(ox + i, oy + c - 3 + bump, 2, 1);
    else ctx.fillRect(ox + c - 3 + bump, oy + i, 1, 2);
  }
}

function paintFence(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const stubs = linearStubs(map, wx, wy, (t) => t === 'fence');
  drawBand(ctx, ox, oy, 2, stubs, '#5a4326');
  // posts every 2 tiles
  if ((wx + wy) % 2 === 0) {
    const c = TILE_PX / 2;
    ctx.fillStyle = '#3a2c18';
    ctx.fillRect(ox + c - 1, oy + c - 1, 3, 3);
  }
}

function paintTrench(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  const stubs = linearStubs(map, wx, wy, (t) => t === 'trench');
  ctx.globalAlpha = 0.3;
  drawBand(ctx, ox, oy, 7, stubs, '#786c54'); // lighter spoil either side
  ctx.globalAlpha = 1;
  const jag = (hash2(wx, wy, seed + 601) - 0.5) * 2;
  const c = TILE_PX / 2 + jag;
  ctx.fillStyle = '#161410';
  if (stubs.r || stubs.l) ctx.fillRect(ox, oy + Math.round(c) - 2, TILE_PX, 5);
  else ctx.fillRect(ox + Math.round(c) - 2, oy, 5, TILE_PX);
}

// ---------------------------------------------------------------- buildings
const WOOD_ROOF_VARIANTS = [
  { base: '#6f4a2c', light: '#89613c', dark: '#4c3018' },
  { base: '#7a3f2c', light: '#96543c', dark: '#54281a' },
  { base: '#63432c', light: '#7d5b3c', dark: '#42291a' },
];
const STONE_ROOF_VARIANTS = [
  { base: '#6d6d68', light: '#87877e', dark: '#454541' },
  { base: '#743832', light: '#8f4d44', dark: '#4a221e' },
];
const BLOCK_FLAT_VARIANTS = ['#5a5a54', '#6a4c3e', '#3e4a3a', '#524848', '#454c40'];

function paintRoofWeathering(ctx: CanvasRenderingContext2D, left: number, top: number, w: number, h: number, id: number): void {
  const n = Math.max(2, Math.min(24, Math.floor((w * h) / 500)));
  for (let i = 0; i < n; i++) {
    const rx = left + hash2(id * 13 + i, i, 601) * w;
    const ry = top + hash2(id * 17 + i, i, 602) * h;
    const sz = 2 + Math.floor(hash2(id * 19 + i, i, 603) * 3);
    const lighter = hash2(id * 23 + i, i, 604) > 0.5;
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = lighter ? '#ffffff' : '#000000';
    ctx.fillRect(rx, ry, sz, sz);
  }
  ctx.globalAlpha = 1;
}

function paintRoof(ctx: CanvasRenderingContext2D, bb: BuildingBBox, x0: number, y0: number): void {
  const left = (bb.minX - x0) * TILE_PX;
  const top = (bb.minY - y0) * TILE_PX;
  const wTiles = bb.maxX - bb.minX + 1;
  const hTiles = bb.maxY - bb.minY + 1;
  const w = wTiles * TILE_PX;
  const h = hTiles * TILE_PX;
  const stone = bb.kind === 'stone';
  const big = Math.max(wTiles, hTiles) > 12;

  // soft shadow cast onto the ground on the S and E sides (two alpha steps), drawn first.
  ctx.fillStyle = 'rgba(8,8,6,0.35)';
  ctx.fillRect(left + w, top + 3, 1, h - 3);
  ctx.fillRect(left + 3, top + h, w - 3, 1);
  ctx.fillStyle = 'rgba(8,8,6,0.16)';
  ctx.fillRect(left + w + 1, top + 3, 2, h - 3);
  ctx.fillRect(left + 3, top + h + 1, w - 3, 2);

  if (big) {
    const flat = BLOCK_FLAT_VARIANTS[bb.id % BLOCK_FLAT_VARIANTS.length];
    ctx.fillStyle = flat;
    ctx.fillRect(left, top, w, h);
    // lighter parapet inset by 1px
    ctx.strokeStyle = shadeHex(flat, 0.22);
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 1.5, top + 1.5, Math.max(0, w - 3), Math.max(0, h - 3));
    ctx.fillStyle = shadeHex(flat, -0.3);
    ctx.fillRect(left, top + h - 1, w, 1);
    ctx.fillRect(left + w - 1, top, 1, h);
    // row of small chimneys along the ridge line
    const chimN = Math.max(2, Math.floor(w / 24));
    ctx.fillStyle = '#2c2a26';
    for (let i = 0; i < chimN; i++) {
      const cx = left + 4 + Math.floor((i * (w - 8)) / Math.max(1, chimN - 1));
      ctx.fillRect(cx, top + 2, 2, 2);
    }
    // skylights
    ctx.fillStyle = '#8a9aa0';
    const skyN = Math.max(2, Math.floor((w * h) / 900));
    for (let i = 0; i < skyN; i++) {
      const sx = left + 3 + Math.floor(hash2(bb.id * 7 + i, i, 55) * Math.max(1, w - 6));
      const sy = top + 3 + Math.floor(hash2(bb.id * 11 + i, i, 56) * Math.max(1, h - 6));
      ctx.fillRect(sx, sy, 2, 2);
    }
    paintRoofWeathering(ctx, left, top, w, h, bb.id);
    if (stone) {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      for (let gx = 5; gx < w; gx += 6) { ctx.beginPath(); ctx.moveTo(left + gx + 0.5, top); ctx.lineTo(left + gx + 0.5, top + h); ctx.stroke(); }
      for (let gy = 5; gy < h; gy += 6) { ctx.beginPath(); ctx.moveTo(left, top + gy + 0.5); ctx.lineTo(left + w, top + gy + 0.5); ctx.stroke(); }
    }
    return;
  }

  const variants = stone ? STONE_ROOF_VARIANTS : WOOD_ROOF_VARIANTS;
  const v = variants[bb.id % variants.length];
  const ridgeHoriz = wTiles >= hTiles; // ridge runs along the longer axis

  // shaded (unlit) slope first, full footprint
  ctx.fillStyle = v.dark;
  ctx.fillRect(left, top, w, h);
  // lit slope, >=18% brighter than the shaded slope
  ctx.fillStyle = v.light;
  if (ridgeHoriz) ctx.fillRect(left, top, w, Math.ceil(h / 2));
  else ctx.fillRect(left, top, Math.ceil(w / 2), h);

  // plank/tile lines perpendicular to the ridge, -8% brightness
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  if (ridgeHoriz) { for (let x = 2; x < w; x += 3) ctx.fillRect(left + x, top, 1, h); }
  else { for (let y = 2; y < h; y += 3) ctx.fillRect(left, top + y, w, 1); }

  // ridge line: 1px lighter than the lit slope
  ctx.fillStyle = shadeHex(v.light, 0.2);
  if (ridgeHoriz) ctx.fillRect(left, top + Math.floor(h / 2), w, 1);
  else ctx.fillRect(left + Math.floor(w / 2), top, 1, h);

  // eave outline: 1px dark
  ctx.strokeStyle = v.dark;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));

  // faint stone-coursing mortar lines
  if (stone) {
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    for (let gx = 4; gx < w; gx += 5) { ctx.beginPath(); ctx.moveTo(left + gx + 0.5, top); ctx.lineTo(left + gx + 0.5, top + h); ctx.stroke(); }
    for (let gy = 4; gy < h; gy += 5) { ctx.beginPath(); ctx.moveTo(left, top + gy + 0.5); ctx.lineTo(left + w, top + gy + 0.5); ctx.stroke(); }
  }

  // chimney on buildings >= 5x5 tiles, with a highlight
  if (wTiles >= 5 && hTiles >= 5) {
    const chimSize = 3;
    const cx = left + w - chimSize - 2, cy = top + 2;
    ctx.fillStyle = '#38352e';
    ctx.fillRect(cx, cy, chimSize, chimSize);
    ctx.fillStyle = '#7a766c';
    ctx.fillRect(cx, cy, chimSize, 1);
    ctx.fillRect(cx, cy, 1, chimSize);
  }

  paintRoofWeathering(ctx, left, top, w, h, bb.id);
}

function paintEaveNotches(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const i = idx(map, wx, wy);
  if (!map.windows[i]) return;
  const bid = map.buildingId[i];
  const dirs: [number, number, 'l' | 'r' | 't' | 'b'][] = [[-1, 0, 'l'], [1, 0, 'r'], [0, -1, 't'], [0, 1, 'b']];
  ctx.fillStyle = 'rgba(224,214,164,0.7)';
  for (const [dx, dy, side] of dirs) {
    const outer = !inBounds(map, wx + dx, wy + dy) || map.buildingId[idx(map, wx + dx, wy + dy)] !== bid;
    if (!outer) continue;
    if (side === 'l') ctx.fillRect(ox, oy + 4, 1, 2);
    else if (side === 'r') ctx.fillRect(ox + TILE_PX - 1, oy + 4, 1, 2);
    else if (side === 't') ctx.fillRect(ox + 4, oy, 2, 1);
    else ctx.fillRect(ox + 4, oy + TILE_PX - 1, 2, 1);
  }
}

// --------------------------------------------------------------------- trees
function paintTreeShadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  ctx.save();
  ctx.translate(cx + 4, cy + 6);
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * (1 - i * 0.15), ry * (1 - i * 0.15), 0, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Winter leafless scrub tree: a spiky brown starburst with a small dark centre. */
function paintScrubTree(ctx: CanvasRenderingContext2D, cx: number, cy: number, seed: number, size: number): void {
  ctx.globalAlpha = 0.2;
  ctx.beginPath();
  ctx.ellipse(cx + 3, cy + 4, size * 0.5, size * 0.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.globalAlpha = 1;
  const n = 6 + Math.floor(hash2(Math.round(cx), Math.round(cy), seed) * 5);
  ctx.strokeStyle = '#5a4530';
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + hash2(Math.round(cx) + i, Math.round(cy), seed + 1) * 0.6;
    const len = size * (0.4 + hash2(Math.round(cx), Math.round(cy) + i, seed + 2) * 0.6);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len * 0.6 - len * 0.25);
    ctx.stroke();
  }
  ctx.fillStyle = '#2c2418';
  ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.fill();
}

function paintTrees(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number): void {
  const t = tileAt(map, wx, wy);
  if (t === 'woods') {
    const count = hash2(wx, wy, seed + 101) < 0.4 ? 3 : 5;
    for (let i = 0; i < count; i++) {
      const jxT = (hash2(wx * 13 + i, wy * 13 + i, seed + 103) - 0.5) * 1.4;
      const jyT = (hash2(wx * 13 + i + 5, wy * 13 + i + 5, seed + 107) - 0.5) * 1.4;
      // ragged canopy edge: reject candidates that fall outside the smoothed woody field
      if (coverageAt(map, isWoody, wx + 0.5 + jxT, wy + 0.5 + jyT, seed + 8801) < 0.5) continue;
      const cx = ox + (0.5 + jxT) * TILE_PX, cy = oy + (0.5 + jyT) * TILE_PX;
      if (season === 'winter') {
        const size = 12 + hash2(wx * 23 + i, wy * 23 + i, seed + 121) * 10;
        paintScrubTree(ctx, cx, cy, seed + 121, size);
      } else {
        const variant = Math.floor(hash2(wx * 17 + i, wy * 17 + i, seed + 109) * 3);
        const scale = 0.8 + hash2(wx * 23 + i, wy * 23 + i, seed + 121) * 0.5;
        const sprite = getTreeSprite(variant, season);
        const dw = sprite.width * scale, dh = sprite.height * scale;
        paintTreeShadow(ctx, cx, cy, dw * 0.45, dh * 0.25);
        ctx.drawImage(sprite, Math.round(cx - dw / 2), Math.round(cy - dh / 2), dw, dh);
      }
    }
  } else if (t === 'scatteredtrees') {
    if (hash2(wx, wy, seed + 111) < 0.55) {
      const jxT = (hash2(wx * 19, wy * 19, seed + 113) - 0.5) * 0.4;
      const jyT = (hash2(wx * 23, wy * 23, seed + 117) - 0.5) * 0.4;
      if (coverageAt(map, isWoody, wx + 0.5 + jxT, wy + 0.5 + jyT, seed + 8802) >= 0.5) {
        const cx = ox + (0.5 + jxT) * TILE_PX, cy = oy + (0.5 + jyT) * TILE_PX;
        if (season === 'winter') {
          const size = 12 + hash2(wx * 31, wy * 31, seed + 123) * 10;
          paintScrubTree(ctx, cx, cy, seed + 123, size);
        } else {
          const variant = Math.floor(hash2(wx * 29, wy * 29, seed + 119) * 3);
          const scale = 0.85 + hash2(wx * 31, wy * 31, seed + 123) * 0.4;
          const sprite = getTreeSprite(variant, season);
          const dw = sprite.width * scale, dh = sprite.height * scale;
          paintTreeShadow(ctx, cx, cy, dw * 0.45, dh * 0.25);
          ctx.drawImage(sprite, Math.round(cx - dw / 2), Math.round(cy - dh / 2), dw, dh);
        }
      }
    }
    // occasional bush near the edge of scattered trees / woods
    if (hash2(wx, wy, seed + 131) < 0.18) {
      drawDecorItem(ctx, 'bush', ox + TILE_PX / 2 + (hash2(wx * 37, wy * 37, seed + 133) - 0.5) * 6, oy + TILE_PX / 2 + (hash2(wx * 41, wy * 41, seed + 137) - 0.5) * 6);
    }
  } else if (t === 'grass' || t === 'hedge') {
    if (hash2(wx, wy, seed + 141) < 0.02) {
      drawDecorItem(ctx, 'bush', ox + TILE_PX / 2, oy + TILE_PX / 2);
    }
  }
}

/** Tiles whose terrain is in `vectorLineTerrains` are rendered by `paintLineVector` as one
 * smooth stroked path per chunk instead — skip the blocky per-tile band for those here. */
function paintDetail(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number, vectorLineTerrains: Set<Terrain>): void {
  const t = tileAt(map, wx, wy);
  switch (t) {
    case 'mud': paintMud(ctx, wx, wy, ox, oy, seed); break;
    case 'crater': paintCraterTile(ctx, ox, oy, seed, season); break;
    case 'trench': if (!vectorLineTerrains.has('trench')) paintTrench(ctx, map, wx, wy, ox, oy, seed); break;
    case 'hedge': if (!vectorLineTerrains.has('hedge')) paintHedge(ctx, map, wx, wy, ox, oy, seed); break;
    case 'fence': if (!vectorLineTerrains.has('fence')) paintFence(ctx, map, wx, wy, ox, oy); break;
    case 'stonewall': if (!vectorLineTerrains.has('stonewall')) paintStonewall(ctx, map, wx, wy, ox, oy); break;
    case 'bridge': paintBridge(ctx, map, wx, wy, ox, oy); break;
    default: paintGroundTexture(ctx, map, wx, wy, ox, oy, season, seed); break;
  }
}

// ------------------------------------------------- smooth vector line features (hedge/fence/
// stonewall/trench): a single stroked path with round joins per feature, instead of the
// per-tile axis-aligned band, so diagonal runs don't stair-step.
function strokePolylineWorld(ctx: CanvasRenderingContext2D, points: Vec2[], x0: number, y0: number, widthPx: number, color: string): void {
  if (points.length < 2 || widthPx <= 0) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.beginPath();
  ctx.moveTo((points[0].x - x0) * TILE_PX, (points[0].y - y0) * TILE_PX);
  for (let i = 1; i < points.length; i++) ctx.lineTo((points[i].x - x0) * TILE_PX, (points[i].y - y0) * TILE_PX);
  ctx.stroke();
  ctx.restore();
}

/** Walks a polyline (tile coords) at a fixed pixel spacing, calling `cb` with the world-pixel
 * position and unit tangent at each stop — used to place fence posts / wall joint ticks. */
function walkPolylineWorld(points: Vec2[], spacingPx: number, cb: (wx: number, wy: number, ux: number, uy: number) => void): void {
  let carry = 0;
  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s], b = points[s + 1];
    const ax = a.x * TILE_PX, ay = a.y * TILE_PX, bx = b.x * TILE_PX, by = b.y * TILE_PX;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len, uy = dy / len;
    let d = carry;
    while (d < len) {
      cb(ax + ux * d, ay + uy * d, ux, uy);
      d += spacingPx;
    }
    carry = d - len;
  }
}

function paintLineVector(ctx: CanvasRenderingContext2D, v: MapVectorFeature, x0: number, y0: number, seed: number): void {
  const pts = v.points;
  if (pts.length < 2) return;
  if (v.terrain === 'hedge') {
    strokePolylineWorld(ctx, pts, x0, y0, TILE_PX * 0.4, 'rgba(10,20,8,0.28)');
    strokePolylineWorld(ctx, pts, x0, y0, TILE_PX * 0.3, '#2c3d22');
    strokePolylineWorld(ctx, pts, x0, y0, TILE_PX * 0.15, 'rgba(76,106,52,0.55)');
  } else if (v.terrain === 'stonewall') {
    strokePolylineWorld(ctx, pts, x0, y0, TILE_PX * 0.24, 'rgba(16,16,8,0.3)');
    strokePolylineWorld(ctx, pts, x0, y0, TILE_PX * 0.2, '#9a9a92');
    ctx.strokeStyle = '#5a5a52';
    ctx.lineWidth = 1;
    walkPolylineWorld(pts, 3, (wx, wy, ux, uy) => {
      const lx = wx - x0 * TILE_PX, ly = wy - y0 * TILE_PX;
      const px_ = -uy * 2, py_ = ux * 2;
      ctx.beginPath();
      ctx.moveTo(lx - px_, ly - py_);
      ctx.lineTo(lx + px_, ly + py_);
      ctx.stroke();
    });
  } else if (v.terrain === 'fence') {
    strokePolylineWorld(ctx, pts, x0, y0, 2, '#5a4326');
    ctx.fillStyle = '#3a2c18';
    walkPolylineWorld(pts, TILE_PX * 2, (wx, wy) => {
      const lx = wx - x0 * TILE_PX, ly = wy - y0 * TILE_PX;
      ctx.fillRect(lx - 1, ly - 1, 3, 3);
    });
  } else if (v.terrain === 'trench') {
    strokePolylineWorld(ctx, pts, x0, y0, TILE_PX * 0.35, 'rgba(120,108,84,0.32)');
    strokePolylineWorld(ctx, pts, x0, y0, TILE_PX * 0.25, '#161410');
  } else {
    void seed;
  }
}

// ============================================================================
export class TerrainRenderer {
  private map: GameMap;
  private seed: number;
  private chunksX: number;
  private chunksY: number;
  /** Insertion-ordered LRU cache: oldest-used key is first. */
  private chunks = new Map<string, HTMLCanvasElement>();
  private buildingBBoxes = new Map<number, BuildingBBox>();
  private fieldId: Int32Array;
  private fieldAxis = new Map<number, FieldInfo>();
  private groundUnder: Terrain[];
  private lowRes: HTMLCanvasElement | null = null;
  /** Terrains (hedge/fence/stonewall/trench) fully covered by a 'line' vector on this map — the
   * per-tile band painter is skipped for these and a smooth stroked path is drawn instead. */
  private vectorLineTerrains = new Set<Terrain>();

  constructor(map: GameMap) {
    this.map = map;
    this.seed = hashStr(map.def.id) ^ (map.width * 73856093) ^ (map.height * 19349663);
    this.chunksX = Math.max(1, Math.ceil(map.width / CHUNK_TILES));
    this.chunksY = Math.max(1, Math.ceil(map.height / CHUNK_TILES));
    this.fieldId = new Int32Array(map.width * map.height).fill(-1);
    this.computeBuildingBBoxes();
    this.computeFields();
    this.groundUnder = this.computeGroundUnder();
    if (map.def.vectors) {
      for (const v of map.def.vectors) if (v.kind === 'line') this.vectorLineTerrains.add(v.terrain);
    }
  }

  /** Nearest soft-ground terrain per tile (BFS/Voronoi from all soft-ground tiles), used as the
   * "what's really under this road/rubble/building tile" base for the smooth ground pass. */
  private computeGroundUnder(): Terrain[] {
    const map = this.map;
    const w = map.width, h = map.height;
    const n = w * h;
    const result: Terrain[] = new Array(n);
    const visited = new Uint8Array(n);
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (SOFT_GROUND.has(map.tiles[i])) { result[i] = map.tiles[i]; visited[i] = 1; queue.push(i); }
    }
    if (queue.length === 0) {
      const fallback: Terrain = map.def.season === 'winter' ? 'snow' : 'grass';
      result.fill(fallback);
      return result;
    }
    let qh = 0;
    while (qh < queue.length) {
      const ci = queue[qh++];
      const cx = ci % w, cy = (ci / w) | 0;
      const neighbors: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (visited[ni]) continue;
        visited[ni] = 1;
        result[ni] = result[ci];
        queue.push(ni);
      }
    }
    return result;
  }

  private computeBuildingBBoxes(): void {
    const map = this.map;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = idx(map, x, y);
        const bid = map.buildingId[i];
        if (bid < 0) continue;
        const isStone = map.tiles[i] === 'buildingStone';
        let bb = this.buildingBBoxes.get(bid);
        if (!bb) {
          bb = { minX: x, minY: y, maxX: x, maxY: y, kind: isStone ? 'stone' : 'wood', id: bid };
          this.buildingBBoxes.set(bid, bb);
        } else {
          bb.minX = Math.min(bb.minX, x); bb.minY = Math.min(bb.minY, y);
          bb.maxX = Math.max(bb.maxX, x); bb.maxY = Math.max(bb.maxY, y);
          if (isStone) bb.kind = 'stone';
        }
      }
    }
  }

  /** Flood-fill contiguous 'crops' tiles into field ids, and pick a row axis per field. */
  private computeFields(): void {
    const map = this.map;
    const w = map.width, h = map.height;
    let nextId = 0;
    const stack: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(map, x, y);
        if (this.fieldId[i] !== -1 || map.tiles[i] !== 'crops') continue;
        const id = nextId++;
        stack.push(i);
        this.fieldId[i] = id;
        while (stack.length) {
          const ci = stack.pop()!;
          const cx = ci % w, cy = Math.floor(ci / w);
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (this.fieldId[ni] !== -1 || map.tiles[ni] !== 'crops') continue;
            this.fieldId[ni] = id;
            stack.push(ni);
          }
        }
        this.fieldAxis.set(id, { horiz: hash2(x, y, this.seed + 303) < 0.5 });
      }
    }
  }

  private chunkKey(cx: number, cy: number): string { return `${cx},${cy}`; }

  invalidateTile(x: number, y: number): void {
    const cx = Math.floor(x / CHUNK_TILES);
    const cy = Math.floor(y / CHUNK_TILES);
    this.chunks.delete(this.chunkKey(cx, cy));
    this.updateLowResTile(x, y);
  }

  /** Move `key` to the most-recently-used end; evict the oldest entry past the cap. */
  private touchChunk(key: string, canvas: HTMLCanvasElement): void {
    if (this.chunks.has(key)) this.chunks.delete(key);
    this.chunks.set(key, canvas);
    if (this.chunks.size > MAX_CACHED_CHUNKS) {
      const oldest = this.chunks.keys().next().value;
      if (oldest !== undefined) this.chunks.delete(oldest);
    }
  }

  private bakeChunk(cx: number, cy: number): HTMLCanvasElement {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_PX;
    canvas.height = CHUNK_PX;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const season = this.map.def.season;
    const x0 = cx * CHUNK_TILES, y0 = cy * CHUNK_TILES;
    const map = this.map;

    // ------------------------------------------------------ coverage grids (fallback when a
    // road/river has no vector geometry, and always for crops/rubble which aren't vectorized)
    const cropsGrid = buildGrid(map, x0, y0, CHUNK_TILES, isCrops);
    const pavedGrid = buildGrid(map, x0, y0, CHUNK_TILES, isPaved);
    const dirtGrid = buildGrid(map, x0, y0, CHUNK_TILES, isDirtRoad);
    const waterGrid = buildGrid(map, x0, y0, CHUNK_TILES, isWater);
    const rubbleGrid = buildGrid(map, x0, y0, CHUNK_TILES, isRubble);
    const dirtyGrid = season === 'winter' ? buildGrid(map, x0, y0, CHUNK_TILES, isDirtySource) : cropsGrid;

    // ------------------------------------------------------ vector geometry (smooth roads/rivers)
    const pavedVec = buildAreaField(map.def.vectors, 'road', 'pavedroad', x0, y0, CHUNK_TILES, CHUNK_TILES);
    const dirtVec = buildAreaField(map.def.vectors, 'road', 'dirtroad', x0, y0, CHUNK_TILES, CHUNK_TILES);
    const waterVec = buildAreaField(map.def.vectors, 'river', 'water', x0, y0, CHUNK_TILES, CHUNK_TILES);

    // ------------------------------------------------------------ ground+features pass
    const img = ctx.createImageData(CHUNK_PX, CHUNK_PX);
    reliefCache = new Map<number, number>();
    paintGroundAndFeatures(
      img.data, CHUNK_PX, map, season, this.seed, x0, y0, CHUNK_TILES, CHUNK_TILES,
      this.groundUnder, map.width, map.height, this.fieldId, this.fieldAxis,
      cropsGrid, pavedGrid, dirtGrid, waterGrid, rubbleGrid, dirtyGrid,
      pavedVec, dirtVec, waterVec,
    );
    reliefCache = null;
    ctx.putImageData(img, 0, 0);

    // ------------------------------------------------------------ detail pass (walls/hedges/etc + ground texture)
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= map.width) continue;
        if (BUILDING_TERRAINS.has(tileAt(map, wx, wy))) continue;
        paintDetail(ctx, map, wx, wy, tx * TILE_PX, ty * TILE_PX, season, this.seed, this.vectorLineTerrains);
      }
    }

    // ------------------------------------------------------------ smooth vector line features
    // (hedge/fence/stonewall/trench) drawn once per chunk as a stroked path, replacing the
    // per-tile bands skipped above for terrains that have vector geometry on this map.
    if (map.def.vectors && this.vectorLineTerrains.size) {
      for (const v of map.def.vectors) {
        if (v.kind !== 'line') continue;
        paintLineVector(ctx, v, x0, y0, this.seed);
      }
    }

    // ------------------------------------------------------------ buildings
    for (const bb of this.buildingBBoxes.values()) {
      if (bb.maxX < x0 || bb.minX >= x0 + CHUNK_TILES || bb.maxY < y0 || bb.minY >= y0 + CHUNK_TILES) continue;
      paintRoof(ctx, bb, x0, y0);
    }
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= map.width) continue;
        const t = tileAt(map, wx, wy);
        if (t === 'buildingWood' || t === 'buildingStone') paintEaveNotches(ctx, map, wx, wy, tx * TILE_PX, ty * TILE_PX);
      }
    }

    // ------------------------------------------------------------ trees/bushes
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= map.width) continue;
        paintTrees(ctx, map, wx, wy, tx * TILE_PX, ty * TILE_PX, season, this.seed);
      }
    }

    // ------------------------------------------------------------ decor
    this.drawDecor(ctx, x0, y0);

    const dt = t0 ? performance.now() - t0 : 0;
    if (typeof console !== 'undefined' && dt) {
      // eslint-disable-next-line no-console
      console.log(`[terrain] baked chunk (${cx},${cy}) in ${dt.toFixed(1)}ms`);
    }
    return canvas;
  }

  private drawDecor(ctx: CanvasRenderingContext2D, x0: number, y0: number): void {
    const decor = this.map.def.decor;
    if (!decor || !decor.length) return;
    for (const d of decor) {
      if (d.x < x0 - 1 || d.x >= x0 + CHUNK_TILES + 1 || d.y < y0 - 1 || d.y >= y0 + CHUNK_TILES + 1) continue;
      const cx = (d.x - x0) * TILE_PX;
      const cy = (d.y - y0) * TILE_PX;
      drawDecorItem(ctx, d.kind, cx, cy, d.variant ?? 0);
    }
  }

  // -------------------------------------------------------------- low-res
  /** Cheap flat-colour whole-map painter at 2px/tile, used for the thumbnail and as a
   * placeholder for chunks that haven't been baked yet. Never touches per-tile ImageData
   * loops or fbm — just one flat (lightly hash-tinted) fill per tile. */
  private ensureLowRes(): HTMLCanvasElement {
    if (this.lowRes) return this.lowRes;
    const map = this.map;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, map.width * LOWRES_PX_PER_TILE);
    canvas.height = Math.max(1, map.height * LOWRES_PX_PER_TILE);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) this.paintLowResTile(ctx, x, y);
    }
    this.lowRes = canvas;
    return canvas;
  }

  private paintLowResTile(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const map = this.map;
    const season = map.def.season;
    const t = tileAt(map, x, y);
    const i = idx(map, x, y);
    let color: RGB;
    if (t === 'buildingWood' || t === 'buildingStone' || t === 'floor') {
      const bid = map.buildingId[i];
      const bb = bid >= 0 ? this.buildingBBoxes.get(bid) : undefined;
      const stone = bb ? bb.kind === 'stone' : t === 'buildingStone';
      color = hexToRgb(stone ? '#6d6d68' : '#6f4a2c');
    } else if (t === 'woods') {
      color = hexToRgb(season === 'winter' ? '#7a7468' : '#33502a');
    } else if (t === 'scatteredtrees') {
      color = hexToRgb(season === 'winter' ? '#8a8478' : '#43602f');
    } else if (t === 'water') {
      color = hexToRgb(season === 'winter' ? '#c8d2d9' : '#4a6578');
    } else if (t === 'crater' || t === 'bridge') {
      color = rampLerp(rampRgb(season, this.groundUnder[i]), 0.5);
    } else {
      color = rampLerp(rampRgb(season, t), 0.5);
    }
    const tint = (hash2(x, y, this.seed + 8811) - 0.5) * 10;
    color = { r: clamp255(color.r + tint), g: clamp255(color.g + tint), b: clamp255(color.b + tint) };
    ctx.fillStyle = `rgb(${color.r | 0},${color.g | 0},${color.b | 0})`;
    ctx.fillRect(x * LOWRES_PX_PER_TILE, y * LOWRES_PX_PER_TILE, LOWRES_PX_PER_TILE, LOWRES_PX_PER_TILE);
  }

  private updateLowResTile(x: number, y: number): void {
    if (!this.lowRes) return;
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return;
    this.paintLowResTile(this.lowRes.getContext('2d')!, x, y);
  }

  // -------------------------------------------------------------- draw / thumbnail
  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const px = TILE_PX * cam.zoom;
    const viewTilesW = VIEW_W / px;
    const viewTilesH = VIEW_H / px;
    const startCx = Math.max(0, Math.floor(cam.x / CHUNK_TILES));
    const endCx = Math.min(this.chunksX - 1, Math.floor((cam.x + viewTilesW) / CHUNK_TILES));
    const startCy = Math.max(0, Math.floor(cam.y / CHUNK_TILES));
    const endCy = Math.min(this.chunksY - 1, Math.floor((cam.y + viewTilesH) / CHUNK_TILES));
    let bakeBudget = BAKES_PER_DRAW;
    const lowRes = this.ensureLowRes();
    for (let cy = startCy; cy <= endCy; cy++) {
      for (let cx = startCx; cx <= endCx; cx++) {
        const key = this.chunkKey(cx, cy);
        let chunk = this.chunks.get(key);
        if (chunk) {
          this.touchChunk(key, chunk);
        } else if (bakeBudget > 0) {
          chunk = this.bakeChunk(cx, cy);
          this.touchChunk(key, chunk);
          bakeBudget--;
        }
        const s = worldToScreen(cam, { x: cx * CHUNK_TILES, y: cy * CHUNK_TILES });
        const size = CHUNK_PX * cam.zoom;
        if (chunk) {
          ctx.drawImage(chunk, s.x, s.y, size, size);
        } else {
          // not yet baked this session — fall back to the cheap low-res whole-map painter
          const sx = cx * CHUNK_TILES * LOWRES_PX_PER_TILE;
          const sy = cy * CHUNK_TILES * LOWRES_PX_PER_TILE;
          const sw = Math.min(CHUNK_TILES * LOWRES_PX_PER_TILE, lowRes.width - sx);
          const sh = Math.min(CHUNK_TILES * LOWRES_PX_PER_TILE, lowRes.height - sy);
          if (sw > 0 && sh > 0) ctx.drawImage(lowRes, sx, sy, sw, sh, s.x, s.y, size, size);
        }
      }
    }
    ctx.restore();
  }

  thumbnail(w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const lowRes = this.ensureLowRes();
    const mapPxW = this.map.width * LOWRES_PX_PER_TILE;
    const mapPxH = this.map.height * LOWRES_PX_PER_TILE;
    const scale = Math.min(w / mapPxW, h / mapPxH);
    const dw = mapPxW * scale, dh = mapPxH * scale;
    const offX = (w - dw) / 2, offY = (h - dh) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lowRes, 0, 0, mapPxW, mapPxH, offX, offY, dw, dh);
    return canvas;
  }

  drawOverlays(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const map = state.map;
    const season = map.def.season;
    const px = TILE_PX * cam.zoom;

    if (map.dirtyTiles && map.dirtyTiles.length) {
      for (const ti of map.dirtyTiles) this.invalidateTile(ti % map.width, Math.floor(ti / map.width));
      map.dirtyTiles.length = 0;
    }

    for (const ti of map.craters) {
      const cx = ti % map.width, cy = Math.floor(ti / map.width);
      const s = worldToScreen(cam, { x: cx + 0.5, y: cy + 0.5 });
      if (s.x < -px || s.x > VIEW_W + px || s.y < -px || s.y > VIEW_H + px) continue;
      const r = px / 2 - 1;
      paintCraterAt(ctx, s.x, s.y, r, this.seed + ti, season);
    }

    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#5a1a12';
    for (const p of state.bloodDecals) {
      const s = worldToScreen(cam, p);
      ctx.fillRect(Math.round(s.x - 1), Math.round(s.y - 1), 2, 2);
    }
    ctx.globalAlpha = 1;

    const viewTilesW = VIEW_W / px, viewTilesH = VIEW_H / px;
    const minX = Math.max(0, Math.floor(cam.x) - 1);
    const maxX = Math.min(map.width - 1, Math.ceil(cam.x + viewTilesW) + 1);
    const minY = Math.max(0, Math.floor(cam.y) - 1);
    const maxY = Math.min(map.height - 1, Math.ceil(cam.y + viewTilesH) + 1);
    let count = 0;
    for (let y = minY; y <= maxY && count < 400; y++) {
      for (let x = minX; x <= maxX && count < 400; x++) {
        const d = map.smoke[idx(map, x, y)];
        if (!d || d <= 0.05) continue;
        const jx = (hash2(x, y, 777) - 0.5) * 0.4;
        const jy = (hash2(x, y, 778) - 0.5) * 0.4;
        const s = worldToScreen(cam, { x: x + 0.5 + jx, y: y + 0.5 + jy });
        const sprite = getSmokePuff(24);
        ctx.globalAlpha = Math.min(1, d * 0.9);
        ctx.drawImage(sprite, Math.round(s.x - (sprite.width * cam.zoom) / 2), Math.round(s.y - (sprite.height * cam.zoom) / 2), sprite.width * cam.zoom, sprite.height * cam.zoom);
        count++;
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
