import type { Vec2, Facing8 } from './types';
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec2, b: Vec2) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const v = (x: number, y: number): Vec2 => ({ x, y });
export const vadd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vsub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vscale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const vlen = (a: Vec2) => Math.hypot(a.x, a.y);
export const vnorm = (a: Vec2): Vec2 => { const l = vlen(a) || 1; return { x: a.x / l, y: a.y / l }; };
/** angle in radians, 0 = north (−y), clockwise positive */
export const angleTo = (from: Vec2, to: Vec2) => Math.atan2(to.x - from.x, -(to.y - from.y));
export const facingFromAngle = (rad: number): Facing8 => ((Math.round(rad / (Math.PI / 4)) % 8 + 8) % 8) as Facing8;
export const facingTo = (from: Vec2, to: Vec2): Facing8 => facingFromAngle(angleTo(from, to));
export const facingAngle = (f: Facing8) => f * Math.PI / 4;
export const FACING_DIR: Vec2[] = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];
export const wrapAngle = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
/** rotate angle `a` towards `target` by at most `maxDelta` */
export const turnTowards = (a: number, target: number, maxDelta: number) => {
  const d = wrapAngle(target - a);
  return Math.abs(d) <= maxDelta ? target : a + Math.sign(d) * maxDelta;
};
export const pointInRect = (p: Vec2, r: { x: number; y: number; w: number; h: number }) =>
  p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
