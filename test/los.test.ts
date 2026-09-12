import { describe, it, expect } from 'vitest';
import type { MapDef, Terrain } from '@/shared/types';
import { buildMap, idx } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { hasLOS, losTrace, losDistanceFactor } from '@/sim/los';

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

describe('los', () => {
  it('a wall blocks LOS through it', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(10, 5, 1, 10, 'stonewall');
    });
    const map = buildMap(def);
    expect(hasLOS(map, { x: 5.5, y: 9.5 }, { x: 15.5, y: 9.5 })).toBe(false);
  });

  it('open ground at short range has clear LOS', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
    });
    const map = buildMap(def);
    expect(hasLOS(map, { x: 5.5, y: 5.5 }, { x: 10.5, y: 5.5 })).toBe(true);
  });

  it('window wall tile lets LOS through when adjacent to shooter or target', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.building(5, 5, 5, 5, 'wood');
    });
    const map = buildMap(def);
    // find a window tile on the west wall (x=5) and shoot from just outside it
    let windowY = -1;
    for (let y = 5; y < 10; y++) {
      if (map.windows[idx(map, 5, y)] === 1) { windowY = y; break; }
    }
    expect(windowY).toBeGreaterThan(-1);
    const from = { x: 3.5, y: windowY + 0.5 };
    const to = { x: 6.5, y: windowY + 0.5 }; // inside the building, adjacent to the window wall
    const result = losTrace(map, from, to);
    expect(result.clear).toBe(true);
  });

  it('a non-window wall tile blocks LOS even nearby', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.building(5, 5, 5, 5, 'stone');
    });
    const map = buildMap(def);
    let wallY = -1;
    for (let y = 5; y < 10; y++) {
      if (map.windows[idx(map, 5, y)] === 0) { wallY = y; break; }
    }
    expect(wallY).toBeGreaterThan(-1);
    const from = { x: 3.5, y: wallY + 0.5 };
    const to = { x: 6.5, y: wallY + 0.5 };
    const result = losTrace(map, from, to);
    expect(result.clear).toBe(false);
  });

  it('three hedge tiles in a row accumulate concealment and block LOS', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(8, 10, 3, 1, 'hedge');
    });
    const map = buildMap(def);
    // hedge concealment 0.6 per tile: 2 tiles >= 1.0, so a shot through 3 tiles is blocked
    expect(hasLOS(map, { x: 5.5, y: 10.5 }, { x: 15.5, y: 10.5 })).toBe(false);
  });

  it('a single hedge tile does not fully block LOS at short range', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(10, 10, 1, 1, 'hedge');
    });
    const map = buildMap(def);
    const result = losTrace(map, { x: 8.5, y: 10.5 }, { x: 12.5, y: 10.5 });
    expect(result.clear).toBe(true);
    expect(result.visibility).toBeGreaterThan(0);
  });

  it('losDistanceFactor matches pinned points', () => {
    expect(losDistanceFactor(0)).toBeCloseTo(1);
    expect(losDistanceFactor(200)).toBeCloseTo(0.5);
    expect(losDistanceFactor(400)).toBeCloseTo(0.2);
  });

  it('a soldier inside woods can see out a couple tiles but not far through it', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(5, 5, 20, 20, 'woods');
    });
    const map = buildMap(def);
    const insideNear = losTrace(map, { x: 10.5, y: 10.5 }, { x: 12.5, y: 10.5 });
    expect(insideNear.clear).toBe(true);
    const insideFar = losTrace(map, { x: 10.5, y: 10.5 }, { x: 22.5, y: 10.5 });
    expect(insideFar.clear).toBe(false);
  });

  it('woods hard-blocks LOS when the shooter is outside it', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(10, 5, 3, 10, 'woods');
    });
    const map = buildMap(def);
    expect(hasLOS(map, { x: 2.5, y: 9.5 }, { x: 20.5, y: 9.5 })).toBe(false);
  });
});
