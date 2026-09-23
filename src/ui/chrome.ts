// ============================================================================
// chrome.ts — the CC3 "propaganda poster" menu chrome: logotype and screen
// title, torn-metal buttons, dark panels, vertical stencil labels and one
// small set of type styles. Everything draws in the 800x600 MENU-local space
// (the caller has translated by MENU_X/MENU_Y, see screens/common.ts).
// The in-battle HUD has its own olive chrome in ui/hud/hudChrome.ts.
// ============================================================================
import type { Rect } from '@/shared/types';
import { hash2 } from '@/shared/rng';

/** The menu type scale and colours: one heading size, one label size, one body size. */
export const UI = {
  title: 'bold 30px Arial, Helvetica, sans-serif',
  heading: 'bold 14px Arial, Helvetica, sans-serif',
  label: 'bold 12px Arial, Helvetica, sans-serif',
  body: '12px Arial, Helvetica, sans-serif',
  note: '10px Arial, Helvetica, sans-serif',
  gold: '#f0d24a',
  text: '#f0ece4',
  dim: '#a8988c',
  accent: '#e8a33d',
  good: '#5ccf5c',
  bad: '#e8402c',
} as const;

/** Draws `text` with a 2px dark drop shadow. Baseline is always 'alphabetic'. */
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

/** Plain text in one of the UI styles (no shadow); leaves the ctx state untouched. */
export function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'left'): void {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** A gold section heading (the one heading style used inside screens). */
export function drawHeading(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign = 'left'): void {
  drawShadowText(ctx, text, x, y, UI.heading, UI.gold, 'rgba(0,0,0,0.8)', align);
}

const STENCIL_FONT = '"Stencil", "Stencil Std", "Arial Narrow", Impact, sans-serif';

/** Draws `text` one glyph at a time with `spacing` px extra advance; returns
 * the total advance. When `draw` is false only measures. */
function spacedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number, draw: boolean): number {
  let cx = x;
  for (const ch of text) {
    if (draw) {
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillText(ch, cx + 1.5, y + 1.5);
      ctx.fillStyle = '#f4f4ee';
      ctx.fillText(ch, cx, y);
    }
    cx += ctx.measureText(ch).width + spacing;
  }
  return cx - x - spacing;
}

/** Top-left "CLOSE||COMBAT" logotype: widely letter-spaced white capitals with
 * a pair of narrow yellow bars between the words (MENU x 10..233). */
export function drawLogo(ctx: CanvasRenderingContext2D): void {
  const targetW = 223;
  ctx.save();
  ctx.font = `bold 22px ${STENCIL_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const gap = 6;
  const barsW = 11;
  const natural = spacedText(ctx, 'CLOSE', 0, 0, 5, false) + gap + barsW + gap + spacedText(ctx, 'COMBAT', 0, 0, 5, false);
  ctx.translate(10, 30);
  ctx.scale(natural > 0 ? targetW / natural : 1, 1);
  let cx = spacedText(ctx, 'CLOSE', 0, 0, 5, true) + gap;
  for (const barX of [cx, cx + 7]) {
    ctx.fillStyle = '#f0c020';
    ctx.fillRect(barX, -19, 4, 20);
    ctx.fillStyle = '#b07a10';
    ctx.fillRect(barX, -3, 4, 4);
  }
  cx += barsW + gap;
  spacedText(ctx, 'COMBAT', cx, 0, 5, true);
  ctx.restore();
}

/** Top-right screen name ('MAIN', 'REQUISITION', ...), right-aligned at MENU x 784. */
export function drawScreenTitle(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.save();
  ctx.font = `bold 22px ${STENCIL_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const t = text.toUpperCase();
  const total = spacedText(ctx, t, 0, 0, 2.5, false);
  spacedText(ctx, t, 784 - total, 30, 2.5, true);
  ctx.restore();
}

/** A ragged outline around `r`: `amp` px of jag along the long edges; `tornEnd` cuts a
 * swallow-tail notch into the right end, like a banner torn off its pole. */
function raggedPath(ctx: CanvasRenderingContext2D, r: Rect, amp: number, teethW: number, tornEnd = false): void {
  const { x, y, w, h } = r;
  const seed = Math.round(r.x * 31 + r.y * 17);
  const jag = (i: number, salt: number) => (hash2(seed + i, salt) - 0.5) * amp;
  const n = Math.max(4, Math.round(w / teethW));
  ctx.beginPath();
  ctx.moveTo(x, y + jag(0, 1));
  for (let i = 1; i <= n; i++) ctx.lineTo(x + (w * i) / n, y + jag(i, 1));
  ctx.lineTo(tornEnd ? x + w - h * 0.35 : x + w + jag(1, 2), y + h * 0.5);
  for (let i = n; i >= 0; i--) ctx.lineTo(x + (w * i) / n, y + h + jag(i, 3));
  ctx.closePath();
}

/** The main menu's big banner button: a dark steel strip with a torn right end and a
 * bold 26px label (gold when hovered). */
export function drawMetalButton(ctx: CanvasRenderingContext2D, r: Rect, label: string, hot = false): void {
  ctx.save();
  ctx.translate(3, 4);
  raggedPath(ctx, r, 5, 40, true);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  ctx.restore();

  ctx.save();
  raggedPath(ctx, r, 5, 40, true);
  const grad = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  grad.addColorStop(0, hot ? '#5a5652' : '#3e3a38');
  grad.addColorStop(0.5, hot ? '#34302e' : '#262322');
  grad.addColorStop(1, hot ? '#1e1b1a' : '#151312');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(r.x, r.y - 4, r.w, 6);
  ctx.restore();
  raggedPath(ctx, r, 5, 40, true);
  ctx.strokeStyle = hot ? 'rgba(240,210,74,0.8)' : 'rgba(200,180,154,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  drawShadowText(ctx, label, r.x + 20, r.y + r.h / 2 + 9, 'bold 26px Arial, Helvetica, sans-serif', hot ? UI.gold : '#f4f4f0');
}

export interface SmallButtonOpts {
  /** pointer over it */
  hot?: boolean;
  /** the chosen value of a toggle group (German/Soviet, a tab, ...) */
  active?: boolean;
  /** temporarily unavailable (e.g. Next with an empty roster) */
  disabled?: boolean;
}

/** A small torn tab button (bottom strip, toggles, tabs): maroon fill, tan ragged edge. */
export function drawSmallMetalButton(ctx: CanvasRenderingContext2D, r: Rect, label: string, opts: SmallButtonOpts = {}): void {
  const { hot = false, active = false, disabled = false } = opts;
  ctx.save();
  if (disabled) ctx.globalAlpha = 0.4;
  raggedPath(ctx, { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }, 2.5, 6);
  ctx.fillStyle = active ? '#8a2418' : hot && !disabled ? '#5a2a22' : '#321612';
  ctx.fill();
  ctx.strokeStyle = active ? '#f0c878' : '#c8b49a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = UI.label;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = Math.round(r.x + r.w / 2);
  const cy = Math.round(r.y + r.h / 2) + 1;
  ctx.fillStyle = '#000000';
  ctx.fillText(label, cx + 1, cy + 1);
  ctx.fillStyle = active ? '#fff4d8' : hot && !disabled ? UI.gold : '#d8d0c6';
  ctx.fillText(label, cx, cy);
  ctx.restore();
}

/** A translucent dark panel with a thin warm edge — list/info panels on the poster screens. */
export function drawDarkPanel(ctx: CanvasRenderingContext2D, r: Rect): void {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  ctx.save();
  ctx.fillStyle = 'rgba(12,5,4,0.84)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(160,96,64,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
}

/** `text` set vertically in chunky letter-spaced Impact with a dark outline and a flame
 * gradient — the requisition screen's "FORCE POOL" / "ACTIVE ROSTER" labels, one on each
 * outer edge. Upward (default): reads bottom-to-top from (x, y) = its baseline's bottom end,
 * glyphs to the left of x. Downward: reads top-to-bottom from (x, y) = its top-left corner,
 * glyphs to the right of x. `maxLen` squeezes the run to fit. */
export function drawVerticalStencil(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, maxLen: number, downward = false): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(downward ? Math.PI / 2 : -Math.PI / 2);
  ctx.font = `900 ${size}px Impact, "Arial Black", Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const spacing = Math.max(2, Math.round(size * 0.08));
  let total = -spacing;
  for (const ch of text) total += ctx.measureText(ch).width + spacing;
  if (total > maxLen) ctx.scale(maxLen / total, 1);
  const g = ctx.createLinearGradient(0, 0, total, 0);
  g.addColorStop(0, '#ff6a00');
  g.addColorStop(1, '#ffc030');
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1a0a05';
  let cx = 0;
  for (const ch of text) {
    ctx.strokeText(ch, cx, 0);
    ctx.fillStyle = g;
    ctx.fillText(ch, cx, 0);
    cx += ctx.measureText(ch).width + spacing;
  }
  ctx.restore();
}
