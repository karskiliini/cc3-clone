// ============================================================================
// visibilityOverlay.ts — "what can my selected units see?" map overlay.
//
// For the selected friendly teams, every map cell in (and just around) the viewport is scored with
// the sim's own spotting rules (observerStandingSpotScore in sim/spotting.ts), taking the best
// score over all eligible spotters of those teams (dismounted soldiers; a vehicle contributes one
// spotter per living crewman's eye — turret ring, hull front — each with its own facing arc, so a
// selected buttoned-up tank visibly shows its blind flanks on the overlay, see sim/vehicleVision.ts):
//   - score >= 0.5  -> a standing enemy there is spotted for certain: left untouched
//   - 0 < score < 0.5 -> only a per-tick chance (concealment / distance / facing): light dark-green
//   - score 0       -> out of detection range or LOS blocked: darkened ~40%
//
// ASSUMPTION: each cell is evaluated for a *standing, stationary, non-firing enemy soldier* at the
// cell centre (stance factor 1, no movement/firing bonus), so the overlay answers "could I see an
// enemy standing there?". Prone/sneaking enemies are harder to see; moving or firing ones easier.
// Enemy *vehicles* use the longer 400 m range, so they may be spotted a little beyond the ring.
//
// Rendering: the sim's LOS is tile-quantised (losTrace floors both ends), so sampling inside a tile
// cannot reveal extra geometry — every tile-centre score is the ground truth. To avoid a tile-grid
// staircase, the per-cell "blocked" and "certain" masks are bilinearly interpolated between cell
// centres at SUB px per cell and passed through a narrow smoothstep: the class boundary becomes an
// iso-contour that runs diagonally between tile centres (never more than half a cell from the
// sim's own boundary), and a small box blur feathers it. Cell centres deep inside a region keep
// exactly their class shade. Computation is time-sliced; rasterising happens once per pass, so
// the steady-state per-frame cost is a single drawImage.
// ============================================================================
import type { BattleState, Camera, Side } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { losTrace } from '@/sim/los';
import {
  collectSpotters, observerStandingSpotScore, SOLDIER_SPOT_RANGE_M, spotterEyeM, type Spotter,
} from '@/sim/spotting';

/** Spot score at/above which a standing enemy is spotted every tick (updateSpotting's bestP >= 0.5). */
export const CERTAIN_SPOT_SCORE = 0.5;

export const VIS_CLEAR = 0;
export const VIS_OBSCURED = 1;
export const VIS_BLOCKED = 2;

const MARGIN_TILES = 8;
/** Region origin/extent snap, so small camera moves inside the margin don't force a recompute. */
const REGION_SNAP = 8;
const CHECK_INTERVAL_MS = 250;
const FRAME_BUDGET_MS = 6;

/** Raster pixels per cell edge. */
const SUB = 4;
const BLOCKED_ALPHA = 0.42;
/** Green tint: strongest where barely visible, lighter approaching the certain-spot threshold. */
const OBSCURED_ALPHA_MAX = 0.34;
const OBSCURED_ALPHA_MIN = 0.16;
const OBSCURED_RGB = [18, 70, 22] as const;
/** Spotter moves beyond this many tiles from the snapshot trigger a recompute. */
const MOVE_EPS_TILES = 0.5;

export interface VisRegion { x0: number; y0: number; cols: number; rows: number; step: number }

/** One group of spotters sharing a start tile: losTrace depends only on start/end tiles plus the
 * distance falloff, so the group shares one trace (exactly what updateSpotting's tile-keyed LOS
 * cache does) while the range, always-spot and mind factors stay per soldier. */
export interface SpotterGroup { members: Spotter[] }

export function groupSpotters(spotters: Spotter[]): SpotterGroup[] {
  const byTile = new Map<number, SpotterGroup>();
  for (const sp of spotters) {
    const key = Math.floor(sp.pos.x) * 100003 + Math.floor(sp.pos.y);
    let g = byTile.get(key);
    if (!g) { g = { members: [] }; byTile.set(key, g); }
    g.members.push(sp);
  }
  // tallest eye first: terrain masking is monotone in eye height, so if the tallest member's
  // trace is blocked every shorter member in the same tile is blocked too — which keeps the
  // `if (vis === 0) break` early-out below correct for mixed-stance groups.
  for (const g of byTile.values()) g.members.sort((a, b) => spotterEyeM(b) - spotterEyeM(a));
  return [...byTile.values()];
}

/** Best standing-target spot score at (tx, ty) over the spotters, capped at CERTAIN_SPOT_SCORE
 * (the search stops as soon as any spotter reaches it). 0 = out of range or blocked. */
export function visibilityScore(state: BattleState, groups: SpotterGroup[] | Spotter[], tx: number, ty: number): number {
  const gs: SpotterGroup[] = groups.length > 0 && 'members' in groups[0] ? groups as SpotterGroup[] : groupSpotters(groups as Spotter[]);
  const target = { x: tx, y: ty };
  const rangeTiles = SOLDIER_SPOT_RANGE_M / TILE_M;
  const rangeSq = rangeTiles * rangeTiles;
  let best = 0;
  for (const g of gs) {
    // Terrain masking makes the trace depend on the observer's eye height as well as his tile,
    // so the per-group memo is keyed by eye height: a prone rifleman and the tank beside him
    // genuinely see different ground behind a crest.
    let visEye = NaN, vis = -1;
    const losFor = (from: { x: number; y: number }, to: { x: number; y: number }, eyeM = 1.7, targetM = 1.7): number => {
      if (vis < 0 || visEye !== eyeM) { vis = losTrace(state.map, from, to, { eyeM, targetM }).visibility; visEye = eyeM; }
      return vis;
    };
    for (const sp of g.members) {
      const dx = sp.pos.x - tx, dy = sp.pos.y - ty;
      if (dx * dx + dy * dy > rangeSq) continue; // cheap pre-check (same test observerVisibility does)
      const score = observerStandingSpotScore(state, sp, target, losFor);
      if (score > best) {
        best = score;
        if (best >= CERTAIN_SPOT_SCORE) return CERTAIN_SPOT_SCORE;
      }
      // A vehicle eye can score 0 from its facing arc alone, without `losFor` (and so `vis`) ever
      // being consulted for it — `vis` would then be stale from a *different* member's eyeM, and
      // breaking on it could wrongly skip a shorter member with a real (unblocked) view. Only take
      // the early-out for plain point spotters, where `vis` always reflects this member's own trace.
      if (vis === 0 && !sp.vehicleEye) break; // LOS from this tile is blocked for every (point) member
    }
  }
  return best;
}

/** Visibility class of one target point (clear = certain spot, obscured = chance, blocked = never). */
export function classifyVisibility(state: BattleState, groups: SpotterGroup[] | Spotter[], tx: number, ty: number): number {
  const v = visibilityScore(state, groups, tx, ty);
  return v >= CERTAIN_SPOT_SCORE ? VIS_CLEAR : v > 0 ? VIS_OBSCURED : VIS_BLOCKED;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
};

/**
 * Rasterises per-cell scores (cols x rows, row-major) into RGBA at SUB px per cell: bilinear
 * interpolation of the blocked / certain masks between cell centres, a narrow smoothstep to form a
 * soft contour, then a 3x3 box blur (radius ~1/4 cell). Pure; exported for tests.
 */
export function rasterizeScores(scores: Float32Array, cols: number, rows: number, sub = SUB): { data: Uint8ClampedArray; w: number; h: number } {
  const w = cols * sub, h = rows * sub;
  // per-pixel alpha of the black and green layers
  const aB = new Float32Array(w * h);
  const aG = new Float32Array(w * h);
  const n = cols * rows;
  const blocked = new Float32Array(n), certain = new Float32Array(n), partial = new Float32Array(n), tint = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = scores[i];
    blocked[i] = v <= 0 ? 1 : 0;
    certain[i] = v >= CERTAIN_SPOT_SCORE ? 1 : 0;
    partial[i] = 1 - blocked[i] - certain[i];
    // partial band grades by score; blocked/certain cells borrow the band's ends for smooth mixing
    tint[i] = OBSCURED_ALPHA_MAX + (OBSCURED_ALPHA_MIN - OBSCURED_ALPHA_MAX) * Math.min(1, Math.max(0, v / CERTAIN_SPOT_SCORE));
  }
  // 1) bilinear masks between cell centres
  const mB = new Float32Array(w * h), mP = new Float32Array(w * h), mG = new Float32Array(w * h);
  for (let py = 0; py < h; py++) {
    const fy = (py + 0.5) / sub - 0.5;
    let y0 = Math.floor(fy); const ty = fy - y0;
    let y1 = y0 + 1;
    if (y0 < 0) y0 = 0; if (y1 > rows - 1) y1 = rows - 1;
    for (let px = 0; px < w; px++) {
      const fx = (px + 0.5) / sub - 0.5;
      let x0 = Math.floor(fx); const tx = fx - x0;
      let x1 = x0 + 1;
      if (x0 < 0) x0 = 0; if (x1 > cols - 1) x1 = cols - 1;
      const i00 = y0 * cols + x0, i10 = y0 * cols + x1, i01 = y1 * cols + x0, i11 = y1 * cols + x1;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const o = py * w + px;
      mB[o] = blocked[i00] * w00 + blocked[i10] * w10 + blocked[i01] * w01 + blocked[i11] * w11;
      mP[o] = partial[i00] * w00 + partial[i10] * w10 + partial[i01] * w01 + partial[i11] * w11;
      mG[o] = tint[i00] * w00 + tint[i10] * w10 + tint[i01] * w01 + tint[i11] * w11;
    }
  }
  // 2) round the tile staircase: blur the masks (two box passes, radius ~1/4 cell each, i.e. a
  //    kernel spanning about one cell) before thresholding, so iso-contours become smooth curves
  const boxBlur = (src: Float32Array, rad: number): Float32Array => {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const k = 2 * rad + 1;
    for (let y = 0; y < h; y++) {
      const r = y * w;
      let acc = 0;
      for (let x = -rad - 1; x < rad; x++) acc += src[r + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        acc += src[r + Math.min(w - 1, x + rad)] - src[r + Math.max(0, x - rad - 1)];
        tmp[r + x] = acc / k;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -rad - 1; y < rad; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        acc += tmp[Math.min(h - 1, y + rad) * w + x] - tmp[Math.max(0, y - rad - 1) * w + x];
        out[y * w + x] = acc / k;
      }
    }
    return out;
  };
  const rad = Math.max(1, Math.round(sub / 4));
  const sB = boxBlur(boxBlur(mB, rad), rad), sP = boxBlur(boxBlur(mP, rad), rad);
  for (let o = 0; o < w * h; o++) {
    const bs = smooth(0.3, 0.7, sB[o]), ps = smooth(0.3, 0.7, sP[o]);
    aB[o] = BLOCKED_ALPHA * bs;
    // green only where the partial band itself dominates: no green seam on blocked/clear edges
    aG[o] = mG[o] * ps * (1 - bs);
  }
  // 3) light feather of the final contour
  const B = boxBlur(aB, 1), G = boxBlur(aG, 1);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let o = 0, q = 0; o < w * h; o++, q += 4) {
    const a = B[o] + G[o] * (1 - B[o]);
    if (a <= 0.002) continue;
    const gShare = (G[o] * (1 - B[o])) / a; // black contributes rgb 0
    data[q] = OBSCURED_RGB[0] * gShare;
    data[q + 1] = OBSCURED_RGB[1] * gShare;
    data[q + 2] = OBSCURED_RGB[2] * gShare;
    data[q + 3] = a * 255;
  }
  return { data, w, h };
}

/** The cell grid the overlay computes for this camera: viewport plus a margin, snapped, clamped
 * to the map; one cell per tile at zoom 1-2, 2x2 tiles at zoom 0.5. */
export function overlayRegion(mapW: number, mapH: number, cam: Camera): VisRegion {
  const step = cam.zoom <= 0.5 ? 2 : 1;
  const px = TILE_PX * cam.zoom;
  const snap = REGION_SNAP;
  const vx0 = Math.max(0, Math.floor((cam.x - MARGIN_TILES) / snap) * snap);
  const vy0 = Math.max(0, Math.floor((cam.y - MARGIN_TILES) / snap) * snap);
  const vx1 = Math.min(mapW, Math.ceil((cam.x + VIEW_W / px + MARGIN_TILES) / snap) * snap);
  const vy1 = Math.min(mapH, Math.ceil((cam.y + VIEW_H / px + MARGIN_TILES) / snap) * snap);
  return { x0: vx0, y0: vy0, cols: Math.max(1, Math.ceil((vx1 - vx0) / step)), rows: Math.max(1, Math.ceil((vy1 - vy0) / step)), step };
}

interface SpotterSnap { x: number; y: number; facing: number; threat: number | null; beliefs: number[] }

interface Job {
  teamKey: string;
  region: VisRegion;
  groups: SpotterGroup[];
  scores: Float32Array;
  next: number;
  spentMs: number;
  frames: number;
  /** scores done; rasterise next frame (this one's budget is spent) */
  rasterPending: boolean;
}

/** Everything a pass depended on, compared with hysteresis to decide whether to recompute. */
interface PassInputs {
  teamKey: string;
  region: VisRegion;
  spotters: SpotterSnap[];
  terrainHash: number;
}

export interface VisOverlayStats {
  /** total compute time of the last completed pass, ms (summed over frames, incl. rasterising) */
  lastPassMs: number;
  lastPassRasterMs: number;
  lastPassFrames: number;
  lastPassCells: number;
  lastPassSpotters: number;
  passes: number;
}

function snapSpotters(spotters: Spotter[]): SpotterSnap[] {
  return spotters.map((sp) => ({
    x: sp.pos.x, y: sp.pos.y,
    facing: sp.soldier ? sp.soldier.facing : -1,
    threat: sp.soldier ? sp.soldier.mind.threatDir : null,
    beliefs: sp.soldier ? sp.soldier.mind.beliefs.flatMap((b) => [b.pos.x, b.pos.y]) : [],
  }));
}

function spottersChanged(a: SpotterSnap[], b: SpotterSnap[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    if (Math.abs(p.x - q.x) > MOVE_EPS_TILES || Math.abs(p.y - q.y) > MOVE_EPS_TILES) return true;
    if (p.facing !== q.facing) return true;
    if ((p.threat == null) !== (q.threat == null)) return true;
    if (p.threat != null && q.threat != null && Math.abs(p.threat - q.threat) > 0.1) return true;
    if (p.beliefs.length !== q.beliefs.length) return true;
    for (let k = 0; k < p.beliefs.length; k++) if (Math.abs(p.beliefs[k] - q.beliefs[k]) > 1) return true;
  }
  return false;
}

function sameRegion(a: VisRegion, b: VisRegion): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.cols === b.cols && a.rows === b.rows && a.step === b.step;
}

/** Terrain + smoke hash over the only tiles any sight line of this pass can cross: the bounding
 * box of the spotters and the region. Smoke is quantised to 1/8 density steps. */
export function sightTerrainHash(state: BattleState, spotters: Spotter[], r: VisRegion): number {
  const map = state.map;
  let bx0 = r.x0, by0 = r.y0, bx1 = r.x0 + r.cols * r.step, by1 = r.y0 + r.rows * r.step;
  for (const sp of spotters) {
    bx0 = Math.min(bx0, Math.floor(sp.pos.x)); by0 = Math.min(by0, Math.floor(sp.pos.y));
    bx1 = Math.max(bx1, Math.floor(sp.pos.x) + 1); by1 = Math.max(by1, Math.floor(sp.pos.y) + 1);
  }
  bx0 = Math.max(0, bx0); by0 = Math.max(0, by0); bx1 = Math.min(map.width, bx1); by1 = Math.min(map.height, by1);
  let h = 0;
  for (let y = by0; y < by1; y++) {
    let i = y * map.width + bx0;
    for (let x = bx0; x < bx1; x++, i++) {
      const t = map.tiles[i];
      h = (Math.imul(h, 31) + t.charCodeAt(0) + t.length * 7 + ((map.smoke[i] ?? 0) * 8 | 0) * 131) | 0;
    }
  }
  return h;
}

export class VisibilityOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private shown: { region: VisRegion; teamKey: string } | null = null;
  private job: Job | null = null;
  private lastInputs: PassInputs | null = null;
  private lastCheckMs = -Infinity;
  readonly stats: VisOverlayStats = { lastPassMs: 0, lastPassRasterMs: 0, lastPassFrames: 0, lastPassCells: 0, lastPassSpotters: 0, passes: 0 };

  constructor() {
    // Read-only debug hook for perf checks from the browser console.
    if (typeof window !== 'undefined') (window as unknown as { __cc3VisionStats?: VisOverlayStats }).__cc3VisionStats = this.stats;
  }

  /** Drop everything (e.g. when the overlay is turned off). */
  reset(): void {
    this.job = null;
    this.shown = null;
    this.lastInputs = null;
    this.lastCheckMs = -Infinity;
  }

  /** Call once per frame. `teamIds` are the selected friendly teams. */
  update(state: BattleState, cam: Camera, side: Side, teamIds: readonly number[], nowMs: number): void {
    if (teamIds.length === 0) { this.reset(); return; }
    const teamKey = [...teamIds].sort((a, b) => a - b).join(',');
    if (this.shown && this.shown.teamKey !== teamKey) this.shown = null; // never show another selection's view
    if (this.job && this.job.teamKey !== teamKey) this.job = null;

    if (!this.job && nowMs - this.lastCheckMs >= CHECK_INTERVAL_MS) {
      this.lastCheckMs = nowMs;
      const t0 = performance.now();
      const spotters = collectSpotters(state, side, new Set(teamIds));
      const region = overlayRegion(state.map.width, state.map.height, cam);
      const inputs: PassInputs = { teamKey, region, spotters: snapSpotters(spotters), terrainHash: sightTerrainHash(state, spotters, region) };
      const prev = this.lastInputs;
      const changed = !this.shown || !prev || prev.teamKey !== teamKey || !sameRegion(prev.region, region)
        || prev.terrainHash !== inputs.terrainHash || spottersChanged(prev.spotters, inputs.spotters);
      if (changed) {
        this.lastInputs = inputs;
        this.job = {
          teamKey, region, groups: groupSpotters(spotters),
          scores: new Float32Array(region.cols * region.rows), next: 0,
          spentMs: performance.now() - t0, frames: 0, rasterPending: false,
        };
        this.stats.lastPassSpotters = spotters.length;
      }
    }

    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    const deadline = t0 + FRAME_BUDGET_MS;
    const { region, scores, groups } = job;
    const total = region.cols * region.rows;
    const half = region.step / 2;
    let i = job.next;
    while (i < total) {
      const cx = i % region.cols, cy = (i / region.cols) | 0;
      scores[i] = groups.length === 0 ? 0
        : visibilityScore(state, groups, region.x0 + cx * region.step + half, region.y0 + cy * region.step + half);
      i++;
      if ((i & 15) === 0 && performance.now() >= deadline) break;
    }
    job.next = i;
    job.frames++;
    job.spentMs += performance.now() - t0;
    if (i < total) return;

    // Rasterise on the next frame if this one already used its budget.
    if (performance.now() - t0 > 1 && !job.rasterPending) {
      job.rasterPending = true;
      return;
    }
    const tr = performance.now();
    const img = rasterizeScores(scores, region.cols, region.rows);
    if (!this.canvas) this.canvas = document.createElement('canvas');
    this.canvas.width = img.w;
    this.canvas.height = img.h;
    this.canvas.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), 0, 0);
    const rasterMs = performance.now() - tr;
    this.shown = { region, teamKey: job.teamKey };
    this.stats.lastPassMs = job.spentMs + rasterMs;
    this.stats.lastPassRasterMs = rasterMs;
    this.stats.lastPassFrames = job.frames + (job.rasterPending ? 1 : 0);
    this.stats.lastPassCells = total;
    this.stats.passes++;
    this.job = null;
  }

  /** Draws the shading plus a feathered ring at the soldier-target detection range around each team. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, teamIds: readonly number[]): void {
    if (teamIds.length === 0 || !this.shown || !this.canvas) return;
    const px = TILE_PX * cam.zoom;
    const r = this.shown.region;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(this.canvas, (r.x0 - cam.x) * px, (r.y0 - cam.y) * px, r.cols * r.step * px, r.rows * r.step * px);

    const rangePx = (SOLDIER_SPOT_RANGE_M / TILE_M) * px;
    const feather = Math.max(5, 0.5 * px);
    for (const id of teamIds) {
      const team = state.teams.get(id);
      if (!team || team.outOfAction) continue;
      const cx = (team.pos.x - cam.x) * px, cy = (team.pos.y - cam.y) * px;
      // skip rings that can't touch the viewport
      const nearest = Math.hypot(Math.max(Math.abs(cx - VIEW_W / 2) - VIEW_W / 2, 0), Math.max(Math.abs(cy - VIEW_H / 2) - VIEW_H / 2, 0));
      const farthest = Math.hypot(Math.abs(cx - VIEW_W / 2) + VIEW_W / 2, Math.abs(cy - VIEW_H / 2) + VIEW_H / 2);
      if (nearest > rangePx + feather || farthest < rangePx - feather) continue;
      const g = ctx.createRadialGradient(cx, cy, rangePx - feather, cx, cy, rangePx + feather);
      g.addColorStop(0, 'rgba(210,235,190,0)');
      g.addColorStop(0.5, 'rgba(210,235,190,0.38)');
      g.addColorStop(1, 'rgba(210,235,190,0)');
      ctx.beginPath();
      ctx.arc(cx, cy, rangePx, 0, Math.PI * 2);
      ctx.strokeStyle = g;
      ctx.lineWidth = feather * 2;
      ctx.stroke();
    }
    ctx.restore();
  }
}
