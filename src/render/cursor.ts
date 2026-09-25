import type { Vec2, CursorKind } from '@/shared/types';
import { getCursorSprite } from '@/render/sprites';

// ============================================================================
// Native-cursor CSS strings — built once per CursorKind (not per frame) so
// the OS cursor tracks the real pointer with zero lag, instead of drawing a
// canvas sprite one frame behind the hardware pointer. Sprites are 16x16;
// we scale to 32x32 (2x) for crisp rendering on hi-DPI displays and encode
// as a data-URL PNG so no extra network request is needed.
// ============================================================================
const SCALE = 2;

// Hotspot in *source* (16x16) pixels; scaled by SCALE below.
const HOTSPOT: Record<CursorKind, [number, number]> = {
  arrow: [0, 0],
  crosshair: [8, 8],
  hand: [4, 2],
  no: [8, 8],
  move: [8, 8],
  wait: [8, 8],
  target: [0, 0], // the four target kinds are built separately, see buildTargetCursor
  targetNone: [0, 0],
  targetMaybe: [0, 0],
  targetLikely: [0, 0],
  targetNoneBlocked: [0, 0],
  targetMaybeBlocked: [0, 0],
  targetLikelyBlocked: [0, 0],
  targetDead: [0, 0],
};

const cssCache = new Map<CursorKind, string>();

/** Large aiming cross shown while a Fire order hovers an enemy that can be targeted: a 64 px
 * reticle (ring, four arms with a centre gap, centre dot) in red with a dark outline so it reads
 * on any ground. Drawn directly at cursor resolution rather than scaled from a 16 px sprite. */
const TARGET_SIZE = 64;
/** Reticle colours: red for men and soft targets; against armour the colour tells the chance of
 * the best available round against the plate it would strike from here: black will not penetrate,
 * yellow might, green is likely to. Black gets a pale outline instead of a dark one. */
const TARGET_COLORS: Partial<Record<CursorKind, [string, string]>> = {
  target: ['#ff3a24', 'rgba(0,0,0,0.85)'],
  targetNone: ['#101010', 'rgba(235,235,225,0.9)'],
  targetMaybe: ['#ffd21e', 'rgba(0,0,0,0.85)'],
  targetLikely: ['#35e04a', 'rgba(0,0,0,0.85)'],
  targetNoneBlocked: ['#101010', 'rgba(235,235,225,0.9)'],
  targetMaybeBlocked: ['#ffd21e', 'rgba(0,0,0,0.85)'],
  targetLikelyBlocked: ['#35e04a', 'rgba(0,0,0,0.85)'],
  targetDead: ['#9a9a94', 'rgba(0,0,0,0.85)'],
};
/** No line of fire from here: the same colour, but the ring and arms are broken into dashes. */
const BLOCKED_KINDS = new Set<CursorKind>(['targetNoneBlocked', 'targetMaybeBlocked', 'targetLikelyBlocked']);

function buildTargetCursor(kind: CursorKind): string {
  const [ink, outline] = TARGET_COLORS[kind] ?? TARGET_COLORS.target!;
  const c = document.createElement('canvas');
  c.width = TARGET_SIZE;
  c.height = TARGET_SIZE;
  const ctx = c.getContext('2d')!;
  const m = TARGET_SIZE / 2;
  const blocked = BLOCKED_KINDS.has(kind);
  const deadTarget = kind === 'targetDead';
  const shape = (): void => {
    ctx.setLineDash(blocked ? [5, 4] : []);
    ctx.beginPath();
    ctx.arc(m, m, 17, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (blocked) {
        // arms broken in two: a gap where the ring crosses them
        ctx.moveTo(m + dx * 7, m + dy * 7); ctx.lineTo(m + dx * 13, m + dy * 13);
        ctx.moveTo(m + dx * 21, m + dy * 21); ctx.lineTo(m + dx * 29, m + dy * 29);
      } else {
        ctx.moveTo(m + dx * 7, m + dy * 7);
        ctx.lineTo(m + dx * 29, m + dy * 29);
      }
    }
    if (deadTarget) {
      // a wreck: the centre struck through with an X
      for (const [dx, dy] of [[1, 1], [1, -1]]) {
        ctx.moveTo(m - dx * 8, m - dy * 8);
        ctx.lineTo(m + dx * 8, m + dy * 8);
      }
    }
    ctx.stroke();
  };
  ctx.lineCap = 'butt';
  // The black reticle is mostly ink with a thin pale halo; the coloured ones are a thin bright
  // line inside a heavier dark outline.
  const dark = kind === 'targetNone' || kind === 'targetNoneBlocked';
  ctx.strokeStyle = outline;
  ctx.lineWidth = 5;
  shape();
  ctx.strokeStyle = ink;
  ctx.lineWidth = dark ? 3.2 : 2;
  shape();
  if (!deadTarget) {
    ctx.fillStyle = outline;
    ctx.fillRect(m - 2.5, m - 2.5, 5, 5);
    ctx.fillStyle = ink;
    ctx.fillRect(m - 1.5, m - 1.5, 3, 3);
  }
  return `url(${c.toDataURL('image/png')}) ${m} ${m}, crosshair`;
}

function buildCssCursor(kind: CursorKind): string {
  if (TARGET_COLORS[kind]) return buildTargetCursor(kind);
  const src = getCursorSprite(kind);
  const c = document.createElement('canvas');
  c.width = src.width * SCALE;
  c.height = src.height * SCALE;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  const [hx, hy] = HOTSPOT[kind];
  return `url(${url}) ${hx * SCALE} ${hy * SCALE}, auto`;
}

/** Returns (and caches) the `cursor:` CSS value for a given cursor kind. */
export function cssCursorFor(kind: CursorKind): string {
  let css = cssCache.get(kind);
  if (!css) {
    css = buildCssCursor(kind);
    cssCache.set(kind, css);
  }
  return css;
}

/** No-op fallback kept for compatibility: the cursor is now the native OS
 * pointer (see cssCursorFor / main.ts), so nothing needs to be drawn. */
export function drawCursor(_ctx: CanvasRenderingContext2D, _mouse: Vec2, _kind: CursorKind): void {
  // intentionally empty
}
