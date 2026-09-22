import type { BattleConfig, BattleResult, CursorKind, InputState, OperationState, Rect, Screen, Side } from '@/shared/types';
import { otherSide } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { game } from '@/game';
import { Battle } from '@/sim/battle';
import { OPERATION, initialForcePool } from '@/data/operation';
import { TEAM_DEFS } from '@/data/units';
import { getMap } from '@/data/maps';
import { drawDarkPanel, drawHeading, drawLabel, drawShadowText, drawSmallMetalButton, UI } from '@/ui/chrome';
import { drawMenuFrame, toMenuInput, BottomStrip, truncateText } from './common';
import { ForcePicker } from './forcePicker';
import { MainMenuScreen } from './mainMenu';
import { DeployScreen } from './deploy';

const OPERATION_KEY = 'cc3.operation';

/** Short result word for the briefing header's "past results" line — the manual specifies
 * results carry forward from battle to battle, so the player should be able to see them. */
const RESULT_SHORT: Record<BattleResult, string> = {
  totalVictory: 'Total Vict.',
  decisiveVictory: 'Decisive Vict.',
  majorVictory: 'Major Vict.',
  minorVictory: 'Minor Vict.',
  draw: 'Draw',
  minorDefeat: 'Minor Def.',
  majorDefeat: 'Major Def.',
  decisiveDefeat: 'Decisive Def.',
  totalDefeat: 'Total Def.',
};

function saveOperation(op: OperationState): void {
  try {
    localStorage.setItem(OPERATION_KEY, JSON.stringify(op));
  } catch {
    // ignore storage errors
  }
}

function loadOperation(): OperationState | null {
  try {
    const raw = localStorage.getItem(OPERATION_KEY);
    return raw ? (JSON.parse(raw) as OperationState) : null;
  } catch {
    return null;
  }
}

/** Advances the campaign after a battle: records the result, rebuilds the surviving
 * force pool from the just-fought Battle, and persists the operation state. */
export function advanceOperation(result: BattleResult): void {
  const op = game.operation;
  if (!op) return;
  op.results.push(result);

  const battle = game.battle;
  if (battle) {
    const side = op.playerSide;
    const survivors: OperationState['forcePool'] = [];
    for (const team of battle.state.teams.values()) {
      if (team.side !== side) continue;
      const alive = team.soldierIds.filter((id) => {
        const s = battle.state.soldiers.get(id);
        return s && s.health !== 'dead';
      }).length;
      if (alive > 0) survivors.push({ defId: team.defId, experience: team.experience, alive });
    }
    if (survivors.length > 0) op.forcePool = survivors;
  }

  op.index += 1;
  if (op.index < OPERATION.length) {
    op.requisition = OPERATION[op.index].requisition[op.playerSide];
  }
  saveOperation(op);
}

const NEW_PANEL: Rect = { x: 200, y: 170, w: 400, h: 200 };

export class OperationScreen implements Screen {
  private mode: 'new' | 'briefing' | 'complete' = 'new';
  private newSide: Side = 'german';
  private hasSaved: boolean;
  private mouse = { x: -1, y: -1 };

  // new-operation widgets
  private sideGerR: Rect = { x: 300, y: 234, w: 132, h: 26 };
  private sideSovR: Rect = { x: 444, y: 234, w: 132, h: 26 };
  private startR: Rect = { x: 224, y: 284, w: 352, h: 26 };
  private continueR: Rect = { x: 224, y: 324, w: 352, h: 26 };

  private picker: ForcePicker | null = null;
  private strip = new BottomStrip({});

  constructor() {
    this.hasSaved = loadOperation() != null;
    if (game.operation && game.operation.index >= OPERATION.length) this.mode = 'complete';
    else if (game.operation) this.enterBriefing();
  }

  private enterBriefing(): void {
    const op = game.operation;
    if (!op) return;
    this.mode = 'briefing';
    this.strip = new BottomStrip({ next: 'Next →' });
    const battleDef = OPERATION[op.index];
    // Seed the starting roster from surviving teams, but only as many as fit this battle's
    // requisition budget — carrying the whole (pre-casualty) force pool over unconditionally
    // could put the roster over budget before the player touches anything.
    let spent = 0;
    const startRosterIds: string[] = [];
    for (const f of op.forcePool) {
      const cost = TEAM_DEFS[f.defId]?.cost ?? 0;
      if (spent + cost > op.requisition) continue;
      spent += cost;
      startRosterIds.push(f.defId);
    }
    this.picker = new ForcePicker(op.playerSide, battleDef.year, op.requisition, startRosterIds);
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    this.mouse = m.mouse;

    if (this.mode === 'new') {
      for (const c of m.clicks) {
        if (c.button !== 0) continue;
        if (pointInRect(c, this.sideGerR)) this.newSide = 'german';
        else if (pointInRect(c, this.sideSovR)) this.newSide = 'soviet';
        else if (pointInRect(c, this.startR)) {
          const op: OperationState = {
            index: 0,
            playerSide: this.newSide,
            results: [],
            forcePool: initialForcePool(this.newSide),
            requisition: OPERATION[0].requisition[this.newSide],
          };
          game.operation = op;
          saveOperation(op);
          this.enterBriefing();
          return;
        } else if (this.hasSaved && pointInRect(c, this.continueR)) {
          const saved = loadOperation();
          if (saved) {
            game.operation = saved;
            if (saved.index >= OPERATION.length) this.mode = 'complete';
            else this.enterBriefing();
            return;
          }
        }
      }
      if (this.strip.update(m).back) game.setScreen(new MainMenuScreen());
      return;
    }

    if (this.mode === 'complete') {
      if (this.strip.update(m).back) {
        game.operation = null;
        try {
          localStorage.removeItem(OPERATION_KEY);
        } catch {
          // ignore
        }
        game.setScreen(new MainMenuScreen());
      }
      return;
    }

    // briefing
    const op = game.operation;
    if (!op || !this.picker) return;
    this.picker.update(m);
    this.strip.nextEnabled = this.picker.rosterIds.length > 0;
    const result = this.strip.update(m);
    if (result.back) {
      game.setScreen(new MainMenuScreen());
    } else if (result.next) {
      const battleDef = OPERATION[op.index];
      const enemy = otherSide(op.playerSide);
      const cfg: BattleConfig = {
        mapId: battleDef.mapId,
        playerSide: op.playerSide,
        year: battleDef.year,
        seed: Date.now() & 0xffff,
        durationS: 20 * 60,
        difficulty: 'normal',
        forces: { [op.playerSide]: [...this.picker.rosterIds], [enemy]: battleDef.aiForces[enemy] } as Record<Side, string[]>,
      };
      game.battleConfig = cfg;
      game.battle = new Battle(cfg);
      game.setScreen(new DeployScreen(game.battle));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'OPERATION', () => {
      if (this.mode === 'new') this.drawNew(ctx);
      else if (this.mode === 'complete') drawShadowText(ctx, 'OPERATION COMPLETE', 400, 270, UI.title, UI.gold, 'rgba(0,0,0,0.8)', 'center');
      else this.drawBriefing(ctx);
      this.strip.draw(ctx);
    });
  }

  private drawNew(ctx: CanvasRenderingContext2D): void {
    const hot = (r: Rect) => pointInRect(this.mouse, r);
    drawHeading(ctx, 'NEW OPERATION', NEW_PANEL.x + 4, NEW_PANEL.y - 12);
    drawDarkPanel(ctx, { ...NEW_PANEL, h: this.hasSaved ? NEW_PANEL.h : NEW_PANEL.h - 40 });
    drawLabel(ctx, `${OPERATION.length} linked battles; your survivors carry over to the next.`, NEW_PANEL.x + 24, NEW_PANEL.y + 34, UI.body, UI.text);
    drawLabel(ctx, 'Fight as', NEW_PANEL.x + 24, this.sideGerR.y + 17, UI.label, UI.text);
    drawSmallMetalButton(ctx, this.sideGerR, 'German', { active: this.newSide === 'german', hot: hot(this.sideGerR) });
    drawSmallMetalButton(ctx, this.sideSovR, 'Soviet', { active: this.newSide === 'soviet', hot: hot(this.sideSovR) });
    drawSmallMetalButton(ctx, this.startR, 'Start New Operation', { hot: hot(this.startR) });
    if (this.hasSaved) drawSmallMetalButton(ctx, this.continueR, 'Continue Saved Operation', { hot: hot(this.continueR) });
  }

  private drawBriefing(ctx: CanvasRenderingContext2D): void {
    const op = game.operation;
    if (!op || !this.picker) return;
    const battleDef = OPERATION[op.index];
    const mapDef = getMap(battleDef.mapId);
    drawDarkPanel(ctx, { x: 16, y: 44, w: 768, h: 42 });
    drawLabel(ctx, `BATTLE ${op.index + 1} OF ${OPERATION.length}: ${battleDef.title}`, 26, 61, UI.label, UI.gold);
    if (op.results.length > 0) {
      drawLabel(ctx, `Past results: ${op.results.map((r) => RESULT_SHORT[r]).join(', ')}`, 774, 61, UI.note, UI.dim, 'right');
    }
    ctx.font = UI.body;
    ctx.fillStyle = UI.text;
    ctx.fillText(truncateText(ctx, `${mapDef.name} — ${mapDef.description}`, 748), 26, 78);
    this.picker.draw(ctx);
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
