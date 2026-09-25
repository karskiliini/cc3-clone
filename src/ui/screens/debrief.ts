import type { BattleResult, CursorKind, InputState, Screen, Side, Team } from '@/shared/types';
import { experienceLevel } from '@/data/experience';
import { medalById } from '@/data/medals';
import { OPERATION } from '@/data/operation';
import { GRAND_CAMPAIGN, operationForIndex } from '@/data/campaign';
import { appendHistory } from '@/data/history';
import { game } from '@/game';
import type { Battle } from '@/sim/battle';
import { prisonerCount } from '@/sim/victory';
import { drawDarkPanel, drawHeading, drawLabel, drawShadowText, UI } from '@/ui/chrome';
import { drawMenuFrame, toMenuInput, BottomStrip, truncateText } from './common';
import { CoaScreen } from './coa';
import { MainMenuScreen } from './mainMenu';
import { advanceOperation } from './operation';
import { RosterScreen } from './roster';

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

type Box = { x: number; y: number; w: number; h: number };
const SCORE: Box = { x: 40, y: 96, w: 720, h: 170 };
const AWARDS: Box = { x: 40, y: 274, w: 720, h: 44 };

/** After the battle: the result, a side-by-side scoreboard, any commendations and the
 * player's teams. In an operation the battle is folded into the campaign on arrival (so the
 * commendations and "next battle" line are this battle's); Continue then goes on to the next
 * battle's course-of-action screen, otherwise to the main menu. Soldiers opens the roster. */
export class DebriefScreen implements Screen {
  private battle: Battle;
  private strip = new BottomStrip({ back: false, next: 'Continue →', soldiers: !!game.campaign });
  /** operation battle just fought: index + land expectation captured before advancing */
  private opBattle: { index: number; expectedVLs?: number } | null = null;
  private recorded = false;

  constructor(battle: Battle) {
    this.battle = battle;
  }

  /** Once per debrief: chronicle the battle (G15) and fold it into the operation/campaign. */
  private record(): void {
    if (this.recorded) return;
    this.recorded = true;
    const st = this.battle.state;
    const playerSide = this.battle.playerSide();
    const enemySide: Side = playerSide === 'german' ? 'soviet' : 'german';
    const op = game.operation;
    appendHistory({
      opIndex: op?.opIndex ?? -1,
      battleIndex: op ? op.index : -1,
      mapId: st.config.mapId,
      year: st.config.year,
      playerSide,
      result: st.result ?? 'draw',
      kills: st.sides[playerSide].kills,
      losses: st.sides[playerSide].losses,
      enemyLosses: st.sides[enemySide].losses,
      durationS: Math.round(st.time),
      foughtAt: Date.now(),
    });
    if (op) {
      this.opBattle = { index: op.index, expectedVLs: OPERATION[op.index]?.expectedVLs };
      advanceOperation(st.result ?? 'draw');
    }
  }

  update(_dt: number, input: InputState): void {
    this.record();
    const result = this.strip.update(toMenuInput(input));
    if (result.soldiers) {
      game.setScreen(new RosterScreen(this));
      return;
    }
    // ESC continues like the forward button (the debrief has no Back).
    if (!result.next && !input.keysPressed.has('escape')) return;
    game.setScreen(game.operation ? new CoaScreen() : new MainMenuScreen());
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'DEBRIEF', () => {
      const state = this.battle.state;
      drawShadowText(ctx, RESULT_WORDS[state.result ?? 'draw'], 400, 80, UI.title, UI.gold, 'rgba(0,0,0,0.8)', 'center');
      this.drawScoreboard(ctx);
      const hasAwards = this.drawAwards(ctx);
      this.drawTeams(ctx, hasAwards ? AWARDS.y + AWARDS.h + 8 : AWARDS.y);
      this.strip.draw(ctx);
    });
  }

  private drawScoreboard(ctx: CanvasRenderingContext2D): void {
    const state = this.battle.state;
    const player = this.battle.playerSide();
    const enemy: Side = player === 'german' ? 'soviet' : 'german';
    const vlPoints = (side: Side) => state.map.victoryLocations.filter((vl) => vl.owner === side).reduce((sum, vl) => sum + vl.value, 0);
    const totalVl = state.map.victoryLocations.reduce((sum, vl) => sum + vl.value, 0);
    // G20: in an operation the land gained is graded against the briefing's expectation.
    const expected = this.opBattle?.expectedVLs;
    // [label, player value, enemy value, higher is better for the player]
    const rows: [string, number, number, boolean][] = [
      [expected != null ? `Victory points held (expected ${expected})` : 'Victory points held', vlPoints(player), vlPoints(enemy), true],
      ['Enemy men killed', state.sides[player].kills, state.sides[enemy].kills, true],
      ['Men lost', state.sides[player].losses, state.sides[enemy].losses, false],
      ['Prisoners taken (worth 3× a kill)', prisonerCount(state, player), prisonerCount(state, enemy), true],
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
      // the land row compares against the expectation when there is one
      const ref = i === 0 && expected != null ? expected : e;
      const better = higherBetter ? p > ref : p < ref;
      const worse = higherBetter ? p < ref : p > ref;
      drawLabel(ctx, better ? '▲' : worse ? '▼' : '–', SCORE.x + SCORE.w - 30, y, UI.label, better ? UI.good : worse ? UI.bad : UI.dim, 'center');
    });
  }

  /** G2: the campaign's commendations for this battle; returns whether any were drawn. */
  private drawAwards(ctx: CanvasRenderingContext2D): boolean {
    const awards = this.opBattle ? game.campaign?.lastAwards ?? [] : [];
    if (awards.length === 0) return false;
    drawDarkPanel(ctx, AWARDS);
    drawLabel(ctx, 'COMMENDATIONS', AWARDS.x + 20, AWARDS.y + 16, UI.label, UI.gold);
    if (awards.length > 2) drawLabel(ctx, `+${awards.length - 2} more`, AWARDS.x + AWARDS.w - 20, AWARDS.y + 16, UI.note, UI.dim, 'right');
    ctx.save();
    ctx.font = UI.note;
    ctx.fillStyle = UI.text;
    awards.slice(0, 2).forEach((a, i) => {
      const honours = [...a.medalIds.map((id) => medalById(id)?.name ?? id), a.promotedTo ? `promoted to ${a.promotedTo}` : ''].filter(Boolean).join(', ');
      ctx.fillText(truncateText(ctx, `${a.rank} ${a.name} — ${honours}`, AWARDS.w - 40), AWARDS.x + 20, AWARDS.y + 29 + i * 12);
    });
    ctx.restore();
    return true;
  }

  private drawTeams(ctx: CanvasRenderingContext2D, top: number): void {
    const state = this.battle.state;
    const player = this.battle.playerSide();
    const TEAMS: Box = { x: 40, y: top, w: 720, h: 548 - top };
    drawDarkPanel(ctx, TEAMS);
    drawHeading(ctx, 'YOUR TEAMS', TEAMS.x + 20, TEAMS.y + 24);
    // G4: what comes next in the operation — the next battle, or the closing line
    const op = this.opBattle ? game.operation : null;
    if (op) {
      const next = op.index >= OPERATION.length
        ? 'OPERATION COMPLETE'
        : `NEXT: ${GRAND_CAMPAIGN[op.opIndex ?? operationForIndex(GRAND_CAMPAIGN, op.index)]?.title ?? ''} — ${OPERATION[op.index].title}`;
      drawLabel(ctx, next, TEAMS.x + TEAMS.w - 20, TEAMS.y + 24, UI.label, UI.accent, 'right');
    }
    // Two columns so every team fits, vehicle teams included (a single column ran out of
    // room after ~8 rows and silently dropped the vehicle teams).
    const colW = (TEAMS.w - 60) / 2;
    const rowH = 16;
    const y0 = TEAMS.y + 64;
    const maxRows = Math.floor((TEAMS.y + TEAMS.h - 10 - y0) / rowH) + 1;
    const cols = [0, 118, 190, 228, 262];
    const fled = state.fledSide === player;
    const teams = [...state.teams.values()].filter((t) => t.side === player);
    // the second column only when the list overflows the first
    for (let c = 0; c < (teams.length > maxRows ? 2 : 1); c++) {
      const x = TEAMS.x + 20 + c * (colW + 20);
      ['Team', 'Experience', 'Men', 'Kills', 'State'].forEach((h, i) => drawLabel(ctx, h, x + cols[i], TEAMS.y + 44, UI.note, UI.dim));
    }
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
