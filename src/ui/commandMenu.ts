// ============================================================================
// commandMenu.ts — right-click popup: vertical list of the seven orders.
// ============================================================================
import type { Rect, Vec2, InputState, Team, OrderType } from '@/shared/types';
import { ORDER_TYPES, ORDER_LABELS, ORDER_HOTKEYS } from '@/shared/types';
import { clamp } from '@/shared/math';
import { PALETTE } from '@/render/palette';
import { drawText, textWidth, FONT_SMALL_H } from '@/render/pixelfont';
import { drawBevelBox, hitRect } from '@/ui/chrome';

const ROW_W = 90;
const ROW_H = 14;
const BORDER = 2;
const PANEL_W = ROW_W + BORDER * 2;
const PANEL_H = ROW_H * ORDER_TYPES.length + BORDER * 2;

export interface CommandMenuOpts {
  canSmoke: boolean;
  canFire: boolean;
}

/** x-offset (px) at which character `i` of `text` begins when drawn with drawText. */
function charStartX(text: string, i: number): number {
  if (i <= 0) return 0;
  return textWidth(text.slice(0, i)) + 1;
}

export class CommandMenu {
  isOpen = false;
  rect: Rect = { x: 0, y: 0, w: PANEL_W, h: PANEL_H };
  private team: Team | null = null;
  private disabled: Partial<Record<OrderType, boolean>> = {};
  private hoverIndex = -1;

  open(at: Vec2, team: Team, opts?: CommandMenuOpts): void {
    const x = clamp(Math.round(at.x), 0, 800 - PANEL_W);
    const y = clamp(Math.round(at.y), 0, 480 - PANEL_H);
    this.rect = { x, y, w: PANEL_W, h: PANEL_H };
    this.team = team;
    this.disabled = {
      fire: opts ? !opts.canFire : false,
      smoke: opts ? !opts.canSmoke : false,
    };
    this.isOpen = true;
    this.hoverIndex = -1;
  }

  close(): void {
    this.isOpen = false;
    this.team = null;
    this.hoverIndex = -1;
  }

  private rowRect(i: number): Rect {
    return { x: this.rect.x + BORDER, y: this.rect.y + BORDER + i * ROW_H, w: ROW_W, h: ROW_H };
  }

  private rowIndexAt(p: Vec2): number | null {
    for (let i = 0; i < ORDER_TYPES.length; i++) {
      if (hitRect(p, this.rowRect(i))) return i;
    }
    return null;
  }

  update(input: InputState): OrderType | 'cancel' | null {
    if (!this.isOpen) return null;

    const hoverIdx = this.rowIndexAt(input.mouse);
    this.hoverIndex = hoverIdx ?? -1;

    if (input.keysPressed.has('escape')) {
      this.close();
      return 'cancel';
    }

    for (const type of ORDER_TYPES) {
      if (input.keysPressed.has(ORDER_HOTKEYS[type]) && !this.disabled[type]) {
        this.close();
        return type;
      }
    }

    for (const c of input.clicks) {
      const p = { x: c.x, y: c.y };
      if (hitRect(p, this.rect)) {
        if (c.button === 0) {
          const idx = this.rowIndexAt(p);
          if (idx != null) {
            const type = ORDER_TYPES[idx];
            if (!this.disabled[type]) {
              this.close();
              return type;
            }
            return null;
          }
        }
      } else if (c.button === 0 || c.button === 2) {
        this.close();
        return 'cancel';
      }
    }

    return null;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.isOpen) return;
    drawBevelBox(ctx, this.rect, false);

    for (let i = 0; i < ORDER_TYPES.length; i++) {
      const type = ORDER_TYPES[i];
      const r = this.rowRect(i);
      const disabled = !!this.disabled[type];
      const hot = this.hoverIndex === i && !disabled;

      if (hot) {
        ctx.fillStyle = PALETTE.gold;
        ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      }

      const label = ORDER_LABELS[type];
      const color = hot ? PALETTE.black : disabled ? PALETTE.dim : PALETTE.text;
      const tx = Math.round(r.x + 4);
      const ty = Math.round(r.y + (r.h - FONT_SMALL_H) / 2);
      drawText(ctx, label, tx, ty, color, 'small');

      const hotkey = ORDER_HOTKEYS[type];
      const idx = label.toLowerCase().indexOf(hotkey.toLowerCase());
      if (idx >= 0) {
        const ux0 = tx + charStartX(label, idx);
        const chWidth = textWidth(label[idx]);
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(ux0), Math.round(ty + FONT_SMALL_H), Math.round(chWidth), 1);
      }
    }
  }
}
