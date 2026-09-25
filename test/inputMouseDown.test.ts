import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInput } from '@/engine/input';

const events: EventTarget[] = [];

beforeEach(() => {
  events.push(new EventTarget());
  (globalThis as { window?: EventTarget }).window = events[events.length - 1];
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function event(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, Object.fromEntries(Object.entries(props).map(([name, value]) => [name, { value }])));
  events[events.length - 1].dispatchEvent(e);
}

describe('input state', () => {
  it('mousedown places the cursor at the press point even with no prior mousemove', () => {
    const canvas = Object.assign(new EventTarget(), {
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 1024, height: 768 }),
    }) as unknown as HTMLCanvasElement;
    const input = createInput(canvas);
    event('mousedown', { clientX: 300, clientY: 220, button: 0 });
    expect(input.state.mouse).toEqual({ x: 300, y: 220 });
    // a press far from the last mousemove must not register as a drag
    event('mouseup', { clientX: 300, clientY: 220, button: 0 });
    expect(input.state.mouse).toEqual({ x: 300, y: 220 });
  });

  it('mousemove keeps tracking after mousedown', () => {
    const canvas = Object.assign(new EventTarget(), {
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 1024, height: 768 }),
    }) as unknown as HTMLCanvasElement;
    const input = createInput(canvas);
    event('mousedown', { clientX: 100, clientY: 100, button: 0 });
    event('mousemove', { clientX: 400, clientY: 260 });
    expect(input.state.mouse).toEqual({ x: 400, y: 260 });
  });

  it('letterboxes clicks outside the logical frame onto the nearest edge, not into a stale position', () => {
    // 426x416 window: scale = 0.41602, offY = (416 - 319.5)/2 = 48.25.
    const canvas = Object.assign(new EventTarget(), {
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 426, height: 416 }),
    }) as unknown as HTMLCanvasElement;
    const input = createInput(canvas);
    event('mousedown', { clientX: 100, clientY: 60, button: 0 });
    expect(input.state.mouse.x).toBeGreaterThan(200); // 100 / 0.416 = 240, not clamped to 0
  });
});
