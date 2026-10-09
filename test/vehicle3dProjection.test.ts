import { describe, it, expect } from 'vitest';
import { worldToScreen } from '@/engine/camera';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import {
  viewProjection, toScreen, worldPoint, shadowMatrix, localToWorldXZ, TILT_RAD, SUN_TO,
} from '@/render/vehicle3d/projection';

function cam(x: number, y: number, zoom: number) {
  return { x, y, zoom } as Parameters<typeof worldToScreen>[0];
}

describe('vehicle3d projection', () => {
  it.each([[0.5, 0, 0], [1, 12.5, 40.25], [2, 180, 96]])('ground points land where worldToScreen puts them (zoom %s, cam %s,%s)', (zoom, cx, cy) => {
    const c = cam(cx, cy, zoom);
    const m = viewProjection(c, VIEW_W, VIEW_H);
    for (const p of [{ x: cx + 3, y: cy + 7 }, { x: cx + 40.5, y: cy + 20.25 }]) {
      const s = toScreen(m, worldPoint(p, 0), VIEW_W, VIEW_H);
      const ref = worldToScreen(c, p);
      expect(s.x).toBeCloseTo(ref.x, 6);
      expect(s.y).toBeCloseTo(ref.y, 6);
    }
  });

  it('height lifts a point up the screen by z·sin(12°)·ppm', () => {
    const c = cam(0, 0, 1);
    const m = viewProjection(c, VIEW_W, VIEW_H);
    const ppm = TILE_PX / 2;
    const g = toScreen(m, worldPoint({ x: 10, y: 10 }, 0), VIEW_W, VIEW_H);
    const h = toScreen(m, worldPoint({ x: 10, y: 10 }, 3), VIEW_W, VIEW_H);
    expect(h.x).toBeCloseTo(g.x, 9);
    expect(g.y - h.y).toBeCloseTo(3 * Math.sin(TILT_RAD) * ppm, 9);
  });

  it('higher and more southern points are nearer (smaller depth), all inside the clip range', () => {
    const c = cam(0, 0, 1);
    const m = viewProjection(c, VIEW_W, VIEW_H);
    const base = toScreen(m, worldPoint({ x: 10, y: 10 }, 0), VIEW_W, VIEW_H).depth;
    expect(toScreen(m, worldPoint({ x: 10, y: 10 }, 2), VIEW_W, VIEW_H).depth).toBeLessThan(base);
    expect(toScreen(m, worldPoint({ x: 10, y: 11 }, 0), VIEW_W, VIEW_H).depth).toBeLessThan(base);
    for (const p of [{ x: 0, y: 0 }, { x: 60, y: 40 }]) {
      for (const z of [-2, 25]) expect(Math.abs(toScreen(m, worldPoint(p, z), VIEW_W, VIEW_H).depth)).toBeLessThan(1);
    }
  });

  it('has a negative determinant like a standard three.js ortho camera (front faces keep their winding)', () => {
    const e = viewProjection(cam(3, 4, 1), VIEW_W, VIEW_H);
    // upper-left 3x3, column-major
    const det = e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
    expect(det).toBeLessThan(0);
  });

  it('shadows fall to the south-east on the ground plane, along the sun', () => {
    const s = shadowMatrix();
    const P = [0, 2, 0, 1];
    const out = [0, 1, 2, 3].map((r) => s[r] * P[0] + s[4 + r] * P[1] + s[8 + r] * P[2] + s[12 + r] * P[3]);
    expect(out[1]).toBeCloseTo(0.002, 9);
    expect(out[0]).toBeGreaterThan(0);              // east
    expect(out[2]).toBeGreaterThan(0);              // south
    expect(out[0] / 2).toBeCloseTo(-SUN_TO[0] / SUN_TO[1], 9);
  });

  it('hull-local offsets rotate clockwise from north', () => {
    const [e0, s0] = localToWorldXZ(0, 1, 0);           // forward, facing north
    expect(e0).toBeCloseTo(0, 9); expect(s0).toBeCloseTo(-1, 9);
    const [e1, s1] = localToWorldXZ(0, 1, Math.PI / 2); // forward, facing east
    expect(e1).toBeCloseTo(1, 9); expect(s1).toBeCloseTo(0, 9);
    const [e2, s2] = localToWorldXZ(1, 0, 0);           // right, facing north
    expect(e2).toBeCloseTo(1, 9); expect(s2).toBeCloseTo(0, 9);
  });
});
