import { expect, it } from 'vitest';
import { stepHullBody } from '@/sim/hullPhysics';
import { add, dot, rotate } from '@/sim/hullMath';
import type { HullGroundProbe } from '@/shared/types';
import { rig } from './hullPhysicsHelpers';

for (const axis of ['x', 'y'] as const) for (const grade of [-0.12, 0.12]) for (const speedMs of [-1, 1]) {
  it(`tracks follow signed speed ${speedMs} on ${axis} grade ${grade}`, () => {
    const length = Math.sqrt(1 + grade * grade);
    const normal = { x: axis === 'x' ? -grade / length : 0,
      y: axis === 'y' ? -grade / length : 0, z: 1 / length };
    const probe: HullGroundProbe = (x, y) => ({ heightM: (axis === 'x' ? x : y) * grade, normal });
    const r = rig('pz4gh', probe);
    for (let i = 0; i < 20; i++) r.step();
    for (let i = 0; i < 60; i++) r.step({ speedMs, yawRateRadS: 0, brake: false });
    const heading = rotate(r.body.orientation, { x: 0, y: -1, z: 0 });
    const projection = dot(heading, normal);
    const tangent = add(heading, { x: -normal.x * projection, y: -normal.y * projection, z: -normal.z * projection });
    const scale = 1 / Math.sqrt(dot(tangent, tangent));
    const forward = { x: tangent.x * scale, y: tangent.y * scale, z: tangent.z * scale };
    const along = dot(r.body.velocity, forward);
    const drift = { x: r.body.velocity.x - along * forward.x,
      y: r.body.velocity.y - along * forward.y, z: r.body.velocity.z - along * forward.z };
    expect(along).toBeCloseTo(speedMs, 1);
    expect(Math.sqrt(dot(drift, drift))).toBeLessThan(0.03);
  });
}
it('moving tracks still slide when the slope requires more friction than the ground supplies', () => {
  const grade = 0.12, length = Math.sqrt(1 + grade * grade);
  const normal = { x: -grade / length, y: 0, z: 1 / length };
  const probe: HullGroundProbe = x => ({ heightM: x * grade, normal });
  const r = rig('pz4gh', probe), initialX = r.body.position.x;
  for (let i = 0; i < 30; i++) stepHullBody(r.body, r.def, { speedMs: 1, yawRateRadS: 0, brake: false }, probe, 0.1, 0.01);
  expect(r.body.position.x).toBeLessThan(initialX - 1);
  expect(r.body.velocity.x).toBeLessThan(-0.5);
});
