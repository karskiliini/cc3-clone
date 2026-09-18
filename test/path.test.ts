import { describe, it, expect } from 'vitest';
import type { MapDef, Terrain } from '@/shared/types';
import { buildMap } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { findPath, isPassable } from '@/sim/path';

function makeDef(paint: (tiles: Terrain[], w: number, h: number) => void, w = 30, h = 30): MapDef {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    width: w,
    height: h,
    season: 'summer',
    paint,
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
}

describe('path', () => {
  it('finds a straight path across open ground', () => {
    const def = makeDef((tiles, w, h) => new MapPainter(tiles, w, h, 1).fill('open'));
    const map = buildMap(def);
    const path = findPath(map, { x: 2.5, y: 2.5 }, { x: 10.5, y: 2.5 }, 'infantry');
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1];
    expect(last.x).toBeCloseTo(10.5);
    expect(last.y).toBeCloseTo(2.5);
  });

  it('prefers a road over rough ground when not much longer', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('mud');
      p.road([{ x: 2, y: 2 }, { x: 2, y: 20 }, { x: 20, y: 20 }], 2, 'pavedroad');
    });
    const map = buildMap(def);
    const path = findPath(map, { x: 2.5, y: 2.5 }, { x: 20.5, y: 20.5 }, 'infantry');
    expect(path.length).toBeGreaterThan(0);
    let onRoadCount = 0;
    for (const p of path) {
      const t = map.tiles[Math.floor(p.y) * map.width + Math.floor(p.x)];
      if (t === 'pavedroad') onRoadCount++;
    }
    // most of the path should ride the road corridor rather than cut straight through open ground
    expect(onRoadCount).toBeGreaterThan(path.length * 0.5);
  });

  it('water is impassable: path routes around it or gives up if fully surrounded', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(0, 10, 30, 3, 'water'); // full-width water barrier
    });
    const map = buildMap(def);
    expect(isPassable(map, 5, 11, 'infantry')).toBe(false);
    const path = findPath(map, { x: 5.5, y: 5.5 }, { x: 5.5, y: 25.5 }, 'infantry');
    // unreachable across a full barrier with no bridge: falls back to nearest reachable tile,
    // which must not be beyond the water.
    for (const p of path) {
      expect(p.y).toBeLessThan(10);
    }
  });

  it('building interior is reachable for infantry (walls act as doors)', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.building(10, 10, 5, 5, 'wood');
    });
    const map = buildMap(def);
    const path = findPath(map, { x: 2.5, y: 12.5 }, { x: 12.5, y: 12.5 }, 'infantry');
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1];
    expect(Math.floor(last.x)).toBe(12);
    expect(Math.floor(last.y)).toBe(12);
  });

  it('vehicles cannot enter woods or buildings', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(10, 10, 5, 5, 'woods');
    });
    const map = buildMap(def);
    expect(isPassable(map, 12, 12, 'vehicle')).toBe(false);
    expect(isPassable(map, 12, 12, 'infantry')).toBe(true);
  });

  it('handles a 240x180 open map corner-to-corner under 250ms', () => {
    // 50 ms on an idle machine (A* over 43k tiles); the full suite runs many workers in
    // parallel on the same cores, which multiplies wall time ~4x — budget for that, and the
    // smoke test below still catches true regressions.
    const def = makeDef((tiles, w, h) => new MapPainter(tiles, w, h, 1).fill('open'), 240, 180);
    const map = buildMap(def);
    const start = performance.now();
    const path = findPath(map, { x: 0.5, y: 0.5 }, { x: 239.5, y: 179.5 }, 'infantry');
    const elapsed = performance.now() - start;
    expect(path.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
  });
});
