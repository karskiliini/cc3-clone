import type { BattleConfig, CursorKind, InputState, Rect, Screen, Side } from '@/shared/types';
import { clamp } from '@/shared/math';
import { pointInRect } from '@/shared/math';
import { game } from '@/game';
import { Battle } from '@/sim/battle';
import { buildMap } from '@/sim/map';
import { TerrainRenderer } from '@/render/terrainRender';
import { drawDarkPanel, drawLogo, drawScreenTitle, drawShadowText, drawSmallMetalButton } from '@/ui/chrome';
import { MAPS } from '@/data/maps';
import { TEAM_DEFS } from '@/data/units';
import { DEFAULT_FORCES } from '@/data/operation';
import { beginMenuFrame, toMenuInput, BottomStrip, ForcePicker, wordWrap } from './common';
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
  return min >= 999 ? 'Fight To The Finish' : `${min} MIN`;
}

function yearForMapId(id: string): number {
  const m = /(\d{4})$/.exec(id);
  return m ? parseInt(m[1], 10) : 1941;
}

/** Second step of Battle mode: edit your force via the shared requisition
 * picker, then Next begins deployment. */
class BattleRequisitionScreen implements Screen {
  private picker: ForcePicker;
  private strip = new BottomStrip({ showBack: true, nextLabel: 'Next →' });
  private cfgBase: Omit<BattleConfig, 'forces'>;
  private enemySide: Side;
  private enemyForces: string[];

  constructor(cfgBase: Omit<BattleConfig, 'forces'>, side: Side, year: number, initialIds: string[], enemySide: Side, enemyForces: string[], winterMap: boolean) {
    this.cfgBase = cfgBase;
    this.enemySide = enemySide;
    this.enemyForces = enemyForces;
    const points = initialIds.reduce((sum, id) => sum + (TEAM_DEFS[id]?.cost ?? 0), 0);
    this.picker = new ForcePicker(side, year, points, initialIds, winterMap);
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    this.picker.update(m);
    const result = this.strip.update(m);
    if (result.quitOrBack) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.main) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.options) return;
    if (result.next && this.picker.rosterIds.length > 0) {
      const cfg: BattleConfig = {
        ...this.cfgBase,
        forces: { [this.picker.side]: [...this.picker.rosterIds], [this.enemySide]: this.enemyForces } as Record<Side, string[]>,
      };
      game.battleConfig = cfg;
      game.battle = new Battle(cfg);
      game.setScreen(new DeployScreen(game.battle));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);
    drawLogo(ctx);
    drawScreenTitle(ctx, 'REQUISITION');
    this.picker.draw(ctx);
    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}

export class BattleSetupScreen implements Screen {
  private mapSelected = 0;
  private mapListRect: Rect = { x: 24, y: 96, w: 340, h: 176 };
  private thumbCache = new Map<string, HTMLCanvasElement>();

  private playerSide: Side = 'german';
  private year = 1941;
  private difficulty: 'easy' | 'normal' | 'hard' = 'normal';
  private durationMin = 20;

  private sideGerR: Rect = { x: 408, y: 102, w: 176, h: 22 };
  private sideSovR: Rect = { x: 592, y: 102, w: 176, h: 22 };
  private yearMinusR: Rect = { x: 408, y: 148, w: 28, h: 22 };
  private yearPlusR: Rect = { x: 740, y: 148, w: 28, h: 22 };
  private diffR: Rect = { x: 408, y: 194, w: 360, h: 22 };
  private durR: Rect = { x: 408, y: 240, w: 360, h: 22 };

  private strip = new BottomStrip({ showBack: true, nextLabel: 'Next →' });

  constructor() {
    this.year = yearForMapId(MAPS[0].id);
  }

  private getThumb(id: string): HTMLCanvasElement | null {
    let c = this.thumbCache.get(id);
    if (!c) {
      const def = MAPS.find((m) => m.id === id);
      if (!def) return null;
      c = new TerrainRenderer(buildMap(def)).thumbnail(300, 176);
      this.thumbCache.set(id, c);
    }
    return c;
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);

    if (m.wheel !== 0 && pointInRect(m.mouse, this.mapListRect)) {
      // no scroll needed: only 5 maps, all fit
    }
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      const rowH = this.mapListRect.h / MAPS.length;
      if (pointInRect(p, this.mapListRect)) {
        const idx = Math.floor((p.y - this.mapListRect.y) / rowH);
        if (idx >= 0 && idx < MAPS.length) {
          this.mapSelected = idx;
          this.year = yearForMapId(MAPS[idx].id);
        }
      } else if (pointInRect(p, this.sideGerR)) {
        this.playerSide = 'german';
      } else if (pointInRect(p, this.sideSovR)) {
        this.playerSide = 'soviet';
      } else if (pointInRect(p, this.yearMinusR)) {
        this.year = clamp(this.year - 1, 1941, 1945);
      } else if (pointInRect(p, this.yearPlusR)) {
        this.year = clamp(this.year + 1, 1941, 1945);
      } else if (pointInRect(p, this.diffR)) {
        const idx = DIFFICULTIES.indexOf(this.difficulty);
        this.difficulty = DIFFICULTIES[(idx + 1) % DIFFICULTIES.length];
      } else if (pointInRect(p, this.durR)) {
        const idx = DURATIONS.indexOf(this.durationMin);
        this.durationMin = DURATIONS[(idx + 1) % DURATIONS.length];
      }
    }

    const result = this.strip.update(m);
    if (result.quitOrBack || result.main) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.next) {
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
      };
      game.setScreen(
        new BattleRequisitionScreen(
          cfgBase,
          this.playerSide,
          this.year,
          forces[this.playerSide],
          enemySide,
          forces[enemySide],
          def.season === 'winter',
        ),
      );
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);
    drawLogo(ctx);
    drawScreenTitle(ctx, 'BATTLE');

    drawDarkPanel(ctx, { x: 16, y: 88, w: 360, h: 460 });
    drawShadowText(ctx, 'SELECT A MAP', 24, 76, 'bold 15px Arial, Helvetica, sans-serif', '#f0d840');

    const rowH = this.mapListRect.h / MAPS.length;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.mapListRect.x, this.mapListRect.y, this.mapListRect.w, this.mapListRect.h);
    ctx.clip();
    for (let i = 0; i < MAPS.length; i++) {
      const ry = this.mapListRect.y + i * rowH;
      if (i === this.mapSelected) {
        ctx.fillStyle = 'rgba(200,50,30,0.35)';
        ctx.fillRect(this.mapListRect.x, ry, this.mapListRect.w, rowH);
      }
      ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = i === this.mapSelected ? '#f0d840' : '#f0f0ec';
      ctx.fillText(MAPS[i].name, this.mapListRect.x + 8, ry + rowH / 2 + 4);
    }
    ctx.restore();

    const def = MAPS[this.mapSelected];
    const thumb = this.getThumb(def.id);
    const thumbRect: Rect = { x: 32, y: 284, w: 300, h: 176 };
    if (thumb) ctx.drawImage(thumb, thumbRect.x, thumbRect.y);
    ctx.strokeStyle = 'rgba(210,210,205,0.5)';
    ctx.strokeRect(thumbRect.x + 0.5, thumbRect.y + 0.5, thumbRect.w - 1, thumbRect.h - 1);

    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#e8e8e0';
    let ty = 480;
    for (const line of wordWrap(def.description, 340, 'small')) {
      ctx.fillText(line, 24, ty);
      ty += 14;
      if (ty > 540) break;
    }

    drawDarkPanel(ctx, { x: 396, y: 84, w: 392, h: 400 });
    drawShadowText(ctx, 'FORCE', 404, 76, 'bold 15px Arial, Helvetica, sans-serif', '#f0d840');

    ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#f0d840';
    ctx.fillText('SIDE', 408, 96);
    drawSmallMetalButton(ctx, this.sideGerR, 'German', { hot: this.playerSide === 'german' });
    drawSmallMetalButton(ctx, this.sideSovR, 'Soviet', { hot: this.playerSide === 'soviet' });

    ctx.fillText('YEAR', 408, 142);
    drawSmallMetalButton(ctx, this.yearMinusR, '-');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0f0ec';
    ctx.fillText(String(this.year), 594, 163);
    ctx.textAlign = 'left';
    drawSmallMetalButton(ctx, this.yearPlusR, '+');

    ctx.fillStyle = '#f0d840';
    ctx.fillText('DIFFICULTY', 408, 188);
    drawSmallMetalButton(ctx, this.diffR, DIFFICULTY_LABEL[this.difficulty]);

    ctx.fillText('BATTLE LENGTH', 408, 234);
    drawSmallMetalButton(ctx, this.durR, durationLabel(this.durationMin));

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
