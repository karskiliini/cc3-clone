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
// Memory/perf: chunks are 16x16 tiles (320x320 px at zoom 1) and are LAZILY
// baked on first use, kept in a per-zoom LRU cache (see MAX_CACHED_CHUNKS_BY_ZOOM).
// Measured bake cost (Berlin): ~5-11ms/chunk at 0.5x, ~20-50ms at 1x, ~80-115ms
// at 2x. `draw()` bakes against a wall-clock budget (BAKE_BUDGET_MS) rather than
// a chunk count, nearest-to-screen-centre first; chunks not yet baked fall back
// to a cached bake at another zoom or the cheap whole-map low-res (2px per tile)
// canvas, so scrolling never stalls for long. `thumbnail()` never bakes full-res
// chunks at all — it only ever scales that low-res canvas.
// ============================================================================
import type { Camera, GameMap, BattleState, MapVectorFeature, Terrain, Season, Vec2 } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { fbm, fbm64, fbm14, heightField, fbmClump, angleField } from '@/render/noise';
import { idx, tileAt, inBounds } from '@/sim/map';
import { TERRAIN_COLORS } from '@/render/palette';
import { getTreeSprite, getTreeShadowSprite, getSmokePuff, TREE_SPRITE_WORLD_PX, TREE_VARIANTS, type TreeShape } from '@/render/sprites';
import { drawDecorItem } from '@/render/decorSprites';
import {
  paintCrater, paintFoxhole, paintTrenches, buildTrenchDraw, craterExtentPx, foxholeExtentPx, oldCraterDiameter,
  type CraterDraw, type FoxholeDraw, type TrenchDraw,
} from '@/render/craterArt';
import { worldToScreen, ZOOM_LEVELS } from '@/engine/camera';

const CHUNK_TILES = 16;
const CHUNK_PX = CHUNK_TILES * TILE_PX; // 320
/** Per-zoom LRU caps. Each must stay above the largest visible chunk count at that zoom
 * (~40 at 0.5x, ~12 at 1x, ~6 at 2x). 0.5x holds all of Berlin (140 chunks, 160x160 each,
 * ~3.6MB); 1x ~26MB; 2x (640x640) ~26MB. A zoom only ever evicts its own entries, so zooming
 * in never throws away the cheap low-zoom working set. */
const MAX_CACHED_CHUNKS_BY_ZOOM: Record<number, number> = { 0.5: 160, 1: 64, 2: 16 };
/** Wall-clock bake budget per draw(): at least one chunk is always baked per frame when any
 * are pending, further chunks only while under the deadline. A single 1x bake is ~20-50ms and
 * a 2x bake ~80-115ms, so this caps a frame at roughly one chunk's cost instead of 6-8. */
const BAKE_BUDGET_MS = 10;
/** Larger budget used only when nothing is cached at any zoom yet (first open of a map). */
const BAKE_BUDGET_COLD_MS = 40;
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

interface ChunkEntry {
  canvas: HTMLCanvasElement; cx: number; cy: number;
  /** map.craterMarks already drawn into this canvas */
  marks: number;
}

interface BuildingBBox {
  minX: number; minY: number; maxX: number; maxY: number;
  kind: 'wood' | 'stone';
  id: number;
  /** roof style class of the undamaged footprint (kept when blasts cave parts of the roof in) */
  origBig?: boolean;
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
// Frozen river: a clearly darker steel blue-grey than the surrounding snow (ref_cc3_1482 river
// avg ~(116,123,128)) — the old pale ramp sat only ~17 luminance units below snow and vanished.
const ICE_RAMP = ['#6e8290', '#7d919e', '#8fa2ae', '#a6b6c0'];
// Summer road/crops: warm saturated ochre/gold sampled against ref_cc3_1479 (dirt road ~(131,102,35),
// wheat ~(162,125,31)). Separate from ROAD_RAMP/CROPS_RAMP, which autumn still uses.
// Round-5 fix #7: the four-stop ramp swung 6 levels per pixel-pair against the reference's 16-17.
// A wet-rut dark at the bottom and a dry gravel highlight at the top widen the swing to the
// reference's, and the per-pixel gravel/rut work in the dirtroad branch of paintGroundAndFeatures
// spends that range at the 2-5 px scale the eye reads as "gravel track".
const SUMMER_ROAD_RAMP = ['#78591c', '#8d6a24', '#a27c2e', '#b48c3c', '#c49d50', '#d2ac74'];
/** stamped gravel highlight / wet rut, sampled from ref_cc3_1479's dirt road */
const ROAD_GRAVEL: RGB = { r: 205, g: 165, b: 108 };
const ROAD_WET_RUT: RGB = { r: 106, g: 78, b: 36 };
const SUMMER_CROPS_RAMP = ['#6e5210', '#8a6a16', '#a27e1e', '#b89226', '#c8a230'];
// grey-brown debris, not the pinkish-brown palette.ts default (that read as a paint spatter,
// especially over snow) — used for all seasons since rubble is rubble regardless.
const RUBBLE_RAMP = ['#6e675c', '#7a7266', '#847c70', '#8a8276'];
// Summer grass patch ramps (same dark->light positions as the grass ramp so the fine/clump
// texture carries straight across a patch edge): warm ochre dry-grass and darker brown earth.
const SUMMER_OCHRE_PATCH: RGB[] = [[84, 68, 24], [102, 84, 32], [120, 100, 42], [138, 116, 54], [154, 132, 68]].map(([r, g, b]) => ({ r, g, b }));
const SPECKLE_BROWN: RGB = { r: 94, g: 66, b: 34 }; // ~#6a4a24 warm dirt
const SPECKLE_OCHRE: RGB = { r: 140, g: 114, b: 54 }; // ~#9a7a38 dry grass
const SUMMER_BROWN_PATCH: RGB[] = [[62, 50, 28], [76, 62, 34], [90, 74, 42], [104, 88, 52], [118, 102, 64]].map(([r, g, b]) => ({ r, g, b }));

const LOCAL_RAMPS: Partial<Record<Season, Partial<Record<Terrain, string[]>>>> = {
  summer: {
    // warm bare earth (ref_cc3_1479 bare ground ~(146,126,46)), not grey concrete
    open: ['#86692e', '#9a7a36', '#ab8a40', '#ba984a', '#c6a656'],
    // CC3 olive green, ramp hue ~66deg / sat ~0.66: the per-pixel warm dirt speckle in
    // paintGroundAndFeatures pulls the rendered mean to ~60deg like ref_cc3_1479; large ochre/
    // brown blotches come from the low-frequency patch layer in groundColorFbm.
    // Round-5 fix #7/#15: round 4's "pull it back to green" overshot — ref_cc3_1479's open grass
    // is a dry BROWN-OLIVE (R above G), ours had become a yellow-green (R below G). Every stop
    // gains red and loses a little green, which lands the rendered mean back on the reference's
    // hue while the olive base and the speckle layers below are untouched.
    grass: ['#4a4419', '#5b5420', '#706128', '#7f6c2e', '#918039'],
    tallgrass: ['#62652a', '#767834', '#8a893e', '#9a984a'],
    crops: SUMMER_CROPS_RAMP,
    mud: MUD_RAMP,
    dirtroad: SUMMER_ROAD_RAMP,
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
    // Round-5 fix #7: ours measured 28 levels brighter and distinctly cooler than ref_cc3_1482's
    // trodden winter ground (#b2aaa5). Every stop drops ~20-22 levels and warms so red sits above
    // blue — snow that has been walked, drifted and dirtied, not blank paper.
    snow: ['#a7a6a5', '#b9b7b3', '#cac7c1', '#d6d2cb'],
    // snow-covered tracks: close to snow colour (ref_cc3_1484 main track ~(225,225,227)); the
    // road is defined by its wheel ruts, not by a dark fill. Paved top stays ~10+ below snow so
    // Berlin streets still read as streets.
    // round-5 fix #7: with the snow ramp dropped ~20 levels, the old track ramp sat BRIGHTER than
    // the ground it crosses. A used track in ref_cc3_1484 is dirtier than the field either side.
    dirtroad: ['#8f8578', '#9d9384', '#a89d8d', '#b0a595'],
    // darkened with the snow ramp (round-5 fix #7): a swept street still reads as street
    pavedroad: ['#7e7a72', '#8b867c', '#969086', '#a09a8e'],
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
/** Smoothstep-style ramp from 0 at `lo` to 1 at `hi`, clamped. Used to turn a coverage field's
 * hard `> 0.5` colour switch into an actual cross-fade over the coverage value's own feathered
 * band, instead of the base ground colour and the feature colour meeting at a 1-pixel-wide hard
 * edge right at the threshold — the fix for the round-3 critique's "seam" (a tallgrass/crops/mud
 * patch interior, blurred at the coverage-grid level but still fully opaque past its 0.5
 * threshold, meeting fully-opaque grass on the other side with no actual colour blend between
 * them). */
function smooth01(v: number, lo: number, hi: number): number {
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}
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

// Nested by season then terrain (rather than a string-concatenated key) so the hot per-pixel
// path in groundColorFbm — called up to a few times per pixel, and at bpt^2 resolution that's
// 4x the calls at zoom 2 — never builds a string just to do a cache lookup.
const rampRgbCache: Partial<Record<Season, Partial<Record<Terrain, RGB[]>>>> = {};
function rampRgb(season: Season, t: Terrain): RGB[] {
  let bySeason = rampRgbCache[season];
  if (!bySeason) { bySeason = {}; rampRgbCache[season] = bySeason; }
  let r = bySeason[t];
  if (!r) { r = rampFor(season, t).map(hexToRgb); bySeason[t] = r; }
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
  if (t === 'grass' || t === 'open') {
    // dense 2-5px stipple rather than a smooth 60px cloud wash (ref_cc3_1479 grass lumSD ~18-20):
    // weaker large-scale term, stronger medium term, plus a ~3px fbm band. Summer drops the
    // brightening bias and raises the per-pixel fine term for more luminance contrast.
    const summer = season === 'summer';
    const bias = summer ? 0 : 0.08;
    // round-4 #1: summer fine (per-pixel) and ~3px band amplitudes cut ~40% (0.40->0.24,
    // 0.6->0.36) — they read as a dithered checkerboard at 1:1.
    const fine = summer ? 0.24 : 0.18;
    // 1 octave: the 2nd (1.5px) octave duplicated the per-pixel `g` term; dropping it pays for
    // the summer patch layer below within the bake budget.
    const f3 = fbm(X / 3, Y / 3, 1, seed + th + 77);
    const tt = clamp01(0.5 + bias + 0.45 * (f64 - 0.5) + 0.6 * (f14 - 0.5) + (summer ? 0.36 : 0.35) * (f3 - 0.5) + fine * (g - 0.5));
    if (summer && t === 'grass' && ramp.length === 5) {
      // large (~100-200px) ochre and brown patches from low-frequency noise, ref_cc3_1479's warm
      // dry-grass/earth blotches over mid-green grass (instead of yellowing the whole field).
      // One value-noise octave each (bake budget), with the already-sampled 64px/14px mottling
      // bands mixed in so patch edges are ragged and soft rather than smooth ovals.
      const po = fbm(X / 160, Y / 160, 1, seed + 6101) + 0.35 * (f64 - 0.5) + 0.2 * (f14 - 0.5);
      const wo = smooth01(po, 0.53, 0.74);
      const pb = fbm(X / 100, Y / 100, 1, seed + 6203) + 0.3 * (f64 - 0.5) + 0.25 * (f14 - 0.5);
      const wb = smooth01(pb, 0.6, 0.82) * 0.6;
      // all three ramps have 5 stops at the same tt: blend inline with one allocation (hot path)
      const u = tt * 4;
      let i = Math.floor(u);
      if (i >= 4) i = 3;
      const fr = u - i;
      const g0 = ramp[i], g1 = ramp[i + 1];
      let r = g0.r + (g1.r - g0.r) * fr, gg = g0.g + (g1.g - g0.g) * fr, bb = g0.b + (g1.b - g0.b) * fr;
      if (wo > 0.001) {
        const o0 = SUMMER_OCHRE_PATCH[i], o1 = SUMMER_OCHRE_PATCH[i + 1], k = wo * 0.85;
        r += (o0.r + (o1.r - o0.r) * fr - r) * k;
        gg += (o0.g + (o1.g - o0.g) * fr - gg) * k;
        bb += (o0.b + (o1.b - o0.b) * fr - bb) * k;
      }
      if (wb > 0.001) {
        const b0 = SUMMER_BROWN_PATCH[i], b1 = SUMMER_BROWN_PATCH[i + 1];
        r += (b0.r + (b1.r - b0.r) * fr - r) * wb;
        gg += (b0.g + (b1.g - b0.g) * fr - gg) * wb;
        bb += (b0.b + (b1.b - b0.b) * fr - bb) * wb;
      }
      return { r, g: gg, b: bb };
    }
    return rampLerp(ramp, tt);
  }
  const tt = clamp01(0.5 + 0.9 * (f64 - 0.5) + 0.5 * (f14 - 0.5) + 0.18 * (g - 0.5));
  return rampLerp(ramp, tt);
}

/** Hillshading from the map's REAL ground elevation (sim/mapdsl.ts's ElevationPainter, per tile,
 * bilinearly interpolated), lit from the north-west: a slope facing NW brightens, one falling
 * away to the SE darkens, +-RELIEF_AMP. A map with no relief (`map.ground` undefined) falls back
 * to the old low-frequency fbm mottling so hand-built/test maps still get some tonal variety.
 *
 * The terms vary over hundreds of pixels, so this is evaluated once per 4x4-pixel block and
 * memoised for the life of one chunk bake (reset per bakeChunk call), exactly as before — the
 * bake cost is unchanged apart from two Float32Array bilinear reads per block instead of two
 * fbm evaluations (strictly cheaper). */
const RELIEF_AMP = 0.18;
/** Metres of rise per metre of run that saturates the shading. Round-5 fix #2: 0.35 meant the
 * ordinary 6-10% working slopes of rolling farmland landed at 1 +- 0.05 — under the ground's own
 * dither amplitude, so the hillshading was invisible in the normal view. At 0.18 a 10% slope
 * shades at ~55% of full amplitude and the landforms read. */
const RELIEF_FULL_GRADE = 0.18;
let reliefCache: Map<number, number> | null = null;
let reliefGround: Float32Array | null = null;
let reliefW = 0, reliefH = 0;

/** Bilinear ground elevation (m) at a world pixel. */
function groundAtPx(X: number, Y: number): number {
  const g = reliefGround!;
  const W = reliefW, H = reliefH;
  const fx = X / TILE_PX - 0.5, fy = Y / TILE_PX - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const ax = fx - x0, ay = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 = 0; if (x1 < 0) x1 = 0; if (x0 >= W) x0 = W - 1; if (x1 >= W) x1 = W - 1;
  if (y0 < 0) y0 = 0; if (y1 < 0) y1 = 0; if (y0 >= H) y0 = H - 1; if (y1 >= H) y1 = H - 1;
  const a = g[y0 * W + x0], b = g[y0 * W + x1], c = g[y1 * W + x0], d = g[y1 * W + x1];
  const top = a + (b - a) * ax;
  return top + (c + (d - c) * ax - top) * ay;
}

function reliefFactor(X: number, Y: number, seed: number): number {
  const bx = X >> 2, by = Y >> 2;
  const key = (bx & 0xffff) * 100003 + (by & 0xffff);
  const cache = reliefCache;
  if (cache) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  let f: number;
  if (reliefGround) {
    // central differences over one tile (2 m) in each axis, in metres of rise per metre of run
    const runM = 2 * TILE_M;
    const gx = (groundAtPx(X + TILE_PX, Y) - groundAtPx(X - TILE_PX, Y)) / runM;
    const gy = (groundAtPx(X, Y + TILE_PX) - groundAtPx(X, Y - TILE_PX)) / runM;
    // light from the NW: its horizontal direction of travel is (+1,+1)/sqrt2 (toward the SE), so
    // illumination is -(gradient . lightDir) — ground rising toward the light gets brighter.
    const lit = -(gx + gy) * Math.SQRT1_2 / RELIEF_FULL_GRADE;
    f = 1 + RELIEF_AMP * (lit < -1 ? -1 : lit > 1 ? 1 : lit);
  } else {
    const h1 = heightField(X - 4, Y - 4, seed);
    const h2 = heightField(X + 4, Y + 4, seed);
    f = 1 + 0.18 * (h1 - h2) * 8;
    f = f < 0.85 ? 0.85 : f > 1.15 ? 1.15 : f;
  }
  if (cache) cache.set(key, f);
  return f;
}

/** Sparse short directional "grass tuft" strokes for the brush-clump ground pass (fix #2c): each
 * ~10px cell has a ~22% chance of hosting one 3-7px stroke, oriented by the slowly-varying
 * `angleField` so neighbouring tufts lean together like brushed grass rather than scattering
 * randomly. Returns a +-0.1 shade delta for pixels within ~0.7px of the stroke, else 0. Anchors
 * are kept 2px inset from the cell edge so a stroke never needs to be evaluated from a
 * neighbouring cell — one hash lookup per pixel, no neighbour scan. */
const tuftMemo = { cx: NaN, cy: NaN, seed: NaN, ax0: 0, ay0: 0, ex: 0, ey: 0 };
function tuftShade(wpx: number, wpy: number, seed: number, chance = 0.22, amt = 0.1): number {
  const cellSize = 10;
  const ccx = Math.floor(wpx / cellSize), ccy = Math.floor(wpy / cellSize);
  if (hash2(ccx, ccy, seed + 4601) > chance) return 0;
  // Stroke geometry depends only on the cell, and the bake loop walks pixels row by row, so
  // memoise the last cell's stroke (identical output; skips angleField's fbm on ~90% of calls).
  if (ccx !== tuftMemo.cx || ccy !== tuftMemo.cy || seed !== tuftMemo.seed) {
    const ax = ccx * cellSize + 2 + hash2(ccx, ccy, seed + 4602) * (cellSize - 4);
    const ay = ccy * cellSize + 2 + hash2(ccx, ccy, seed + 4603) * (cellSize - 4);
    const len = 3 + hash2(ccx, ccy, seed + 4604) * 4;
    const ang = angleField(ax, ay, seed);
    const dx = Math.cos(ang) * len * 0.5, dy = Math.sin(ang) * len * 0.5;
    tuftMemo.cx = ccx; tuftMemo.cy = ccy; tuftMemo.seed = seed;
    tuftMemo.ax0 = ax - dx; tuftMemo.ay0 = ay - dy; tuftMemo.ex = dx * 2; tuftMemo.ey = dy * 2;
  }
  const { ax0, ay0, ex, ey } = tuftMemo;
  const len2 = ex * ex + ey * ey;
  let t = len2 > 1e-6 ? ((wpx - ax0) * ex + (wpy - ay0) * ey) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx2 = ax0 + t * ex, cy2 = ay0 + t * ey;
  const ddx = wpx - cx2, ddy = wpy - cy2;
  if (ddx * ddx + ddy * ddy > 0.49) return 0;
  return hash2(ccx, ccy, seed + 4605) > 0.45 ? amt : -amt;
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
function buildGrid(map: GameMap, x0: number, y0: number, tiles: number, classify: (t: Terrain) => boolean, blurR = 0, sample: (tx: number, ty: number) => Terrain = (tx, ty) => tileAt(map, tx, ty)): Grid {
  const size = tiles + 3;
  const data = new Float32Array(size * size);
  let any = false;
  if (blurR <= 0) {
    for (let gy = 0; gy < size; gy++) {
      const ty = y0 - 1 + gy;
      for (let gx = 0; gx < size; gx++) {
        const tx = x0 - 1 + gx;
        const v = classify(sample(tx, ty)) ? 1 : 0;
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
      raw[gy * rawSize + gx] = classify(sample(tx, ty)) ? 1 : 0;
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
function sampleGrid(grid: Grid, tx: number, px: number, ty: number, py: number, wpx: number, wpy: number, seed: number, noiseAmt = 0.08, tileSize = TILE_PX): number {
  if (!grid.any) return 0;
  const { data, size } = grid;
  const quarter = tileSize / 4;
  const gx0 = tx + (px < quarter ? 0 : 1);
  const fx = px < quarter ? 0.5 + px / tileSize : px / tileSize - 0.5;
  const gy0 = ty + (py < quarter ? 0 : 1);
  const fy = py < quarter ? 0.5 + py / tileSize : py / tileSize - 0.5;
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

interface VecSegW {
  ax: number; ay: number; bx: number; by: number; halfW: number;
  /** owning polyline index + segment index within it (adjacency test for junction detection) */
  poly: number; segIdx: number;
  /** true when endpoint a / b is an OPEN end of its polyline (not an interior joint) */
  aOpen: boolean; bOpen: boolean;
}
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
  for (let vi = 0; vi < vectors.length; vi++) {
    const v = vectors[vi];
    if (v.kind !== kind || v.terrain !== terrain) continue;
    const halfW = (v.width * TILE_PX) / 2;
    const last = v.points.length - 2;
    for (let i = 0; i < v.points.length - 1; i++) {
      const a = v.points[i], b = v.points[i + 1];
      const ax = a.x * TILE_PX, ay = a.y * TILE_PX, bx = b.x * TILE_PX, by = b.y * TILE_PX;
      const sminX = Math.min(ax, bx) - halfW, smaxX = Math.max(ax, bx) + halfW;
      const sminY = Math.min(ay, by) - halfW, smaxY = Math.max(ay, by) + halfW;
      if (smaxX < minX || sminX > maxX || smaxY < minY || sminY > maxY) continue;
      segs.push({ ax, ay, bx, by, halfW, poly: vi, segIdx: i, aOpen: i === 0, bOpen: i === last });
    }
  }
  return segs.length ? { segs } : null;
}

interface VecSample {
  cov: number; dist: number; halfW: number;
  /** unclamped along-segment distance (px) from the best segment's nearest OPEN polyline end;
   * negative past the end cap, Infinity when that segment has no open end. */
  endDist: number;
  /** true when 2+ non-adjacent segments cover this pixel (a road junction/crossing) */
  junction: boolean;
}
const VEC_SAMPLE_NONE: VecSample = { cov: 0, dist: 0, halfW: 1, endDist: Infinity, junction: false };

/** Coverage of a road/river vector field at world pixel (wpx,wpy): signed distance to the nearest
 * polyline segment (round joins, since it's a min over segments), smoothstep-feathered over
 * VEC_FEATHER_PX at a half-width modulated by low-amplitude coherent fbm so shoulders wander. */
function sampleVecArea(field: VecAreaField, wpx: number, wpy: number, seed: number): VecSample {
  // "best" = the segment with the smallest (dist - effHalf), NOT the highest clamped coverage:
  // coverage saturates at 1 inside the road, so picking by coverage kept the FIRST segment's
  // distance past its own end, bending rut iso-bands into hairpin loops at every joint.
  let bestCov = 0, bestDist = 0, bestHalfW = 1, bestEnd = Infinity, bestScore = Infinity;
  let coverPoly = -1, coverSeg = -1, junction = false;
  for (const s of field.segs) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy;
    const tRaw = len2 > 1e-6 ? ((wpx - s.ax) * dx + (wpy - s.ay) * dy) / len2 : 0;
    const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
    const cx = s.ax + t * dx, cy = s.ay + t * dy;
    const ddx = wpx - cx, ddy = wpy - cy;
    // wobble amplitude is +-TILE_PX*0.25 and the feather band is VEC_FEATHER_PX either side of
    // that, so anything further than half-width + ~12px can never affect coverage — reject early.
    const margin = s.halfW + TILE_PX * 0.25 + VEC_FEATHER_PX + 2;
    const dist2 = ddx * ddx + ddy * ddy;
    if (dist2 > margin * margin) continue; // cheap reject before paying for fbm
    const dist = Math.sqrt(dist2);
    if (dist < s.halfW) {
      if (coverPoly < 0) { coverPoly = s.poly; coverSeg = s.segIdx; }
      else if (s.poly !== coverPoly || Math.abs(s.segIdx - coverSeg) > 1) junction = true;
    }
    const wobble = (fbm(wpx / 40, wpy / 40, 2, seed) - 0.5) * TILE_PX * 0.5;
    const effHalf = s.halfW + wobble;
    const cov = clamp01(0.5 - (dist - effHalf) / VEC_FEATHER_PX);
    const score = dist - effHalf;
    if (cov > 0 && score < bestScore) {
      bestScore = score;
      bestCov = cov; bestDist = dist; bestHalfW = s.halfW;
      const len = Math.sqrt(len2);
      let e = Infinity;
      if (s.aOpen) e = tRaw * len;
      if (s.bOpen) e = Math.min(e, (1 - tRaw) * len);
      bestEnd = e;
    }
  }
  return bestCov > 0 ? { cov: bestCov, dist: bestDist, halfW: bestHalfW, endDist: bestEnd, junction } : VEC_SAMPLE_NONE;
}

const isCrops = (t: Terrain) => t === 'crops';
const isOpenGround = (t: Terrain) => t === 'open';
const isMud = (t: Terrain) => t === 'mud';
const isTallgrass = (t: Terrain) => t === 'tallgrass';
const isPaved = (t: Terrain) => t === 'pavedroad';
const isDirtRoad = (t: Terrain) => t === 'dirtroad';
const isWater = (t: Terrain) => t === 'water';
const isRubble = (t: Terrain) => t === 'rubble';
const isDirtySource = (t: Terrain) => t === 'pavedroad' || t === 'dirtroad' || t === 'rubble';
const isWoody = (t: Terrain) => t === 'woods' || t === 'scatteredtrees';
const isWoodsTile = (t: Terrain) => t === 'woods';
const isLeeSource = (t: Terrain) => t === 'hedge' || t === 'stonewall' || t === 'fence' || t === 'buildingWood' || t === 'buildingStone';
const isTrampleSource = (t: Terrain) => t === 'buildingWood' || t === 'buildingStone' || t === 'floor' || t === 'dirtroad' || t === 'pavedroad' || t === 'bridge';
const EMPTY_GRID: Grid = { data: new Float32Array(1), size: 1, any: false };
const FOREST_FLOOR_DARK: RGB = { r: 34, g: 36, b: 20 };
const FOREST_FLOOR_MID: RGB = { r: 70, g: 62, b: 34 };
const LITTER_BROWN: RGB = { r: 112, g: 82, b: 44 };
const LITTER_OLIVE: RGB = { r: 88, g: 94, b: 44 };
const SNOW_UNDER_TREES: RGB = { r: 176, g: 180, b: 186 };
// round-5 fix #7: the drift/lee shadows were a strong cornflower blue that pulled the whole
// snowfield's mean cooler than the reference's; warmed so red sits close to blue.
const SNOW_DRIFT_SHADOW: RGB = { r: 172, g: 176, b: 190 };
const SNOW_CREST: RGB = { r: 232, g: 230, b: 226 };
const SNOW_LEE_SHADOW: RGB = { r: 152, g: 154, b: 172 };
const SNOW_TRAMPLED: RGB = { r: 186, g: 186, b: 184 };
const SNOW_RUT: RGB = { r: 110, g: 94, b: 76 };
const DEAD_GRASS: RGB = { r: 146, g: 122, b: 82 };
const BARE_EARTH: RGB = { r: 84, g: 68, b: 52 };

/** Bilinear sample of a coverage grid at fractional GRID coords (index g <-> tile x0-1+g
 * centre), clamped to the grid — used for offset (lee-shadow) lookups. */
function sampleGridF(grid: Grid, gx: number, gy: number): number {
  if (!grid.any) return 0;
  const { data, size } = grid;
  const mx = size - 1.001;
  gx = gx < 0 ? 0 : gx > mx ? mx : gx;
  gy = gy < 0 ? 0 : gy > mx ? mx : gy;
  const i0 = gx | 0, j0 = gy | 0, fx = gx - i0, fy = gy - j0;
  const o = j0 * size + i0;
  const a = data[o] + (data[o + 1] - data[o]) * fx;
  const b = data[o + size] + (data[o + size + 1] - data[o + size]) * fx;
  return a + (b - a) * fy;
}

// ---------------------------------------------------------------- base fill
function paintGroundAndFeatures(
  data: Uint8ClampedArray, bufW: number, map: GameMap, season: Season, seed: number,
  x0: number, y0: number, tilesW: number, tilesH: number,
  groundUnder: Terrain[], mapW: number, mapH: number,
  fieldId: Int32Array, fieldAxis: Map<number, FieldInfo>,
  cropsGrid: Grid, mudGrid: Grid, tallgrassGrid: Grid, pavedGrid: Grid, dirtGrid: Grid, waterGrid: Grid, rubbleGrid: Grid, dirtyGrid: Grid,
  openGrid: Grid,
  pavedVec: VecAreaField | null, dirtVec: VecAreaField | null, waterVec: VecAreaField | null,
  tramRailY: number[],
  zoom: number, bpt: number,
  woodsGrid: Grid, leeGrid: Grid, trampleGrid: Grid,
): void {
  // ---- per-chunk low-frequency lattices (every LAT world px, bilinearly sampled per pixel):
  // snow drift height + its NW-facing slope, and two ridge-noise fields whose |v-0.5| iso-bands
  // become meandering trampled paths / paired vehicle ruts near buildings and roads.
  const winterPass = season === 'winter';
  const LAT = 4;
  const latN = Math.ceil((tilesW * TILE_PX) / LAT) + 2;
  const wx0px = x0 * TILE_PX, wy0px = y0 * TILE_PX;
  let latDrift: Float32Array | null = null, latLit: Float32Array | null = null;
  if (winterPass) {
    latDrift = new Float32Array(latN * latN); latLit = new Float32Array(latN * latN);
    const driftAt = (X: number, Y: number) => fbm((X * 0.8 + Y * 0.3) / 150, Y / 85, 2, seed + 7301);
    for (let j = 0; j < latN; j++) {
      for (let i = 0; i < latN; i++) {
        const X = wx0px + i * LAT, Y = wy0px + j * LAT;
        const d = driftAt(X, Y);
        const o = j * latN + i;
        latDrift[o] = d;
        latLit[o] = d - driftAt(X - 6, Y - 6);
      }
    }
  }
  const latSample = (arr: Float32Array, wpx: number, wpy: number): number => {
    const lx = (wpx - wx0px) / LAT, ly = (wpy - wy0px) / LAT;
    const i0 = lx | 0, j0 = ly | 0;
    const fx = lx - i0, fy = ly - j0;
    const o = j0 * latN + i0;
    const a = arr[o] + (arr[o + 1] - arr[o]) * fx;
    const b = arr[o + latN] + (arr[o + latN + 1] - arr[o + latN]) * fx;
    return a + (b - a) * fy;
  };
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

      for (let py = 0; py < bpt; py++) {
        const wpy = wy * TILE_PX + py / zoom;
        for (let px = 0; px < bpt; px++) {
          const wpx = wx * TILE_PX + px / zoom;

          // -------------------------------------------------------- coverage samples (cheap:
          // a handful of array lookups + one hash2 each — always computed first so the far
          // more expensive fbm ground blend below can be skipped entirely for pixels deep
          // inside a feature, since one of the branches further down will overwrite `color`
          // unconditionally in that case anyway). Roads/rivers prefer the smooth vector
          // distance field when the map declares one (see MapDef.vectors); tile-grid coverage
          // is the fallback (and always used for crops/rubble, which aren't vectorized).
          const covCrop = sampleGrid(cropsGrid, tx, px, ty, py, wpx, wpy, seed + 3001, 0.08, bpt);
          const covMud = sampleGrid(mudGrid, tx, px, ty, py, wpx, wpy, seed + 3011, 0.05, bpt);
          const covTallgrass = sampleGrid(tallgrassGrid, tx, px, ty, py, wpx, wpy, seed + 3021, 0.05, bpt);
          const pavedRes = pavedVec ? sampleVecArea(pavedVec, wpx, wpy, seed + 3101) : null;
          const covPaved = pavedRes ? pavedRes.cov : sampleGrid(pavedGrid, tx, px, ty, py, wpx, wpy, seed + 3101, 0.08, bpt);
          const dirtRes = dirtVec ? sampleVecArea(dirtVec, wpx, wpy, seed + 3201) : null;
          const covDirt = dirtRes ? dirtRes.cov : sampleGrid(dirtGrid, tx, px, ty, py, wpx, wpy, seed + 3201, 0.08, bpt);
          const waterRes = waterVec ? sampleVecArea(waterVec, wpx, wpy, seed + 3301) : null;
          const covWater = waterRes ? waterRes.cov : sampleGrid(waterGrid, tx, px, ty, py, wpx, wpy, seed + 3301, 0.08, bpt);
          const covRubble = sampleGrid(rubbleGrid, tx, px, ty, py, wpx, wpy, seed + 3401, 0.08, bpt);
          const deepFeature = covCrop > 0.85 || covMud > 0.85 || covTallgrass > 0.85 || covPaved > 0.85 || covDirt > 0.85 || covWater > 0.85 || covRubble > 0.85;

          // -------------------------------------------------- smoothed ground (feathered blend)
          let groundT: Terrain = 'grass';
          let color: RGB;
          if (!deepFeature) {
            const quarterT = bpt / 4;
            const cx0 = px < quarterT ? wx - 1 : wx, cx1 = cx0 + 1;
            const cy0 = py < quarterT ? wy - 1 : wy, cy1 = cy0 + 1;
            const tA = groundAt(cx0, cy0), tB = groundAt(cx1, cy0), tC = groundAt(cx0, cy1), tD = groundAt(cx1, cy1);
            // coherent low-frequency fbm wobble of the sample position (not per-pixel white
            // noise) so tile-to-tile ground borders wander like a brushed edge rather than
            // staying tile-aligned — applies uniformly to every soft-ground class (grass,
            // open, tallgrass, snow, mud all flow through this same code path).
            const wobX = (fbm(wpx / 24, wpy / 24, 1, seed + 8801) - 0.5) * (VEC_FEATHER_PX * 1.6);
            const wobY = (fbm(wpx / 24, wpy / 24, 1, seed + 8802) - 0.5) * (VEC_FEATHER_PX * 1.6);
            const fxx = clamp01((px < quarterT ? 0.5 + px / bpt : px / bpt - 0.5) + wobX / TILE_PX);
            const fyy = clamp01((py < quarterT ? 0.5 + py / bpt : py / bpt - 0.5) + wobY / TILE_PX);
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
            const bestGO = bestT === 'grass' || bestT === 'open';
            if (bestGO && openGrid.any) {
              // grass<->open: cross-fade over a blurred coverage field (sampled from the ground-
              // under map, so roads don't punch "grass" holes into open ground) instead of the
              // 4-corner pick, whose narrow feather left 20px tile stair-steps at 1:1.
              const covOpen = sampleGrid(openGrid, tx, px, ty, py, wpx, wpy, seed + 3031, 0.05, bpt);
              const ob = smooth01(covOpen, 0.32, 0.68);
              if (ob <= 0.003) color = groundColorFbm('grass', season, wpx, wpy, seed);
              else if (ob >= 0.997) color = groundColorFbm('open', season, wpx, wpy, seed);
              else color = lerpRGB(groundColorFbm('grass', season, wpx, wpy, seed), groundColorFbm('open', season, wpx, wpy, seed), ob);
              groundT = ob > 0.5 ? 'open' : 'grass';
            } else {
              color = groundColorFbm(bestT, season, wpx, wpy, seed);
            }
            // feathered 6px-ish blend band near borders (only pay for a second sample when close)
            const secondGO = secondT === 'grass' || secondT === 'open';
            if (secondT !== bestT && bestS - secondS < 0.3 && !(bestGO && secondGO && openGrid.any)) {
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
          // tile-stepped stamp; mud takes priority since it's usually the smaller, later detail).
          // Cross-faded by the coverage value itself (smooth01) rather than a hard `> 0.5` colour
          // switch — the grid is already blurred so covTallgrass/covMud ramp smoothly across a
          // real pixel band at the patch edge, but a binary switch still meets 100%-base-colour
          // against 100%-feature-colour in a single pixel right at the threshold, which is
          // exactly the hard "seam" the round-3 critique caught (fix #1/#2).
          const tgBlend = smooth01(covTallgrass, 0.32, 0.68);
          if (tgBlend > 0.003) {
            let tg = groundColorFbm('tallgrass', season, wpx, wpy, seed);
            if (covTallgrass < 0.62) tg = shade(tg, -0.08); // feathered inner edge, slightly duller
            if (season === 'summer') tg = shade(tg, (hash2(wpx, wpy, seed + 9121) - 0.5) * 0.3 + (hash2(Math.floor(wpx / 2), Math.floor(wpy / 3), seed + 9122) - 0.5) * 0.16); // stalk stipple
            color = lerpRGB(color, tg, tgBlend);
            if (tgBlend > 0.5) groundT = 'tallgrass';
          }
          const mudBlend = smooth01(covMud, 0.32, 0.68);
          if (mudBlend > 0.003) {
            let mc = groundColorFbm('mud', season, wpx, wpy, seed);
            if (covMud < 0.62) mc = shade(mc, -0.1);
            color = lerpRGB(color, mc, mudBlend);
            if (mudBlend > 0.5) groundT = 'mud';
          }

          // -------------------------------------------------------- crops
          // summer/autumn fields get a firm, ragged edge: coherent ~7px fbm jitter on the coverage
          // value and a narrow blend band, instead of a 20px soft feather (ref wheat has a crisp
          // lobed outline with a dark rim). Winter keeps the soft blend (fields ~= snow anyway).
          const cropEdge = season === 'winter' || covCrop <= 0.15 || covCrop >= 0.85
            ? covCrop : covCrop + (fbm(wpx / 7, wpy / 7, 2, seed + 4250) - 0.5) * 0.35;
          const cropBlend = season === 'winter' ? smooth01(covCrop, 0.32, 0.68) : smooth01(cropEdge, 0.44, 0.52);
          if (cropBlend > 0.003) {
            // Row axis: ONE base angle for the whole MAP (see fieldBaseAngleDeg — hashed from
            // the map id to 0/90/occasionally 45 degrees), and each contiguous field (flood-
            // filled in computeFields, small fields inheriting their nearest large field's
            // angle) only adds a small +-12 degree wobble on top. This is what keeps adjacent
            // wheat patches from ever showing perpendicular rows next to each other — no
            // per-field coin-flip between "horizontal" and "vertical" any more.
            const fid = fieldId[wy * mapW + wx];
            const info = fid >= 0 ? fieldAxis.get(fid) : undefined;
            const sinT = info ? info.sin : 0, cosT = info ? info.cos : 1;
            // slight low-frequency fbm wobble along the row so lines don't look ruler-straight,
            // then 3px-spaced rows — kept very faint: the reference wheat shows dense stipple, not
            // a visible barcode of rows.
            const wobSeed = seed + (fid >= 0 ? fid * 131 : 0) + 7701;
            const wobble = (fbm(wpx / 60, wpy / 60, 1, wobSeed) - 0.5) * 4;
            const perp = -wpx * sinT + wpy * cosT + wobble;
            const rowPhase = ((Math.floor(perp / 3) % 2) + 2) % 2; // guard against negative perp
            let color2: RGB;
            if (season === 'winter') {
              // snowbound field: within a few percent of open snow, broken faint furrows, sparse
              // stubble specks — no blue-grey corduroy sheet.
              const cropBase = lerpRGB(groundColorFbm('snow', season, wpx, wpy, seed), groundColorFbm('crops', season, wpx, wpy, seed), 0.2);
              color2 = cropBase;
              if (hash2(Math.floor(wpx / 4), Math.floor(wpy / 4), seed + 7710) > 0.35) color2 = shade(color2, rowPhase === 0 ? 0.015 : -0.015);
              const stub = hash2(wpx, wpy, seed + 7720);
              if (stub < 0.04) color2 = lerpRGB(color2, { r: 138, g: 120, b: 92 }, 0.3 + stub * 5);
              if (covCrop < 0.65) color2 = shade(color2, -0.04);
            } else {
              const cropBase = groundColorFbm('crops', season, wpx, wpy, seed);
              // single-pixel stipple only (the old 2px-block term read as a checkerboard, 4px blocks at zoom 2)
              color2 = shade(cropBase, (hash2(wpx, wpy, seed + 4243) - 0.5) * 0.26);
              color2 = shade(color2, rowPhase === 0 ? 0.03 : -0.03);
              if (cropEdge < 0.58) color2 = shade(color2, -0.22); // thin dark headland rim
            }
            color = lerpRGB(color, color2, cropBlend);
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
              if (ratio > 0.7) {
                const snowBlend = clamp01((ratio - 0.7) / 0.30) * 0.8;
                rc = lerpRGB(rc, groundColorFbm('snow', season, wpx, wpy, seed), snowBlend);
              }
              // two thin, broken dark-brown wheel ruts (no dark fill): faded at open road ends
              // and junctions so they never loop around an end cap or cross through each other.
              const trackOff = pavedRes ? Math.abs(pavedRes.dist - 0.4 * pavedRes.halfW) : Math.abs(ratio - 0.4) * 6;
              const rutOk = !pavedRes || (pavedRes.endDist >= pavedRes.halfW && !pavedRes.junction);
              if (rutOk && trackOff < 1.2 && hash2(Math.floor(wpx / 3), Math.floor(wpy / 3), seed + 4530) > 0.15) {
                rc = lerpRGB(rc, { r: 96, g: 84, b: 70 }, 0.75);
              }
            } else {
              if (atGutter) rc = shade(rc, -0.32); // dark gutter line right at the edge
              else if (nearEdge) rc = shade(rc, -0.16); // kerb
              const crackBlockX = Math.floor(wpx / 3), crackBlockY = Math.floor(wpy / 3);
              if (hash2(crackBlockX, crackBlockY, seed + 4501) < 0.02) rc = shade(rc, -0.24);
            }
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
            // The rut distance wobbles a little (fbm) so tracks meander instead of reading as
            // ruler-straight rails, and ruts fade out within one half-width of an OPEN polyline
            // end and wherever two non-adjacent segments overlap (junctions) — otherwise the
            // clamped distance iso-band wraps round the end cap into a hairpin loop.
            const rutWob = (fbm(wpx / 30, wpy / 30, 2, seed + 4620) - 0.5) * 2;
            const rutOk = !dirtRes || (dirtRes.endDist >= dirtRes.halfW && !dirtRes.junction);
            const inRutBand = rutOk && (dirtRes
              ? (Math.abs(dirtRes.dist + rutWob - 0.34 * dirtRes.halfW) < 1.9
                || Math.abs(dirtRes.dist + rutWob - 0.68 * dirtRes.halfW) < 1.4)
              : covDirt >= 0.58 && covDirt <= 0.74);
            const rutHit = inRutBand && hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 4602) > 0.2;
            if (season === 'winter') {
              // snow-covered track: pale snow with thin dark-brown ruts, no puddles
              // round-5 fix #7: wider, dirtier ruts (SNOW_RUT at ~3x the old coverage) — a snow
              // track in ref_cc3_1484 is two broad churned brown bands, not a hairline.
              if (rutHit) rc = lerpRGB(rc, SNOW_RUT, 0.8);
              else {
                rc = lerpRGB(rc, groundColorFbm('snow', season, wpx, wpy, seed), 0.55);
                const dh = hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 4611);
                if (dh < 0.22) rc = lerpRGB(rc, SNOW_RUT, 0.2 + 0.5 * (dh / 0.22));
                else if (dh < 0.34) rc = lerpRGB(rc, DEAD_GRASS, 0.3);
              }
            } else if (rutHit) {
              const puddleBucketX = Math.floor(wpx / 45), puddleBucketY = Math.floor(wpy / 45);
              if (hash2(puddleBucketX, puddleBucketY, seed + 4603) < 0.15) {
                rc = lerpRGB(rc, ROAD_WET_RUT, 0.55); // wet, churned earth in the rut
              } else {
                rc = lerpRGB(rc, ROAD_WET_RUT, 0.3);
              }
            }
            // ---- summer road surface: gravel. Round-5 fix #7 measured our dirt road at a local
            // contrast of 6 against the reference's 16-17 — a flat ochre slab with two rut lines.
            // The reference road is a *graded gravel* surface: a bright dry crown, dark damp ruts,
            // and loose stones catching the light. Three cheap layers reproduce that, all at the
            // 2-5 px scale the eye reads as grain (the ramp's own fbm bands only vary over 14-64 px):
            if (season !== 'winter') {
              // (1) a fine, road-following wash: a 3 px fbm band plus a per-pixel stipple
              const fineR = fbm(wpx / 3.5, wpy / 3.5, 1, seed + 4640);
              const grainR = hash2(wpx, wpy, seed + 4641);
              rc = shade(rc, (fineR - 0.5) * 0.30 + (grainR - 0.5) * 0.34);
              // (2) the crown: a graded track is domed, so the middle is dry and pale and the
              // verges are damp and dark. From vector geometry this is a real distance ratio.
              const ratioR = dirtRes ? Math.min(1, dirtRes.dist / Math.max(1, dirtRes.halfW)) : 1 - covDirt;
              rc = shade(rc, 0.14 - 0.34 * ratioR * ratioR);
              // (3) stamped gravel: ~8% of 2-3 px cells are loose stones (bright, with a dark
              // side away from the light), another ~6% are pressed-in dark grit.
              const gcx = Math.floor(wpx / 1.8), gcy = Math.floor(wpy / 1.8);
              const gh = hash2(gcx, gcy, seed + 4642);
              if (gh < 0.085) {
                const lit = hash2(gcx + (wpx > gcx * 2.5 + 1 ? 1 : 0), gcy, seed + 4643);
                rc = lerpRGB(rc, ROAD_GRAVEL, 0.35 + 0.45 * lit);
              } else if (gh < 0.145) {
                rc = shade(rc, -0.28 - 0.22 * hash2(gcx, gcy, seed + 4644));
              }
            } else if (hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 4610) < 0.02) {
              rc = shade(rc, -0.2); // sparse stones (mostly buried under snow in winter)
            }
            color = rc;
          }

          // -------------------------------------------------------- water
          const waterBlend = smooth01(covWater, 0.32, 0.68);
          if (waterBlend > 0.003) {
            let wc = groundColorFbm('water', season, wpx, wpy, seed);
            const bankRatio = waterRes ? waterRes.dist / waterRes.halfW : null;
            if (season === 'winter') {
              // wind-scoured pale ice/snow patches inside the dark steel-grey ice, a dark-brown
              // reed/scrub line along each bank, and a narrow snow band just inside it.
              const ice = fbm(wpx / 18, wpy / 18, 2, seed + 4805);
              if (ice > 0.66) wc = lerpRGB(wc, { r: 214, g: 222, b: 228 }, clamp01((ice - 0.66) / 0.15) * 0.55);
              if (bankRatio !== null) {
                if (bankRatio > 0.86) wc = lerpRGB(wc, { r: 96, g: 78, b: 58 }, 0.55);
                else if (bankRatio > 0.7) wc = lerpRGB(wc, { r: 225, g: 230, b: 234 }, 0.35);
              } else {
                if (covWater < 0.6) wc = lerpRGB(wc, { r: 96, g: 78, b: 58 }, 0.55);
                else if (covWater < 0.7) wc = lerpRGB(wc, { r: 225, g: 230, b: 234 }, 0.35);
              }
            } else if (bankRatio !== null) {
              if (bankRatio > 0.82) wc = shade(wc, -0.3); // dark bank line
              else if (bankRatio > 0.62) wc = shade(wc, 0.18); // bank highlight band
            } else {
              if (covWater < 0.62) wc = shade(wc, -0.3);
              else if (covWater < 0.72) wc = shade(wc, 0.18);
            }
            color = lerpRGB(color, wc, waterBlend);
          }

          // -------------------------------------------------------- rubble
          const rubbleBlend = smooth01(covRubble, 0.32, 0.68);
          if (rubbleBlend > 0.003) {
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
            color = lerpRGB(color, rb, rubbleBlend);
          }

          // ---------------------------------------------------- dirty snow near roads/rubble
          if (season === 'winter' && groundT === 'snow' && covPaved <= 0.5 && covDirt <= 0.5 && covRubble <= 0.5) {
            const covDirty = sampleGrid(dirtyGrid, tx, px, ty, py, wpx, wpy, seed + 3601, 0.05);
            const blend = clamp01(covDirty) * 0.55;
            if (blend > 0.01) color = lerpRGB(color, groundColorFbm('mud', season, wpx, wpy, seed), blend);
          }

          // ------------------------------------------- brush-clump texture on plain ground (not
          // crops/mud/tallgrass/roads/water/rubble): round-3 critique #2 — the old flat 4%-of-
          // pixels single-pixel fleck read as uniform "TV static" grain, not painted brush-work.
          // Replaced with a mid-frequency clump layer (dab-like patches) plus sparse short
          // directional tufts (grass strokes), both of which are strictly cheaper-looking (they
          // vary over several pixels) than isolated single-pixel noise.
          const plainGround = (groundT === 'grass' || groundT === 'open' || groundT === 'snow')
            && covCrop <= 0.5 && covMud <= 0.5 && covTallgrass <= 0.5
            && covPaved <= 0.5 && covDirt <= 0.5 && covWater <= 0.5 && covRubble <= 0.5;
          if (plainGround) {
            // (b) mid-frequency 'clump' layer: fbm at 6-10px wavelength, posterised into 4 tonal
            // steps then blended 60% with the raw (continuous) value so the clump edges stay soft
            // rather than razor-stepped — this is what produces visible dab-like patches.
            const clump = clamp01(fbmClump(wpx, wpy, seed));
            const posterized = Math.round(clump * 3) / 3;
            const soft = lerp(clump, posterized, 0.6);
            const isSnowGround = groundT === 'snow';
            color = shade(color, (soft - 0.5) * (isSnowGround ? 0.36 : 0.40));
            // (c) sparse directional strokes 3-7px long ("grass tufts"), following a slowly
            // varying angle field. Grass/open get denser, stronger tufts plus sparse dark-brown
            // earth flecks (ref grass stipple); snow keeps the subtler original values.
            // Round-5 fix #7/#15: tuft density and amplitude raised (0.40/0.16 -> 0.48/0.24) so the
            // 5-15 px scale the eye actually reads as "grass" carries real contrast.
            const tuft = isSnowGround ? tuftShade(wpx, wpy, seed, 0.3, 0.13) : tuftShade(wpx, wpy, seed, 0.48, 0.24);
            if (tuft !== 0) color = shade(color, tuft);
            if (season !== 'summer' && !isSnowGround && hash2(wpx, wpy, seed + 9100) < 0.06) color = lerpRGB(color, { r: 92, g: 70, b: 38 }, 0.35);
            if (season === 'summer' && !isSnowGround) {
              // Single-pixel only (no 2px term: that read as a checkerboard). ref_cc3_1479 grass is
              // olive with dense per-pixel warm dirt/dry-grass speckle, so: a 1px luminance stipple,
              // plus ~8-12% of pixels pushed to warm brown or dry ochre and darker 1px flecks, with
              // density clumped by the mid-frequency `clump` field (dirt showing through grass).
              const hs = hash2(wpx, wpy, seed + 9111);
              color = shade(color, (hs - 0.5) * 0.60);
              const dirt = fbm(wpx / 12, wpy / 12, 1, seed + 9130) * 0.65 + clump * 0.35;
              const dens = 0.02 + 0.26 * smooth01(dirt, 0.42, 0.74);
              const hp = hash2(wpx, wpy, seed + 9120);
              if (hp < dens) {
                const warm = hash2(wpx, wpy, seed + 9121) < 0.55 ? SPECKLE_BROWN : SPECKLE_OCHRE;
                color = lerpRGB(color, warm, 0.45 + 0.35 * (hp / dens));
              } else if (hp < dens * 1.5) {
                color = shade(color, -0.44 - 0.24 * hs); // dark 1px fleck
              }
            }
          }

          // ------------------------------------------------ forest floor under dense woods
          // dark brown-green floor with leaf-litter speckle, so gaps between crowns read as
          // shaded ground rather than open meadow.
          if (plainGround && woodsGrid.any) {
            const covWoods = sampleGrid(woodsGrid, tx, px, ty, py, wpx, wpy, seed + 3701, 0.05, bpt);
            const fb = smooth01(covWoods, 0.3, 0.72);
            if (fb > 0.003 && !winterPass) {
              const mott = hash2(Math.floor(wpx / 3), Math.floor(wpy / 3), seed + 7402) * 0.55 + hash2(wpx, wpy, seed + 7403) * 0.45;
              let fl = lerpRGB(FOREST_FLOOR_DARK, FOREST_FLOOR_MID, mott);
              const lh = hash2(wpx, wpy, seed + 7401);
              if (lh < 0.09) fl = lerpRGB(fl, LITTER_BROWN, 0.75);
              else if (lh < 0.14) fl = lerpRGB(fl, LITTER_OLIVE, 0.7);
              else if (lh < 0.22) fl = shade(fl, -0.35);
              color = lerpRGB(color, fl, fb * 0.9);
            } else if (fb > 0.003) {
              // winter: thinner, greyer snow under the canopy with twig/leaf litter showing
              color = lerpRGB(color, SNOW_UNDER_TREES, fb * 0.35);
              const lh = hash2(wpx, wpy, seed + 7401);
              if (lh < 0.03 * fb) color = lerpRGB(color, LITTER_BROWN, 0.5);
            }
          }

          // ------------------------------------------------ snow depth (winter open snow)
          if (winterPass && plainGround && groundT === 'snow' && latDrift && latLit) {
            const dv = latSample(latDrift, wpx, wpy);
            const dl = latSample(latLit, wpx, wpy);
            // blue-grey drift hollows, bright sunlit crests, cooler lee slopes
            const trough = 1 - smooth01(dv, 0.3, 0.62);
            color = lerpRGB(color, SNOW_DRIFT_SHADOW, trough * 0.32);
            const crest = clamp01(dl * 16);
            const lee = clamp01(-dl * 16);
            if (crest > 0) color = lerpRGB(color, SNOW_CREST, crest * 0.6);
            if (lee > 0) color = lerpRGB(color, SNOW_DRIFT_SHADOW, lee * 0.3);

            // soft blue shadow on the lee (SE) side of hedges/walls/fences/buildings
            if (leeGrid.any) {
              const gxl = tx + px / bpt + 0.5 - 0.45, gyl = ty + py / bpt + 0.5 - 0.45;
              const leeS = smooth01(sampleGridF(leeGrid, gxl, gyl), 0.08, 0.42);
              if (leeS > 0.003) color = lerpRGB(color, SNOW_LEE_SHADOW, leeS * 0.42);
            }

            // trampled ground around buildings and along roads
            // (explicit track curves are stroked per building in paintWinterTracks; here trampled
            // ground only greys the snow a little and lets earth show through more easily)
            let tramp = 0;
            if (trampleGrid.any) {
              tramp = smooth01(sampleGrid(trampleGrid, tx, px, ty, py, wpx, wpy, seed + 3801, 0.02, bpt), 0.1, 0.4);
              if (tramp > 0.003) color = lerpRGB(color, SNOW_TRAMPLED, tramp * 0.18);
            }

            // exposed dark earth / dead-grass streaks where snow lies thin: road shoulders, under
            // trees, along hedges and walls, trampled ground and wind-scoured crests
            const covDirtyT = dirtyGrid.any ? sampleGrid(dirtyGrid, tx, px, ty, py, wpx, wpy, seed + 3602, 0.03, bpt) : 0;
            const covLeeHere = leeGrid.any ? sampleGrid(leeGrid, tx, px, ty, py, wpx, wpy, seed + 3702, 0.03, bpt) : 0;
            const covW = woodsGrid.any ? sampleGrid(woodsGrid, tx, px, ty, py, wpx, wpy, seed + 3703, 0.03, bpt) : 0;
            // Round-5 fix #7: ref_cc3_1482 sells snow with DIRT — exposed earth along every track
            // and bank, brown dead grass poking through everywhere, not only beside a hedge. The
            // `thin` field is roughly tripled (a real floor over open snow, and every source
            // weighted up), and the threshold now spends the whole field instead of 42% of it.
            const thin = Math.max(
              0.40,                                  // open snowfield: never bare paper
              clamp01(covDirtyT) * 0.85,
              covW * 0.6, covLeeHere * 1.2, tramp * 0.7, crest * 0.2,
            );
            {
              // Three scales, weighted toward the isotropic CLUMP octave: the reference's dead
              // vegetation sits in round tussocks a few pixels across scattered evenly over the
              // field, not in the wind-combed horizontal bands a single anisotropic fbm gives.
              const clumpS = clamp01(fbmClump(wpx, wpy, seed + 7360));
              const en = clumpS * 0.50
                + fbm(wpx / 13, wpy / 13, 1, seed + 7351) * 0.28
                + hash2(wpx, wpy, seed + 7352) * 0.22;
              const thr = 1 - thin * 0.92;
              if (en > thr) {
                const amt = clamp01((en - thr) * 5.5);
                const ec = lerpRGB(BARE_EARTH, DEAD_GRASS, smooth01(fbm(wpx / 2.5, wpy / 7, 1, seed + 7353), 0.42, 0.58));
                color = lerpRGB(color, ec, amt * 0.92);
                // twigs: the darkest pixels inside a tussock, which is where most of the
                // reference's per-pixel contrast actually lives
                if (amt > 0.45 && hash2(wpx, wpy, seed + 7356) < 0.3) color = shade(color, -0.4);
              }
              // scattered grit, hard little drift shadows and wind-polished highlights, so open
              // snow still has grain where no stubble showed through
              const gh = hash2(Math.floor(wpx / 2), Math.floor(wpy / 2), seed + 7355);
              if (gh < 0.06) color = lerpRGB(color, SNOW_RUT, 0.25 + 4 * gh);
              else if (gh < 0.17) color = lerpRGB(color, SNOW_DRIFT_SHADOW, 0.3);
              else if (gh > 0.9) color = lerpRGB(color, SNOW_CREST, 0.36);
            }
          }

          // -------------------------------------------------------- relief + grain + brush
          const rf = reliefFactor(wpx, wpy, seed);
          color = shade(color, rf - 1);
          // (a) low-amplitude per-pixel grain, +-3 RGB (was +-6 — the round-3 critique's "digital
          // speckle" complaint was largely this term dominating at full amplitude).
          const grain = (hash2(wpx, wpy, seed + 9001) - 0.5) * 6;
          color = { r: clamp255(color.r + grain), g: clamp255(color.g + grain), b: clamp255(color.b + grain) };
          const brush = 0.97 + 0.06 * hash2(Math.floor(wpx / 2), Math.floor(wpy / 3), seed + 9002);
          color = { r: clamp255(color.r * brush), g: clamp255(color.g * brush), b: clamp255(color.b * brush) };

          setPixel(data, bufW, tx * bpt + px, ty * bpt + py, color);
        }
      }
    }
  }
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

/** Solid wooden deck with plank seams across the direction of travel, side rails where the deck
 * ends, and a shadow cast onto the water on the SE side. Travel direction = the bridge rect's
 * long axis (length of the contiguous bridge run through this tile in each direction). */
function paintBridge(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const run = (dx: number, dy: number): number => {
    let n = 0;
    for (let k = 1; k < 64 && tileAt(map, wx + dx * k, wy + dy * k) === 'bridge'; k++) n++;
    return n;
  };
  const lenH = 1 + run(1, 0) + run(-1, 0);
  const lenV = 1 + run(0, 1) + run(0, -1);
  const travelH = lenH >= lenV;
  ctx.fillStyle = '#6a5232';
  ctx.fillRect(ox, oy, TILE_PX, TILE_PX);
  ctx.fillStyle = '#4a3618';
  if (travelH) { for (let x = ((wx * TILE_PX) % 3 + 3) % 3; x < TILE_PX; x += 3) ctx.fillRect(ox + x, oy, 1, TILE_PX); }
  else { for (let y = ((wy * TILE_PX) % 3 + 3) % 3; y < TILE_PX; y += 3) ctx.fillRect(ox, oy + y, TILE_PX, 1); }
  const isWaterT = (t: Terrain) => t === 'water';
  if (travelH) {
    const north = tileAt(map, wx, wy - 1), south = tileAt(map, wx, wy + 1);
    if (north !== 'bridge') {
      ctx.fillStyle = '#3a2a14'; ctx.fillRect(ox, oy, TILE_PX, 2);
      ctx.fillStyle = '#8a6c40'; ctx.fillRect(ox, oy + 2, TILE_PX, 1);
    }
    if (south !== 'bridge') {
      ctx.fillStyle = '#3a2a14'; ctx.fillRect(ox, oy + TILE_PX - 2, TILE_PX, 2);
      ctx.fillStyle = '#8a6c40'; ctx.fillRect(ox, oy + TILE_PX - 3, TILE_PX, 1);
      if (isWaterT(south)) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(ox, oy + TILE_PX, TILE_PX, 3); }
    }
  } else {
    const west = tileAt(map, wx - 1, wy), east = tileAt(map, wx + 1, wy);
    if (west !== 'bridge') {
      ctx.fillStyle = '#3a2a14'; ctx.fillRect(ox, oy, 2, TILE_PX);
      ctx.fillStyle = '#8a6c40'; ctx.fillRect(ox + 2, oy, 1, TILE_PX);
    }
    if (east !== 'bridge') {
      ctx.fillStyle = '#3a2a14'; ctx.fillRect(ox + TILE_PX - 2, oy, 2, TILE_PX);
      ctx.fillStyle = '#8a6c40'; ctx.fillRect(ox + TILE_PX - 3, oy, 1, TILE_PX);
      if (isWaterT(east)) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(ox + TILE_PX, oy, 3, TILE_PX); }
    }
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

/** Winter hedges are leafless brown scrub lines with snow flecks (ref winter scrub), not green. */
const HEDGE_WINTER = { core: '#5c4632', shadow: 'rgba(20,14,8,0.45)', lobe: '#8a7256', snow: '#e8ecf0' };
/** Summer hedges: dark natural olive-green (hue ~75deg), not the old blue-leaning teal-green. */
const HEDGE_SUMMER = { core: '#343a24', shadow: 'rgba(12,12,4,0.45)', lobe: '#5a6238', bump: '#4c5432' };

function paintHedge(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number, season: Season): void {
  const winter = season === 'winter';
  const stubs = linearStubs(map, wx, wy, (t) => t === 'hedge');
  if (winter) {
    ctx.globalAlpha = 1;
    drawBand(ctx, ox + 1, oy + 1, 6, stubs, HEDGE_WINTER.shadow);
  } else {
    ctx.globalAlpha = 0.25;
    drawBand(ctx, ox + 1, oy + 1, 6, stubs, '#0e1006');
    ctx.globalAlpha = 1;
  }
  drawBand(ctx, ox, oy, 6, stubs, winter ? HEDGE_WINTER.core : HEDGE_SUMMER.core);
  // lighter bumpy top pixels
  const c = TILE_PX / 2;
  for (let i = 0; i < TILE_PX; i += 2) {
    const bump = hash2(wx * 4 + i, wy * 4 + i, seed + 71) > 0.5 ? 1 : 0;
    ctx.fillStyle = winter ? HEDGE_WINTER.lobe : HEDGE_SUMMER.bump;
    if (stubs.r || stubs.l) ctx.fillRect(ox + i, oy + c - 3 + bump, 2, 1);
    else ctx.fillRect(ox + c - 3 + bump, oy + i, 1, 2);
    if (winter && hash2(wx * 5 + i, wy * 5 + i, seed + 72) > 0.6) {
      ctx.fillStyle = HEDGE_WINTER.snow;
      if (stubs.r || stubs.l) ctx.fillRect(ox + i, oy + c - 4 + bump, 1, 1);
      else ctx.fillRect(ox + c - 4 + bump, oy + i, 1, 1);
    }
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
  // `occ` is the original footprint while classifying outside/courtyard; tiles whose roof has
  // caved in (blast damage turned them to rubble/wall stubs) are dropped from it at the end, so the
  // roof is clipped around them without mistaking them for a courtyard.
  const occ = new Array<boolean>(w * h);
  const caved: number[] = [];
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const ti = idx(map, bb.minX + tx, bb.minY + ty);
      occ[ty * w + tx] = map.buildingId[ti] === bb.id;
      if (occ[ty * w + tx] && !BUILDING_TERRAINS.has(map.tiles[ti])) caved.push(ty * w + tx);
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
  for (const k of caved) occ[k] = false;
  if (caved.length) irregular = true;
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

type RoofTex = 'shingle' | 'plank' | 'tile';
/** Pattern period in world px — must divide CHUNK_PX so the texture lines up across chunk seams. */
const ROOF_TEX_PERIOD = 20;
const roofPatternCanvas = new Map<string, HTMLCanvasElement>();

/** A tileable overlay (alpha light/dark only, so it works on any roof colour) generated per pixel
 * at the OUTPUT resolution for the given zoom: shingle courses with staggered joints, planks, or
 * clay/stone tile courses. Courses run parallel to the ridge. */
function roofPatternSource(kind: RoofTex, ridgeHoriz: boolean, zoom: number): HTMLCanvasElement {
  const key = `${kind}|${ridgeHoriz ? 'h' : 'v'}|${zoom}`;
  let c = roofPatternCanvas.get(key);
  if (c) return c;
  const P = Math.max(2, Math.round(ROOF_TEX_PERIOD * zoom));
  c = document.createElement('canvas');
  c.width = P; c.height = P;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(P, P);
  const d = img.data;
  const course = kind === 'plank' ? 5 : 4;
  const joint = kind === 'plank' ? 20 : kind === 'tile' ? 4 : 5;
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      // (a = across-ridge coord, b = along-ridge coord) in world px
      const wxp = (i + 0.5) / zoom, wyp = (j + 0.5) / zoom;
      const a = ridgeHoriz ? wyp : wxp, b = ridgeHoriz ? wxp : wyp;
      let lum = 0; // -1..1
      if (kind === 'plank') {
        // planks run ACROSS courses (perpendicular to ridge) — swap roles
        const pa = b, pb = a;
        const pi = Math.floor(pa / course);
        const fa = pa / course - pi;
        lum = (hash2(pi, 0, 7711) - 0.5) * 0.5;
        if (fa < 0.12 * (zoom >= 2 ? 1 : 1.6)) lum -= 0.7;
        else if (fa < 0.3) lum += 0.12;
        lum += (hash2(pi, Math.floor(pb / 2), 7712) - 0.5) * 0.18;
      } else {
        const ci = Math.floor(a / course);
        const fa = a / course - ci;
        const stagger = ci % 2 ? joint / 2 : 0;
        const si = Math.floor((b + stagger) / joint);
        const fb = (b + stagger) / joint - si;
        lum = (hash2(ci, si, kind === 'tile' ? 7721 : 7731) - 0.5) * 0.55;
        if (kind === 'tile') lum += Math.sin(fb * Math.PI) * 0.3 - 0.15; // rounded pantile
        else lum += (fa - 0.5) * 0.35; // each shingle lighter at its lower, exposed butt edge
        const edgeW = 0.9 / (course * zoom);
        if (fa > 1 - edgeW * 1.2) lum -= 0.85; // course shadow line
        if (fb < 0.9 / (joint * zoom)) lum -= 0.5; // joint
      }
      const o = (j * P + i) * 4;
      if (lum >= 0) { d[o] = 255; d[o + 1] = 236; d[o + 2] = 200; d[o + 3] = Math.min(255, lum * 90); }
      else { d[o] = 16; d[o + 1] = 10; d[o + 2] = 4; d[o + 3] = Math.min(255, -lum * 125); }
    }
  }
  ctx.putImageData(img, 0, 0);
  roofPatternCanvas.set(key, c);
  return c;
}

function getRoofPattern(ctx: CanvasRenderingContext2D, kind: RoofTex, ridgeHoriz: boolean, zoom: number): CanvasPattern | null {
  const pat = ctx.createPattern(roofPatternSource(kind, ridgeHoriz, zoom), 'repeat');
  if (!pat) return null;
  // the bake context is scaled by `zoom`: map one pattern pixel to one output pixel
  if (typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([1 / zoom, 0, 0, 1 / zoom, 0, 0]));
  return pat;
}

/** Building height in world px (drives cast-shadow length). */
function buildingHeightPx(bb: BuildingBBox, big: boolean, seed: number): number {
  const base = big ? 10 : bb.kind === 'stone' ? 8.5 : 7;
  return base + (hash2(bb.id, 29, seed + 731) - 0.5) * 2;
}

/** SE cast shadow for one building: every occupied tile swept by the sun offset, unioned into one
 * path (nonzero fill) so overlapping sweeps never double the alpha, with a softer wider halo. */
function paintBuildingShadow(ctx: CanvasRenderingContext2D, map: GameMap, bb: BuildingBBox, x0: number, y0: number, seed: number, season: Season): void {
  const fp = analyzeFootprint(map, bb);
  if (!fp.occ.some(Boolean)) return; // ruined: no roof left to cast a shadow
  const wTiles = bb.maxX - bb.minX + 1, hTiles = bb.maxY - bb.minY + 1;
  const big = bb.origBig ?? (fp.hole !== null || (wTiles > 12 && hTiles > 12));
  const hgt = buildingHeightPx(bb, big, seed);
  const snowy = season === 'winter';
  const sweep = (dx: number, dy: number): Path2D => {
    const p = new Path2D();
    for (let ty = 0; ty < fp.h; ty++) {
      for (let tx = 0; tx < fp.w; tx++) {
        if (!fp.occ[ty * fp.w + tx]) continue;
        const l = (bb.minX + tx - x0) * TILE_PX, t = (bb.minY + ty - y0) * TILE_PX;
        const r = l + TILE_PX, b = t + TILE_PX;
        p.moveTo(l, t); p.lineTo(r, t); p.lineTo(r + dx, t + dy); p.lineTo(r + dx, b + dy); p.lineTo(l + dx, b + dy); p.lineTo(l, b); p.closePath();
      }
    }
    return p;
  };
  // Round-5 fix #5: this is now unconditional and deliberately heavy enough to read at zoom 1 on
  // summer grass as well as on snow — in ref_cc3_1484 the cast shadow is the single strongest cue
  // that a building has height. Length scales with the building's own height (buildingHeightPx).
  const dx = hgt * 1.25, dy = hgt * 1.05;
  ctx.fillStyle = snowy ? 'rgba(52,66,104,0.24)' : 'rgba(10,10,6,0.2)';
  ctx.fill(sweep(dx + 4, dy + 4), 'nonzero');   // penumbra
  ctx.fillStyle = snowy ? 'rgba(46,60,98,0.56)' : 'rgba(8,8,4,0.5)';
  ctx.fill(sweep(dx, dy), 'nonzero');           // the shadow proper
  ctx.fillStyle = snowy ? 'rgba(38,48,82,0.34)' : 'rgba(6,6,2,0.34)';
  ctx.fill(sweep(dx * 0.5, dy * 0.5), 'nonzero'); // darker close to the wall
}

function paintRoof(ctx: CanvasRenderingContext2D, map: GameMap, bb: BuildingBBox, x0: number, y0: number, seed: number, season: Season, zoom = 1): void {
  const left = (bb.minX - x0) * TILE_PX;
  const top = (bb.minY - y0) * TILE_PX;
  const wTiles = bb.maxX - bb.minX + 1;
  const hTiles = bb.maxY - bb.minY + 1;
  const w = wTiles * TILE_PX;
  const h = hTiles * TILE_PX;
  const stone = bb.kind === 'stone';
  const snowy = season === 'winter';
  const fp = analyzeFootprint(map, bb);
  if (!fp.occ.some(Boolean)) return; // ruined: the roof is gone
  const big = bb.origBig ?? (fp.hole !== null || (wTiles > 12 && hTiles > 12));

  // Eaves overhang: the roof oversails its wall, so a graded band of its own shadow falls on the
  // ground/wall-top just outside the S and E eaves, deepest right under the edge and fading over
  // the overhang's depth (round-5 fix #5: this used to be a flat 2 px slab).
  {
    const over = 3 + (big ? 2 : 0);
    const gE = ctx.createLinearGradient(left + w, 0, left + w + over, 0);
    gE.addColorStop(0, snowy ? 'rgba(28,36,58,0.62)' : 'rgba(8,8,4,0.58)');
    gE.addColorStop(1, snowy ? 'rgba(28,36,58,0)' : 'rgba(8,8,4,0)');
    ctx.fillStyle = gE;
    ctx.fillRect(left + w, top + 1, over, h + over);
    const gS = ctx.createLinearGradient(0, top + h, 0, top + h + over);
    gS.addColorStop(0, snowy ? 'rgba(28,36,58,0.62)' : 'rgba(8,8,4,0.58)');
    gS.addColorStop(1, snowy ? 'rgba(28,36,58,0)' : 'rgba(8,8,4,0)');
    ctx.fillStyle = gS;
    ctx.fillRect(left + 1, top + h, w + over, over);
  }

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
    const flat = snowy ? mixHex(flatBase, SNOW_LIT, 0.62) : flatBase;
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
    // roofing-felt seams at output resolution
    {
      const pat = getRoofPattern(ctx, 'plank', w >= h, zoom);
      if (pat) { ctx.fillStyle = pat; ctx.globalAlpha = 0.35; ctx.fillRect(left, top, w, h); ctx.globalAlpha = 1; }
    }
    // 2px parapet at the outer edge (lit on N/W, dark on S/E) casting a shadow onto the roof
    // just inside its N and W runs
    ctx.fillStyle = snowy ? 'rgba(40,52,84,0.28)' : 'rgba(0,0,0,0.28)';
    ctx.fillRect(left + 2, top + 2, w - 4, 3);
    ctx.fillRect(left + 2, top + 5, 3, h - 7);
    ctx.fillStyle = shadeHex(flat, 0.25);
    ctx.fillRect(left, top, w, 2);
    ctx.fillRect(left, top, 2, h);
    ctx.fillStyle = shadeHex(flat, -0.4);
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
    // Winter: the roof material stays legible under a frosted tone (shaded slope reads as dark
    // material, lit slope a frosted tone clearly darker than ground snow) with snow patches on
    // top, instead of a SNOW_LIT/SNOW_SHADE box that vanished into the ground snow.
    const litFill = snowy ? mixHex(v.light, SNOW_LIT, 0.55) : v.light;
    const shadeFill = snowy ? mixHex(v.dark, SNOW_SHADE, 0.25) : v.dark;

    const along = ridgeHoriz ? w : h; // ridge length
    const across = ridgeHoriz ? h : w;
    const ridgeAt = Math.floor(across / 2);
    // two slopes: NW-facing slope (N half for an E-W ridge, W half for N-S) catches the sun
    const litRect = ridgeHoriz ? [left, top, w, ridgeAt] : [left, top, ridgeAt, h];
    const shadeRect = ridgeHoriz ? [left, top + ridgeAt, w, h - ridgeAt] : [left + ridgeAt, top, w - ridgeAt, h];
    // Round-5 fix #5: the roof used to be two flat fills butted together at a razor-sharp line,
    // which read as two materials rather than one pitched roof. It is now ONE continuous
    // material graded across both pitches: brightest along the ridge on the sun (NW) side,
    // falling steadily to each eave, with the far pitch a whole step darker. Nothing here is a
    // hard band except the ridge cap itself.
    {
      const pitch = ctx.createLinearGradient(
        ridgeHoriz ? 0 : left, ridgeHoriz ? top : 0,
        ridgeHoriz ? 0 : left + w, ridgeHoriz ? top + h : 0,
      );
      const r = Math.max(0.04, Math.min(0.96, ridgeAt / Math.max(1, across)));
      // One material throughout — every stop is v.base shaded, so the two pitches read as the same
      // roof lit from two angles (ref_cc3_1484), not as two different coverings.
      pitch.addColorStop(0, shadeHex(v.base, -0.04));             // NW eave, under its overhang
      pitch.addColorStop(r * 0.5, shadeHex(v.base, 0.14));        // up the sunlit pitch
      pitch.addColorStop(Math.max(0, r - 0.04), shadeHex(v.base, 0.3)); // ridge, sun side
      pitch.addColorStop(Math.min(1, r + 0.04), shadeHex(v.base, -0.16)); // ridge, shade side
      pitch.addColorStop(Math.min(1, r + (1 - r) * 0.55), shadeHex(v.base, -0.3));
      pitch.addColorStop(1, shadeHex(v.base, -0.44));             // SE eave, deepest shade
      ctx.fillStyle = pitch;
      ctx.fillRect(left, top, w, h);
    }
    void along;

    // shingle / plank / tile courses at OUTPUT resolution (pattern generated per zoom)
    const texKind: RoofTex = stone ? 'tile' : hash2(bb.id, 17, seed + 721) < 0.62 ? 'shingle' : 'plank';
    const pat = getRoofPattern(ctx, texKind, ridgeHoriz, zoom);
    if (pat) {
      ctx.fillStyle = pat;
      // round-5 fix #5: the courses were too low-contrast to survive at zoom 1 — drawn twice
      // (the second pass only at zoom 1, where one pattern pixel is one screen pixel) so the
      // shingle/plank rhythm is actually visible on the map rather than only at zoom 2.
      ctx.globalAlpha = snowy ? 0.6 : 1;
      ctx.fillRect(left, top, w, h);
      if (!snowy && zoom <= 1) { ctx.globalAlpha = 0.55; ctx.fillRect(left, top, w, h); }
      ctx.globalAlpha = 1;
    }
    // gable-end falloff ALONG the ridge: a real roof is a little darker where it runs back into
    // its own gable, which keeps the ridge from reading as a painted stripe of constant value
    {
      const gEnd = ridgeHoriz
        ? ctx.createLinearGradient(left, 0, left + w, 0)
        : ctx.createLinearGradient(0, top, 0, top + h);
      gEnd.addColorStop(0, 'rgba(0,0,0,0.16)');
      gEnd.addColorStop(0.22, 'rgba(0,0,0,0)');
      gEnd.addColorStop(0.78, 'rgba(0,0,0,0)');
      gEnd.addColorStop(1, 'rgba(0,0,0,0.2)');
      ctx.fillStyle = gEnd;
      ctx.fillRect(left, top, w, h);
    }

    // hipped-end hint: darker triangles at each end of the ridge on the shaded slope
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    if (ridgeHoriz) {
      const g = Math.min(h * 0.45, w * 0.25);
      ctx.beginPath(); ctx.moveTo(left, top + ridgeAt); ctx.lineTo(left + g, top + h); ctx.lineTo(left, top + h); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(left + w, top + ridgeAt); ctx.lineTo(left + w - g, top + h); ctx.lineTo(left + w, top + h); ctx.closePath(); ctx.fill();
    } else {
      const g = Math.min(w * 0.45, h * 0.25);
      ctx.beginPath(); ctx.moveTo(left + ridgeAt, top); ctx.lineTo(left + w, top + g); ctx.lineTo(left + w, top); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(left + ridgeAt, top + h); ctx.lineTo(left + w, top + h - g); ctx.lineTo(left + w, top + h); ctx.closePath(); ctx.fill();
    }

    if (snowy) {
      // snow cover: bright on the sunlit slope, cold blue-grey on the shaded slope, thinning to
      // bare material along the eaves and in wind-scoured patches, so ridge and eaves still read.
      const [lx, ly, lw, lh] = litRect;
      const [sx, sy, sw, sh] = shadeRect;
      ctx.fillStyle = 'rgba(238,242,246,0.64)';
      ctx.fillRect(lx, ly, lw, lh);
      ctx.fillStyle = 'rgba(176,190,212,0.46)';
      ctx.fillRect(sx, sy, sw, sh);
      // roof courses still faintly show through the snow
      if (pat) { ctx.fillStyle = pat; ctx.globalAlpha = 0.3; ctx.fillRect(left, top, w, h); ctx.globalAlpha = 1; }
      // wind-scoured streaks along the courses where the roof material shows through
      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, w, h); ctx.clip();
      const bareN = Math.max(2, Math.floor((w * h) / 380));
      ctx.fillStyle = shadeHex(v.base, -0.05);
      for (let i = 0; i < bareN; i++) {
        const px_ = left + 2 + hash2(bb.id * 71 + i, i, 840) * (w - 4);
        const py_ = top + 2 + hash2(bb.id * 73 + i, i, 841) * (h - 4);
        const len = 4 + hash2(bb.id, i, 842) * 10;
        ctx.globalAlpha = 0.25 + hash2(bb.id, i, 843) * 0.3;
        if (ridgeHoriz) ctx.fillRect(px_ - len / 2, py_, len, 1 + Math.round(hash2(bb.id, i, 844)));
        else ctx.fillRect(px_, py_ - len / 2, 1 + Math.round(hash2(bb.id, i, 844)), len);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      // bare material along the eaves (snow slides off the edge)
      ctx.fillStyle = shadeHex(v.base, -0.15);
      ctx.globalAlpha = 0.7;
      if (ridgeHoriz) { ctx.fillRect(left, top, w, 1.5); ctx.fillRect(left, top + h - 1.5, w, 1.5); }
      else { ctx.fillRect(left, top, 1.5, h); ctx.fillRect(left + w - 1.5, top, 1.5, h); }
      ctx.globalAlpha = 1;
    }

    // ridge: a 2px cap — lit highlight on the sun side, dark line on the shaded side
    ctx.fillStyle = snowy ? shadeHex(v.dark, -0.1) : shadeHex(v.dark, -0.3);
    if (ridgeHoriz) ctx.fillRect(left, top + ridgeAt, w, 1);
    else ctx.fillRect(left + ridgeAt, top, 1, h);
    ctx.fillStyle = snowy ? '#f6f8fa' : shadeHex(v.light, 0.35);
    if (ridgeHoriz) ctx.fillRect(left, top + ridgeAt - 1, w, 1);
    else ctx.fillRect(left + ridgeAt - 1, top, 1, h);

    // eaves: dark outline all round, a lit fascia on the N and W edges
    ctx.strokeStyle = shadeHex(v.dark, -0.35);
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    ctx.fillStyle = snowy ? 'rgba(255,255,255,0.35)' : 'rgba(255,240,210,0.22)';
    ctx.fillRect(left + 1, top + 1, w - 2, 1);
    ctx.fillRect(left + 1, top + 1, 1, h - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(left + 1, top + h - 2, w - 2, 1);
    ctx.fillRect(left + w - 2, top + 1, 1, h - 2);

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

/** Draws a 4px dark wall band (with a small 2px lighter window-gap patch at its middle when the
 * segment has a window/door) along one edge of a tile. `orient` is the long axis of the band. */
function drawWallBand(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  orient: 'h' | 'v', dark: string, hasWindow: boolean, light: string,
): void {
  ctx.fillStyle = dark;
  ctx.fillRect(x, y, w, h);
  if (!hasWindow) return;
  ctx.fillStyle = light;
  if (orient === 'h') ctx.fillRect(x + w / 2 - 3, y + h / 2 - 1, 6, 2);
  else ctx.fillRect(x + w / 2 - 1, y + h / 2 - 3, 2, 6);
}

/** Roof-off interior view for a friendly-occupied building (CC3: "roofs disappear when friendly
 * troops occupy"). Baked once per building id into an offscreen canvas sized to the building's
 * bbox (TILE_PX scale, local origin at bb.minX/minY) and cached, so drawOverlays only ever pays
 * one drawImage per occupied building each frame: a plank/flagstone floor, perimeter interior
 * walls with window gaps, a few furniture hints, and a soft inner shadow on the N/W walls. */
function paintInterior(map: GameMap, bb: BuildingBBox, fp: Footprint, seed: number): HTMLCanvasElement {
  const w = fp.w * TILE_PX, h = fp.h * TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const stone = bb.kind === 'stone';

  // Clip everything to the occupancy mask so an irregular footprint (notch/tower) never paints
  // interior floor onto ground that isn't actually part of the building.
  const clip = new Path2D();
  for (let ty = 0; ty < fp.h; ty++) {
    for (let tx = 0; tx < fp.w; tx++) {
      if (fp.occ[ty * fp.w + tx]) clip.rect(tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX);
    }
  }
  ctx.save();
  ctx.clip(clip);

  // floor: wood planks run along the long axis (4px bands across the short axis); stone gets a
  // 6px flagstone checker.
  if (stone) {
    const c1 = '#8b8880', c2 = '#7a7770';
    for (let gy = 0; gy < h; gy += 6) {
      for (let gx = 0; gx < w; gx += 6) {
        ctx.fillStyle = (((gx / 6) | 0) + ((gy / 6) | 0)) % 2 === 0 ? c1 : c2;
        ctx.fillRect(gx, gy, 6, 6);
      }
    }
  } else {
    const c1 = '#8a6a44', c2 = '#75593a';
    const longAxisHoriz = fp.w >= fp.h;
    if (longAxisHoriz) {
      for (let gy = 0; gy < h; gy += 4) { ctx.fillStyle = ((gy / 4) | 0) % 2 === 0 ? c1 : c2; ctx.fillRect(0, gy, w, 4); }
    } else {
      for (let gx = 0; gx < w; gx += 4) { ctx.fillStyle = ((gx / 4) | 0) % 2 === 0 ? c1 : c2; ctx.fillRect(gx, 0, 4, h); }
    }
  }

  // perimeter interior walls, with a window-gap patch where map.windows marks a door/window.
  const WALL_BAND = 4;
  const wallDark = stone ? '#4d4a44' : '#3c3128';
  const winLight = stone ? 'rgba(205,210,215,0.6)' : 'rgba(225,205,165,0.6)';
  for (let ty = 0; ty < fp.h; ty++) {
    for (let tx = 0; tx < fp.w; tx++) {
      if (!fp.occ[ty * fp.w + tx]) continue;
      const wx = bb.minX + tx, wy = bb.minY + ty;
      const i = idx(map, wx, wy);
      if (map.tiles[i] !== 'buildingWood' && map.tiles[i] !== 'buildingStone') continue;
      const hasWindow = map.windows[i] === 1;
      const ox = tx * TILE_PX, oy = ty * TILE_PX;
      const outer = (dx: number, dy: number) =>
        !inBounds(map, wx + dx, wy + dy) || map.buildingId[idx(map, wx + dx, wy + dy)] !== bb.id;
      if (outer(0, -1)) drawWallBand(ctx, ox, oy, TILE_PX, WALL_BAND, 'h', wallDark, hasWindow, winLight);
      if (outer(0, 1)) drawWallBand(ctx, ox, oy + TILE_PX - WALL_BAND, TILE_PX, WALL_BAND, 'h', wallDark, hasWindow, winLight);
      if (outer(-1, 0)) drawWallBand(ctx, ox, oy, WALL_BAND, TILE_PX, 'v', wallDark, hasWindow, winLight);
      if (outer(1, 0)) drawWallBand(ctx, ox + TILE_PX - WALL_BAND, oy, WALL_BAND, TILE_PX, 'v', wallDark, hasWindow, winLight);
    }
  }

  // a few furniture hints scattered on the floor
  const furnN = 2 + Math.floor(hash2(bb.id, 3, seed + 9101) * 2);
  for (let i = 0; i < furnN; i++) {
    const fx_ = 6 + hash2(bb.id * 13 + i, i, seed + 9102) * Math.max(1, w - 16);
    const fy_ = 6 + hash2(bb.id * 17 + i, i, seed + 9103) * Math.max(1, h - 14);
    ctx.fillStyle = 'rgba(20,16,12,0.55)';
    ctx.fillRect(fx_ + 1, fy_ + 1, 5, 4);
    ctx.fillStyle = '#2a241c';
    ctx.fillRect(fx_, fy_, 5, 4);
  }

  // subtle inner shadow along the N and W walls
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 0, w, 6);
  ctx.fillRect(0, 0, 6, h);

  ctx.restore();
  return canvas;
}

function paintEaveNotches(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const i = idx(map, wx, wy);
  if (!map.windows[i]) return;
  const bid = map.buildingId[i];
  const dirs: [number, number, 'l' | 'r' | 't' | 'b'][] = [[-1, 0, 'l'], [1, 0, 'r'], [0, -1, 't'], [0, 1, 'b']];
  // Round-5 fix #5: windows used to be cream blobs sitting on the roof edge and read as rivets.
  // A window seen from above is a DARK RECESS in the eave line with a thin lit sill/lintel on the
  // sunward side of it — three thin strips, never a filled pale square.
  const OPENING = 'rgba(14,12,10,0.86)';
  const SILL_LIT = 'rgba(214,198,158,0.55)';
  const SILL_DARK = 'rgba(40,34,26,0.7)';
  const HALF = Math.floor(TILE_PX / 2);
  for (const [dx, dy, side] of dirs) {
    const outer = !inBounds(map, wx + dx, wy + dy) || map.buildingId[idx(map, wx + dx, wy + dy)] !== bid;
    if (!outer) continue;
    const horiz = side === 't' || side === 'b';
    const len = Math.max(4, HALF - 2);        // the opening runs along the wall
    const a = horiz ? ox + (TILE_PX - len) / 2 : (side === 'l' ? ox : ox + TILE_PX - 3);
    const b = horiz ? (side === 't' ? oy : oy + TILE_PX - 3) : oy + (TILE_PX - len) / 2;
    ctx.fillStyle = OPENING;
    if (horiz) ctx.fillRect(a, b, len, 3); else ctx.fillRect(a, b, 3, len);
    // sill: lit on the N and W faces (the light comes from the NW), shaded on S and E
    ctx.fillStyle = side === 't' || side === 'l' ? SILL_LIT : SILL_DARK;
    if (side === 't') ctx.fillRect(a, b + 3, len, 1);
    else if (side === 'b') ctx.fillRect(a, b - 1, len, 1);
    else if (side === 'l') ctx.fillRect(a + 3, b, 1, len);
    else ctx.fillRect(a - 1, b, 1, len);
  }
}

// --------------------------------------------------------------------- trees
/** Size buckets (x zoom) that crown sprites are generated at; a crown of size s is drawn from
 * the smallest bucket >= s, so it is only ever downscaled by <=~25% (with smoothing), never
 * nearest-neighbour upscaled. */
const CROWN_SIZE_BUCKETS = [0.7, 0.95, 1.2, 1.45, 1.7];
/** Visual crown radius in world px at size 1 (sprite footprint is 28px). */
const CROWN_R = 11.5;
/** Canopy alpha: a touch translucent so the canopy mass never reads as a solid carpet. */
const CANOPY_ALPHA = 0.88;

function drawCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, shape: TreeShape, variant: number, season: Season, zoom: number, alpha = CANOPY_ALPHA): void {
  let b = CROWN_SIZE_BUCKETS[CROWN_SIZE_BUCKETS.length - 1];
  for (const s of CROWN_SIZE_BUCKETS) if (s >= size - 1e-6) { b = s; break; }
  const spr = getTreeSprite(variant, season, b * zoom, shape);
  const dw = TREE_SPRITE_WORLD_PX * size;
  ctx.globalAlpha = alpha;
  ctx.drawImage(spr, Math.round((cx - dw / 2) * zoom) / zoom, Math.round((cy - dw / 2) * zoom) / zoom, dw, dw);
  ctx.globalAlpha = 1;
}

/** Soft cast shadow for one crown: summer/autumn a SE-offset soft oval; winter a long cold
 * blue-grey streak running down-left across the snow (ref_cc3_1482). */
function drawCrownShadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, season: Season, zoom: number): void {
  const R = CROWN_R * size;
  if (season === 'winter') {
    const spr = getTreeShadowSprite(zoom, 'blue');
    const s = TREE_SPRITE_WORLD_PX * size * 0.75;
    ctx.save();
    ctx.translate(cx - s * 0.55, cy + s * 0.35);
    ctx.rotate(-0.6);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(spr, -s * 1.05, -s * 0.24, s * 2.1, s * 0.48);
    ctx.restore();
  } else {
    const spr = getTreeShadowSprite(zoom, 'dark');
    ctx.globalAlpha = season === 'summer' ? 0.72 : 0.6;
    ctx.drawImage(spr, cx + R * 0.45 - R * 1.2, cy + R * 0.6 - R * 1.0, R * 2.4, R * 2.0);
    ctx.globalAlpha = 1;
  }
}

/** Winter leafless scrub tree: a spiky brown starburst with a small dark centre. */
function paintScrubTree(ctx: CanvasRenderingContext2D, cx: number, cy: number, seed: number, size: number, stroke = '#5a4530', lineWidth = 1, ownShadow = true): void {
  if (ownShadow) {
    ctx.globalAlpha = 0.2;
    ctx.beginPath();
    ctx.ellipse(cx + 3, cy + 4, size * 0.5, size * 0.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  const n = 6 + Math.floor(hash2(Math.round(cx), Math.round(cy), seed) * 5);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
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

// ------------------------------------------------------------ winter tracks (trampled paths +
// vehicle ruts converging on buildings from roads and neighbouring houses, ref_cc3_1484)
interface WinterTrack { a: Vec2; c: Vec2; b: Vec2; ruts: boolean; minX: number; minY: number; maxX: number; maxY: number }

function computeWinterTracks(map: GameMap, bboxes: Map<number, BuildingBBox>, seed: number): WinterTrack[] {
  const tracks: WinterTrack[] = [];
  const isRoadT = (t: Terrain) => t === 'dirtroad' || t === 'pavedroad' || t === 'bridge';
  const edgePoint = (bb: BuildingBBox, tx: number, ty: number): Vec2 => {
    // point on the bbox boundary (world px) nearest the target (world px)
    const l = bb.minX * TILE_PX, r = (bb.maxX + 1) * TILE_PX, t = bb.minY * TILE_PX, btm = (bb.maxY + 1) * TILE_PX;
    const x = Math.min(r, Math.max(l, tx)), y = Math.min(btm, Math.max(t, ty));
    const dl = x - l, dr = r - x, dt = y - t, db = btm - y;
    const m = Math.min(dl, dr, dt, db);
    if (tx >= l && tx <= r && ty >= t && ty <= btm) return { x, y };
    if (m === dl && tx < l) return { x: l, y };
    if (m === dr && tx > r) return { x: r, y };
    if (m === dt && ty < t) return { x, y: t };
    return { x, y: ty < t ? t : ty > btm ? btm : y };
  };
  const push = (a: Vec2, b: Vec2, ruts: boolean, h: number) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 12) return;
    const off = (h - 0.5) * len * 0.5;
    const c = { x: (a.x + b.x) / 2 - (dy / len) * off, y: (a.y + b.y) / 2 + (dx / len) * off };
    const pad = 10;
    tracks.push({
      a, b, c, ruts,
      minX: Math.min(a.x, b.x, c.x) - pad, minY: Math.min(a.y, b.y, c.y) - pad,
      maxX: Math.max(a.x, b.x, c.x) + pad, maxY: Math.max(a.y, b.y, c.y) + pad,
    });
  };
  const list = [...bboxes.values()];
  for (const bb of list) {
    const bcx = ((bb.minX + bb.maxX + 1) / 2) * TILE_PX, bcy = ((bb.minY + bb.maxY + 1) / 2) * TILE_PX;
    // nearest road tile within 12 tiles of the footprint
    let best: Vec2 | null = null, bestD = Infinity;
    const R = 12;
    for (let ty = bb.minY - R; ty <= bb.maxY + R; ty++) {
      for (let tx = bb.minX - R; tx <= bb.maxX + R; tx++) {
        if (!inBounds(map, tx, ty) || !isRoadT(map.tiles[idx(map, tx, ty)])) continue;
        const ex = tx < bb.minX ? bb.minX - tx : tx > bb.maxX ? tx - bb.maxX : 0;
        const ey = ty < bb.minY ? bb.minY - ty : ty > bb.maxY ? ty - bb.maxY : 0;
        const d = ex * ex + ey * ey + hash2(tx, ty, seed + 7501) * 0.5;
        if (d < bestD) { bestD = d; best = { x: (tx + 0.5) * TILE_PX, y: (ty + 0.5) * TILE_PX }; }
      }
    }
    if (best && bestD > 1) {
      // two approaches from the road, slightly apart, converging on the house
      const a = edgePoint(bb, best.x, best.y);
      push(a, best, true, hash2(bb.id, 1, seed + 7502));
      const b2 = { x: best.x + (hash2(bb.id, 2, seed + 7503) - 0.5) * 90, y: best.y + (hash2(bb.id, 3, seed + 7503) - 0.5) * 90 };
      if (inBounds(map, Math.floor(b2.x / TILE_PX), Math.floor(b2.y / TILE_PX))) push(edgePoint(bb, b2.x, b2.y), b2, hash2(bb.id, 4, seed + 7504) < 0.5, hash2(bb.id, 5, seed + 7502));
    }
    // a footpath to the nearest neighbouring building (each pair once)
    let nb: BuildingBBox | null = null, nd = Infinity;
    for (const o of list) {
      if (o.id === bb.id) continue;
      const ocx = ((o.minX + o.maxX + 1) / 2) * TILE_PX, ocy = ((o.minY + o.maxY + 1) / 2) * TILE_PX;
      const d = Math.hypot(ocx - bcx, ocy - bcy);
      if (d < nd) { nd = d; nb = o; }
    }
    if (nb && nb.id > bb.id && nd < 18 * TILE_PX) {
      const ocx = ((nb.minX + nb.maxX + 1) / 2) * TILE_PX, ocy = ((nb.minY + nb.maxY + 1) / 2) * TILE_PX;
      push(edgePoint(bb, ocx, ocy), edgePoint(nb, bcx, bcy), false, hash2(bb.id, nb.id, seed + 7505));
    }
  }
  return tracks;
}

function paintWinterTracks(ctx: CanvasRenderingContext2D, tracks: WinterTrack[], x0: number, y0: number, seed: number): void {
  const wx0 = x0 * TILE_PX, wy0 = y0 * TILE_PX;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    if (tr.maxX < wx0 || tr.minX > wx0 + CHUNK_PX || tr.maxY < wy0 || tr.minY > wy0 + CHUNK_PX) continue;
    const ax = tr.a.x - wx0, ay = tr.a.y - wy0, cx = tr.c.x - wx0, cy = tr.c.y - wy0, bx = tr.b.x - wx0, by = tr.b.y - wy0;
    const curve = (o: number) => {
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * o, ny = dx / len * o;
      ctx.beginPath();
      ctx.moveTo(ax + nx, ay + ny);
      ctx.quadraticCurveTo(cx + nx, cy + ny, bx + nx, by + ny);
      ctx.stroke();
    };
    // trampled, greyer band of broken snow
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(120,126,138,0.14)';
    ctx.lineWidth = tr.ruts ? 9 : 5;
    curve(0);
    ctx.strokeStyle = 'rgba(150,156,168,0.12)';
    ctx.lineWidth = tr.ruts ? 5 : 3;
    curve(0);
    // paired ruts (vehicles/sleds) or a single broken foot track, dark earth showing through
    const h = hash2(i, 7, seed + 7510);
    ctx.setLineDash([7 + h * 6, 2 + h * 2, 4, 1.5]);
    ctx.strokeStyle = 'rgba(92,72,52,0.78)';
    ctx.lineWidth = 1.25;
    if (tr.ruts) { curve(-2.2); curve(2.2); } else { ctx.strokeStyle = 'rgba(104,90,74,0.45)'; curve(0); }
  }
  ctx.setLineDash([]);
  ctx.restore();
}

// ------------------------------------------------------------ dense woods (blue-noise crowns)
interface WoodCand { x: number; y: number; size: number; shape: TreeShape; variant: number; pri: number; scrub: boolean }

/** Candidate cell size (world px) and minimum-spacing factor (x sum of crown radii). Winter
 * woods are individual trees with snow between them, summer woods a closed but irregular canopy
 * with floor gaps. */
function woodsParams(season: Season): { cell: number; k: number } {
  return season === 'winter' ? { cell: 16, k: 0.8 } : { cell: 10, k: 0.52 };
}

/** One jittered crown candidate per world cell — a pure function of (cell, seed), so every chunk
 * that sees a cell derives the identical tree (seam-free across chunk bakes). */
function woodsCandidate(map: GameMap, ci: number, cj: number, cell: number, seed: number, season: Season): WoodCand | null {
  if (ci < 0 || cj < 0) return null;
  const x = (ci + 0.1 + 0.8 * hash2(ci, cj, seed + 1201)) * cell;
  const y = (cj + 0.1 + 0.8 * hash2(ci, cj, seed + 1202)) * cell;
  const tx = Math.floor(x / TILE_PX), ty = Math.floor(y / TILE_PX);
  if (!inBounds(map, tx, ty) || map.tiles[idx(map, tx, ty)] !== 'woods') return null;
  // ragged canopy edge against the smoothed woody field
  if (coverageAt(map, isWoody, x / TILE_PX - 0.5, y / TILE_PX - 0.5, seed + 8801) < 0.5) return null;
  const winter = season === 'winter';
  // low-frequency clearings so the forest floor shows through in irregular glades
  const clr = fbm(x / 72, y / 72, 2, seed + 1207);
  if (clr < (winter ? 0.3 : 0.27)) return null;
  if (hash2(ci, cj, seed + 1204) < (winter ? 0.06 : 0.03)) return null;
  let size = (winter ? 0.95 : 0.7) + (winter ? 0.55 : 0.8) * hash2(ci, cj, seed + 1205);
  const hs = hash2(ci, cj, seed + 1206);
  let shape: TreeShape;
  let scrub = false;
  if (winter) {
    if (hs < 0.76) shape = 'bare';
    else if (hs < 0.92) { shape = 'conifer'; size *= 0.8; }
    else { shape = 'bare'; scrub = true; }
  } else {
    shape = hs < 0.36 ? 'round' : hs < 0.68 ? 'lobed' : hs < 0.86 ? 'elongated' : 'conifer';
    if (shape === 'conifer') size = Math.max(0.6, size * 0.78);
  }
  return {
    x, y, size, shape, scrub,
    variant: Math.floor(hash2(ci, cj, seed + 1208) * TREE_VARIANTS),
    pri: hash2(ci, cj, seed + 1209),
  };
}

/** Dense-woods crowns for one chunk (plus padding so crowns/shadows straddling the edge are drawn
 * identically on both sides). Poisson-disc style thinning: a candidate is dropped if any
 * higher-priority candidate within k*(Ri+Rj) exists, giving irregular overlap and floor gaps
 * instead of a regular carpet. All shadows go down before any crown. */
function paintWoodsChunk(ctx: CanvasRenderingContext2D, map: GameMap, x0: number, y0: number, season: Season, seed: number, zoom: number): void {
  const { cell, k } = woodsParams(season);
  const PAD = 48;
  const reach = Math.ceil((k * 2 * CROWN_R * 1.5) / cell);
  const wx0 = x0 * TILE_PX, wy0 = y0 * TILE_PX;
  const ci0 = Math.floor((wx0 - PAD) / cell) - reach, cj0 = Math.floor((wy0 - PAD) / cell) - reach;
  const ci1 = Math.floor((wx0 + CHUNK_PX + PAD) / cell) + reach, cj1 = Math.floor((wy0 + CHUNK_PX + PAD) / cell) + reach;
  // quick reject: no woods tile anywhere in the padded window
  let anyWoods = false;
  const tx0 = Math.max(0, Math.floor((wx0 - PAD) / TILE_PX) - 1), tx1 = Math.min(map.width - 1, Math.floor((wx0 + CHUNK_PX + PAD) / TILE_PX) + 1);
  const ty0 = Math.max(0, Math.floor((wy0 - PAD) / TILE_PX) - 1), ty1 = Math.min(map.height - 1, Math.floor((wy0 + CHUNK_PX + PAD) / TILE_PX) + 1);
  for (let ty = ty0; ty <= ty1 && !anyWoods; ty++) for (let tx = tx0; tx <= tx1; tx++) if (map.tiles[idx(map, tx, ty)] === 'woods') { anyWoods = true; break; }
  if (!anyWoods) return;

  const gw = ci1 - ci0 + 1, gh = cj1 - cj0 + 1;
  const cands: (WoodCand | null)[] = new Array(gw * gh);
  for (let gj = 0; gj < gh; gj++) for (let gi = 0; gi < gw; gi++) cands[gj * gw + gi] = woodsCandidate(map, ci0 + gi, cj0 + gj, cell, seed, season);

  const accepted: WoodCand[] = [];
  for (let gj = reach; gj < gh - reach; gj++) {
    for (let gi = reach; gi < gw - reach; gi++) {
      const c = cands[gj * gw + gi];
      if (!c) continue;
      if (c.x < wx0 - PAD || c.x > wx0 + CHUNK_PX + PAD || c.y < wy0 - PAD || c.y > wy0 + CHUNK_PX + PAD) continue;
      const ri = CROWN_R * c.size;
      let ok = true;
      for (let dj = -reach; dj <= reach && ok; dj++) {
        for (let di = -reach; di <= reach; di++) {
          if (!di && !dj) continue;
          const o = cands[(gj + dj) * gw + gi + di];
          if (!o || o.pri <= c.pri) continue;
          const md = k * (ri + CROWN_R * o.size);
          const dx = o.x - c.x, dy = o.y - c.y;
          if (dx * dx + dy * dy < md * md) { ok = false; break; }
        }
      }
      if (ok) accepted.push(c);
    }
  }
  if (!accepted.length) return;
  // small trees underneath, big ones on top; ties by position (deterministic across chunks)
  accepted.sort((a, b) => a.size - b.size || a.y - b.y || a.x - b.x);
  const lx = (c: WoodCand) => c.x - wx0, ly = (c: WoodCand) => c.y - wy0;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const c of accepted) drawCrownShadow(ctx, lx(c), ly(c), c.size, season, zoom);
  for (const c of accepted) {
    if (c.scrub) {
      ctx.imageSmoothingEnabled = false;
      paintScrubTree(ctx, lx(c), ly(c), seed + 131, 16 + c.size * 8, '#4a3626', 1.3, false);
      ctx.imageSmoothingEnabled = true;
    } else {
      drawCrown(ctx, lx(c), ly(c), c.size, c.shape, c.variant, season, zoom, c.shape === 'bare' ? 1 : CANOPY_ALPHA);
    }
  }
  ctx.imageSmoothingEnabled = false;
}

/** Per-tile trees outside dense woods ('scatteredtrees' fringes, tree lines, orchards). Dense
 * 'woods' tiles are handled chunk-wide by paintWoodsChunk. */
function paintTrees(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number, zoom: number): void {
  const t = tileAt(map, wx, wy);
  if (t !== 'scatteredtrees') return;
  // round-3 fix #3: summer scatteredtrees canopy density raised to 0.72 per tile.
  if (hash2(wx, wy, seed + 111) >= 0.72) return;
  const jxT = (hash2(wx * 19, wy * 19, seed + 113) - 0.5) * 0.4;
  const jyT = (hash2(wx * 23, wy * 23, seed + 117) - 0.5) * 0.4;
  if (coverageAt(map, isWoody, wx + 0.5 + jxT, wy + 0.5 + jyT, seed + 8802) < 0.5) return;
  const cx = ox + (0.5 + jxT) * TILE_PX, cy = oy + (0.5 + jyT) * TILE_PX;
  const hScale = hash2(wx * 31, wy * 31, seed + 123);
  const variant = Math.floor(hash2(wx * 29, wy * 29, seed + 119) * TREE_VARIANTS);
  const shapeRoll = hash2(wx * 37, wy * 37, seed + 127);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (season === 'winter') {
    if (shapeRoll < 0.45) {
      ctx.imageSmoothingEnabled = false;
      paintScrubTree(ctx, cx, cy, seed + 123, 12 + hScale * 10);
    } else {
      const size = 0.65 + hScale * 0.45;
      drawCrownShadow(ctx, cx, cy, size, season, zoom);
      drawCrown(ctx, cx, cy, size, shapeRoll < 0.85 ? 'bare' : 'conifer', variant, season, zoom, 1);
    }
  } else {
    const size = season === 'summer' ? 1.0 + 0.6 * hScale : 0.85 + hScale * 0.45;
    const shape: TreeShape = shapeRoll < 0.5 ? 'round' : shapeRoll < 0.85 ? 'lobed' : 'elongated';
    drawCrownShadow(ctx, cx, cy, size, season, zoom);
    drawCrown(ctx, cx, cy, size, shape, variant, season, zoom, 0.94);
  }
  ctx.imageSmoothingEnabled = false;
}


/** Tiles whose terrain is in `vectorLineTerrains` are rendered by `paintLineVector` as one
 * smooth stroked path per chunk instead — skip the blocky per-tile band for those here. */
function paintDetail(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number, vectorLineTerrains: Set<Terrain>): void {
  const t = tileAt(map, wx, wy);
  switch (t) {
    case 'mud': paintMud(ctx, wx, wy, ox, oy, seed); break;
    case 'rubble': paintRubbleDebris(ctx, wx, wy, ox, oy, seed, season); break;
    case 'crater': break; // drawn by the earthwork pass (craterArt) in bakeChunk
    case 'trench': break; // likewise: trench vectors, foxholes, or an auto-foxhole per stray tile
    case 'hedge': if (!vectorLineTerrains.has('hedge')) paintHedge(ctx, map, wx, wy, ox, oy, seed, season); break;
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

function paintLineVector(ctx: CanvasRenderingContext2D, v: MapVectorFeature, x0: number, y0: number, seed: number, season: Season): void {
  const pts = v.points;
  if (pts.length < 2) return;
  if (v.terrain === 'hedge') {
    // a slim (6px) bumpy line, not a flat wide bar: a plain core stroke, a 1px shadow line
    // offset to the SE, and lobed lighter blobs every ~6px on the NW side for a leafy silhouette.
    // Winter: leafless brown scrub with snow flecks instead of summer green.
    const winter = season === 'winter';
    strokePolylineWorld(ctx, pts, x0, y0, 6, winter ? HEDGE_WINTER.core : HEDGE_SUMMER.core);
    ctx.strokeStyle = winter ? HEDGE_WINTER.shadow : HEDGE_SUMMER.shadow;
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
    walkPolylineWorld(pts, 6, (wx, wy, ux, uy) => {
      let px_ = -uy, py_ = ux;
      if (px_ + py_ > 0) { px_ = -px_; py_ = -py_; } // NW-ish perpendicular
      const lx = wx - x0 * TILE_PX + px_ * 2.2, ly = wy - y0 * TILE_PX + py_ * 2.2;
      const r = 1.6 + hash2(Math.round(wx), Math.round(wy), seed + 881) * 1.2;
      ctx.fillStyle = winter ? HEDGE_WINTER.lobe : HEDGE_SUMMER.lobe;
      ctx.beginPath();
      ctx.ellipse(lx, ly, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      if (winter) {
        ctx.fillStyle = HEDGE_WINTER.snow;
        ctx.fillRect(Math.round(lx - r * 0.6), Math.round(ly - r * 0.6), 1, 1);
      }
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
    // drawn as a shaded, crenellated earthwork by craterArt.paintTrenches (see bakeChunk)
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
  /** Per-zoom insertion-ordered LRU caches (oldest-used key first), keyed by chunkKey. */
  private chunksByZoom = new Map<number, Map<string, ChunkEntry>>();
  /** Map-placed (old) craters, trench centrelines and foxholes, in zoom-1 world px. */
  private oldCraters: (CraterDraw & { r: number })[] = [];
  private trenches: TrenchDraw[] = [];
  private foxholes: FoxholeDraw[] = [];
  /** Tile indexes that were already 'crater' when the map was built — the rest came from battle
   * explosions (and are drawn from map.craterMarks instead). */
  private mapCraterTiles = new Set<number>();
  /** Most-recently-used key per zoom, so draw() can skip the delete+set re-insert for it. */
  private mruKey = new Map<number, string>();
  private buildingBBoxes = new Map<number, BuildingBBox>();
  /** Roof-off interior canvases, cached per building id the first time it's occupied by a
   * friendly soldier (see drawOverlays) — building geometry never changes mid-battle so one
   * bake per id is enough for the whole battle. */
  private interiorCache = new Map<number, HTMLCanvasElement>();
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
  private winterTracks: WinterTrack[] | null = null;
  /** terrain as built — lets the bake tell a flattened hedge/fence or breached wall (whose vector
   * line must be cut there) from ground that was always open */
  private origTiles: Terrain[];

  constructor(map: GameMap) {
    this.map = map;
    this.seed = hashStr(map.def.id) ^ (map.width * 73856093) ^ (map.height * 19349663);
    this.chunksX = Math.max(1, Math.ceil(map.width / CHUNK_TILES));
    this.chunksY = Math.max(1, Math.ceil(map.height / CHUNK_TILES));
    this.fieldId = new Int32Array(map.width * map.height).fill(-1);
    const angleRoll = hash2(0, 0, this.seed + 909);
    // 0 or 90 only — a 45 degree roll produced a diagonal chevron barcode at zoom 2.
    this.fieldBaseAngleDeg = angleRoll < 0.5 ? 0 : 90;
    this.origTiles = map.tiles.slice();
    this.computeBuildingBBoxes();
    for (const bb of this.buildingBBoxes.values()) {
      const fp = analyzeFootprint(map, bb);
      bb.origBig = fp.hole !== null || (bb.maxX - bb.minX + 1 > 12 && bb.maxY - bb.minY + 1 > 12);
    }
    this.computeFields();
    this.groundUnder = this.computeGroundUnder();
    if (map.def.vectors) {
      for (const v of map.def.vectors) if (v.kind === 'line') this.vectorLineTerrains.add(v.terrain);
    }
    this.computeEarthworks();
  }

  /** Collects every map-placed earthwork: crater-tile clusters (one crater per isolated tile, a
   * few overlapping ones per cluster), 'shellhole' decor, trench line vectors (crenellated), and
   * 'foxhole' decor plus an auto-foxhole for any trench tile no trench line or foxhole covers. */
  private computeEarthworks(): void {
    const map = this.map;
    const w = map.width, h = map.height;
    const runtime = new Set(map.craters);
    const zones = map.def.deployZones;
    const az = zones[map.def.attacker];
    const toward = { x: (az.x + az.w / 2) * TILE_PX, y: (az.y + az.h / 2) * TILE_PX };
    const seen = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (map.tiles[i] !== 'crater' || runtime.has(i) || seen[i]) continue;
      const comp: number[] = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        comp.push(c);
        const cx = c % w, cy = (c / w) | 0;
        const nb = [cx > 0 ? c - 1 : -1, cx < w - 1 ? c + 1 : -1, cy > 0 ? c - w : -1, cy < h - 1 ? c + w : -1];
        for (const q of nb) if (q >= 0 && !seen[q] && map.tiles[q] === 'crater' && !runtime.has(q)) { seen[q] = 1; stack.push(q); }
      }
      for (const c of comp) this.mapCraterTiles.add(c);
      const count = comp.length === 1 ? 1 : Math.min(4, Math.max(2, Math.round(comp.length / 7)));
      const order = comp.slice().sort((a, b) => hash2(a, 1, this.seed + 7101) - hash2(b, 1, this.seed + 7101));
      for (let k = 0; k < count; k++) {
        const c = order[k];
        const seed = (this.seed + c * 31 + k) | 0;
        const x = ((c % w) + 0.5 + (hash2(c, 2, this.seed + 7102) - 0.5) * 0.5) * TILE_PX;
        const y = (((c / w) | 0) + 0.5 + (hash2(c, 3, this.seed + 7103) - 0.5) * 0.5) * TILE_PX;
        const diameterM = comp.length === 1 ? oldCraterDiameter(seed, 2.4, 3.6) : oldCraterDiameter(seed, 2.8, 4.8);
        this.addOldCrater({ x, y, diameterM, kind: 'shell', old: true, seed });
      }
    }
    const foxTiles = new Set<number>();
    for (const d of map.def.decor ?? []) {
      if (d.kind === 'shellhole') {
        // craterLine drops a shellhole beside the crater tile it marks — the same shell hole, so
        // don't paint a second overlapping crater next to it
        let dup = false;
        for (let yy = Math.floor(d.y) - 2; yy <= Math.floor(d.y) + 2 && !dup; yy++) {
          for (let xx = Math.floor(d.x) - 2; xx <= Math.floor(d.x) + 2; xx++) {
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && this.mapCraterTiles.has(yy * w + xx)) { dup = true; break; }
          }
        }
        if (dup) continue;
        const seed = (this.seed + Math.round(d.x * 977) + Math.round(d.y * 131)) | 0;
        const v = d.variant ?? 0;
        this.addOldCrater({ x: d.x * TILE_PX, y: d.y * TILE_PX, diameterM: 1.3 + (v % 3) * 0.45 + hash2(v, 5, seed) * 0.4, kind: 'shell', old: true, seed });
      } else if (d.kind === 'foxhole') {
        const x = d.x * TILE_PX, y = d.y * TILE_PX;
        const v = d.variant ?? 0;
        const angle = d.angle ?? Math.atan2(toward.y - y, toward.x - x);
        this.foxholes.push({ x, y, angle, variant: (v >> 1) % 3, men: v & 1 ? 2 : 1, seed: (this.seed + Math.round(x * 13) + Math.round(y * 7)) | 0 });
        foxTiles.add(Math.floor(d.y) * w + Math.floor(d.x));
      }
    }
    const trenchLines: Vec2[][] = [];
    let ti = 0;
    for (const v of map.def.vectors ?? []) {
      if (v.kind !== 'line' || v.terrain !== 'trench' || v.points.length < 2) continue;
      trenchLines.push(v.points);
      this.trenches.push(buildTrenchDraw(v.points, TILE_PX, toward, (this.seed + 9311 * ++ti) | 0));
    }
    // stray trench tiles (e.g. a dug-in rect) that no line or foxhole explains: a foxhole each
    for (let i = 0; i < w * h; i++) {
      if (map.tiles[i] !== 'trench' || foxTiles.has(i)) continue;
      const tx = i % w + 0.5, ty = ((i / w) | 0) + 0.5;
      let near = false;
      for (const pts of trenchLines) {
        for (let s = 0; s < pts.length - 1 && !near; s++) {
          const a = pts[s], b = pts[s + 1];
          const abx = b.x - a.x, aby = b.y - a.y;
          const L2 = abx * abx + aby * aby || 1;
          const t = Math.max(0, Math.min(1, ((tx - a.x) * abx + (ty - a.y) * aby) / L2));
          if (Math.hypot(tx - a.x - abx * t, ty - a.y - aby * t) < 1.25) near = true;
        }
        if (near) break;
      }
      if (near) continue;
      const x = tx * TILE_PX, y = ty * TILE_PX;
      const seed = (this.seed + i * 17) | 0;
      this.foxholes.push({ x, y, angle: Math.atan2(toward.y - y, toward.x - x), variant: Math.floor(hash2(i, 9, this.seed + 7104) * 3), men: hash2(i, 10, this.seed + 7105) < 0.5 ? 1 : 2, seed });
    }
  }

  private addOldCrater(c: CraterDraw): void {
    // never on/against water, bridges or buildings (a shell hole's bowl would paint over them)
    const map = this.map;
    const R = Math.ceil(c.diameterM / 2 / 2);
    const tx = Math.floor(c.x / TILE_PX), ty = Math.floor(c.y / TILE_PX);
    for (let yy = ty - R; yy <= ty + R; yy++) {
      for (let xx = tx - R; xx <= tx + R; xx++) {
        const t = tileAt(map, xx, yy);
        if (t === 'water' || t === 'bridge' || t === 'buildingWood' || t === 'buildingStone' || t === 'floor') return;
      }
    }
    this.oldCraters.push({ ...c, r: craterExtentPx(c) });
  }

  /** Draws every earthwork touching the chunk whose zoom-1 world px origin is (ox, oy). Craters
   * first (under trenches), then trenches, foxholes, and this battle's fresh blast marks. */
  private paintEarthworks(ctx: CanvasRenderingContext2D, ox: number, oy: number, zoom: number, marksUpTo: number): void {
    const season = this.map.def.season;
    const span = CHUNK_PX;
    for (const c of this.oldCraters) {
      if (c.x + c.r < ox || c.x - c.r > ox + span || c.y + c.r < oy || c.y - c.r > oy + span) continue;
      paintCrater(ctx, c, season, ox, oy, zoom);
    }
    paintTrenches(ctx, this.trenches, season, ox, oy, zoom);
    const fr = foxholeExtentPx();
    for (const f of this.foxholes) {
      if (f.x + fr < ox || f.x - fr > ox + span || f.y + fr < oy || f.y - fr > oy + span) continue;
      paintFoxhole(ctx, f, season, ox, oy, zoom);
    }
    const marks = this.map.craterMarks;
    if (marks) for (let k = 0; k < marksUpTo && k < marks.length; k++) this.paintMark(ctx, k, ox, oy, zoom);
  }

  private markDraw(k: number): CraterDraw {
    const m = this.map.craterMarks![k];
    return { x: m.x * TILE_PX, y: m.y * TILE_PX, diameterM: m.sizeM, kind: m.kind, old: false, seed: (this.seed + k * 7919 + Math.round(m.x * 101)) | 0 };
  }

  private paintMark(ctx: CanvasRenderingContext2D, k: number, ox: number, oy: number, zoom: number): void {
    const c = this.markDraw(k);
    const r = craterExtentPx(c);
    if (c.x + r < ox || c.x - r > ox + CHUNK_PX || c.y + r < oy || c.y - r > oy + CHUNK_PX) return;
    paintCrater(ctx, c, this.map.def.season, ox, oy, zoom);
  }

  /** Stamps blast marks added since the last frame straight into every cached chunk they touch
   * (at every zoom), so a fresh crater appears immediately without re-baking the chunk. Chunks
   * baked later include all marks up to their bake time (ChunkEntry.marks) — never both. */
  private stampNewMarks(): void {
    const marks = this.map.craterMarks;
    if (!marks || !marks.length) return;
    for (const [zoom, m] of this.chunksByZoom) {
      for (const e of m.values()) {
        if (e.marks >= marks.length) continue;
        const ox = e.cx * CHUNK_PX, oy = e.cy * CHUNK_PX;
        const ctx = e.canvas.getContext('2d')!;
        for (let k = e.marks; k < marks.length; k++) this.paintMark(ctx, k, ox, oy, zoom);
        e.marks = marks.length;
      }
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

  private zoomCache(zoom: number): Map<string, ChunkEntry> {
    let m = this.chunksByZoom.get(zoom);
    if (!m) { m = new Map(); this.chunksByZoom.set(zoom, m); }
    return m;
  }

  invalidateTile(x: number, y: number): void {
    const cx = Math.floor(x / CHUNK_TILES);
    const cy = Math.floor(y / CHUNK_TILES);
    // a tile edit invalidates the bake at every zoom level it might be cached at.
    const key = this.chunkKey(cx, cy);
    for (const m of this.chunksByZoom.values()) m.delete(key);
    this.updateLowResTile(x, y);
  }

  /** Move `key` to the most-recently-used end of its zoom's LRU. */
  private touchChunk(zoom: number, key: string): void {
    if (this.mruKey.get(zoom) === key) return;
    const m = this.zoomCache(zoom);
    const e = m.get(key);
    if (!e) return;
    m.delete(key);
    m.set(key, e);
    this.mruKey.set(zoom, key);
  }

  /** Inserts a fresh bake and evicts this zoom's oldest entries past its cap, never evicting a
   * chunk inside the currently visible chunk rectangle. */
  private insertChunk(zoom: number, cx: number, cy: number, canvas: HTMLCanvasElement,
    vis: { x0: number; y0: number; x1: number; y1: number }): void {
    const m = this.zoomCache(zoom);
    const key = this.chunkKey(cx, cy);
    m.delete(key);
    m.set(key, { canvas, cx, cy, marks: this.map.craterMarks?.length ?? 0 });
    this.mruKey.set(zoom, key);
    const cap = MAX_CACHED_CHUNKS_BY_ZOOM[zoom] ?? 32;
    if (m.size <= cap) return;
    for (const [k, e] of m) {
      if (m.size <= cap) break;
      if (e.cx >= vis.x0 && e.cx <= vis.x1 && e.cy >= vis.y0 && e.cy <= vis.y1) continue;
      m.delete(k);
    }
  }

  /** Bakes chunk (cx,cy) at the given zoom level: the ImageData ground/coverage pass runs at
   * `bpt` (TILE_PX*zoom, rounded) pixels-per-tile — the true output resolution — with every
   * noise/hash sample expressed in zoom-1 world-pixel units (px/zoom) so per-pixel grain,
   * feathered edges, ruts and rows are computed fresh at that resolution instead of being
   * baked once at zoom 1 and blockily upscaled. The remaining canvas-op passes (walls, roofs,
   * trees, decor) are unchanged code, just run under a ctx.scale(zoom,zoom) so line widths and
   * drawImage calls scale automatically. Tree crowns are the exception: they are generated at
   * zoom x size-bucket resolution (getTreeSprite scale) and drawn with smoothing on. */
  private bakeChunk(cx: number, cy: number, zoom: number): HTMLCanvasElement {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const bpt = Math.round(TILE_PX * zoom);
    const chunkPx = CHUNK_TILES * bpt;
    const canvas = document.createElement('canvas');
    canvas.width = chunkPx;
    canvas.height = chunkPx;
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
    // crops use a smaller blur than mud/tallgrass so the field edge stays firm and ragged
    const cropsGrid = buildGrid(map, x0, y0, CHUNK_TILES, isCrops, 1);
    const mudGrid = buildGrid(map, x0, y0, CHUNK_TILES, isMud, AREA_BLUR);
    const tallgrassGrid = buildGrid(map, x0, y0, CHUNK_TILES, isTallgrass, AREA_BLUR);
    const pavedGrid = buildGrid(map, x0, y0, CHUNK_TILES, isPaved);
    const dirtGrid = buildGrid(map, x0, y0, CHUNK_TILES, isDirtRoad);
    const waterGrid = buildGrid(map, x0, y0, CHUNK_TILES, isWater);
    // rubble spreads only ~1 tile past its footprint (not the wider AREA_BLUR used for
    // crops/mud/tallgrass), so debris reads as a collapsed building, not a blanket stain.
    const rubbleGrid = buildGrid(map, x0, y0, CHUNK_TILES, isRubble, 1);
    // blurred so the dirty-snow shoulder doesn't show tile stair-steps along road edges
    const dirtyGrid = season === 'winter' ? buildGrid(map, x0, y0, CHUNK_TILES, isDirtySource, 1) : cropsGrid;
    const gu = this.groundUnder, mw = map.width, mh = map.height;
    const woodsGrid = buildGrid(map, x0, y0, CHUNK_TILES, isWoodsTile, 1);
    const leeGrid = season === 'winter' ? buildGrid(map, x0, y0, CHUNK_TILES, isLeeSource, 1) : EMPTY_GRID;
    const trampleGrid = season === 'winter' ? buildGrid(map, x0, y0, CHUNK_TILES, isTrampleSource, 3) : EMPTY_GRID;
    const openGrid = buildGrid(map, x0, y0, CHUNK_TILES, isOpenGround, 1, (tx, ty) => {
      const cx2 = tx < 0 ? 0 : tx >= mw ? mw - 1 : tx;
      const cy2 = ty < 0 ? 0 : ty >= mh ? mh - 1 : ty;
      return gu[cy2 * mw + cx2];
    });

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

    // ------------------------------------------------------------ ground+features pass (baked
    // at true output resolution — bpt px/tile — not zoom-1 and upscaled)
    const img = ctx.createImageData(chunkPx, chunkPx);
    reliefCache = new Map<number, number>();
    reliefGround = map.ground ?? null; reliefW = map.width; reliefH = map.height;
    paintGroundAndFeatures(
      img.data, chunkPx, map, season, this.seed, x0, y0, CHUNK_TILES, CHUNK_TILES,
      this.groundUnder, map.width, map.height, this.fieldId, this.fieldAxis,
      cropsGrid, mudGrid, tallgrassGrid, pavedGrid, dirtGrid, waterGrid, rubbleGrid, dirtyGrid, openGrid,
      pavedVec, dirtVec, waterVec, tramRailY, zoom, bpt,
      woodsGrid, leeGrid, trampleGrid,
    );
    reliefCache = null;
    reliefGround = null;
    ctx.putImageData(img, 0, 0);

    // Everything below draws with plain canvas ops in TILE_PX-unit coordinates (unchanged from
    // the zoom-1 code); scaling the context — rather than the coordinates — means line widths,
    // strokes and drawImage calls all scale by `zoom` for free, with real per-scale
    // antialiasing on vector ops instead of a blocky post-hoc upscale (sprites keep nearest-
    // neighbour scaling since imageSmoothingEnabled is off).
    ctx.save();
    ctx.scale(zoom, zoom);

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

    // ------------------------------------------------------------ earthworks: craters, trenches,
    // foxholes, blast marks (per-pixel height-field shading at true output resolution; each
    // feature is culled against the chunk and drawn whole, so seams match between chunks)
    this.paintEarthworks(ctx, x0 * TILE_PX, y0 * TILE_PX, zoom, map.craterMarks?.length ?? 0);

    // ------------------------------------------------------------ smooth vector line features
    // (hedge/fence/stonewall/trench) drawn once per chunk as a stroked path, replacing the
    // per-tile bands skipped above for terrains that have vector geometry on this map.
    if (map.def.vectors && this.vectorLineTerrains.size) {
      // cut the stroked lines out of tiles whose hedge/fence/wall was flattened or breached
      const broken = this.brokenLineTiles(x0, y0);
      if (broken.length) {
        const clip = new Path2D();
        clip.rect(-2 * TILE_PX, -2 * TILE_PX, (CHUNK_TILES + 4) * TILE_PX, (CHUNK_TILES + 4) * TILE_PX);
        for (const bi of broken) clip.rect((bi % map.width - x0) * TILE_PX, (((bi / map.width) | 0) - y0) * TILE_PX, TILE_PX, TILE_PX);
        ctx.save();
        ctx.clip(clip, 'evenodd');
      }
      for (const v of map.def.vectors) {
        if (v.kind !== 'line') continue;
        paintLineVector(ctx, v, x0, y0, this.seed, season);
      }
      if (broken.length) ctx.restore();
    }
    this.paintStructureDamage(ctx, x0, y0, season);

    if (season === 'winter') {
      if (!this.winterTracks) this.winterTracks = computeWinterTracks(map, this.buildingBBoxes, this.seed);
      paintWinterTracks(ctx, this.winterTracks, x0, y0, this.seed);
    }

    // ------------------------------------------------------------ buildings
    // all cast shadows first so a neighbour's shadow never lands on top of a roof
    for (const bb of this.buildingBBoxes.values()) {
      if (bb.maxX < x0 - 1 || bb.minX >= x0 + CHUNK_TILES || bb.maxY < y0 - 1 || bb.minY >= y0 + CHUNK_TILES) continue;
      paintBuildingShadow(ctx, map, bb, x0, y0, this.seed, season);
    }
    for (const bb of this.buildingBBoxes.values()) {
      // The wall band + cast shadow drawn on the S/E sides protrude up to ~1 tile past the
      // building's own footprint, so a chunk immediately past that edge still needs a (clipped)
      // draw call to pick up that protruding sliver — widen the overlap test by 1 tile on the
      // max side accordingly.
      if (bb.maxX < x0 - 1 || bb.minX >= x0 + CHUNK_TILES || bb.maxY < y0 - 1 || bb.minY >= y0 + CHUNK_TILES) continue;
      paintRoof(ctx, map, bb, x0, y0, this.seed, season, zoom);
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
    this.paintCavedRoofEdges(ctx, x0, y0);

    // ------------------------------------------------------------ trees/bushes
    // Padded by 1 tile on every side (matching drawDecor's padding, and buildings' widened
    // overlap test above): a tree's jittered canopy/shadow can extend up to ~1 tile from its
    // owning tile, and each tile is only ever "owned" by one chunk for tree purposes, so without
    // this padding a canopy straddling a chunk boundary was drawn (and clipped by the canvas
    // edge) in its owning chunk only — never redrawn in the neighbour, leaving a hard clipped
    // edge right at the seam (round-3 critique #1's "trees near a boundary" case). paintTrees is
    // a pure function of (wx,wy) via hash2, so redrawing the same source tile from both chunks
    // reproduces the identical tree in both, harmlessly clipped by each canvas's own bounds.
    for (let ty = -1; ty <= CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy < 0 || wy >= map.height) continue;
      for (let tx = -1; tx <= CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx < 0 || wx >= map.width) continue;
        paintTrees(ctx, map, wx, wy, tx * TILE_PX, ty * TILE_PX, season, this.seed, zoom);
      }
    }

    paintWoodsChunk(ctx, map, x0, y0, season, this.seed, zoom);


    // ------------------------------------------------------------ decor
    this.drawDecor(ctx, x0, y0);

    ctx.restore();

    const dt = t0 ? performance.now() - t0 : 0;
    if (typeof console !== 'undefined' && dt) {
      // eslint-disable-next-line no-console
      console.log(`[terrain] baked chunk (${cx},${cy}) @${zoom}x in ${dt.toFixed(1)}ms`);
    }
    return canvas;
  }

  /** Tile indexes (chunk + 1 tile border) that started as hedge/fence/stone wall and are no longer. */
  private brokenLineTiles(x0: number, y0: number): number[] {
    const map = this.map;
    const out: number[] = [];
    for (let wy = Math.max(0, y0 - 1); wy <= Math.min(map.height - 1, y0 + CHUNK_TILES); wy++) {
      for (let wx = Math.max(0, x0 - 1); wx <= Math.min(map.width - 1, x0 + CHUNK_TILES); wx++) {
        const i = wy * map.width + wx;
        const o = this.origTiles[i];
        if ((o === 'hedge' || o === 'fence' || o === 'stonewall') && map.tiles[i] !== o) out.push(i);
      }
    }
    return out;
  }

  /** Battle damage on the ground layer: debris of flattened hedges/fences, and stubs of ruined
   * buildings' walls (standing stone wall tiles inside a building footprint, which no vector
   * line covers). Breached wall tiles are rubble and get the rubble debris pass already. */
  private paintStructureDamage(ctx: CanvasRenderingContext2D, x0: number, y0: number, season: Season): void {
    const map = this.map;
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= map.height) break;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= map.width) break;
        const i = wy * map.width + wx;
        const o = this.origTiles[i], t = map.tiles[i];
        const ox = tx * TILE_PX, oy = ty * TILE_PX;
        if ((o === 'hedge' || o === 'fence') && t !== o) {
          const n = o === 'hedge' ? 7 : 4;
          for (let k = 0; k < n; k++) {
            const px = ox + 2 + hash2(wx * 7 + k, wy, this.seed + 7101) * (TILE_PX - 4);
            const py = oy + 2 + hash2(wx, wy * 7 + k, this.seed + 7102) * (TILE_PX - 4);
            if (o === 'hedge') {
              ctx.fillStyle = season === 'winter' ? 'rgba(70,56,40,0.85)' : k % 2 ? 'rgba(52,78,34,0.9)' : 'rgba(84,104,48,0.85)';
              ctx.fillRect(Math.round(px), Math.round(py), 2 + (k % 2), 2);
            } else {
              ctx.save();
              ctx.translate(px, py);
              ctx.rotate(hash2(wx + k, wy + k, this.seed + 7103) * Math.PI);
              ctx.fillStyle = '#5a4326';
              ctx.fillRect(-3, -0.5, 6, 1.5);
              ctx.restore();
            }
          }
        } else if (t === 'stonewall' && map.buildingId[i] >= 0) {
          // jagged broken wall stub with a shadow
          ctx.fillStyle = 'rgba(16,16,8,0.35)';
          ctx.fillRect(ox + 3, oy + 3, TILE_PX - 4, TILE_PX - 4);
          ctx.fillStyle = '#8e8a82';
          ctx.fillRect(ox + 2, oy + 2, TILE_PX - 5, TILE_PX - 5);
          ctx.fillStyle = '#b4b0a6';
          for (let k = 0; k < 4; k++) {
            const bx = ox + 2 + Math.floor(hash2(wx + k, wy, this.seed + 7111) * (TILE_PX - 8));
            const by = oy + 2 + Math.floor(hash2(wx, wy + k, this.seed + 7112) * (TILE_PX - 8));
            ctx.fillRect(bx, by, 3, 2);
          }
          ctx.fillStyle = '#4e4a44';
          ctx.fillRect(ox + 2, oy + TILE_PX - 5, TILE_PX - 5, 2);
        }
      }
    }
  }

  /** Broken roof edge where part of a building's roof has caved in: charred dark rim along the
   * still-roofed neighbours plus a few fallen beams across the hole. */
  private paintCavedRoofEdges(ctx: CanvasRenderingContext2D, x0: number, y0: number): void {
    const map = this.map;
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= map.height) break;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= map.width) break;
        const i = wy * map.width + wx;
        const bid = map.buildingId[i];
        if (bid < 0 || BUILDING_TERRAINS.has(map.tiles[i])) continue;
        const ox = tx * TILE_PX, oy = ty * TILE_PX;
        ctx.fillStyle = 'rgba(24,18,12,0.28)';
        ctx.fillRect(ox, oy, TILE_PX, TILE_PX);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = wx + dx, ny = wy + dy;
          if (!inBounds(map, nx, ny)) continue;
          const ni = ny * map.width + nx;
          if (map.buildingId[ni] !== bid || !BUILDING_TERRAINS.has(map.tiles[ni])) continue;
          // jagged charred rim on the roofed side
          ctx.fillStyle = 'rgba(20,14,10,0.85)';
          for (let k = 0; k < TILE_PX; k += 3) {
            const d = 1 + Math.floor(hash2(wx * 3 + k, wy * 3 + dx + dy, this.seed + 7121) * 3);
            if (dx === 1) ctx.fillRect(ox + TILE_PX - d, oy + k, d, 3);
            else if (dx === -1) ctx.fillRect(ox, oy + k, d, 3);
            else if (dy === 1) ctx.fillRect(ox + k, oy + TILE_PX - d, 3, d);
            else ctx.fillRect(ox + k, oy, 3, d);
          }
        }
        if (hash2(wx, wy, this.seed + 7131) < 0.45) {
          ctx.save();
          ctx.translate(ox + TILE_PX / 2, oy + TILE_PX / 2);
          ctx.rotate(hash2(wx, wy, this.seed + 7132) * Math.PI);
          ctx.fillStyle = '#2a1e14';
          ctx.fillRect(-TILE_PX * 0.45, -1, TILE_PX * 0.9, 2);
          ctx.restore();
        }
      }
    }
  }

  private drawDecor(ctx: CanvasRenderingContext2D, x0: number, y0: number): void {
    const decor = this.map.def.decor;
    if (!decor || !decor.length) return;
    for (const d of decor) {
      if (d.kind === 'shellhole' || d.kind === 'foxhole') continue; // earthwork pass
      if (d.x < x0 - 1 || d.x >= x0 + CHUNK_TILES + 1 || d.y < y0 - 1 || d.y >= y0 + CHUNK_TILES + 1) continue;
      const cx = (d.x - x0) * TILE_PX;
      const cy = (d.y - y0) * TILE_PX;
      drawDecorItem(ctx, d.kind, cx, cy, d.variant ?? 0, this.map.def.season);
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

  /** Uses the exact same `groundColorFbm` ramp+fbm function (plus the same relief-shading term)
   * that the real per-pixel bake uses, sampled at every one of the LOWRES_PX_PER_TILE^2 output
   * pixels (world pixel coords, not a single tile-centre sample) — this is what makes the
   * low-res scrolling fallback tone-identical to a baked chunk at the seam between them instead
   * of reading as a flatter, differently-toned patch next to it (round-3 critique #1/fix #1). */
  private paintLowResTile(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const map = this.map;
    const season = map.def.season;
    const t = tileAt(map, x, y);
    const i = idx(map, x, y);
    if (t === 'buildingWood' || t === 'buildingStone' || t === 'floor') {
      const cx = (x + 0.5) * TILE_PX, cy = (y + 0.5) * TILE_PX;
      const bid = map.buildingId[i];
      const bb = bid >= 0 ? this.buildingBBoxes.get(bid) : undefined;
      const stone = bb ? bb.kind === 'stone' : t === 'buildingStone';
      const base = hexToRgb(stone ? '#6d6d68' : '#6f4a2c');
      const color = shade(base, (fbm(cx / 40, cy / 40, 2, this.seed + 8811) - 0.5) * 0.2);
      ctx.fillStyle = `rgb(${clamp255(color.r) | 0},${clamp255(color.g) | 0},${clamp255(color.b) | 0})`;
      ctx.fillRect(x * LOWRES_PX_PER_TILE, y * LOWRES_PX_PER_TILE, LOWRES_PX_PER_TILE, LOWRES_PX_PER_TILE);
      return;
    }
    const groundT = (t === 'crater' || t === 'bridge') ? this.groundUnder[i] : t;
    const subPx = TILE_PX / LOWRES_PX_PER_TILE;
    for (let sy = 0; sy < LOWRES_PX_PER_TILE; sy++) {
      for (let sx = 0; sx < LOWRES_PX_PER_TILE; sx++) {
        const wpx = x * TILE_PX + (sx + 0.5) * subPx;
        const wpy = y * TILE_PX + (sy + 0.5) * subPx;
        let color = groundColorFbm(groundT, season, wpx, wpy, this.seed);
        const rf = reliefFactor(wpx, wpy, this.seed);
        color = shade(color, rf - 1);
        ctx.fillStyle = `rgb(${clamp255(color.r) | 0},${clamp255(color.g) | 0},${clamp255(color.b) | 0})`;
        ctx.fillRect(x * LOWRES_PX_PER_TILE + sx, y * LOWRES_PX_PER_TILE + sy, 1, 1);
      }
    }
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
    const vis = { x0: startCx, y0: startCy, x1: endCx, y1: endCy };
    const cache = this.zoomCache(cam.zoom);

    // ---- bake pending visible chunks against a wall-clock budget, nearest the screen centre
    // first (measured: ~20-50ms per chunk at 1x, ~80-115ms at 2x — a count-based budget of 6-8
    // bakes per draw produced 150-360ms frame stalls). At least one chunk is baked per frame so
    // the view always converges; the rest fall back to another zoom's bake or the low-res map.
    const pendingList: { cx: number; cy: number; d: number }[] = [];
    const centreCx = (cam.x + viewTilesW / 2) / CHUNK_TILES - 0.5;
    const centreCy = (cam.y + viewTilesH / 2) / CHUNK_TILES - 0.5;
    for (let cy = startCy; cy <= endCy; cy++) {
      for (let cx = startCx; cx <= endCx; cx++) {
        if (!cache.has(this.chunkKey(cx, cy))) {
          const dx = cx - centreCx, dy = cy - centreCy;
          pendingList.push({ cx, cy, d: dx * dx + dy * dy });
        }
      }
    }
    if (pendingList.length) {
      let anyCached = false;
      for (const m of this.chunksByZoom.values()) if (m.size) { anyCached = true; break; }
      const budget = anyCached ? BAKE_BUDGET_MS : BAKE_BUDGET_COLD_MS;
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const deadline = now() + budget;
      pendingList.sort((p1, p2) => p1.d - p2.d);
      let bakedThisFrame = 0;
      for (const pc of pendingList) {
        if (bakedThisFrame > 0 && now() >= deadline) break;
        this.insertChunk(cam.zoom, pc.cx, pc.cy, this.bakeChunk(pc.cx, pc.cy, cam.zoom), vis);
        bakedThisFrame++;
      }
    }

    // ---- blit. Chunk rects are derived from ONE rounded origin so neighbouring chunks always
    // share exact integer edges at any zoom/fractional camera position — separately rounding
    // each chunk's position and size left a 1px dark hairline at chunk seams while panning.
    const originX = Math.round(-cam.x * px);
    const originY = Math.round(-cam.y * px);
    const chunkScreenPx = CHUNK_TILES * px;
    const lowRes = this.ensureLowRes();
    for (let cy = startCy; cy <= endCy; cy++) {
      const top = Math.round(originY + cy * chunkScreenPx);
      const bottom = Math.round(originY + (cy + 1) * chunkScreenPx);
      for (let cx = startCx; cx <= endCx; cx++) {
        const left = Math.round(originX + cx * chunkScreenPx);
        const right = Math.round(originX + (cx + 1) * chunkScreenPx);
        const dw = right - left, dh = bottom - top;
        const key = this.chunkKey(cx, cy);
        const entry = cache.get(key);
        if (entry) {
          this.touchChunk(cam.zoom, key);
          ctx.drawImage(entry.canvas, left, top, dw, dh);
          continue;
        }
        // Not yet baked at this zoom level. Prefer scaling a bake of the SAME chunk at a
        // DIFFERENT zoom level, if one is cached — same ground pass, same seed, same world
        // pixel coords, just a different output resolution, so it is tonally identical (unlike
        // the flat-fill low-res painter) and only ever a scale-blur, never a seam. Only fall
        // back to the cheap whole-map low-res painter when no bake of this chunk exists yet at
        // any zoom.
        let otherZoomChunk: HTMLCanvasElement | undefined;
        for (const z of ZOOM_LEVELS) {
          if (z === cam.zoom) continue;
          const other = this.chunksByZoom.get(z)?.get(key);
          if (other) { otherZoomChunk = other.canvas; break; }
        }
        if (otherZoomChunk) {
          ctx.drawImage(otherZoomChunk, left, top, dw, dh);
        } else {
          const sx = cx * CHUNK_TILES * LOWRES_PX_PER_TILE;
          const sy = cy * CHUNK_TILES * LOWRES_PX_PER_TILE;
          const full = CHUNK_TILES * LOWRES_PX_PER_TILE;
          const sw = Math.min(full, lowRes.width - sx);
          const sh = Math.min(full, lowRes.height - sy);
          // partial edge chunks: scale the destination by the same fraction so the low-res map
          // isn't stretched over the whole chunk rect
          if (sw > 0 && sh > 0) ctx.drawImage(lowRes, sx, sy, sw, sh, left, top, dw * (sw / full), dh * (sh / full));
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
    const px = TILE_PX * cam.zoom;

    if (map.dirtyTiles && map.dirtyTiles.length) {
      const buildings = new Set<number>();
      for (const ti of map.dirtyTiles) {
        this.invalidateTile(ti % map.width, Math.floor(ti / map.width));
        // a building's roof/shadow spans several chunks: re-bake all of them, and its roof-off view
        const bid = map.buildingId[ti];
        if (bid >= 0) buildings.add(bid);
        // a cut vector line changes its neighbours' tile too (line caps)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = ti % map.width + dx, ny = Math.floor(ti / map.width) + dy;
          if (inBounds(map, nx, ny)) this.invalidateTile(nx, ny);
        }
      }
      for (const bid of buildings) {
        const bb = this.buildingBBoxes.get(bid);
        this.interiorCache.delete(bid);
        if (!bb) continue;
        for (let cy = Math.floor((bb.minY - 2) / CHUNK_TILES); cy <= Math.floor((bb.maxY + 2) / CHUNK_TILES); cy++) {
          for (let cx = Math.floor((bb.minX - 2) / CHUNK_TILES); cx <= Math.floor((bb.maxX + 2) / CHUNK_TILES); cx++) {
            this.invalidateTile(Math.max(0, cx * CHUNK_TILES), Math.max(0, cy * CHUNK_TILES));
          }
        }
      }
      map.dirtyTiles.length = 0;
    }

    // Roofs disappear when friendly troops occupy a building (CC3 manual): find every building
    // id containing at least one living player-side soldier this frame, and blit a cached
    // roof-off interior over its baked roof. Enemy-occupied and empty buildings are untouched —
    // their roofs stay baked into the chunk canvas underneath.
    const playerSide = state.config.playerSide;
    const occupiedBuildings = new Set<number>();
    for (const s of state.soldiers.values()) {
      if (s.health === 'dead' || s.side !== playerSide) continue;
      const tx = Math.floor(s.pos.x), ty = Math.floor(s.pos.y);
      if (!inBounds(map, tx, ty)) continue;
      const bid = map.buildingId[idx(map, tx, ty)];
      if (bid >= 0) occupiedBuildings.add(bid);
    }
    for (const bid of occupiedBuildings) {
      const bb = this.buildingBBoxes.get(bid);
      if (!bb) continue;
      let interior = this.interiorCache.get(bid);
      if (!interior) {
        interior = paintInterior(map, bb, analyzeFootprint(map, bb), this.seed);
        this.interiorCache.set(bid, interior);
      }
      const s0 = worldToScreen(cam, { x: bb.minX, y: bb.minY });
      const dw = interior.width * cam.zoom, dh = interior.height * cam.zoom;
      if (s0.x > VIEW_W || s0.y > VIEW_H || s0.x + dw < 0 || s0.y + dh < 0) continue;
      ctx.drawImage(interior, s0.x, s0.y, dw, dh);
    }

    // fresh blast marks are stamped into the baked chunks (not redrawn every frame)
    this.stampNewMarks();

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
