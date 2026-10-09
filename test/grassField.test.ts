import { describe, it, expect } from 'vitest';
import { bladeAt, CELL_M, type GrowthAt } from '@/render/vehicle3d/grassField';

const grass: GrowthAt = () => 'tallgrass';
const crops: GrowthAt = () => 'crops';
const none: GrowthAt = () => null;
/** horizontal tip offset (fraction of length) of a blade bent into an arc of `a` radians */
const tipOffset = (a: number): number => (a < 1e-6 ? 0 : (1 - Math.cos(a)) / a);

describe('blade field', () => {
  it('the same cell always grows the same blade, inside that cell', () => {
    const a = bladeAt(1234, 567, grass, 'summer')!, b = bladeAt(1234, 567, grass, 'summer')!;
    expect(a).toEqual(b);
    expect(a.xM).toBeGreaterThanOrEqual(1234 * CELL_M); expect(a.xM).toBeLessThan(1235 * CELL_M);
    expect(a.zM).toBeGreaterThanOrEqual(567 * CELL_M); expect(a.zM).toBeLessThan(568 * CELL_M);
  });
  it('no blade where nothing tall grows', () => {
    expect(bladeAt(10, 10, none, 'summer')).toBeNull();
  });
  it('tall grass grows curved grass blades, crops grow straight wheat', () => {
    for (let i = 0; i < 300; i++) {
      const g = bladeAt(i, 3 * i, grass, 'summer')!, w = bladeAt(i, 3 * i, crops, 'summer')!;
      expect(g.kind).toBe('grass'); expect(w.kind).toBe('wheat');
      expect(g.heightM).toBeGreaterThanOrEqual(0.6); expect(g.heightM).toBeLessThanOrEqual(0.9);
      expect(w.heightM).toBeGreaterThanOrEqual(1.0); expect(w.heightM).toBeLessThanOrEqual(1.2);
      expect(g.widthM).toBeGreaterThanOrEqual(0.04); expect(g.widthM).toBeLessThanOrEqual(0.06);
      expect(tipOffset(g.restAngle)).toBeGreaterThanOrEqual(0.14); expect(tipOffset(g.restAngle)).toBeLessThanOrEqual(0.31);
      expect(tipOffset(w.restAngle)).toBeLessThanOrEqual(0.08);
    }
  });
  it('colours come from the season palette', () => {
    const s = bladeAt(5, 9, grass, 'summer')!, w = bladeAt(5, 9, grass, 'winter')!;
    expect(s.colour).not.toBe(w.colour);
    expect([0x4c5823, 0x5c6829, 0x6e7831, 0x80883b]).toContain(s.colour);
  });
});
