// ============================================================================
// groundMarks.test.ts — the stamped ground-mark layers in render/noise.ts (grass clumps, blades,
// scuffs, winter tussocks). The painted ground is only seamless across independently baked
// chunks if a mark layer is a PURE FUNCTION OF WORLD POSITION: two bakes whose windows overlap
// must agree bit-for-bit on every shared world pixel, at every zoom.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { acquireMarkLayers, stampTufts, stampScuffs, stampTussocks, type MarkLayers, type TuftStyle } from '@/render/noise';

const STYLE: TuftStyle = {
  cell: 3.4, seed: 1234, minLen: 1.6, maxLen: 4, minAspect: 0.35, maxAspect: 0.8,
  amp: 0.25, flat: 0.5, lightFrac: 0.5, warmFrac: 0.2, coolFrac: 0.2, tint: 0.32,
  angleJitter: 0.6, seedHead: 0.4, crisp: 2, windScale: 150, windBase: -0.9, windSwing: 0.9,
};
const dens = (X: number, Y: number): number => 0.5 + 0.4 * Math.sin(X / 40) * Math.cos(Y / 33);

function stampAll(size: number, slot: number, wx0: number, wy0: number, zoom: number): MarkLayers {
  const l = acquireMarkLayers(size, slot);
  stampTufts(l, wx0, wy0, zoom, STYLE, dens);
  stampScuffs(l, wx0, wy0, zoom, { cell: 38, seed: 77, minR: 1.4, maxR: 3.4, blobs: 6, spread: 6 }, () => 0.5);
  return l;
}

describe('stamped ground marks', () => {
  for (const zoom of [0.5, 1, 2]) {
    it(`is a pure function of world position across overlapping bakes @ zoom ${zoom}`, () => {
      const size = 128;
      const shiftW = 40; // world px, a whole number of output px at every zoom
      const a = stampAll(size, 0, 600, 300, zoom);
      const b = stampAll(size, 1, 600 + shiftW, 300 + shiftW, zoom);
      const so = shiftW * zoom;
      let compared = 0, nonZero = 0;
      for (let y = 0; y < size - so; y++) {
        for (let x = 0; x < size - so; x++) {
          const ia = (y + so) * size + x + so, ib = y * size + x;
          expect(b.L[ib]).toBe(a.L[ia]);
          expect(b.T[ib]).toBe(a.T[ia]);
          expect(b.E[ib]).toBe(a.E[ia]);
          compared++;
          if (a.L[ia] !== 0) nonZero++;
        }
      }
      expect(compared).toBeGreaterThan(1000);
      expect(nonZero / compared).toBeGreaterThan(0.3); // the layer is actually populated
    });
  }

  it('winter tussocks agree across overlapping bakes and respect density 0', () => {
    const size = 96;
    const a = acquireMarkLayers(size, 0), b = acquireMarkLayers(size, 1);
    stampTussocks(a, 0, 0, 1, { cell: 8, seed: 5 }, () => 0.6);
    stampTussocks(b, 32, 16, 1, { cell: 8, seed: 5 }, () => 0.6);
    let marks = 0;
    for (let y = 0; y < size - 16; y++) {
      for (let x = 0; x < size - 32; x++) {
        const ia = (y + 16) * size + x + 32, ib = y * size + x;
        expect(b.E[ib]).toBe(a.E[ia]);
        expect(b.L[ib]).toBe(a.L[ia]);
        if (a.E[ia] > 0) marks++;
      }
    }
    expect(marks).toBeGreaterThan(20);
    const none = acquireMarkLayers(size, 0);
    stampTussocks(none, 0, 0, 1, { cell: 8, seed: 5 }, () => 0);
    expect(none.E.every((v) => v === 0)).toBe(true);
  });

  it('marks are clumps a few pixels across, not single-pixel noise', () => {
    const size = 160;
    const l = acquireMarkLayers(size, 0);
    stampTufts(l, 0, 0, 1, STYLE, () => 0.8);
    let mean = 0;
    for (const v of l.L) mean += v;
    mean /= l.L.length;
    let c0 = 0, c1 = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size - 1; x++) {
        const a = l.L[y * size + x] - mean, b = l.L[y * size + x + 1] - mean;
        c0 += a * a; c1 += a * b;
      }
    }
    expect(c1 / c0).toBeGreaterThan(0.5); // white noise would sit near 0
  });
});
