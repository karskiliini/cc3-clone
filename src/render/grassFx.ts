// ============================================================================
// grassFx.ts — tall growth reacts to what moves through it (render side only).
//   * Vehicles and men standing in tall grass or crops SINK into it: blades are drawn over the
//     lower edge of the figure, so a tank no longer seems to float on top of the field.
//   * Vehicles leave a wake of flattened growth: two crushed ruts and a bent-over band between
//     them, stamped into a half-resolution map-sized layer as they advance.
// Trails are stamped only for vehicles the player can see, so a rut never betrays a hidden enemy.
// Nothing here feeds back into the simulation.
// ============================================================================
import type { BattleState, Camera, Season, Side, Terrain, Vec2 } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { worldToScreen } from '@/engine/camera';
import { tileAt } from '@/sim/map';
import { hash2 } from '@/shared/rng';

export type TallGrowth = 'tallgrass' | 'crops';
export function tallGrowthAt(state: BattleState, p: Vec2): TallGrowth | null {
  const t: Terrain = tileAt(state.map, Math.floor(p.x), Math.floor(p.y));
  return t === 'tallgrass' || t === 'crops' ? t : null;
}

/** Standing blades (dark to light) and the paler, straw-like tone of growth pressed flat. */
const BLADES: Record<'summer' | 'autumn' | 'winter', Record<TallGrowth, { up: string[]; flat: string; rut: string }>> = {
  summer: {
    tallgrass: { up: ['#4c5823', '#5c6829', '#6e7831', '#80883b'], flat: '#8f9450', rut: '#4a4a24' },
    crops: { up: ['#8f8438', '#9a8f3f', '#a39847', '#b8a850'], flat: '#c2b26a', rut: '#6a5a2c' },
  },
  autumn: {
    tallgrass: { up: ['#726a2a', '#847a34', '#948a3e', '#a4993f'], flat: '#b0a45a', rut: '#574c22' },
    crops: { up: ['#9a7f2c', '#a68a34', '#b0953c', '#c0a548'], flat: '#c9b468', rut: '#6a5426' },
  },
  winter: {
    tallgrass: { up: ['#9a9478', '#b4b09a', '#c9d0da', '#dfe4ea'], flat: '#e6e9ee', rut: '#8e9098' },
    crops: { up: ['#a09a7c', '#bcb8a2', '#d2d8e2', '#e4e8ee'], flat: '#e8ebf0', rut: '#94969e' },
  },
};
function seasonKey(season: Season | undefined): 'summer' | 'autumn' | 'winter' {
  return season === 'winter' ? 'winter' : season === 'autumn' ? 'autumn' : 'summer';
}

/** Corners-free description of a vehicle's footprint for stamping and for the sink fringe. */
export interface Footprint { pos: Vec2; facing: number; lengthM: number; widthM: number }

/** Distance (tiles) a vehicle must cover before the next wake stamp. */
export const STAMP_STEP_TILES = 0.35;

/** Pure: should a new stamp be laid, given where the last one went? */
export function needsStamp(last: Vec2 | undefined, pos: Vec2): boolean {
  return !last || Math.hypot(pos.x - last.x, pos.y - last.y) >= STAMP_STEP_TILES;
}

const TRAIL_PX_PER_TILE = 10; // half the terrain resolution: crushed growth is soft anyway

export class GrassFx {
  private trail: HTMLCanvasElement | null = null;
  private tctx: CanvasRenderingContext2D | null = null;
  private last = new Map<number, Vec2>();
  private lastTime = -1;
  private mapRef: unknown = null;

  private reset(): void { this.trail = null; this.tctx = null; this.last.clear(); }

  /** Lay wake stamps for visible vehicles moving through tall growth. Call once per frame. */
  update(state: BattleState, playerSide: Side): void {
    if (state.map !== this.mapRef || state.time < this.lastTime - 0.5) { this.reset(); this.mapRef = state.map; }
    this.lastTime = state.time;
    const season = seasonKey(state.map.def?.season);
    for (const v of state.vehicles.values()) {
      if (v.side !== playerSide && !state.spottedVehicles[playerSide].has(v.id)) continue;
      const growth = tallGrowthAt(state, v.pos);
      const prev = this.last.get(v.id);
      if (!growth) { if (prev) this.last.set(v.id, { ...v.pos }); continue; }
      if (!needsStamp(prev, v.pos)) continue;
      // a vehicle first seen standing still in the field has no wake yet: just remember it
      if (prev) this.stamp(state, { pos: v.pos, facing: v.hullFacing, lengthM: VEHICLE_DEFS[v.defId]?.lengthM ?? 6, widthM: VEHICLE_DEFS[v.defId]?.widthM ?? 3 }, growth, season, prev);
      this.last.set(v.id, { ...v.pos });
    }
  }

  private ensure(state: BattleState): CanvasRenderingContext2D | null {
    if (this.tctx) return this.tctx;
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = state.map.width * TRAIL_PX_PER_TILE;
    c.height = state.map.height * TRAIL_PX_PER_TILE;
    this.trail = c;
    this.tctx = c.getContext('2d');
    return this.tctx;
  }

  private stamp(state: BattleState, f: Footprint, growth: TallGrowth, season: 'summer' | 'autumn' | 'winter', from: Vec2): void {
    const g = this.ensure(state);
    if (!g) return;
    const k = TRAIL_PX_PER_TILE, mPx = k / TILE_M;
    const pal = BLADES[season][growth];
    // the wake runs from the previous stamp to the vehicle's tail, along the path actually driven
    const dx = f.pos.x - from.x, dy = f.pos.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    const ang = Math.atan2(dx, -dy); // 0 = north, clockwise
    const halfW = (f.widthM / 2) * mPx;
    const trackW = Math.max(1.2, 0.5 * mPx);
    const tail = (f.lengthM / 2) * mPx;
    g.save();
    g.translate(from.x * k, from.y * k);
    g.rotate(ang);
    const L = len * k;
    // in this frame "forward" is -y; the stretch just vacated lies behind the tail
    const y0 = tail, y1 = tail - L - 1;
    // bent-over band between the tracks: pale, low contrast, streaked along the travel direction
    g.globalAlpha = 0.2;
    g.fillStyle = pal.flat;
    g.fillRect(-halfW, y1, halfW * 2, y0 - y1);
    g.globalAlpha = 0.5;
    g.strokeStyle = pal.flat;
    g.lineWidth = 0.6;
    const seed = Math.floor(from.x * 7.3 + from.y * 13.1);
    for (let i = 0; i < 7; i++) {
      const x = -halfW + (hash2(i, seed, 11) * 2 * halfW);
      g.beginPath(); g.moveTo(x, y0); g.lineTo(x + (hash2(i, seed, 12) - 0.5) * 1.2, y1); g.stroke();
    }
    // crushed ruts under the tracks: darker, earth shows through
    g.globalAlpha = 0.42;
    g.fillStyle = pal.rut;
    g.fillRect(-halfW, y1, trackW, y0 - y1);
    g.fillRect(halfW - trackW, y1, trackW, y0 - y1);
    // a pale lip of pressed stalks outside each rut
    g.globalAlpha = 0.45;
    g.fillStyle = pal.flat;
    g.fillRect(-halfW - 0.8, y1, 0.8, y0 - y1);
    g.fillRect(halfW, y1, 0.8, y0 - y1);
    g.restore();
  }

  /** The flattened wakes. Draw after the terrain and before the units. */
  drawTrails(ctx: CanvasRenderingContext2D, cam: Camera): void {
    if (!this.trail) return;
    const tilePx = TILE_PX * cam.zoom;
    const sx = cam.x * TRAIL_PX_PER_TILE, sy = cam.y * TRAIL_PX_PER_TILE;
    const sw = (VIEW_W / tilePx) * TRAIL_PX_PER_TILE, sh = (VIEW_H / tilePx) * TRAIL_PX_PER_TILE;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.trail, sx, sy, sw, sh, 0, 0, VIEW_W, VIEW_H);
    ctx.imageSmoothingEnabled = prev;
  }

  /** Blades in front of everything standing in tall growth. Draw after the units. */
  drawStanding(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
    const season = seasonKey(state.map.def?.season);
    const z = cam.zoom, mPx = (TILE_PX * z) / TILE_M;
    ctx.save();
    ctx.lineCap = 'butt';
    for (const v of state.vehicles.values()) {
      if (v.side !== playerSide && !state.spottedVehicles[playerSide].has(v.id)) continue;
      const growth = tallGrowthAt(state, v.pos);
      if (!growth) continue;
      const p = worldToScreen(cam, v.pos);
      if (p.x < -80 || p.y < -80 || p.x > VIEW_W + 80 || p.y > VIEW_H + 80) continue;
      const def = VEHICLE_DEFS[v.defId];
      this.fringe(ctx, p, v.hullFacing, (def?.lengthM ?? 6) * mPx, (def?.widthM ?? 3) * mPx, BLADES[season][growth].up, z, v.pos, growth === 'crops' ? 1.15 : 1);
    }
    for (const s of state.soldiers.values()) {
      if (s.vehicleId != null || s.health === 'dead') continue;
      if (s.side !== playerSide && !state.spotted[playerSide].has(s.id)) continue;
      const growth = tallGrowthAt(state, s.pos);
      if (!growth) continue;
      const p = worldToScreen(cam, s.pos);
      if (p.x < -20 || p.y < -20 || p.x > VIEW_W + 20 || p.y > VIEW_H + 20) continue;
      this.tuft(ctx, p, BLADES[season][growth].up, z, s.pos, s.stance === 'prone' ? 1.5 : 1);
    }
    ctx.restore();
  }

  /** Blades all round a hull, leaning in over its edge; thickest on the near (screen-south) side,
   * because the camera looks slightly from the south and the growth stands between it and the hull. */
  private fringe(ctx: CanvasRenderingContext2D, c: Vec2, facing: number, lenPx: number, widPx: number, cols: string[], z: number, world: Vec2, tall: number): void {
    const fx = Math.sin(facing), fy = -Math.cos(facing); // forward
    const rx = Math.cos(facing), ry = Math.sin(facing);  // right
    const hl = lenPx / 2, hw = widPx / 2;
    const step = 1.6 * z;
    const wseed = Math.floor(world.x * 2) * 31 + Math.floor(world.y * 2) * 17;
    let n = 0;
    const edge = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number): void => {
      const L = Math.hypot(bx - ax, by - ay), count = Math.max(1, Math.floor(L / step));
      // outward normal pointing down-screen = the near side: taller, denser blades
      const near = Math.max(0, ny);
      for (let i = 0; i <= count; i++) {
        const t = i / count, h1 = hash2(n, wseed, 5), h2 = hash2(n, wseed, 6), h3 = hash2(n++, wseed, 7);
        if (h3 > 0.4 + near * 0.45) continue;
        const out = (0.5 + h2 * 2.5) * z; // blades start at uneven distances outside the hull
        const bx0 = ax + (bx - ax) * t + nx * out + (h1 - 0.5) * step * 2.4;
        const by0 = ay + (by - ay) * t + ny * out;
        const reach = (1.5 + near * 2.6 + h2 * h2 * 4.5) * z * tall;
        // mostly the darker tones: the light ones are the rare sunlit tips
        ctx.strokeStyle = cols[Math.min(cols.length - 1, Math.floor(h1 * h1 * cols.length))];
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = Math.max(1, z * 0.9);
        ctx.beginPath();
        ctx.moveTo(bx0, by0);
        // blades stand up (up-screen) and lean in over the hull edge
        ctx.lineTo(bx0 - nx * reach * 0.7 + (h3 - 0.2) * 3 * z, by0 - ny * reach * 0.7 - reach * 0.5);
        ctx.stroke();
      }
    };
    const corner = (a: number, b: number): [number, number] => [c.x + fx * a * hl + rx * b * hw, c.y + fy * a * hl + ry * b * hw];
    const [flx, fly] = corner(1, -1), [frx, fry] = corner(1, 1), [blx, bly] = corner(-1, -1), [brx, bry] = corner(-1, 1);
    edge(flx, fly, frx, fry, fx, fy);     // front
    edge(brx, bry, blx, bly, -fx, -fy);   // rear
    edge(frx, fry, brx, bry, rx, ry);     // right side
    edge(blx, bly, flx, fly, -rx, -ry);   // left side
  }

  /** A few blades across a man's lower half; a prone man is nearly covered. */
  private tuft(ctx: CanvasRenderingContext2D, p: Vec2, cols: string[], z: number, world: Vec2, spread: number): void {
    const wseed = Math.floor(world.x * 4) * 29 + Math.floor(world.y * 4) * 13;
    const count = Math.round(5 * spread);
    for (let i = 0; i < count; i++) {
      const h1 = hash2(i, wseed, 21), h2 = hash2(i, wseed, 22);
      const x = p.x + (h1 - 0.5) * 9 * z * spread, y = p.y + (2 + h2 * 3) * z;
      ctx.strokeStyle = cols[i % cols.length];
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1, z * 0.8);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (h2 - 0.5) * 2 * z, y - (3.5 + h1 * 2.5) * z);
      ctx.stroke();
    }
  }
}
