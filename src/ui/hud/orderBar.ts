// ============================================================================
// orderBar.ts — modern-controls addition: a small grid of order buttons in
// the bottom strip's otherwise-empty region (x 812..971, y 728..768), so a
// pending order can be picked without right-clicking. Mirrors the classic
// right-click menu's order set/colours/hotkeys (Z/X/C/V/B/N/M) plus a
// Cancel (Esc) button. The active pending order is highlighted; the whole
// bar is disabled (dim, inert) when no team is selected.
// ============================================================================
import type { InputState, OrderType, Rect } from '@/shared/types';
import { ORDER_HOTKEYS, ORDER_DOT_COLOR } from '@/shared/types';
import { HUD } from '@/render/palette';
import { drawHudBevel, hitRect, setHudFont } from './hudChrome';

// Well clear of Flee/Truce (x 585..615) and of the Combat Messages column + title (x 620..800).
const BAR_X = 812;
const BAR_Y = 728;
const COLS = 4;
const ROWS = 2;
const GAP = 1;
const BTN_W = 39;
const BTN_H = 19;

type Slot = OrderType | 'cancel';
const SLOTS: Slot[] = ['move', 'moveFast', 'sneak', 'fire', 'smoke', 'defend', 'ambush', 'cancel'];
const SLOT_LABEL: Record<Slot, string> = {
  move: 'Move', moveFast: 'Move Fast', sneak: 'Sneak', fire: 'Fire',
  smoke: 'Smoke', defend: 'Defend', ambush: 'Ambush', cancel: 'Cancel',
};
const TOOLTIP_MIN_X = 620;
const TOOLTIP_MAX_X = 1020;

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

      // disabled buttons read recessed, not just dim
      drawHudBevel(ctx, r, !opts.enabled && !active, active ? HUD.red : HUD.base);
      if (hot && !active) {
        ctx.strokeStyle = HUD.bevelLight;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
      }

      if (slot === 'cancel') {
        setHudFont(ctx, 'tiny');
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
      setHudFont(ctx, 'tiny');
      ctx.fillText(hotkey, Math.round(r.x + 11), Math.round(r.y + 5));
    }

    if (this.hoverIndex >= 0) this.drawTooltip(ctx, this.hoverIndex, opts);
  }

  /** Name + hotkey of the hovered button, drawn just above the bar (even when disabled). */
  private drawTooltip(ctx: CanvasRenderingContext2D, i: number, opts: OrderBarOpts): void {
    const slot = SLOTS[i];
    const key = slot === 'cancel' ? 'Esc' : ORDER_HOTKEYS[slot].toUpperCase();
    const text = `${SLOT_LABEL[slot]} (${key})${opts.enabled || slot === 'cancel' ? '' : ' - select a team'}`;
    setHudFont(ctx, 'small');
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const h = 15;
    const r = slotRect(i);
    const x = Math.max(TOOLTIP_MIN_X, Math.min(TOOLTIP_MAX_X - w, Math.round(r.x)));
    const y = BAR_Y - h - 1;
    drawHudBevel(ctx, { x, y, w, h }, false, HUD.black);
    ctx.fillStyle = HUD.text;
    ctx.fillText(text, x + 4, y + 2);
  }
}
