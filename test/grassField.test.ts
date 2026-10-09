import { describe, it, expect } from 'vitest';
import { bendBlade, bladeAt, CELL_M, FLAT, patchFade, PUSH_M, type Blade, type GrowthAt, type HullPatch } from '@/render/vehicle3d/grassField';

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

// a north-facing 7 x 3 m hull at the origin: its right side (east) is x = 1.5, its bow z = -3.5
const hull = (over: Partial<HullPatch> = {}): HullPatch => ({ id: 1, xM: 0, zM: 0, facing: 0, halfLenM: 3.5, halfWidM: 1.5, speedMs: 0, ...over });
const blade = (xM: number, zM: number): Blade => ({ kind: 'grass', xM, zM, heightM: 0.8, widthM: 0.05, restAngle: 0, restDir: 0, colour: 0 });

describe('patch fade', () => {
  it('is full near the hull, gone at the patch edge, and never rises outward', () => {
    expect(patchFade(0)).toBe(1); expect(patchFade(2.5)).toBe(1);
    expect(patchFade(5)).toBe(0); expect(patchFade(7)).toBe(0);
    let last = 1;
    for (let d = 2.5; d <= 5; d += 0.1) { const f = patchFade(d); expect(f).toBeLessThanOrEqual(last); last = f; }
  });
});

describe('bending', () => {
  it('under the hull the growth lies flat along the hull', () => {
    const b = bendBlade(blade(0.5, 1), [hull()], null);
    expect(b.angle).toBe(FLAT); expect(b.heightScale).toBe(0.08);
    expect(b.dirZ).toBeCloseTo(-1);                       // facing north
  });
  it('beside the hull blades lean away from it, more the closer they stand', () => {
    const near = bendBlade(blade(1.7, 0), [hull()], null), far = bendBlade(blade(2.3, 0), [hull()], null);
    expect(near.dirX).toBeCloseTo(1); expect(near.dirZ).toBeCloseTo(0);
    expect(near.angle).toBeGreaterThan(far.angle);
    expect(far.angle).toBeGreaterThan(0);
    expect(bendBlade(blade(1.5 + PUSH_M + 0.5, 0), [hull()], null).angle).toBe(0);   // rest
  });
  it('a moving bow pushes the blades ahead of it forward, further out than a parked one', () => {
    const parked = bendBlade(blade(0, -5), [hull()], null);
    const moving = bendBlade(blade(0, -5), [hull({ speedMs: 4 })], null);
    expect(parked.angle).toBe(0);
    expect(moving.angle).toBeGreaterThan(0); expect(moving.dirZ).toBeCloseTo(-1);
  });
  it('reversing pushes the blades behind the stern backward', () => {
    const b = bendBlade(blade(0, 5), [hull({ speedMs: -2 })], null);
    expect(b.dirZ).toBeCloseTo(1); expect(b.angle).toBeGreaterThan(0);
  });
  it('wake gap: right behind a moving tail the growth already lies flat', () => {
    const b = bendBlade(blade(0.3, 3.5 + 0.6), [hull({ speedMs: 4 })], null);
    expect(b.angle).toBe(FLAT); expect(b.heightScale).toBe(0.12); expect(b.dirZ).toBeCloseTo(-1);
    expect(bendBlade(blade(0.3, 3.5 + 0.6), [hull()], null).heightScale).toBe(1);   // parked: no gap
  });
  it('crushed ground lies flat the way it was driven', () => {
    const b = bendBlade(blade(20, 20), [hull()], () => ({ level: 1, dirRad: Math.PI / 2 }));
    expect(b.angle).toBe(FLAT); expect(b.heightScale).toBe(0.12); expect(b.dirX).toBeCloseTo(1);
  });
  it('between two hulls the stronger push wins', () => {
    const a = hull(), b = hull({ id: 2, xM: 4 });            // b's left side at x = 2.5
    const r = bendBlade(blade(2.3, 0), [a, b], null);        // 0.8 m from a, 0.2 m from b
    expect(r.dirX).toBeCloseTo(-1);
  });
});
