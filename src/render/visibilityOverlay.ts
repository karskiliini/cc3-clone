// ============================================================================
// visibilityOverlay.ts — "what can my selected units see?" map overlay.
//
// For the selected friendly teams, every map cell in (and just around) the viewport is scored with
// the sim's own spotting rules (observerStandingSpotScore in sim/spotting.ts), taking the best
// score over all eligible spotters of those teams (dismounted soldiers; a vehicle spots from its
// own position for its crew):
//   - score >= 0.5  -> a standing enemy there is spotted for certain: left untouched
//   - 0 < score < 0.5 -> only a per-tick chance (concealment / distance / facing): light dark-green
//   - score 0       -> out of detection range or LOS blocked: darkened ~40%
//
// ASSUMPTION: each cell is evaluated for a *standing, stationary, non-firing enemy soldier* at the
// cell centre (stance factor 1, no movement/firing bonus), so the overlay answers "could I see an
// enemy standing there?". Prone/sneaking enemies are harder to see; moving or firing ones easier.
// Enemy *vehicles* use the longer 400 m range, so they may be spotted a little beyond the ring.
//
// The grid is rasterised at one pixel per cell into a small offscreen canvas and drawn scaled
// with smoothing on, so the class boundaries come out as soft edges. Work is time-sliced.
// ============================================================================
import type { BattleState, Camera, Side } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import { losTrace } from '@/sim/los';
import {
  collectSpotters, observerStandingSpotScore, SOLDIER_SPOT_RANGE_M, type Spotter,
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

const OBSCURED_RGBA = [18, 70, 22, Math.round(0.3 * 255)] as const;
const BLOCKED_RGBA = [0, 0, 0, Math.round(0.42 * 255)] as const;

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
  return [...byTile.values()];
}

/** Classifies one target point for a set of spotters (pure; used by the overlay and tests). */
export function classifyVisibility(state: BattleState, groups: SpotterGroup[] | Spotter[], tx: number, ty: number): number {
  const gs: SpotterGroup[] = groups.length > 0 && 'members' in groups[0] ? groups as SpotterGroup[] : groupSpotters(groups as Spotter[]);
  const target = { x: tx, y: ty };
  const rangeTiles = SOLDIER_SPOT_RANGE_M / TILE_M;
  const rangeSq = rangeTiles * rangeTiles;
  let best = 0;
  for (const g of gs) {
    let vis = -1;
    const losFor = (from: { x: number; y: number }, to: { x: number; y: number }): number => {
      if (vis < 0) vis = losTrace(state.map, from, to).visibility;
      return vis;
    };
    for (const sp of g.members) {
      const dx = sp.pos.x - tx, dy = sp.pos.y - ty;
      if (dx * dx + dy * dy > rangeSq) continue; // cheap pre-check (same test observerVisibility does)
      const score = observerStandingSpotScore(state, sp, target, losFor);
      if (score > best) {
        best = score;
        if (best >= CERTAIN_SPOT_SCORE) return VIS_CLEAR;
      }
      if (vis === 0) break; // LOS from this tile is blocked for every member
    }
  }
  return best > 0 ? VIS_OBSCURED : VIS_BLOCKED;
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

interface Job {
  sig: string;
  teamKey: string;
  region: VisRegion;
  groups: SpotterGroup[];
  data: Uint8ClampedArray;
  next: number;
  spentMs: number;
  frames: number;
}

export interface VisOverlayStats {
  /** total compute time of the last completed pass, ms (summed over frames) */
  lastPassMs: number;
  lastPassFrames: number;
  lastPassCells: number;
  lastPassSpotters: number;
  passes: number;
}

export class VisibilityOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private shown: { region: VisRegion; teamKey: string } | null = null;
  private job: Job | null = null;
  private lastSig = '';
  private lastCheckMs = -Infinity;
  readonly stats: VisOverlayStats = { lastPassMs: 0, lastPassFrames: 0, lastPassCells: 0, lastPassSpotters: 0, passes: 0 };

  constructor() {
    // Read-only debug hook for perf checks from the browser console.
    if (typeof window !== 'undefined') (window as unknown as { __cc3VisionStats?: VisOverlayStats }).__cc3VisionStats = this.stats;
  }

  /** Drop everything (e.g. when the overlay is turned off). */
  reset(): void {
    this.job = null;
    this.shown = null;
    this.lastSig = '';
    this.lastCheckMs = -Infinity;
  }

  private signature(state: BattleState, teamKey: string, spotters: Spotter[], r: VisRegion): string {
    const parts: (string | number)[] = [teamKey, r.x0, r.y0, r.cols, r.rows, r.step];
    for (const sp of spotters) {
      parts.push(Math.floor(sp.pos.x * 2), Math.floor(sp.pos.y * 2));
      const s = sp.soldier;
      if (s) {
        parts.push(s.facing, s.mind.threatDir == null ? 'n' : Math.round(s.mind.threatDir * 12));
        for (const b of s.mind.beliefs) parts.push(Math.round(b.pos.x), Math.round(b.pos.y));
      }
    }
    // Terrain can change (crushed hedges, craters) and smoke drifts: hash the region plus the
    // range around it cheaply (one pass over ints/strings).
    const map = state.map;
    const pad = SOLDIER_SPOT_RANGE_M / TILE_M;
    const hx0 = Math.max(0, r.x0 - pad), hy0 = Math.max(0, r.y0 - pad);
    const hx1 = Math.min(map.width, r.x0 + r.cols * r.step + pad), hy1 = Math.min(map.height, r.y0 + r.rows * r.step + pad);
    let h = 0;
    for (let y = hy0; y < hy1; y++) {
      let i = y * map.width + hx0;
      for (let x = hx0; x < hx1; x++, i++) {
        const t = map.tiles[i];
        h = (Math.imul(h, 31) + t.charCodeAt(0) + t.length * 7 + ((map.smoke[i] ?? 0) * 16 | 0)) | 0;
      }
    }
    parts.push(h);
    return parts.join(',');
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
      const sig = this.signature(state, teamKey, spotters, region);
      if (sig !== this.lastSig || !this.shown) {
        this.lastSig = sig;
        this.job = {
          sig, teamKey, region, groups: groupSpotters(spotters),
          data: new Uint8ClampedArray(region.cols * region.rows * 4), next: 0,
          spentMs: performance.now() - t0, frames: 0,
        };
        this.stats.lastPassSpotters = spotters.length;
      }
    }

    // Camera jumped far (minimap click): the pending job's region may no longer cover the view,
    // but finishing it is still cheaper than restarting; the next check picks up the new region.
    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    const deadline = t0 + FRAME_BUDGET_MS;
    const { region, data, groups } = job;
    const total = region.cols * region.rows;
    const half = region.step / 2;
    let i = job.next;
    while (i < total) {
      const cx = i % region.cols, cy = (i / region.cols) | 0;
      const cls = groups.length === 0 ? VIS_BLOCKED
        : classifyVisibility(state, groups, region.x0 + cx * region.step + half, region.y0 + cy * region.step + half);
      const o = i * 4;
      if (cls === VIS_OBSCURED) { data[o] = OBSCURED_RGBA[0]; data[o + 1] = OBSCURED_RGBA[1]; data[o + 2] = OBSCURED_RGBA[2]; data[o + 3] = OBSCURED_RGBA[3]; }
      else if (cls === VIS_BLOCKED) { data[o] = BLOCKED_RGBA[0]; data[o + 1] = BLOCKED_RGBA[1]; data[o + 2] = BLOCKED_RGBA[2]; data[o + 3] = BLOCKED_RGBA[3]; }
      i++;
      if ((i & 15) === 0 && performance.now() >= deadline) break;
    }
    job.next = i;
    job.frames++;
    job.spentMs += performance.now() - t0;
    if (i < total) return;

    if (!this.canvas) this.canvas = document.createElement('canvas');
    this.canvas.width = region.cols;
    this.canvas.height = region.rows;
    const cctx = this.canvas.getContext('2d')!;
    cctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, region.cols, region.rows), 0, 0);
    this.shown = { region, teamKey: job.teamKey };
    this.stats.lastPassMs = job.spentMs;
    this.stats.lastPassFrames = job.frames;
    this.stats.lastPassCells = total;
    this.stats.passes++;
    this.job = null;
  }

  /** Draws the shading plus a soft ring at the soldier-target detection range around each team. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, teamIds: readonly number[]): void {
    if (teamIds.length === 0 || !this.shown || !this.canvas) return;
    const px = TILE_PX * cam.zoom;
    const r = this.shown.region;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    // Each pixel's centre sits on its cell centre, so smoothing interpolates between samples.
    ctx.drawImage(this.canvas, (r.x0 - cam.x) * px, (r.y0 - cam.y) * px, r.cols * r.step * px, r.rows * r.step * px);

    const rangePx = (SOLDIER_SPOT_RANGE_M / TILE_M) * px;
    for (const id of teamIds) {
      const team = state.teams.get(id);
      if (!team || team.outOfAction) continue;
      const cx = (team.pos.x - cam.x) * px, cy = (team.pos.y - cam.y) * px;
      // skip rings that can't touch the viewport
      const nearest = Math.hypot(Math.max(Math.abs(cx - VIEW_W / 2) - VIEW_W / 2, 0), Math.max(Math.abs(cy - VIEW_H / 2) - VIEW_H / 2, 0));
      const farthest = Math.hypot(Math.abs(cx - VIEW_W / 2) + VIEW_W / 2, Math.abs(cy - VIEW_H / 2) + VIEW_H / 2);
      if (nearest > rangePx || farthest < rangePx) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, rangePx, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(210,235,190,0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
}
