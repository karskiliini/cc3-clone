import * as dm from '@/shared/dmath';
import { VEHICLE_DEFS } from '@/data/units';
import { getHeightField, setTileProfile } from '@/sim/heightField';
import { describe, it, expect } from 'vitest';
import type { MapDef, Terrain } from '@/shared/types';
import { buildMap } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { findPath, isPassable, vehicleSlopeCost } from '@/sim/path';

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

describe('directional vehicle slopes', () => {
  function slopeMap(grade: number) {
    const map = buildMap(makeDef((tiles, w, h) => new MapPainter(tiles, w, h, 1).fill('open')));
    map.ground = new Float32Array(map.width * map.height);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) map.ground[y * map.width + x] = (x + 0.5) * 2 * grade;
    map.groundSteep = new Float32Array(map.width * map.height).fill(Math.abs(grade));
    return map;
  }
  it('charges across-slope motion independently of the forward climb cap', () => {
    const map = slopeMap(0.24), def = { ...VEHICLE_DEFS.sdkfz251, slopeComfortDeg: 5, slopeTipDeg: 30 };
    expect(vehicleSlopeCost(map, { x: 10.5, y: 10.5 }, { x: 11.5, y: 10.5 }, def)).toBe(1);
    expect(vehicleSlopeCost(map, { x: 10.5, y: 10.5 }, { x: 10.5, y: 11.5 }, def)).toBeGreaterThan(1);
    expect(vehicleSlopeCost(slopeMap(0.26), { x: 10.5, y: 10.5 }, { x: 11.5, y: 10.5 }, def)).toBe(Infinity);
  });
  it('allows a safe contour beyond the old global cutoff and forbids a tipping contour', () => {
    const map = slopeMap((dm.sin(35 * Math.PI / 180) / dm.cos(35 * Math.PI / 180)));
    const from = { x: 10.5, y: 10.5 }, to = { x: 10.5, y: 18.5 };
    expect(isPassable(map, 10, 10, 'vehicle')).toBe(false);
    expect(isPassable(map, 10, 10, 'vehicle', VEHICLE_DEFS.kv1)).toBe(true);
    expect(vehicleSlopeCost(map, from, to, VEHICLE_DEFS.sdkfz251)).toBe(Infinity);
    expect(vehicleSlopeCost(map, from, to, VEHICLE_DEFS.kv1)).toBeGreaterThan(1);
    expect(findPath(map, from, to, 'vehicle', undefined, undefined, { def: VEHICLE_DEFS.kv1 }).at(-1)).toEqual(to);
    expect(findPath(map, from, to, 'vehicle', undefined, undefined, { def: VEHICLE_DEFS.sdkfz251 })).toEqual([]);
    expect(findPath(map, from, to, 'infantry')).toEqual(findPath(slopeMap(0), from, to, 'infantry'));
  });
  it('does not interpret a composite feature as a bare-ground slope', () => {
    const map = slopeMap(0);
    setTileProfile(getHeightField(map), 10, 11, 3);
    expect(vehicleSlopeCost(map, { x: 10.5, y: 10.5 }, { x: 10.5, y: 11.5 }, VEHICLE_DEFS.sdkfz251)).toBe(1);
  });
});
