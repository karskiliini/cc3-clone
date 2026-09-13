// ============================================================================
// commandMenu.ts — right-click popup: a small vertical maroon menu of orders,
// grouped into the manual's three categories (Movement / Targeting / Dig-in)
// with thin separators and a small colour swatch per order, bold white text,
// red highlight on hover, hotkey underlined.
// ============================================================================
import type { Rect, Vec2, InputState, Team, OrderType } from '@/shared/types';
import { ORDER_LABELS, ORDER_HOTKEYS, ORDER_DOT_COLOR, SCREEN_W, SCREEN_H } from '@/shared/types';
import { clamp } from '@/shared/math';
import { HUD } from '@/render/palette';
import { drawHudBevel, hitRect, setHudFont } from '@/ui/hud/hudChrome';

// Manual's three named categories: Movement, Targeting, Dig-in.
const MENU_GROUPS: OrderType[][] = [
  ['sneak', 'move', 'moveFast'],
  ['fire', 'smoke'],
  ['defend', 'ambush'],
];
const MENU_ORDER: OrderType[] = MENU_GROUPS.flat();

const ROW_W = 104;
const ROW_H = 18; // taller rows = a bigger, easier target (native-feel hit area)
const GROUP_GAP = 4; // thin separator gap between categories
const BORDER = 2;
const SWATCH_SIZE = 6;
const PANEL_W = ROW_W + BORDER * 2;
const PANEL_H = ROW_H * MENU_ORDER.length + GROUP_GAP * (MENU_GROUPS.length - 1) + BORDER * 2;

export interface CommandMenuOpts {
  canSmoke: boolean;
  canFire: boolean;
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** Row layout: (groupIndex, rowWithinGroup, orderType) for every visible row,
 * precomputed once since the grouping never changes at runtime. */
interface RowLayout { type: OrderType; y: number }
function buildLayout(): RowLayout[] {
  const rows: RowLayout[] = [];
  let y = BORDER;
  for (const group of MENU_GROUPS) {
    for (const type of group) {
      rows.push({ type, y });
      y += ROW_H;
    }
    y += GROUP_GAP;
  }
  return rows;
}
const LAYOUT = buildLayout();

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
    return { x: this.rect.x + BORDER, y: this.rect.y + LAYOUT[i].y, w: ROW_W, h: ROW_H };
  }

  private rowIndexAt(p: Vec2): number | null {
    for (let i = 0; i < LAYOUT.length; i++) {
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

    for (const type of MENU_ORDER) {
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
            const type = LAYOUT[idx].type;
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

    // Press-drag-release: mousedown on the team (elsewhere) opened this menu
    // while the right button is still held; releasing it over a row picks
    // that order, same as a left click would.
    for (const r of input.releases) {
      if (r.button !== 2) continue;
      const p = { x: r.x, y: r.y };
      const idx = this.rowIndexAt(p);
      if (idx != null) {
        const type = LAYOUT[idx].type;
        if (!this.disabled[type]) {
          this.close();
          return type;
        }
      }
    }

    return null;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.isOpen) return;
    drawHudBevel(ctx, this.rect, false);

    for (let i = 0; i < LAYOUT.length; i++) {
      const type = LAYOUT[i].type;
      const r = this.rowRect(i);
      const disabled = !!this.disabled[type];
      const hot = this.hoverIndex === i && !disabled;

      if (hot) {
        ctx.fillStyle = HUD.red;
        ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      }

      // Order-colour swatch (manual's exact per-order colour table).
      const swatchColor = ORDER_DOT_COLOR[type];
      const sy = Math.round(r.y + (r.h - SWATCH_SIZE) / 2);
      ctx.fillStyle = disabled ? HUD.dim : swatchColor;
      ctx.fillRect(Math.round(r.x + 3), sy, SWATCH_SIZE, SWATCH_SIZE);
      ctx.strokeStyle = HUD.black;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(r.x + 3) + 0.5, sy + 0.5, SWATCH_SIZE - 1, SWATCH_SIZE - 1);

      const label = titleCase(ORDER_LABELS[type]);
      setHudFont(ctx, 'small');
      const color = disabled ? HUD.dim : HUD.text;
      const tx = Math.round(r.x + 3 + SWATCH_SIZE + 5);
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

    // Thin separators between the three categories (Movement/Targeting/Dig-in).
    ctx.strokeStyle = HUD.bevelDark;
    ctx.lineWidth = 1;
    let rowCursor = 0;
    for (let g = 0; g < MENU_GROUPS.length - 1; g++) {
      rowCursor += MENU_GROUPS[g].length;
      const afterRow = LAYOUT[rowCursor - 1];
      const sepY = Math.round(this.rect.y + afterRow.y + ROW_H + GROUP_GAP / 2);
      ctx.beginPath();
      ctx.moveTo(this.rect.x + 2, sepY + 0.5);
      ctx.lineTo(this.rect.x + this.rect.w - 2, sepY + 0.5);
      ctx.stroke();
    }
  }
}
