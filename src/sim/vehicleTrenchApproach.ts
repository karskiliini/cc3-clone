import type { GameMap, Vec2, VehicleDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import * as dm from '@/shared/dmath';

// stampTrenchSegs ends its parapet 1.6 m from the vector; bilinear samples reach
// another half metre. Add the arrival tolerance outside the full turning envelope.
export const TRENCH_APPROACH_REACH = 0.25;
function clearance(def: VehicleDef): number {
  return (dm.hypot(def.lengthM, def.widthM) / 2 + 1.6 + 0.5) / TILE_M + TRENCH_APPROACH_REACH;
}
interface Segment { a: Vec2; b: Vec2; nx: number; ny: number; length: number }
function segments(map: GameMap): Segment[] {
  const out: Segment[] = [];
  for (const feature of map.def.vectors ?? []) {
    if (feature.kind !== 'line' || feature.terrain !== 'trench') continue;
    for (let i = 1; i < feature.points.length; i++) {
      const a = feature.points[i - 1], b = feature.points[i], length = dm.hypot(b.x - a.x, b.y - a.y);
      if (length) out.push({ a, b, nx: -(b.y - a.y) / length, ny: (b.x - a.x) / length, length });
    }
  }
  return out;
}
function side(p: Vec2, s: Segment): number { return (p.x - s.a.x) * s.nx + (p.y - s.a.y) * s.ny; }

/** Generated crossing endpoints have an exact geometric signature, reconstructed from the
 * map and vehicle dimensions. No navigation state is hidden outside the canonical route. */
export function isTrenchApproachPoint(map: GameMap, def: VehicleDef, p: Vec2): boolean {
  const margin = clearance(def);
  return segments(map).some(s => {
    if (Math.abs(Math.abs(side(p, s)) - margin) > 1e-8) return false;
    const along = (p.x - s.a.x) * s.ny - (p.y - s.a.y) * s.nx;
    return along >= 0 && along <= s.length;
  });
}

/** An entry is followed by its opposite-bank partner on the same normal. The open
 * approach to that entry may use ordinary rolling steering; only the crossing must align. */
export function isTrenchApproachEntry(map: GameMap, def: VehicleDef, point: Vec2, next?: Vec2): boolean {
  if (!next || !isTrenchApproachPoint(map, def, point) || !isTrenchApproachPoint(map, def, next)) return false;
  const margin = clearance(def);
  return segments(map).some(s => {
    const a = side(point, s), b = side(next, s);
    return a * b < 0 && Math.abs(a) >= margin - 1e-8 && Math.abs(b) >= margin - 1e-8
      && Math.abs((next.x - point.x) * s.ny - (next.y - point.y) * s.nx) < 1e-8;
  });
}

/** Along this normal, overlapping bank envelopes form one crossing. Both turns
 * must be outside the whole group; an interior endpoint would sit on another lip. */
function crossingBounds(lines: Segment[], normal: Segment, point: Vec2, margin: number): [number, number] {
  const intervals: [number, number][] = [];
  for (const line of lines) {
    const projection = normal.nx * line.nx + normal.ny * line.ny;
    if (projection === 0) continue;
    const centre = -side(point, line) / projection;
    const x = point.x + centre * normal.nx, y = point.y + centre * normal.ny;
    const along = (x - line.a.x) * line.ny - (y - line.a.y) * line.nx;
    if (along < 0 || along > line.length) continue;
    const radius = margin / Math.abs(projection);
    intervals.push([centre - radius, centre + radius]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let lo = -margin, hi = margin;
  // Each expansion absorbs at least one interval. The fixed segment count bounds
  // chained overlaps in either direction without repeatedly rewriting the route.
  for (let pass = 0; pass < intervals.length; pass++) {
    let expanded = false;
    for (const [a, b] of intervals) if (a <= hi && b >= lo && (a < lo || b > hi)) {
      lo = Math.min(lo, a); hi = Math.max(hi, b); expanded = true;
    }
    if (!expanded) break;
  }
  return [lo, hi];
}

/** A tile path crossing an excavation becomes a straight, perpendicular crossing with its
 * two turns on supported ground. Keep both endpoints until the complete hull clears. */
export function prepareTrenchApproaches(map: GameMap, def: VehicleDef, from: Vec2, original: Vec2[],
  canConnect: (a: Vec2, b: Vec2, originalSpan: readonly Vec2[]) => boolean): Vec2[] {
  if (def.turnRadiusM != null) return original;
  const lines = segments(map), margin = clearance(def);
  let route = original;
  // Each original edge can cross each authored segment at most once. A rewrite
  // may expose a neighbour's crossing again, but must not create an endless cycle.
  let remaining = original.length * lines.length;
  for (let i = 0; i < route.length && remaining > 0; i++) {
    const before = i === 0 ? from : route[i - 1], after = route[i];
    for (const line of lines) {
      const start = side(before, line), end = side(after, line);
      if (start === 0 || start * end > 0 || start === end) continue;
      if (end === 0) {
        let beyond = i + 1;
        while (beyond < route.length && side(route[beyond], line) === 0) beyond++;
        if (beyond === route.length || side(route[beyond], line) * start >= 0) continue;
      }
      const t = start / (start - end);
      if (t <= 0 || t > 1) continue;
      const crossing = { x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t };
      const along = (crossing.x - line.a.x) * line.ny - (crossing.y - line.a.y) * line.nx;
      if (along < 0 || along > line.length) continue;
      const sign = Math.sign(start);
      let first = i;
      while (first > 0 && side(route[first - 1], line) * sign < margin) first--;
      let last = i;
      while (last < route.length && side(route[last], line) * sign > -margin) last++;
      // The first perpendicular crossing may put its far-bank connector through
      // an obstacle. Existing route nodes locate alternative gaps along this bank.
      const candidates = [crossing, ...route.slice(first, last + 1).map(p => {
        const offset = side(p, line);
        return { x: p.x - offset * line.nx, y: p.y - offset * line.ny };
      })];
      let replacement: { first: number; last: number; entry: Vec2; exit: Vec2 } | undefined;
      for (const candidate of candidates) {
        const u = (candidate.x - line.a.x) * line.ny - (candidate.y - line.a.y) * line.nx;
        if (u < 0 || u > line.length) continue;
        const [lo, hi] = crossingBounds(lines, line, candidate, margin);
        const near = sign > 0 ? hi : lo, far = sign > 0 ? lo : hi;
        const entry = { x: candidate.x + line.nx * near, y: candidate.y + line.ny * near };
        const exit = { x: candidate.x + line.nx * far, y: candidate.y + line.ny * far };
        let begin = i, end = i;
        while (begin > 0 && side(route[begin - 1], line) * sign < near * sign) begin--;
        while (end < route.length && side(route[end], line) * sign > far * sign) end++;
        const previous = begin === 0 ? from : route[begin - 1];
        const next = route[Math.min(end, route.length - 1)];
        const originalSpan = [previous, ...route.slice(begin, end), ...(next ? [next] : [])];
        if (canConnect(previous, entry, originalSpan) && canConnect(entry, exit, originalSpan)
          && (!next || canConnect(exit, next, originalSpan))) {
          replacement = { first: begin, last: end, entry, exit }; break;
        }
      }
      if (!replacement) continue;
      first = replacement.first;
      const tail = replacement.last < route.length ? route.slice(replacement.last) : [route[route.length - 1]];
      route = [...route.slice(0, first), replacement.entry, replacement.exit, ...tail];
      remaining--;
      i = first + 1; // the generated entry-to-exit edge is already prepared
      break;
    }
  }
  return route;
}
