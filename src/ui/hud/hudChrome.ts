// ============================================================================
// hudChrome.ts — shared drawing primitives for the dark-maroon in-battle HUD:
// bevelled boxes, the bottom-panel background, real (non-bitmap) fonts, and
// team-status -> colour mappings shared by teamGrid/soldierMonitor/unitRender.
// ============================================================================
import type { Rect, Team, TeamStatusWord, Vec2 } from '@/shared/types';
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

/** Team name-bar colour: driven by team state first (dead/broken -> dark
 * red, suppressed/panicking -> yellow), falling back to a role colour for
 * teams that are otherwise fine — command teams read cyan/teal in the
 * original regardless of activity, everyone else green. */
export function teamBarColor(team: Team): string {
  switch (team.status) {
    case 'Destroyed':
    case 'Knocked Out':
      return HUD.darkRed;
    case 'Broken':
    case 'Panicked':
    case 'Routed':
      return HUD.red;
    case 'Pinned':
    case 'Cowering':
      return HUD.yellow;
    default:
      break;
  }
  if (team.type === 'command') return HUD.cyan;
  return HUD.green;
}

/** Team-status word -> status-text colour (independent of the bar colour). */
export function teamStatusTextColor(word: TeamStatusWord): string {
  switch (word) {
    case 'Ambushing':
    case 'Idle':
      return HUD.green;
    case 'Firing':
      return HUD.yellow;
    case 'Moving Fast':
      return HUD.red;
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
      return HUD.text;
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

// ----------------------------------------------------------------- icons ---
/** Uniform tone per team type for the otherwise-monochrome grid/glyph icons
 * (infantry read khaki/olive, vehicles read steel-blue, command reads cyan)
 * — applied as a colour tint over the icon's opaque pixels only. */
const ICON_TINT: Record<string, string> = {
  rifle: '#9a9a6a', smg: '#9a9a6a', mg: '#9a9a6a', mortar: '#9a9a6a',
  atgun: '#9a9a6a', sniper: '#9a9a6a', atteam: '#9a9a6a', engineer: '#9a9a6a',
  tank: '#7a8fa8', spg: '#7a8fa8', halftrack: '#7a8fa8',
  command: HUD.cyan,
};

const tintCache = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

/** Returns `icon` recoloured (source-atop tint) for the given team type,
 * cached per (icon, type) pair. Falls back to the icon unchanged if no tint
 * is defined for that type. */
export function tintedTeamIcon(icon: HTMLCanvasElement, teamType: string): HTMLCanvasElement {
  const color = ICON_TINT[teamType];
  if (!color) return icon;
  let byColor = tintCache.get(icon);
  if (!byColor) { byColor = new Map(); tintCache.set(icon, byColor); }
  let out = byColor.get(color);
  if (!out) {
    out = document.createElement('canvas');
    out.width = icon.width;
    out.height = icon.height;
    const octx = out.getContext('2d')!;
    octx.drawImage(icon, 0, 0);
    octx.globalCompositeOperation = 'source-atop';
    octx.globalAlpha = 0.55;
    octx.fillStyle = color;
    octx.fillRect(0, 0, icon.width, icon.height);
    octx.globalAlpha = 1;
    octx.globalCompositeOperation = 'source-over';
    byColor.set(color, out);
  }
  return out;
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
