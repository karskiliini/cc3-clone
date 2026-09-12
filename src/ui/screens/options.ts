import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { SCREEN_W } from '@/shared/types';
import { clamp } from '@/shared/math';
import { game } from '@/game';
import { Button, drawButton, drawPanel, drawTitleBanner, hitRect } from '@/ui/chrome';
import { drawText } from '@/render/pixelfont';
import { PALETTE } from '@/render/palette';
import { drawBackdrop, createBackButton } from './common';

const SPEEDS: (1 | 2 | 4)[] = [1, 2, 4];

/** Click test + edge-triggered handling for a toggle/cycle button drawn with a dynamic label. */
function clickedIn(input: InputState, r: Rect): boolean {
  for (const c of input.clicks) {
    if (c.button === 0 && hitRect({ x: c.x, y: c.y }, r)) return true;
  }
  return false;
}

export class OptionsScreen implements Screen {
  private returnTo: Screen;
  private panelRect = { x: (SCREEN_W - 360) / 2, y: 140, w: 360, h: 260 };

  private volMinusR: Rect;
  private volPlusR: Rect;
  private labelsR: Rect;
  private losR: Rect;
  private speedR: Rect;

  private volMinus: Button;
  private volPlus: Button;
  private backBtn = createBackButton();

  constructor(returnTo: Screen) {
    this.returnTo = returnTo;
    const p = this.panelRect;
    this.volMinusR = { x: p.x + 200, y: p.y + 40, w: 20, h: 20 };
    this.volPlusR = { x: p.x + 300, y: p.y + 40, w: 20, h: 20 };
    this.labelsR = { x: p.x + 220, y: p.y + 80, w: 100, h: 20 };
    this.losR = { x: p.x + 220, y: p.y + 120, w: 100, h: 20 };
    this.speedR = { x: p.x + 220, y: p.y + 160, w: 100, h: 20 };
    this.volMinus = new Button(this.volMinusR, '-');
    this.volPlus = new Button(this.volPlusR, '+');
  }

  update(_dt: number, input: InputState): void {
    const s = game.settings;
    if (this.volMinus.update(input)) {
      s.volume = clamp(Math.round((s.volume - 0.1) * 10) / 10, 0, 1);
      game.audio?.setVolume?.(s.volume);
    }
    if (this.volPlus.update(input)) {
      s.volume = clamp(Math.round((s.volume + 0.1) * 10) / 10, 0, 1);
      game.audio?.setVolume?.(s.volume);
    }
    if (clickedIn(input, this.labelsR)) s.unitLabels = !s.unitLabels;
    if (clickedIn(input, this.losR)) s.losLines = !s.losLines;
    if (clickedIn(input, this.speedR)) {
      const idx = SPEEDS.indexOf(s.speed);
      s.speed = SPEEDS[(idx + 1) % SPEEDS.length];
    }
    if (this.backBtn.update(input) || input.keysPressed.has('escape')) {
      game.saveSettings();
      game.setScreen(this.returnTo);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawBackdrop(ctx);
    drawTitleBanner(ctx, 'OPTIONS', 40);
    const p = this.panelRect;
    drawPanel(ctx, p, { title: 'OPTIONS' });

    const s = game.settings;
    drawText(ctx, 'VOLUME', p.x + 20, p.y + 46, PALETTE.gold, 'small');
    drawText(ctx, `${Math.round(s.volume * 100)}%`, p.x + 150, p.y + 46, PALETTE.text, 'small');
    this.volMinus.draw(ctx);
    this.volPlus.draw(ctx);

    drawText(ctx, 'UNIT LABELS', p.x + 20, p.y + 86, PALETTE.gold, 'small');
    drawButton(ctx, this.labelsR, s.unitLabels ? 'ON' : 'OFF', {});

    drawText(ctx, 'LOS LINES', p.x + 20, p.y + 126, PALETTE.gold, 'small');
    drawButton(ctx, this.losR, s.losLines ? 'ON' : 'OFF', {});

    drawText(ctx, 'SPEED', p.x + 20, p.y + 166, PALETTE.gold, 'small');
    drawButton(ctx, this.speedR, `x${s.speed}`, {});

    this.backBtn.draw(ctx);
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
