import { expect, it } from 'vitest';
import { add, cross, dot, hullAngles, inverseRotate, multiply, normalize, rotate, yawQuat } from '@/sim/hullMath';
import type { Vec3 } from '@/shared/types';

function close(actual: Vec3, want: Vec3): void {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(want[axis], 12);
}

it('identity preserves vectors and zero quaternion normalizes to identity', () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 }, v = { x: 2, y: -3, z: 4 };
  expect(rotate(identity, v)).toEqual(v);
  expect(inverseRotate(identity, v)).toEqual(v);
  expect(normalize({ x: 0, y: 0, z: 0, w: 0 })).toEqual(identity);
  expect(normalize({ x: 0, y: 0, z: 0, w: 5 })).toEqual(identity);
});

it('north rotated clockwise faces east and round-trips', () => {
  const q = yawQuat(Math.PI / 2), f = { x: 0, y: -1, z: 0 };
  close(rotate(q, f), { x: 1, y: 0, z: 0 });
  close(inverseRotate(q, rotate(q, f)), f);
  expect(hullAngles(q).heading).toBeCloseTo(Math.PI / 2, 12);
  expect(hullAngles(q).pitch).toBe(0);
  expect(hullAngles(q).roll).toBe(0);
});

it('composed heading and pitch rotate in local-to-world order', () => {
  // A -90 degree local x rotation raises north to up; yaw happens afterwards.
  const s = Math.sqrt(0.5), pitch = { x: -s, y: 0, z: 0, w: s };
  const q = normalize(multiply(yawQuat(Math.PI / 2), pitch));
  close(rotate(q, { x: 0, y: -1, z: 0 }), { x: 0, y: 0, z: 1 });
  close(rotate(q, { x: 0, y: 0, z: 1 }), { x: -1, y: 0, z: 0 });
  close(inverseRotate(q, rotate(q, { x: 2, y: -3, z: 4 })), { x: 2, y: -3, z: 4 });
  expect(hullAngles(q).pitch).toBeCloseTo(Math.PI / 2, 12);
});

it('roll is right-vector elevation relative to up', () => {
  const q = { x: 0, y: -Math.sqrt(0.5), z: 0, w: Math.sqrt(0.5) };
  close(rotate(q, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: 1 });
  expect(hullAngles(q).roll).toBeCloseTo(Math.PI / 2, 12);
});

it('vector arithmetic has right-handed cross products', () => {
  expect(add({ x: 1, y: 2, z: 3 }, { x: -4, y: 5, z: -6 })).toEqual({ x: -3, y: 7, z: -3 });
  expect(dot({ x: 1, y: 2, z: 3 }, { x: -4, y: 5, z: -6 })).toBe(-12);
  expect(cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 0, z: 1 });
});
