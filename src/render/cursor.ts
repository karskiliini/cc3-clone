import type { Vec2, CursorKind } from '@/shared/types';
import { getCursorSprite } from '@/render/sprites';

export function drawCursor(ctx: CanvasRenderingContext2D, mouse: Vec2, kind: CursorKind): void {
  const sprite = getCursorSprite(kind);
  const hotspotX = kind === 'crosshair' ? 8 : 0;
  const hotspotY = kind === 'crosshair' ? 8 : 0;
  // Drawn last, directly to the canvas with no active clip region, so it is
  // never clipped by the bottom panel or any other UI element.
  ctx.drawImage(sprite, Math.round(mouse.x - hotspotX), Math.round(mouse.y - hotspotY));
}
