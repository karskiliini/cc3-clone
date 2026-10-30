import { expect, it, vi } from 'vitest';
import { DEFAULT_FORCES } from '@/data/operation';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { Battle } from '@/sim/battle';
import { groundProbe } from '@/sim/hullGround';
import * as physics from '@/sim/hullPhysics';
import { add, rotate } from '@/sim/hullMath';
import { beginVehicleBodyTick, completeVehicleMovement } from '@/sim/vehicle';
import { Rng } from '@/shared/rng';
import { SIM_DT } from '@/shared/types';
import { kineticEnergy, stop } from './hullPhysicsHelpers';
import { addTank, makeState } from './vehicleDamageHelpers';

it('places the Berlin seed 2 Tiger without launch energy and keeps its actual terrain contact bounded', () => {
  const battle = new Battle({ mapId: 'berlin_1945', playerSide: 'german', year: 1945, seed: 2,
    durationS: 1200, difficulty: 'normal', forces: DEFAULT_FORCES[1945], aiBothSides: true });
  battle.submit('german', { type: 'autoDeploy' });
  battle.submit('german', { type: 'ready' });
  battle.flushDue();
  const tiger = battle.state.vehicles.get(46)!;
  expect(tiger.defId).toBe('tiger');
  expect(tiger.pos).toEqual({ x: 56.5, y: 89.5 });
  const body = structuredClone(tiger.body!), def = VEHICLE_DEFS[tiger.defId], p = hullParams(def);
  const probe = groundProbe(battle.state.map);
  // The old four-corner plane put this hull inside a roof boundary: its very
  // first 10 ms force update produced vz=31 m/s and omega.y=-19 rad/s.
  for (const x of [p.solidBox.min.x, p.solidBox.max.x])
    for (const y of [p.solidBox.min.y, p.solidBox.max.y])
      for (const z of [p.solidBox.min.z, p.solidBox.max.z]) {
        const point = add(body.position, rotate(body.orientation, { x, y, z }));
        expect(point.z).toBeGreaterThanOrEqual(probe(point.x, point.y).heightM - 1e-10);
      }
  for (const contact of p.contacts) {
    const point = add(body.position, rotate(body.orientation, contact.local)), ground = probe(point.x, point.y);
    expect((ground.heightM - point.z) * ground.normal.z).toBeLessThanOrEqual(p.suspension.travelM + 1e-10);
  }
  expect(kineticEnergy(body, def)).toBe(0);
  // Berlin's surface is above zero. Even allowing all initial gravitational
  // potential and every spring's full-travel energy bounds this passive fall.
  const energyBudget = p.massKg * 9.81 * body.position.z
    + p.contacts.length * 0.5 * p.suspension.springKNm * 1000 * p.suspension.travelM ** 2;
  let maxEnergy = 0, maxQuatError = 0;
  for (let tick = 0; tick < 6000; tick++) {
    physics.stepHullBody(body, def, stop, probe, SIM_DT);
    maxEnergy = Math.max(maxEnergy, kineticEnergy(body, def));
    const q = body.orientation;
    maxQuatError = Math.max(maxQuatError, Math.abs(q.x ** 2 + q.y ** 2 + q.z ** 2 + q.w ** 2 - 1));
    expect([...Object.values(body.position), ...Object.values(body.velocity), ...Object.values(body.angularVelocity)].every(Number.isFinite)).toBe(true);
  }
  expect(maxEnergy).toBeLessThan(energyBudget);
  expect(maxQuatError).toBeLessThan(1e-12);
  // Exercise the original production path beyond its former tick-80 failure.
  for (let tick = 0; tick < 100; tick++) { battle.step(SIM_DT); battle.drainEvents(); }
  expect(battle.state.tick).toBe(100);
  for (const v of battle.state.vehicles.values()) if (v.body)
    expect([...Object.values(v.body.position), ...Object.values(v.body.velocity), ...Object.values(v.body.angularVelocity)].every(Number.isFinite)).toBe(true);
}, 60000);

it('rejects nonfinite and out-of-map sweep endpoints before allocating sample points', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  const def = VEHICLE_DEFS[v.defId];
  beginVehicleBodyTick(state, v, def);
  const before = { ...v.body!.position };
  const mock = vi.spyOn(physics, 'stepHullBody').mockImplementation((body, _def, _drive, _probe, _dt, _going, accept) => {
    expect(accept).toBeDefined();
    for (const x of [NaN, Infinity, -Infinity, 1e200, -1e200, -0.01, state.map.width * 2])
      expect(accept!(body.position, { ...body.position, x })).toBe(false);
    expect(accept!({ ...body.position, x: 1e200 }, body.position)).toBe(false);
    expect(accept!({ ...body.position, x: -0.01 }, body.position)).toBe(false);
  });
  try {
    completeVehicleMovement(state, new Rng(1), SIM_DT, v, def, undefined);
    expect(v.body!.position).toEqual(before);
    expect(mock).toHaveBeenCalledOnce();
  } finally { mock.mockRestore(); }
});
