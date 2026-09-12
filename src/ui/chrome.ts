// ============================================================================
// chrome.ts — shared CC3-style olive chrome primitives: bevelled panels,
// buttons, list rows, scroll arrows, title banners. All canvas, integer px.
// ============================================================================
import type { Rect, Vec2, InputState } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { PALETTE } from '@/render/palette';
import { drawText, drawTextCentered, textWidth, FONT_SMALL_H, FONT_BIG_H } from '@/render/pixelfont';

export const HOT_FACE = '#454b41';

/** Point-in-rect hit test (re-export for ui modules that only import chrome). */
export function hitRect(p: Vec2, r: Rect): boolean {
  return pointInRect(p, r);
}

/** Fills `r` with the chrome face colour and draws a 2px bevel border.
 * sunken=false (default): light on top/left, dark on bottom/right (raised).
 * sunken=true: reversed (inset look). */
export function drawBevelBox(ctx: CanvasRenderingContext2D, r: Rect, sunken = false, face: string = PALETTE.chromeBg): void {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  ctx.fillStyle = face;
  ctx.fillRect(x, y, w, h);
  const light = sunken ? PALETTE.bevelDark : PALETTE.bevelLight;
  const dark = sunken ? PALETTE.bevelLight : PALETTE.bevelDark;
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = dark;
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x + w - 2, y, 2, h);
}

/** Draws a full panel: bevel box plus an optional title strip (small gold text,
 * 12px tall, with a 1px separator below it). */
export function drawPanel(ctx: CanvasRenderingContext2D, r: Rect, opts?: { sunken?: boolean; title?: string }): void {
  drawBevelBox(ctx, r, opts?.sunken ?? false);
  if (opts?.title) {
    drawText(ctx, opts.title, Math.round(r.x) + 4, Math.round(r.y) + 3, PALETTE.gold, 'small');
    ctx.fillStyle = PALETTE.bevelDark;
    ctx.fillRect(Math.round(r.x) + 2, Math.round(r.y) + 12, Math.round(r.w) - 4, 1);
  }
}

export interface ButtonDrawOpts {
  pressed?: boolean;
  disabled?: boolean;
  hot?: boolean;
}

/** Draws a bevelled push-button with a centred, uppercase small-font label. */
export function drawButton(ctx: CanvasRenderingContext2D, r: Rect, label: string, opts: ButtonDrawOpts = {}): void {
  const { pressed = false, disabled = false, hot = false } = opts;
  const face = pressed ? PALETTE.chromeBg : hot ? HOT_FACE : PALETTE.chromeBg;
  drawBevelBox(ctx, r, pressed, face);
  const color = disabled ? PALETTE.dim : PALETTE.text;
  const shift = pressed ? 1 : 0;
  const cx = Math.round(r.x + r.w / 2) + shift;
  const cy = Math.round(r.y + (r.h - FONT_SMALL_H) / 2) + shift;
  drawTextCentered(ctx, label.toUpperCase(), cx, cy, color, 'small');
}

export class Button {
  r: Rect;
  label: string;
  disabled = false;
  hot = false;

  constructor(r: Rect, label: string) {
    this.r = r;
    this.label = label;
  }

  /** Updates hot state; returns true exactly on the frame a left click lands
   * inside this button's rect and it is not disabled. */
  update(input: InputState): boolean {
    this.hot = pointInRect(input.mouse, this.r);
    if (this.disabled) return false;
    for (const c of input.clicks) {
      if (c.button === 0 && pointInRect({ x: c.x, y: c.y }, this.r)) return true;
    }
    return false;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawButton(ctx, this.r, this.label, { disabled: this.disabled, hot: this.hot });
  }
}

export interface ListRowOpts {
  hot?: boolean;
  selected?: boolean;
  dim?: boolean;
}

/** Draws a selectable list row: lighter face when hot, 1px gold inset frame when selected. */
export function drawListRow(ctx: CanvasRenderingContext2D, r: Rect, opts: ListRowOpts = {}): void {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  if (opts.hot) {
    ctx.fillStyle = HOT_FACE;
    ctx.fillRect(x, y, w, h);
  }
  if (opts.selected) {
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
  }
}

function triangle(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, dir: 'up' | 'down', color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (dir === 'up') {
    ctx.moveTo(cx - size, cy + size);
    ctx.lineTo(cx + size, cy + size);
    ctx.lineTo(cx, cy - size);
  } else {
    ctx.moveTo(cx - size, cy - size);
    ctx.lineTo(cx + size, cy - size);
    ctx.lineTo(cx, cy + size);
  }
  ctx.closePath();
  ctx.fill();
}

/** Draws two scroll arrows side by side (up on the left half, down on the right
 * half) within `r` — designed for short scroll-bar strips (e.g. teamList's
 * 10px bottom band) where stacking them vertically would be too small. */
export function drawScrollArrows(ctx: CanvasRenderingContext2D, r: Rect, upHot: boolean, downHot: boolean): void {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  const halfW = Math.floor(w / 2);
  const upRect: Rect = { x, y, w: halfW, h };
  const downRect: Rect = { x: x + halfW, y, w: w - halfW, h };
  ctx.fillStyle = upHot ? HOT_FACE : PALETTE.chromeBg;
  ctx.fillRect(upRect.x, upRect.y, upRect.w, upRect.h);
  ctx.fillStyle = downHot ? HOT_FACE : PALETTE.chromeBg;
  ctx.fillRect(downRect.x, downRect.y, downRect.w, downRect.h);
  ctx.fillStyle = PALETTE.bevelDark;
  ctx.fillRect(x + halfW, y, 1, h);
  const size = Math.max(2, Math.floor(h / 3));
  triangle(ctx, upRect.x + upRect.w / 2, y + h / 2, size, 'up', PALETTE.text);
  triangle(ctx, downRect.x + downRect.w / 2, y + h / 2, size, 'down', PALETTE.text);
}

/** Draws a big-font gold heading, horizontally centred at `x` (defaults to
 * screen centre when omitted by caller — callers pass the centre explicitly),
 * with a 1px darker shadow offset by (1,1). */
export function drawTitleBanner(ctx: CanvasRenderingContext2D, text: string, y: number, cx = 400): void {
  drawTextCentered(ctx, text, cx + 1, y + 1, PALETTE.black, 'big');
  drawTextCentered(ctx, text, cx, y, PALETTE.gold, 'big');
}

/** Draws a huge 'title'-size gold heading with a 2px dark drop shadow, used
 * only by the main menu's marquee title. */
export function drawMarqueeTitle(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number): void {
  drawTextCentered(ctx, text, cx + 2, y + 2, PALETTE.black, 'title');
  drawTextCentered(ctx, text, cx, y, PALETTE.gold, 'title');
}

// Re-exported so callers of chrome.ts have everything they need without an
// extra import for simple label-fitting logic.
export { textWidth, FONT_BIG_H, FONT_SMALL_H };
