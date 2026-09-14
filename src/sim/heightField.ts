// ============================================================================
// heightField.ts — surface height model of the battlefield, in metres, at 0.5 m resolution
// (HF_RES = 4 samples per 2 m tile edge). Ground level is 0.
//
// Two layers are composed per sample:
//   base  — driven by the tile's current terrain (re-derived per tile when a tile changes):
//           hedges +1.5, fences +1.1 (thin), stone walls +1.8, buildings (wood 4 m eaves / 6 m
//           ridge, stone 8-12 m by size, big city blocks 15 m), rubble mounds +0.6..1.5, water -0.5.
//   dig   — stamped earthworks that persist whatever the tile becomes: shell craters (bowl with a
//           +0.2 m rim, depth by size), foxholes (-1.2 m with a +0.4 m spoil mound toward the
//           enemy), trenches (-1.5 m along the zig-zag with a low parapet).
// height = base >= 1 (a standing structure) ? base : base + dig.
// Tree crowns live in `canopy` (woods 8-12 m) so a view can draw them over the ground.
// Vehicles are not part of the field. Render-only consumers (the depth view) read it; nothing
// in the sim's combat/LOS rules depends on it, so it never affects determinism.
// ============================================================================
import type { GameMap, HeightField, MapVectorFeature, Terrain, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { hash2 } from '@/shared/rng';

export const HF_RES = 4;
/** metres per sample */
export const HF_STEP_M = TILE_M / HF_RES;

export const H_HEDGE = 1.5;
export const H_FENCE = 1.1;
export const H_STONEWALL = 1.8;
export const H_WOOD_EAVE = 4;
export const H_WOOD_RIDGE = 6;
export const H_STONE_EAVE_MIN = 8;
export const H_STONE_EAVE_MAX = 12;
export const H_BIG_BLOCK = 15;
export const H_RUBBLE_MIN = 0.6;
export const H_RUBBLE_MAX = 1.5;
export const H_BREACH_LIP = 0.6;
export const H_WATER = -0.5;
export const H_FOXHOLE = -1.2;
export const H_FOXHOLE_SPOIL = 0.4;
export const H_TRENCH = -1.5;
export const H_CRATER_RIM = 0.2;

/** A per-tile base profile: one flat height, or HF_RES*HF_RES samples (row-major). */
export type TileProfile = number | ArrayLike<number>;

interface BuildingInfo {
  id: number;
  minX: number; minY: number; maxX: number; maxY: number;
  stone: boolean;
  big: boolean;
  eave: number;
  ridge: number;
  ridgeHoriz: boolean;
}

interface Seg { ax: number; ay: number; bx: number; by: number }

interface FieldCtx {
  map: GameMap;
  buildings: Map<number, BuildingInfo>;
  /** line-vector segments per terrain, bucketed by tile index they pass near */
  lineSegs: Map<Terrain, Map<number, Seg[]>>;
  /** flat base-height overrides per tile index (breach lips, ruined wall stubs) */
  overrides: Map<number, number>;
}

const ctxByField = new WeakMap<HeightField, FieldCtx>();

const LINE_TERRAINS: Terrain[] = ['hedge', 'fence', 'stonewall', 'trench'];
const BUILDING_TERRAIN = new Set<Terrain>(['buildingWood', 'buildingStone', 'floor']);

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth(t: number): number { const c = clamp01(t); return c * c * (3 - 2 * c); }

function distSeg(px: number, py: number, s: Seg): number {
  const abx = s.bx - s.ax, aby = s.by - s.ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? clamp01(((px - s.ax) * abx + (py - s.ay) * aby) / len2) : 0;
  return Math.hypot(px - (s.ax + abx * t), py - (s.ay + aby * t));
}

// ------------------------------------------------------------------ building/context setup
function computeBuildings(map: GameMap): Map<number, BuildingInfo> {
  const out = new Map<number, BuildingInfo>();
  const w = map.width;
  for (let i = 0; i < map.tiles.length; i++) {
    const bid = map.buildingId[i];
    if (bid < 0) continue;
    const x = i % w, y = (i / w) | 0;
    let b = out.get(bid);
    if (!b) {
      b = { id: bid, minX: x, minY: y, maxX: x, maxY: y, stone: false, big: false, eave: 0, ridge: 0, ridgeHoriz: true };
      out.set(bid, b);
    }
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    if (map.tiles[i] === 'buildingStone') b.stone = true;
  }
  for (const b of out.values()) {
    const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
    let occupied = 0;
    for (let y = b.minY; y <= b.maxY; y++) for (let x = b.minX; x <= b.maxX; x++) if (map.buildingId[y * w + x] === b.id) occupied++;
    // a city block (courtyard ring) or a very large footprint: tall flat-roofed tenement
    b.big = (bw > 12 && bh > 12) || occupied < bw * bh * 0.8;
    b.ridgeHoriz = bw >= bh;
    if (b.stone) {
      if (b.big) { b.eave = H_BIG_BLOCK; b.ridge = H_BIG_BLOCK; } else {
        const size = clamp01((bw * bh - 16) / 80);
        b.eave = H_STONE_EAVE_MIN + (H_STONE_EAVE_MAX - H_STONE_EAVE_MIN) * size - 1.5 * (1 - size);
        b.eave = Math.max(H_STONE_EAVE_MIN - 1.5, b.eave);
        b.ridge = b.eave + 2;
      }
    } else {
      b.eave = H_WOOD_EAVE;
      b.ridge = H_WOOD_RIDGE;
    }
  }
  return out;
}

function computeLineSegs(map: GameMap): Map<Terrain, Map<number, Seg[]>> {
  const out = new Map<Terrain, Map<number, Seg[]>>();
  const vectors: MapVectorFeature[] = map.def.vectors ?? [];
  for (const v of vectors) {
    if (v.kind !== 'line' || !LINE_TERRAINS.includes(v.terrain)) continue;
    let buckets = out.get(v.terrain);
    if (!buckets) { buckets = new Map(); out.set(v.terrain, buckets); }
    for (let k = 0; k < v.points.length - 1; k++) {
      // vector points are tile coordinates (the DSL rasterises tiles whose centre lies within
      // half a tile of the polyline; the renderer strokes the same points)
      const a = v.points[k], b = v.points[k + 1];
      const seg: Seg = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
      const x0 = Math.floor(Math.min(seg.ax, seg.bx)) - 1, x1 = Math.floor(Math.max(seg.ax, seg.bx)) + 1;
      const y0 = Math.floor(Math.min(seg.ay, seg.by)) - 1, y1 = Math.floor(Math.max(seg.ay, seg.by)) + 1;
      for (let y = Math.max(0, y0); y <= Math.min(map.height - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(map.width - 1, x1); x++) {
          // cheap reject: tile centre farther than 1.5 tiles from the segment
          if (distSeg(x + 0.5, y + 0.5, seg) > 1.5) continue;
          const ti = y * map.width + x;
          let arr = buckets.get(ti);
          if (!arr) { arr = []; buckets.set(ti, arr); }
          arr.push(seg);
        }
      }
    }
  }
  return out;
}

/** Segments (tile coords) for a line tile: the map's vector geometry through it, or else links
 * from the tile centre to neighbouring tiles of the same terrain (a dot when isolated). */
function segmentsForTile(ctx: FieldCtx, t: Terrain, tx: number, ty: number): Seg[] {
  const map = ctx.map;
  const ti = ty * map.width + tx;
  // Map vector geometry when the tile lies on one (the DSL rasterises a 1-wide line into every
  // tile whose centre is within half a tile, often two rows, so tile links would draw a ladder);
  // only the samples of tiles still of that terrain are raised, so a flattened tile cuts exactly
  // its piece out, like the renderer's clip.
  const vec = ctx.lineSegs.get(t)?.get(ti);
  if (vec && vec.length) {
    // only trust the vector when it actually crosses this tile (within ~0.8 tile of its centre)
    if (vec.some((s) => distSeg(tx + 0.5, ty + 0.5, s) <= 0.8)) return vec;
  }
  const cx = tx + 0.5, cy = ty + 0.5;
  const same = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && map.tiles[y * map.width + x] === t;
  const segs: Seg[] = [];
  const orth: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of orth) if (same(tx + dx, ty + dy)) segs.push({ ax: cx, ay: cy, bx: cx + dx, by: cy + dy });
  const diag: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [dx, dy] of diag) {
    if (!same(tx + dx, ty + dy)) continue;
    if (same(tx + dx, ty) || same(tx, ty + dy)) continue; // already joined through an orthogonal link
    segs.push({ ax: cx, ay: cy, bx: cx + dx, by: cy + dy });
  }
  if (!segs.length) segs.push({ ax: cx, ay: cy, bx: cx, by: cy });
  return segs;
}

// ------------------------------------------------------------------ per-tile base profile
function rubbleTileValue(map: GameMap, x: number, y: number): number {
  // mound height grows with how much rubble surrounds the tile (a collapsed building's centre
  // piles higher than a lone heap)
  let n = 0, tot = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      tot++;
      const t = map.tiles[ny * map.width + nx];
      if (t === 'rubble' || t === 'stonewall' || BUILDING_TERRAIN.has(t)) n++;
    }
  }
  const frac = tot ? n / tot : 0;
  return H_RUBBLE_MIN + (H_RUBBLE_MAX - H_RUBBLE_MIN) * smooth((frac - 0.2) / 0.7) + (hash2(x, y, 4421) - 0.5) * 0.15;
}

function lineHeight(t: Terrain, dM: number): number {
  switch (t) {
    case 'hedge': return dM <= 0.45 ? H_HEDGE : dM <= 0.95 ? H_HEDGE * (1 - smooth((dM - 0.45) / 0.5)) : 0;
    // thin, but faded over ~0.3 m so a diagonal fence doesn't alias into dashes between samples
    case 'fence': return dM <= 0.25 ? H_FENCE : dM <= 0.75 ? H_FENCE * (1 - smooth((dM - 0.25) / 0.5)) : 0;
    case 'stonewall': return dM <= 0.5 ? H_STONEWALL : dM <= 0.7 ? H_STONEWALL * (1 - smooth((dM - 0.5) / 0.2)) : 0;
    default: return 0;
  }
}

/** Writes the 16 base samples of tile (tx,ty) from its current terrain into `out` (row-major). */
function computeTileBase(ctx: FieldCtx, tx: number, ty: number, out: Float32Array): void {
  const map = ctx.map;
  const R = HF_RES;
  const ti = ty * map.width + tx;
  const ov = ctx.overrides.get(ti);
  if (ov !== undefined) {
    for (let k = 0; k < R * R; k++) out[k] = ov + (hash2(tx * R + (k % R), ty * R + ((k / R) | 0), 4431) - 0.5) * 0.12;
    return;
  }
  const t = map.tiles[ti];
  const bid = map.buildingId[ti];
  if (BUILDING_TERRAIN.has(t) && bid >= 0) {
    const b = ctx.buildings.get(bid);
    if (b) {
      const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
      for (let sy = 0; sy < R; sy++) {
        for (let sx = 0; sx < R; sx++) {
          const px = tx + (sx + 0.5) / R, py = ty + (sy + 0.5) / R;
          let h: number;
          if (b.big) {
            // flat roof with a raised parapet along the outer wall
            h = b.eave + (t !== 'floor' ? 0.8 : 0);
          } else {
            const half = (b.ridgeHoriz ? bh : bw) / 2;
            const c = b.ridgeHoriz ? b.minY + bh / 2 : b.minX + bw / 2;
            const off = Math.abs((b.ridgeHoriz ? py : px) - c);
            h = b.ridge - (b.ridge - b.eave) * clamp01(off / Math.max(0.5, half));
          }
          out[sy * R + sx] = h;
        }
      }
      return;
    }
  }
  switch (t) {
    case 'rubble': {
      // bilinear between tile-centre mound values so neighbouring rubble tiles join smoothly
      const val = (x: number, y: number): number => {
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) return 0.2;
        return map.tiles[y * map.width + x] === 'rubble' ? rubbleTileValue(map, x, y) : 0.25;
      };
      for (let sy = 0; sy < R; sy++) {
        for (let sx = 0; sx < R; sx++) {
          const fx = (sx + 0.5) / R - 0.5, fy = (sy + 0.5) / R - 0.5;
          const nx = fx < 0 ? -1 : 1, ny = fy < 0 ? -1 : 1;
          const ax = Math.abs(fx), ay = Math.abs(fy);
          const v00 = val(tx, ty), v10 = val(tx + nx, ty), v01 = val(tx, ty + ny), v11 = val(tx + nx, ty + ny);
          const top = v00 + (v10 - v00) * ax, bot = v01 + (v11 - v01) * ax;
          out[sy * R + sx] = Math.max(0.15, top + (bot - top) * ay) + (hash2(tx * R + sx, ty * R + sy, 4437) - 0.5) * 0.18;
        }
      }
      return;
    }
    case 'water': out.fill(H_WATER); return;
    case 'bridge': out.fill(0.3); return;
    default: out.fill(0); addLineFeatures(ctx, tx, ty, out); return;
  }
}

const LINE_FEATURES = new Set<Terrain>(['hedge', 'fence', 'stonewall']);

/** Raises the samples of tile (tx,ty) that lie on a hedge/fence/wall line passing through this
 * tile or a neighbouring one. A sample is only raised by the part of a line whose nearest point
 * lies inside a tile that still has that terrain, so the band is continuous across tile corners
 * (the rasterised line tiles don't cover a thin diagonal band exactly) and a flattened or
 * breached tile loses exactly its own piece. */
function addLineFeatures(ctx: FieldCtx, tx: number, ty: number, out: Float32Array): void {
  const map = ctx.map;
  const R = HF_RES;
  for (let ny = ty - 1; ny <= ty + 1; ny++) {
    if (ny < 0 || ny >= map.height) continue;
    for (let nx = tx - 1; nx <= tx + 1; nx++) {
      if (nx < 0 || nx >= map.width) continue;
      const nt = map.tiles[ny * map.width + nx];
      if (!LINE_FEATURES.has(nt)) continue;
      const segs = segmentsForTile(ctx, nt, nx, ny);
      for (let sy = 0; sy < R; sy++) {
        for (let sx = 0; sx < R; sx++) {
          const px = tx + (sx + 0.5) / R, py = ty + (sy + 0.5) / R;
          let d = Infinity;
          for (const sg of segs) {
            const abx = sg.bx - sg.ax, aby = sg.by - sg.ay;
            const len2 = abx * abx + aby * aby;
            const u = len2 > 0 ? clamp01(((px - sg.ax) * abx + (py - sg.ay) * aby) / len2) : 0;
            const qx = sg.ax + abx * u, qy = sg.ay + aby * u;
            if (qx < nx - 0.02 || qx > nx + 1.02 || qy < ny - 0.02 || qy > ny + 1.02) continue;
            const dd = Math.hypot(px - qx, py - qy);
            if (dd < d) d = dd;
          }
          if (d === Infinity) continue;
          const h = lineHeight(nt, d * TILE_M);
          if (h > out[sy * R + sx]) out[sy * R + sx] = h;
        }
      }
    }
  }
}

function tileCanopy(map: GameMap, tx: number, ty: number, out: Float32Array): void {
  const R = HF_RES;
  const t = map.tiles[ty * map.width + tx];
  if (t === 'woods') {
    const base = 8 + hash2(tx, ty, 5101) * 4;
    for (let k = 0; k < R * R; k++) out[k] = base + (hash2(tx * R + (k % R), ty * R + ((k / R) | 0), 5102) - 0.5) * 1.5;
  } else if (t === 'scatteredtrees') {
    for (let k = 0; k < R * R; k++) {
      const sx = tx * R + (k % R), sy = ty * R + ((k / R) | 0);
      // lone crowns: a sample cluster around a hashed trunk position in the tile
      const trunkX = Math.floor(hash2(tx, ty, 5103) * R), trunkY = Math.floor(hash2(tx, ty, 5104) * R);
      const d = Math.hypot((k % R) - trunkX, ((k / R) | 0) - trunkY);
      out[k] = hash2(tx, ty, 5105) < 0.6 && d <= 1.2 ? 7 + hash2(sx, sy, 5106) * 2 : 0;
    }
  } else {
    out.fill(0);
  }
}

// ------------------------------------------------------------------ stamping (dig layer)
function compose(field: HeightField, i: number): void {
  const b = field.base[i];
  field.height[i] = b >= 1 ? b : b + field.dig[i];
}

function recomposeRect(field: HeightField, sx0: number, sy0: number, sx1: number, sy1: number): void {
  const x0 = Math.max(0, sx0), y0 = Math.max(0, sy0), x1 = Math.min(field.w - 1, sx1), y1 = Math.min(field.h - 1, sy1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) compose(field, y * field.w + x);
}

/** Crater depth (m, negative) by rim diameter: grenade hole ~-0.3, mortar ~-0.9, tank/AT HE
 * -1.0..-1.3, 122 mm+ -1.8. */
export function craterDepthM(sizeM: number): number {
  if (sizeM <= 1.3) return -0.3;
  if (sizeM <= 2.55) return -0.9;
  if (sizeM >= 4.9) return -1.8;
  return -(1.0 + clamp01((sizeM - 2.6) / 1.2) * 0.3);
}

function stampBowl(field: HeightField, cx: number, cy: number, radiusM: number, depth: number, rim: number): void {
  const R = field.res;
  const rT = radiusM / TILE_M; // radius in tiles
  const reach = rT * 1.6;
  const sx0 = Math.floor((cx - reach) * R), sx1 = Math.ceil((cx + reach) * R);
  const sy0 = Math.floor((cy - reach) * R), sy1 = Math.ceil((cy + reach) * R);
  for (let sy = Math.max(0, sy0); sy <= Math.min(field.h - 1, sy1); sy++) {
    for (let sx = Math.max(0, sx0); sx <= Math.min(field.w - 1, sx1); sx++) {
      const px = (sx + 0.5) / R, py = (sy + 0.5) / R;
      const d = Math.hypot(px - cx, py - cy) / rT; // 1 at the rim
      const i = sy * field.w + sx;
      if (d < 1) {
        const v = depth * (1 - d * d);
        // overlapping holes deepen a little rather than simply taking the deeper one
        field.dig[i] = Math.min(field.dig[i], v) + (field.dig[i] < 0 && v < 0 ? Math.max(v, field.dig[i]) * 0.15 : 0);
      } else if (d < 1.6 && field.dig[i] >= -0.05) {
        const r = rim * Math.sin(((d - 1) / 0.6) * Math.PI) * (d < 1.3 ? 1 : 1 - (d - 1.3) / 0.3 * 0.5);
        field.dig[i] = Math.max(field.dig[i], r);
      }
    }
  }
  recomposeRect(field, sx0, sy0, sx1, sy1);
}

/** Stamps a shell/grenade crater of rim diameter `sizeM` centred at `pos` (tile coords). */
export function applyCrater(field: HeightField, pos: Vec2, sizeM: number): void {
  stampBowl(field, pos.x, pos.y, Math.max(0.4, sizeM / 2), craterDepthM(sizeM), H_CRATER_RIM);
  field.version++;
}

/** Foxhole pit (-1.2 m) with a spoil mound on the side facing `angle` (radians, 0 = east). */
function stampFoxhole(field: HeightField, cx: number, cy: number, angle: number, twoMan: boolean): void {
  const R = field.res;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const halfLenM = twoMan ? 1.0 : 0.55, halfWidM = 0.55;
  const reach = 1.4; // tiles
  const sx0 = Math.floor((cx - reach) * R), sx1 = Math.ceil((cx + reach) * R);
  const sy0 = Math.floor((cy - reach) * R), sy1 = Math.ceil((cy + reach) * R);
  for (let sy = Math.max(0, sy0); sy <= Math.min(field.h - 1, sy1); sy++) {
    for (let sx = Math.max(0, sx0); sx <= Math.min(field.w - 1, sx1); sx++) {
      const dx = ((sx + 0.5) / R - cx) * TILE_M, dy = ((sy + 0.5) / R - cy) * TILE_M;
      const along = dx * ux + dy * uy;       // toward the enemy
      const across = -dx * uy + dy * ux;     // along the pit's long axis
      const i = sy * field.w + sx;
      const e = Math.hypot(Math.max(0, Math.abs(across) - (halfLenM - halfWidM)) / halfWidM, along / halfWidM);
      if (e < 1) {
        field.dig[i] = Math.min(field.dig[i], H_FOXHOLE * (e < 0.6 ? 1 : 1 - smooth((e - 0.6) / 0.4) * 0.7));
      } else {
        // crescent of spoil 0.6-1.4 m in front of the pit
        const f = along - halfWidM;
        if (f > 0 && f < 1.1 && Math.abs(across) < halfLenM + 0.6) {
          const m = H_FOXHOLE_SPOIL * Math.sin((f / 1.1) * Math.PI) * (1 - smooth((Math.abs(across) - halfLenM) / 0.6));
          field.dig[i] = Math.max(field.dig[i], m);
        }
      }
    }
  }
  recomposeRect(field, sx0, sy0, sx1, sy1);
}

function stampTrenchSegs(field: HeightField, segs: Seg[]): void {
  const R = field.res;
  for (const s of segs) {
    const reach = 1.0;
    const sx0 = Math.floor((Math.min(s.ax, s.bx) - reach) * R), sx1 = Math.ceil((Math.max(s.ax, s.bx) + reach) * R);
    const sy0 = Math.floor((Math.min(s.ay, s.by) - reach) * R), sy1 = Math.ceil((Math.max(s.ay, s.by) + reach) * R);
    for (let sy = Math.max(0, sy0); sy <= Math.min(field.h - 1, sy1); sy++) {
      for (let sx = Math.max(0, sx0); sx <= Math.min(field.w - 1, sx1); sx++) {
        const dM = distSeg((sx + 0.5) / R, (sy + 0.5) / R, s) * TILE_M;
        const i = sy * field.w + sx;
        if (dM <= 0.55) field.dig[i] = Math.min(field.dig[i], H_TRENCH);
        else if (dM <= 0.85) field.dig[i] = Math.min(field.dig[i], H_TRENCH * (1 - smooth((dM - 0.55) / 0.3)));
        else if (dM <= 1.6 && field.dig[i] >= 0) field.dig[i] = Math.max(field.dig[i], 0.3 * Math.sin(((dM - 0.85) / 0.75) * Math.PI));
      }
    }
    recomposeRect(field, sx0, sy0, sx1, sy1);
  }
}

/** Map-placed craters, placed exactly like the terrain renderer draws them (same hashes): a
 * cluster of 'crater' tiles is 1-4 overlapping shell holes, not one bowl per tile; 'shellhole'
 * decor away from crater tiles is a small old hole. */
function stampMapCraters(map: GameMap, field: HeightField): void {
  const w = map.width, h = map.height;
  let hs = 0;
  for (let i = 0; i < map.def.id.length; i++) hs = (hs * 31 + map.def.id.charCodeAt(i)) | 0;
  const seed = (hs >>> 0) ^ (w * 73856093) ^ (h * 19349663);
  const seen = new Uint8Array(w * h);
  const craterTiles = new Set<number>();
  const blocked = (cx: number, cy: number, diameterM: number): boolean => {
    const R = Math.ceil(diameterM / 2 / 2);
    const tx = Math.floor(cx), ty = Math.floor(cy);
    for (let yy = ty - R; yy <= ty + R; yy++) for (let xx = tx - R; xx <= tx + R; xx++) {
      const t = map.tiles[Math.max(0, Math.min(h - 1, yy)) * w + Math.max(0, Math.min(w - 1, xx))];
      if (t === 'water' || t === 'bridge' || BUILDING_TERRAIN.has(t)) return true;
    }
    return false;
  };
  const stamp = (cx: number, cy: number, diameterM: number) => {
    if (blocked(cx, cy, diameterM)) return;
    stampBowl(field, cx, cy, diameterM / 2, craterDepthM(diameterM) * 0.85, H_CRATER_RIM);
  };
  for (let i = 0; i < w * h; i++) {
    if (map.tiles[i] !== 'crater' || seen[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const cx = c % w, cy = (c / w) | 0;
      const nb = [cx > 0 ? c - 1 : -1, cx < w - 1 ? c + 1 : -1, cy > 0 ? c - w : -1, cy < h - 1 ? c + w : -1];
      for (const q of nb) if (q >= 0 && !seen[q] && map.tiles[q] === 'crater') { seen[q] = 1; stack.push(q); }
    }
    for (const c of comp) craterTiles.add(c);
    const count = comp.length === 1 ? 1 : Math.min(4, Math.max(2, Math.round(comp.length / 7)));
    const order = comp.slice().sort((a, b) => hash2(a, 1, seed + 7101) - hash2(b, 1, seed + 7101));
    for (let k = 0; k < count; k++) {
      const c = order[k];
      const cs = (seed + c * 31 + k) | 0;
      const x = (c % w) + 0.5 + (hash2(c, 2, seed + 7102) - 0.5) * 0.5;
      const y = ((c / w) | 0) + 0.5 + (hash2(c, 3, seed + 7103) - 0.5) * 0.5;
      const [lo, hi] = comp.length === 1 ? [2.4, 3.6] : [2.8, 4.8];
      stamp(x, y, lo + hash2(cs, 17, 7001) * (hi - lo));
    }
  }
  for (const d of map.def.decor ?? []) {
    if (d.kind !== 'shellhole') continue;
    let dup = false;
    for (let yy = Math.floor(d.y) - 2; yy <= Math.floor(d.y) + 2 && !dup; yy++) {
      for (let xx = Math.floor(d.x) - 2; xx <= Math.floor(d.x) + 2; xx++) {
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && craterTiles.has(yy * w + xx)) { dup = true; break; }
      }
    }
    if (dup) continue;
    const ds = (seed + Math.round(d.x * 977) + Math.round(d.y * 131)) | 0;
    const v = d.variant ?? 0;
    stamp(d.x, d.y, 1.3 + (v % 3) * 0.45 + hash2(v, 5, ds) * 0.4);
  }
}

// ------------------------------------------------------------------ public API
function writeTile(field: HeightField, tx: number, ty: number, samples: ArrayLike<number> | number, canopy?: Float32Array): void {
  const R = field.res;
  for (let sy = 0; sy < R; sy++) {
    for (let sx = 0; sx < R; sx++) {
      const i = (ty * R + sy) * field.w + tx * R + sx;
      field.base[i] = typeof samples === 'number' ? samples : samples[sy * R + sx];
      if (canopy) field.canopy[i] = canopy[sy * R + sx];
      compose(field, i);
    }
  }
}

export function buildHeightField(map: GameMap): HeightField {
  const R = HF_RES;
  const w = map.width * R, h = map.height * R;
  const field: HeightField = {
    res: R, w, h,
    base: new Float32Array(w * h), dig: new Float32Array(w * h),
    height: new Float32Array(w * h), canopy: new Float32Array(w * h),
    version: 1, marksApplied: 0,
  };
  const ctx: FieldCtx = { map, buildings: computeBuildings(map), lineSegs: computeLineSegs(map), overrides: new Map() };
  ctxByField.set(field, ctx);

  const tmp = new Float32Array(R * R), can = new Float32Array(R * R);
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      computeTileBase(ctx, tx, ty, tmp);
      tileCanopy(map, tx, ty, can);
      writeTile(field, tx, ty, tmp, can);
    }
  }

  // ---- dig layer: foxholes, trenches, map-placed craters
  const decor = map.def.decor ?? [];
  const foxholeTiles = new Set<number>();
  for (const d of decor) {
    if (d.kind !== 'foxhole') continue;
    foxholeTiles.add(Math.floor(d.y) * map.width + Math.floor(d.x));
    stampFoxhole(field, d.x, d.y, d.angle ?? 0, ((d.variant ?? 0) & 1) === 1);
  }
  const trenchBuckets = ctx.lineSegs.get('trench');
  const stamped = new Set<Seg>();
  const vecSegs: Seg[] = [];
  for (let ti = 0; ti < map.tiles.length; ti++) {
    if (map.tiles[ti] !== 'trench' || foxholeTiles.has(ti)) continue;
    const tx = ti % map.width, ty = (ti / map.width) | 0;
    const near = trenchBuckets?.get(ti)?.filter((s) => distSeg(tx + 0.5, ty + 0.5, s) <= 0.8);
    if (near && near.length) {
      for (const s of near) if (!stamped.has(s)) { stamped.add(s); vecSegs.push(s); }
    } else {
      // a stray trench tile with no vector: the renderer draws an auto-foxhole there
      stampFoxhole(field, tx + 0.5, ty + 0.5, hash2(tx, ty, 5201) * Math.PI * 2, false);
    }
  }
  stampTrenchSegs(field, vecSegs);
  stampMapCraters(map, field);
  syncCraterMarks(map, field);
  field.version = 1;
  return field;
}

/** The map's height field, building it on first use (test maps built by hand have none). */
export function getHeightField(map: GameMap): HeightField {
  if (!map.heightField || !ctxByField.has(map.heightField)) map.heightField = buildHeightField(map);
  return map.heightField;
}

/** Stamps any map.craterMarks not yet in the field (the marks are the one record of every
 * explosion's crater, sized/shrunk by combat.ts's leaveCrater). */
export function syncCraterMarks(map: GameMap, field: HeightField): void {
  const marks = map.craterMarks;
  if (!marks) return;
  for (let k = field.marksApplied; k < marks.length; k++) applyCrater(field, marks[k], marks[k].sizeM);
  field.marksApplied = marks.length;
}

/** Composite surface height (m) at tile coords (x,y), bilinear between samples. */
export function heightAt(field: HeightField, x: number, y: number): number {
  return sampleBilinear(field, field.height, x, y);
}

/** Tree-crown height (m) at tile coords, 0 where there is no canopy. */
export function canopyAt(field: HeightField, x: number, y: number): number {
  return sampleBilinear(field, field.canopy, x, y);
}

function sampleBilinear(field: HeightField, arr: Float32Array, x: number, y: number): number {
  const fx = x * field.res - 0.5, fy = y * field.res - 0.5;
  const x0 = Math.max(0, Math.min(field.w - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(field.h - 1, Math.floor(fy)));
  const x1 = Math.min(field.w - 1, x0 + 1), y1 = Math.min(field.h - 1, y0 + 1);
  const ax = clamp01(fx - x0), ay = clamp01(fy - y0);
  const a = arr[y0 * field.w + x0], b = arr[y0 * field.w + x1], c = arr[y1 * field.w + x0], d = arr[y1 * field.w + x1];
  return (a + (b - a) * ax) + ((c + (d - c) * ax) - (a + (b - a) * ax)) * ay;
}

/** Sets a tile's base profile explicitly (flat height or HF_RES*HF_RES samples). The value is
 * kept as an override, so later refreshes of that tile (e.g. a neighbour changing) keep it. */
export function setTileProfile(field: HeightField, tileX: number, tileY: number, profile: TileProfile): void {
  const ctx = ctxByField.get(field);
  const R = field.res;
  if (tileX < 0 || tileY < 0 || tileX * R >= field.w || tileY * R >= field.h) return;
  if (ctx && typeof profile === 'number') ctx.overrides.set(tileY * (field.w / R) + tileX, profile);
  writeTile(field, tileX, tileY, profile);
  field.version++;
}

/** Drops any explicit profile for a tile and re-derives it from the tile's current terrain;
 * also refreshes its neighbours (hedge/fence links and rubble mounds depend on them). */
export function refreshTile(map: GameMap, tileX: number, tileY: number): void {
  const field = getHeightField(map);
  const ctx = ctxByField.get(field)!;
  ctx.overrides.delete(tileY * map.width + tileX);
  refreshTiles(map, [tileY * map.width + tileX]);
}

/** Re-derives base samples (and canopy) of the given tiles and their 8-neighbours. */
export function refreshTiles(map: GameMap, tileIdxs: Iterable<number>): void {
  const field = getHeightField(map);
  const ctx = ctxByField.get(field)!;
  const todo = new Set<number>();
  for (const ti of tileIdxs) {
    const tx = ti % map.width, ty = (ti / map.width) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = tx + dx, ny = ty + dy;
      if (nx >= 0 && ny >= 0 && nx < map.width && ny < map.height) todo.add(ny * map.width + nx);
    }
  }
  const tmp = new Float32Array(HF_RES * HF_RES), can = new Float32Array(HF_RES * HF_RES);
  for (const ti of todo) {
    const tx = ti % map.width, ty = (ti / map.width) | 0;
    computeTileBase(ctx, tx, ty, tmp);
    tileCanopy(map, tx, ty, can);
    writeTile(field, tx, ty, tmp, can);
  }
  field.version++;
}

/** Flat base override for a tile (breach lip, ruined wall stub) followed by a recompute. */
export function setTileOverride(map: GameMap, tileX: number, tileY: number, heightM: number): void {
  const field = getHeightField(map);
  setTileProfile(field, tileX, tileY, heightM);
}

/** Roof height of a building tile's eave (m), or 0 when unknown — used for collapse messages. */
export function buildingEaveM(map: GameMap, bid: number): number {
  const field = getHeightField(map);
  return ctxByField.get(field)?.buildings.get(bid)?.eave ?? 0;
}

/** True when the building was classified as a big (tenement / city block) footprint. */
export function buildingIsBig(map: GameMap, bid: number): boolean {
  const field = getHeightField(map);
  return ctxByField.get(field)?.buildings.get(bid)?.big ?? false;
}
