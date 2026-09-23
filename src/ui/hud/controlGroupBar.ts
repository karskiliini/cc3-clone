import type { InputState, Rect } from '@/shared/types';
import { HUD } from '@/render/palette';
import { CONTROL_GROUP_KEYS, type ControlGroupAction, type ControlGroupSlot } from '@/ui/controlGroups';
import { drawHudBevel, hitRect, setHudFont } from './hudChrome';

// The free HUD column above the order bar, clear of the combat-message column.
const X = 812;
const Y = 649;
const WIDTH = 39;
const HEIGHT = 27;

function slotRect(index: number): Rect {
  return { x: X + (index % 5) * (WIDTH + 1), y: Y + Math.floor(index / 5) * (HEIGHT + 1), w: WIDTH, h: HEIGHT };
}

export class ControlGroupBar {
  private hoverIndex = -1;

  update(input: InputState): ControlGroupAction | null {
    this.hoverIndex = CONTROL_GROUP_KEYS.findIndex((_, i) => hitRect(input.mouse, slotRect(i)));
    for (const click of input.clicks) {
      if (click.button !== 0) continue;
      const index = CONTROL_GROUP_KEYS.findIndex((_, i) => hitRect(click, slotRect(i)));
      if (index >= 0) return { key: CONTROL_GROUP_KEYS[index], assign: input.keysDown.has('control') || input.keysDown.has('meta') };
    }
    return null;
  }

  isHovering(): boolean { return this.hoverIndex >= 0; }

  draw(ctx: CanvasRenderingContext2D, slots: readonly ControlGroupSlot[]): void {
    setHudFont(ctx, 'label');
    ctx.fillStyle = HUD.text;
    const active = slots.find((slot) => slot.active);
    ctx.fillText(`Control groups${active ? ` · ${active.key} selected` : ''}`, X, 634);
    slots.forEach((slot, i) => {
      const r = slotRect(i);
      drawHudBevel(ctx, r, slot.count === 0, slot.active ? HUD.darkRed : HUD.face);
      if (slot.active || i === this.hoverIndex) {
        ctx.strokeStyle = slot.active ? HUD.gold : HUD.text;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      }
      ctx.textAlign = 'center';
      setHudFont(ctx, 'label');
      ctx.fillStyle = slot.active ? HUD.gold : slot.count ? HUD.text : HUD.dim;
      ctx.fillText(slot.key, r.x + r.w / 2, r.y + 2);
      setHudFont(ctx, 'tiny');
      ctx.fillStyle = slot.count ? HUD.green : HUD.dim;
      ctx.fillText(slot.count ? `${slot.count} ${slot.count === 1 ? 'team' : 'teams'}` : 'empty', r.x + r.w / 2, r.y + 15);
      ctx.textAlign = 'left';
    });
    setHudFont(ctx, 'tiny');
    ctx.fillStyle = HUD.dim;
    ctx.fillText('Number / click: select', X, 707);
    ctx.fillText('Ctrl + number / click: assign or clear', X, 718);
  }
}
