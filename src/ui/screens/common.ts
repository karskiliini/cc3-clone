// ============================================================================
// common.ts — shared helpers for full-screen UI states: background painting,
// a small ListBox widget, word-wrap, camera-control helpers and a BACK button
// factory. Nothing here owns simulation state.
// ============================================================================
import type { Camera, InputState, Rect } from '@/shared/types';
import { SCREEN_W, SCREEN_H, VIEW_W, VIEW_H } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { panCamera, clampCamera } from '@/engine/camera';
import { Button } from '@/ui/chrome';
import { PALETTE } from '@/render/palette';
import { drawText, textWidth } from '@/render/pixelfont';

// ------------------------------------------------------------------- noise --
/** Deterministic 2D hash in [0,1), used for the painted-texture backdrop dither. */
export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}

// ---------------------------------------------------------------- backdrop --
/**
 * Fills the full 800x600 screen with a dark olive-black painted gradient,
 * a subtle noise dither texture, and a vignette frame. Used by every
 * full-screen overlay before drawing chrome panels on top.
 */
export function drawBackdrop(ctx: CanvasRenderingContext2D): void {
  const w = SCREEN_W;
  const h = SCREEN_H;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#262a20');
  grad.addColorStop(0.55, '#1a1d16');
  grad.addColorStop(1, '#0d0e0b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // painted noise dither
  const step = 4;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const n = hash2(x, y);
      if (n > 0.9) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(x, y, step, step);
      } else if (n < 0.08) {
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        ctx.fillRect(x, y, step, step);
      }
    }
  }

  // vignette
  const grd = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  ctx.strokeStyle = 'rgba(216,180,72,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(9.5, 9.5, w - 19, h - 19);
}

// ------------------------------------------------------------------ button --
/** A BACK button at a conventional spot; screens can reposition freely. */
export function createBackButton(label = 'BACK', x = 20, y = SCREEN_H - 44): Button {
  return new Button({ x, y, w: 100, h: 20 }, label);
}

// ------------------------------------------------------------------ layout --
/** Word-wrap `text` to lines no wider than `maxWidth` px at the given font size. */
export function wordWrap(text: string, maxWidth: number, size: 'small' | 'big' = 'small'): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (cur && textWidth(test, size) > maxWidth) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  color: string,
  lineH = 9,
  size: 'small' | 'big' = 'small',
): number {
  const lines = wordWrap(text, maxWidth, size);
  let cy = y;
  for (const line of lines) {
    drawText(ctx, line, x, cy, color, size);
    cy += lineH;
  }
  return cy;
}

// ------------------------------------------------------------------ ListBox --
/** A simple scrollable single-select list of text rows. */
export class ListBox {
  rect: Rect;
  rowH: number;
  items: string[] = [];
  selected = -1;
  scroll = 0;

  constructor(rect: Rect, rowH: number) {
    this.rect = rect;
    this.rowH = rowH;
  }

  visibleRows(): number {
    return Math.max(1, Math.floor(this.rect.h / this.rowH));
  }

  /** Returns true when the selection changed this frame. */
  update(input: InputState): boolean {
    let changed = false;
    if (pointInRect(input.mouse, this.rect) && input.wheel !== 0) {
      const maxScroll = Math.max(0, this.items.length - this.visibleRows());
      this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + (input.wheel > 0 ? 1 : -1)));
    }
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      if (!pointInRect({ x: c.x, y: c.y }, this.rect)) continue;
      const row = this.scroll + Math.floor((c.y - this.rect.y) / this.rowH);
      if (row >= 0 && row < this.items.length) {
        if (row !== this.selected) changed = true;
        this.selected = row;
      }
    }
    return changed;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    ctx.clip();
    const visible = this.visibleRows();
    for (let i = 0; i < visible; i++) {
      const idx = this.scroll + i;
      if (idx >= this.items.length) break;
      const ry = this.rect.y + i * this.rowH;
      if (idx === this.selected) {
        ctx.fillStyle = 'rgba(216,180,72,0.22)';
        ctx.fillRect(this.rect.x, ry, this.rect.w, this.rowH);
        ctx.strokeStyle = PALETTE.gold;
        ctx.strokeRect(this.rect.x + 0.5, ry + 0.5, this.rect.w - 1, this.rowH - 1);
      }
      drawText(
        ctx,
        this.items[idx],
        this.rect.x + 4,
        ry + Math.round((this.rowH - 7) / 2),
        idx === this.selected ? PALETTE.gold : PALETTE.text,
        'small',
      );
    }
    ctx.restore();
  }
}

// -------------------------------------------------------------- camera ctl --
/** Edge-scroll (cursor near the viewport border) + arrow-key panning, clamped to the map. */
export function updateCameraEdgeScrollAndKeys(
  cam: Camera,
  input: InputState,
  dt: number,
  mapW: number,
  mapH: number,
  edgePx = 8,
  speedPxPerSec = 300,
): void {
  let dx = 0;
  let dy = 0;
  if (input.mouse.y >= 0 && input.mouse.y <= VIEW_H) {
    if (input.mouse.x >= 0 && input.mouse.x < edgePx) dx -= 1;
    if (input.mouse.x <= VIEW_W && input.mouse.x > VIEW_W - edgePx) dx += 1;
    if (input.mouse.y >= 0 && input.mouse.y < edgePx) dy -= 1;
    if (input.mouse.y > VIEW_H - edgePx) dy += 1;
  }
  if (input.keysDown.has('arrowleft')) dx -= 1;
  if (input.keysDown.has('arrowright')) dx += 1;
  if (input.keysDown.has('arrowup')) dy -= 1;
  if (input.keysDown.has('arrowdown')) dy += 1;
  if (dx !== 0 || dy !== 0) panCamera(cam, dx * speedPxPerSec * dt, dy * speedPxPerSec * dt);
  clampCamera(cam, mapW, mapH);
}

export interface DragPanState {
  active: boolean;
  lastX: number;
  lastY: number;
}

export function makeDragPanState(): DragPanState {
  return { active: false, lastX: 0, lastY: 0 };
}

/** Simple right-drag pan (no click/drag distinction) — used by screens without a command menu. */
export function updateRightDragPan(cam: Camera, input: InputState, s: DragPanState, mapW: number, mapH: number): void {
  if (input.buttons.right) {
    if (!s.active) {
      s.active = true;
      s.lastX = input.mouse.x;
      s.lastY = input.mouse.y;
    } else {
      const dx = input.mouse.x - s.lastX;
      const dy = input.mouse.y - s.lastY;
      if (dx !== 0 || dy !== 0) {
        panCamera(cam, -dx, -dy);
        s.lastX = input.mouse.x;
        s.lastY = input.mouse.y;
      }
    }
  } else {
    s.active = false;
  }
  clampCamera(cam, mapW, mapH);
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss < 10 ? '0' : ''}${ss}`;
}
