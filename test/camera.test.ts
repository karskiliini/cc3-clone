import { describe, it, expect } from 'vitest';
import { createCamera, worldToScreen, screenToWorld, clampCamera, panCamera, centerCamera, zoomIn, zoomOut } from '@/engine/camera';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';

describe('camera', () => {
  it('worldToScreen/screenToWorld roundtrip at zoom 1', () => {
    const cam = createCamera();
    cam.x = 12.5;
    cam.y = 3.25;
    const p = { x: 20, y: 10 };
    const screen = worldToScreen(cam, p);
    const back = screenToWorld(cam, screen);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it('worldToScreen/screenToWorld roundtrip at zoom 2', () => {
    const cam = createCamera();
    cam.zoom = 2;
    cam.x = 5;
    cam.y = 8;
    const p = { x: 30, y: 40 };
    const screen = worldToScreen(cam, p);
    const back = screenToWorld(cam, screen);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it('worldToScreen places the camera origin at (0,0)', () => {
    const cam = createCamera();
    cam.x = 4;
    cam.y = 6;
    const screen = worldToScreen(cam, { x: 4, y: 6 });
    expect(screen.x).toBe(0);
    expect(screen.y).toBe(0);
  });

  it('worldToScreen scales by TILE_PX * zoom', () => {
    const cam = createCamera();
    cam.zoom = 2;
    const screen = worldToScreen(cam, { x: 1, y: 1 });
    expect(screen.x).toBe(TILE_PX * 2);
    expect(screen.y).toBe(TILE_PX * 2);
  });

  it('clampCamera keeps the camera inside a map larger than the viewport', () => {
    const cam = createCamera();
    const viewTilesW = VIEW_W / (TILE_PX * cam.zoom);
    const viewTilesH = VIEW_H / (TILE_PX * cam.zoom);
    const mapW = viewTilesW * 4;
    const mapH = viewTilesH * 4;

    cam.x = -100;
    cam.y = -100;
    clampCamera(cam, mapW, mapH);
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);

    cam.x = mapW + 100;
    cam.y = mapH + 100;
    clampCamera(cam, mapW, mapH);
    expect(cam.x).toBeCloseTo(mapW - viewTilesW, 6);
    expect(cam.y).toBeCloseTo(mapH - viewTilesH, 6);
  });

  it('clampCamera centers the view when the map is smaller than the viewport', () => {
    const cam = createCamera();
    const viewTilesW = VIEW_W / (TILE_PX * cam.zoom);
    const viewTilesH = VIEW_H / (TILE_PX * cam.zoom);
    const mapW = viewTilesW / 2;
    const mapH = viewTilesH / 2;

    cam.x = 999;
    cam.y = 999;
    clampCamera(cam, mapW, mapH);
    expect(cam.x).toBeCloseTo((mapW - viewTilesW) / 2, 6);
    expect(cam.y).toBeCloseTo((mapH - viewTilesH) / 2, 6);
  });

  it('panCamera moves the camera by the pixel delta converted to tiles', () => {
    const cam = createCamera();
    cam.x = 10;
    cam.y = 10;
    const px = TILE_PX * cam.zoom;
    panCamera(cam, px * 2, -px * 3);
    expect(cam.x).toBeCloseTo(12, 6);
    expect(cam.y).toBeCloseTo(7, 6);
  });

  it('centerCamera centers the viewport on the given point', () => {
    const cam = createCamera();
    const viewTilesW = VIEW_W / (TILE_PX * cam.zoom);
    const viewTilesH = VIEW_H / (TILE_PX * cam.zoom);
    centerCamera(cam, { x: 50, y: 60 });
    expect(cam.x).toBeCloseTo(50 - viewTilesW / 2, 6);
    expect(cam.y).toBeCloseTo(60 - viewTilesH / 2, 6);
  });

  it('zoomIn magnifies continuously (no level jumps) and clamps at the bounds', () => {
    const cam = createCamera();
    expect(cam.zoom).toBe(1);
    zoomIn(cam, 1000, 1000);
    expect(cam.zoom).toBeGreaterThan(1);
    expect(cam.zoom).toBeLessThan(2);
    for (let i = 0; i < 10; i++) zoomIn(cam, 1000, 1000);
    expect(cam.zoom).toBe(2); // clamped at the top
    zoomOut(cam, 1000, 1000);
    expect(cam.zoom).toBeLessThan(2);
    for (let i = 0; i < 20; i++) zoomOut(cam, 1000, 1000);
    expect(cam.zoom).toBe(0.5); // clamped at the bottom
  });

  it('zoom keeps the anchored world point fixed on screen', () => {
    const cam = createCamera();
    centerCamera(cam, { x: 30, y: 30 });
    const anchor = { x: 100, y: 80 };
    const before = screenToWorld(cam, anchor);
    zoomIn(cam, 1000, 1000, anchor);
    const after = screenToWorld(cam, anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('zooming out shows more of the map (more tiles fit the same viewport)', () => {
    const cam = createCamera();
    const tilesAtZoom1 = VIEW_W / (TILE_PX * cam.zoom);
    zoomOut(cam, 1000, 1000);
    const tilesAtZoomOut = VIEW_W / (TILE_PX * cam.zoom);
    expect(tilesAtZoomOut).toBeGreaterThan(tilesAtZoom1);
  });
});
