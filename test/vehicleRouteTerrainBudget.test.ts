import { expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { takeHullDrive } from '@/sim/hullDrive';
import { stepVehicles } from '@/sim/vehicle';
import { addTank, makeState } from './vehicleDamageHelpers';

it('retains the original diagonal edge terrain budget when consuming its reached road waypoint', () => {
  const state = makeState(), start = { x: 20.5, y: 20.5 }, next = { x: 21.5, y: 21.5 };
  const { v, team } = addTank(state, 'stug3g', start, 3 * Math.PI / 4);
  state.map.tiles[20 * state.map.width + 20] = 'dirtroad';
  state.map.tiles[21 * state.map.width + 21] = 'dirtroad';
  state.map.tiles[20 * state.map.width + 21] = 'mud';
  state.map.tiles[21 * state.map.width + 20] = 'mud';
  v.path = [start, next];
  team.order = { type: 'move', target: next, issuedAt: 0 };
  stepVehicles(state, new Rng(3), 0.1);
  expect(v.path[0]).toBe(next);
  expect(takeHullDrive(v).speedMs).toBeGreaterThan(0);
});
