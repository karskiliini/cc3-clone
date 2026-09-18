import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInput } from '@/engine/input';

let events: EventTarget;
beforeEach(() => {
  events = new EventTarget();
  vi.stubGlobal('window', events);
});
afterEach(() => vi.unstubAllGlobals());

function keyboard(type: 'keydown' | 'keyup', key: string, opts: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, Object.fromEntries(Object.entries({ key, repeat: false, ctrlKey: false, metaKey: false, ...opts })
    .map(([name, value]) => [name, { value }])));
  events.dispatchEvent(event);
  return event;
}

function setup() { return createInput(new EventTarget() as HTMLCanvasElement); }

describe('keyboard input around editable controls', () => {
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('leaves shortcuts and space alone in a %s', (tagName) => {
    const { state } = setup();
    const target = { tagName, isContentEditable: false };
    const number = keyboard('keydown', '1', { ctrlKey: true, target });
    const space = keyboard('keydown', ' ', { target });
    keyboard('keyup', ' ', { target });
    expect([...state.keysPressed]).toEqual([]);
    expect([...state.keysDown]).toEqual([]);
    expect(number.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false);
  });

  it('leaves contenteditable descendants alone', () => {
    const { state } = setup();
    const target = { tagName: 'SPAN', isContentEditable: true };
    keyboard('keydown', '1', { metaKey: true, target });
    expect([...state.keysPressed]).toEqual([]);
  });

  it('records a fast assignment chord outside editors and prevents browser number shortcuts', () => {
    const { state } = setup();
    keyboard('keydown', 'Control');
    const number = keyboard('keydown', '1', { ctrlKey: true });
    keyboard('keyup', '1', { ctrlKey: true });
    keyboard('keyup', 'Control');
    expect(state.keysPressed.has('mod+1')).toBe(true);
    expect(number.defaultPrevented).toBe(true);
  });

  it('drops held movement and queued game shortcuts when a text field takes focus', () => {
    const { state } = setup();
    keyboard('keydown', 'ArrowRight');
    keyboard('keydown', '1', { ctrlKey: true });
    const focus = new Event('focusin');
    Object.defineProperty(focus, 'target', { value: { tagName: 'INPUT', isContentEditable: false } });
    events.dispatchEvent(focus);
    expect([...state.keysDown]).toEqual([]);
    expect([...state.keysPressed]).toEqual([]);
  });
});
