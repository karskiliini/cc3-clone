// Frozen pre-optimization footprint, source e7540f5; ordered differential oracle.
import type { BattleState, HullBody, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { HullParams } from '@/data/vehiclePhysics';
import { rotate } from '@/sim/hullMath';
import { idx } from '@/sim/map';
interface AcceptedHullPose { position: HullBody['position']; orientation: HullBody['orientation'] }

/** Exact XY projection of the accepted solid box, including pitched/rolled roof corners. */
function hullFootprint(box: HullParams['solidBox'], pose: AcceptedHullPose): Vec2[] {
  const points: Vec2[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const r = rotate(pose.orientation, { x, y, z });
    points.push({ x: (pose.position.x + r.x) / TILE_M, y: (pose.position.y + r.y) / TILE_M });
  }
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (ordered: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const point of ordered) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    return out.slice(0, -1);
  };
  return [...half(points), ...half([...points].reverse())];
}

/** SAT with tile axes supplied by the bounding range and each polygon edge normal. */
function footprintTouchesTile(polygon: Vec2[], x: number, y: number): boolean {
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const nx = a.y - b.y, ny = b.x - a.x;
    let lo = Infinity, hi = -Infinity;
    for (const point of polygon) {
      const projection = point.x * nx + point.y * ny;
      lo = Math.min(lo, projection); hi = Math.max(hi, projection);
    }
    const origin = x * nx + y * ny;
    const tileLo = origin + Math.min(0, nx) + Math.min(0, ny);
    const tileHi = origin + Math.max(0, nx) + Math.max(0, ny);
    if (hi < tileLo || lo > tileHi) return false;
  }
  return true;
}

export function referenceFootprintTiles(state: BattleState, params: HullParams, poses: AcceptedHullPose[]): Set<number> {
  const tiles = new Set<number>();
  for (const pose of poses) {
    const polygon = hullFootprint(params.solidBox, pose);
    const minX = Math.max(0, Math.floor(Math.min(...polygon.map(p => p.x))));
    const maxX = Math.min(state.map.width - 1, Math.floor(Math.max(...polygon.map(p => p.x))));
    const minY = Math.max(0, Math.floor(Math.min(...polygon.map(p => p.y))));
    const maxY = Math.min(state.map.height - 1, Math.floor(Math.max(...polygon.map(p => p.y))));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (footprintTouchesTile(polygon, x, y)) tiles.add(idx(state.map, x, y));
    }
  }
  return tiles;
}

