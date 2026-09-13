import { describe, it, expect } from 'vitest';
import type { GameMap, MapDef, Terrain } from '@/shared/types';
import { coverFrom, coverScore, omniCoverAt } from '@/sim/cover';

const W = 10, H = 10;

function makeMap(setup: (tiles: Terrain[]) => void): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  setup(tiles);
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
  return {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
}

function setTile(tiles: Terrain[], x: number, y: number, t: Terrain): void {
  tiles[y * W + x] = t;
}

describe('coverFrom', () => {
  it('is higher against fire perpendicular to a wall than against fire parallel to it', () => {
    // A stonewall sits directly north of the soldier's tile (2,2), i.e. at (2,1).
    const map = makeMap((tiles) => setTile(tiles, 2, 1, 'stonewall'));
    const tile = { x: 2.5, y: 2.5 };

    const perpendicular = coverFrom(map, tile, 0); // fire arriving from due north, straight into the wall
    const parallel = coverFrom(map, tile, Math.PI / 2); // fire arriving from due east, along the wall

    expect(perpendicular).toBeGreaterThan(parallel);
  });

  it('omni cover (trench) protects equally regardless of direction, on top of any linear cover', () => {
    const map = makeMap((tiles) => setTile(tiles, 2, 2, 'trench'));
    const tile = { x: 2.5, y: 2.5 };
    const north = coverFrom(map, tile, 0);
    const east = coverFrom(map, tile, Math.PI / 2);
    expect(north).toBeCloseTo(east, 5);
    expect(north).toBeCloseTo(omniCoverAt(map, tile), 5);
  });

  it('combines omni and linear cover, capped at 1', () => {
    const map = makeMap((tiles) => { setTile(tiles, 2, 2, 'trench'); setTile(tiles, 2, 1, 'buildingStone'); });
    const tile = { x: 2.5, y: 2.5 };
    const cover = coverFrom(map, tile, 0);
    expect(cover).toBeLessThanOrEqual(1);
    expect(cover).toBeGreaterThan(omniCoverAt(map, tile));
  });
});

describe('coverScore', () => {
  it('weights multiple threats by confidence/threat level', () => {
    const map = makeMap((tiles) => setTile(tiles, 2, 1, 'stonewall'));
    const tile = { x: 2.5, y: 2.5 };
    const scoreNorthHeavy = coverScore(map, tile, [
      { dirRad: 0, weight: 0.9 },
      { dirRad: Math.PI, weight: 0.1 },
    ]);
    const scoreSouthHeavy = coverScore(map, tile, [
      { dirRad: 0, weight: 0.1 },
      { dirRad: Math.PI, weight: 0.9 },
    ]);
    // The wall is on the north side, so weighting the northern threat more heavily should score
    // higher (the wall actually helps against the threat that matters most).
    expect(scoreNorthHeavy).toBeGreaterThan(scoreSouthHeavy);
  });

  it('returns the omni cover when there are no threats', () => {
    const map = makeMap((tiles) => setTile(tiles, 2, 2, 'crater'));
    const tile = { x: 2.5, y: 2.5 };
    expect(coverScore(map, tile, [])).toBeCloseTo(omniCoverAt(map, tile), 5);
  });
});
