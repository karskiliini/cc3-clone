import type { InputState } from '@/shared/types';
import { SCREEN_W, SCREEN_H } from '@/shared/types';
import { clamp } from '@/shared/math';
import { game } from '@/game';

const PREVENT_KEYS = new Set([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab']);

function unlockAudio(): void {
  game.audio?.unlock?.();
}

export function createInput(canvas: HTMLCanvasElement): { state: InputState; endFrame(): void } {
  const state: InputState = {
    mouse: { x: 0, y: 0 },
    buttons: { left: false, right: false, middle: false },
    clicks: [],
    releases: [],
    keysDown: new Set(),
    keysPressed: new Set(),
    wheel: 0,
    pointerInside: true,
  };

  // Reused scratch object for clientToLogical results, to avoid allocating a
  // new {x,y} on every mousemove/mousedown/mouseup — those fire very often.
  const scratchPt = { x: 0, y: 0 };

  // DevicePixelRatio-independent: getBoundingClientRect() and clientX/clientY
  // are both in CSS pixels, so this mapping is exact regardless of DPR. The
  // canvas is laid out with object-fit:contain (letterboxed, 4:3), so we
  // recompute the same contain-fit math the browser uses for painting.
  function clientToLogical(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / SCREEN_W, rect.height / SCREEN_H);
    const dispW = SCREEN_W * scale;
    const dispH = SCREEN_H * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    scratchPt.x = clamp((clientX - offX) / (scale || 1), 0, SCREEN_W - 1);
    scratchPt.y = clamp((clientY - offY) / (scale || 1), 0, SCREEN_H - 1);
    return scratchPt;
  }

  function buttonOf(b: number): 0 | 1 | 2 {
    return (b === 2 ? 2 : b === 1 ? 1 : 0) as 0 | 1 | 2;
  }

  window.addEventListener('mousemove', (e: MouseEvent) => {
    const p = clientToLogical(e.clientX, e.clientY);
    state.mouse.x = p.x;
    state.mouse.y = p.y;
    state.pointerInside = true;
  });

  // Edge-scroll and drag gestures must stop dead the instant the pointer
  // leaves the page or the window loses focus — otherwise the camera (or a
  // stuck button) keeps "moving" after the user has alt-tabbed away.
  canvas.addEventListener('mouseleave', () => {
    state.pointerInside = false;
  });
  window.addEventListener('blur', () => {
    state.pointerInside = false;
    state.buttons.left = false;
    state.buttons.right = false;
    state.buttons.middle = false;
    state.keysDown.clear();
  });

  window.addEventListener('mousedown', (e: MouseEvent) => {
    unlockAudio();
    const p = clientToLogical(e.clientX, e.clientY);
    const button = buttonOf(e.button);
    if (button === 0) state.buttons.left = true;
    else if (button === 1) state.buttons.middle = true;
    else if (button === 2) state.buttons.right = true;
    state.clicks.push({ x: p.x, y: p.y, button });
  });

  window.addEventListener('mouseup', (e: MouseEvent) => {
    const p = clientToLogical(e.clientX, e.clientY);
    const button = buttonOf(e.button);
    if (button === 0) state.buttons.left = false;
    else if (button === 1) state.buttons.middle = false;
    else if (button === 2) state.buttons.right = false;
    state.releases.push({ x: p.x, y: p.y, button });
  });

  window.addEventListener('contextmenu', (e: Event) => {
    e.preventDefault();
  });

  // Right-drag-to-pan and left-drag-to-select must never trigger the
  // browser's native text/image selection or drag-ghost affordances.
  window.addEventListener('selectstart', (e: Event) => e.preventDefault());
  canvas.addEventListener('dragstart', (e: Event) => e.preventDefault());

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    unlockAudio();
    const key = e.key.toLowerCase();
    if (PREVENT_KEYS.has(key)) e.preventDefault();
    if (!e.repeat) state.keysPressed.add(key);
    state.keysDown.add(key);
  });

  window.addEventListener('keyup', (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    state.keysDown.delete(key);
  });

  window.addEventListener('wheel', (e: WheelEvent) => {
    state.wheel += e.deltaY;
  });

  function endFrame(): void {
    state.clicks.length = 0;
    state.releases.length = 0;
    state.keysPressed.clear();
    state.wheel = 0;
  }

  return { state, endFrame };
}
