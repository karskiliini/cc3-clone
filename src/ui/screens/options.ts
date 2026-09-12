import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { clamp } from '@/shared/math';
import { pointInRect } from '@/shared/math';
import { game } from '@/game';
import { drawDarkPanel, drawLogo, drawScreenTitle, drawShadowText, drawSmallMetalButton } from '@/ui/chrome';
import { beginMenuFrame, toMenuInput, BottomStrip } from './common';
import { MainMenuScreen } from './mainMenu';

const SPEEDS: (1 | 2 | 4)[] = [1, 2, 4];

interface ToggleRow {
  label: string;
  rect: Rect;
  get: () => boolean;
  set: (v: boolean) => void;
}

export class OptionsScreen implements Screen {
  private returnTo: Screen;
  private panel: Rect = { x: 60, y: 90, w: 680, h: 420 };

  private volMinusR: Rect;
  private volPlusR: Rect;
  private labelsR: Rect;
  private losR: Rect;
  private speedR: Rect;

  private realismRows: ToggleRow[];

  private strip = new BottomStrip({ showBack: true, nextEnabled: false });

  constructor(returnTo: Screen) {
    this.returnTo = returnTo;
    const p = this.panel;
    this.volMinusR = { x: p.x + 150, y: p.y + 46, w: 22, h: 22 };
    this.volPlusR = { x: p.x + 250, y: p.y + 46, w: 22, h: 22 };
    this.labelsR = { x: p.x + 150, y: p.y + 86, w: 100, h: 22 };
    this.losR = { x: p.x + 150, y: p.y + 126, w: 100, h: 22 };
    this.speedR = { x: p.x + 150, y: p.y + 166, w: 100, h: 22 };

    const s = game.settings;
    const rowX = p.x + 400;
    const rowY0 = p.y + 60;
    const rowStep = 46;
    this.realismRows = [
      { label: 'Always See Enemy', rect: { x: rowX, y: rowY0, w: 70, h: 18 }, get: () => !!s.alwaysSeeEnemy, set: (v) => (s.alwaysSeeEnemy = v) },
      { label: 'Never Act On Initiative', rect: { x: rowX, y: rowY0 + rowStep, w: 70, h: 18 }, get: () => !!s.neverActOnInitiative, set: (v) => (s.neverActOnInitiative = v) },
      { label: 'Always Have Full Enemy Info', rect: { x: rowX, y: rowY0 + rowStep * 2, w: 70, h: 18 }, get: () => !!s.alwaysFullEnemyInfo, set: (v) => (s.alwaysFullEnemyInfo = v) },
      { label: 'Always Obey Orders', rect: { x: rowX, y: rowY0 + rowStep * 3, w: 70, h: 18 }, get: () => !!s.alwaysObeyOrders, set: (v) => (s.alwaysObeyOrders = v) },
    ];
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    const s = game.settings;
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (pointInRect(p, this.volMinusR)) {
        s.volume = clamp(Math.round((s.volume - 0.1) * 10) / 10, 0, 1);
        game.audio?.setVolume?.(s.volume);
      } else if (pointInRect(p, this.volPlusR)) {
        s.volume = clamp(Math.round((s.volume + 0.1) * 10) / 10, 0, 1);
        game.audio?.setVolume?.(s.volume);
      } else if (pointInRect(p, this.labelsR)) {
        s.unitLabels = !s.unitLabels;
      } else if (pointInRect(p, this.losR)) {
        s.losLines = !s.losLines;
      } else if (pointInRect(p, this.speedR)) {
        const idx = SPEEDS.indexOf(s.speed);
        s.speed = SPEEDS[(idx + 1) % SPEEDS.length];
      } else {
        for (const row of this.realismRows) {
          if (pointInRect(p, row.rect)) row.set(!row.get());
        }
      }
    }

    const result = this.strip.update(m);
    if (result.quitOrBack || result.main) {
      game.saveSettings();
      game.setScreen(new MainMenuScreen());
      return;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);
    drawLogo(ctx);
    drawScreenTitle(ctx, 'OPTIONS');

    const p = this.panel;
    drawDarkPanel(ctx, p);
    drawShadowText(ctx, 'GAME OPTIONS', p.x + 20, p.y + 28, 'bold 16px Arial, Helvetica, sans-serif', '#f0d840');

    const s = game.settings;
    const label = (text: string, x: number, y: number) => {
      ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f0f0ec';
      ctx.fillText(text, x, y);
    };
    label('VOLUME', p.x + 24, p.y + 40);
    label(`${Math.round(s.volume * 100)}%`, p.x + 90, p.y + 40);
    drawSmallMetalButton(ctx, this.volMinusR, '-');
    drawSmallMetalButton(ctx, this.volPlusR, '+');

    label('UNIT LABELS', p.x + 24, p.y + 80);
    drawSmallMetalButton(ctx, this.labelsR, s.unitLabels ? 'ON' : 'OFF');

    label('LOS LINES', p.x + 24, p.y + 120);
    drawSmallMetalButton(ctx, this.losR, s.losLines ? 'ON' : 'OFF');

    label('SPEED', p.x + 24, p.y + 160);
    drawSmallMetalButton(ctx, this.speedR, `x${s.speed}`);

    drawShadowText(ctx, 'REALISM', p.x + 400, p.y + 28, 'bold 16px Arial, Helvetica, sans-serif', '#f0d840');
    for (const row of this.realismRows) {
      label(row.label, p.x + 400, row.rect.y - 4);
      drawSmallMetalButton(ctx, row.rect, row.get() ? 'ON' : 'OFF');
    }

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
