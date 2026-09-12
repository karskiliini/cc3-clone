import type { CursorKind, InputState, Screen } from '@/shared/types';
import { SCREEN_H, SCREEN_W } from '@/shared/types';
import { game } from '@/game';
import { Button, drawTitleBanner } from '@/ui/chrome';
import { drawText, drawTextCentered } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { drawBackdrop } from './common';
import { BattleSetupScreen } from './battleSetup';
import { OperationScreen } from './operation';
import { OptionsScreen } from './options';

const BTN_W = 160;
const BTN_H = 20;

export class MainMenuScreen implements Screen {
  private battleBtn = new Button({ x: (SCREEN_W - BTN_W) / 2, y: 300, w: BTN_W, h: BTN_H }, 'BATTLE');
  private operationBtn = new Button({ x: (SCREEN_W - BTN_W) / 2, y: 328, w: BTN_W, h: BTN_H }, 'OPERATION');
  private optionsBtn = new Button({ x: (SCREEN_W - BTN_W) / 2, y: 356, w: BTN_W, h: BTN_H }, 'OPTIONS');

  update(_dt: number, input: InputState): void {
    if (input.clicks.length > 0) game.audio?.unlock?.();

    if (this.battleBtn.update(input)) {
      game.setScreen(new BattleSetupScreen());
      return;
    }
    if (this.operationBtn.update(input)) {
      game.setScreen(new OperationScreen());
      return;
    }
    if (this.optionsBtn.update(input)) {
      game.setScreen(new OptionsScreen(this));
      return;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawBackdrop(ctx);
    drawTitleBanner(ctx, 'CLOSE COMBAT III', 90);
    drawTextCentered(ctx, 'THE RUSSIAN FRONT', SCREEN_W / 2, 150, PALETTE.gold, 'small');

    this.battleBtn.draw(ctx);
    this.operationBtn.draw(ctx);
    this.optionsBtn.draw(ctx);

    drawText(ctx, "A tribute to the 1999 Atomic Games classic - all art procedural", 16, SCREEN_H - 20, PALETTE.dim, 'small');
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
