import type { BattleConfig, BattleResult, CursorKind, InputState, OperationState, Rect, Screen, Side } from '@/shared/types';
import { otherSide } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { game } from '@/game';
import { Battle } from '@/sim/battle';
import { OPERATION, initialForcePool } from '@/data/operation';
import { TEAM_DEFS } from '@/data/units';
import { getMap } from '@/data/maps';
import { drawDarkPanel, drawLogo, drawScreenTitle, drawShadowText, drawSmallMetalButton } from '@/ui/chrome';
import { beginMenuFrame, toMenuInput, BottomStrip, ForcePicker, wordWrap } from './common';
import { MainMenuScreen } from './mainMenu';
import { DeployScreen } from './deploy';

const OPERATION_KEY = 'cc3.operation';

/** Short result word for the briefing header's "past results" line — the manual specifies
 * results carry forward from battle to battle, so the player should be able to see them. */
const RESULT_SHORT: Record<BattleResult, string> = {
  decisive: 'Decisive',
  victory: 'Victory',
  draw: 'Draw',
  defeat: 'Defeat',
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

export class OperationScreen implements Screen {
  private mode: 'new' | 'briefing' | 'complete';
  private newSide: Side = 'german';
  private hasSaved: boolean;

  // new-operation widgets
  private sideGerR: Rect = { x: 220, y: 220, w: 176, h: 26 };
  private sideSovR: Rect = { x: 404, y: 220, w: 176, h: 26 };
  private startR: Rect = { x: 320, y: 272, w: 160, h: 26 };
  private continueR: Rect = { x: 300, y: 312, w: 200, h: 26 };

  private picker: ForcePicker | null = null;
  private strip: BottomStrip;

  constructor() {
    this.hasSaved = loadOperation() != null;
    if (!game.operation) {
      this.mode = 'new';
      this.strip = new BottomStrip({ showBack: true, nextEnabled: false });
    } else if (game.operation.index >= OPERATION.length) {
      this.mode = 'complete';
      this.strip = new BottomStrip({ showBack: true, nextEnabled: false });
    } else {
      this.mode = 'briefing';
      this.strip = new BottomStrip({ showBack: true, nextLabel: 'Next →' });
      this.initPicker();
    }
  }

  private initPicker(): void {
    const op = game.operation;
    if (!op) return;
    const battleDef = OPERATION[op.index];
    const mapDef = getMap(battleDef.mapId);
    // Seed the starting roster from surviving teams, but only as many as fit this battle's
    // requisition budget — carrying the whole (pre-casualty) force pool over unconditionally
    // could put the roster over budget before the player touches anything, showing negative
    // requisition points remaining.
    let spent = 0;
    const startRosterIds: string[] = [];
    for (const f of op.forcePool) {
      const cost = TEAM_DEFS[f.defId]?.cost ?? 0;
      if (spent + cost > op.requisition) continue;
      spent += cost;
      startRosterIds.push(f.defId);
    }
    this.picker = new ForcePicker(op.playerSide, battleDef.year, op.requisition, startRosterIds, mapDef.season === 'winter');
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);

    if (this.mode === 'new') {
      for (const c of m.clicks) {
        if (c.button !== 0) continue;
        const p = { x: c.x, y: c.y };
        if (pointInRect(p, this.sideGerR)) this.newSide = 'german';
        else if (pointInRect(p, this.sideSovR)) this.newSide = 'soviet';
        else if (pointInRect(p, this.startR)) {
          const op: OperationState = {
            index: 0,
            playerSide: this.newSide,
            results: [],
            forcePool: initialForcePool(this.newSide),
            requisition: OPERATION[0].requisition[this.newSide],
          };
          game.operation = op;
          saveOperation(op);
          this.mode = 'briefing';
          this.strip = new BottomStrip({ showBack: true, nextLabel: 'Next →' });
          this.initPicker();
        } else if (this.hasSaved && pointInRect(p, this.continueR)) {
          const saved = loadOperation();
          if (saved) {
            game.operation = saved;
            this.mode = saved.index >= OPERATION.length ? 'complete' : 'briefing';
            this.strip = new BottomStrip({ showBack: true, nextLabel: this.mode === 'briefing' ? 'Next →' : undefined, nextEnabled: this.mode === 'briefing' });
            if (this.mode === 'briefing') this.initPicker();
          }
        }
      }
      const result = this.strip.update(m);
      if (result.quitOrBack || result.main) game.setScreen(new MainMenuScreen());
      return;
    }

    if (this.mode === 'complete') {
      const result = this.strip.update(m);
      if (result.quitOrBack || result.main) {
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

    const result = this.strip.update(m);
    if (result.quitOrBack || result.main) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.next && this.picker.rosterIds.length > 0) {
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
    beginMenuFrame(ctx);
    drawLogo(ctx);
    drawScreenTitle(ctx, 'OPERATION');

    if (this.mode === 'new') {
      drawDarkPanel(ctx, { x: 200, y: 160, w: 400, h: 200 });
      drawShadowText(ctx, 'NEW OPERATION — CHOOSE YOUR SIDE', 220, 194, 'bold 15px Arial, Helvetica, sans-serif', '#f0d840');
      drawSmallMetalButton(ctx, this.sideGerR, 'German', { hot: this.newSide === 'german' });
      drawSmallMetalButton(ctx, this.sideSovR, 'Soviet', { hot: this.newSide === 'soviet' });
      drawSmallMetalButton(ctx, this.startR, 'Start');
      if (this.hasSaved) drawSmallMetalButton(ctx, this.continueR, 'Continue Operation');
      this.strip.draw(ctx);
      ctx.restore();
      return;
    }

    if (this.mode === 'complete') {
      ctx.font = 'bold 28px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f0d840';
      ctx.fillText('OPERATION COMPLETE', 400, 260);
      this.strip.draw(ctx);
      ctx.restore();
      return;
    }

    const op = game.operation;
    if (!op || !this.picker) {
      ctx.restore();
      return;
    }
    const battleDef = OPERATION[op.index];
    const mapDef = getMap(battleDef.mapId);
    drawDarkPanel(ctx, { x: 16, y: 46, w: 768, h: 42 });
    ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0d840';
    ctx.fillText(`BATTLE ${op.index + 1} OF ${OPERATION.length}: ${battleDef.title}`, 24, 62);
    if (op.results.length > 0) {
      ctx.font = '11px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#e8e8e0';
      ctx.textAlign = 'right';
      ctx.fillText(`Past results: ${op.results.map((r) => RESULT_SHORT[r]).join(', ')}`, 776, 62);
      ctx.textAlign = 'left';
    }
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#e8e8e0';
    const desc = wordWrap(`${mapDef.name} — ${mapDef.description}`, 740, 'small').slice(0, 1).join(' ');
    ctx.fillText(desc, 24, 78);

    this.picker.draw(ctx);

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
