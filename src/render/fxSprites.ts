// ============================================================================
// fxSprites.ts — the pre-rendered combat-FX flipbooks (tools/blender/fx.py → public/sprites/fx_s,
// fx_m, fx_l: 64 / 128 / 256 px cells at 10 px/m, anchored on the cell centre, dirs = 1).
// Entries: grenade, he, he.big, smoke, impact (+ `.w` winter variants), fire (loop), puff.dark,
// puff.light (frame = variant). Loaded lazily on first use; every draw returns false while the
// atlas is missing so callers can skip (or fall back) quietly.
// ============================================================================
import { getAtlas, loadAtlas, atlasCellRect, type Atlas, type AtlasEntry } from '@/render/spriteAtlas';

const FX_ATLASES = ['fx_s', 'fx_m', 'fx_l'] as const;
let requested = false;

/** Start fetching the FX atlases (idempotent). */
export function requestFxAtlases(): Promise<unknown> {
  requested = true;
  return Promise.all(FX_ATLASES.map((n) => loadAtlas(n)));
}

/** FX entries may carry `times`: the burst-time (s) each frame shows (frames are eased, dense at
 * the flash), so a frame is picked by time rather than by a fixed fps. */
type FxEntry = AtlasEntry & { times?: number[] };
const lookup = new Map<string, { atlas: Atlas; entry: FxEntry }>();
function find(key: string): { atlas: Atlas; entry: FxEntry } | null {
  if (!requested) void requestFxAtlases();
  const hit = lookup.get(key);
  if (hit) return hit;
  for (const n of FX_ATLASES) {
    const a = getAtlas(n);
    const e = a?.meta.entries[key];
    if (a && a.image && e) {
      const r = { atlas: a, entry: e };
      lookup.set(key, r);
      return r;
    }
  }
  return null;
}

/** Winter variant key when one exists (snow thrown, white dust ring). */
export function fxSeasonKey(key: string, winter: boolean): string {
  if (!winter) return key;
  const w = `${key}.w`;
  return find(w) ? w : key;
}

/** Playing length (s) of a non-looping entry, 0 when unknown. */
export function fxDuration(key: string): number {
  const f = find(key);
  if (!f) return 0;
  const t = f.entry.times;
  if (t && t.length) return t[t.length - 1] + (t[t.length - 1] - (t[t.length - 2] ?? 0)) * 0.5;
  return f.entry.fps > 0 ? f.entry.frames / f.entry.fps : 0;
}

export function fxFrames(key: string): number { return find(key)?.entry.frames ?? 0; }

/**
 * Draw frame `frame` of `key` centred on (x, y) screen px. `scale` multiplies the native
 * 10 px/m size (pass cam.zoom × any size factor). Loops wrap, one-shots return false past the end.
 */
export function drawFxFrame(ctx: CanvasRenderingContext2D, key: string, frame: number, x: number, y: number, scale: number, alpha = 1): boolean {
  const f = find(key);
  if (!f || alpha <= 0.004) return false;
  const { atlas, entry } = f;
  let fr = Math.floor(frame);
  if (entry.loop) fr = ((fr % entry.frames) + entry.frames) % entry.frames;
  else if (fr < 0 || fr >= entry.frames) return false;
  const r = atlasCellRect(atlas.meta, entry.start + fr);
  const w = r.sw * scale, h = r.sh * scale;
  const ax = atlas.meta.anchor.x * scale, ay = atlas.meta.anchor.y * scale;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(atlas.image!, r.sx, r.sy, r.sw, r.sh, x - ax, y - ay, w, h);
  ctx.globalAlpha = prev;
  return true;
}

/** Draw `key` as it looks `ageS` seconds after it started (fps from the atlas). */
export function drawFxAt(ctx: CanvasRenderingContext2D, key: string, ageS: number, x: number, y: number, scale: number, alpha = 1): boolean {
  const f = find(key);
  if (!f || ageS < 0) return false;
  return drawFxFrame(ctx, key, fxFrameAt(f.entry, ageS), x, y, scale, alpha);
}

/** Frame index `ageS` into an entry: by its `times` table when it has one (the last frame whose
 * time has come; -1 once it has played out), else by fps. Pure (tested). */
export function fxFrameAt(entry: { frames: number; fps: number; loop: boolean; times?: number[] }, ageS: number): number {
  const t = entry.times;
  if (!t || t.length === 0) return Math.floor(ageS * entry.fps);
  const end = t[t.length - 1] + (t[t.length - 1] - (t[t.length - 2] ?? 0)) * 0.5;
  if (ageS >= end) return -1;
  let lo = 0, hi = t.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= ageS) lo = mid; else hi = mid - 1; }
  return lo;
}

// ------------------------------------------------------------------ additive light
const glowCache = new Map<string, HTMLCanvasElement>();
/** A soft warm light blob (cached radial gradient) blended with 'lighter': the flash of a burst
 * or the glow of a fire lighting the ground around it. */
export function drawGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radiusPx: number, alpha: number, rgb = '255,125,45'): void {
  if (alpha <= 0.01 || radiusPx <= 1) return;
  let c = glowCache.get(rgb);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.3, `rgba(${rgb},0.4)`);
    grad.addColorStop(0.65, `rgba(${rgb},0.1)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(rgb, c);
  }
  const prevOp = ctx.globalCompositeOperation, prevA = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(c, x - radiusPx, y - radiusPx, radiusPx * 2, radiusPx * 2);
  ctx.globalCompositeOperation = prevOp;
  ctx.globalAlpha = prevA;
}
