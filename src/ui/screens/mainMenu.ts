import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { game } from '@/game';
import { drawLogo, drawMetalButton, drawScreenTitle } from '@/ui/chrome';
import { pointInRect } from '@/shared/math';
import { beginMenuFrame, toMenuInput, BottomStrip } from './common';
import { BattleSetupScreen } from './battleSetup';
import { OperationScreen } from './operation';
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
    { label: 'Play A Game', rect: { x: 340, y: 148, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new BattleSetupScreen()) },
    { label: 'Boot Camp (Training)', rect: { x: 360, y: 236, w: BTN_W, h: BTN_H }, disabled: true },
    { label: 'Operation', rect: { x: 380, y: 324, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new OperationScreen()) },
    { label: 'Options', rect: { x: 400, y: 412, w: BTN_W, h: BTN_H }, action: () => game.setScreen(new OptionsScreen(this)) },
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
    ctx.fillText('Microsoft(R) Close Combat(TM) III: The Russian Front (tribute) - all art procedural', 16, 522);
    ctx.fillText('(c) 1998-1999 Atomic Games, Inc. -- fan-made clone, no affiliation.', 16, 536);

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
