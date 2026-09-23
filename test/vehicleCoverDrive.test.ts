import { describe, expect, it } from 'vitest';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { angleTo, dist, wrapAngle } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { hasLOS } from '@/sim/los';
import { isPassable } from '@/sim/path';
import { isVehicleReversing, onVehicleNearMiss, stepVehicles } from '@/sim/vehicle';
import { addTank, makeState } from './vehicleDamageHelpers';

describe('a tank drives into cover instead of sliding', () => {
  for (const defId of ['pz4gh', 't34_76']) {
    it(`${defId} turns and drives forward into side cover with hull-aligned displacement`, () => {
      const state = makeState();
      const { v } = addTank(state, defId, { x: 200.5, y: 200.5 }, 0, 60, 'german');
      state.map.tiles[200 * state.map.width + 202] = 'buildingStone';
      const threat = { x: 200.5, y: 192.5 };
      onVehicleNearMiss(state, v, WEAPONS.pak40, threat);
      expect(hasLOS(state.map, v.pos, threat)).toBe(true);
      const start = { ...v.pos };
      const rng = new Rng(3);
      let moved = 0, pivoted = false, reachedCover = false;
      for (let i = 0; i < 18 / SIM_DT; i++) {
        const before = { ...v.pos }, facing = v.hullFacing;
        state.time += SIM_DT;
        stepVehicles(state, rng, SIM_DT);
        const delta = dist(before, v.pos);
        const turned = Math.abs(wrapAngle(v.hullFacing - facing));
        expect(turned).toBeLessThanOrEqual(VEHICLE_DEFS[defId].hullTurnDegS! * Math.PI / 180 * SIM_DT + 1e-8);
        if (delta < 1e-8 && turned > 1e-6) pivoted = true;
        if (delta > 1e-8) {
          moved += delta * TILE_M;
          expect(Math.abs(wrapAngle(angleTo(before, v.pos) - v.hullFacing))).toBeLessThan(0.01);
          expect(v.speed).toBeGreaterThanOrEqual(0);
          expect(isPassable(state.map, Math.floor(v.pos.x), Math.floor(v.pos.y), 'vehicle')).toBe(true);
        }
        if (!hasLOS(state.map, v.pos, threat)) { reachedCover = true; break; }
      }
      expect(pivoted).toBe(true);
      expect(moved).toBeGreaterThan(2);
      expect(dist(start, v.pos) * TILE_M).toBeGreaterThan(2);
      expect(reachedCover).toBe(true);
    });
  }

  it('an aligned rearward withdrawal backs along the hull and reports reverse speed', () => {
    const state = makeState();
    // Hull north; the nearby wall to the northeast screens a short retreat directly south
    // from an attacker farther northeast, so the driver can preserve frontal armour.
    const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60);
    state.map.tiles[199 * state.map.width + 201] = 'buildingStone';
    for (let y = 200; y <= 203; y++) state.map.tiles[y * state.map.width + 201] = 'water';
    const threat = { x: 204.5, y: 184.5 };
    onVehicleNearMiss(state, v, WEAPONS.pak40, threat);
    const rng = new Rng(9);
    let reversed = false;
    for (let i = 0; i < 8 / SIM_DT; i++) {
      const before = { ...v.pos };
      state.time += SIM_DT;
      stepVehicles(state, rng, SIM_DT);
      if (dist(before, v.pos) < 1e-8) continue;
      const slip = Math.abs(wrapAngle(angleTo(before, v.pos) - v.hullFacing - Math.PI));
      expect(slip).toBeLessThan(0.01);
      expect(v.speed).toBeLessThan(0);
      reversed = true;
      break;
    }
    expect(reversed).toBe(true);
  });

  it('settles in cover and resumes the existing order after the threat memory clears without snapping', () => {
    const state = makeState();
    const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60);
    state.map.tiles[200 * state.map.width + 202] = 'buildingStone';
    const threat = { x: 200.5, y: 192.5 };
    onVehicleNearMiss(state, v, WEAPONS.pak40, threat);
    const orderedRoute = [{ x: 190.5, y: 210.5 }];
    v.path = orderedRoute;
    const rng = new Rng(3);
    let stillFor = 0;
    for (let i = 0; i < 14 / SIM_DT && stillFor < 0.5; i++) {
      const before = { ...v.pos }, facing = v.hullFacing;
      state.time += SIM_DT;
      stepVehicles(state, rng, SIM_DT);
      stillFor = !hasLOS(state.map, v.pos, threat) && dist(before, v.pos) < 1e-8
        && Math.abs(wrapAngle(v.hullFacing - facing)) < 1e-8 ? stillFor + SIM_DT : 0;
      expect(v.path).toBe(orderedRoute);
    }
    expect(stillFor).toBeGreaterThanOrEqual(0.5);
    expect(v.speed).toBe(0);
    expect(isVehicleReversing(state, v)).toBe(true); // holds its refuge while the threat is remembered
    const refuge = { ...v.pos };
    state.time += 16; // the unseen shooter's near-miss memory has expired
    for (let i = 0; i < 15 / SIM_DT; i++) {
      const before = { ...v.pos };
      state.time += SIM_DT;
      stepVehicles(state, rng, SIM_DT);
      expect(isVehicleReversing(state, v)).toBe(false);
      expect(dist(before, v.pos) * TILE_M).toBeLessThanOrEqual(VEHICLE_DEFS.pz4gh.speedRoadMs * SIM_DT + 1e-6);
    }
    expect(dist(refuge, v.pos) * TILE_M).toBeGreaterThan(4);
    expect(dist(v.pos, { x: 190.5, y: 210.5 })).toBeLessThan(dist(refuge, { x: 190.5, y: 210.5 }));
  });

  it('drives to reachable cover when the closest screened tile is an isolated pocket', () => {
    const state = makeState();
    const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 60);
    for (let y = 200; y <= 202; y++) for (let x = 201; x <= 203; x++) {
      if (x !== 202 || y !== 201) state.map.tiles[y * state.map.width + x] = 'water';
    }
    state.map.tiles[200 * state.map.width + 202] = 'buildingStone';
    const threat = { x: 200.5, y: 192.5 };
    onVehicleNearMiss(state, v, WEAPONS.pak40, threat);
    const rng = new Rng(3);
    const start = { ...v.pos };
    for (let i = 0; i < 14 / SIM_DT; i++) {
      state.time += SIM_DT;
      stepVehicles(state, rng, SIM_DT);
      expect(isPassable(state.map, Math.floor(v.pos.x), Math.floor(v.pos.y), 'vehicle')).toBe(true);
      if (!hasLOS(state.map, v.pos, threat)) break;
    }
    expect(dist(start, v.pos) * TILE_M).toBeGreaterThan(2);
    expect(hasLOS(state.map, v.pos, threat)).toBe(false);
  });
});
