import type { HullQuat, Vec3 } from '@/shared/types';
import * as dm from '@/shared/dmath';

export function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Composition a after b, with both rotations local-to-world. */
export function multiply(a: HullQuat, b: HullQuat): HullQuat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export function normalize(q: HullQuat): HullQuat {
  const length = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  return length === 0 ? { x: 0, y: 0, z: 0, w: 1 }
    : { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

/** Rotate using a unit quaternion (the solver renormalizes it each substep). */
export function rotate(q: HullQuat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}
export function inverseRotate(q: HullQuat, v: Vec3): Vec3 {
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}
export function yawQuat(rad: number): HullQuat {
  return { x: 0, y: 0, z: dm.sin(rad / 2), w: dm.cos(rad / 2) };
}
export function hullAngles(q: HullQuat): { heading: number; pitch: number; roll: number } {
  const forward = rotate(q, { x: 0, y: -1, z: 0 });
  const right = rotate(q, { x: 1, y: 0, z: 0 }), up = rotate(q, { x: 0, y: 0, z: 1 });
  return { heading: dm.atan2(forward.x, -forward.y),
    pitch: dm.atan2(forward.z, Math.sqrt(forward.x * forward.x + forward.y * forward.y)),
    roll: dm.atan2(right.z, up.z) };
}
