// ============================================================================
// growth.ts — tall growth (tall grass, crops) as part of the battlefield's surface.
//   * Standing growth has a height (about a metre). That height is what limits sight through a
//     field: see LOW_GROWTH_HEIGHT_M in los.ts, which scales by how much of a tile still stands.
//   * Vehicles press it down as they drive: under the tracks it is crushed to ground level, and
//     between the tracks it is bent over and stays a little higher. Blasts flatten it too.
//   * The depth map and the pointer's elevation readout show the growth as surface height, so
//     the ruts read as lanes cut into the field.
// Deterministic: no randomness, driven only by vehicle poses and crater marks.
// ============================================================================
import type { BattleState, GameMap, Terrain, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';

export const GROWTH_RES = 4; // samples per tile edge (0.5 m), same grid as the height field
export const GROWTH_HEIGHT_M: Partial<Record<Terrain, number>> = { tallgrass: 1.0, crops: 1.2 };
/** Remaining height share by state: 0 standing, 1 bent over (between the tracks), 2 crushed. */
export const CUT_FACTOR = [1, 0.3, 0] as const;
export const TRACK_WIDTH_M = 0.55;

export interface GrowthField {
  res: number; w: number; h: number;
  /** 0 standing, 1 bent, 2 crushed; per sample */
  cut: Uint8Array;
  /** current growth height (m) per sample, 0 where nothing tall grows */
  heightM: Float32Array;
  /** share of the tile's growth still standing, 0..1 (1 where nothing was touched) */
  tileStanding: Float32Array;
  /** bumped whenever a sample changes */
  version: number;
  marksApplied: number;
}

const fields = new WeakMap<GameMap, GrowthField>();

export function getGrowth(map: GameMap): GrowthField {
  let f = fields.get(map);
  if (f) return f;
  const R = GROWTH_RES, w = map.width * R, h = map.height * R;
  f = { res: R, w, h, cut: new Uint8Array(w * h), heightM: new Float32Array(w * h), tileStanding: new Float32Array(map.width * map.height).fill(1), version: 1, marksApplied: 0 };
  for (let ty = 0; ty < map.height; ty++) for (let tx = 0; tx < map.width; tx++) {
    const gh = GROWTH_HEIGHT_M[map.tiles[ty * map.width + tx]];
    if (!gh) continue;
    for (let sy = 0; sy < R; sy++) for (let sx = 0; sx < R; sx++) f.heightM[(ty * R + sy) * w + tx * R + sx] = gh;
  }
  fields.set(map, f);
  return f;
}

/** Share (0..1) of this tile's tall growth that still stands. 1 for untouched or growth-free tiles. */
export function tileStanding(map: GameMap, tileIndex: number): number {
  const f = fields.get(map);
  return f ? f.tileStanding[tileIndex] : 1;
}

/** Growth height (m) at tile coords: nearest 0.5 m sample. */
export function growthHeightAt(map: GameMap, x: number, y: number): number {
  const f = getGrowth(map);
  const sx = Math.floor(x * f.res), sy = Math.floor(y * f.res);
  if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) return 0;
  return f.heightM[sy * f.w + sx];
}

function setCut(map: GameMap, f: GrowthField, sx: number, sy: number, level: 1 | 2, dirty: Set<number>): void {
  if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) return;
  const i = sy * f.w + sx;
  if (f.cut[i] >= level) return;
  const ti = Math.floor(sy / f.res) * map.width + Math.floor(sx / f.res);
  const gh = GROWTH_HEIGHT_M[map.tiles[ti]];
  if (!gh) return;
  f.cut[i] = level;
  f.heightM[i] = gh * CUT_FACTOR[level];
  dirty.add(ti);
}

function settle(map: GameMap, f: GrowthField, dirty: Set<number>): void {
  if (dirty.size === 0) return;
  const R = f.res;
  for (const ti of dirty) {
    const tx = ti % map.width, ty = (ti / map.width) | 0;
    let sum = 0;
    for (let sy = 0; sy < R; sy++) for (let sx = 0; sx < R; sx++) sum += CUT_FACTOR[f.cut[(ty * R + sy) * f.w + tx * R + sx]];
    f.tileStanding[ti] = sum / (R * R);
  }
  f.version++;
}

/** Press the growth down under a vehicle's footprint: crushed under both tracks, bent between. */
export function flattenUnderVehicle(map: GameMap, pos: Vec2, facing: number, lengthM: number, widthM: number): void {
  const f = getGrowth(map);
  const R = f.res, stepM = TILE_M / R;
  const hl = lengthM / 2, hw = widthM / 2;
  const fx = Math.sin(facing), fy = -Math.cos(facing), rx = Math.cos(facing), ry = Math.sin(facing);
  const reachT = (Math.hypot(hl, hw) + stepM) / TILE_M;
  const x0 = Math.floor((pos.x - reachT) * R), x1 = Math.ceil((pos.x + reachT) * R);
  const y0 = Math.floor((pos.y - reachT) * R), y1 = Math.ceil((pos.y + reachT) * R);
  const dirty = new Set<number>();
  for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
    const dxM = ((sx + 0.5) / R - pos.x) * TILE_M, dyM = ((sy + 0.5) / R - pos.y) * TILE_M;
    const along = dxM * fx + dyM * fy, across = dxM * rx + dyM * ry;
    if (Math.abs(along) > hl || Math.abs(across) > hw) continue;
    // a sample is 0.5 m wide: count it as track when its centre is within the track band, padded
    // by a quarter sample so a 0.55 m track never slips between sample centres
    setCut(map, f, sx, sy, Math.abs(across) >= hw - TRACK_WIDTH_M - stepM * 0.25 ? 2 : 1, dirty);
  }
  settle(map, f, dirty);
}

/** A blast lays the growth flat: crushed inside the crater, bent over in a ring around it. */
export function flattenByBlast(map: GameMap, pos: Vec2, sizeM: number): void {
  const f = getGrowth(map);
  const R = f.res, inner = sizeM * 0.6, outer = sizeM * 1.3;
  const reachT = outer / TILE_M;
  const dirty = new Set<number>();
  for (let sy = Math.floor((pos.y - reachT) * R); sy <= Math.ceil((pos.y + reachT) * R); sy++) {
    for (let sx = Math.floor((pos.x - reachT) * R); sx <= Math.ceil((pos.x + reachT) * R); sx++) {
      const d = Math.hypot(((sx + 0.5) / R - pos.x) * TILE_M, ((sy + 0.5) / R - pos.y) * TILE_M);
      if (d <= inner) setCut(map, f, sx, sy, 2, dirty); else if (d <= outer) setCut(map, f, sx, sy, 1, dirty);
    }
  }
  settle(map, f, dirty);
}

/** Per sim step: every vehicle standing or driving in tall growth presses it down, and new
 * craters flatten what grew there. */
export function stepGrowth(state: BattleState): void {
  const map = state.map;
  let f: GrowthField | null = null;
  for (const v of state.vehicles.values()) {
    const t = map.tiles[Math.floor(v.pos.y) * map.width + Math.floor(v.pos.x)];
    // the footprint can reach growth while the centre is still on the road beside it, so only
    // skip the work when the map has no tall growth near at all: cheap test on the centre and ends
    const def = VEHICLE_DEFS[v.defId];
    const len = def?.lengthM ?? 6, wid = def?.widthM ?? 3;
    const hx = Math.sin(v.hullFacing) * (len / 2 / TILE_M), hy = -Math.cos(v.hullFacing) * (len / 2 / TILE_M);
    const tA = map.tiles[Math.floor(v.pos.y + hy) * map.width + Math.floor(v.pos.x + hx)];
    const tB = map.tiles[Math.floor(v.pos.y - hy) * map.width + Math.floor(v.pos.x - hx)];
    if (!GROWTH_HEIGHT_M[t] && !GROWTH_HEIGHT_M[tA] && !GROWTH_HEIGHT_M[tB]) continue;
    flattenUnderVehicle(map, v.pos, v.hullFacing, len, wid);
  }
  const marks = map.craterMarks;
  if (marks && marks.length) {
    f = getGrowth(map);
    for (let k = f.marksApplied; k < marks.length; k++) flattenByBlast(map, marks[k], marks[k].sizeM);
    f.marksApplied = marks.length;
  }
}
