import { describe, it, expect } from 'vitest';
import type { MapDef, Terrain } from '@/shared/types';
import { buildMap, tileAt, idx, inBounds, coverAt, concealmentAt, setTile } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { TERRAIN_PROPS } from '@/sim/terrain';

function makeDef(paint: (tiles: Terrain[], w: number, h: number) => void, w = 20, h = 20): MapDef {
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

describe('map', () => {
  it('buildMap assigns a common buildingId to a building via flood fill', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.building(5, 5, 5, 5, 'wood');
    });
    const map = buildMap(def);
    const floorTile = idx(map, 7, 7);
    const wallTile = idx(map, 5, 7);
    expect(map.tiles[floorTile]).toBe('floor');
    expect(map.tiles[wallTile]).toBe('buildingWood');
    expect(map.buildingId[floorTile]).toBeGreaterThanOrEqual(0);
    expect(map.buildingId[floorTile]).toBe(map.buildingId[wallTile]);
  });

  it('marks windows on wall tiles adjacent to a road (door)', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.building(5, 5, 5, 5, 'stone');
      p.rect(4, 7, 1, 1, 'dirtroad'); // adjacent to wall at (5,7)
    });
    const map = buildMap(def);
    const wallNextToRoad = idx(map, 5, 7);
    expect(map.windows[wallNextToRoad]).toBe(1);
  });

  it('marks roughly every 3rd perimeter wall tile as a window', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.building(2, 2, 8, 8, 'wood');
    });
    const map = buildMap(def);
    let windowCount = 0;
    let wallCount = 0;
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] === 'buildingWood') {
        wallCount++;
        if (map.windows[i] === 1) windowCount++;
      }
    }
    expect(wallCount).toBeGreaterThan(0);
    expect(windowCount).toBeGreaterThan(0);
    expect(windowCount).toBeLessThan(wallCount);
  });

  it('tileAt clamps out-of-bounds queries', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('grass');
    });
    const map = buildMap(def);
    expect(inBounds(map, -1, 0)).toBe(false);
    expect(tileAt(map, -1, 0)).toBe('grass');
    expect(tileAt(map, 999, 999)).toBe('grass');
  });

  it('coverAt/concealmentAt reflect terrain props and smoke', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
      p.rect(5, 5, 3, 3, 'woods');
    });
    const map = buildMap(def);
    expect(coverAt(map, { x: 6.5, y: 6.5 })).toBeCloseTo(TERRAIN_PROPS.woods.cover);
    const before = concealmentAt(map, { x: 6.5, y: 6.5 });
    map.smoke[idx(map, 6, 6)] = 0.4;
    const after = concealmentAt(map, { x: 6.5, y: 6.5 });
    expect(after).toBeCloseTo(before + 0.4 * 1.5);
  });

  it('setTile mutates the tile grid', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('open');
    });
    const map = buildMap(def);
    setTile(map, 3, 3, 'crater');
    expect(map.tiles[idx(map, 3, 3)]).toBe('crater');
  });
});
