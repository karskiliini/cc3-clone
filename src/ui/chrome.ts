// ============================================================================
// chrome.ts — shared CC3-style olive chrome primitives: bevelled panels,
// buttons, list rows, scroll arrows, title banners. All canvas, integer px.
// ============================================================================
import type { Rect, Vec2, InputState } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { PALETTE } from '@/render/palette';
import { drawText, drawTextCentered, textWidth, FONT_SMALL_H, FONT_BIG_H } from '@/render/pixelfont';
import { hash2 } from '@/shared/rng';
import { getPosterBackground } from '@/render/menuArt';

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

// ============================================================================
// POSTER CHROME — the CC3-style "propaganda poster" menu look: real canvas
// fonts (not the bitmap pixelfont), torn-metal buttons, a top logotype/title
// bar and a bottom control strip. Used by mainMenu/battleSetup/options/
// debrief/operation; drawn in the 800x600 MENU-local coordinate space (the
// caller is responsible for translating by MENU_X/MENU_Y first).
// ============================================================================

/** Draws `text` once in `shadow` offset by (2,2) then once in `color` at (x,y).
 * Caller sets `align`/`ctx.textBaseline` expectations via the `align` param
 * (baseline is always 'alphabetic'). */
export function drawShadowText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
  shadow: string = 'rgba(0,0,0,0.8)',
  align: CanvasTextAlign = 'left',
): void {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = shadow;
  ctx.fillText(text, x + 2, y + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Draws the cached procedural poster background filling the 800x600 area
 * (assumes the caller has already translated the context to MENU-local
 * origin). */
export function drawPoster(ctx: CanvasRenderingContext2D): void {
  ctx.drawImage(getPosterBackground(), 0, 0);
}

/** Top-left "CLOSE|COMBAT" logotype: white stencil-ish letters, letter-spaced,
 * with a small orange vertical divider between the two words. */
export function drawLogo(ctx: CanvasRenderingContext2D): void {
  const x = 16;
  const y = 34;
  ctx.save();
  ctx.font = 'bold 22px Impact, "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let cx = x;
  const drawWord = (word: string) => {
    for (const ch of word) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(ch, cx + 2, y + 2);
      ctx.fillStyle = '#f2f2ec';
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + 3;
    }
  };
  drawWord('CLOSE');
  cx += 6;
  ctx.fillStyle = '#c8501a';
  ctx.fillRect(Math.round(cx), y - 18, 3, 22);
  ctx.fillRect(Math.round(cx) + 7, y - 18, 3, 22);
  cx += 18;
  drawWord('COMBAT');
  ctx.restore();
}

/** Top-right screen-name label, e.g. 'MAIN', 'REQUISITION', 'BATTLE'. */
export function drawScreenTitle(ctx: CanvasRenderingContext2D, text: string): void {
  drawShadowText(ctx, text.toUpperCase(), 784, 34, 'bold 26px Arial, Helvetica, sans-serif', '#f5f5f0', 'rgba(0,0,0,0.75)', 'right');
}

export interface MetalButtonOpts {
  hot?: boolean;
  disabled?: boolean;
}

function buttonSeed(r: Rect): number {
  return Math.round(r.x * 31 + r.y * 17);
}

/** Builds (but doesn't stroke/fill) a ragged torn-metal outline path for `r`. */
function jaggedButtonPath(ctx: CanvasRenderingContext2D, r: Rect, seed: number): void {
  const { x, y, w, h } = r;
  const jag = (i: number, salt: number) => (hash2(seed + i, salt) - 0.5) * 5;
  const teethX = 8;
  const teethY = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + jag(0, 1));
  for (let i = 1; i <= teethX; i++) ctx.lineTo(x + (w * i) / teethX, y + jag(i, 1));
  for (let i = 1; i <= teethY; i++) ctx.lineTo(x + w + jag(i, 2), y + (h * i) / teethY);
  for (let i = teethX - 1; i >= 0; i--) ctx.lineTo(x + (w * i) / teethX, y + h + jag(i, 3));
  for (let i = teethY - 1; i >= 1; i--) ctx.lineTo(x + jag(i, 4), y + (h * i) / teethY);
  ctx.closePath();
}

/** A large torn-metal-strip button used for the main menu's marquee choices:
 * jagged edges, riveted look, bold left-aligned 26px text (yellow on hover). */
export function drawMetalButton(ctx: CanvasRenderingContext2D, r: Rect, label: string, opts: MetalButtonOpts = {}): void {
  const { hot = false, disabled = false } = opts;
  const seed = buttonSeed(r);
  ctx.save();
  jaggedButtonPath(ctx, r, seed);
  ctx.clip();
  const grad = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  if (disabled) {
    grad.addColorStop(0, '#3c3c3c');
    grad.addColorStop(0.5, '#242424');
    grad.addColorStop(1, '#181818');
  } else if (hot) {
    grad.addColorStop(0, '#6e6e6e');
    grad.addColorStop(0.5, '#414141');
    grad.addColorStop(1, '#242424');
  } else {
    grad.addColorStop(0, '#57575a');
    grad.addColorStop(0.5, '#333336');
    grad.addColorStop(1, '#1c1c1e');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(r.x - 6, r.y - 6, r.w + 12, r.h + 12);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(r.x, r.y, r.w, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let rx = r.x + 12; rx < r.x + r.w - 6; rx += 36) {
    ctx.beginPath();
    ctx.arc(rx, r.y + 4, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx, r.y + r.h - 4, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  jaggedButtonPath(ctx, r, seed);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const textColor = disabled ? '#7a7a7a' : hot ? '#f2d048' : '#f4f4f0';
  drawShadowText(ctx, label, r.x + 18, r.y + r.h / 2 + 9, 'bold 26px Arial, Helvetica, sans-serif', textColor);
}

export interface SmallButtonOpts {
  hot?: boolean;
  disabled?: boolean;
}

/** A small dark-grey bevelled button with bold 12px centred white text —
 * used for the bottom control strip present on every menu screen. */
export function drawSmallMetalButton(ctx: CanvasRenderingContext2D, r: Rect, label: string, opts: SmallButtonOpts = {}): void {
  const { hot = false, disabled = false } = opts;
  drawBevelBox(ctx, r, false, disabled ? '#2a2a2a' : hot ? '#4c4c4e' : '#38383a');
  const color = disabled ? '#6c6c6c' : hot ? '#f2d048' : '#f0f0ec';
  ctx.save();
  ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = Math.round(r.x + r.w / 2);
  const cy = Math.round(r.y + r.h / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillText(label, cx + 1, cy + 1);
  ctx.fillStyle = color;
  ctx.fillText(label, cx, cy);
  ctx.restore();
}

export interface BottomStripButtonSpec {
  label: string;
  rect: Rect;
  disabled?: boolean;
  hot?: boolean;
}

/** Draws a row of small bevelled buttons for the bottom control strip. */
export function drawBottomStrip(ctx: CanvasRenderingContext2D, buttons: BottomStripButtonSpec[]): void {
  for (const b of buttons) drawSmallMetalButton(ctx, b.rect, b.label, { disabled: b.disabled, hot: b.hot });
}

/** A translucent dark panel with a thin light-grey frame — used for list
 * panels on the poster-style screens. */
export function drawDarkPanel(ctx: CanvasRenderingContext2D, r: Rect): void {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = 'rgba(210,210,205,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
}

/** Draws `text` rotated -90deg (bottom-to-top), used for the vertical
 * "FORCE POOL" / "ACTIVE ROSTER" stencil labels on the requisition screen. */
export function drawVerticalStencil(ctx: CanvasRenderingContext2D, text: string, x: number, yBottom: number, color = '#e08a2c'): void {
  ctx.save();
  ctx.translate(x, yBottom);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 24px Impact, "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(text, 2, 2);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}
