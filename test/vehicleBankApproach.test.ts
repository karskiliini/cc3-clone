import { describe, expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { bankCoverApproach, bankHullClear, bankTurningRoom } from '@/sim/vehicleBankApproach';
import { findPath } from '@/sim/path';
import { losTrace } from '@/sim/los';
import { angleTo, dist } from '@/shared/math';
import { makeState } from './vehicleDamageHelpers';

function pocket() {
  const state = makeState();
  for (let y = 200; y <= 202; y++) for (let x = 201; x <= 203; x++) {
    if (x !== 202 || y !== 201) state.map.tiles[y * state.map.width + x] = 'water';
  }
  state.map.tiles[200 * state.map.width + 202] = 'buildingStone';
  return state.map;
}

describe('supported approaches beside water', () => {
  it('accepts an aligned refuge without requiring room for a complete turn there', () => {
    const map = pocket(), def = VEHICLE_DEFS.pz4gh;
    expect(bankHullClear(map, def, { x: 203.5, y: 203.5 }, Math.PI / 2)).toBe(false);
    expect(bankHullClear(map, def, { x: 203.5, y: 203.75 }, Math.PI / 2)).toBe(true);
    expect(bankHullClear(map, def, { x: 203.5, y: 203.75 }, 0)).toBe(false);
    expect(bankTurningRoom(map, def, { x: 203.5, y: 203.75 })).toBe(false);
  });

  it('stages the bank turn and reaches an oriented supported point inside the original cover region', () => {
    const map = pocket(), def = VEHICLE_DEFS.pz4gh, from = { x: 200.5, y: 200.5 };
    const target = { x: 203.5, y: 203.5 }, threat = { x: 200.5, y: 192.5 };
    const validCover = (p: { x: number; y: number }) => {
      const trace = losTrace(map, p, threat);
      return !trace.clear && !!trace.blockedAt && dist(p, trace.blockedAt) <= 4;
    };
    const route = findPath(map, from, target, 'vehicle', 2000, undefined, { def });
    const approach = bankCoverApproach(map, def, from, route, validCover)!;
    expect(approach).toBeTruthy();
    expect(bankTurningRoom(map, def, approach.staging)).toBe(true);
    expect(validCover(approach.target)).toBe(true);
    expect(bankHullClear(map, def, approach.target, angleTo(approach.staging, approach.target))).toBe(true);
    expect(route.at(-1)).toEqual(target); // caller's route is immutable
  });
});
