import { describe, expect, it, vi } from 'vitest';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { createHullBody, stepHullBody } from '@/sim/hullPhysics';
import { hullRecoveryDrive, stepHullGameplay } from '@/sim/hullGameplay';
import { isServiceable, isRemountTarget, tryRemountOrder } from '@/sim/vehicleCrew';
import { isImmobile } from '@/sim/vehicleDamage';
import { stepVehicles } from '@/sim/vehicle';
import { stepTransport } from '@/sim/transport';
import * as hullPhysics from '@/sim/hullPhysics';
import { requestHullDrive, takeHullDrive } from '@/sim/hullDrive';
import { cross, dot, rotate, yawQuat } from '@/sim/hullMath';
import * as dm from '@/shared/dmath';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';
import { flat, stop } from './hullPhysicsHelpers';
import type { HullGroundProbe, Vec3 } from '@/shared/types';

function fixture(id = 'sdkfz251') {
  const state = makeState(), rng = new Rng(4), rig = addTank(state, id, { x: 20, y: 20 });
  rig.v.body = createHullBody(VEHICLE_DEFS[id], rig.v.pos, 0, flat);
  return { state, rng, ...rig, body: rig.v.body };
}
function tick(f: ReturnType<typeof fixture>, n = 1) {
  for (let i = 0; i < n; i++) { f.state.time += 0.1; stepHullGameplay(f.state, f.rng, f.v, 0.1, true); }
}

describe('permanent overturn', () => {
  it.each(['roll', 'pitch'])('requires two continuous seconds of excessive %s, then happens once', axis => {
    const f = fixture();
    f.body.orientation = axis === 'roll' ? { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
      : { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    f.v.path = [{ x: 21, y: 20 }];
    tick(f, 19);
    expect(f.body.overturned).toBe(false);
    tick(f);
    expect(f.body.overturned).toBe(true);
    expect(f.v.state).toBe('knockedOut');
    expect(f.v.path).toEqual([]);
    expect(isServiceable(f.v)).toBe(false);
    expect(f.v.fire).toBeUndefined();
    expect(f.v.deathOutcome).toBeUndefined();
    const after = f.rng.state(); tick(f, 30);
    expect(f.rng.state()).toBe(after);
    expect(f.state.messages.filter(m => m.text.includes('overturned'))).toHaveLength(1);
  });
  it('resets the continuous timer if it recovers before two seconds', () => {
    const f = fixture();
    f.body.orientation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }; tick(f, 19);
    f.body.orientation = yawQuat(0); tick(f);
    expect(f.body.tippedS).toBe(0);
    f.body.orientation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }; tick(f, 19);
    expect(f.body.overturned).toBe(false);
  });
  it('rolls exactly once per living aboard man in soldier-id order and uses passenger exit flow', () => {
    const f = fixture();
    const p = soldier(2, 7, f.v.side, f.v.pos, 'kar98k', { vehicleId: f.v.id, seat: 'passenger' });
    f.state.soldiers.set(p.id, p); f.state.teams.set(7, mkTeam(7, 'rifle', [2], f.v.side, f.v.pos));
    f.v.passengerIds = [p.id];
    f.crew[0].health = 'dead';
    const outside = soldier(1, f.team.id, f.v.side, f.v.pos, 'kar98k');
    f.state.soldiers.set(1, outside); f.team.soldierIds.unshift(1); f.team.soldierIds.reverse();
    const next = vi.spyOn(f.rng, 'next').mockReturnValueOnce(0.1).mockReturnValue(0.01);
    f.body.orientation = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }; tick(f, 20);
    expect(next).toHaveBeenCalledTimes(f.crew.length);
    expect(p.health).toBe('wounded');
    expect(f.crew.slice(1).every(s => s.health === 'incapacitated')).toBe(true);
    expect(outside.health).toBe('healthy');
    expect(f.v.unloading?.panicked).toBe(true);
    for (let i = 0; i < 100; i++) { f.state.time += 0.1; stepTransport(f.state, 0.1); }
    expect(p.vehicleId).toBeNull();
    tick(f); expect(next).toHaveBeenCalledTimes(f.crew.length);
  });
  it('cannot remount an overturned hull even if its state is later abandoned', () => {
    const f = fixture(); f.body.overturned = true; f.v.state = 'abandoned';
    expect(isServiceable(f.v)).toBe(false);
    expect(isRemountTarget(f.state, f.team, f.v.pos)).toBe(false);
    expect(tryRemountOrder(f.state, f.team, { type: 'move', target: f.v.pos, issuedAt: 0 })).toBe(true);
    expect(f.v.remount).toBeUndefined();
  });
  it('still integrates a permanent wreck in production', () => {
    const f = fixture(); f.body.overturned = true; f.v.state = 'knockedOut';
    f.body.position.z += 10; const z = f.body.position.z;
    stepVehicles(f.state, f.rng, 0.1);
    expect(f.body.position.z).toBeLessThan(z);
    expect(f.body.overturned).toBe(true);
  });
});

describe('hung-up recovery', () => {
  it('recognizes support-only belly after .5 s without granting traction', () => {
    const f = fixture('t34_76'), p = hullParams(VEHICLE_DEFS[f.v.defId]);
    const ridge: HullGroundProbe = (x) => ({ heightM: Math.abs(x - f.body.position.x) < 0.1 ? 2 : 0, normal: { x: 0, y: 0, z: 1 } });
    f.body.position.z = 2 - p.solidBox.min.z + 1e-9;
    const x = f.body.position.x, y = f.body.position.y;
    for (let i = 0; i < 4; i++) stepHullBody(f.body, VEHICLE_DEFS[f.v.defId], stop, ridge, 0.1);
    expect(f.body.hungUp).toBe(false);
    stepHullBody(f.body, VEHICLE_DEFS[f.v.defId], stop, ridge, 0.1);
    expect(f.body.hungUp).toBe(true);
    for (let i = 0; i < 30; i++) {
      const drive = hullRecoveryDrive(f.v, f.team.experience)!;
      stepHullBody(f.body, VEHICLE_DEFS[f.v.defId], drive, ridge, 0.1); tick(f);
    }
    expect(f.body.position.x).toBeCloseTo(x, 8); expect(f.body.position.y).toBeCloseTo(y, 8);
    expect(f.body.suspensionTravel.every(c => c === 0)).toBe(true);
    expect(f.body.rockTries).toBe(2);
  });
  it('does not mark airborne or roof-supported hulls hung up', () => {
    const f = fixture('t34_76'); f.body.position.z += 100;
    for (let i = 0; i < 6; i++) stepHullBody(f.body, VEHICLE_DEFS[f.v.defId], stop, flat, 0.1);
    expect(f.body.hungUp).toBe(false); expect(f.body.hungS).toBe(0);
    f.body.orientation = { x: 1, y: 0, z: 0, w: 0 };
    f.body.position.z = hullParams(VEHICLE_DEFS[f.v.defId]).solidBox.max.z + 1e-9;
    f.body.velocity = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 6; i++) stepHullBody(f.body, VEHICLE_DEFS[f.v.defId], stop, flat, 0.1);
    expect(f.body.hungUp).toBe(false);
  });
  it.each([-10, 0, 24, 25, 50, 100, 120])('uses the clamped experience try budget for %s', experience => {
    const f = fixture(); f.body.hungUp = true; f.team.experience = experience;
    const max = 1 + Math.floor(Math.max(0, Math.min(100, experience)) / 25);
    const next = vi.spyOn(f.rng, 'next').mockReturnValue(0.5);
    const before = { ...f.body };
    expect(hullRecoveryDrive(f.v, experience)).toEqual({ speedMs: -1, yawRateRadS: 0, brake: false });
    expect(f.body).toEqual(before); expect(next).not.toHaveBeenCalled();
    f.body.rockPhaseS = 0.749;
    expect(hullRecoveryDrive(f.v, experience)?.speedMs).toBe(-1);
    f.body.rockPhaseS = 0.75;
    expect(hullRecoveryDrive(f.v, experience)?.speedMs).toBe(1);
    f.body.rockPhaseS = 0;
    tick(f, max * 15);
    expect(f.body.rockTries).toBe(max); expect(next).toHaveBeenCalledTimes(max);
    expect(hullRecoveryDrive(f.v, experience)).toEqual(stop);
    tick(f, 30); expect(next).toHaveBeenCalledTimes(max);
  });
  it('draws a side only upon track loss and uses existing immobilization', () => {
    const f = fixture(); f.body.hungUp = true; f.body.rockPhaseS = 1.4;
    const next = vi.spyOn(f.rng, 'next').mockReturnValueOnce(0.01).mockReturnValueOnce(0.8);
    tick(f);
    expect(next).toHaveBeenCalledTimes(2); expect(f.v.damage?.trackR).toBe('destroyed');
    expect(isImmobile(f.v)).toBe(true); expect(f.v.state).toBe('immobilized');
    tick(f, 50); expect(next).toHaveBeenCalledTimes(2);
  });
  it('clears recovery state when support is regained and starts creation with clear flags', () => {
    const f = fixture(); expect(f.body.hungUp).toBe(false); expect(f.body.hungS).toBe(0);
    f.body.hungUp = true; f.body.hungS = 1; f.body.rockTries = 1; f.body.rockPhaseS = 0.5;
    stepHullBody(f.body, VEHICLE_DEFS[f.v.defId], stop, flat, 0.1); tick(f);
    expect(f.body.hungUp).toBe(false); expect(f.body.hungS).toBe(0);
    expect(f.body.rockTries).toBe(0); expect(f.body.rockPhaseS).toBe(0);
  });
});

it('production starts powered recovery after the threshold tick and overrides route requests', () => {
  const f = fixture('t34_76'), def = VEHICLE_DEFS[f.v.defId], p = hullParams(def);
  const ridge: HullGroundProbe = x => ({ heightM: Math.abs(x - f.body.position.x) < 0.1 ? 2 : 0,
    normal: { x: 0, y: 0, z: 1 } });
  f.body.position.z = 2 - p.solidBox.min.z + 1e-9;
  f.body.hungS = 0.4;
  requestHullDrive(f.v, { speedMs: 99, yawRateRadS: 88, brake: false });
  const step = hullPhysics.stepHullBody, drives: number[] = [];
  const spy = vi.spyOn(hullPhysics, 'stepHullBody').mockImplementation((body, def, drive, _probe, dt, going, accept) => {
    drives.push(drive.speedMs); step(body, def, drive, ridge, dt, going, accept);
  });
  try {
    stepVehicles(f.state, f.rng, 0.1);
    expect(f.body.hungUp).toBe(true); expect(f.body.rockPhaseS).toBe(0);
    f.v.path = [{ x: 20, y: 10 }];
    stepVehicles(f.state, f.rng, 0.1);
    expect(drives).toEqual([0, -1]); expect(f.body.rockPhaseS).toBeCloseTo(0.1, 12);
    expect(f.body.rockTries).toBe(0);
  } finally { spy.mockRestore(); }
});

it('does not advance a powered cycle without its tick-local application flag or a driver', () => {
  const f = fixture(); f.body.hungUp = true; f.body.rockPhaseS = 1.4;
  const after = f.rng.state();
  stepHullGameplay(f.state, f.rng, f.v, 0.1);
  expect(f.body.rockPhaseS).toBe(1.4); expect(f.rng.state()).toBe(after);
  for (const s of f.crew) s.health = 'incapacitated';
  stepHullGameplay(f.state, f.rng, f.v, 0.1, true);
  expect(f.body.rockPhaseS).toBe(1.4); expect(f.rng.state()).toBe(after);
  const p = hullParams(VEHICLE_DEFS[f.v.defId]), centre = { ...f.body.position };
  f.body.position.z = 2 - p.solidBox.min.z + 1e-9; f.body.hungS = 0.5;
  const ridge: HullGroundProbe = x => ({ heightM: Math.abs(x - centre.x) < 0.1 ? 2 : 0,
    normal: { x: 0, y: 0, z: 1 } });
  const original = hullPhysics.stepHullBody;
  const spy = vi.spyOn(hullPhysics, 'stepHullBody').mockImplementation((body, def, drive, probe, dt, going, accept) => {
    expect(drive).toEqual(stop); original(body, def, drive, ridge, dt, going, accept);
  });
  try { stepVehicles(f.state, f.rng, 0.1); } finally { spy.mockRestore(); }
  expect(f.body.rockTries).toBe(0); expect(f.body.rockPhaseS).toBe(1.4);
  expect(f.rng.state()).toBe(after); expect(takeHullDrive(f.v)).toEqual(stop);
});

it.each([2, 3, 4])('uses positive regular driven loads on a belly ridge (%s of 12)', count => {
  const f = fixture('t34_76'), def = VEHICLE_DEFS[f.v.defId], p = hullParams(def);
  f.body.position.z = 2 - p.solidBox.min.z + 1e-9;
  f.body.hungS = 0.4;
  const supports = p.contacts.filter(c => c.driven && !c.horn);
  const selected = count === 2 ? [supports[2], supports[8]]
    : count === 3 ? [supports[0], supports[5], supports[8]] : [supports[0], supports[5], supports[6], supports[11]];
  const centre = { ...f.body.position };
  const trackHeight = centre.z + supports[0].local.z + 0.01;
  const ridge: HullGroundProbe = (x, y) => ({ heightM: Math.abs(x - centre.x) < 0.1 ? 2
    : selected.some(c => Math.abs(x - centre.x - c.local.x) < 0.2 && Math.abs(y - centre.y - c.local.y) < 0.2)
      ? trackHeight : 0, normal: { x: 0, y: 0, z: 1 } });
  stepHullBody(f.body, def, stop, ridge, 0.1);
  expect(f.body.hungUp).toBe(count === 2);
});

// These fixtures exercise actual impulses/integration on a narrow ridge. The
// captured last-substep geometry distinguishes horizontal rotation error from Z
// alone, and a separating rotation from support; no stored contact cache is used.
function slopedRidge(sx: number, sy: number, angle: number, omega: Vec3, height: number, radius: number) {
  const f = fixture('t34_76'), def = VEHICLE_DEFS[f.v.defId], p = hullParams(def);
  const local = { x: 0, y: 0, z: p.solidBox.min.z };
  f.body.orientation = { x: dm.sin(angle / 2), y: 0, z: 0, w: dm.cos(angle / 2) };
  const initial = rotate(f.body.orientation, local), cx = f.body.position.x + initial.x, cy = f.body.position.y + initial.y;
  f.body.position.z = height - initial.z + 1e-9; f.body.hungS = 0.4;
  f.body.angularVelocity = { ...omega };
  const length = Math.sqrt(1 + sx * sx + sy * sy), normal = { x: -sx / length, y: -sy / length, z: 1 / length };
  const probe: HullGroundProbe = (x, y) => ({ heightM: Math.abs(x - cx) < radius && Math.abs(y - cy) < radius
    ? height + sx * (x - cx) + sy * (y - cy) : 0, normal });
  let oldOffset = initial, lastOmega = omega;
  stepHullBody(f.body, def, stop, probe, 0.1, 1, () => {
    oldOffset = rotate(f.body.orientation, local); lastOmega = { ...f.body.angularVelocity }; return true;
  });
  const finalOffset = rotate(f.body.orientation, local), angularStep = cross(lastOmega, oldOffset);
  const residual = { x: finalOffset.x - oldOffset.x - 0.01 * angularStep.x,
    y: finalOffset.y - oldOffset.y - 0.01 * angularStep.y, z: finalOffset.z - oldOffset.z - 0.01 * angularStep.z };
  const point = { x: f.body.position.x + finalOffset.x, y: f.body.position.y + finalOffset.y,
    z: f.body.position.z + finalOffset.z };
  return { f, gap: point.z - probe(point.x, point.y).heightM, residual, normal };
}

it('retains sloped belly support when horizontal rotation residual contributes to separation', () => {
  const r = slopedRidge(-2, -2, 0, { x: -3, y: -1, z: 0 }, 2, 0.2);
  // Final separation exceeds the complete Z residual: a Z-only check loses a
  // genuine impulse-supported point on this slope.
  expect(r.gap).toBeGreaterThan(Math.abs(r.residual.z) + 2e-9);
  expect(r.gap).toBeLessThan(0.0005);
  expect(r.f.body.hungUp).toBe(true);
});

it('does not retain a separating belly point with an inward normal residual', () => {
  const r = slopedRidge(-0.6, 0, -1.3, { x: 1.8, y: 0.3, z: 6 }, 10, 0.6);
  expect(dot(r.residual, r.normal)).toBeLessThan(0);
  expect(r.gap).toBeGreaterThan(0.0002);
  expect(r.gap).toBeLessThan(Math.abs(r.residual.z));
  expect(r.f.body.hungUp).toBe(false); expect(r.f.body.hungS).toBe(0);
});

it.each([false, true])('classifies accepted ridge support after translation rejection=%s', rejected => {
  const f = fixture('t34_76'), def = VEHICLE_DEFS[f.v.defId], p = hullParams(def);
  const x = f.body.position.x;
  const ridge: HullGroundProbe = px => ({ heightM: Math.abs(px - x) < 0.1 ? 2 : 0,
    normal: { x: 0, y: 0, z: 1 } });
  f.body.position.z = 2 - p.solidBox.min.z + 1e-9; f.body.hungS = 0.4;
  f.body.velocity.x = 5;
  stepHullBody(f.body, def, stop, ridge, 0.1, 1, () => !rejected);
  if (rejected) {
    expect(f.body.position.x).toBe(x); expect(f.body.hungUp).toBe(true);
  } else {
    expect(f.body.position.x).toBeGreaterThan(x + 0.1);
    expect(f.body.hungUp).toBe(false); expect(f.body.hungS).toBe(0);
  }
});
