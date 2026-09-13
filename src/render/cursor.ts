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
};

const cssCache = new Map<CursorKind, string>();

function buildCssCursor(kind: CursorKind): string {
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
