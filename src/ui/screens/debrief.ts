import type { BattleResult, CursorKind, InputState, Screen, Side, Team } from '@/shared/types';
import { experienceLevel } from '@/data/experience';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { drawDarkPanel, drawHeading, drawLabel, drawShadowText, UI } from '@/ui/chrome';
import { drawMenuFrame, toMenuInput, BottomStrip, truncateText } from './common';
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

const SCORE: { x: number; y: number; w: number; h: number } = { x: 40, y: 100, w: 720, h: 150 };
const TEAMS: { x: number; y: number; w: number; h: number } = { x: 40, y: 266, w: 720, h: 278 };

/** After the battle: the result, a side-by-side scoreboard and the player's teams. Continue
 * returns to the operation (which records the result) or to the main menu. */
export class DebriefScreen implements Screen {
  private battle: Battle;
  private strip = new BottomStrip({ back: false, next: 'Continue →' });

  constructor(battle: Battle) {
    this.battle = battle;
  }

  update(_dt: number, input: InputState): void {
    if (!this.strip.update(toMenuInput(input)).next) return;
    if (game.operation) {
      advanceOperation(this.battle.state.result ?? 'draw');
      game.setScreen(new OperationScreen());
    } else {
      game.setScreen(new MainMenuScreen());
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'DEBRIEF', () => {
      const state = this.battle.state;
      drawShadowText(ctx, RESULT_WORDS[state.result ?? 'draw'], 400, 80, UI.title, UI.gold, 'rgba(0,0,0,0.8)', 'center');
      this.drawScoreboard(ctx);
      this.drawTeams(ctx);
      this.strip.draw(ctx);
    });
  }

  private drawScoreboard(ctx: CanvasRenderingContext2D): void {
    const state = this.battle.state;
    const player = this.battle.playerSide();
    const enemy: Side = player === 'german' ? 'soviet' : 'german';
    const vlPoints = (side: Side) => state.map.victoryLocations.filter((vl) => vl.owner === side).reduce((sum, vl) => sum + vl.value, 0);
    const totalVl = state.map.victoryLocations.reduce((sum, vl) => sum + vl.value, 0);
    // [label, player value, enemy value, higher is better for the player]
    const rows: [string, number, number, boolean][] = [
      ['Victory points held', vlPoints(player), vlPoints(enemy), true],
      ['Enemy men killed', state.sides[player].kills, state.sides[enemy].kills, true],
      ['Men lost', state.sides[player].losses, state.sides[enemy].losses, false],
      ['Morale', Math.round(state.sides[player].morale), Math.round(state.sides[enemy].morale), true],
    ];
    const colP = SCORE.x + 470;
    const colE = SCORE.x + 600;
    drawDarkPanel(ctx, SCORE);
    const name = (s: Side) => (s === 'german' ? 'German' : 'Soviet');
    drawLabel(ctx, `${name(player)} (you)`, colP, SCORE.y + 26, UI.heading, UI.gold, 'right');
    drawLabel(ctx, name(enemy), colE, SCORE.y + 26, UI.heading, UI.gold, 'right');
    rows.forEach(([label, p, e, higherBetter], i) => {
      const y = SCORE.y + 56 + i * 24;
      drawLabel(ctx, label, SCORE.x + 20, y, UI.label, UI.text);
      const suffix = i === 0 ? ` / ${totalVl}` : '';
      drawLabel(ctx, `${p}${suffix}`, colP, y, UI.label, UI.text, 'right');
      drawLabel(ctx, `${e}${suffix}`, colE, y, UI.label, UI.text, 'right');
      const better = higherBetter ? p > e : p < e;
      const worse = higherBetter ? p < e : p > e;
      drawLabel(ctx, better ? '▲' : worse ? '▼' : '–', SCORE.x + SCORE.w - 30, y, UI.label, better ? UI.good : worse ? UI.bad : UI.dim, 'center');
    });
  }

  private drawTeams(ctx: CanvasRenderingContext2D): void {
    const state = this.battle.state;
    const player = this.battle.playerSide();
    drawDarkPanel(ctx, TEAMS);
    drawHeading(ctx, 'YOUR TEAMS', TEAMS.x + 20, TEAMS.y + 24);
    // Two columns so every team fits, vehicle teams included (a single column ran out of
    // room after ~8 rows and silently dropped the vehicle teams).
    const colW = (TEAMS.w - 60) / 2;
    const rowH = 16;
    const y0 = TEAMS.y + 64;
    const maxRows = Math.floor((TEAMS.y + TEAMS.h - 10 - y0) / rowH) + 1;
    const cols = [0, 118, 190, 228, 262];
    for (let c = 0; c < 2; c++) {
      const x = TEAMS.x + 20 + c * (colW + 20);
      ['Team', 'Experience', 'Men', 'Kills', 'State'].forEach((h, i) => drawLabel(ctx, h, x + cols[i], TEAMS.y + 44, UI.note, UI.dim));
    }
    const fled = state.fledSide === player;
    const teams = [...state.teams.values()].filter((t) => t.side === player);
    ctx.save();
    ctx.font = UI.body;
    teams.slice(0, maxRows * 2).forEach((team, i) => {
      const x = TEAMS.x + 20 + Math.floor(i / maxRows) * (colW + 20);
      const y = y0 + (i % maxRows) * rowH;
      const alive = team.soldierIds.filter((id) => state.soldiers.get(id)?.health !== 'dead').length;
      const outcome = finalStateLabel(team, fled);
      ctx.fillStyle = UI.text;
      ctx.fillText(truncateText(ctx, team.name, cols[1] - 8), x, y);
      ctx.fillStyle = UI.dim;
      ctx.fillText(experienceLevel(team.experience), x + cols[1], y);
      ctx.fillStyle = UI.text;
      ctx.fillText(`${alive}/${team.soldierIds.length}`, x + cols[2], y);
      ctx.fillText(String(team.kills), x + cols[3], y);
      ctx.fillStyle = outcome === 'Intact' || outcome === 'Withdrawn' ? UI.text : UI.bad;
      ctx.fillText(outcome, x + cols[4], y);
    });
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
