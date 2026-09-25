import type { BattleConfig, CursorKind, InputState, Rect, Screen, Side } from '@/shared/types';
import { clamp, pointInRect } from '@/shared/math';
import { game } from '@/game';
import { Battle } from '@/sim/battle';
import { buildMap } from '@/sim/map';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawDarkPanel, drawHeading, drawLabel, drawSmallMetalButton, UI } from '@/ui/chrome';
import { MAPS } from '@/data/maps';
import { TEAM_DEFS } from '@/data/units';
import { DEFAULT_FORCES } from '@/data/operation';
import { drawMenuFrame, toMenuInput, BottomStrip, wrapText } from './common';
import { ForcePicker } from './forcePicker';
import { MainMenuScreen } from './mainMenu';
import { DeployScreen } from './deploy';

const DURATIONS = [10, 15, 20, 30, 999];
const DIFFICULTIES: ('easy' | 'normal' | 'hard')[] = ['easy', 'normal', 'hard'];
const DIFFICULTY_LABEL: Record<'easy' | 'normal' | 'hard', string> = {
  easy: 'Recruit',
  normal: 'Veteran',
  hard: 'Hero',
};

function durationLabel(min: number): string {
  return min >= 999 ? 'Fight To The Finish' : `${min} Minutes`;
}

function yearForMapId(id: string): number {
  const m = /(\d{4})$/.exec(id);
  return m ? parseInt(m[1], 10) : 1941;
}

/** Second step of Battle mode: edit your force via the shared requisition
 * picker, then Next begins deployment. Back returns to the setup screen. */
class BattleRequisitionScreen implements Screen {
  private picker: ForcePicker;
  private strip = new BottomStrip({ next: 'Next →' });
  private cfgBase: Omit<BattleConfig, 'forces'>;
  private enemySide: Side;
  private enemyForces: string[];
  private backTo: Screen;

  constructor(backTo: Screen, cfgBase: Omit<BattleConfig, 'forces'>, initialIds: string[], enemySide: Side, enemyForces: string[]) {
    this.backTo = backTo;
    this.cfgBase = cfgBase;
    this.enemySide = enemySide;
    this.enemyForces = enemyForces;
    // total budget: the default roster's cost plus 20 spare points, so the
    // player starts with points remaining (the original showed 18)
    const points = initialIds.reduce((sum, id) => sum + (TEAM_DEFS[id]?.cost ?? 0), 0) + 20;
    this.picker = new ForcePicker(cfgBase.playerSide, cfgBase.year, points, initialIds);
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    this.picker.update(m);
    this.strip.nextEnabled = this.picker.rosterIds.length > 0;
    const result = this.strip.update(m);
    if (result.back) {
      game.setScreen(this.backTo);
    } else if (result.next) {
      const cfg: BattleConfig = {
        ...this.cfgBase,
        forces: { [this.picker.side]: [...this.picker.rosterIds], [this.enemySide]: this.enemyForces } as Record<Side, string[]>,
      };
      // a custom battle is not part of a running operation: its debrief must not advance
      // the operation (Operation → Continue reloads it from storage)
      game.operation = null;
      game.campaign = null;
      game.battleConfig = cfg;
      game.battle = new Battle(cfg);
      game.setScreen(new DeployScreen(game.battle));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'REQUISITION', () => {
      this.picker.draw(ctx);
      this.strip.draw(ctx);
    });
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}

const MAP_ROW_H = 24;
const MAP_LIST: Rect = { x: 17, y: 89, w: 358, h: MAPS.length * MAP_ROW_H };
const THUMB: Rect = { x: 46, y: MAP_LIST.y + MAP_LIST.h + 14, w: 300, h: 176 };
const SETTINGS: Rect = { x: 396, y: 88, w: 388, h: 232 };
const DESC: Rect = { x: 396, y: 332, w: 388, h: 212 };
const CUSTOM_KEY = 'cc3.custom';
const CTRL_X = 540;
const CTRL_W = 228;
const rowY = (i: number) => SETTINGS.y + 16 + i * 44;

export class BattleSetupScreen implements Screen {
  private mapSelected = 0;
  private thumbCache = new Map<string, HTMLCanvasElement>();
  private mouse = { x: -1, y: -1 };

  private playerSide: Side = 'german';
  private year: number;
  private difficulty: 'easy' | 'normal' | 'hard' = 'normal';
  private durationMin = 20;

  private sideGerR: Rect = { x: CTRL_X, y: rowY(0), w: CTRL_W / 2 - 4, h: 24 };
  private sideSovR: Rect = { x: CTRL_X + CTRL_W / 2 + 4, y: rowY(0), w: CTRL_W / 2 - 4, h: 24 };
  private yearMinusR: Rect = { x: CTRL_X, y: rowY(1), w: 30, h: 24 };
  private yearPlusR: Rect = { x: CTRL_X + CTRL_W - 30, y: rowY(1), w: 30, h: 24 };
  private diffR: Rect = { x: CTRL_X, y: rowY(2), w: CTRL_W, h: 24 };
  private durR: Rect = { x: CTRL_X, y: rowY(3), w: CTRL_W, h: 24 };
  private saveR: Rect = { x: CTRL_X, y: rowY(4), w: CTRL_W / 2 - 4, h: 24 };
  private loadR: Rect = { x: CTRL_X + CTRL_W / 2 + 4, y: rowY(4), w: CTRL_W / 2 - 4, h: 24 };
  private hasSaved = false;

  private strip = new BottomStrip({ next: 'Next →' });

  constructor() {
    this.year = yearForMapId(MAPS[0].id);
    try {
      this.hasSaved = localStorage.getItem(CUSTOM_KEY) !== null;
    } catch {
      this.hasSaved = false;
    }
  }

  /** Custom-scenario preset (roadmap G15): map/side/year/difficulty/duration persisted to
   * localStorage so a favourite setup can be re-fought; forces are drawn fresh from the
   * year's default OOB at load time. */
  private saveSetup(): void {
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify({
        mapId: MAPS[this.mapSelected].id,
        playerSide: this.playerSide,
        year: this.year,
        difficulty: this.difficulty,
        durationMin: this.durationMin,
      }));
      this.hasSaved = true;
    } catch {
      // quota/private mode: saving is a nicety
    }
  }

  private loadSetup(): void {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as { mapId?: string; playerSide?: Side; year?: number; difficulty?: 'easy' | 'normal' | 'hard'; durationMin?: number };
      const idx = MAPS.findIndex((m) => m.id === p.mapId);
      if (idx >= 0) this.mapSelected = idx;
      if (p.playerSide === 'german' || p.playerSide === 'soviet') this.playerSide = p.playerSide;
      this.year = clamp(p.year ?? 1941, 1941, 1945);
      if (p.difficulty && DIFFICULTIES.includes(p.difficulty)) this.difficulty = p.difficulty;
      if (p.durationMin && DURATIONS.includes(p.durationMin)) this.durationMin = p.durationMin;
    } catch {
      // a corrupt preset is ignored
    }
  }

  private getThumb(id: string): HTMLCanvasElement | null {
    let c = this.thumbCache.get(id);
    if (!c) {
      const def = MAPS.find((m) => m.id === id);
      if (!def) return null;
      c = new TerrainRenderer(buildMap(def)).thumbnail(THUMB.w, THUMB.h);
      this.thumbCache.set(id, c);
    }
    return c;
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    this.mouse = m.mouse;
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      if (pointInRect(c, MAP_LIST)) {
        const idx = Math.floor((c.y - MAP_LIST.y) / MAP_ROW_H);
        if (idx >= 0 && idx < MAPS.length) {
          this.mapSelected = idx;
          this.year = yearForMapId(MAPS[idx].id);
        }
      } else if (pointInRect(c, this.sideGerR)) {
        this.playerSide = 'german';
      } else if (pointInRect(c, this.sideSovR)) {
        this.playerSide = 'soviet';
      } else if (pointInRect(c, this.yearMinusR)) {
        this.year = clamp(this.year - 1, 1941, 1945);
      } else if (pointInRect(c, this.yearPlusR)) {
        this.year = clamp(this.year + 1, 1941, 1945);
      } else if (pointInRect(c, this.diffR)) {
        this.difficulty = DIFFICULTIES[(DIFFICULTIES.indexOf(this.difficulty) + 1) % DIFFICULTIES.length];
      } else if (pointInRect(c, this.durR)) {
        this.durationMin = DURATIONS[(DURATIONS.indexOf(this.durationMin) + 1) % DURATIONS.length];
      } else if (pointInRect(c, this.saveR)) {
        this.saveSetup();
      } else if (this.hasSaved && pointInRect(c, this.loadR)) {
        this.loadSetup();
      }
    }

    const result = this.strip.update(m);
    if (result.back) {
      game.setScreen(new MainMenuScreen());
    } else if (result.next) {
      const def = MAPS[this.mapSelected];
      const enemySide: Side = this.playerSide === 'german' ? 'soviet' : 'german';
      const forces = DEFAULT_FORCES[this.year] ?? DEFAULT_FORCES[1941];
      const cfgBase: Omit<BattleConfig, 'forces'> = {
        mapId: def.id,
        playerSide: this.playerSide,
        year: this.year,
        seed: Date.now() & 0xffff,
        durationS: this.durationMin >= 999 ? 999 * 60 : this.durationMin * 60,
        difficulty: this.difficulty,
        // item 024: realism toggles ride into the battle config
        alwaysSeeEnemy: game.settings.alwaysSeeEnemy,
        neverActOnInitiative: game.settings.neverActOnInitiative,
        alwaysFullEnemyInfo: game.settings.alwaysFullEnemyInfo,
        alwaysObeyOrders: game.settings.alwaysObeyOrders,
      };
      game.setScreen(new BattleRequisitionScreen(this, cfgBase, forces[this.playerSide], enemySide, forces[enemySide]));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'BATTLE', () => {
      const hot = (r: Rect) => pointInRect(this.mouse, r);
      drawHeading(ctx, 'SELECT A MAP', 24, 76);
      drawDarkPanel(ctx, { x: 16, y: 88, w: 360, h: 456 });
      const hotRow = hot(MAP_LIST) ? Math.floor((this.mouse.y - MAP_LIST.y) / MAP_ROW_H) : -1;
      MAPS.forEach((map, i) => {
        const ry = MAP_LIST.y + i * MAP_ROW_H;
        if (i === this.mapSelected || i === hotRow) {
          ctx.fillStyle = i === this.mapSelected ? 'rgba(200,50,30,0.38)' : 'rgba(255,255,255,0.06)';
          ctx.fillRect(MAP_LIST.x, ry, MAP_LIST.w, MAP_ROW_H);
        }
        drawLabel(ctx, map.name, MAP_LIST.x + 12, ry + 17, 'bold 13px Arial, Helvetica, sans-serif', i === this.mapSelected ? UI.gold : UI.text);
        drawLabel(ctx, String(yearForMapId(map.id)), MAP_LIST.x + MAP_LIST.w - 12, ry + 17, UI.body, UI.dim, 'right');
      });

      const def = MAPS[this.mapSelected];
      const thumb = this.getThumb(def.id);
      if (thumb) ctx.drawImage(thumb, THUMB.x, THUMB.y);
      ctx.strokeStyle = 'rgba(210,190,170,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(THUMB.x + 0.5, THUMB.y + 0.5, THUMB.w - 1, THUMB.h - 1);

      drawDarkPanel(ctx, DESC);
      drawLabel(ctx, def.name, DESC.x + 16, DESC.y + 24, UI.heading, UI.gold);
      ctx.font = UI.body;
      ctx.fillStyle = UI.text;
      let ty = DESC.y + 48;
      for (const line of wrapText(ctx, def.description, DESC.w - 32).slice(0, 10)) {
        ctx.fillText(line, DESC.x + 16, ty);
        ty += 16;
      }

      drawHeading(ctx, 'BATTLE SETTINGS', 404, 76);
      drawDarkPanel(ctx, SETTINGS);
      const label = (i: number, text: string) => drawLabel(ctx, text, SETTINGS.x + 16, rowY(i) + 17, UI.label, UI.text);
      label(0, 'Side');
      drawSmallMetalButton(ctx, this.sideGerR, 'German', { active: this.playerSide === 'german', hot: hot(this.sideGerR) });
      drawSmallMetalButton(ctx, this.sideSovR, 'Soviet', { active: this.playerSide === 'soviet', hot: hot(this.sideSovR) });
      label(1, 'Year');
      drawSmallMetalButton(ctx, this.yearMinusR, '−', { hot: hot(this.yearMinusR) });
      drawLabel(ctx, String(this.year), CTRL_X + CTRL_W / 2, rowY(1) + 17, 'bold 14px Arial, Helvetica, sans-serif', UI.gold, 'center');
      drawSmallMetalButton(ctx, this.yearPlusR, '+', { hot: hot(this.yearPlusR) });
      label(2, 'Difficulty');
      drawSmallMetalButton(ctx, this.diffR, DIFFICULTY_LABEL[this.difficulty], { hot: hot(this.diffR) });
      label(3, 'Battle Length');
      drawSmallMetalButton(ctx, this.durR, durationLabel(this.durationMin), { hot: hot(this.durR) });
      label(4, 'Custom Setup');
      drawSmallMetalButton(ctx, this.saveR, 'Save', { hot: hot(this.saveR) });
      if (this.hasSaved) drawSmallMetalButton(ctx, this.loadR, 'Load', { hot: hot(this.loadR) });

      this.strip.draw(ctx);
    });
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
