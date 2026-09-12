import type { CursorKind, InputState, Screen } from '@/shared/types';
import { SCREEN_H, SCREEN_W } from '@/shared/types';
import { game } from '@/game';
import { Button, drawMarqueeTitle } from '@/ui/chrome';
import { drawText, drawTextCentered } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { buildMap } from '@/sim/map';
import { getMap } from '@/data/maps';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawBackdrop } from './common';
import { BattleSetupScreen } from './battleSetup';
import { OperationScreen } from './operation';
import { OptionsScreen } from './options';

const BTN_W = 160;
const BTN_H = 20;

// Rendered once, lazily, and cached at module scope so every MainMenuScreen
// instance (returning to the menu, etc.) reuses the same backdrop bitmap.
let titleBg: HTMLCanvasElement | null | undefined; // undefined = not attempted yet, null = failed

function getTitleBackground(): HTMLCanvasElement | null {
  if (titleBg !== undefined) return titleBg;
  try {
    const map = buildMap(getMap('village_1942'));
    titleBg = new TerrainRenderer(map).thumbnail(SCREEN_W, SCREEN_H);
  } catch {
    titleBg = null;
  }
  return titleBg;
}

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
    const bg = getTitleBackground();
    if (bg) {
      ctx.drawImage(bg, 0, 0);
      // darken to ~35% opacity with a vertical gradient (darker top/bottom)
      const grad = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
      grad.addColorStop(0, 'rgba(8,9,7,0.85)');
      grad.addColorStop(0.35, 'rgba(8,9,7,0.6)');
      grad.addColorStop(0.65, 'rgba(8,9,7,0.6)');
      grad.addColorStop(1, 'rgba(8,9,7,0.88)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, SCREEN_W - 8, SCREEN_H - 8);
      ctx.strokeStyle = 'rgba(216,180,72,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(9.5, 9.5, SCREEN_W - 19, SCREEN_H - 19);
    } else {
      drawBackdrop(ctx);
    }

    const cx = SCREEN_W / 2;
    const ruleW = 360;
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(cx - ruleW / 2, 78, ruleW, 1);
    drawMarqueeTitle(ctx, 'CLOSE COMBAT III', cx, 88);
    ctx.fillRect(cx - ruleW / 2, 88 + 17 + 8, ruleW, 1);

    drawTextCentered(ctx, 'THE RUSSIAN FRONT', cx, 88 + 17 + 20, PALETTE.gold, 'big');

    this.battleBtn.draw(ctx);
    this.operationBtn.draw(ctx);
    this.optionsBtn.draw(ctx);

    const credit = "A tribute to the 1999 Atomic Games classic - all art procedural";
    drawText(ctx, credit, 16, SCREEN_H - 20, PALETTE.dim, 'small');
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
