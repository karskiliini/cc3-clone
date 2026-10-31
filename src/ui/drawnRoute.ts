import type { Vec2 } from '@/shared/types';

/** Preserve corners, reduce only collinear mouse samples. Never truncate a route silently. */
export function appendDrawnPoint(points: Vec2[], p: Vec2): boolean {
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.15) return true;
  const before = points[points.length - 2];
  if (before && last) {
    const ax = last.x - before.x, ay = last.y - before.y;
    const bx = p.x - last.x, by = p.y - last.y;
    if (ax * bx + ay * by > 0 && Math.abs(ax * by - ay * bx) < 0.01) {
      points[points.length - 1] = { ...p }; return true;
    }
  }
  if (points.length >= 512) return false;
  points.push({ ...p }); return true;
}
