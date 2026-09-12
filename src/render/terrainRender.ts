// ============================================================================
// terrainRender.ts — bakes the painted CC3-style terrain into offscreen chunk
// canvases and blits them each frame. Also draws craters/blood/smoke overlays.
//
// Technique: ground + crops + roads + water + rubble are all resolved in one
// per-pixel ImageData pass. Every one of those classes is represented as a
// coverage field sampled at TILE CENTRES (1 inside / 0 outside); each pixel
// bilinearly interpolates that field from its four nearest tile centres and
// thresholds at 0.5 (+ small hash noise for organic edges). This turns the
// stepped tile-aligned polygons the map DSL paints into smooth, ragged,
// hand-painted-looking borders, with no diagonal hatch patterns anywhere.
// Walls/hedges/fences/trenches/buildings/trees/decor are then drawn with
// ordinary canvas ops on top, in that fixed order.
// ============================================================================
import type { Camera, GameMap, BattleState, Terrain, Season } from '@/shared/types';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { idx, tileAt, inBounds } from '@/sim/map';
import { TERRAIN_COLORS } from '@/render/palette';
import { getTreeSprite, getSmokePuff } from '@/render/sprites';
import { drawDecorItem } from '@/render/decorSprites';
import { worldToScreen } from '@/engine/camera';

const CHUNK_TILES = 26;
const CHUNK_PX = CHUNK_TILES * TILE_PX; // 260

const BUILDING_TERRAINS = new Set<Terrain>(['buildingWood', 'buildingStone', 'floor']);
/** Terrain a pixel "falls back to" when the tile itself is a feature (road/water/crops/rubble/wall). */
const SOFT_GROUND = new Set<Terrain>(['open', 'grass', 'tallgrass', 'snow', 'mud']);

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

interface BuildingBBox {
  minX: number; minY: number; maxX: number; maxY: number;
  kind: 'wood' | 'stone';
  id: number;
}

interface FieldInfo { horiz: boolean }

// ============================================================================
// color ramp overrides — kept local to the renderer (palette.ts is owned by
// another agent) so 'open'/'grass'/'tallgrass' read as olive-tan/olive-green
// rather than the palette's dark chocolate brown, and winter 'snow' reads
// clean off-white.
// ============================================================================
const LOCAL_RAMPS: Partial<Record<Season, Partial<Record<Terrain, string[]>>>> = {
  summer: {
    open: ['#8f8a5e', '#9a9366', '#857f55'],
    grass: ['#6e7a3f', '#778445', '#66713a'],
    tallgrass: ['#7c8a46', '#84914e', '#6f7c3c'],
  },
  autumn: {
    open: ['#a0904a', '#a89a52', '#93843e'],
    grass: ['#94893c', '#9c9244', '#867c34'],
    tallgrass: ['#a08a34', '#a8943c', '#8e7a2c'],
  },
  winter: {
    snow: ['#e6e8ec', '#d9dde3', '#e0e3e8'],
  },
};
function rampFor(season: Season, t: Terrain): string[] {
  return LOCAL_RAMPS[season]?.[t] ?? TERRAIN_COLORS[season][t];
}

// ============================================================================
// noise + color helpers
// ============================================================================
function fade(t: number): number { return t * t * (3 - 2 * t); }

/** Bilinear-interpolated hash2 lattice noise, 0..1, at world-tile-fractional coords. */
function latticeNoise(x: number, y: number, seed: number, cell: number): number {
  const gx = x / cell, gy = y / cell;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = fade(gx - x0), fy = fade(gy - y0);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

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

/**
 * Smooth low-frequency ground color for terrain `t` at fractional world-tile
 * coords (wxf,wyf): two octaves of value noise blend between the terrain's
 * 2-4 ramp shades so tonal variation reads as patches metres across, not
 * per-pixel camo noise. Adds a very small per-pixel grain on top.
 */
function groundColor(t: Terrain, season: Season, wxf: number, wyf: number, wpx: number, wpy: number, seed: number): RGB {
  const ramp = rampFor(season, t);
  const c0 = hexToRgb(ramp[0]);
  const c1 = hexToRgb(ramp[1 % ramp.length]);
  const c2 = hexToRgb(ramp[2 % ramp.length]);
  const n1 = latticeNoise(wxf, wyf, seed + 1, 6);
  const n2 = latticeNoise(wxf, wyf, seed + 2, 1.5);
  let r = lerp(c0.r, c1.r, n1), g = lerp(c0.g, c1.g, n1), b = lerp(c0.b, c1.b, n1);
  const w2 = n2 * 0.35;
  r = lerp(r, c2.r, w2); g = lerp(g, c2.g, w2); b = lerp(b, c2.b, w2);
  const grain = (hash2(wpx, wpy, seed + 9) - 0.5) * 6; // +-3 levels
  return { r: clamp255(r + grain), g: clamp255(g + grain), b: clamp255(b + grain) };
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
interface Grid { data: Float32Array; size: number }

function buildGrid(map: GameMap, x0: number, y0: number, tiles: number, classify: (t: Terrain) => boolean): Grid {
  const size = tiles + 3;
  const data = new Float32Array(size * size);
  for (let gy = 0; gy < size; gy++) {
    const ty = y0 - 1 + gy;
    for (let gx = 0; gx < size; gx++) {
      const tx = x0 - 1 + gx;
      data[gy * size + gx] = classify(tileAt(map, tx, ty)) ? 1 : 0;
    }
  }
  return { data, size };
}

/** Bilinear sample of `grid` at the pixel (tx,px,ty,py) local to the chunk, plus hash noise. */
function sampleGrid(grid: Grid, tx: number, px: number, ty: number, py: number, wpx: number, wpy: number, seed: number, noiseAmt = 0.08): number {
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
        const gy0 = ty + (py < 5 ? 0 : 1);
        const fy = py < 5 ? 0.5 + py / TILE_PX : py / TILE_PX - 0.5;
        for (let px = 0; px < TILE_PX; px++) {
          const wpx = wx * TILE_PX + px;
          const wxf = wpx / TILE_PX, wyf = wpy / TILE_PX;

          // -------------------------------------------------- smoothed ground
          const cx0 = px < 5 ? wx - 1 : wx, cx1 = cx0 + 1;
          const cy0 = py < 5 ? wy - 1 : wy, cy1 = cy0 + 1;
          const tA = groundAt(cx0, cy0), tB = groundAt(cx1, cy0), tC = groundAt(cx0, cy1), tD = groundAt(cx1, cy1);
          const fxx = px < 5 ? 0.5 + px / TILE_PX : px / TILE_PX - 0.5;
          const fyy = py < 5 ? 0.5 + py / TILE_PX : py / TILE_PX - 0.5;
          const scores = new Map<Terrain, number>();
          scores.set(tA, (scores.get(tA) || 0) + (1 - fxx) * (1 - fyy));
          scores.set(tB, (scores.get(tB) || 0) + fxx * (1 - fyy));
          scores.set(tC, (scores.get(tC) || 0) + (1 - fxx) * fyy);
          scores.set(tD, (scores.get(tD) || 0) + fxx * fyy);
          let groundT: Terrain = tA, bestScore = -1;
          for (const [t, s] of scores) {
            const noisy = s + (hash2(wpx, wpy, seed + hashStr(t)) - 0.5) * 0.16;
            if (noisy > bestScore) { bestScore = noisy; groundT = t; }
          }

          let color = groundColor(groundT, season, wxf, wyf, wpx, wpy, seed);

          // tallgrass tuft strokes: thin vertical lighter runs
          if (groundT === 'tallgrass' && hash2(wpx, Math.floor(wpy / 3), seed + 555) < 0.1) {
            color = shade(color, 0.16);
          } else if ((groundT === 'grass' || groundT === 'open') && hash2(wpx, wpy, seed + 4477) > 0.996) {
            color = shade(color, 0.14);
          } else if ((groundT === 'grass' || groundT === 'open') && hash2(wpx, wpy, seed + 4478) < 0.004) {
            color = shade(color, -0.14);
          } else if (groundT === 'snow' && hash2(wpx, wpy, seed + 991) > 0.998) {
            color = shade(color, -0.1);
          }

          // -------------------------------------------------------- crops
          const covCrop = sampleGrid(cropsGrid, tx, px, ty, py, wpx, wpy, seed + 3001);
          if (covCrop > 0.5) {
            const fid = fieldId[wy * mapW + wx];
            const info = fid >= 0 ? fieldAxis.get(fid) : undefined;
            const horiz = info ? info.horiz : true;
            const cropBase = groundColor('crops', season, wxf, wyf, wpx, wpy, seed);
            const stripe = horiz ? Math.floor(wpy / 2) % 2 : Math.floor(wpx / 2) % 2;
            const ragged = hash2(wpx, wpy, seed + 909) < 0.1;
            color = ragged ? cropBase : shade(cropBase, stripe === 0 ? 0.1 : -0.1);
            if (covCrop < 0.6) color = shade(color, -0.12); // headland darker near edge
          }

          // -------------------------------------------------------- roads
          const covPaved = sampleGrid(pavedGrid, tx, px, ty, py, wpx, wpy, seed + 3101);
          const covDirt = sampleGrid(dirtGrid, tx, px, ty, py, wpx, wpy, seed + 3201);
          if (covPaved > 0.5) {
            let rc = groundColor('pavedroad', season, wxf, wyf, wpx, wpy, seed);
            if (covPaved < 0.58) rc = shade(rc, -0.16); // kerb
            const crackBlockX = Math.floor(wpx / 3), crackBlockY = Math.floor(wpy / 3);
            if (hash2(crackBlockX, crackBlockY, seed + 4501) < 0.025) rc = shade(rc, -0.22);
            if (latticeNoise(wxf, wyf, seed + 4601, 8) > 0.86) rc = shade(rc, 0.12); // worn patch
            color = rc;
          } else if (covDirt > 0.5) {
            let rc = groundColor('dirtroad', season, wxf, wyf, wpx, wpy, seed);
            if (covDirt >= 0.62 && covDirt <= 0.70) rc = shade(rc, -0.12); // rut iso-contour
            color = rc;
          }

          // -------------------------------------------------------- water
          const covWater = sampleGrid(waterGrid, tx, px, ty, py, wpx, wpy, seed + 3301);
          if (covWater > 0.5) {
            let wc = groundColor('water', season, wxf, wyf, wpx, wpy, seed);
            if (covWater < 0.62) wc = shade(wc, -0.3); // dark bank line
            else if (covWater < 0.72) wc = shade(wc, 0.18); // bank highlight
            color = wc;
          }

          // -------------------------------------------------------- rubble
          const covRubble = sampleGrid(rubbleGrid, tx, px, ty, py, wpx, wpy, seed + 3401);
          if (covRubble > 0.5) {
            let rb = groundColor('rubble', season, wxf, wyf, wpx, wpy, seed);
            const bx = Math.floor(wpx / 2), by = Math.floor(wpy / 2);
            const fragH = hash2(bx, by, seed + 3501);
            if (fragH < 0.08) {
              rb = fragH < 0.04 ? { r: 138, g: 74, b: 58 } : { r: 116, g: 112, b: 104 };
            } else {
              rb = shade(rb, -0.06); // dust
            }
            color = rb;
          }

          // ---------------------------------------------------- dirty snow
          if (season === 'winter' && groundT === 'snow') {
            const covDirty = sampleGrid(dirtyGrid, tx, px, ty, py, wpx, wpy, seed + 3601, 0.05);
            const blend = clamp01(covDirty) * 0.55;
            if (blend > 0.01 && covPaved <= 0.5 && covDirt <= 0.5 && covRubble <= 0.5) {
              color = lerpRGB(color, { r: 118, g: 110, b: 96 }, blend);
            }
          }

          setPixel(data, bufW, tx * TILE_PX + px, ty * TILE_PX + py, color);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ crater
function paintCraterTile(ctx: CanvasRenderingContext2D, ox: number, oy: number, seed: number): void {
  const cx = ox + TILE_PX / 2, cy = oy + TILE_PX / 2, r = TILE_PX / 2 - 1;
  ctx.globalAlpha = 0.6;
  ctx.beginPath(); ctx.fillStyle = '#1e1c18'; ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  for (let a = 0; a <= 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    const rr = r * (0.85 + hash2(a, Math.round(cx), seed) * 0.3);
    const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
    if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.strokeStyle = '#6a6252';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
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

function paintRoof(ctx: CanvasRenderingContext2D, bb: BuildingBBox, x0: number, y0: number): void {
  const left = (bb.minX - x0) * TILE_PX;
  const top = (bb.minY - y0) * TILE_PX;
  const wTiles = bb.maxX - bb.minX + 1;
  const hTiles = bb.maxY - bb.minY + 1;
  const w = wTiles * TILE_PX;
  const h = hTiles * TILE_PX;
  const stone = bb.kind === 'stone';
  const big = Math.max(wTiles, hTiles) > 12;

  // shadow cast onto the ground on the S and E sides (35% darken), drawn first.
  ctx.fillStyle = 'rgba(8,8,6,0.35)';
  ctx.fillRect(left + w, top + 2, 2, h - 2);
  ctx.fillRect(left + 2, top + h, w - 2, 2);

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
}

function shadeHex(hex: string, amt: number): string {
  const c = hexToRgb(hex);
  const s = shade(c, amt);
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(s.r)}${h(s.g)}${h(s.b)}`;
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
function paintTrees(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number): void {
  const t = tileAt(map, wx, wy);
  if (t === 'woods') {
    const count = hash2(wx, wy, seed + 101) < 0.4 ? 3 : 5;
    for (let i = 0; i < count; i++) {
      const jxT = (hash2(wx * 13 + i, wy * 13 + i, seed + 103) - 0.5) * 1.4;
      const jyT = (hash2(wx * 13 + i + 5, wy * 13 + i + 5, seed + 107) - 0.5) * 1.4;
      // ragged canopy edge: reject candidates that fall outside the smoothed woody field
      if (coverageAt(map, isWoody, wx + 0.5 + jxT, wy + 0.5 + jyT, seed + 8801) < 0.5) continue;
      const variant = Math.floor(hash2(wx * 17 + i, wy * 17 + i, seed + 109) * 3);
      const scale = 0.8 + hash2(wx * 23 + i, wy * 23 + i, seed + 121) * 0.5;
      const sprite = getTreeSprite(variant, season);
      const dw = sprite.width * scale, dh = sprite.height * scale;
      const cx = ox + (0.5 + jxT) * TILE_PX, cy = oy + (0.5 + jyT) * TILE_PX;
      ctx.drawImage(sprite, Math.round(cx - dw / 2), Math.round(cy - dh / 2), dw, dh);
    }
  } else if (t === 'scatteredtrees') {
    if (hash2(wx, wy, seed + 111) < 0.55) {
      const jxT = (hash2(wx * 19, wy * 19, seed + 113) - 0.5) * 0.4;
      const jyT = (hash2(wx * 23, wy * 23, seed + 117) - 0.5) * 0.4;
      if (coverageAt(map, isWoody, wx + 0.5 + jxT, wy + 0.5 + jyT, seed + 8802) >= 0.5) {
        const variant = Math.floor(hash2(wx * 29, wy * 29, seed + 119) * 3);
        const scale = 0.85 + hash2(wx * 31, wy * 31, seed + 123) * 0.4;
        const sprite = getTreeSprite(variant, season);
        const dw = sprite.width * scale, dh = sprite.height * scale;
        const cx = ox + (0.5 + jxT) * TILE_PX, cy = oy + (0.5 + jyT) * TILE_PX;
        ctx.drawImage(sprite, Math.round(cx - dw / 2), Math.round(cy - dh / 2), dw, dh);
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

function paintDetail(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  const t = tileAt(map, wx, wy);
  switch (t) {
    case 'mud': paintMud(ctx, wx, wy, ox, oy, seed); break;
    case 'crater': paintCraterTile(ctx, ox, oy, seed); break;
    case 'trench': paintTrench(ctx, map, wx, wy, ox, oy, seed); break;
    case 'hedge': paintHedge(ctx, map, wx, wy, ox, oy, seed); break;
    case 'fence': paintFence(ctx, map, wx, wy, ox, oy); break;
    case 'stonewall': paintStonewall(ctx, map, wx, wy, ox, oy); break;
    case 'bridge': paintBridge(ctx, map, wx, wy, ox, oy); break;
    default: break;
  }
}

// ============================================================================
export class TerrainRenderer {
  private map: GameMap;
  private seed: number;
  private chunksX: number;
  private chunksY: number;
  private chunks = new Map<string, HTMLCanvasElement>();
  private dirty = new Set<string>();
  private buildingBBoxes = new Map<number, BuildingBBox>();
  private fieldId: Int32Array;
  private fieldAxis = new Map<number, FieldInfo>();
  private groundUnder: Terrain[];

  constructor(map: GameMap) {
    this.map = map;
    this.seed = hashStr(map.def.id) ^ (map.width * 73856093) ^ (map.height * 19349663);
    this.chunksX = Math.max(1, Math.ceil(map.width / CHUNK_TILES));
    this.chunksY = Math.max(1, Math.ceil(map.height / CHUNK_TILES));
    this.fieldId = new Int32Array(map.width * map.height).fill(-1);
    this.computeBuildingBBoxes();
    this.computeFields();
    this.groundUnder = this.computeGroundUnder();
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
    this.dirty.add(this.chunkKey(cx, cy));
  }

  private getChunk(cx: number, cy: number): HTMLCanvasElement {
    const key = this.chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (!c || this.dirty.has(key)) {
      c = this.bakeChunk(cx, cy);
      this.chunks.set(key, c);
      this.dirty.delete(key);
    }
    return c;
  }

  private bakeChunk(cx: number, cy: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_PX;
    canvas.height = CHUNK_PX;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const season = this.map.def.season;
    const x0 = cx * CHUNK_TILES, y0 = cy * CHUNK_TILES;
    const map = this.map;

    // ------------------------------------------------------ coverage grids
    const cropsGrid = buildGrid(map, x0, y0, CHUNK_TILES, isCrops);
    const pavedGrid = buildGrid(map, x0, y0, CHUNK_TILES, isPaved);
    const dirtGrid = buildGrid(map, x0, y0, CHUNK_TILES, isDirtRoad);
    const waterGrid = buildGrid(map, x0, y0, CHUNK_TILES, isWater);
    const rubbleGrid = buildGrid(map, x0, y0, CHUNK_TILES, isRubble);
    const dirtyGrid = season === 'winter' ? buildGrid(map, x0, y0, CHUNK_TILES, isDirtySource) : cropsGrid;

    // ------------------------------------------------------------ ground+features pass
    const img = ctx.createImageData(CHUNK_PX, CHUNK_PX);
    paintGroundAndFeatures(
      img.data, CHUNK_PX, map, season, this.seed, x0, y0, CHUNK_TILES, CHUNK_TILES,
      this.groundUnder, map.width, map.height, this.fieldId, this.fieldAxis,
      cropsGrid, pavedGrid, dirtGrid, waterGrid, rubbleGrid, dirtyGrid,
    );
    ctx.putImageData(img, 0, 0);

    // ------------------------------------------------------------ detail pass (walls/hedges/etc)
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= map.width) continue;
        if (BUILDING_TERRAINS.has(tileAt(map, wx, wy))) continue;
        paintDetail(ctx, map, wx, wy, tx * TILE_PX, ty * TILE_PX, this.seed);
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
    for (let cy = startCy; cy <= endCy; cy++) {
      for (let cx = startCx; cx <= endCx; cx++) {
        const chunk = this.getChunk(cx, cy);
        const s = worldToScreen(cam, { x: cx * CHUNK_TILES, y: cy * CHUNK_TILES });
        const size = CHUNK_PX * cam.zoom;
        ctx.drawImage(chunk, s.x, s.y, size, size);
      }
    }
    ctx.restore();
  }

  thumbnail(w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const mapPxW = this.map.width * TILE_PX;
    const mapPxH = this.map.height * TILE_PX;
    const scale = Math.min(w / mapPxW, h / mapPxH);
    const offX = (w - mapPxW * scale) / 2;
    const offY = (h - mapPxH * scale) / 2;
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        const chunk = this.getChunk(cx, cy);
        const dx = offX + cx * CHUNK_TILES * TILE_PX * scale;
        const dy = offY + cy * CHUNK_TILES * TILE_PX * scale;
        ctx.drawImage(chunk, dx, dy, CHUNK_PX * scale, CHUNK_PX * scale);
      }
    }
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
      for (const ti of map.dirtyTiles) this.invalidateTile(ti % map.width, Math.floor(ti / map.width));
      map.dirtyTiles.length = 0;
    }

    for (const ti of map.craters) {
      const cx = ti % map.width, cy = Math.floor(ti / map.width);
      const s = worldToScreen(cam, { x: cx + 0.5, y: cy + 0.5 });
      if (s.x < -px || s.x > VIEW_W + px || s.y < -px || s.y > VIEW_H + px) continue;
      const r = px / 2 - 1;
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.fillStyle = '#1e1c18'; ctx.arc(s.x, s.y, r * 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.strokeStyle = '#6a6252'; ctx.lineWidth = 1; ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
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
