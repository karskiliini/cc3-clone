// ============================================================================
// commandMenu.ts — right-click popup: a small vertical maroon menu of orders,
// bold white text with a red highlight on hover, hotkey underlined.
// ============================================================================
import type { Rect, Vec2, InputState, Team, OrderType } from '@/shared/types';
import { ORDER_TYPES, ORDER_LABELS, ORDER_HOTKEYS, SCREEN_W, SCREEN_H } from '@/shared/types';
import { clamp } from '@/shared/math';
import { HUD } from '@/render/palette';
import { drawHudBevel, hitRect, setHudFont } from '@/ui/hud/hudChrome';

const ROW_W = 96;
const ROW_H = 16;
const BORDER = 2;
const PANEL_W = ROW_W + BORDER * 2;
const PANEL_H = ROW_H * ORDER_TYPES.length + BORDER * 2;

export interface CommandMenuOpts {
  canSmoke: boolean;
  canFire: boolean;
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export class CommandMenu {
  isOpen = false;
  rect: Rect = { x: 0, y: 0, w: PANEL_W, h: PANEL_H };
  private team: Team | null = null;
  private disabled: Partial<Record<OrderType, boolean>> = {};
  private hoverIndex = -1;

  open(at: Vec2, team: Team, opts?: CommandMenuOpts): void {
    const x = clamp(Math.round(at.x), 0, SCREEN_W - PANEL_W);
    const y = clamp(Math.round(at.y), 0, SCREEN_H - PANEL_H);
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
    drawHudBevel(ctx, this.rect, false);

    for (let i = 0; i < ORDER_TYPES.length; i++) {
      const type = ORDER_TYPES[i];
      const r = this.rowRect(i);
      const disabled = !!this.disabled[type];
      const hot = this.hoverIndex === i && !disabled;

      if (hot) {
        ctx.fillStyle = HUD.red;
        ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      }

      const label = titleCase(ORDER_LABELS[type]);
      setHudFont(ctx, 'small');
      const color = disabled ? HUD.dim : HUD.text;
      const tx = Math.round(r.x + 5);
      const ty = Math.round(r.y + 3);
      ctx.fillStyle = color;
      ctx.fillText(label, tx, ty);

      const hotkey = ORDER_HOTKEYS[type];
      const idx = label.toLowerCase().indexOf(hotkey.toLowerCase());
      if (idx >= 0) {
        const before = label.slice(0, idx);
        const ux0 = tx + ctx.measureText(before).width;
        const chWidth = ctx.measureText(label[idx]).width;
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(ux0), Math.round(ty + 12), Math.round(chWidth), 1);
      }
    }
  }
}
