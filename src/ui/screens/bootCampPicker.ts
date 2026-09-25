import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { game } from '@/game';
import { drawDarkPanel, drawListRow, drawScreenTitle, drawShadowText } from '@/ui/chrome';
import { pointInRect } from '@/shared/math';
import { BOOT_LESSONS, type BootLesson, type BootTracked, makeTracked } from './bootcamp';
import { BootBattleScreen } from './bootBattle';
import { beginMenuFrame, toMenuInput, BottomStrip } from './common';
import { MainMenuScreen } from './mainMenu';
import { OptionsScreen } from './options';

// ============================================================================
// BootCampScreen — lesson picker for the five boot-camp tutorials (roadmap G5).
// ============================================================================

const LIST_RECT: Rect = { x: 120, y: 130, w: 560, h: 44 * 5 };

export class BootCampScreen implements Screen {
  private hotIndex = -1;
  private completed = new Set<string>(loadDone());
  private strip = new BottomStrip({ showBack: true, nextEnabled: false });

  update(_dt: number, input: InputState): void {
    // ESC = Back in every menu screen, like the original (round7 UI pass).
    if (input.keysPressed.has('escape')) { game.setScreen(new MainMenuScreen()); return; }
    const m = toMenuInput(input);
    const result = this.strip.update(m);
    if (result.quitOrBack || result.main) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.options) { game.setScreen(new OptionsScreen(this)); return; }
    this.hotIndex = -1;
    for (let i = 0; i < BOOT_LESSONS.length; i++) {
      if (pointInRect(m.mouse, rowRect(i))) this.hotIndex = i;
    }
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      for (let i = 0; i < BOOT_LESSONS.length; i++) {
        if (pointInRect({ x: c.x, y: c.y }, rowRect(i))) {
          game.setScreen(new BootBattleScreen(BOOT_LESSONS[i], () => {
            this.completed.add(BOOT_LESSONS[i].id);
            saveDone([...this.completed]);
          }));
          return;
        }
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);
    drawScreenTitle(ctx, 'BOOT CAMP');
    drawShadowText(ctx, 'Train, soldier. The camp enforces its tasks — disobey and it stops you.', 400, 108, 'italic 12px Arial, Helvetica, sans-serif', '#c8c8c0');

    BOOT_LESSONS.forEach((lesson, i) => {
      const r = rowRect(i);
      drawListRow(ctx, r, { hot: this.hotIndex === i });
      ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = this.completed.has(lesson.id) ? '#8fb070' : '#f0f0ec';
      ctx.fillText(`${this.completed.has(lesson.id) ? '✓ ' : ''}${lesson.title}`, r.x + 12, r.y + 27);
      ctx.textAlign = 'right';
      ctx.font = '11px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#a8a89c';
      ctx.fillText(`${lesson.tasks.length} tasks`, r.x + r.w - 12, r.y + 27);
      ctx.textAlign = 'left';
    });

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}

function rowRect(i: number): Rect {
  return { x: LIST_RECT.x, y: LIST_RECT.y + i * 44, w: LIST_RECT.w, h: 40 };
}

const DONE_KEY = 'cc3.bootcamp';

function loadDone(): string[] {
  try {
    const raw = localStorage.getItem(DONE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveDone(ids: string[]): void {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(ids));
  } catch {
    // nicety
  }
}

