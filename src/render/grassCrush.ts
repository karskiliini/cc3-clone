// ============================================================================
// grassCrush.ts — where tall growth has been driven flat: a map-sized grid of
// 0.5 m cells (level + travel direction) that the 3D grass reads. GrassFx
// stamps it together with its painted wake, so the two always agree.
// Render side only; never read by the sim.
// ============================================================================
import type { GameMap, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';

export const CRUSH_CELL_M = 0.5;
const PER_TILE = TILE_M / CRUSH_CELL_M;
const TAU = Math.PI * 2;

/** level 0..1 (1 = flat), dirRad = the way it was pressed (0 = north, clockwise) */
export interface Crush { level: number; dirRad: number }

export class CrushMap {
  readonly cols: number;
  readonly rows: number;
  // allocated on the first stamp: most battles never drive through a field
  private level: Uint8Array | null = null;
  private dir: Uint8Array | null = null;

  constructor(widthTiles: number, heightTiles: number) {
    this.cols = Math.ceil(widthTiles * PER_TILE);
    this.rows = Math.ceil(heightTiles * PER_TILE);
  }

  /** Flattens the band swept from `from` to `to` (tile coords), halfWidthM either side of the line. */
  stampBand(from: Vec2, to: Vec2, halfWidthM: number): void {
    const ax = from.x * TILE_M, az = from.y * TILE_M, bx = to.x * TILE_M, bz = to.y * TILE_M;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-4) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const dirRad = Math.atan2(ux, -uz);
    const q = Math.round(((((dirRad % TAU) + TAU) % TAU) / TAU) * 256) & 255;
    this.level ??= new Uint8Array(this.cols * this.rows);
    this.dir ??= new Uint8Array(this.cols * this.rows);
    const r = halfWidthM;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / CRUSH_CELL_M));
    const c1 = Math.min(this.cols - 1, Math.floor((Math.max(ax, bx) + r) / CRUSH_CELL_M));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz) - r) / CRUSH_CELL_M));
    const r1 = Math.min(this.rows - 1, Math.floor((Math.max(az, bz) + r) / CRUSH_CELL_M));
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        const px = (i + 0.5) * CRUSH_CELL_M - ax, pz = (j + 0.5) * CRUSH_CELL_M - az;
        const t = px * ux + pz * uz, n = Math.abs(-px * uz + pz * ux);
        if (t < 0 || t > len || n > r) continue;
        const k = j * this.cols + i;
        this.level[k] = 255;
        this.dir[k] = q;
      }
    }
  }

  at(p: Vec2): Crush | null {
    if (!this.level || !this.dir) return null;
    const i = Math.floor(p.x * PER_TILE), j = Math.floor(p.y * PER_TILE);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return null;
    const k = j * this.cols + i, l = this.level[k];
    return l ? { level: l / 255, dirRad: (this.dir[k] / 256) * TAU } : null;
  }

  clear(): void { this.level = null; this.dir = null; }
}

const maps = new WeakMap<GameMap, CrushMap>();

/** The battle map's crush grid (one per map object; a new battle's map gets a fresh one). */
export function crushMapFor(map: GameMap): CrushMap {
  let c = maps.get(map);
  if (!c) { c = new CrushMap(map.width, map.height); maps.set(map, c); }
  return c;
}
