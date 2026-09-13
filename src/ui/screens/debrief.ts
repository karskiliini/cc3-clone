import type { BattleResult, CursorKind, InputState, Screen, Side } from '@/shared/types';
import { SIDES } from '@/shared/types';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { drawDarkPanel, drawLogo, drawScreenTitle, drawShadowText } from '@/ui/chrome';
import { beginMenuFrame, toMenuInput, BottomStrip } from './common';
import { MainMenuScreen } from './mainMenu';
import { OperationScreen, advanceOperation } from './operation';

const RESULT_WORDS: Record<BattleResult, string> = {
  decisive: 'Decisive Victory',
  victory: 'Minor Victory',
  draw: 'Draw',
  defeat: 'Minor Defeat',
};

export class DebriefScreen implements Screen {
  private battle: Battle;
  private strip = new BottomStrip({ showBack: true, nextLabel: 'Next →' });

  constructor(battle: Battle) {
    this.battle = battle;
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    const result = this.strip.update(m);
    if (result.quitOrBack || result.main || result.next) {
      const battleResult = this.battle.state.result ?? 'draw';
      if (game.operation) {
        advanceOperation(battleResult);
        game.setScreen(new OperationScreen());
      } else {
        game.setScreen(new MainMenuScreen());
      }
    }
  }

  private drawRatingRow(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, w: number, playerVal: number, enemyVal: number): void {
    ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0f0ec';
    ctx.fillText(label, x, y);
    const arrowX = x + w - 20;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e8e8e0';
    ctx.fillText(`${Math.round(playerVal)} : ${Math.round(enemyVal)}`, arrowX, y);
    let arrow = '→';
    let color = '#e8e8e0';
    if (playerVal > enemyVal * 1.05) {
      arrow = '↑';
      color = '#3fbf3f';
    } else if (enemyVal > playerVal * 1.05) {
      arrow = '↓';
      color = '#d02020';
    }
    ctx.fillStyle = color;
    ctx.font = 'bold 14px Arial, Helvetica, sans-serif';
    ctx.fillText(arrow, x + w, y);
    ctx.textAlign = 'left';
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);
    drawLogo(ctx);
    drawScreenTitle(ctx, 'DEBRIEF');

    const state = this.battle.state;
    const result = state.result ?? 'draw';
    ctx.font = 'bold 32px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(RESULT_WORDS[result], 402, 82);
    ctx.fillStyle = '#f0d840';
    ctx.fillText(RESULT_WORDS[result], 400, 80);
    ctx.textAlign = 'left';

    const colW = 340;
    const colX: Record<Side, number> = { german: 40, soviet: 800 - colW - 40 };
    const playerSide = this.battle.playerSide();
    const enemySide: Side = playerSide === 'german' ? 'soviet' : 'german';
    for (const side of SIDES) {
      const x = colX[side];
      const y = 108;
      const rect = { x, y, w: colW, h: 150 };
      drawDarkPanel(ctx, rect);
      drawShadowText(ctx, side.toUpperCase(), x + 12, y + 20, 'bold 14px Arial, Helvetica, sans-serif', '#f0d840');
      const s = state.sides[side];
      const vls = state.map.victoryLocations.filter((vl) => vl.owner === side);
      const vlValue = vls.reduce((sum, vl) => sum + vl.value, 0);
      const totalValue = state.map.victoryLocations.reduce((sum, vl) => sum + vl.value, 0);
      let ty = y + 44;
      ctx.font = '12px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(`Victory locations held: ${vls.length} (${vlValue}/${totalValue} pts)`, x + 12, ty);
      ty += 20;
      ctx.fillText(`Kills: ${s.kills}`, x + 12, ty);
      ty += 20;
      ctx.fillText(`Losses: ${s.losses}`, x + 12, ty);
      ty += 20;
      ctx.fillText(`Morale: ${Math.round(s.morale)}`, x + 12, ty);
    }

    const ratingRect = { x: 40, y: 270, w: 720, h: 96 };
    drawDarkPanel(ctx, ratingRect);
    const playerStat = state.sides[playerSide];
    const enemyStat = state.sides[enemySide];
    const playerVls = state.map.victoryLocations.filter((vl) => vl.owner === playerSide).reduce((s, vl) => s + vl.value, 0);
    const enemyVls = state.map.victoryLocations.filter((vl) => vl.owner === enemySide).reduce((s, vl) => s + vl.value, 0);
    this.drawRatingRow(ctx, 'Force strength', ratingRect.x + 16, ratingRect.y + 26, ratingRect.w - 32, playerStat.morale, enemyStat.morale);
    this.drawRatingRow(ctx, 'Casualties', ratingRect.x + 16, ratingRect.y + 54, ratingRect.w - 32, enemyStat.losses, playerStat.losses);
    this.drawRatingRow(ctx, 'Land gained', ratingRect.x + 16, ratingRect.y + 82, ratingRect.w - 32, playerVls, enemyVls);

    const teamsRect = { x: 40, y: 384, w: 720, h: 160 };
    drawDarkPanel(ctx, teamsRect);
    drawShadowText(ctx, 'YOUR TEAMS', teamsRect.x + 12, teamsRect.y + 20, 'bold 13px Arial, Helvetica, sans-serif', '#f0d840');
    let ty = teamsRect.y + 40;
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    for (const team of state.teams.values()) {
      if (team.side !== playerSide) continue;
      const alive = team.soldierIds.filter((id) => {
        const soldier = state.soldiers.get(id);
        return soldier && soldier.health !== 'dead';
      }).length;
      ctx.fillStyle = '#f0d840';
      ctx.fillText(team.name, teamsRect.x + 16, ty);
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(`${alive}/${team.soldierIds.length}`, teamsRect.x + 220, ty);
      ctx.fillText(`Kills: ${team.kills}`, teamsRect.x + 300, ty);
      ctx.fillText(team.status, teamsRect.x + 420, ty);
      ty += 15;
      if (ty > teamsRect.y + teamsRect.h - 8) break;
    }

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
