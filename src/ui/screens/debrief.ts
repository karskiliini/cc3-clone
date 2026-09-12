import type { CursorKind, InputState, Screen, Side } from '@/shared/types';
import { SCREEN_W, SIDES } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { Button, drawPanel, drawTitleBanner } from '@/ui/chrome';
import { drawText, drawTextCentered } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { drawBackdrop } from './common';
import { MainMenuScreen } from './mainMenu';
import { OperationScreen, advanceOperation } from './operation';

const RESULT_WORDS: Record<string, string> = {
  decisive: 'DECISIVE VICTORY',
  victory: 'VICTORY',
  draw: 'DRAW',
  defeat: 'DEFEAT',
};

export class DebriefScreen implements Screen {
  private battle: Battle;
  private continueBtn = new Button({ x: (SCREEN_W - 160) / 2, y: 556, w: 160, h: 20 }, 'CONTINUE');

  constructor(battle: Battle) {
    this.battle = battle;
  }

  update(_dt: number, input: InputState): void {
    if (this.continueBtn.update(input)) {
      const result = this.battle.state.result ?? 'draw';
      if (game.operation) {
        advanceOperation(result);
        game.setScreen(new OperationScreen());
      } else {
        game.setScreen(new MainMenuScreen());
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawBackdrop(ctx);
    const state = this.battle.state;
    const result = state.result ?? 'draw';
    drawTextCentered(ctx, RESULT_WORDS[result] ?? result.toUpperCase(), SCREEN_W / 2, 40, PALETTE.gold, 'big');

    const colW = 340;
    const colX: Record<Side, number> = { german: 40, soviet: SCREEN_W - colW - 40 };
    for (const side of SIDES) {
      const x = colX[side];
      const y = 110;
      drawPanel(ctx, { x, y, w: colW, h: 160 }, { title: side.toUpperCase() });
      const s = state.sides[side];
      const vls = state.map.victoryLocations.filter((vl) => vl.owner === side);
      const vlValue = vls.reduce((sum, vl) => sum + vl.value, 0);
      const totalValue = state.map.victoryLocations.reduce((sum, vl) => sum + vl.value, 0);
      let ty = y + 24;
      drawText(ctx, `VLs held: ${vls.length} (${vlValue}/${totalValue} pts)`, x + 16, ty, PALETTE.text, 'small');
      ty += 16;
      drawText(ctx, `Kills: ${s.kills}`, x + 16, ty, PALETTE.text, 'small');
      ty += 16;
      drawText(ctx, `Losses: ${s.losses}`, x + 16, ty, PALETTE.text, 'small');
      ty += 16;
      drawText(ctx, `Morale: ${Math.round(s.morale)}`, x + 16, ty, PALETTE.text, 'small');
    }

    drawPanel(ctx, { x: 40, y: 290, w: SCREEN_W - 80, h: 250 }, { title: 'YOUR TEAMS' });
    let ty = 316;
    for (const team of state.teams.values()) {
      if (team.side !== this.battle.playerSide()) continue;
      const alive = team.soldierIds.filter((id) => {
        const soldier = state.soldiers.get(id);
        return soldier && soldier.health !== 'dead';
      }).length;
      drawText(ctx, team.name, 56, ty, PALETTE.gold, 'small');
      drawText(ctx, `${alive}/${team.soldierIds.length}`, 280, ty, PALETTE.text, 'small');
      drawText(ctx, `Kills: ${team.kills}`, 360, ty, PALETTE.text, 'small');
      drawText(ctx, team.status, 480, ty, PALETTE.text, 'small');
      ty += 14;
      if (ty > 290 + 240) break;
    }

    this.continueBtn.draw(ctx);
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
