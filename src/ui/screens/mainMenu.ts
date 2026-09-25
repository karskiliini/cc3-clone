import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { game } from '@/game';
import { drawLogo, drawMetalButton, drawScreenTitle } from '@/ui/chrome';
import { pointInRect } from '@/shared/math';
import { BattleSetupScreen } from './battleSetup';
import { beginMenuFrame, toMenuInput, BottomStrip } from './common';
import { BootCampScreen } from './bootCampPicker';
import { OperationScreen } from './operation';
import { HistoryScreen } from './history';
import { OptionsScreen } from './options';

interface MenuButtonSpec {
  label: string;
  rect: Rect;
  disabled?: boolean;
  action?: () => void;
}

const BTN_W = 340;
const BTN_H = 46;

export class MainMenuScreen implements Screen {
  private buttons: MenuButtonSpec[] = [
    { label: 'Play A Game', rect: { x: 336, y: 148, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new BattleSetupScreen()) },
    { label: 'Boot Camp (Training)', rect: { x: 364, y: 226, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new BootCampScreen()) },
    { label: 'Operation', rect: { x: 392, y: 304, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new OperationScreen()) },
    { label: 'History', rect: { x: 420, y: 382, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new HistoryScreen()) },
    { label: 'Options', rect: { x: 448, y: 460, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new OptionsScreen(this)) },
  ];
  private hotIndex = -1;
  private strip = new BottomStrip({ showBack: false, nextEnabled: false });

  update(_dt: number, input: InputState): void {
    if (input.clicks.length > 0) game.audio?.unlock?.();
    const m = toMenuInput(input);

    this.hotIndex = -1;
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i];
      if (!b.disabled && pointInRect(m.mouse, b.rect)) this.hotIndex = i;
    }
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      for (const b of this.buttons) {
        if (!b.disabled && pointInRect({ x: c.x, y: c.y }, b.rect)) {
          b.action?.();
          return;
        }
      }
    }

    const result = this.strip.update(m);
    if (result.quitOrBack || result.main) {
      // already home; harmless reset
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.options) {
      game.setScreen(new OptionsScreen(this));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);

    drawLogo(ctx);
    drawScreenTitle(ctx, 'MAIN');

    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i];
      drawMetalButton(ctx, b.rect, b.label, { disabled: b.disabled, hot: i === this.hotIndex });
    }

    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.fillStyle = 'rgba(232,232,224,0.7)';
    ctx.textAlign = 'left';
    ctx.fillText('Fan-made tribute to Close Combat III - all art and code original', 16, 522);
    ctx.fillText('Not affiliated with Microsoft or Atomic Games.', 16, 536);

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
