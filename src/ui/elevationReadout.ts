import type { Camera, GameMap, Vec2 } from '@/shared/types';
import { VIEW_W } from '@/shared/types';
import { screenToWorld } from '@/engine/camera';
import { featureHeightAt, getHeightField, groundAt, syncCraterMarks } from '@/sim/heightField';
import { drawText, textWidth } from '@/render/pixelfont';
import { growthHeightAt } from '@/sim/growth';

/** "12.4 m" for bare ground; with something standing on it or dug into it, the difference too:
 * "12.4 m +6.0" on a roof, "12.4 m -1.2" in a foxhole. Small differences are ground noise. */
export function elevationLabel(groundM: number, featureM: number): string {
  const g = `${groundM.toFixed(1)} m`;
  if (Math.abs(featureM) < 0.25) return g;
  return `${g} ${featureM > 0 ? '+' : '-'}${Math.abs(featureM).toFixed(1)}`;
}

/** Elevation under the pointer, always shown next to it on the map (not over the HUD). Uses the
 * same height field as the depth map, so craters, foxholes, walls and damaged buildings count. */
export function drawElevationReadout(ctx: CanvasRenderingContext2D, cam: Camera, map: GameMap, mouse: Vec2): void {
  const w = screenToWorld(cam, mouse);
  if (w.x < 0 || w.y < 0 || w.x >= map.width || w.y >= map.height) return;
  const field = getHeightField(map);
  syncCraterMarks(map, field);
  const text = elevationLabel(groundAt(field, w.x, w.y), featureHeightAt(field, w.x, w.y) + growthHeightAt(map, w.x, w.y));
  const tw = textWidth(text);
  let x = Math.round(mouse.x + 16);
  const y = Math.round(mouse.y + 18);
  if (x + tw + 6 > VIEW_W) x = Math.round(mouse.x - tw - 12);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x - 3, y - 2, tw + 6, 11);
  drawText(ctx, text, x, y, '#e8e2c0');
}
