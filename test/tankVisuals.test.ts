import { describe, expect, it } from 'vitest';
import { shellTraceSample } from '@/render/shellTrace';
import { thrownTurretPose, vehicleLook, vehiclePose, TURRET_FLIGHT_S } from '@/render/vehicle3d/look';
import { TRACER_LIFE } from '@/shared/types';
import { detonateVehicle } from '@/sim/vehicleExplosion';
import { rollDeathOutcome } from '@/sim/vehicleDamage';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { addTank, makeState } from './vehicleDamageHelpers';

const from = { x: 100, y: 200 }, to = { x: 500, y: 200 };
describe('readable tank shells without changed ballistics', () => {
  it('starts with a visible body near the muzzle, travels continuously and fades only after reaching the impact', () => {
    expect(shellTraceSample(from, to, 0, 1)!.body).toBeGreaterThan(0);
    let prev = from.x;
    for (let t = 0; t < TRACER_LIFE; t += 0.01) {
      const s = shellTraceSample(from, to, t, 1)!;
      expect(s.x).toBeGreaterThanOrEqual(prev); expect(s.x).toBeLessThanOrEqual(to.x);
      expect(s.y).toBe(200); expect(s.body).toBeLessThanOrEqual(s.x - from.x + 1e-8); prev = s.x;
    }
    expect(shellTraceSample(from, to, TRACER_LIFE * 0.7, 1)!.x).toBe(to.x);
    expect(shellTraceSample(from, to, TRACER_LIFE, 1)).toBeNull();
  });
  it('scales to battle zooms, follows oblique fire and does not draw zero-length or future shots', () => {
    for (const zoom of [0.5, 1, 2]) expect(shellTraceSample(from, to, 0.1, zoom)!.body).toBeCloseTo(9 * zoom);
    expect(shellTraceSample(from, { x: 200, y: 300 }, 0.1, 1)!.angle).toBeCloseTo(Math.PI / 4);
    expect(shellTraceSample(from, from, 0.1, 1)).toBeNull(); expect(shellTraceSample(from, to, -0.1, 1)).toBeNull();
  });
});

describe('tank turret destruction follows a shared ballistic animation', () => {
  function scene() {
    const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 100, y: 100 });
    state.time = 10; expect(detonateVehicle(state, new Rng(8), v, 'soviet')).toBe(true);
    return { state, v };
  }
  it('records the real launch clock, rises off the hull, and lands exactly at the simulation landing', () => {
    const { state, v } = scene(); expect(v.turretBlownAt).toBe(10);
    const start = thrownTurretPose(vehicleLook(v, state))!;
    expect(start.posTiles).toEqual(v.pos); expect(start.heightM).toBe(0);
    state.time += TURRET_FLIGHT_S / 2;
    const mid = thrownTurretPose(vehicleLook(v, state))!;
    expect(mid.heightM).toBeGreaterThan(4); expect(mid.posTiles).not.toEqual(v.pos); expect(mid.posTiles).not.toEqual(v.turretLanding);
    state.time = 10 + TURRET_FLIGHT_S + 0.5;
    const end = thrownTurretPose(vehicleLook(v, state))!;
    expect(end.posTiles).toEqual(v.turretLanding); expect(end.heightM).toBe(0); expect(end.dirRad).toBe(v.turretLandingDir);
  });
  it('gives the 3D mesh the same horizontal position, height and rotation as the sprite animation sample', () => {
    const { state, v } = scene(); state.time += 0.5;
    const look = vehicleLook(v, state), sample = thrownTurretPose(look)!;
    const mesh = vehiclePose(look, true, { x: 0, y: 0.4 });
    expect(mesh.turretPivot).toEqual([sample.posTiles.x * 2, sample.heightM, sample.posTiles.y * 2]);
    expect(mesh.turretYaw).toBe(-sample.dirRad); expect(mesh.turretTilt).toBe(sample.tilt);
  });
  it('freezes while paused, does not mutate the sim, and supports historical wrecks without a launch clock', () => {
    const { state, v } = scene(); state.time += 0.6;
    const snapshot = JSON.stringify(v), a = vehicleLook(v, state);
    expect(thrownTurretPose(a)).toEqual(thrownTurretPose(vehicleLook(v, state))); expect(JSON.stringify(v)).toBe(snapshot);
    v.turretBlownAt = undefined;
    expect(thrownTurretPose(vehicleLook(v, state))!.posTiles).toEqual(v.turretLanding);
  });
  it('timestamps non-rack turret loss and never relaunches a turret already blown off', () => {
    const state = makeState(), { v } = addTank(state, 'pz4gh', { x: 100, y: 100 });
    rollDeathOutcome({ next: () => 0.68 }, v, VEHICLE_DEFS.pz4gh, true, 3);
    expect(v.turretBlownAt).toBe(3); state.time = 9;
    detonateVehicle(state, new Rng(4), v, 'soviet'); expect(v.turretBlownAt).toBe(3);
  });
});
