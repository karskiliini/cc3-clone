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
/** Burst budget used when a camera jump (map open, teleport, big scroll) leaves more than 2
 * visible chunks unbaked at once — lets the whole viewport catch up within ~2-3 draw() calls
 * instead of trickling in at 2/frame, while a normal small scroll (<=2 new chunks) still only
 * pays the small per-frame budget. */
const BAKES_PER_DRAW_BURST = 6;
const LOWRES_PX_PER_TILE = 2;

const BUILDING_TERRAINS = new Set<Terrain>(['buildingWood', 'buildingStone', 'floor']);
/** Terrain a pixel "falls back to" when the tile itself is a feature (road/water/crops/rubble/wall). */
// 'tallgrass' and 'mud' are deliberately NOT soft-ground seeds: they're rendered as blurred
// coverage overlays (see mudGrid/tallgrassGrid in paintGroundAndFeatures) so their macro shape
// can be smoothed independently of the tile-corner ground blend, same as crops/rubble.
const SOFT_GROUND = new Set<Terrain>(['open', 'grass', 'snow']);

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

/** sin/cos of the field's row angle, precomputed once per field so rendering never redoes trig. */
interface FieldInfo { sin: number; cos: number }

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
// grey-brown debris, not the pinkish-brown palette.ts default (that read as a paint spatter,
// especially over snow) — used for all seasons since rubble is rubble regardless.
const RUBBLE_RAMP = ['#6e675c', '#7a7266', '#847c70', '#8a8276'];

const LOCAL_RAMPS: Partial<Record<Season, Partial<Record<Terrain, string[]>>>> = {
  summer: {
    open: ['#7d7250', '#928660', '#a3976c', '#b0a479', '#c2b686'],
    grass: ['#4f5e2b', '#66743a', '#7a8748', '#8d9a56', '#a8b06a'],
    tallgrass: ['#6f7d3a', '#8a9648', '#a1ac57', '#b5bd66'],
    crops: CROPS_RAMP,
    mud: MUD_RAMP,
    dirtroad: ROAD_RAMP,
    pavedroad: PAVED_RAMP,
    water: WATER_RAMP,
    rubble: RUBBLE_RAMP,
  },
  autumn: {
    open: ['#8a7a48', '#93844f', '#847338', '#9c8c52', '#b8a850'],
    grass: ['#6b6a32', '#847f3c', '#9a9348', '#ada55a', '#c0b862'],
    tallgrass: ['#847a34', '#948a3e', '#726a2a', '#a4993f'],
    crops: CROPS_RAMP,
    mud: MUD_RAMP,
    dirtroad: ROAD_RAMP,
    pavedroad: PAVED_RAMP,
    water: WATER_RAMP,
    rubble: RUBBLE_RAMP,
  },
  winter: {
    snow: ['#c4c9d1', '#d6dae0', '#e6e9ee', '#f2f4f7'],
    dirtroad: ['#7c7264', '#8c8072', '#98897a', '#a49484'],
    pavedroad: ['#6a6c70', '#75777c', '#7d7f84', '#87898e'],
    mud: ['#3a352e', '#4a4238', '#585044', '#635a4c'],
    water: ICE_RAMP,
    rubble: RUBBLE_RAMP,
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
/** Blends toward `to` by `t` (0..1) — unlike shadeHex (which only scales brightness and so keeps
 * the original hue), this is what "snow-covered" needs: a green/brown roof under snow should
 * read as pale white-grey, not a brighter version of the same green/brown. */
function mixHex(hex: string, to: string, t: number): string {
  const s = lerpRGB(hexToRgb(hex), hexToRgb(to), t);
  const h = (n: number) => Math.round(clamp255(n)).toString(16).padStart(2, '0');
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
/** grass/open get a bright 5th "sunlit crest" ramp stop; bias the centre of the distribution
 * up a little so more of the NW-facing high ground actually reaches it (see fix #7). */
function groundColorFbm(t: Terrain, season: Season, X: number, Y: number, seed: number): RGB {
  const ramp = rampRgb(season, t);
  const th = hashStrCached(t);
  const f64 = fbm64(X, Y, seed + th);
  const f14 = fbm14(X, Y, seed + th);
  const g = hash2(X, Y, seed + 31);
  const bias = (t === 'grass' || t === 'open') ? 0.08 : 0;
  const tt = clamp01(0.5 + bias + 0.9 * (f64 - 0.5) + 0.5 * (f14 - 0.5) + 0.18 * (g - 0.5));
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

/**
 * Builds a coverage grid at tile-centre resolution (1 tile of padding either side, as before).
 * `blurR` > 0 pre-blurs the boolean classification with a box filter of that tile radius before
 * it's handed to `sampleGrid`'s bilinear+hash pass, so the underlying macro silhouette itself
 * loses its tile-stepped corners (not just the ~1-tile-wide edge band) — this is what makes
 * crops/mud/tallgrass/rubble patches read as soft amoeba blobs instead of staircases (fix #6).
 */
function buildGrid(map: GameMap, x0: number, y0: number, tiles: number, classify: (t: Terrain) => boolean, blurR = 0): Grid {
  const size = tiles + 3;
  const data = new Float32Array(size * size);
  let any = false;
  if (blurR <= 0) {
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
  // raw classification over a padded window so the box blur has real neighbours at every
  // output cell (including the +-1 tile sampling margin `sampleGrid` itself needs).
  const rawPad = blurR;
  const rawSize = size + 2 * rawPad;
  const raw = new Float32Array(rawSize * rawSize);
  for (let gy = 0; gy < rawSize; gy++) {
    const ty = y0 - 1 - rawPad + gy;
    for (let gx = 0; gx < rawSize; gx++) {
      const tx = x0 - 1 - rawPad + gx;
      raw[gy * rawSize + gx] = classify(tileAt(map, tx, ty)) ? 1 : 0;
    }
  }
  // separable box blur (horizontal pass, then vertical) — O(n*(2R+1)) instead of O(n*(2R+1)^2).
  const norm1 = 2 * blurR + 1;
  const tmp = new Float32Array(rawSize * size);
  for (let gy = 0; gy < rawSize; gy++) {
    const rowIn = gy * rawSize, rowOut = gy * size;
    for (let gx = 0; gx < size; gx++) {
      let sum = 0;
      const rcx = gx + rawPad;
      for (let dx = -blurR; dx <= blurR; dx++) sum += raw[rowIn + rcx + dx];
      tmp[rowOut + gx] = sum / norm1;
    }
  }
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      let sum = 0;
      for (let dy = -blurR; dy <= blurR; dy++) sum += tmp[(gy + rawPad + dy) * size + gx];
      const v = sum / norm1;
      data[gy * size + gx] = v;
      if (v > 0) any = true;
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
const isMud = (t: Terrain) => t === 'mud';
const isTallgrass = (t: Terrain) => t === 'tallgrass';
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
  cropsGrid: Grid, mudGrid: Grid, tallgrassGrid: Grid, pavedGrid: Grid, dirtGrid: Grid, waterGrid: Grid, rubbleGrid: Grid, dirtyGrid: Grid,
  pavedVec: VecAreaField | null, dirtVec: VecAreaField | null, waterVec: VecAreaField | null,
  tramRailY: number[],
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
          const covMud = sampleGrid(mudGrid, tx, px, ty, py, wpx, wpy, seed + 3011, 0.05);
          const covTallgrass = sampleGrid(tallgrassGrid, tx, px, ty, py, wpx, wpy, seed + 3021, 0.05);
          const pavedRes = pavedVec ? sampleVecArea(pavedVec, wpx, wpy, seed + 3101) : null;
          const covPaved = pavedRes ? pavedRes.cov : sampleGrid(pavedGrid, tx, px, ty, py, wpx, wpy, seed + 3101);
          const dirtRes = dirtVec ? sampleVecArea(dirtVec, wpx, wpy, seed + 3201) : null;
          const covDirt = dirtRes ? dirtRes.cov : sampleGrid(dirtGrid, tx, px, ty, py, wpx, wpy, seed + 3201);
          const waterRes = waterVec ? sampleVecArea(waterVec, wpx, wpy, seed + 3301) : null;
          const covWater = waterRes ? waterRes.cov : sampleGrid(waterGrid, tx, px, ty, py, wpx, wpy, seed + 3301);
          const covRubble = sampleGrid(rubbleGrid, tx, px, ty, py, wpx, wpy, seed + 3401);
          const deepFeature = covCrop > 0.85 || covMud > 0.85 || covTallgrass > 0.85 || covPaved > 0.85 || covDirt > 0.85 || covWater > 0.85 || covRubble > 0.85;

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
          if (!deepFeature && (groundT === 'grass' || groundT === 'open') && covCrop <= 0.5 && covMud <= 0.5 && covTallgrass <= 0.5 && covWater <= 0.5) {
            const roadProx = Math.max(covDirt, covPaved * 0.7);
            if (roadProx > 0.02 && roadProx < 0.55) {
              const wearAmt = clamp01(roadProx / 0.55) * 0.4;
              color = lerpRGB(color, groundColorFbm('dirtroad', season, wpx, wpy, seed), wearAmt);
            }
          }

          // ------------------------------------------------ tallgrass / mud (blurred coverage
          // overlays — see buildGrid's blurR — so their macro silhouette is a soft blob, not a
          // tile-stepped stamp; mud takes priority since it's usually the smaller, later detail)
          if (covTallgrass > 0.5) {
            let tg = groundColorFbm('tallgrass', season, wpx, wpy, seed);
            if (covTallgrass < 0.62) tg = shade(tg, -0.08); // feathered inner edge, slightly duller
            color = tg;
            groundT = 'tallgrass';
          }
          if (covMud > 0.5) {
            let mc = groundColorFbm('mud', season, wpx, wpy, seed);
            if (covMud < 0.62) mc = shade(mc, -0.1);
            color = mc;
            groundT = 'mud';
          }

          // -------------------------------------------------------- crops
          if (covCrop > 0.5) {
            // Row axis: ONE base angle for the whole MAP (see fieldBaseAngleDeg — hashed from
            // the map id to 0/90/occasionally 45 degrees), and each contiguous field (flood-
            // filled in computeFields, small fields inheriting their nearest large field's
            // angle) only adds a small +-12 degree wobble on top. This is what keeps adjacent
            // wheat patches from ever showing perpendicular rows next to each other — no
            // per-field coin-flip between "horizontal" and "vertical" any more.
            const fid = fieldId[wy * mapW + wx];
            const info = fid >= 0 ? fieldAxis.get(fid) : undefined;
            const sinT = info ? info.sin : 0, cosT = info ? info.cos : 1;
            const cropBase = groundColorFbm('crops', season, wpx, wpy, seed);
            // slight low-frequency fbm wobble along the row so lines don't look ruler-straight,
            // then 3px-spaced rows at +-7% brightness.
            const wobSeed = seed + (fid >= 0 ? fid * 131 : 0) + 7701;
            const wobble = (fbm(wpx / 60, wpy / 60, 1, wobSeed) - 0.5) * 4;
            const perp = -wpx * sinT + wpy * cosT + wobble;
            const rowPhase = ((Math.floor(perp / 3) % 2) + 2) % 2; // guard against negative perp
            let color2 = shade(cropBase, rowPhase === 0 ? 0.07 : -0.07);
            if (covCrop < 0.65) color2 = shade(color2, -0.14); // darker headland near the field edge
            color = color2;
          }

          // -------------------------------------------------------- roads
          if (covPaved > 0.5) {
            let rc = groundColorFbm('pavedroad', season, wpx, wpy, seed);
            if (season !== 'winter') {
              // cobble/sett texture: a per-cell brightness step every 3-4px so the surface reads
              // as individually laid stones rather than a flat tinted band. Skipped in winter —
              // a snow-covered street reading as a knitted hatch/corduroy pattern was exactly
              // the bug: smooth snow with soft wheel tracks reads right, cobble grain under snow
              // does not.
              const cobbleX = Math.floor(wpx / 4), cobbleY = Math.floor(wpy / 4);
              const cobble = hash2(cobbleX, cobbleY, seed + 4520);
              rc = shade(rc, (cobble - 0.5) * 0.08);
            }
            const nearEdge = pavedRes ? pavedRes.dist > pavedRes.halfW * 0.82 : covPaved < 0.58;
            const atGutter = pavedRes ? pavedRes.dist > pavedRes.halfW * 0.9 : covPaved < 0.55;
            if (season === 'winter') {
              // snow blends into the gutters over ~3px instead of a dark kerb line, and two
              // soft wheel-track bands read as slightly darker either side of the centreline.
              const ratio = pavedRes ? pavedRes.dist / pavedRes.halfW : 1 - covPaved;
              if (ratio > 0.78) {
                const snowBlend = clamp01((ratio - 0.78) / 0.22) * 0.8;
                rc = lerpRGB(rc, groundColorFbm('snow', season, wpx, wpy, seed), snowBlend);
              }
              const trackOff = pavedRes ? Math.abs(pavedRes.dist - 0.4 * pavedRes.halfW) : Math.abs(ratio - 0.4) * 6;
              if (trackOff < 1.6) rc = shade(rc, -0.14);
            } else {
              if (atGutter) rc = shade(rc, -0.32); // dark gutter line right at the edge
              else if (nearEdge) rc = shade(rc, -0.16); // kerb
            }
            const crackBlockX = Math.floor(wpx / 3), crackBlockY = Math.floor(wpy / 3);
            if (hash2(crackBlockX, crackBlockY, seed + 4501) < 0.02) rc = shade(rc, -0.24);
            // tram rails: two 1px dark lines 4px apart, where a tramwire decor line runs
            for (let i = 0; i < tramRailY.length; i++) {
              const off = wpy - tramRailY[i];
              if (off === -2 || off === 2) { rc = shade(rc, -0.55); break; }
            }
            color = rc;
          } else if (covDirt > 0.5) {
            let rc = groundColorFbm('dirtroad', season, wpx, wpy, seed);
            // worn ruts: two darker bands either side of the centreline, with hash breaks so
            // they read as worn wheel tracks, plus occasional puddle flecks along them (every
            // ~40-60px) for wetter contrast. From vector geometry this is a proper distance
            // iso-band at +-0.35*halfwidth; from the tile-grid fallback it's an approximation
            // via the coverage value itself.
            const inRutBand = dirtRes
              ? Math.abs(dirtRes.dist - 0.35 * dirtRes.halfW) < 1.6
              : covDirt >= 0.6 && covDirt <= 0.72;
            if (inRutBand && hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 4602) > 0.2) {
              const puddleBucketX = Math.floor(wpx / 45), puddleBucketY = Math.floor(wpy / 45);
              if (hash2(puddleBucketX, puddleBucketY, seed + 4603) < 0.15) {
                rc = lerpRGB(rc, { r: 66, g: 80, b: 86 }, 0.55); // wet puddle fleck in the rut
              } else {
                rc = shade(rc, -0.18);
              }
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
              // muted brick red fragments + dark grey wall-stub fragments (~8% combined)
              rb = fragH < 0.04 ? { r: 122, g: 74, b: 60 } : { r: 92, g: 88, b: 80 };
            } else {
              rb = shade(rb, -0.06); // dust
            }
            if (season === 'winter' && hash2(bx, by, seed + 3502) < 0.4) {
              rb = lerpRGB(rb, { r: 226, g: 230, b: 234 }, 0.5); // snow dusting on top of the debris
            }
            color = rb;
          }

          // ---------------------------------------------------- dirty snow near roads/rubble
          if (season === 'winter' && groundT === 'snow' && covPaved <= 0.5 && covDirt <= 0.5 && covRubble <= 0.5) {
            const covDirty = sampleGrid(dirtyGrid, tx, px, ty, py, wpx, wpy, seed + 3601, 0.05);
            const blend = clamp01(covDirty) * 0.55;
            if (blend > 0.01) color = lerpRGB(color, groundColorFbm('mud', season, wpx, wpy, seed), blend);
          }

          // ------------------------------------------- sparse per-pixel tufts on plain ground
          // (not crops/mud/tallgrass/roads/water/rubble): ~4% of pixels get a lighter or darker
          // fleck, on top of everything else, so open ground reads as grainy at 1:1 instead of
          // a smooth colour wash (round-2 critique #1).
          const plainGround = (groundT === 'grass' || groundT === 'open' || groundT === 'snow')
            && covCrop <= 0.5 && covMud <= 0.5 && covTallgrass <= 0.5
            && covPaved <= 0.5 && covDirt <= 0.5 && covWater <= 0.5 && covRubble <= 0.5;
          if (plainGround && hash2(wpx, wpy, seed + 9101) < 0.04) {
            color = shade(color, hash2(wpx, wpy, seed + 9102) > 0.5 ? 0.22 : -0.22);
          }

          // -------------------------------------------------------- relief + grain + brush
          const rf = reliefFactor(wpx, wpy, seed);
          color = shade(color, rf - 1);
          const grain = (hash2(wpx, wpy, seed + 9001) - 0.5) * 12; // +-6 RGB
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

  // splash/spoil rays radiating a short way beyond the rim, and occasional grass regrowth at
  // the outer lip — matches the reference's craters, which never read as an isolated clean disc.
  const rayN = 4 + Math.floor(hash2(Math.round(cx), Math.round(cy), seed + 71) * 3);
  ctx.strokeStyle = craterRimColor(season);
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < rayN; i++) {
    const ang = hash2(Math.round(cx) + i, Math.round(cy) + i, seed + 72) * Math.PI * 2;
    const r0 = r * (1.0 + hash2(i, Math.round(cx), seed + 73) * 0.1);
    const r1 = r * (1.15 + hash2(i, Math.round(cy), seed + 74) * 0.25);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (season !== 'winter' && hash2(Math.round(cx), Math.round(cy), seed + 75) < 0.15) {
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = '#7a8748';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
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

/** Debris pass for a rubble tile: a handful of rotated wall-fragment blocks with a highlight
 * edge and their own offset drop shadow, plus a scatter of small masonry chips — so a rubble
 * tile reads as a collapsed structure, not just a tinted-noise ground colour. */
function paintRubbleDebris(ctx: CanvasRenderingContext2D, wx: number, wy: number, ox: number, oy: number, seed: number, season: Season): void {
  // a scorched dark patch, roughly a third of tiles, drawn first so fragments/beams sit on it
  if (hash2(wx, wy, seed + 5220) < 0.35) {
    const sx = ox + hash2(wx * 41, wy * 41, seed + 5221) * TILE_PX;
    const sy = oy + hash2(wx * 43, wy * 43, seed + 5222) * TILE_PX;
    const sr = 5 + hash2(wx * 47, wy * 47, seed + 5223) * 5;
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#0e0c0a';
    ctx.beginPath(); ctx.ellipse(sx, sy, sr, sr * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  const nFrag = 2 + Math.floor(hash2(wx, wy, seed + 5201) * 3); // 2..4
  for (let i = 0; i < nFrag; i++) {
    const fx = ox + 2 + hash2(wx * 7 + i, wy * 7 + i, seed + 5202) * (TILE_PX - 10);
    const fy = oy + 2 + hash2(wx * 11 + i, wy * 11 + i, seed + 5203) * (TILE_PX - 10);
    const w = 4 + hash2(wx * 13 + i, wy * 13 + i, seed + 5204) * 6; // 4..10 px
    const h = 3 + hash2(wx * 17 + i, wy * 17 + i, seed + 5205) * 4; // 3..7 px
    const ang = hash2(wx * 19 + i, wy * 19 + i, seed + 5206) * Math.PI;
    const brick = hash2(wx * 23 + i, wy * 23 + i, seed + 5207) < 0.4;
    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate(ang);
    // cast shadow
    ctx.fillStyle = 'rgba(10,8,6,0.4)';
    ctx.fillRect(-w / 2 + 1.2, -h / 2 + 1.2, w, h);
    // fragment body
    ctx.fillStyle = brick ? '#6e4238' : '#5c5850';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    // lit top-left edge
    ctx.fillStyle = brick ? '#8a5a4a' : '#7a766e';
    ctx.fillRect(-w / 2, -h / 2, w, 1);
    ctx.fillRect(-w / 2, -h / 2, 1, h);
    // dark crack/mortar line
    ctx.fillStyle = 'rgba(20,16,12,0.5)';
    ctx.fillRect(-w / 2, h / 2 - 1, w, 1);
    ctx.restore();
  }
  // a couple of charred black roof-beam fragments, on maybe a third of tiles
  if (hash2(wx, wy, seed + 5230) < 0.3) {
    const nBeam = 1 + Math.floor(hash2(wx, wy, seed + 5231) * 2);
    for (let i = 0; i < nBeam; i++) {
      const bx = ox + 2 + hash2(wx * 53 + i, wy * 53 + i, seed + 5232) * (TILE_PX - 8);
      const by = oy + 2 + hash2(wx * 59 + i, wy * 59 + i, seed + 5233) * (TILE_PX - 8);
      const len = 6 + hash2(wx * 61 + i, wy * 61 + i, seed + 5234) * 6;
      const ang = hash2(wx * 67 + i, wy * 67 + i, seed + 5235) * Math.PI;
      ctx.strokeStyle = '#161310';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx - Math.cos(ang) * len / 2, by - Math.sin(ang) * len / 2);
      ctx.lineTo(bx + Math.cos(ang) * len / 2, by + Math.sin(ang) * len / 2);
      ctx.stroke();
    }
  }
  // fine masonry dust/chips scattered between the fragments; in winter, a few white flecks of
  // snow dusted on top so the debris still reads as grey-brown but frost-touched
  for (let i = 0; i < 6; i++) {
    const px_ = ox + hash2(wx * 29 + i, wy * 29 + i, seed + 5208) * TILE_PX;
    const py_ = oy + hash2(wx * 31 + i, wy * 31 + i, seed + 5209) * TILE_PX;
    ctx.fillStyle = hash2(wx * 37 + i, wy * 37 + i, seed + 5210) < 0.5 ? 'rgba(150,140,130,0.6)' : 'rgba(40,34,28,0.5)';
    ctx.fillRect(px_, py_, 1, 1);
  }
  if (season === 'winter') {
    for (let i = 0; i < 5; i++) {
      const px_ = ox + hash2(wx * 71 + i, wy * 71 + i, seed + 5240) * TILE_PX;
      const py_ = oy + hash2(wx * 73 + i, wy * 73 + i, seed + 5241) * TILE_PX;
      ctx.fillStyle = 'rgba(232,236,240,0.55)';
      ctx.fillRect(px_, py_, 1, 1);
    }
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
  { base: '#5e4a30', light: '#786240', dark: '#3c2e1c' },
  { base: '#7c5228', light: '#966a38', dark: '#523418' },
  { base: '#4c3c2a', light: '#665238', dark: '#2e2416' },
];
const STONE_ROOF_VARIANTS = [
  { base: '#6d6d68', light: '#87877e', dark: '#454541' },
  { base: '#743832', light: '#8f4d44', dark: '#4a221e' },
  { base: '#5a5c56', light: '#74766e', dark: '#3a3c36' },
  { base: '#665048', light: '#80685e', dark: '#42322c' },
  { base: '#6a6258', light: '#847a6e', dark: '#443e36' },
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

const SNOW_LIT = '#e4e7ec';
const SNOW_SHADE = '#c9ced6';

interface Footprint {
  w: number; h: number; occ: boolean[];
  /** an enclosed interior gap (a real courtyard) in world tile coords, or null */
  hole: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** true if the footprint isn't a plain filled rectangle (has a notch or a hole) */
  irregular: boolean;
}

/** Classify every tile of a building's bbox as occupied/empty, then flood-fill the empty tiles
 * reachable from the bbox border ("outside" the true footprint, e.g. the flanks of a narrower
 * tower merged into a wider nave) so what's left over (empties that never touch the border) is a
 * genuinely enclosed hole — a courtyard, not a concave notch in the outline. */
function analyzeFootprint(map: GameMap, bb: BuildingBBox): Footprint {
  const w = bb.maxX - bb.minX + 1, h = bb.maxY - bb.minY + 1;
  const occ = new Array<boolean>(w * h);
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      occ[ty * w + tx] = map.buildingId[idx(map, bb.minX + tx, bb.minY + ty)] === bb.id;
    }
  }
  const outside = new Array<boolean>(w * h).fill(false);
  const stack: number[] = [];
  const seed = (i: number) => { if (!occ[i] && !outside[i]) { outside[i] = true; stack.push(i); } };
  for (let tx = 0; tx < w; tx++) { seed(tx); seed((h - 1) * w + tx); }
  for (let ty = 0; ty < h; ty++) { seed(ty * w); seed(ty * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const tx = i % w, ty = (i / w) | 0;
    const nbrs: [number, number][] = [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]];
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (occ[ni] || outside[ni]) continue;
      outside[ni] = true;
      stack.push(ni);
    }
  }
  let holeMinX = Infinity, holeMinY = Infinity, holeMaxX = -Infinity, holeMaxY = -Infinity;
  let irregular = false;
  for (let i = 0; i < w * h; i++) {
    if (occ[i]) continue;
    irregular = true;
    if (outside[i]) continue;
    const tx = i % w, ty = (i / w) | 0;
    if (tx < holeMinX) holeMinX = tx; if (tx > holeMaxX) holeMaxX = tx;
    if (ty < holeMinY) holeMinY = ty; if (ty > holeMaxY) holeMaxY = ty;
  }
  const hole = holeMaxX >= holeMinX
    ? { minX: bb.minX + holeMinX, minY: bb.minY + holeMinY, maxX: bb.minX + holeMaxX, maxY: bb.minY + holeMaxY }
    : null;
  return { w, h, occ, hole, irregular };
}

/** A narrower band of occupied tiles at the top or bottom of the footprint (e.g. a church tower
 * merged with its nave) — returned in tile coords local to the bbox, or null if the footprint
 * doesn't have one. */
function findTowerBand(fp: Footprint): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const { w, h, occ } = fp;
  const rowRange = (ty: number): [number, number] | null => {
    let lo = Infinity, hi = -Infinity;
    for (let tx = 0; tx < w; tx++) if (occ[ty * w + tx]) { if (tx < lo) lo = tx; if (tx > hi) hi = tx; }
    return hi >= lo ? [lo, hi] : null;
  };
  const top = rowRange(0);
  if (top && top[1] - top[0] + 1 < w * 0.75) {
    let endTy = 0;
    while (endTy + 1 < h - 1) {
      const r = rowRange(endTy + 1);
      if (!r || r[1] - r[0] + 1 > top[1] - top[0] + 2) break;
      endTy++;
    }
    return { minX: top[0], maxX: top[1], minY: 0, maxY: endTy };
  }
  const bot = rowRange(h - 1);
  if (bot && bot[1] - bot[0] + 1 < w * 0.75) {
    let startTy = h - 1;
    while (startTy - 1 > 0) {
      const r = rowRange(startTy - 1);
      if (!r || r[1] - r[0] + 1 > bot[1] - bot[0] + 2) break;
      startTy--;
    }
    return { minX: bot[0], maxX: bot[1], minY: startTy, maxY: h - 1 };
  }
  return null;
}

/** A small pyramidal (hipped) tower roof: 4 shaded facets meeting at a centre apex, used for a
 * narrower tower section that pokes out of a wider building (village church/school). */
function paintPyramidTower(ctx: CanvasRenderingContext2D, left: number, top: number, w: number, h: number, base: string): void {
  const cx = left + w / 2, cy = top + h / 2;
  ctx.fillStyle = shadeHex(base, 0.3); // N facet, lit
  ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(left + w, top); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shadeHex(base, 0.06); // W facet
  ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(left, top + h); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shadeHex(base, -0.12); // E facet
  ctx.beginPath(); ctx.moveTo(left + w, top); ctx.lineTo(left + w, top + h); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shadeHex(base, -0.32); // S facet, shaded
  ctx.beginPath(); ctx.moveTo(left, top + h); ctx.lineTo(left + w, top + h); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shadeHex(base, 0.45);
  ctx.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2); // apex highlight
  ctx.strokeStyle = shadeHex(base, -0.45);
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
}

/** Occupied-tile rectangles as one clip path, so a roof drawn with plain fillRect() calls over
 * the whole bbox never bleeds onto ground beside a notch (e.g. a tower narrower than its nave). */
function occupancyClipPath(fp: Footprint, bb: BuildingBBox, x0: number, y0: number): Path2D {
  const path = new Path2D();
  for (let ty = 0; ty < fp.h; ty++) {
    for (let tx = 0; tx < fp.w; tx++) {
      if (!fp.occ[ty * fp.w + tx]) continue;
      path.rect((bb.minX + tx - x0) * TILE_PX, (bb.minY + ty - y0) * TILE_PX, TILE_PX, TILE_PX);
    }
  }
  return path;
}

function paintRoof(ctx: CanvasRenderingContext2D, map: GameMap, bb: BuildingBBox, x0: number, y0: number, seed: number, season: Season): void {
  const left = (bb.minX - x0) * TILE_PX;
  const top = (bb.minY - y0) * TILE_PX;
  const wTiles = bb.maxX - bb.minX + 1;
  const hTiles = bb.maxY - bb.minY + 1;
  const w = wTiles * TILE_PX;
  const h = hTiles * TILE_PX;
  const stone = bb.kind === 'stone';
  const snowy = season === 'winter';
  const fp = analyzeFootprint(map, bb);
  const big = fp.hole !== null || (wTiles > 12 && hTiles > 12);

  // Wall/base course, just outside the roof footprint on the S and E sides, so the roof reads
  // as sitting on a structure rather than floating directly on the ground texture: a lit top
  // edge, a material-appropriate mid tone, a dark base line, and a handful of window marks with
  // sills. Ground-shadow band cast beyond the wall, in two alpha steps.
  const WALL_PX = 4;
  const wallMid = stone ? '#8d8a80' : (hash2(bb.id, 7, seed + 711) < 0.5 ? '#c8bfa8' : '#6b4a2e');
  ctx.fillStyle = wallMid;
  ctx.fillRect(left + w, top, WALL_PX, h + WALL_PX);
  ctx.fillRect(left, top + h, w + WALL_PX, WALL_PX);
  ctx.fillStyle = shadeHex(wallMid, 0.32);
  ctx.fillRect(left + w, top, 1, h + WALL_PX);
  ctx.fillRect(left, top + h, w + WALL_PX, 1);
  ctx.fillStyle = shadeHex(wallMid, -0.38);
  ctx.fillRect(left + w + WALL_PX - 1, top, 1, h + WALL_PX);
  ctx.fillRect(left, top + h + WALL_PX - 1, w + WALL_PX, 1);

  // window marks with a light sill: denser rhythm (every ~4px) for tenement facades, a handful
  // (2-3) for ordinary houses.
  const drawWinV = (wx: number, wy: number) => {
    ctx.fillStyle = 'rgba(20,18,16,0.8)';
    ctx.fillRect(wx, wy, 2, 3);
    ctx.fillStyle = snowy ? 'rgba(210,214,220,0.85)' : 'rgba(230,224,200,0.85)';
    ctx.fillRect(wx, wy + 3, 2, 1);
  };
  const drawWinH = (wx: number, wy: number) => {
    ctx.fillStyle = 'rgba(20,18,16,0.8)';
    ctx.fillRect(wx, wy, 3, 2);
    ctx.fillStyle = snowy ? 'rgba(210,214,220,0.85)' : 'rgba(230,224,200,0.85)';
    ctx.fillRect(wx + 3, wy, 1, 2);
  };
  if (big) {
    for (let d = 5; d < h - 1; d += 4) drawWinV(left + w + 1, top + d);
    for (let d = 5; d < w - 1; d += 4) drawWinH(left + d, top + h + 1);
  } else {
    const winN = 2 + Math.floor(hash2(bb.id, 91, seed + 712) * 2);
    for (let i = 0; i < winN; i++) { const t = (i + 1) / (winN + 1); drawWinV(left + w + 1, top + Math.round(t * h)); }
    for (let i = 0; i < winN; i++) { const t = (i + 1) / (winN + 1); drawWinH(left + Math.round(t * w), top + h + 1); }
  }

  // soft shadow cast onto the ground beyond the wall, ~6px wide, in two alpha steps.
  ctx.fillStyle = 'rgba(8,8,6,0.35)';
  ctx.fillRect(left + w + WALL_PX, top, 2, h + WALL_PX);
  ctx.fillRect(left, top + h + WALL_PX, w + WALL_PX, 2);
  ctx.fillStyle = 'rgba(8,8,6,0.18)';
  ctx.fillRect(left + w + WALL_PX + 2, top, 4, h + WALL_PX);
  ctx.fillRect(left, top + h + WALL_PX + 2, w + WALL_PX, 4);

  // If the footprint isn't a plain rectangle (a notch, like a narrower tower merged into a
  // nave, or a real interior hole/courtyard), clip the roof fills to the occupied tiles only so
  // they never paint over ground that isn't actually part of the building.
  const clip = fp.irregular ? occupancyClipPath(fp, bb, x0, y0) : null;
  if (clip) { ctx.save(); ctx.clip(clip); }

  if (big) {
    // Snow "on" the roof means a frosted lightening of the mansard's own dark grey-brown plus a
    // scattered dusting, not a full whiteout — the flat fill needs to stay visibly darker than
    // the surrounding snow ground or the whole ring silhouette disappears against it.
    const flatBase = BLOCK_FLAT_VARIANTS[Math.floor(hash2(bb.id, bb.minX + bb.minY, seed + 601) * BLOCK_FLAT_VARIANTS.length)];
    // In winter this must read as a snow-covered roof (pale, off-white), not merely a brighter
    // version of the same olive/brown material colour — a hue-preserving brighten here is what
    // produced the flat olive-green rectangle the critique flagged.
    const flat = snowy ? mixHex(flatBase, SNOW_LIT, 0.72) : flatBase;
    ctx.fillStyle = flat;
    ctx.fillRect(left, top, w, h);
    if (snowy) {
      ctx.fillStyle = shadeHex(flat, 0.3);
      ctx.fillRect(left, top, w, Math.ceil(h * 0.4));
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      const dustN = Math.max(4, Math.floor((w * h) / 120));
      for (let i = 0; i < dustN; i++) {
        const sx = left + hash2(bb.id * 53 + i, i, 821) * w;
        const sy = top + hash2(bb.id * 59 + i, i, 822) * h;
        ctx.fillRect(sx, sy, 1, 1);
      }
    }
    // inset lighter rectangle: a two-tier mansard/roof-terrace hint
    ctx.strokeStyle = shadeHex(flat, 0.22);
    ctx.lineWidth = 2;
    ctx.strokeRect(left + 2, top + 2, Math.max(0, w - 4), Math.max(0, h - 4));
    // 2px parapet at the outer edge
    ctx.fillStyle = shadeHex(flat, -0.35);
    ctx.fillRect(left, top, w, 2);
    ctx.fillRect(left, top, 2, h);
    ctx.fillRect(left, top + h - 2, w, 2);
    ctx.fillRect(left + w - 2, top, 2, h);
    // row of chimneys along the long axis
    const chimN = Math.max(2, Math.floor(w / 24));
    for (let i = 0; i < chimN; i++) {
      const cx = left + 4 + Math.floor((i * (w - 8)) / Math.max(1, chimN - 1));
      const cy = top + 3;
      ctx.fillStyle = 'rgba(10,8,6,0.35)';
      ctx.fillRect(cx + 1, cy + 1, 2, 2);
      ctx.fillStyle = '#2c2a26';
      ctx.fillRect(cx, cy, 2, 2);
    }
    if (!snowy) {
      ctx.fillStyle = '#8a9aa0';
      const skyN = Math.max(2, Math.floor((w * h) / 900));
      for (let i = 0; i < skyN; i++) {
        const sx = left + 3 + Math.floor(hash2(bb.id * 7 + i, i, 55) * Math.max(1, w - 6));
        const sy = top + 3 + Math.floor(hash2(bb.id * 11 + i, i, 56) * Math.max(1, h - 6));
        ctx.fillRect(sx, sy, 2, 2);
      }
    }
    paintRoofWeathering(ctx, left, top, w, h, bb.id);
    if (stone && !snowy) {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      for (let gx = 5; gx < w; gx += 6) { ctx.beginPath(); ctx.moveTo(left + gx + 0.5, top); ctx.lineTo(left + gx + 0.5, top + h); ctx.stroke(); }
      for (let gy = 5; gy < h; gy += 6) { ctx.beginPath(); ctx.moveTo(left, top + gy + 0.5); ctx.lineTo(left + w, top + gy + 0.5); ctx.stroke(); }
    }
  } else {
    const variants = stone ? STONE_ROOF_VARIANTS : WOOD_ROOF_VARIANTS;
    const v = variants[Math.floor(hash2(bb.id, bb.minX + bb.minY, seed + 602) * variants.length)];
    const ridgeHoriz = wTiles >= hTiles; // ridge runs along the longer axis
    const litFill = snowy ? SNOW_LIT : v.light;
    const shadeFill = snowy ? SNOW_SHADE : v.dark;

    // shaded (unlit) slope first, full footprint
    ctx.fillStyle = shadeFill;
    ctx.fillRect(left, top, w, h);
    // lit slope, brighter than the shaded slope
    ctx.fillStyle = litFill;
    if (ridgeHoriz) ctx.fillRect(left, top, w, Math.ceil(h / 2));
    else ctx.fillRect(left, top, Math.ceil(w / 2), h);

    // gable-end hint: a darker triangle on the shaded slope at each end of the ridge, where it
    // meets the short walls
    ctx.fillStyle = shadeHex(v.dark, -0.18);
    if (ridgeHoriz) {
      const g = Math.min(h * 0.4, w * 0.25);
      ctx.beginPath(); ctx.moveTo(left, top + h / 2); ctx.lineTo(left + g, top + h); ctx.lineTo(left, top + h); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(left + w, top + h / 2); ctx.lineTo(left + w - g, top + h); ctx.lineTo(left + w, top + h); ctx.closePath(); ctx.fill();
    } else {
      const g = Math.min(w * 0.4, h * 0.25);
      ctx.beginPath(); ctx.moveTo(left + w / 2, top); ctx.lineTo(left + w, top + g); ctx.lineTo(left + w, top); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(left + w / 2, top + h); ctx.lineTo(left + w, top + h - g); ctx.lineTo(left + w, top + h); ctx.closePath(); ctx.fill();
    }

    // plank/tile lines perpendicular to the ridge, -8% brightness
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    if (ridgeHoriz) { for (let x = 2; x < w; x += 3) ctx.fillRect(left + x, top, 1, h); }
    else { for (let y = 2; y < h; y += 3) ctx.fillRect(left, top + y, w, 1); }

    // ridge line: always the roof material's own dark tone, so it (and the eave outline below)
    // stay visible against a snow-covered roof rather than disappearing into it.
    ctx.fillStyle = snowy ? v.dark : shadeHex(v.light, 0.2);
    if (ridgeHoriz) ctx.fillRect(left, top + Math.floor(h / 2), w, 1);
    else ctx.fillRect(left + Math.floor(w / 2), top, 1, h);

    // eave outline: 1px dark
    ctx.strokeStyle = v.dark;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));

    // faint stone-coursing mortar lines
    if (stone && !snowy) {
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      for (let gx = 4; gx < w; gx += 5) { ctx.beginPath(); ctx.moveTo(left + gx + 0.5, top); ctx.lineTo(left + gx + 0.5, top + h); ctx.stroke(); }
      for (let gy = 4; gy < h; gy += 5) { ctx.beginPath(); ctx.moveTo(left, top + gy + 0.5); ctx.lineTo(left + w, top + gy + 0.5); ctx.stroke(); }
    }

    // chimney on buildings >= 5x5 tiles, with a highlight and its own tiny cast shadow; in
    // winter, a few bare patches of the roof's own colour show through the snow near it.
    if (wTiles >= 5 && hTiles >= 5) {
      const chimSize = 3;
      const cx = left + w - chimSize - 2, cy = top + 2;
      ctx.fillStyle = 'rgba(10,8,6,0.4)';
      ctx.fillRect(cx + 1, cy + 1, chimSize, chimSize);
      ctx.fillStyle = '#38352e';
      ctx.fillRect(cx, cy, chimSize, chimSize);
      ctx.fillStyle = '#7a766c';
      ctx.fillRect(cx, cy, chimSize, 1);
      ctx.fillRect(cx, cy, 1, chimSize);
      if (snowy) {
        ctx.fillStyle = v.base;
        for (let i = 0; i < 4; i++) {
          const px_ = cx + (hash2(bb.id * 41 + i, i, 813) - 0.5) * 10;
          const py_ = cy + (hash2(bb.id * 43 + i, i, 814) - 0.5) * 10;
          ctx.fillRect(px_, py_, 1 + Math.round(hash2(bb.id, i, 815)), 1);
        }
      }
    }

    paintRoofWeathering(ctx, left, top, w, h, bb.id);

    // a narrower tower band (church/school): re-draw that sub-rect as a small pyramid roof
    const tower = findTowerBand(fp);
    if (tower) {
      const tLeft = left + tower.minX * TILE_PX, tTop = top + tower.minY * TILE_PX;
      const tW = (tower.maxX - tower.minX + 1) * TILE_PX, tH = (tower.maxY - tower.minY + 1) * TILE_PX;
      paintPyramidTower(ctx, tLeft, tTop, tW, tH, snowy ? SNOW_LIT : v.base);
    }
  }

  if (clip) ctx.restore();

  // A genuine interior courtyard (a hole fully enclosed by the ring, not just a notch in the
  // outline): cobbled grey ground with a lighter centre, an inner parapet edge, and a rhythm of
  // windows on the facade facing in, instead of being hidden under one solid roof slab.
  if (fp.hole) {
    const hl = (fp.hole.minX - x0) * TILE_PX, ht = (fp.hole.minY - y0) * TILE_PX;
    const hw = (fp.hole.maxX - fp.hole.minX + 1) * TILE_PX, hh = (fp.hole.maxY - fp.hole.minY + 1) * TILE_PX;
    const cobble = snowy ? '#7d7f84' : '#6e6f6a';
    ctx.fillStyle = cobble;
    ctx.fillRect(hl, ht, hw, hh);
    for (let cy2 = 0; cy2 < hh; cy2 += 4) {
      for (let cx2 = 0; cx2 < hw; cx2 += 4) {
        const v2 = hash2(Math.floor((hl + cx2) / 4), Math.floor((ht + cy2) / 4), seed + 6301);
        ctx.globalAlpha = 0.07;
        ctx.fillStyle = v2 > 0.5 ? '#ffffff' : '#000000';
        ctx.fillRect(hl + cx2, ht + cy2, 4, 4);
      }
    }
    ctx.globalAlpha = 1;
    const grad = ctx.createRadialGradient(hl + hw / 2, ht + hh / 2, 1, hl + hw / 2, ht + hh / 2, Math.max(hw, hh) / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.16)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(hl, ht, hw, hh);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(hl + 1, ht + 1, Math.max(0, hw - 2), Math.max(0, hh - 2));
    ctx.fillStyle = snowy ? 'rgba(30,28,26,0.85)' : 'rgba(40,36,30,0.7)';
    for (let wx2 = hl + 4; wx2 < hl + hw - 3; wx2 += 4) { ctx.fillRect(wx2, ht + 2, 2, 3); ctx.fillRect(wx2, ht + hh - 5, 2, 3); }
    for (let wy2 = ht + 4; wy2 < ht + hh - 3; wy2 += 4) { ctx.fillRect(hl + 2, wy2, 3, 2); ctx.fillRect(hl + hw - 5, wy2, 3, 2); }
    if (snowy) {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#e8ecf0';
      ctx.fillRect(hl, ht, hw, 2); ctx.fillRect(hl, ht + hh - 2, hw, 2);
      ctx.fillRect(hl, ht, 2, hh); ctx.fillRect(hl + hw - 2, ht, 2, hh);
      ctx.globalAlpha = 1;
    }
  }
}

function paintEaveNotches(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const i = idx(map, wx, wy);
  if (!map.windows[i]) return;
  const bid = map.buildingId[i];
  const dirs: [number, number, 'l' | 'r' | 't' | 'b'][] = [[-1, 0, 'l'], [1, 0, 'r'], [0, -1, 't'], [0, 1, 'b']];
  ctx.fillStyle = 'rgba(230,220,170,0.85)';
  for (const [dx, dy, side] of dirs) {
    const outer = !inBounds(map, wx + dx, wy + dy) || map.buildingId[idx(map, wx + dx, wy + dy)] !== bid;
    if (!outer) continue;
    if (side === 'l') ctx.fillRect(ox, oy + 4, 2, 3);
    else if (side === 'r') ctx.fillRect(ox + TILE_PX - 2, oy + 4, 2, 3);
    else if (side === 't') ctx.fillRect(ox + 4, oy, 3, 2);
    else ctx.fillRect(ox + 4, oy + TILE_PX - 2, 3, 2);
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

/** A soft lightening on the NW third of the canopy so individual trees pop against the ground
 * ramp instead of reading as a flat dark disc (round-2 critique: trees don't read as trees). */
function paintCanopyHighlight(ctx: CanvasRenderingContext2D, cx: number, cy: number, dw: number, dh: number, season: Season): void {
  ctx.globalAlpha = season === 'winter' ? 0.22 : 0.28;
  ctx.fillStyle = season === 'winter' ? '#eef2f6' : '#a8c06a';
  ctx.beginPath();
  ctx.ellipse(cx - dw * 0.16, cy - dh * 0.18, dw * 0.28, dh * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
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
      // 'woods' (dense tree mass) always uses the round canopy sprite — including the
      // snow-crusted winter variant already built in sprites.ts — so it reads as a mass of
      // trees; only the sparser 'scatteredtrees' fringe uses the leafless scrub look.
      const variant = Math.floor(hash2(wx * 17 + i, wy * 17 + i, seed + 109) * 3);
      const scale = 0.8 + hash2(wx * 23 + i, wy * 23 + i, seed + 121) * 0.5;
      const sprite = getTreeSprite(variant, season);
      const dw = sprite.width * scale, dh = sprite.height * scale;
      paintTreeShadow(ctx, cx, cy, dw * 0.45, dh * 0.25);
      ctx.drawImage(sprite, Math.round(cx - dw / 2), Math.round(cy - dh / 2), dw, dh);
      paintCanopyHighlight(ctx, cx, cy, dw, dh, season);
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
          paintCanopyHighlight(ctx, cx, cy, dw, dh, season);
        }
      }
    }
  }
  // (no per-tile bush roll on plain grass/hedge tiles — bushes come only from each map's
  // explicit scatterDecor('bush', …) placements, matching the original's sparse, deliberate
  // look instead of a uniform per-tile scatter.)
}

/** Tiles whose terrain is in `vectorLineTerrains` are rendered by `paintLineVector` as one
 * smooth stroked path per chunk instead — skip the blocky per-tile band for those here. */
function paintDetail(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number, vectorLineTerrains: Set<Terrain>): void {
  const t = tileAt(map, wx, wy);
  switch (t) {
    case 'mud': paintMud(ctx, wx, wy, ox, oy, seed); break;
    case 'rubble': paintRubbleDebris(ctx, wx, wy, ox, oy, seed, season); break;
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
    // a slim (6px) bumpy line, not a flat wide bar: a plain core stroke, a 1px shadow line
    // offset to the SE, and lobed lighter blobs every ~6px on the NW side for a leafy silhouette.
    strokePolylineWorld(ctx, pts, x0, y0, 6, '#2c3d22');
    ctx.strokeStyle = 'rgba(6,10,4,0.45)';
    ctx.lineWidth = 1;
    walkPolylineWorld(pts, 4, (wx, wy, ux, uy) => {
      const lx = wx - x0 * TILE_PX, ly = wy - y0 * TILE_PX;
      let px_ = -uy, py_ = ux;
      if (px_ + py_ < 0) { px_ = -px_; py_ = -py_; } // SE-ish perpendicular
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + px_ * 3.5, ly + py_ * 3.5);
      ctx.stroke();
    });
    ctx.fillStyle = '#5c7a3e';
    walkPolylineWorld(pts, 6, (wx, wy, ux, uy) => {
      let px_ = -uy, py_ = ux;
      if (px_ + py_ > 0) { px_ = -px_; py_ = -py_; } // NW-ish perpendicular
      const lx = wx - x0 * TILE_PX + px_ * 2.2, ly = wy - y0 * TILE_PX + py_ * 2.2;
      const r = 1.6 + hash2(Math.round(wx), Math.round(wy), seed + 881) * 1.2;
      ctx.beginPath();
      ctx.ellipse(lx, ly, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (v.terrain === 'stonewall') {
    strokePolylineWorld(ctx, pts, x0, y0, 6, 'rgba(16,16,8,0.3)');
    strokePolylineWorld(ctx, pts, x0, y0, 5, '#9a9a92');
    ctx.strokeStyle = '#5a5a52';
    ctx.lineWidth = 1;
    walkPolylineWorld(pts, 3, (wx, wy, ux, uy) => {
      const lx = wx - x0 * TILE_PX, ly = wy - y0 * TILE_PX;
      const px_ = -uy * 2.5, py_ = ux * 2.5;
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
    strokePolylineWorld(ctx, pts, x0, y0, 10, 'rgba(120,108,84,0.28)'); // lighter spoil either side
    strokePolylineWorld(ctx, pts, x0, y0, 6, '#161410');
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
  /** One row-axis angle (degrees) for every crop field on this map, hashed from the map id —
   * 0 or 90 most of the time, occasionally 45. Individual fields only wobble a little around
   * this shared angle (see computeFields), so adjacent wheat patches never show perpendicular
   * rows next to each other. */
  private fieldBaseAngleDeg = 0;
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
    const angleRoll = hash2(0, 0, this.seed + 909);
    this.fieldBaseAngleDeg = angleRoll < 0.15 ? 45 : angleRoll < 0.575 ? 0 : 90;
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
  /** Flood-fills contiguous 'crops' tiles into field ids (one hashed row axis per id — see fix
   * for the "quilted fields" bug). 8-connected on purpose: a blobby/jagged field edge (from
   * `field()`'s angle-noise boundary) routinely leaves diagonal-only-adjacent tiles at the
   * boundary; a 4-connected flood fill would split those off into separate 1-2 tile "fields"
   * with their own independently-hashed axis, which is exactly what produced the
   * alternating-direction quilt look instead of one field with continuous rows. */
  private computeFields(): void {
    const map = this.map;
    const w = map.width, h = map.height;
    const n = w * h;
    const isCrop = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (map.tiles[i] === 'crops') isCrop[i] = 1;

    // Dilate the crops mask by a couple of tiles before flood-filling connectivity: two
    // separately-painted `field()`/`patch()` calls that visually read as one continuous
    // wheat field (touching or a tile or two apart — a farm track, a thin gap, a single
    // stray tile) must still get ONE consistent row axis. Flood-filling the raw mask alone
    // (even 8-connected) treats any such gap as two unrelated fields, each independently
    // hashing its own axis — exactly what produced the alternating-direction "quilt" look
    // where two nearly-touching fields meet.
    const DILATE_R = 2;
    const dilated = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (isCrop[i]) { dilated[i] = 1; continue; }
        outer: for (let dy = -DILATE_R; dy <= DILATE_R; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          const rowBase = ny * w;
          for (let dx = -DILATE_R; dx <= DILATE_R; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            if (isCrop[rowBase + nx]) { dilated[i] = 1; break outer; }
          }
        }
      }
    }

    // Flood-fill connected components over the DILATED mask (8-connected) — this is what
    // actually decides field identity/axis; the dilation is purely a connectivity aid.
    const compId = new Int32Array(n).fill(-1);
    let nextId = 0;
    const stack: number[] = [];
    const neighbors8: [number, number][] = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!dilated[i] || compId[i] !== -1) continue;
        const id = nextId++;
        stack.push(i);
        compId[i] = id;
        while (stack.length) {
          const ci = stack.pop()!;
          const cx = ci % w, cy = Math.floor(ci / w);
          for (const [dx, dy] of neighbors8) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!dilated[ni] || compId[ni] !== -1) continue;
            compId[ni] = id;
            stack.push(ni);
          }
        }
      }
    }

    // Tile count + centroid per component (over real crop tiles only — the dilation halo cells
    // were purely a connectivity bridge and never get a fieldId of their own).
    const compCount = new Array<number>(nextId).fill(0);
    const compSumX = new Array<number>(nextId).fill(0);
    const compSumY = new Array<number>(nextId).fill(0);
    for (let i = 0; i < n; i++) {
      if (!isCrop[i]) continue;
      const id = compId[i];
      compCount[id]++;
      compSumX[id] += i % w;
      compSumY[id] += Math.floor(i / w);
    }

    // One shared base angle for the whole map (this.fieldBaseAngleDeg); "large" fields (>=40
    // tiles) each get that angle plus a small +-12 degree wobble of their own. Small fields
    // (<40 tiles — stray satellite patches, farmyard vegetable plots) don't roll their own
    // angle at all: they inherit whichever large field's centroid is nearest, so a small patch
    // sitting right next to a big wheat field never shows a jarringly different row direction.
    const LARGE_MIN_TILES = 40;
    const angleDeg = new Array<number>(nextId).fill(this.fieldBaseAngleDeg);
    const isLarge = new Array<boolean>(nextId).fill(false);
    for (let id = 0; id < nextId; id++) {
      if (compCount[id] < LARGE_MIN_TILES) continue;
      isLarge[id] = true;
      const wobble = (hash2(id, 777, this.seed + 303) - 0.5) * 24; // +-12 degrees
      angleDeg[id] = this.fieldBaseAngleDeg + wobble;
    }
    for (let id = 0; id < nextId; id++) {
      if (isLarge[id] || compCount[id] === 0) continue;
      const cx = compSumX[id] / compCount[id], cy = compSumY[id] / compCount[id];
      let bestId = -1, bestDist = Infinity;
      for (let j = 0; j < nextId; j++) {
        if (!isLarge[j]) continue;
        const jx = compSumX[j] / compCount[j], jy = compSumY[j] / compCount[j];
        const dx = jx - cx, dy = jy - cy;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; bestId = j; }
      }
      // no large field anywhere on the map (rare) — still just wobble around the shared base
      // angle rather than rolling an unrelated one.
      angleDeg[id] = bestId >= 0 ? angleDeg[bestId] : this.fieldBaseAngleDeg + (hash2(id, 778, this.seed + 304) - 0.5) * 24;
    }

    for (let i = 0; i < n; i++) {
      if (!isCrop[i]) continue;
      const id = compId[i];
      this.fieldId[i] = id;
      if (!this.fieldAxis.has(id)) {
        const rad = (angleDeg[id] * Math.PI) / 180;
        this.fieldAxis.set(id, { sin: Math.sin(rad), cos: Math.cos(rad) });
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
    // road/river has no vector geometry, and always for crops/mud/tallgrass/rubble which aren't
    // vectorized). blurR=2 pre-smooths the area classes so their macro silhouette is a soft
    // blob rather than a tile-stepped stamp (fix #6); road/paved/water grids stay unblurred
    // since they're only a rare fallback when a map lacks vector geometry for that feature.
    const AREA_BLUR = 2;
    const cropsGrid = buildGrid(map, x0, y0, CHUNK_TILES, isCrops, AREA_BLUR);
    const mudGrid = buildGrid(map, x0, y0, CHUNK_TILES, isMud, AREA_BLUR);
    const tallgrassGrid = buildGrid(map, x0, y0, CHUNK_TILES, isTallgrass, AREA_BLUR);
    const pavedGrid = buildGrid(map, x0, y0, CHUNK_TILES, isPaved);
    const dirtGrid = buildGrid(map, x0, y0, CHUNK_TILES, isDirtRoad);
    const waterGrid = buildGrid(map, x0, y0, CHUNK_TILES, isWater);
    // rubble spreads only ~1 tile past its footprint (not the wider AREA_BLUR used for
    // crops/mud/tallgrass), so debris reads as a collapsed building, not a blanket stain.
    const rubbleGrid = buildGrid(map, x0, y0, CHUNK_TILES, isRubble, 1);
    const dirtyGrid = season === 'winter' ? buildGrid(map, x0, y0, CHUNK_TILES, isDirtySource) : cropsGrid;

    // ------------------------------------------------------ vector geometry (smooth roads/rivers)
    const pavedVec = buildAreaField(map.def.vectors, 'road', 'pavedroad', x0, y0, CHUNK_TILES, CHUNK_TILES);
    const dirtVec = buildAreaField(map.def.vectors, 'road', 'dirtroad', x0, y0, CHUNK_TILES, CHUNK_TILES);
    const waterVec = buildAreaField(map.def.vectors, 'river', 'water', x0, y0, CHUNK_TILES, CHUNK_TILES);

    // world-pixel Y centrelines of any 'tramwire' decor line running through this chunk, so the
    // paved-road pass can draw a pair of rail lines beneath it.
    const tramRailY: number[] = [];
    {
      const seen = new Set<number>();
      for (const d of map.def.decor ?? []) {
        if (d.kind !== 'tramwire') continue;
        if (d.x < x0 - 2 || d.x > x0 + CHUNK_TILES + 2) continue;
        const ry = Math.round(d.y * TILE_PX);
        if (!seen.has(ry)) { seen.add(ry); tramRailY.push(ry); }
      }
    }

    // ------------------------------------------------------------ ground+features pass
    const img = ctx.createImageData(CHUNK_PX, CHUNK_PX);
    reliefCache = new Map<number, number>();
    paintGroundAndFeatures(
      img.data, CHUNK_PX, map, season, this.seed, x0, y0, CHUNK_TILES, CHUNK_TILES,
      this.groundUnder, map.width, map.height, this.fieldId, this.fieldAxis,
      cropsGrid, mudGrid, tallgrassGrid, pavedGrid, dirtGrid, waterGrid, rubbleGrid, dirtyGrid,
      pavedVec, dirtVec, waterVec, tramRailY,
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
      // The wall band + cast shadow drawn on the S/E sides protrude up to ~1 tile past the
      // building's own footprint, so a chunk immediately past that edge still needs a (clipped)
      // draw call to pick up that protruding sliver — widen the overlap test by 1 tile on the
      // max side accordingly.
      if (bb.maxX < x0 - 1 || bb.minX >= x0 + CHUNK_TILES || bb.maxY < y0 - 1 || bb.minY >= y0 + CHUNK_TILES) continue;
      paintRoof(ctx, map, bb, x0, y0, this.seed, season);
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

  /** Uses the exact same `groundColorFbm` ramp+fbm function the real per-pixel bake uses (just
   * sampled once at the tile centre instead of per pixel), so the low-res scrolling fallback's
   * tone actually matches baked chunks at their seam instead of reading as a flatter, greyer
   * patch next to them. */
  private paintLowResTile(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const map = this.map;
    const season = map.def.season;
    const t = tileAt(map, x, y);
    const i = idx(map, x, y);
    const cx = (x + 0.5) * TILE_PX, cy = (y + 0.5) * TILE_PX;
    let color: RGB;
    if (t === 'buildingWood' || t === 'buildingStone' || t === 'floor') {
      const bid = map.buildingId[i];
      const bb = bid >= 0 ? this.buildingBBoxes.get(bid) : undefined;
      const stone = bb ? bb.kind === 'stone' : t === 'buildingStone';
      const base = hexToRgb(stone ? '#6d6d68' : '#6f4a2c');
      color = shade(base, (fbm(cx / 40, cy / 40, 2, this.seed + 8811) - 0.5) * 0.2);
    } else if (t === 'crater' || t === 'bridge') {
      color = groundColorFbm(this.groundUnder[i], season, cx, cy, this.seed);
    } else {
      color = groundColorFbm(t, season, cx, cy, this.seed);
    }
    ctx.fillStyle = `rgb(${clamp255(color.r) | 0},${clamp255(color.g) | 0},${clamp255(color.b) | 0})`;
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
    let pending = 0;
    for (let cy = startCy; cy <= endCy; cy++) {
      for (let cx = startCx; cx <= endCx; cx++) {
        if (!this.chunks.has(this.chunkKey(cx, cy))) pending++;
      }
    }
    let bakeBudget = pending > 2 ? BAKES_PER_DRAW_BURST : BAKES_PER_DRAW;
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
