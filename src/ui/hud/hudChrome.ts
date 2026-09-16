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

/** Clips text to `maxW` px, breaking only on a word boundary and marking the cut with an
 * ellipsis (round5 critique #6/#10: the old char-by-char trim cut mid-word — "has been wounde",
 * "has been destroye" — with no ellipsis, so a clipped line looked identical to a complete one).
 * Falls back to a char-trim only for a single word that alone still overflows `maxW`. */
export function clipTextToWidth(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  const ellipsis = '…';
  const budget = maxW - ctx.measureText(ellipsis).width;
  if (budget <= 0) return ellipsis;
  const words = text.split(' ');
  let out = '';
  for (const w of words) {
    const candidate = out ? `${out} ${w}` : w;
    if (ctx.measureText(candidate).width > budget) break;
    out = candidate;
  }
  if (!out) {
    let s = text;
    while (s.length > 1 && ctx.measureText(s + ellipsis).width > maxW) s = s.slice(0, -1);
    return s + ellipsis;
  }
  return out + ellipsis;
}

/** Picks the largest font / fullest wording that fits `maxW` without cutting a word: each
 * candidate text (full word first, then abbreviations) is tried at the base size and up to
 * `maxShrink` px smaller. Falls back to the last candidate trimmed back to a whole word. The
 * returned `font` is the ctx.font string to draw with; ctx.font is left as it was on entry. */
export function fitHudText(
  ctx: CanvasRenderingContext2D, candidates: readonly string[], maxW: number, maxShrink = 2,
): { text: string; font: string } {
  const base = ctx.font;
  const m = /(\d+(?:\.\d+)?)px/.exec(base);
  const px = m ? parseFloat(m[1]) : 11;
  const fontAt = (size: number) => (m ? base.replace(m[0], `${size}px`) : base);
  try {
    for (const text of candidates) {
      for (let d = 0; d <= maxShrink; d++) {
        const font = fontAt(px - d);
        ctx.font = font;
        if (ctx.measureText(text).width <= maxW) return { text, font };
      }
    }
    const font = fontAt(px - maxShrink);
    ctx.font = font;
    const last = candidates[candidates.length - 1] ?? '';
    const words = last.split(' ');
    while (words.length > 1 && ctx.measureText(words.join(' ')).width > maxW) words.pop();
    return { text: words.join(' '), font };
  } finally {
    ctx.font = base;
  }
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
    case 'Hesitating':
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
    case 'Firing':
    case 'Cowering': // shown as 'Seeking Cover'
      return HUD.statusGreen;
    case 'Pinned':
    case 'Hesitating':
      return HUD.yellow;
    case 'Broken':
    case 'Panicked':
    case 'Routed':
      return HUD.red;
    case 'Destroyed':
    case 'Knocked Out':
      return HUD.dim;
    default: // Waiting/Ambushing/Defending/Moving/Moving Fast/Sneaking/Surrendered/Can't See
      return HUD.text;
  }
}

/** Team-status word -> the original-game display word (a few of ours don't match the original's
 * vocabulary 1:1). Round5 critique #8/#9: this used to also remap 'Destroyed' -> 'KIA' and
 * 'Knocked Out' -> 'Destroyed', which meant the SAME underlying "this vehicle is gone" event
 * displayed as two different words depending on whether the hull or the crew died first — the
 * exact "KIA vs Destroyed used interchangeably" defect. Show both words as-is now; morale.ts's
 * computeTeamStatus is responsible for always picking the same one of the two for a given cause. */
const STATUS_DISPLAY: Partial<Record<TeamStatusWord, string>> = {
  Cowering: 'Seeking Cover',
  Routed: 'Fled',
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
