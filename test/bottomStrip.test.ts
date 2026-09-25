import { describe, expect, it } from 'vitest';
import { BottomStrip } from '../src/ui/hud/bottomStrip';
import type { InputState } from '../src/shared/types';

function inputWithMouse(mouse: { x: number; y: number }, click: { x: number; y: number; button: 0 | 1 | 2 }): InputState {
  return {
    mouse,
    buttons: { left: false, right: false, middle: false },
    clicks: [click],
    releases: [],
    keysDown: new Set(),
    keysPressed: new Set(),
    keysReleased: new Set(),
    wheel: 0,
    wheelDX: 0,
    wheelDY: 0,
    pointerInside: true,
  };
}

describe('BottomStrip', () => {
  // Regression: the strip must read click coordinates, not the stale pointer
  // position. A real mouse can produce a click without the pointer having
  // moved into the strip (e.g. a tap sequence) — buttons must still work
  // from the click coords.
  it('fires begin/auto/truce/flee from the click position when the pointer is elsewhere', () => {
    const deploy = new BottomStrip('deploy');
    const battle = new BottomStrip('battle');
    // Pointer parked in the map viewport (20, 100); click lands on Begin (RIGHT_BTN_1
    // spans 297.6..323.7 per refs11, so 310 is safely inside).
    expect(deploy.update(inputWithMouse({ x: 20, y: 100 }, { x: 310, y: 747, button: 0 }))).toBe('begin');
    // Same geometry in battle mode returns truce.
    expect(battle.update(inputWithMouse({ x: 20, y: 100 }, { x: 310, y: 747, button: 0 }))).toBe('truce');
    // And the second button: Auto in deploy, Flee in battle.
    expect(deploy.update(inputWithMouse({ x: 20, y: 100 }, { x: 310, y: 761, button: 0 }))).toBe('auto');
    expect(battle.update(inputWithMouse({ x: 20, y: 100 }, { x: 310, y: 761, button: 0 }))).toBe('flee');
  });

  it('left-side controls fire from click coordinates too', () => {
    const strip = new BottomStrip('deploy');
    expect(strip.update(inputWithMouse({ x: 20, y: 100 }, { x: 60, y: 750, button: 0 }))).toBe('map');
    expect(strip.update(inputWithMouse({ x: 20, y: 100 }, { x: 5, y: 742, button: 0 }))).toBe('chat');
    expect(strip.update(inputWithMouse({ x: 20, y: 100 }, { x: 5, y: 760, button: 0 }))).toBe('options');
  });

  it('ignores clicks outside the strip buttons', () => {
    const strip = new BottomStrip('battle');
    expect(strip.update(inputWithMouse({ x: 20, y: 100 }, { x: 280, y: 746, button: 0 }))).toBeNull();
    expect(strip.update(inputWithMouse({ x: 20, y: 100 }, { x: 310, y: 100, button: 0 }))).toBeNull();
  });
});
