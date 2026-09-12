import type { BattleConfig, BattleResult, CursorKind, InputState, OperationState, Rect, Screen, Side } from '@/shared/types';
import { SCREEN_W, otherSide } from '@/shared/types';
import { game } from '@/game';
import { Battle } from '@/sim/battle';
import { OPERATION, DEFAULT_FORCES, initialForcePool } from '@/data/operation';
import { TEAM_DEFS, teamsForYear } from '@/data/units';
import { getMap } from '@/data/maps';
import { Button, drawButton, drawPanel, drawTitleBanner, hitRect } from '@/ui/chrome';
import { drawText, drawTextCentered } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { drawBackdrop, createBackButton, ListBox, wordWrap } from './common';
import { MainMenuScreen } from './mainMenu';
import { DeployScreen } from './deploy';

const OPERATION_KEY = 'cc3.operation';

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

function clickedIn(input: InputState, r: Rect): boolean {
  for (const c of input.clicks) {
    if (c.button === 0 && hitRect({ x: c.x, y: c.y }, r)) return true;
  }
  return false;
}

export class OperationScreen implements Screen {
  private mode: 'new' | 'briefing' | 'complete';
  private newSide: Side = 'german';
  private hasSaved: boolean;

  // new-operation widgets
  private sideGerR: Rect = { x: (SCREEN_W - 340) / 2, y: 220, w: 160, h: 24 };
  private sideSovR: Rect = { x: (SCREEN_W - 340) / 2 + 180, y: 220, w: 160, h: 24 };
  private startBtn = new Button({ x: (SCREEN_W - 160) / 2, y: 270, w: 160, h: 24 }, 'START');
  private continueBtn = new Button({ x: (SCREEN_W - 200) / 2, y: 310, w: 200, h: 24 }, 'CONTINUE OPERATION');

  // briefing / force-picker widgets
  private availableList = new ListBox({ x: 40, y: 260, w: 320, h: 240 }, 16);
  private chosenList = new ListBox({ x: 440, y: 260, w: 320, h: 240 }, 16);
  private addBtn = new Button({ x: 380, y: 320, w: 40, h: 20 }, '>>');
  private removeBtn = new Button({ x: 380, y: 350, w: 40, h: 20 }, '<<');
  private beginBtn = new Button({ x: SCREEN_W - 180, y: 556, w: 160, h: 20 }, 'BEGIN BATTLE');
  private backBtn = createBackButton('BACK', 20, 556);
  private chosen: string[] = [];
  private availableDefIds: string[] = [];

  constructor() {
    this.hasSaved = loadOperation() != null;
    if (!game.operation) {
      this.mode = 'new';
    } else if (game.operation.index >= OPERATION.length) {
      this.mode = 'complete';
    } else {
      this.mode = 'briefing';
      this.chosen = game.operation.forcePool.map((f) => f.defId);
      this.refreshAvailable();
    }
  }

  private refreshAvailable(): void {
    const op = game.operation;
    if (!op) return;
    const def = OPERATION[op.index];
    const pool = teamsForYear(op.playerSide, def.year);
    this.availableList.items = pool.map((d) => `${d.name} (${d.cost})`);
    this.availableDefIds = pool.map((d) => d.id);
    this.chosenList.items = this.chosen.map((id) => TEAM_DEFS[id]?.name ?? id);
  }

  private requisitionRemaining(): number {
    const op = game.operation;
    if (!op) return 0;
    const spent = this.chosen.reduce((sum, id) => sum + (TEAM_DEFS[id]?.cost ?? 0), 0);
    return op.requisition - spent;
  }

  update(_dt: number, input: InputState): void {
    if (this.mode === 'new') {
      if (clickedIn(input, this.sideGerR)) this.newSide = 'german';
      if (clickedIn(input, this.sideSovR)) this.newSide = 'soviet';
      if (this.startBtn.update(input)) {
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
        this.chosen = op.forcePool.map((f) => f.defId);
        this.refreshAvailable();
      }
      if (this.hasSaved && this.continueBtn.update(input)) {
        const saved = loadOperation();
        if (saved) {
          game.operation = saved;
          this.mode = saved.index >= OPERATION.length ? 'complete' : 'briefing';
          this.chosen = saved.forcePool.map((f) => f.defId);
          this.refreshAvailable();
        }
      }
      if (this.backBtn.update(input)) game.setScreen(new MainMenuScreen());
      return;
    }

    if (this.mode === 'complete') {
      if (this.backBtn.update(input)) {
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
    if (!op) return;
    const defIds = this.availableDefIds;
    this.availableList.update(input);
    this.chosenList.update(input);

    if (this.addBtn.update(input)) {
      const id = defIds[this.availableList.selected];
      const def = id ? TEAM_DEFS[id] : undefined;
      if (def && this.requisitionRemaining() >= def.cost) {
        this.chosen.push(def.id);
        this.chosenList.items = this.chosen.map((cid) => TEAM_DEFS[cid]?.name ?? cid);
      }
    }
    if (this.removeBtn.update(input)) {
      const idx = this.chosenList.selected;
      if (idx >= 0 && idx < this.chosen.length) {
        this.chosen.splice(idx, 1);
        this.chosenList.items = this.chosen.map((cid) => TEAM_DEFS[cid]?.name ?? cid);
        this.chosenList.selected = -1;
      }
    }

    if (this.backBtn.update(input)) {
      game.setScreen(new MainMenuScreen());
      return;
    }

    if (this.beginBtn.update(input) && this.chosen.length > 0) {
      const battleDef = OPERATION[op.index];
      const enemy = otherSide(op.playerSide);
      const cfg: BattleConfig = {
        mapId: battleDef.mapId,
        playerSide: op.playerSide,
        year: battleDef.year,
        seed: Date.now() & 0xffff,
        durationS: 20 * 60,
        difficulty: 'normal',
        forces: { [op.playerSide]: this.chosen, [enemy]: battleDef.aiForces[enemy] } as Record<Side, string[]>,
      };
      game.battleConfig = cfg;
      game.battle = new Battle(cfg);
      game.setScreen(new DeployScreen(game.battle));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawBackdrop(ctx);
    drawTitleBanner(ctx, 'OPERATION', 8);

    if (this.mode === 'new') {
      drawPanel(ctx, { x: (SCREEN_W - 400) / 2, y: 160, w: 400, h: 200 }, { title: 'NEW OPERATION' });
      drawText(ctx, 'CHOOSE YOUR SIDE', (SCREEN_W - 100) / 2, 190, PALETTE.gold, 'small');
      drawButton(ctx, this.sideGerR, 'GERMAN', { pressed: this.newSide === 'german' });
      drawButton(ctx, this.sideSovR, 'SOVIET', { pressed: this.newSide === 'soviet' });
      this.startBtn.draw(ctx);
      if (this.hasSaved) this.continueBtn.draw(ctx);
      this.backBtn.draw(ctx);
      return;
    }

    if (this.mode === 'complete') {
      drawTextCentered(ctx, 'OPERATION COMPLETE', SCREEN_W / 2, 240, PALETTE.gold, 'big');
      this.backBtn.draw(ctx);
      return;
    }

    const op = game.operation;
    if (!op) return;
    const battleDef = OPERATION[op.index];
    const mapDef = getMap(battleDef.mapId);
    drawPanel(ctx, { x: 20, y: 40, w: SCREEN_W - 40, h: 200 }, { title: `BATTLE ${op.index + 1} OF ${OPERATION.length}` });
    drawText(ctx, battleDef.title, 40, 66, PALETTE.gold, 'small');
    drawText(ctx, mapDef.name, 40, 82, PALETTE.text, 'small');
    let ty = 98;
    for (const line of wordWrap(mapDef.description, SCREEN_W - 100, 'small')) {
      drawText(ctx, line, 40, ty, PALETTE.dim, 'small');
      ty += 9;
    }
    drawText(ctx, `Results so far: ${op.results.map((r) => r.toUpperCase()).join(', ') || 'none'}`, 40, 168, PALETTE.text, 'small');
    drawText(ctx, `Requisition remaining: ${this.requisitionRemaining()}`, 40, 184, PALETTE.gold, 'small');

    drawPanel(ctx, { x: 20, y: 250, w: 360, h: 260 }, { title: 'AVAILABLE FORCES' });
    this.availableList.draw(ctx);
    drawPanel(ctx, { x: 420, y: 250, w: 360, h: 260 }, { title: 'YOUR FORCE' });
    this.chosenList.draw(ctx);
    this.addBtn.draw(ctx);
    this.removeBtn.draw(ctx);

    this.backBtn.draw(ctx);
    this.beginBtn.draw(ctx);
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
