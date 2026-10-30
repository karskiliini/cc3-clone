import { expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { deriveTrackedYawModel } from '@/sim/hullActuation';
import { createHullBody } from '@/sim/hullPhysics';
import { CONE_RAD, STANDSTILL_MS, type TwistInput } from '@/sim/localDriver';
import { hasFlatTrackedSupport, reserveStoppingYaw } from '@/sim/trackedYawReserve';

const params = hullParams(VEHICLE_DEFS.pz4gh), model = deriveTrackedYawModel(params)!;
const input = (over: Partial<TwistInput> = {}): TwistInput => ({ speed: 0, yaw: -.35,
  forward: 2 * Math.cos(5 * Math.PI / 180), lateral: 2 * Math.sin(5 * Math.PI / 180), rate: -.1,
  priorYaw: 0, priorPull: 0, pull: 0, model,
  envelope: { turnCapRadS: .35, onlyDir: 0, appliedPullRadS: 0 }, ...over });

// Independent nominal ten-substep plant followed by 30 zero-command coast ticks.
// Check both velocity and travel chord against the accepted final heading.
function coast(x: TwistInput, yaw: number): number {
  const gear = x.forward < 0 ? -1 : 1, pole = model.memory ** .1;
  let r = x.rate, heading = 0, vx = x.lateral, vy = x.forward, max = 0;
  for (let tick = 0; tick <= 30; tick++) {
    let dx = 0, dy = 0;
    for (let j = 0; j < 10; j++) {
      r = pole * r + (1 - pole) * (tick === 0 ? yaw : 0);
      heading += 2 * Math.atan(.005 * r);
      const speed = tick === 0 ? x.speed : 0;
      vx = .975 * vx + .025 * speed * Math.sin(heading);
      vy = .975 * vy + .025 * speed * Math.cos(heading);
      dx += .01 * vx; dy += .01 * vy;
    }
    for (const [a, b] of [[vx, vy], [dx, dy]])
      max = Math.max(max, Math.abs(Math.atan2(gear * a, gear * b) - heading));
  }
  return max;
}

it('keeps the entire braking tail inside the cone for both gears, yaw signs and driven-flow mixtures', () => {
  expect(coast(input(), input().yaw)).toBeGreaterThan(CONE_RAD);
  for (const gear of [-1, 1]) for (const direction of [-1, 1]) for (const rateSign of [-1, 1])
    for (const betaSign of [-1, 1]) for (const speed of [0, 2]) {
      const x = input({ speed: gear * speed, forward: gear * 2 * Math.cos(5 * Math.PI / 180),
        lateral: gear * betaSign * 2 * Math.sin(5 * Math.PI / 180), rate: rateSign * .1, yaw: direction * .35 });
      const yaw = reserveStoppingYaw(x);
      expect(Math.abs(yaw)).toBeLessThanOrEqual(Math.abs(x.yaw));
      expect(yaw * x.yaw).toBeGreaterThanOrEqual(0);
      expect(coast(x, yaw)).toBeLessThan(CONE_RAD);
    }
});

it('retains existing owners, pull, counterthrust, outside-cone correction and true standstill', () => {
  for (const over of [{ priorYaw: .1 }, { priorPull: .1 }, { pull: .1 },
    { speed: -2 }, { lateral: 2 }, { forward: 0, lateral: STANDSTILL_MS / 2 }]) {
    const x = input(over); expect(reserveStoppingYaw(x)).toBe(x.yaw);
  }
  const moving = input({ forward: STANDSTILL_MS, lateral: 0, rate: .3, yaw: .35 });
  expect(reserveStoppingYaw(moving)).toBeLessThan(moving.yaw);
});

it('uses the accepted regular contact positions and rejects slopes, steps and nonflat normals', () => {
  const flat = () => ({ heightM: 0, normal: { x: 0, y: 0, z: 1 } });
  const body = createHullBody(VEHICLE_DEFS.pz4gh, { x: 20, y: 20 }, .6, flat);
  const positions: [number, number][] = [];
  expect(hasFlatTrackedSupport(body, params, (x, y) => { positions.push([x, y]); return flat(); })).toBe(true);
  expect(positions.length).toBe(params.contacts.filter(c => !c.horn).length);
  expect(new Set(positions.map(p => p.join(','))).size).toBe(positions.length);
  expect(hasFlatTrackedSupport(body, params, () => ({ heightM: 0, normal: { x: .01, y: 0, z: Math.sqrt(1 - .0001) } }))).toBe(false);
  let call = 0;
  expect(hasFlatTrackedSupport(body, params, () => ({ ...flat(), heightM: ++call === 1 ? 0 : 1 }))).toBe(false);
  expect(call).toBe(2);
});
