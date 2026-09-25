import type { CursorKind } from '@/shared/types';
import { createInput } from '@/engine/input';
import { startLoop } from '@/engine/loop';
import { cssCursorFor } from '@/render/cursor';
import { game } from '@/game';
import { MainMenuScreen } from '@/ui/screens/mainMenu';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
ctx.imageSmoothingEnabled = false;

const input = createInput(canvas);
game.input = input;
game.setScreen(new MainMenuScreen());

// Dev-only hook for UI verification tooling (headless browser drives real screens).
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') (window as unknown as Record<string, unknown>).__cc3 = game;

const loggedErrors = new Set<string>();
function logOnce(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (!loggedErrors.has(msg)) {
    loggedErrors.add(msg);
    console.error(err);
  }
}

// The cursor is the native OS pointer (set via canvas.style.cursor), not a
// canvas-drawn sprite, so it never lags a frame behind the hardware pointer.
// The style write only happens when the requested kind actually changes.
let lastCursorKind: CursorKind | null = null;

startLoop((dt: number) => {
  const screen = game.screen;
  try {
    screen.update(dt, input.state);
  } catch (err) {
    logOnce(err);
  }
  try {
    screen.draw(ctx);
  } catch (err) {
    logOnce(err);
  }
  const kind = screen.cursor?.() ?? 'arrow';
  if (kind !== lastCursorKind) {
    canvas.style.cursor = cssCursorFor(kind);
    lastCursorKind = kind;
  }
  input.endFrame();
});
