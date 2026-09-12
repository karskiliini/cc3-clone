// ============================================================================
// hudChrome.ts — shared drawing primitives for the dark-maroon in-battle HUD:
// bevelled boxes, the bottom-panel background, real (non-bitmap) fonts, and
// team-status -> colour mappings shared by teamGrid/soldierMonitor/unitRender.
// ============================================================================
import type { Rect, TeamStatusWord, Vec2 } from '@/shared/types';
import { PANEL_H, PANEL_Y, SCREEN_W } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { HUD } from '@/render/palette';

export function hitRect(p: Vec2, r: Rect): boolean {
  return pointInRect(p, r);
}

/** Sets ctx.font/textBaseline for HUD text. Uses real system fonts (Arial/
 * Helvetica/sans-serif), per the brief — the bitmap font is not used here. */
export type HudFontKind = 'label' | 'map' | 'small' | 'tiny';
export function setHudFont(ctx: CanvasRenderingContext2D, kind: HudFontKind = 'label'): void {
  switch (kind) {
    case 'map':
      ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
      break;
    case 'small':
      ctx.font = '11px Arial, Helvetica, sans-serif';
      break;
    case 'tiny':
      ctx.font = 'bold 9px Arial, Helvetica, sans-serif';
      break;
    default:
      ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
  }
  ctx.textBaseline = 'top';
}

/** Fills `r` with the HUD face colour and a 1px bevel (raised by default). */
export function drawHudBevel(ctx: CanvasRenderingContext2D, r: Rect, sunken = false, face: string = HUD.face): void {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  ctx.fillStyle = face;
  ctx.fillRect(x, y, w, h);
  const light = sunken ? HUD.bevelDark : HUD.bevelLight;
  const dark = sunken ? HUD.bevelLight : HUD.bevelDark;
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = dark;
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x + w - 1, y, 1, h);
}

/** Paints the whole bottom-panel background (dark maroon base + thin frame). */
export function drawHudBase(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = HUD.base;
  ctx.fillRect(0, PANEL_Y, SCREEN_W, PANEL_H);
  ctx.strokeStyle = HUD.frame;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, PANEL_Y + 0.5, SCREEN_W - 1, PANEL_H - 1);
}

/** Clips text to `maxW` px by trimming characters (adds no ellipsis — the
 * HUD's boxes are small enough that a hard trim reads fine). */
export function clipTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s).width > maxW) s = s.slice(0, -1);
  return s;
}

/** Team-status word -> one of the three HUD bar colours (green/yellow/red). */
export function teamBarColor(word: TeamStatusWord): string {
  switch (word) {
    case 'Pinned':
    case 'Cowering':
      return HUD.yellow;
    case 'Broken':
    case 'Panicked':
    case 'Routed':
    case 'Destroyed':
    case 'Knocked Out':
      return HUD.red;
    default:
      return HUD.green;
  }
}

/** Team-status word -> the original-game display word (a few of ours don't
 * match the original's vocabulary 1:1). */
const STATUS_DISPLAY: Partial<Record<TeamStatusWord, string>> = {
  Cowering: 'Seeking Cover',
  Routed: 'Fled',
  Destroyed: 'KIA',
  'Knocked Out': 'Destroyed',
  Broken: 'Panicking',
};
export function teamStatusLabel(word: TeamStatusWord): string {
  return STATUS_DISPLAY[word] ?? word;
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

/** Two small scroll-arrow boxes stacked vertically within `r` (up over down). */
export function drawHudScrollArrows(ctx: CanvasRenderingContext2D, r: Rect, upHot: boolean, downHot: boolean): void {
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  const halfH = Math.floor(h / 2);
  drawHudBevel(ctx, { x, y, w, h: halfH }, upHot);
  drawHudBevel(ctx, { x, y: y + halfH, w, h: h - halfH }, downHot);
  const size = Math.max(2, Math.floor(w / 3));
  triangle(ctx, x + w / 2, y + halfH / 2, size, 'up', HUD.text);
  triangle(ctx, x + w / 2, y + halfH + (h - halfH) / 2, size, 'down', HUD.text);
}

export interface HudButtonOpts {
  hot?: boolean;
  disabled?: boolean;
  fontKind?: HudFontKind;
}

/** A small bevelled push-button with a centred label, HUD-styled. */
export function drawHudButton(ctx: CanvasRenderingContext2D, r: Rect, label: string, opts: HudButtonOpts = {}): void {
  drawHudBevel(ctx, r, !!opts.hot);
  setHudFont(ctx, opts.fontKind ?? 'small');
  ctx.fillStyle = opts.disabled ? HUD.dim : HUD.text;
  ctx.textAlign = 'center';
  ctx.fillText(label, Math.round(r.x + r.w / 2), Math.round(r.y + (r.h - 11) / 2));
  ctx.textAlign = 'left';
}
