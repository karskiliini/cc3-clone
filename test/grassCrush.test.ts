import { describe, it, expect } from 'vitest';
import type { GameMap } from '@/shared/types';
import { CrushMap, crushMapFor } from '@/render/grassCrush';

describe('CrushMap', () => {
  it('knows nothing until something is stamped', () => {
    expect(new CrushMap(20, 20).at({ x: 10, y: 10 })).toBeNull();
  });
  it('flattens the band driven, half-width either side, with the travel direction', () => {
    const c = new CrushMap(20, 20);
    c.stampBand({ x: 10, y: 10 }, { x: 10, y: 6 }, 1.5);          // 8 m north
    expect(c.at({ x: 10, y: 8 })).toEqual({ level: 1, dirRad: 0 });
    expect(c.at({ x: 10.5, y: 8 })?.level).toBe(1);               // 1 m aside: inside 1.5 m
    expect(c.at({ x: 11, y: 8 })).toBeNull();                      // 2 m aside
    expect(c.at({ x: 10, y: 11 })).toBeNull();                     // behind the start
    expect(c.at({ x: 10, y: 5 })).toBeNull();                      // beyond the end
  });
  it('stores eastward travel as a quarter turn', () => {
    const c = new CrushMap(20, 20);
    c.stampBand({ x: 4, y: 10 }, { x: 8, y: 10 }, 1);
    expect(c.at({ x: 6, y: 10 })!.dirRad).toBeCloseTo(Math.PI / 2, 1);
  });
  it('clear forgets everything; points off the map are null', () => {
    const c = new CrushMap(20, 20);
    c.stampBand({ x: 10, y: 10 }, { x: 10, y: 6 }, 1.5);
    expect(c.at({ x: -1, y: 8 })).toBeNull();
    c.clear();
    expect(c.at({ x: 10, y: 8 })).toBeNull();
  });
  it('one crush map per game map', () => {
    const a = { width: 20, height: 20 } as GameMap, b = { width: 20, height: 20 } as GameMap;
    expect(crushMapFor(a)).toBe(crushMapFor(a));
    expect(crushMapFor(a)).not.toBe(crushMapFor(b));
  });
});
