import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { game } from '@/game';
import { drawDarkPanel, drawShadowText } from '@/ui/chrome';
import { pointInRect } from '@/shared/math';
import { BOOT_LESSONS, type BootLesson, type BootTracked, makeTracked } from './bootcamp';
import { BootBattleScreen } from './bootBattle';
import { drawListRow, drawMenuFrame, toMenuInput, BottomStrip } from './common';
import { MainMenuScreen } from './mainMenu';

// ============================================================================
// BootCampScreen — lesson picker for the five boot-camp tutorials (roadmap G5).
// ============================================================================

const LIST_RECT: Rect = { x: 120, y: 130, w: 560, h: 44 * 5 };

export class BootCampScreen implements Screen {
  private hotIndex = -1;
  private completed = new Set<string>(loadDone());
  private strip = new BottomStrip({});

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    if (this.strip.update(m).back) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    this.hotIndex = -1;
    for (let i = 0; i < BOOT_LESSONS.length; i++) {
      if (pointInRect(m.mouse, rowRect(i))) this.hotIndex = i;
    }
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      for (let i = 0; i < BOOT_LESSONS.length; i++) {
        if (pointInRect({ x: c.x, y: c.y }, rowRect(i))) {
          // a training battle is not part of a running operation: its debrief must not
          // advance the operation (Operation → Continue reloads it from storage)
          game.operation = null;
          game.campaign = null;
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
    drawMenuFrame(ctx, 'BOOT CAMP', () => this.drawBody(ctx));
  }

  private drawBody(ctx: CanvasRenderingContext2D): void {
    drawShadowText(ctx, 'Train, soldier. The camp enforces its tasks — disobey and it stops you.', 400, 108, 'italic 12px Arial, Helvetica, sans-serif', '#c8c8c0', 'rgba(0,0,0,0.8)', 'center');
    drawDarkPanel(ctx, { x: LIST_RECT.x - 8, y: LIST_RECT.y - 8, w: LIST_RECT.w + 16, h: LIST_RECT.h + 12 });

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

