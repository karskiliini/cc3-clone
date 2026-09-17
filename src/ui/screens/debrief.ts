import type { BattleResult, CursorKind, InputState, Screen, Side, Team } from '@/shared/types';
import { SIDES } from '@/shared/types';
import { experienceLevel } from '@/data/experience';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { drawDarkPanel, drawLogo, drawScreenTitle, drawShadowText } from '@/ui/chrome';
import { beginMenuFrame, toMenuInput, BottomStrip } from './common';
import { MainMenuScreen } from './mainMenu';
import { OperationScreen, advanceOperation } from './operation';

export const RESULT_WORDS: Record<BattleResult, string> = {
  totalVictory: 'Total Victory',
  decisiveVictory: 'Decisive Victory',
  majorVictory: 'Major Victory',
  minorVictory: 'Minor Victory',
  draw: 'Draw',
  minorDefeat: 'Minor Defeat',
  majorDefeat: 'Major Defeat',
  decisiveDefeat: 'Decisive Defeat',
  totalDefeat: 'Total Defeat',
};

/** End-of-battle state for the "YOUR TEAMS" table (round5 critique #10): the live HUD's status
 * word is an in-battle activity ("Loading", "Firing", "Moving Fast") that means nothing once the
 * battle is over, so the debrief needs its own small vocabulary of final outcomes. */
export function finalStateLabel(team: Team, fled: boolean): string {
  switch (team.status) {
    case 'Destroyed':
    case 'Knocked Out':
    case 'Routed':
    case 'Surrendered':
      return team.status;
    default:
      return fled ? 'Withdrawn' : 'Intact';
  }
}

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
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    // Two columns so every team fits, vehicle teams included (round5 critique #10: a single
    // one-team-per-row column ran out of vertical room after ~8 rows and silently dropped the
    // four vehicle teams — their kills never made it into the headline-vs-per-team-sum check).
    const rowH = 15;
    const startY = teamsRect.y + 40;
    const maxRows = Math.max(1, Math.floor((teamsRect.y + teamsRect.h - 8 - startY) / rowH));
    const teamColW = (teamsRect.w - 32) / 2;
    const fled = state.fledSide === playerSide;
    const teamsList = [...state.teams.values()].filter((t) => t.side === playerSide);
    for (let i = 0; i < teamsList.length && i < maxRows * 2; i++) {
      const team = teamsList[i];
      const col = Math.floor(i / maxRows);
      const row = i % maxRows;
      const x = teamsRect.x + 16 + col * (teamColW + 16);
      const y = startY + row * rowH;
      const alive = team.soldierIds.filter((id) => {
        const soldier = state.soldiers.get(id);
        return soldier && soldier.health !== 'dead';
      }).length;
      ctx.fillStyle = '#f0d840';
      ctx.fillText(team.name, x, y);
      // how good they were (data/experience.ts: the one set of words for it)
      ctx.fillStyle = '#a8a89c';
      ctx.fillText(experienceLevel(team.experience), x + 98, y);
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(`${alive}/${team.soldierIds.length}`, x + 140, y);
      ctx.fillText(`Kills: ${team.kills}`, x + 190, y);
      ctx.fillText(finalStateLabel(team, fled), x + 260, y);
    }

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
