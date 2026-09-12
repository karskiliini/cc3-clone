import type { BattleConfig, CursorKind, InputState, Rect, Screen, Side } from '@/shared/types';
import { clamp } from '@/shared/math';
import { game } from '@/game';
import { Battle } from '@/sim/battle';
import { buildMap } from '@/sim/map';
import { TerrainRenderer } from '@/render/terrainRender';
import { getTeamIcon } from '@/render/sprites';
import { Button, drawButton, drawPanel, drawTitleBanner, hitRect } from '@/ui/chrome';
import { drawText, drawTextCentered, textWidth } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { MAPS } from '@/data/maps';
import { TEAM_DEFS } from '@/data/units';
import { DEFAULT_FORCES } from '@/data/operation';
import { drawBackdrop, createBackButton, ListBox, wordWrap } from './common';
import { MainMenuScreen } from './mainMenu';
import { DeployScreen } from './deploy';

const DURATIONS = [10, 15, 20, 30];
const DIFFICULTIES: ('easy' | 'normal' | 'hard')[] = ['easy', 'normal', 'hard'];

function clickedIn(input: InputState, r: Rect): boolean {
  for (const c of input.clicks) {
    if (c.button === 0 && hitRect({ x: c.x, y: c.y }, r)) return true;
  }
  return false;
}

function yearForMapId(id: string): number {
  const m = /(\d{4})$/.exec(id);
  return m ? parseInt(m[1], 10) : 1941;
}

export class BattleSetupScreen implements Screen {
  private mapList = new ListBox({ x: 30, y: 70, w: 340, h: 80 }, 16);
  private thumbCache = new Map<string, HTMLCanvasElement>();

  private playerSide: Side = 'german';
  private year = 1941;
  private difficulty: 'easy' | 'normal' | 'hard' = 'normal';
  private durationMin = 20;

  // FORCE panel is { x: 400, y: 40, w: 380, h: 500 }; controls are inset 8px
  // from the panel's left/right edges (400+8=408 .. 400+380-8=772), and each
  // control sits below its own 12px label line.
  private sideGerR: Rect = { x: 408, y: 68, w: 180, h: 20 };
  private sideSovR: Rect = { x: 592, y: 68, w: 180, h: 20 };
  private yearMinusR: Rect = { x: 408, y: 104, w: 24, h: 20 };
  private yearPlusR: Rect = { x: 748, y: 104, w: 24, h: 20 };
  private diffR: Rect = { x: 408, y: 140, w: 364, h: 20 };
  private durR: Rect = { x: 408, y: 176, w: 364, h: 20 };
  private forcesList = new ListBox({ x: 408, y: 212, w: 364, h: 320 }, 16);

  private backBtn = createBackButton('BACK', 400, 556);
  private startBtn: Button = new Button({ x: 700, y: 556, w: 80, h: 20 }, 'START');

  constructor() {
    this.mapList.items = MAPS.map((m) => m.name);
    this.mapList.selected = 0;
    this.year = yearForMapId(MAPS[0].id);
    this.refreshForcesList();
  }

  private refreshForcesList(): void {
    const ids = DEFAULT_FORCES[this.year]?.[this.playerSide] ?? [];
    this.forcesList.items = ids.map((id) => TEAM_DEFS[id]?.name ?? id);
    this.forcesList.selected = -1;
  }

  private getThumb(id: string): HTMLCanvasElement | null {
    let c = this.thumbCache.get(id);
    if (!c) {
      const def = MAPS.find((m) => m.id === id);
      if (!def) return null;
      c = new TerrainRenderer(buildMap(def)).thumbnail(340, 200);
      this.thumbCache.set(id, c);
    }
    return c;
  }

  update(_dt: number, input: InputState): void {
    if (this.mapList.update(input)) {
      this.year = yearForMapId(MAPS[this.mapList.selected].id);
      this.refreshForcesList();
    }
    if (clickedIn(input, this.sideGerR)) {
      this.playerSide = 'german';
      this.refreshForcesList();
    }
    if (clickedIn(input, this.sideSovR)) {
      this.playerSide = 'soviet';
      this.refreshForcesList();
    }
    if (clickedIn(input, this.yearMinusR)) {
      this.year = clamp(this.year - 1, 1941, 1945);
      this.refreshForcesList();
    }
    if (clickedIn(input, this.yearPlusR)) {
      this.year = clamp(this.year + 1, 1941, 1945);
      this.refreshForcesList();
    }
    if (clickedIn(input, this.diffR)) {
      const idx = DIFFICULTIES.indexOf(this.difficulty);
      this.difficulty = DIFFICULTIES[(idx + 1) % DIFFICULTIES.length];
    }
    if (clickedIn(input, this.durR)) {
      const idx = DURATIONS.indexOf(this.durationMin);
      this.durationMin = DURATIONS[(idx + 1) % DURATIONS.length];
    }
    if (this.backBtn.update(input)) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (this.startBtn.update(input)) {
      const def = MAPS[this.mapList.selected];
      const cfg: BattleConfig = {
        mapId: def.id,
        playerSide: this.playerSide,
        year: this.year,
        seed: Date.now() & 0xffff,
        durationS: this.durationMin * 60,
        difficulty: this.difficulty,
        forces: DEFAULT_FORCES[this.year],
      };
      game.battleConfig = cfg;
      game.battle = new Battle(cfg);
      game.setScreen(new DeployScreen(game.battle));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawBackdrop(ctx);
    drawTitleBanner(ctx, 'BATTLE SETUP', 8);

    drawPanel(ctx, { x: 20, y: 40, w: 360, h: 520 }, { title: 'MAP' });
    this.mapList.draw(ctx);

    const def = MAPS[this.mapList.selected];
    const thumb = this.getThumb(def.id);
    if (thumb) ctx.drawImage(thumb, 30, 160);
    ctx.strokeStyle = PALETTE.bevelDark;
    ctx.strokeRect(29.5, 159.5, 341, 201);

    let ty = 372;
    for (const line of wordWrap(def.description, 340, 'small')) {
      drawText(ctx, line, 30, ty, PALETTE.text, 'small');
      ty += 9;
    }

    drawPanel(ctx, { x: 400, y: 40, w: 380, h: 500 }, { title: 'FORCE' });
    drawText(ctx, 'SIDE', 408, 56, PALETTE.gold, 'small');
    drawButton(ctx, this.sideGerR, 'GERMAN', { pressed: this.playerSide === 'german' });
    drawButton(ctx, this.sideSovR, 'SOVIET', { pressed: this.playerSide === 'soviet' });

    drawText(ctx, 'YEAR', 408, 92, PALETTE.gold, 'small');
    drawButton(ctx, this.yearMinusR, '-', {});
    drawTextCentered(ctx, String(this.year), 590, 111, PALETTE.text, 'small');
    drawButton(ctx, this.yearPlusR, '+', {});

    drawText(ctx, 'DIFFICULTY', 408, 128, PALETTE.gold, 'small');
    drawButton(ctx, this.diffR, this.difficulty.toUpperCase(), {});

    drawText(ctx, 'DURATION', 408, 164, PALETTE.gold, 'small');
    drawButton(ctx, this.durR, `${this.durationMin} MIN`, {});

    drawText(ctx, 'YOUR FORCES', 408, 200, PALETTE.gold, 'small');
    this.drawForcesList(ctx);

    this.backBtn.draw(ctx);
    this.startBtn.draw(ctx);
  }

  /** Custom row rendering for the forces list: icon at the row's left, name
   * after it, cost right-aligned — the default ListBox.draw only draws text. */
  private drawForcesList(ctx: CanvasRenderingContext2D): void {
    const rect = this.forcesList.rect;
    const rowH = this.forcesList.rowH;
    const ids = DEFAULT_FORCES[this.year]?.[this.playerSide] ?? [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    const visible = this.forcesList.visibleRows();
    for (let i = 0; i < visible; i++) {
      const idx = this.forcesList.scroll + i;
      if (idx >= ids.length) break;
      const def = TEAM_DEFS[ids[idx]];
      if (!def) continue;
      const ry = rect.y + i * rowH;
      if (idx === this.forcesList.selected) {
        ctx.fillStyle = 'rgba(216,180,72,0.22)';
        ctx.fillRect(rect.x, ry, rect.w, rowH);
      }
      const icon = getTeamIcon(def.iconId);
      ctx.drawImage(icon, rect.x + 2, ry + Math.round((rowH - icon.height) / 2));
      const nameX = rect.x + 20;
      const costText = `${def.cost}`;
      const costW = textWidth(costText);
      const nameMaxW = rect.w - 20 - costW - 8;
      const name = truncateName(def.name, nameMaxW);
      const ty = ry + Math.round((rowH - 7) / 2);
      drawText(ctx, name, nameX, ty, idx === this.forcesList.selected ? PALETTE.gold : PALETTE.text, 'small');
      drawText(ctx, costText, rect.x + rect.w - 4 - costW, ty, PALETTE.dim, 'small');
    }
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}

function truncateName(text: string, maxW: number): string {
  if (textWidth(text) <= maxW) return text;
  let s = text;
  while (s.length > 0 && textWidth(s) > maxW) s = s.slice(0, -1);
  return s;
}
