import {recordVisual,vehicleObserver} from '@/sim/perception';
import {ensureSeats} from '@/sim/vehicleDamage';
import { expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { takeHullDrive } from '@/sim/hullDrive';
import { stepVehicles } from '@/sim/vehicle';
import { addTank, makeState } from './vehicleDamageHelpers';

for (const obstacle of ['none', 'water', 'hull'] as const) {
  it(`checks the reverse escape before giving way: ${obstacle}`, () => {
    const state = makeState();
    const { v, team } = addTank(state, 't34_76', { x: 20.5, y: 20.5 });
    const target = { x: 20.5, y: 10.5 };
    team.order = { type: 'move', target, issuedAt: 0 };
    v.path = [target];
    v.giveWayUntil = 1;
    if (obstacle === 'water') state.map.tiles[21 * state.map.width + 20] = 'water';
    if (obstacle === 'hull') {
      const other = addTank(state, 't34_76', { x: 20.5, y: 23 });
      other.v.state = 'knockedOut';
      ensureSeats(state,v);recordVisual(state,vehicleObserver(state,v,'driver')!,other.v,'vehicle');
      for (const id of other.team.soldierIds) state.soldiers.delete(id);
    }
    state.time = 0.1;
    stepVehicles(state, new Rng(1), 0.1);
    const drive = takeHullDrive(v);
    if (obstacle === 'none') {
      expect(drive.speedMs).toBeLessThan(0);
      expect(v.giveWayUntil).toBe(1);
    } else {
      expect(drive.speedMs).toBeGreaterThanOrEqual(0);
      expect(v.giveWayUntil).toBeUndefined();
      expect(v.path.at(-1)).toEqual(target);
    }
  });
}
