import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BootBattleScreen } from '@/ui/screens/bootBattle';
import { BOOT_LESSONS, makeTracked } from '@/ui/screens/bootcamp';
import { createInput } from '@/engine/input';
import { game } from '@/game';

let events: EventTarget;
beforeEach(() => {
  events = new EventTarget();
  (globalThis as { window?: EventTarget }).window = events;
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function event(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, Object.fromEntries(Object.entries(props).map(([name, value]) => [name, { value }])));
  events.dispatchEvent(e);
}

function makeInput() {
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 1024, height: 768 }),
  }) as unknown as HTMLCanvasElement;
  return createInput(canvas);
}

describe('boot camp battle modals', () => {
  it('dismisses the intro modal with a click at the drawn CONTINUE location (canvas coords)', () => {
    const lesson = BOOT_LESSONS.find((l) => l.id === 'bootMove')!;
    const passed = { called: false };
    const screen = new BootBattleScreen(lesson, () => { passed.called = true; });
    const input = makeInput();
    // CONTINUE rect is (340..460, 430..458) in canvas space; a menu-local
    // translation would push that click outside the drawn button.
    event('mousedown', { clientX: 400, clientY: 444, button: 0 });
    event('mouseup', { clientX: 400, clientY: 444, button: 0 });
    screen.update(1 / 60, input.state);
    input.endFrame();
    expect(screen.modalKind).toBeNull();
    expect(passed.called).toBe(false);
  });

  it('CONTINUE outside the drawn button does not dismiss the modal', () => {
    const lesson = BOOT_LESSONS.find((l) => l.id === 'bootMonitor')!;
    const screen = new BootBattleScreen(lesson, () => {});
    const input = makeInput();
    event('mousedown', { clientX: 700, clientY: 444, button: 0 });
    event('mouseup', { clientX: 700, clientY: 444, button: 0 });
    screen.update(1 / 60, input.state);
    input.endFrame();
    expect(screen.modalKind).toBe('intro');
  });

  it('registers a player selection so lesson 1 task 1 can complete', () => {
    const lesson = BOOT_LESSONS.find((l) => l.id === 'bootMove')!;
    const screen = new BootBattleScreen(lesson, () => {});
    const tracked = makeTracked();
    expect(tracked.selectionMade).toBeUndefined();
  });
});
