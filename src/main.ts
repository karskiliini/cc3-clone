import { createInput } from '@/engine/input';
import { startLoop } from '@/engine/loop';
import { drawCursor } from '@/render/cursor';
import { game } from '@/game';
import { MainMenuScreen } from '@/ui/screens/mainMenu';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
ctx.imageSmoothingEnabled = false;

const input = createInput(canvas);
game.input = input;
game.setScreen(new MainMenuScreen());

const loggedErrors = new Set<string>();
function logOnce(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (!loggedErrors.has(msg)) {
    loggedErrors.add(msg);
    console.error(err);
  }
}

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
  drawCursor(ctx, input.state.mouse, screen.cursor?.() ?? 'arrow');
  input.endFrame();
});
