import type { Camera, Vec2 } from '@/shared/types';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { clamp } from '@/shared/math';

export function createCamera(): Camera {
  return { x: 0, y: 0, zoom: 1 };
}

export function worldToScreen(cam: Camera, p: Vec2): Vec2 {
  const px = TILE_PX * cam.zoom;
  return { x: (p.x - cam.x) * px, y: (p.y - cam.y) * px };
}

export function screenToWorld(cam: Camera, p: Vec2): Vec2 {
  const px = TILE_PX * cam.zoom;
  return { x: p.x / px + cam.x, y: p.y / px + cam.y };
}

export function clampCamera(cam: Camera, mapW: number, mapH: number): void {
  const px = TILE_PX * cam.zoom;
  const viewTilesW = VIEW_W / px;
  const viewTilesH = VIEW_H / px;

  if (mapW <= viewTilesW) {
    cam.x = (mapW - viewTilesW) / 2;
  } else {
    cam.x = clamp(cam.x, 0, mapW - viewTilesW);
  }

  if (mapH <= viewTilesH) {
    cam.y = (mapH - viewTilesH) / 2;
  } else {
    cam.y = clamp(cam.y, 0, mapH - viewTilesH);
  }
}

export function panCamera(cam: Camera, dxPx: number, dyPx: number): void {
  const px = TILE_PX * cam.zoom;
  cam.x += dxPx / px;
  cam.y += dyPx / px;
}

export function centerCamera(cam: Camera, p: Vec2): void {
  const px = TILE_PX * cam.zoom;
  const viewTilesW = VIEW_W / px;
  const viewTilesH = VIEW_H / px;
  cam.x = p.x - viewTilesW / 2;
  cam.y = p.y - viewTilesH / 2;
}
