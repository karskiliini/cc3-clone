import { describe, expect, it } from 'vitest';
import { drawEffects } from '@/render/effects';
import { worldToScreen } from '@/engine/camera';
import type { Camera, Flash, Tracer } from '@/shared/types';
import { makeState } from './vehicleDamageHelpers';

function drawnEffects(cam: Camera, flashes: Flash[] = [], tracers: Tracer[] = []) {
  const state = makeState();
  state.flashes = flashes; state.tracers = tracers;
  const arcs: { x: number; y: number }[] = [], moves: { x: number; y: number }[] = [], lines: { x: number; y: number }[] = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fill() {}, stroke() {}, setLineDash() {},
    arc(x: number, y: number) { arcs.push({ x, y }); },
    moveTo(x: number, y: number) { moves.push({ x, y }); },
    lineTo(x: number, y: number) { lines.push({ x, y }); },
  } as unknown as CanvasRenderingContext2D;
  drawEffects(ctx, cam, state);
  return { arcs, moves, lines };
}

describe('SMG muzzle effect origins', () => {
  it.each([1, 2])('draws a muzzle-position flash at the raised barrel without another standoff, zoom %s', (zoom) => {
    const cam = { x: 2, y: 3, zoom } as Camera;
    const pos = { x: 10, y: 12 }, height = 1.5;
    const screen = worldToScreen(cam, pos);
    const { arcs } = drawnEffects(cam, [{ pos, facing: Math.PI / 2, t: 0, atMuzzle: true, heightM: height }]);
    expect(arcs.length).toBeGreaterThan(0);
    for (const arc of arcs) {
      expect(arc.x).toBeCloseTo(screen.x);
      expect(arc.y).toBeCloseTo(screen.y - Math.sin(Math.PI / 15) * 10 * height * zoom);
    }
  });

  it('retains the existing infantry flash offset when no muzzle metadata is supplied', () => {
    const cam = { x: 0, y: 0, zoom: 2 } as Camera;
    const pos = { x: 10, y: 12 }, screen = worldToScreen(cam, pos);
    const { arcs } = drawnEffects(cam, [{ pos, facing: Math.PI / 2, t: 0 }]);
    expect(arcs[0].x).toBeCloseTo(screen.x + 16);
    expect(arcs[0].y).toBeCloseTo(screen.y);
  });

  it('starts a tracer at the same raised barrel and leaves its ground endpoint unchanged', () => {
    const cam = { x: 0, y: 0, zoom: 1 } as Camera;
    const from = { x: 10, y: 12 }, to = { x: 12, y: 12 }, height = 0.95;
    const screen = worldToScreen(cam, from), target = worldToScreen(cam, to);
    const ray: Tracer = { from, to, t: 0, hit: false, kind: 'bullet', fromHeightM: height };
    const origin = drawnEffects(cam, [], [ray]);
    expect(origin.moves[0].x).toBeCloseTo(screen.x);
    expect(origin.moves[0].y).toBeCloseTo(screen.y - Math.sin(Math.PI / 15) * 10 * height);
    const end = drawnEffects(cam, [], [{ ...ray, t: 0.25 }]);
    // Contract: the round reaches the ground endpoint (impact point) at the end of its
    // travel — a drawn point coincides with the target regardless of draw order (the
    // dotted-trail rework draws head-first, the streak era drew tail-first).
    const atTarget = [...end.moves, ...end.lines].some((p) => Math.abs(p.x - target.x) < 1 && Math.abs(p.y - target.y) < 1);
    expect(atTarget).toBe(true);
    const legacy = drawnEffects(cam, [], [{ ...ray, fromHeightM: undefined }]);
    expect(legacy.moves[0]).toEqual(screen);
  });
});
