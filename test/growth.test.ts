import { describe, expect, it } from 'vitest';
import { buildMap } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { flattenByBlast, flattenUnderVehicle, growthHeightAt, tileStanding } from '@/sim/growth';
import { hasLOS, losTrace } from '@/sim/los';
import type { MapDef, Terrain } from '@/shared/types';

function field(): ReturnType<typeof buildMap> {
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: 60, height: 20, season: 'summer',
    paint: (tiles: Terrain[], w: number, h: number) => { const p = new MapPainter(tiles, w, h, 1); p.fill('open'); p.rect(10, 0, 40, 20, 'tallgrass'); },
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
  return buildMap(def);
}

describe('tall growth', () => {
  it('stands a metre high until a vehicle drives over it: ground level under the tracks, a little higher between them', () => {
    const map = field();
    expect(growthHeightAt(map, 30.5, 10.5)).toBeCloseTo(1.0);
    // a 6 x 3 m vehicle heading east, centred at (30.5, 10.5): tracks run along y = 10.5 -/+ 0.75 tiles
    flattenUnderVehicle(map, { x: 30.5, y: 10.5 }, Math.PI / 2, 6, 3);
    expect(growthHeightAt(map, 30.5, 10.5 - 0.62)).toBe(0);           // left track
    expect(growthHeightAt(map, 30.5, 10.5 + 0.62)).toBe(0);           // right track
    const mid = growthHeightAt(map, 30.5, 10.5);
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(0.5);    // bent over between the tracks
    expect(growthHeightAt(map, 30.5, 10.5 - 1.2)).toBeCloseTo(1.0);   // untouched beside the rut
    expect(growthHeightAt(map, 36.5, 10.5)).toBeCloseTo(1.0);         // and ahead of the vehicle
  });

  it('a prone man hidden by standing hay is seen along a lane driven through it', () => {
    const map = field();
    const from = { x: 5.5, y: 10.5 }, to = { x: 40.5, y: 10.5 };
    const h = { eyeM: 1.7, targetM: 0.4 };
    expect(hasLOS(map, from, to, h)).toBe(false);
    const before = losTrace(map, { x: 5.5, y: 10.5 }, { x: 14.5, y: 10.5 }, h).visibility;
    for (let x = 10; x <= 41; x += 0.5) flattenUnderVehicle(map, { x, y: 10.5 }, Math.PI / 2, 6, 3);
    expect(tileStanding(map, 10 * 60 + 25)).toBeLessThan(0.5);
    expect(hasLOS(map, from, to, h)).toBe(true);
    expect(losTrace(map, { x: 5.5, y: 10.5 }, { x: 14.5, y: 10.5 }, h).visibility).toBeGreaterThan(before);
    // two tiles to the side the hay still stands and still hides him
    expect(hasLOS(map, { x: 5.5, y: 14.5 }, { x: 40.5, y: 14.5 }, h)).toBe(false);
  });

  it('a blast lays the growth flat around the crater', () => {
    const map = field();
    flattenByBlast(map, { x: 30.5, y: 10.5 }, 3);
    expect(growthHeightAt(map, 30.5, 10.5)).toBe(0);
    expect(growthHeightAt(map, 30.5 + 1.6, 10.5)).toBeCloseTo(0.3);
    expect(growthHeightAt(map, 30.5 + 4, 10.5)).toBeCloseTo(1.0);
  });
});
