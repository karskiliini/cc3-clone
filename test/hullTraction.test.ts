import { expect, it } from 'vitest';
import * as physics from '@/sim/hullPhysics';
import { stepHullBody } from '@/sim/hullPhysics';
import { add, cross, dot, rotate, yawQuat } from '@/sim/hullMath';
import type { HullDrive, HullGroundProbe } from '@/shared/types';
import { flat, stop, rig } from './hullPhysicsHelpers';
import { makeState } from './vehicleDamageHelpers';
import { buildHeightField } from '@/sim/heightField';
import { groundProbe, groundVersion } from '@/sim/hullGround';

const drive = (speedMs = 4, yawRateRadS = 0): HullDrive => ({ speedMs, yawRateRadS, brake: false });
const plane = (slope: number): HullGroundProbe => (x) => ({ heightM: slope * x,
  normal: { x: -slope / Math.sqrt(1 + slope * slope), y: 0, z: 1 / Math.sqrt(1 + slope * slope) } });

it('cannot drive without loaded contacts', () => {
  const r = rig(); r.body.position.z = 100;
  for (let i = 0; i < 5; i++) r.step(drive());
  expect(r.body.velocity.x).toBe(0); expect(r.body.velocity.y).toBe(0);
});

it('solid belly support supplies no drive when suspension is unloaded', () => {
  const mound: HullGroundProbe = (x, y) => ({ heightM: Math.abs(x - 20) < 0.1 && Math.abs(y - 20) < 0.1 ? 0.8 : 0,
    normal: { x: 0, y: 0, z: 1 } });
  const r = rig('t34_76', mound);
  for (let i = 0; i < 20; i++) r.step();
  for (let i = 0; i < 10; i++) r.step(drive());
  expect(r.body.suspensionTravel.every(c => c === 0)).toBe(true);
  expect(r.body.position.x).toBe(20); expect(r.body.position.y).toBe(20);
});

it.each([0, Math.PI / 2])('loaded tracks accelerate forward at heading %s', heading => {
  const r = rig(); r.body.orientation = yawQuat(heading);
  for (let i = 0; i < 20; i++) r.step(drive());
  const forward = rotate(yawQuat(heading), { x: 0, y: -1, z: 0 });
  expect(dot(r.body.velocity, forward)).toBeGreaterThan(3.5);
  expect(dot(r.body.velocity, forward)).toBeLessThan(4.05);
});

it.each([0, Math.PI / 2])('tracked pivot turns right through opposite track velocities at heading %s', heading => {
  const r = rig(); r.body.orientation = yawQuat(heading);
  for (let i = 0; i < 10; i++) r.step(drive(0, 1));
  expect(r.body.angularVelocity.z).toBeGreaterThan(0.1);
  const forward = rotate(r.body.orientation, { x: 0, y: -1, z: 0 });
  const left = rotate(r.body.orientation, { x: -1, y: 0, z: 0 });
  const right = rotate(r.body.orientation, { x: 1, y: 0, z: 0 });
  expect(dot(add(r.body.velocity, cross(r.body.angularVelocity, left)), forward)).toBeGreaterThan(0.1);
  expect(dot(add(r.body.velocity, cross(r.body.angularVelocity, right)), forward)).toBeLessThan(-0.1);
});

it.each(['kubelwagen', 'sdkfz251', 'kettenkrad'])('%s cannot pivot at rest', id => {
  const r = rig(id);
  for (let i = 0; i < 20; i++) r.step(drive(0, 1));
  expect(Math.abs(r.body.angularVelocity.z)).toBeLessThan(0.001);
});

it.each(['t34_76', 'kubelwagen', 'sdkfz251', 'kettenkrad'].flatMap(id =>
  [0, Math.PI / 2].flatMap(heading => [-3, 3].map(speed => ({ id, heading, speed })))))
  ('$id keeps requested right yaw at speed $speed and heading $heading', ({ id, heading, speed }) => {
  const r = rig(id); r.body.orientation = yawQuat(heading);
  for (let i = 0; i < 30; i++) r.step(drive(speed, 0.3));
  const forward = rotate(r.body.orientation, { x: 0, y: -1, z: 0 });
  expect(dot(r.body.velocity, forward) * (speed < 0 ? -1 : 1)).toBeGreaterThan(1);
  expect(r.body.angularVelocity.z).toBeGreaterThan(0.05);
});

it('wheels respect the existing minimum turn radius under an excessive yaw request', () => {
  const r = rig('kubelwagen');
  for (let i = 0; i < 40; i++) r.step(drive(3, 100));
  const speed = Math.sqrt(r.body.velocity.x * r.body.velocity.x + r.body.velocity.y * r.body.velocity.y);
  expect(r.body.angularVelocity.z).toBeGreaterThan(0.05);
  expect(speed / r.body.angularVelocity.z).toBeGreaterThan(3.2); // Catalog radius is 4 m; allow transient tyre slip.
});

it('brakes through contacts without instantly replacing velocity', () => {
  const r = rig(); r.body.velocity.y = -4;
  r.step({ speedMs: 20, yawRateRadS: 1, brake: true });
  expect(-r.body.velocity.y).toBeGreaterThan(2.5);
  expect(-r.body.velocity.y).toBeLessThan(3.5);
  expect(Math.abs(r.body.angularVelocity.z)).toBeLessThan(0.001);
  for (let i = 0; i < 30; i++) r.step();
  expect(Math.abs(r.body.velocity.y)).toBeLessThan(0.005);
});

it('going reduces traction and zero going leaves slope gravity intact', () => {
  const a = rig(), b = rig(), c = rig();
  stepHullBody(a.body, a.def, drive(100), flat, 0.1, 1);
  stepHullBody(b.body, b.def, drive(100), flat, 0.1, 0.1);
  stepHullBody(c.body, c.def, drive(100), flat, 0.1, 0);
  expect(-a.body.velocity.y).toBeGreaterThan(0.5);
  expect(-a.body.velocity.y).toBeLessThan(0.9);
  expect(-b.body.velocity.y).toBeLessThan(-a.body.velocity.y * 0.2);
  expect(c.body.velocity.y).toBe(0);
  const slope = plane(0.2), r = rig('t34_76', slope);
  stepHullBody(r.body, r.def, stop, slope, 0.1, 0);
  expect(r.body.velocity.x).toBeLessThan(-0.1);
});

it('static friction holds a modest slope while insufficient friction permits downhill slide', () => {
  const slope = plane(0.2), held = rig('t34_76', slope), slide = rig('t34_76', slope);
  for (let i = 0; i < 30; i++) {
    stepHullBody(held.body, held.def, stop, slope, 0.1, 1);
    stepHullBody(slide.body, slide.def, stop, slope, 0.1, 0.1);
  }
  expect(Math.abs(held.body.position.x - 20)).toBeLessThan(0.02);
  expect(Math.abs(held.body.velocity.x)).toBeLessThan(0.005);
  expect(slide.body.position.x).toBeLessThan(19);
  expect(slide.body.velocity.x).toBeLessThan(-0.5);
});

it('combined drive and lateral slip share a bounded friction circle', () => {
  const straight = rig(), combined = rig(); combined.body.velocity.x = 100;
  stepHullBody(straight.body, straight.def, drive(100), flat, 0.1);
  stepHullBody(combined.body, combined.def, drive(100), flat, 0.1);
  const dvx = combined.body.velocity.x - 100, dvy = combined.body.velocity.y;
  expect(dvx).toBeLessThan(-0.1); expect(dvy).toBeLessThan(-0.1);
  expect(Math.sqrt(dvx * dvx + dvy * dvy)).toBeLessThan(0.9);
  expect(-combined.body.velocity.y).toBeLessThan(-straight.body.velocity.y * 0.85);
});

it('sleeps only after half a second of stable level zero-input support', () => {
  const r = rig();
  for (let i = 0; i < 4; i++) r.step();
  expect(r.body.asleep).toBe(false);
  for (let i = 0; i < 40 && !r.body.asleep; i++) r.step();
  expect(r.body.asleep).toBe(true);
  expect(r.body.quietS).toBeGreaterThanOrEqual(0.5);
  const before = structuredClone(r.body);
  for (let i = 0; i < 10; i++) r.step();
  expect(r.body).toEqual(before);
});

it('nonzero drive input wakes a sleeping body and drives it in the same tick', () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.step();
  expect(r.body.asleep).toBe(true);
  r.step(drive());
  expect(r.body.asleep).toBe(false); expect(r.body.quietS).toBe(0);
  expect(r.body.velocity.y).toBeLessThan(-0.1);
});

it('an impulse wakes actual sleep and retains airborne velocity without world damping', () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.step();
  expect(r.body.asleep).toBe(true);
  physics.applyHullImpulse(r.body, { x: 26000, y: 0, z: 0 }, r.body.position, r.def);
  expect(r.body.asleep).toBe(false); expect(r.body.quietS).toBe(0);
  r.body.position.z += 100;
  r.step();
  expect(r.body.velocity.x).toBe(1);
});

it('same revision retains sleep exactly while a changed ground revision wakes before stepping', () => {
  let heightM = 0;
  const probe: HullGroundProbe = () => ({ heightM, normal: { x: 0, y: 0, z: 1 } });
  const r = rig('t34_76', probe);
  for (let i = 0; i < 40; i++) r.step();
  expect(r.body.asleep).toBe(true);
  physics.syncHullGroundVersion(r.body, 1); // First revision binding is also a wake.
  for (let i = 0; i < 40; i++) r.step();
  expect(r.body.asleep).toBe(true);
  const before = structuredClone(r.body);
  physics.syncHullGroundVersion(r.body, 1); r.step();
  expect(r.body).toEqual(before);
  heightM = 0.2;
  physics.syncHullGroundVersion(r.body, 2);
  expect(r.body.asleep).toBe(false); expect(r.body.quietS).toBe(0);
  expect(r.body.groundVersion).toBe(2);
  r.step(); expect(r.body.position.z).toBeGreaterThan(before.position.z + 0.01);
});

it('explicit wake resets the canonical quiet timer', () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.step();
  expect(r.body.asleep).toBe(true);
  physics.wakeHull(r.body);
  expect(r.body.asleep).toBe(false); expect(r.body.quietS).toBe(0);
});

it('does not sleep on a supported slope beyond the two-degree level gate', () => {
  const r = rig('t34_76', plane(0.1));
  for (let i = 0; i < 40; i++) r.step();
  expect(Math.abs(r.body.velocity.x)).toBeLessThan(0.005);
  expect(r.body.asleep).toBe(false); expect(r.body.quietS).toBe(0);
});

it('does not accumulate quiet time with active drive or unsettled airborne support', () => {
  const active = rig(), airborne = rig(); airborne.body.position.z += 100;
  for (let i = 0; i < 10; i++) { active.step(drive(0, 1)); airborne.step(); }
  expect(active.body.asleep).toBe(false); expect(active.body.quietS).toBe(0);
  expect(airborne.body.asleep).toBe(false); expect(airborne.body.quietS).toBe(0);
});

it('a zero impulse preserves an asleep body exactly', () => {
  const r = rig(); r.body.asleep = true; r.body.quietS = 0.5;
  const before = structuredClone(r.body);
  physics.applyHullImpulse(r.body, { x: 0, y: 0, z: 0 }, r.body.position, r.def);
  expect(r.body).toEqual(before);
});

it('compressed contacts with zero normal force cannot accelerate a separating hull', () => {
  const r = rig(); r.body.velocity.z = 50;
  r.step(drive(4, 1));
  expect(r.body.velocity.x).toBe(0); expect(r.body.velocity.y).toBe(0);
  expect(r.body.angularVelocity.z).toBe(0);
  expect(r.body.velocity.z).toBeCloseTo(49.019, 10);
});

it('tracks approach the independently predicted passive-friction yaw gain', () => {
  // T34 supports: 12 points at x=±1.26m and y=±2.412,±1.4472,±0.4824m.
  // Equal longitudinal/lateral gains give steady yaw/request=Σx²/(Σx²+Σy²).
  // This checks observed unsaturated response; it does not call contact builders.
  const predictedGain = 0.368990723;
  for (const yawRate of [-0.3, 0.3]) {
    const responses: number[] = [];
    for (const heading of [0, Math.PI / 2]) for (const speed of [-3, 3]) {
      const r = rig(); r.body.orientation = yawQuat(heading);
      for (let i = 0; i < 50; i++) r.step(drive(speed, yawRate));
      const response = r.body.angularVelocity.z;
      expect(Math.abs(response / yawRate / predictedGain - 1)).toBeLessThan(0.1);
      responses.push(response);
    }
    expect(Math.max(...responses) - Math.min(...responses)).toBeLessThan(0.002);
  }
});

it.each(['pending crater marks', 'rebuilt field'])('wakes actual sleep after %s advances the synchronized map revision', change => {
  const map = makeState().map, probe = groundProbe(map), r = rig('t34_76', probe);
  physics.syncHullGroundVersion(r.body, groundVersion(map));
  for (let i = 0; i < 40; i++) r.step();
  expect(r.body.asleep).toBe(true);
  const before = structuredClone(r.body);
  physics.syncHullGroundVersion(r.body, groundVersion(map)); r.step();
  expect(r.body).toEqual(before);
  if (change === 'pending crater marks') map.craterMarks = [{ x: 10, y: 10, sizeM: 5, kind: 'shell' }];
  else map.heightField = buildHeightField(map);
  physics.syncHullGroundVersion(r.body, groundVersion(map));
  expect(r.body.asleep).toBe(false); expect(r.body.quietS).toBe(0);
  expect(r.body.groundVersion).toBeGreaterThan(before.groundVersion);
  r.step();
  expect(r.body.asleep).toBe(false);
  if (change === 'pending crater marks') expect(r.body.position.z).toBeLessThan(before.position.z - 0.01);
});
