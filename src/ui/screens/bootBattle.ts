import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { game } from '@/game';
import { drawDarkPanel, drawScreenTitle, drawShadowText } from '@/ui/chrome';
import { pointInRect } from '@/shared/math';
import { Battle } from '@/sim/battle';
import type { BootLesson, BootTracked } from './bootcamp';
import { makeTracked, trackOrder } from './bootcamp';
import { BattleScreen } from './battle';
import { DebriefScreen } from './debrief';
import { BootCampScreen } from './bootCampPicker';

// ============================================================================
// BootBattleScreen — a boot-camp battle run with task enforcement (roadmap G5).
//
// Wraps BattleScreen: tracks the player's issued orders, drives the lesson's
// task list, and pauses the battle with a task modal — pass it and the next
// task is shown; disobey (fail a task) and the battle stops, as in the
// original ("Boot camp won't work if you don't obey your orders").
// ============================================================================

type ModalKind = 'intro' | 'task' | 'pass' | 'fail' | null;

export class BootBattleScreen implements Screen {
  private battle: Battle;
  private inner: BattleScreen;
  private tracked: BootTracked = makeTracked();
  private taskIndex = 0;
  private modal: ModalKind = null;
  /** Current modal kind for tests/telemetry. */
  get modalKind(): ModalKind { return this.modal; }
  private passedAll = false;
  private onLessonPassed: () => void;

  private continueR: Rect = { x: 340, y: 430, w: 120, h: 28 };
  private replayR: Rect = { x: 340, y: 470, w: 120, h: 28 };

  constructor(private lesson: BootLesson, onLessonPassed: () => void) {
    this.battle = new Battle({
      mapId: lesson.mapId,
      playerSide: 'german',
      year: lesson.year,
      seed: (Date.now() & 0xffff) | 1,
      durationS: lesson.durationS,
      difficulty: 'easy',
      forces: lesson.forces,
    });
    this.onLessonPassed = onLessonPassed;
    this.modal = 'intro';
    this.battle.start();
    this.battle.state.phase = 'paused';
    this.inner = new BattleScreen(this.battle);
  }

  private currentText(): string {
    const task = this.lesson.tasks[this.taskIndex];
    if (!task) return '';
    return task.text;
  }

  private advanceTask(): void {
    this.taskIndex += 1;
    if (this.taskIndex >= this.lesson.tasks.length) {
      this.passedAll = true;
      this.modal = 'pass';
      this.onLessonPassed();
    } else {
      this.modal = 'task';
    }
    this.battle.state.phase = 'paused';
  }

  private failTask(): void {
    this.modal = 'fail';
    this.battle.state.phase = 'paused';
  }

  update(dt: number, input: InputState): void {
    if (this.modal) {
      for (const c of input.clicks) {
        if (c.button !== 0) continue;
        const p = { x: c.x, y: c.y };
        if (pointInRect(p, this.continueR)) {
          if (this.modal === 'pass') {
            game.setScreen(new BootCampScreen());
            return;
          }
          if (this.modal === 'fail') {
            game.setScreen(new BootBattleScreen(this.lesson, this.onLessonPassed));
            return;
          }
          this.modal = null;
          this.battle.state.phase = 'running';
        }
        if ((this.modal === 'fail') && pointInRect(p, this.replayR)) {
          game.setScreen(new BootBattleScreen(this.lesson, this.onLessonPassed));
          return;
        }
      }
      // while a modal is up the inner battle screen still draws but must not step,
      // and must not see the modal's clicks (they would select teams / confirm orders)
      this.inner.update(0, { ...input, clicks: [] });
      return;
    }

    this.observeOrders();
    this.inner.update(dt, input);
    if (this.inner.selectionCount > 0) this.tracked.selectionMade = true;
    // F5 toggles the Team Monitor inside the inner screen; keysPressed persists until
    // endFrame so reading it here still sees the press (lesson 4's task 1).
    if (input.keysPressed.has('f5')) this.tracked.monitorToggled = true;
    const state = this.battle.state;
    if (state.phase === 'ended') return; // inner handles debrief handoff

    const task = this.lesson.tasks[this.taskIndex];
    if (!task) return;
    if (task.done(state, this.tracked)) {
      this.advanceTask();
      return;
    }
    if (task.failed?.(state, this.tracked)) {
      this.failTask();
      return;
    }
  }

  /** Player team orders snapshot: a changed `type:target` key per team is one issued
   * order (inner BattleScreen drains the event queue itself, so events can't be read here). */
  private seenOrders = new Map<number, string>();
  private observeOrders(): void {
    for (const team of this.battle.state.teams.values()) {
      if (team.side !== this.battle.playerSide()) continue;
      const key = team.order ? `${team.order.type}:${Math.round(team.order.target.x)},${Math.round(team.order.target.y)}` : '';
      const prev = this.seenOrders.get(team.id);
      if (key && key !== prev) {
        trackOrder(this.tracked, team.order!);
        this.seenOrders.set(team.id, key);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.inner.draw(ctx);
    if (!this.modal) return;

    // dim + modal panel
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, 800, 600);
    const r: Rect = { x: 160, y: 190, w: 480, h: 200 };
    drawDarkPanel(ctx, r);
    const title = this.modal === 'intro' ? this.lesson.title
      : this.modal === 'fail' ? 'TASK FAILED'
      : this.modal === 'pass' ? 'BOOT CAMP PASSED'
      : 'TASK';
    drawScreenTitle(ctx, title);

    ctx.font = '12px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    const body = this.modal === 'intro' ? this.lesson.intro
      : this.modal === 'fail' ? 'You did not follow your orders. Boot camp won\'t work if you don\'t obey them. Try the lesson again.'
      : this.modal === 'pass' ? 'Fine job, soldier. You have completed this lesson.' : this.currentText();
    let ty = r.y + 48;
    for (const line of wrap(body, 440)) {
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(line, r.x + 20, ty);
      ty += 16;
      if (ty > r.y + r.h - 60) break;
    }

    // task progress
    if (this.modal === 'task') {
      ctx.fillStyle = '#f0d840';
      ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
      ctx.fillText(`Task ${this.taskIndex + 1} of ${this.lesson.tasks.length}`, r.x + 20, r.y + r.h - 40);
    }

    ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#f0d840';
    ctx.textAlign = 'center';
    ctx.fillText(this.modal === 'fail' ? 'RETRY' : 'CONTINUE', this.continueR.x + this.continueR.w / 2, this.continueR.y + 19);
    ctx.strokeStyle = '#c8a028';
    ctx.strokeRect(this.continueR.x + 0.5, this.continueR.y + 0.5, this.continueR.w - 1, this.continueR.h - 1);
    ctx.textAlign = 'left';
  }

  cursor(): CursorKind {
    return this.modal ? 'arrow' : this.inner.cursor();
  }
}

function wrap(text: string, widthPx: number): string[] {
  // the menu screens' wordWrap needs a canvas font context; this simple measure suffices here
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length * 6 > widthPx) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}
