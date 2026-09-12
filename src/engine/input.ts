import type { InputState } from '@/shared/types';
import { SCREEN_W, SCREEN_H } from '@/shared/types';
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
  };

  function clientToLogical(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / SCREEN_W, rect.height / SCREEN_H);
    const dispW = SCREEN_W * scale;
    const dispH = SCREEN_H * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    const x = (clientX - offX) / (scale || 1);
    const y = (clientY - offY) / (scale || 1);
    return { x, y };
  }

  function buttonOf(b: number): 0 | 1 | 2 {
    return (b === 2 ? 2 : b === 1 ? 1 : 0) as 0 | 1 | 2;
  }

  window.addEventListener('mousemove', (e: MouseEvent) => {
    const p = clientToLogical(e.clientX, e.clientY);
    state.mouse.x = p.x;
    state.mouse.y = p.y;
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
