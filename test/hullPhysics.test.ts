import { expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { createHullBody, stepHullBody, applyHullImpulse } from '@/sim/hullPhysics';
import { dot, rotate, yawQuat, hullAngles } from '@/sim/hullMath';
import type { HullGroundProbe } from '@/shared/types';
import { flat, stop, rig, kineticEnergy } from './hullPhysicsHelpers';

it('settles within two seconds and remains bounded for ten minutes', () => {
  const r = rig(); r.body.position.z += 0.1;
  const energyLimit = hullParams(r.def).massKg * 9.81 * 0.1 * 1.05;
  let maxEnergy = 0, maxQuatError = 0;
  for (let i = 0; i < 20; i++) {
    r.step(); maxEnergy = Math.max(maxEnergy, kineticEnergy(r.body, r.def));
  }
  expect(Math.abs(r.body.velocity.z)).toBeLessThan(0.02);
  const z = r.body.position.z;
  for (let i = 0; i < 6000; i++) {
    r.step(); maxEnergy = Math.max(maxEnergy, kineticEnergy(r.body, r.def));
    const q = r.body.orientation;
    maxQuatError = Math.max(maxQuatError, Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1));
  }
  expect(Math.abs(r.body.position.z - z)).toBeLessThan(0.01);
  expect(Math.abs(r.body.position.x - 20)).toBeLessThan(0.001);
  expect(Math.abs(r.body.position.y - 20)).toBeLessThan(0.001);
  expect(maxEnergy).toBeLessThan(energyLimit);
  expect(maxQuatError).toBeLessThan(1e-12);
  console.info('T34 600s:', { maxEnergy, energyLimit, maxQuatError, zDrift: r.body.position.z - z, finalVz: r.body.velocity.z });
});

it.each(['t34_76', 'sdkfz251', 'kettenkrad', 'bm13'])('%s initializes the CG on the sampled plane while retaining the requested heading', id => {
  const def = VEHICLE_DEFS[id], p = hullParams(def), heading = 0.7;
  const normal = { x: -0.1 / Math.sqrt(1.0125), y: 0.05 / Math.sqrt(1.0125), z: 1 / Math.sqrt(1.0125) };
  const slope: HullGroundProbe = (x, y) => ({ heightM: 0.1 * x - 0.05 * y + 3, normal });
  const body = createHullBody(def, { x: 10, y: 10 }, heading, slope);
  expect(body.position.x).toBe(20); expect(body.position.y).toBe(20);
  expect(body.position.z).toBeCloseTo(4 + p.cgHeightM, 12);
  expect(dot(rotate(body.orientation, { x: 0, y: 0, z: 1 }), normal)).toBeCloseTo(1, 10);
  expect(hullAngles(body.orientation).heading).toBeCloseTo(heading, 12);
  expect(body.suspensionTravel).toHaveLength(p.contacts.length);
  expect(body.groundVersion).toBe(0);
});

it('uses ten substeps and rejects other production dt values', () => {
  let calls = 0;
  const probe: HullGroundProbe = () => { calls++; return flat(0, 0); };
  const r = rig('t34_76', probe); calls = 0;
  r.step();
  expect(calls).toBe(10 * (hullParams(r.def).contacts.length + 18));
  expect(() => stepHullBody(r.body, r.def, stop, probe, 0.01)).toThrow(/dt|SIM_DT/);
});

it('applies gravity without tensile suspension or above-ground damping', () => {
  const r = rig(); r.body.position.z += 20;
  r.body.velocity.z = -1;
  r.step();
  expect(r.body.velocity.z).toBeCloseTo(-1.981, 12);
  expect(r.body.suspensionTravel.every(c => c === 0)).toBe(true);
});

it('keeps full-travel suspension bounded with bump stops before belly support', () => {
  const r = rig(), p = hullParams(r.def); r.body.position.z -= 0.3;
  let calls = 0, firstSubstepVz = 0;
  const probe: HullGroundProbe = () => {
    if (calls++ === p.contacts.length + 18) firstSubstepVz = r.body.velocity.z;
    return flat(0, 0);
  };
  stepHullBody(r.body, r.def, stop, probe, 0.1);
  // The clamped ordinary spring alone gives only ~0.248 m/s after 10 ms;
  // the additional 10x bump stiffness gives ~1.43 m/s before belly contact.
  expect(firstSubstepVz).toBeGreaterThan(1);
  expect(r.body.suspensionTravel.every(c => c >= 0 && c <= hullParams(r.def).suspension.travelM)).toBe(true);
  expect(r.body.velocity.z).toBeGreaterThan(0);
});

it('supports an upside-down hull on its solid roof', () => {
  const r = rig(), p = hullParams(r.def);
  r.body.orientation = { x: 1, y: 0, z: 0, w: 0 };
  r.body.position.z = p.solidBox.max.z + 0.5;
  for (let i = 0; i < 100; i++) r.step();
  const roof = r.body.position.z + rotate(r.body.orientation, p.solidBox.max).z;
  expect(roof).toBeGreaterThanOrEqual(-1e-5);
  expect(Math.abs(r.body.velocity.z)).toBeLessThan(0.02);
  expect(rotate(r.body.orientation, { x: 0, y: 0, z: 1 }).z).toBeLessThan(-0.99);
  console.info('roof 10s:', { roof, vz: r.body.velocity.z });
});

it('applies an impulse at a world point using body-frame inertia and wakes the body', () => {
  const r = rig(), p = hullParams(r.def);
  r.body.orientation = yawQuat(Math.PI / 2); r.body.asleep = true; r.body.quietS = 3;
  applyHullImpulse(r.body, { x: 0, y: 0, z: p.massKg }, { x: r.body.position.x + 1, y: r.body.position.y, z: r.body.position.z }, r.def);
  expect(r.body.velocity).toEqual({ x: 0, y: 0, z: 1 });
  expect(r.body.angularVelocity.y).toBeCloseTo(-p.massKg / p.inertia.x, 12);
  expect(r.body.angularVelocity.x).toBeCloseTo(0, 12);
  expect(r.body.asleep).toBe(false); expect(r.body.quietS).toBe(0);
});

it('includes gyroscopic torque so a freely rotating asymmetric hull conserves world momentum', () => {
  const r = rig('t34_76', () => ({ heightM: -1000, normal: { x: 0, y: 0, z: 1 } }));
  r.body.position.z += 100;
  r.body.orientation = yawQuat(0.7); r.body.angularVelocity = { x: 0.3, y: 0.5, z: 0.7 };
  const p = hullParams(r.def), initialQ = r.body.orientation;
  const worldL = (q = r.body.orientation, w = r.body.angularVelocity) => {
    const conjugate = { x: -q.x, y: -q.y, z: -q.z, w: q.w }, local = rotate(conjugate, w);
    return rotate(q, { x: p.inertia.x * local.x, y: p.inertia.y * local.y, z: p.inertia.z * local.z });
  };
  const initialL = worldL(initialQ), initialRotEnergy = kineticEnergy(r.body, r.def);
  r.step(); const finalL = worldL();
  expect(r.body.angularVelocity).not.toEqual({ x: 0.3, y: 0.5, z: 0.7 });
  for (const axis of ['x', 'y', 'z'] as const)
    expect(Math.abs(finalL[axis] - initialL[axis])).toBeLessThan(Math.abs(initialL[axis]) * 0.001);
  const finalRotEnergy = kineticEnergy(r.body, r.def) - 0.5 * p.massKg * dot(r.body.velocity, r.body.velocity);
  expect(Math.abs(finalRotEnergy / initialRotEnergy - 1)).toBeLessThan(0.001);
  console.info('free rotation 0.1s:', {
    relativeMomentumError: { x: finalL.x / initialL.x - 1, y: finalL.y / initialL.y - 1, z: finalL.z / initialL.z - 1 },
    relativeRotEnergyError: finalRotEnergy / initialRotEnergy - 1,
  });
});

// Isotropic inertia leaves omega constant: the world-X rotation must precede yaw.
it('updates the quaternion from world angular velocity by left multiplication', () => {
  const def = { ...VEHICLE_DEFS.t34_76, widthM: 2, lengthM: 2, hullHeightM: 2 };
  const body = createHullBody(def, { x: 10, y: 10 }, 0.7, flat);
  body.position.z += 100; body.angularVelocity = { x: 1, y: 0, z: 0 };
  stepHullBody(body, def, stop, flat, 0.1);
  const right = rotate(body.orientation, { x: 1, y: 0, z: 0 });
  expect(right.x).toBeCloseTo(Math.cos(0.7), 8);
  expect(right.y).toBeCloseTo(Math.sin(0.7) * Math.cos(0.1), 5);
  expect(right.z).toBeCloseTo(Math.sin(0.7) * Math.sin(0.1), 5);
});

it('retains quaternion sign continuously through a full revolution', () => {
  const r = rig(); r.body.position.z += 1000; r.body.angularVelocity = { x: 0, y: 0, z: 1 };
  for (let i = 0; i < 70; i++) r.step();
  expect(r.body.orientation.w).toBeLessThan(0);
});

it('projects suspension compression along the sample normal', () => {
  const r = rig(), p = hullParams(r.def), normal = { x: 0.6, y: 0, z: 0.8 };
  let calls = 0;
  const probe: HullGroundProbe = () => {
    const i = calls++ % (p.contacts.length + 18);
    // Prescribe 5 cm vertical penetration at every suspension sample while
    // keeping solid supports far below the body. Normal compression is 4 cm.
    const heightM = i < p.contacts.length
      ? r.body.position.z + rotate(r.body.orientation, p.contacts[i].local).z + 0.05 : -1000;
    return { heightM, normal };
  };
  stepHullBody(r.body, r.def, stop, probe, 0.1);
  for (const compression of r.body.suspensionTravel) expect(compression).toBeCloseTo(0.04, 12);
});

it('supports a side-down wreck without using suspension as roof or side support', () => {
  const r = rig(), p = hullParams(r.def), half = Math.sqrt(0.5);
  r.body.orientation = { x: 0, y: half, z: 0, w: half };
  r.body.position.z = p.widthM / 2 + 0.5;
  for (let i = 0; i < 100; i++) r.step();
  let lowest = Infinity;
  for (const x of [p.solidBox.min.x, p.solidBox.max.x])
    for (const y of [p.solidBox.min.y, p.solidBox.max.y])
      for (const z of [p.solidBox.min.z, p.solidBox.max.z])
        lowest = Math.min(lowest, r.body.position.z + rotate(r.body.orientation, { x, y, z }).z);
  expect(lowest).toBeGreaterThanOrEqual(-1e-5);
  expect(dot(r.body.velocity, r.body.velocity)).toBeLessThan(0.0004);
  expect(r.body.suspensionTravel.every(c => c === 0)).toBe(true);
  console.info('side 10s:', { lowest, speed: Math.sqrt(dot(r.body.velocity, r.body.velocity)) });
});

it('supports a hung-up belly on the bottom-centre probe with all suspension unloaded', () => {
  const mound: HullGroundProbe = (x, y) => ({ heightM: Math.abs(x - 20) < 0.1 && Math.abs(y - 20) < 0.1 ? 0.8 : 0,
    normal: { x: 0, y: 0, z: 1 } });
  const r = rig('t34_76', mound), p = hullParams(r.def);
  for (let i = 0; i < 20; i++) r.step();
  expect(r.body.position.z + p.solidBox.min.z).toBeCloseTo(0.8, 8);
  expect(r.body.suspensionTravel.every(c => c === 0)).toBe(true);
  expect(r.body.velocity.z).toBeCloseTo(0, 12);
});

it('dissipates kinetic energy in a zero-restitution roof impact and stays bounded for ten minutes', () => {
  const r = rig(), p = hullParams(r.def);
  r.body.orientation = { x: 1, y: 0, z: 0, w: 0 };
  r.body.position.z = p.solidBox.max.z + 1e-9;
  r.body.velocity = { x: 2, y: -1, z: -3 };
  const initialEnergy = kineticEnergy(r.body, r.def);
  r.step();
  expect(kineticEnergy(r.body, r.def)).toBeLessThan(initialEnergy * 0.6);
  // Frictionless supports preserve tangential motion; they supply no traction.
  expect(r.body.velocity.x).toBe(2); expect(r.body.velocity.y).toBe(-1);
  let maxEnergy = 0, maxQuatError = 0;
  for (let i = 0; i < 6000; i++) {
    r.step(); maxEnergy = Math.max(maxEnergy, kineticEnergy(r.body, r.def));
    const q = r.body.orientation;
    maxQuatError = Math.max(maxQuatError, Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1));
  }
  expect(maxEnergy).toBeLessThan(initialEnergy);
  expect(maxQuatError).toBeLessThan(1e-12);
  console.info('roof impact 600s:', { initialEnergy, maxEnergy, maxQuatError, vz: r.body.velocity.z });
});

it('produces identical float state for identical synthetic ground and impulse histories', () => {
  const a = rig(), b = rig();
  for (const r of [a, b]) {
    applyHullImpulse(r.body, { x: 100, y: -200, z: 5000 }, { x: 21, y: 19, z: 21 }, r.def);
    for (let i = 0; i < 100; i++) r.step();
  }
  expect(a.body).toEqual(b.body);
});

it.each(['kv1', 'sdkfz251', 'kubelwagen'])('%s settles without flat-ground creep', id => {
  const r = rig(id); r.body.position.z += 0.1;
  const spawn = { ...r.body.position };
  let maxInitialXY = 0, maxInitialPitch = 0, maxInitialEnergy = 0;
  for (let i = 0; i < 20; i++) {
    r.step();
    if (id === 'sdkfz251') {
      const dx = r.body.position.x - spawn.x, dy = r.body.position.y - spawn.y;
      maxInitialXY = Math.max(maxInitialXY, Math.sqrt(dx * dx + dy * dy));
      maxInitialPitch = Math.max(maxInitialPitch, Math.abs(hullAngles(r.body.orientation).pitch));
      maxInitialEnergy = Math.max(maxInitialEnergy, kineticEnergy(r.body, r.def));
    }
  }
  expect(Math.abs(r.body.velocity.z)).toBeLessThan(0.02);
  const { z } = r.body.position;
  if (id === 'sdkfz251') {
    // Observed maxima over the initial 20 ticks are 0.0603 m / 0.0437 rad /
    // 796 J. These ceilings allow 25–33% margin, not an unbounded exception.
    expect(maxInitialXY).toBeLessThan(0.08);
    expect(maxInitialPitch).toBeLessThan(0.055);
    expect(maxInitialEnergy).toBeLessThan(1000);
    // At 2 s: |pitch|=0.0394 rad and total KE=0.00158 J, including rotation.
    expect(Math.abs(hullAngles(r.body.orientation).pitch)).toBeLessThan(0.045);
    expect(kineticEnergy(r.body, r.def)).toBeLessThan(0.005);

    const checkSettledPhase = (ticks: number, energyCeiling: number) => {
      const position = { ...r.body.position }, angles = hullAngles(r.body.orientation);
      const drift = { x: 0, y: 0, z: 0 }, rotation = { heading: 0, pitch: 0, roll: 0 };
      let maxEnergy = 0;
      for (let i = 0; i < ticks; i++) {
        r.step();
        const current = hullAngles(r.body.orientation);
        for (const axis of ['x', 'y', 'z'] as const)
          drift[axis] = Math.max(drift[axis], Math.abs(r.body.position[axis] - position[axis]));
        for (const angle of ['heading', 'pitch', 'roll'] as const)
          rotation[angle] = Math.max(rotation[angle], Math.abs(current[angle] - angles[angle]));
        maxEnergy = Math.max(maxEnergy, kineticEnergy(r.body, r.def));
      }
      for (const axis of ['x', 'y', 'z'] as const) expect(drift[axis]).toBeLessThan(0.001);
      // The measured 2→22 s pitch change is 3.10e-5 rad. Sampling each tick
      // also catches an orientation excursion that returns at the checkpoint.
      for (const angle of ['heading', 'pitch', 'roll'] as const) expect(rotation[angle]).toBeLessThan(0.0001);
      expect(Math.abs(hullAngles(r.body.orientation).pitch)).toBeLessThan(0.045);
      expect(maxEnergy).toBeLessThan(energyCeiling);
      // 1e-6 J limits an 8 t body's residual motion to at most 16 µm/s
      // translation or roughly 1e-5 rad/s rotation, far below the quiet gate.
      expect(kineticEnergy(r.body, r.def)).toBeLessThan(1e-6);
    };
    checkSettledPhase(200, 0.005); // 2→22 s, still dissipating the tiny tail.
    checkSettledPhase(6000, 1e-6); // Another 600 s, with no continuing creep/rotation.
    expect(Math.sqrt(dot(r.body.velocity, r.body.velocity))).toBeLessThan(0.005);
  } else {
    for (let i = 0; i < 200; i++) r.step();
    expect(r.body.position.x).toBe(20); expect(r.body.position.y).toBe(20);
  }
  expect(Math.abs(r.body.position.z - z)).toBeLessThan(0.01);
  console.info(id + ' 22s:', { zDrift: r.body.position.z - z, finalVz: r.body.velocity.z });
});

it('never pulls a separating loaded suspension contact toward the ground', () => {
  const r = rig(); r.body.velocity.z = 50;
  r.step();
  expect(r.body.velocity.z).toBeCloseTo(49.019, 10);
});

it('checks complete normal-impulse translation, rejecting only XY before final support', () => {
  const slope = (x: number) => ({ heightM: 0.2 * x, normal: { x: -0.2 / Math.sqrt(1.04), y: 0, z: 1 / Math.sqrt(1.04) } });
  const r = rig('t34_76', slope);
  r.body.orientation = { x: 1, y: 0, z: 0, w: 0 };
  r.body.position.z = 4.2; r.body.velocity.z = -10;
  const before = { ...r.body.position }; let calls = 0, normalMovedXY = false;
  stepHullBody(r.body, r.def, stop, slope, 0.1, 1, (from, to) => {
    calls++;
    expect(to.x - from.x).toBeCloseTo(r.body.velocity.x * 0.01, 12);
    expect(to.y - from.y).toBeCloseTo(r.body.velocity.y * 0.01, 12);
    if (to.x !== from.x) normalMovedXY = true;
    return false;
  });
  expect(calls).toBe(10); expect(normalMovedXY).toBe(true);
  expect(r.body.position.x).toBe(before.x); expect(r.body.position.y).toBe(before.y);
  expect(r.body.velocity.x).toBe(0); expect(r.body.velocity.y).toBe(0);
  expect(r.body.orientation).not.toEqual({ x: 1, y: 0, z: 0, w: 0 });
  const p = hullParams(r.def);
  for (const x of [p.solidBox.min.x, p.solidBox.max.x]) for (const y of [p.solidBox.min.y, p.solidBox.max.y]) for (const z of [p.solidBox.min.z, p.solidBox.max.z]) {
    const offset = rotate(r.body.orientation, { x, y, z });
    expect(r.body.position.z + offset.z).toBeGreaterThanOrEqual(slope(r.body.position.x + offset.x).heightM - 1e-8);
  }
});
