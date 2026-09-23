import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { game } from '@/game';
import { drawMetalButton, drawLabel, UI } from '@/ui/chrome';
import { pointInRect } from '@/shared/math';
import { drawMenuFrame, toMenuInput } from './common';
import { BattleSetupScreen } from './battleSetup';
import { OperationScreen } from './operation';
import { OptionsScreen } from './options';

interface MenuButtonSpec {
  label: string;
  rect: Rect;
  action: () => void;
}

const BTN_W = 310;
const BTN_H = 50;

/** The title screen: three banner buttons stepped down across the fire glow, as in CC3. */
export class MainMenuScreen implements Screen {
  private buttons: MenuButtonSpec[] = [
    { label: 'Play A Game', rect: { x: 414, y: 170, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new BattleSetupScreen()) },
    { label: 'Operation', rect: { x: 438, y: 262, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new OperationScreen()) },
    { label: 'Options', rect: { x: 462, y: 354, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new OptionsScreen(this, false)) },
  ];
  private hotIndex = -1;

  update(_dt: number, input: InputState): void {
    if (input.clicks.length > 0) game.audio?.unlock?.();
    const m = toMenuInput(input);
    this.hotIndex = this.buttons.findIndex((b) => pointInRect(m.mouse, b.rect));
    for (const c of m.clicks) {
      const b = this.buttons.find((b) => pointInRect(c, b.rect));
      if (c.button === 0 && b) {
        b.action();
        return;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'MAIN', () => {
      this.buttons.forEach((b, i) => drawMetalButton(ctx, b.rect, b.label, i === this.hotIndex));
      drawLabel(ctx, 'A fan-made tribute to Close Combat III: The Russian Front. All art and code original; not affiliated with Microsoft or Atomic Games.',
        400, 588, UI.note, 'rgba(232,220,208,0.55)', 'center');
    }, { hero: true });
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
