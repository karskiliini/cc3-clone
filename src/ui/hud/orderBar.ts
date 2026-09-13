// ============================================================================
// orderBar.ts — modern-controls addition: a small grid of order buttons in
// the bottom strip's otherwise-empty region (x 620..780, y 728..768), so a
// pending order can be picked without right-clicking. Mirrors the classic
// right-click menu's order set/colours/hotkeys (Z/X/C/V/B/N/M) plus a
// Cancel (Esc) button. The active pending order is highlighted; the whole
// bar is disabled (dim, inert) when no team is selected.
// ============================================================================
import type { InputState, OrderType, Rect } from '@/shared/types';
import { ORDER_HOTKEYS, ORDER_DOT_COLOR } from '@/shared/types';
import { HUD } from '@/render/palette';
import { drawHudBevel, hitRect, setHudFont } from './hudChrome';

const BAR_X = 620;
const BAR_Y = 728;
const COLS = 4;
const ROWS = 2;
const GAP = 1;
const BTN_W = 39;
const BTN_H = 19;

type Slot = OrderType | 'cancel';
const SLOTS: Slot[] = ['move', 'moveFast', 'sneak', 'fire', 'smoke', 'defend', 'ambush', 'cancel'];

function slotRect(i: number): Rect {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return {
    x: BAR_X + col * (BTN_W + GAP),
    y: BAR_Y + row * (BTN_H + GAP),
    w: BTN_W,
    h: BTN_H,
  };
}

export interface OrderBarOpts {
  enabled: boolean;
  pending: OrderType | null;
}

export class OrderBar {
  private hoverIndex = -1;

  /** Returns the order picked this frame (or 'cancel'), else null. */
  update(input: InputState, opts: OrderBarOpts): OrderType | 'cancel' | null {
    this.hoverIndex = -1;
    for (let i = 0; i < SLOTS.length; i++) {
      if (hitRect(input.mouse, slotRect(i))) this.hoverIndex = i;
    }
    if (!opts.enabled) return null;
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      for (let i = 0; i < SLOTS.length; i++) {
        if (hitRect({ x: c.x, y: c.y }, slotRect(i))) return SLOTS[i];
      }
    }
    return null;
  }

  /** True while the pointer hovers any (enabled) button — used for the
   * modern "hand" cursor-over-HUD-buttons feedback. */
  isHovering(): boolean {
    return this.hoverIndex >= 0;
  }

  draw(ctx: CanvasRenderingContext2D, opts: OrderBarOpts): void {
    setHudFont(ctx, 'tiny');
    for (let i = 0; i < SLOTS.length; i++) {
      const slot = SLOTS[i];
      const r = slotRect(i);
      const active = slot !== 'cancel' && opts.pending === slot;
      const hot = this.hoverIndex === i && opts.enabled;

      drawHudBevel(ctx, r, false, active ? HUD.red : HUD.base);
      if (hot && !active) {
        ctx.strokeStyle = HUD.bevelLight;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
      }

      if (slot === 'cancel') {
        ctx.fillStyle = opts.enabled || opts.pending ? HUD.text : HUD.dim;
        ctx.fillText('Esc', Math.round(r.x + 4), Math.round(r.y + 5));
        continue;
      }

      const dotColor = opts.enabled ? ORDER_DOT_COLOR[slot] : HUD.dim;
      ctx.fillStyle = dotColor;
      ctx.fillRect(Math.round(r.x + 3), Math.round(r.y + 6), 5, 5);
      ctx.strokeStyle = HUD.black;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(r.x + 3) + 0.5, Math.round(r.y + 6) + 0.5, 4, 4);

      const hotkey = ORDER_HOTKEYS[slot].toUpperCase();
      ctx.fillStyle = opts.enabled ? HUD.text : HUD.dim;
      ctx.fillText(hotkey, Math.round(r.x + 11), Math.round(r.y + 5));
    }
  }
}
