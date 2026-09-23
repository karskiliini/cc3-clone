// ============================================================================
// common.ts — the poster menu frame shared by every menu screen (main menu,
// battle setup, requisition, operation, options, debrief): the letterboxed
// 800x600 MENU area centred in the 1024x768 canvas, its bottom button strip,
// and canvas text helpers. Menu screens draw and hit-test in MENU-local
// coordinates (0..800, 0..600).
// ============================================================================
import type { InputState, Rect } from '@/shared/types';
import { SCREEN_W, SCREEN_H, MENU_X, MENU_Y, MENU_W, MENU_H } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { drawLogo, drawScreenTitle, drawSmallMetalButton } from '@/ui/chrome';
import { drawPosterBackground } from '@/render/menuArt';

/** Returns a copy of `input` with mouse/click/release points translated into MENU-local space. */
export function toMenuInput(input: InputState): InputState {
  return {
    ...input,
    mouse: { x: input.mouse.x - MENU_X, y: input.mouse.y - MENU_Y },
    clicks: input.clicks.map((c) => ({ x: c.x - MENU_X, y: c.y - MENU_Y, button: c.button })),
    releases: input.releases.map((c) => ({ x: c.x - MENU_X, y: c.y - MENU_Y, button: c.button })),
  };
}

/**
 * Draws one menu screen: black letterbox, the poster (the pointing soldier on the main menu,
 * the plain burning town, dimmed, behind the working screens' panels), the logotype and the
 * screen title, then `body` in MENU-local coordinates with a clean text state.
 */
export function drawMenuFrame(ctx: CanvasRenderingContext2D, title: string, body: () => void, opts: { hero?: boolean } = {}): void {
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.translate(MENU_X, MENU_Y);
  ctx.beginPath();
  ctx.rect(0, 0, MENU_W, MENU_H);
  ctx.clip();
  drawPosterBackground(ctx, opts.hero ? 'hero' : 'plain');
  if (!opts.hero) {
    ctx.fillStyle = 'rgba(16,4,3,0.35)';
    ctx.fillRect(0, 0, MENU_W, MENU_H);
  }
  drawLogo(ctx);
  drawScreenTitle(ctx, title);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  body();
  ctx.restore();
}

// -------------------------------------------------------------- BottomStrip --
const STRIP_Y = 562;
const BACK_R: Rect = { x: 16, y: STRIP_Y, w: 92, h: 22 };
const NEXT_R: Rect = { x: 692, y: STRIP_Y, w: 92, h: 22 };

export interface BottomStripConfig {
  /** Show the "← Back" button at the left (every screen but the main menu). */
  back?: boolean;
  /** Label of the right-hand forward button; omitted = no forward button. */
  next?: string;
}

/** The control strip along the bottom of the menu screens: only the buttons that do
 * something on this screen — "← Back" on the left, the forward action on the right.
 * `update` expects MENU-local input (see `toMenuInput`). */
export class BottomStrip {
  back: boolean;
  next: string | undefined;
  /** false greys the forward button out (e.g. Next with an empty roster). */
  nextEnabled = true;
  private mouse = { x: -1, y: -1 };

  constructor(cfg: BottomStripConfig) {
    this.back = cfg.back ?? true;
    this.next = cfg.next;
  }

  update(input: InputState): { back: boolean; next: boolean } {
    this.mouse = input.mouse;
    let back = false;
    let next = false;
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      if (this.back && pointInRect(c, BACK_R)) back = true;
      else if (this.next && this.nextEnabled && pointInRect(c, NEXT_R)) next = true;
    }
    if (this.back && input.keysPressed.has('escape')) back = true;
    return { back, next };
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.back) drawSmallMetalButton(ctx, BACK_R, '← Back', { hot: pointInRect(this.mouse, BACK_R) });
    if (this.next) {
      drawSmallMetalButton(ctx, NEXT_R, this.next, { hot: pointInRect(this.mouse, NEXT_R), disabled: !this.nextEnabled });
    }
  }
}

// --------------------------------------------------------------------- text --
/** Word-wraps `text` to lines no wider than `maxWidth` in the ctx's current font. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const test = cur ? `${cur} ${word}` : word;
    if (cur && ctx.measureText(test).width > maxWidth) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** `text` cut to fit `maxW` in the ctx's current font, with an ellipsis when cut. */
export function truncateText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
