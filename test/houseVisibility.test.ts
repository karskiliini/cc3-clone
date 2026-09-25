import { describe, it, expect } from 'vitest';
import { losTrace } from '@/sim/los';
import { buildMap } from '@/sim/map';
import type { GameMap, MapDef } from '@/shared/types';

function houseMap(): GameMap {
  const W = 48;
  const tiles: string[] = new Array(W * W).fill('open');
  for (let y = 10; y <= 19; y++) for (let x = 10; x <= 19; x++) {
    const edge = x === 10 || x === 19 || y === 10 || y === 19;
    tiles[y * W + x] = edge ? 'buildingStone' : 'floor';
  }
  const def = { id: 't27b', width: W, height: W, attacker: 'german', season: 'summer', year: 1942,
    paint: (t: string[]) => { for (let i = 0; i < t.length; i++) t[i] = tiles[i]; },
    deployZones: { german: { x: 0, y: 0, w: 8, h: W }, soviet: { x: W - 8, y: 0, w: 8, h: W } },
    victoryLocations: [] } as unknown as MapDef;
  return buildMap(def);
}

describe('item 027: house visibility floor level', () => {
  it('reports which perimeter tiles are windows', () => {
    const map = houseMap();
    const wins: string[] = [];
    for (let y = 10; y <= 19; y++) for (let x = 10; x <= 19; x++) {
      if (map.tiles[y * 48 + x] === 'buildingStone' && map.windows[y * 48 + x] === 1) wins.push(`(${x},${y})`);
    }
    console.log('WINDOWS:', wins.join(' '));
    expect(wins.length).toBeGreaterThan(0);
  });

  it('house interiors are not a goldfish bowl: deep interior invisible through windows, window-adjacent men visible', () => {
    const map = houseMap();
    // ray enters through the east-wall window at (19,14) and ends on the interior (14,14):
    // one interior floor tile of concealment at 0.85 — a distant observer's visibility is
    // crushed toward zero instead of the old goldfish-bowl 0.6
    const r = losTrace(map, { x: 20.6, y: 14 }, { x: 14, y: 14 }, { eyeM: 1.7, targetM: 1.7 });
    // four interior floor tiles at 0.85 concealment each: the line dies inside — the man in
    // the BACK of the room is invisible even through a window; only men right at the glass
    // (one interior tile on the line) remain spottable
    expect(r.clear).toBe(false);
    // and a man standing right at the window (single interior tile on the line) stays visible,
    // dimmed: the ray (20.6,14)->(18.6,14) crosses the window + one floor tile
    const near = losTrace(map, { x: 20.6, y: 14 }, { x: 18.6, y: 14 }, { eyeM: 1.7, targetM: 1.7 });
    expect(near.clear).toBe(true); // right at the glass: still seen
  });
});
