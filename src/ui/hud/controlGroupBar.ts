import type { InputState, Rect } from '@/shared/types';
import { HUD } from '@/render/palette';
import { CONTROL_GROUP_KEYS, type ControlGroupAction, type ControlGroupSlot } from '@/ui/controlGroups';
import { drawHudBevel, hitRect } from './hudChrome';

// The original's bottom strip shows only a tiny grid glyph (x ~137..152, y 744..760) whose
// cells mark which control groups hold teams — no panel, no labels. Groups stay on the
// keyboard: a number recalls, Ctrl+number assigns, Ctrl+the group's own number clears.
const GLYPH: Rect = { x: 135, y: 744, w: 16, h: 16 };
const CELLS = 4; // 4x4 cells for the ten group keys; the last row's odd cell stays dark
const CELL = 4;

function cellRect(index: number): Rect {
  return {
    x: GLYPH.x + (index % CELLS) * (CELL + 0) + 0,
    y: GLYPH.y + Math.floor(index / CELLS) * CELL,
    w: CELL - 1,
    h: CELL - 1,
  };
}

export class ControlGroupBar {
  private hoverIndex = -1;

  update(input: InputState): ControlGroupAction | null {
    this.hoverIndex = CONTROL_GROUP_KEYS.findIndex((_, i) => hitRect(input.mouse, cellRect(i)));
    for (const click of input.clicks) {
      if (click.button !== 0) continue;
      const index = CONTROL_GROUP_KEYS.findIndex((_, i) => hitRect(click, cellRect(i)));
      if (index >= 0) return { key: CONTROL_GROUP_KEYS[index], assign: input.keysDown.has('control') || input.keysDown.has('meta') };
    }
    return null;
  }

  isHovering(): boolean { return this.hoverIndex >= 0; }

  draw(ctx: CanvasRenderingContext2D, slots: readonly ControlGroupSlot[]): void {
    // refs11: the box stays dark/empty until a group actually holds teams —
    // only occupied cells light up (gold when active, green otherwise).
    drawHudBevel(ctx, GLYPH, true, HUD.black);
    slots.forEach((slot, i) => {
      if (!slot.count) return;
      const r = cellRect(i);
      ctx.fillStyle = slot.active ? HUD.gold : '#3f7a34';
      ctx.fillRect(Math.round(r.x) + 1, Math.round(r.y) + 1, r.w - 1, r.h - 1);
      if (slot.active || i === this.hoverIndex) {
        ctx.strokeStyle = HUD.gold;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      }
    });
  }
}
