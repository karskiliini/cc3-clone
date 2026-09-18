import type { Camera, Vec2 } from '@/shared/types';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { clamp } from '@/shared/math';

export function createCamera(): Camera {
  return { x: 0, y: 0, zoom: 1 };
}

/** Zoom bounds: fully out (whole-map overview) to fully in (CC3's close view). */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
/** Continuous zoom (user ask: no jumps between views): each wheel notch / button press scales
 * by this factor instead of snapping to a level. */
export const ZOOM_STEP_FACTOR = 1.25;

/** Scales the camera's zoom continuously, keeping the world point under `anchor` (screen
 * coords, if given) fixed on screen. */
function stepZoom(cam: Camera, dir: 1 | -1, mapW: number, mapH: number, anchor?: Vec2): void {
  const nextZoom = clamp(cam.zoom * (dir > 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR), ZOOM_MIN, ZOOM_MAX);
  if (nextZoom === cam.zoom) return;
  const before = anchor ? screenToWorld(cam, anchor) : null;
  cam.zoom = nextZoom;
  clampCamera(cam, mapW, mapH);
  if (before && anchor) {
    const after = screenToWorld(cam, anchor);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    clampCamera(cam, mapW, mapH);
  }
}

export function zoomIn(cam: Camera, mapW: number, mapH: number, anchor?: Vec2): void {
  stepZoom(cam, 1, mapW, mapH, anchor);
}

export function zoomOut(cam: Camera, mapW: number, mapH: number, anchor?: Vec2): void {
  stepZoom(cam, -1, mapW, mapH, anchor);
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
