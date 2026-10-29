import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { SIM_DT, TILE_M } from '@/shared/types';
import { dist, angleTo, wrapAngle } from '@/shared/math';
import { applyOrder } from '@/sim/orders';
import { findPath, isPassable, segmentPassable } from '@/sim/path';
import { DRIVE_ACCEL_MS2, stepVehicles } from '@/sim/vehicle';
import { coverFrom } from '@/sim/cover';
import { vehicleGrowthRangeMul, updateSpotting } from '@/sim/spotting';
import { flattenUnderVehicle } from '@/sim/growth';
import { hashState } from '@/sim/stateHash';
import { addTank, makeState, W } from './vehicleDamageHelpers';

function tick(state: ReturnType<typeof makeState>, rng: Rng) {
  state.time += SIM_DT; stepVehicles(state, rng, SIM_DT);
}

describe('tank throttle and field driving', () => {
  for (const defId of ['pz4gh', 't34_76', 't70']) {
    it(`${defId} accelerates steadily and drives through a tree belt into cover-producing trunks`, () => {
      const state = makeState(), rng = new Rng(4);
      const { v, team } = addTank(state, defId, { x: 30.5, y: 40.5 }, 0, 60);
      for (let y = 27; y <= 35; y++) for (let x = 28; x <= 32; x++) state.map.tiles[y * W + x] = 'woods';
      applyOrder(state, team, { type: 'moveFast', target: { x: 30.5, y: 22.5 }, issuedAt: 0 }, rng);
      expect(v.path.some(p => state.map.tiles[Math.floor(p.y) * W + Math.floor(p.x)] === 'woods')).toBe(true);
      let top = 0, previous = 0, stoppedTicks = 0;
      for (let i = 0; i < 28 / SIM_DT; i++) {
        const before = { ...v.pos }; tick(state, rng);
        const moved = dist(before, v.pos) * TILE_M;
        expect(v.speed - previous).toBeLessThanOrEqual(DRIVE_ACCEL_MS2 * SIM_DT + 1e-8);
        if (moved > 1e-7) expect(Math.abs(wrapAngle(angleTo(before, v.pos) - v.hullFacing))).toBeLessThan(0.01);
        if (v.path.length > 0 && moved < 1e-7 && v.speed > 0.5) stoppedTicks++;
        previous = v.speed; top = Math.max(top, v.speed);
      }
      expect(top).toBeGreaterThan(2); expect(stoppedTicks).toBe(0);
      expect(v.pos.y).toBeCloseTo(22.5, 1);
      expect(state.map.fallenTrees!.size).toBeGreaterThan(8);
      const i = [...state.map.fallenTrees!.keys()][0];
      const p = { x: i % W + 0.5, y: Math.floor(i / W) + 0.5 };
      expect(state.map.tiles[i]).toBe('rubble');
      expect(coverFrom(state.map, p, 0)).toBeGreaterThanOrEqual(0.35);
      expect(isPassable(state.map, Math.floor(p.x), Math.floor(p.y), 'infantry')).toBe(true);
      expect(state.map.tiles[35 * W + 28]).toBe('woods'); // outside the hull's contact band
    });
  }

  it('tank routes cross trees while wheels, water, buildings, bunkers and steep banks retain their limits', () => {
    const state = makeState(), map = state.map;
    for (let y = 20; y < 40; y++) map.tiles[y * W + 25] = 'woods';
    expect(findPath(map, { x: 20.5, y: 30.5 }, { x: 30.5, y: 30.5 }, 'tank').some(p => Math.floor(p.x) === 25 && Math.floor(p.y) === 30)).toBe(true);
    expect(isPassable(map, 25, 30, 'vehicle')).toBe(false);
    for (const tile of ['water', 'buildingStone', 'floor'] as const) { map.tiles[30 * W + 25] = tile; expect(isPassable(map, 25, 30, 'tank')).toBe(false); }
    map.tiles[30 * W + 25] = 'woods'; map.groundSteep = new Float32Array(W * W); map.groundSteep[30 * W + 25] = 0.4;
    expect(isPassable(map, 25, 30, 'tank')).toBe(false);
  });

  it('does not smooth a route through a tiny fractional wall-corner intersection', () => {
    const state = makeState(); state.map.tiles[96 * W + 45] = 'buildingStone';
    expect(segmentPassable(state.map, { x: 44.998, y: 96.124 }, { x: 47.5, y: 91.5 }, 'tank')).toBe(false);
    expect(segmentPassable(state.map, { x: 44.5, y: 95.5 }, { x: 47.5, y: 91.5 }, 'tank')).toBe(true);
  });

  it('a straight Move behind the hull builds reverse speed gradually without turning round', () => {
    const state = makeState(), rng = new Rng(4);
    const { v, team } = addTank(state, 'pz4gh', { x: 30.5, y: 30.5 }, 0, 60);
    applyOrder(state, team, { type: 'move', target: { x: 30.5, y: 44.5 }, issuedAt: 0 }, rng);
    let prev = 0;
    for (let i = 0; i < 30; i++) { tick(state, rng); expect(v.speed).toBeLessThan(0); expect(Math.abs(v.speed) - prev).toBeLessThanOrEqual(DRIVE_ACCEL_MS2 * SIM_DT + 1e-8); prev = Math.abs(v.speed); }
    expect(v.hullFacing).toBe(0); expect(v.pos.y).toBeGreaterThan(31);
  });

  it('fallen-tree state affects the deterministic battle hash', () => {
    const state = makeState(), rng = new Rng(2), before = hashState({ state, rng });
    state.map.fallenTrees = new Map([[5, { facing: 0.7, fellAt: 1 }]]);
    expect(hashState({ state, rng })).not.toBe(before);
  });
});

describe('tall growth screens tank silhouettes', () => {
  it('screens stationary armour more than moving or firing armour; crushed growth offers less screening', () => {
    const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 30.5, y: 30.5 }, 0, 60);
    for (let y = 25; y <= 35; y++) for (let x = 25; x <= 35; x++) state.map.tiles[y * W + x] = 'tallgrass';
    const standing = vehicleGrowthRangeMul(state, v);
    expect(standing).toBeLessThan(0.75); expect(standing).toBeGreaterThan(0.6);
    v.speed = 3; expect(vehicleGrowthRangeMul(state, v)).toBeGreaterThan(standing);
    v.speed = 0; v.lastMainShotAt = state.time; expect(vehicleGrowthRangeMul(state, v)).toBeGreaterThan(0.9);
    v.lastMainShotAt = -999;
    flattenUnderVehicle(state.map, v.pos, 0, 12, 12);
    expect(vehicleGrowthRangeMul(state, v)).toBeGreaterThan(0.9);
  });

  it('actually reduces distant spotting while leaving close sightings possible', () => {
    const state = makeState();
    const { v: observer } = addTank(state, 'pz4gh', { x: 30.5, y: 30.5 }, Math.PI / 2, 60, 'german');
    const { v: target } = addTank(state, 't34_76', { x: 190.5, y: 30.5 }, 0, 60, 'soviet');
    updateSpotting(state, new Rng(2)); expect(state.spottedVehicles.german.has(target.id)).toBe(true);
    for (let y = 25; y <= 35; y++) for (let x = 185; x <= 195; x++) state.map.tiles[y * W + x] = 'tallgrass';
    updateSpotting(state, new Rng(2)); expect(state.spottedVehicles.german.has(target.id)).toBe(false);
    target.pos = { x: observer.pos.x + 3, y: observer.pos.y };
    updateSpotting(state, new Rng(2)); expect(state.spottedVehicles.german.has(target.id)).toBe(true);
  });
});
