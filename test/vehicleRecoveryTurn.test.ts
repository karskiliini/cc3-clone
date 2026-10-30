import { expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { groundProbe } from '@/sim/hullGround';
import { takeHullDrive } from '@/sim/hullDrive';
import { boxProjection } from '@/sim/localDriver';
import { placeVehicleBody, stepVehicles } from '@/sim/vehicle';
import { addTank, makeState } from './vehicleDamageHelpers';

it('turns the accepted hull while retreating in the opposite gear', () => {
  const state = makeState();
  const { v, team } = addTank(state, 'pz4gh', { x: 20.5, y: 20.5 });
  const def = VEHICLE_DEFS[v.defId];
  placeVehicleBody(v, def, v.pos, 0, groundProbe(state.map));
  const goal = { x: 30.5, y: 10.5 };
  team.order = { type: 'move', target: goal, issuedAt: 0 };
  v.path = [goal];
  const anchorM = { x: v.body!.position.x, y: v.body!.position.y };
  const axis = { x: 0, y: 1 };
  v.localDriver = {
    owner: 1,
    episode: { anchorM, attempts: 1, limit: 3, exhausted: false },
    window: null,
    recovery: { gear: -1, capMs: 2.5, anchorM, axis, turning: true,
      entryMaxProjection: boxProjection(v.body!, hullParams(def).solidBox, axis, anchorM).max,
      phase: 'pending', budgetTicks: 0, elapsedTicks: 0 },
  };
  const start = { ...v.pos };
  const rng = new Rng(3);
  let movingTurn = false;
  for (let i = 0; i < 10; i++) {
    state.time += 0.1;
    stepVehicles(state, rng, 0.1);
    const drive = takeHullDrive(v);
    if (drive.speedMs < 0 && drive.yawRateRadS > 0 && v.speed < 0 && v.hullFacing > 0.01) movingTurn = true;
  }
  expect(movingTurn).toBe(true);
  expect(dist(start, v.pos)).toBeGreaterThan(0.1);
  expect(v.hullFacing).toBeGreaterThan(0.05);
  expect(v.localDriver!.episode!.attempts).toBe(1);
});
