import { describe, it, expect } from 'vitest';
import type { MapDef, Terrain } from '@/shared/types';
import { buildMap } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { aimLineProfile, aimPointClass, classifyPoint } from '@/sim/losProfile';

function makeDef(paint: (tiles: Terrain[], w: number, h: number) => void, w = 60, h = 30): MapDef {
  return {
    id: 'test', name: 'Test', description: '', width: w, height: h, season: 'summer', paint,
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
}

describe('aiming line profile', () => {
  it('is one clear run over open ground', () => {
    const map = buildMap(makeDef((t, w, h) => { new MapPainter(t, w, h, 1).fill('open'); }));
    const segs = aimLineProfile(map, { x: 5.5, y: 10.5 }, { x: 45.5, y: 10.5 });
    expect(segs).toHaveLength(1);
    expect(segs[0].cls).toBe('clear');
    expect(segs[0].t0).toBe(0);
    expect(segs[0].t1).toBe(1);
  });

  it('turns blocked at a wall and stays blocked behind it', () => {
    const map = buildMap(makeDef((t, w, h) => {
      const p = new MapPainter(t, w, h, 1); p.fill('open'); p.rect(25, 0, 1, 30, 'stonewall');
    }));
    const from = { x: 5.5, y: 10.5 }, to = { x: 45.5, y: 10.5 };
    const segs = aimLineProfile(map, from, to);
    expect(segs[0].cls).toBe('clear');
    expect(aimPointClass(segs)).toBe('blocked');
    const firstBlocked = segs.find((s) => s.cls === 'blocked')!;
    // the wall is at x=25 of a 5.5 -> 45.5 line: about half way
    expect(firstBlocked.t0).toBeGreaterThan(0.4);
    expect(firstBlocked.t0).toBeLessThan(0.6);
    expect(classifyPoint(map, from, { x: 40.5, y: 10.5 })).toBe('blocked');
    expect(classifyPoint(map, from, { x: 20.5, y: 10.5 })).toBe('clear');
  });

  it('marks ground seen through concealment as obscured before it is blocked', () => {
    const map = buildMap(makeDef((t, w, h) => {
      const p = new MapPainter(t, w, h, 1); p.fill('open'); p.rect(20, 0, 12, 30, 'tallgrass');
    }));
    const segs = aimLineProfile(map, { x: 5.5, y: 10.5 }, { x: 55.5, y: 10.5 });
    const classes = segs.map((s) => s.cls);
    expect(classes[0]).toBe('clear');
    expect(classes).toContain('obscured');
    // runs are contiguous and cover the whole line
    expect(segs[0].t0).toBe(0);
    expect(segs[segs.length - 1].t1).toBe(1);
    for (let i = 1; i < segs.length; i++) expect(segs[i].t0).toBeCloseTo(segs[i - 1].t1, 6);
  });

  it('handles a zero-length line', () => {
    const map = buildMap(makeDef((t, w, h) => { new MapPainter(t, w, h, 1).fill('open'); }));
    expect(aimLineProfile(map, { x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([{ t0: 0, t1: 1, cls: 'clear' }]);
  });
});
