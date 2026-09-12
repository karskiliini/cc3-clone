// ============================================================================
// losTool.ts — Shift+drag LOS line overlay: green where clear, red where
// blocked, with a small "CLEAR"/"BLOCKED" + distance label at the cursor.
// ============================================================================
import type { Camera, GameMap, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import { losTrace } from '@/sim/los';
import { PALETTE } from '@/render/palette';

function drawLine(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
  ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
  ctx.stroke();
}

/** Draws a LOS line from `from` to `to` (tile coords): green for the clear
 * portion, red for the blocked remainder, plus a label at the cursor. */
export function drawLOSLine(ctx: CanvasRenderingContext2D, cam: Camera, map: GameMap, from: Vec2, to: Vec2): void {
  const trace = losTrace(map, from, to);
  const fromPx = worldToScreen(cam, from);
  const toPx = worldToScreen(cam, to);

  if (trace.clear || !trace.blockedAt) {
    drawLine(ctx, fromPx, toPx, PALETTE.green);
  } else {
    const blockedPx = worldToScreen(cam, trace.blockedAt);
    drawLine(ctx, fromPx, blockedPx, PALETTE.green);
    drawLine(ctx, blockedPx, toPx, PALETTE.red);
  }

  const distM = Math.round(dist(from, to) * TILE_M);
  const label = `${trace.clear ? 'CLEAR' : 'BLOCKED'} ${distM} m`;
  const color = trace.clear ? PALETTE.green : PALETTE.red;
  ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(label, Math.round(toPx.x) + 6, Math.round(toPx.y) - 12);
}
