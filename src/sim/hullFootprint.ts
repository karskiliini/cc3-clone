import type { GameMap, HullBody, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { HullParams } from '@/data/vehiclePhysics';
import { rotate } from './hullMath';

export interface AcceptedHullPose { position: HullBody['position']; orientation: HullBody['orientation'] }

/** Exact XY projection of the accepted solid box, including pitched/rolled roof corners. */
function projectedCorners(box: HullParams['solidBox'], pose: AcceptedHullPose): Vec2[] {
  const points: Vec2[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const r = rotate(pose.orientation, { x, y, z });
    points.push({ x: (pose.position.x + r.x) / TILE_M, y: (pose.position.y + r.y) / TILE_M });
  }
  return points;
}

function convexFootprint(points: Vec2[]): Vec2[] {
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

interface EdgeProjection { nx: number; ny: number; lo: number; hi: number }

/** Polygon projections do not depend on the tile. Retain edge and arithmetic order. */
function edgeProjections(polygon: Vec2[]): EdgeProjection[] {
  return polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const nx = a.y - b.y, ny = b.x - a.x;
    let lo = Infinity, hi = -Infinity;
    for (const point of polygon) {
      const projection = point.x * nx + point.y * ny;
      lo = Math.min(lo, projection); hi = Math.max(hi, projection);
    }
    return { nx, ny, lo, hi };
  });
}

/** SAT with tile axes supplied by the bounding range and each polygon edge normal. */
function footprintTouchesTile(edges: EdgeProjection[], x: number, y: number): boolean {
  for (const { nx, ny, lo, hi } of edges) {
    const origin = x * nx + y * ny;
    const tileLo = origin + Math.min(0, nx) + Math.min(0, ny);
    const tileHi = origin + Math.max(0, nx) + Math.max(0, ny);
    if (hi < tileLo || lo > tileHi) return false;
  }
  return true;
}

/** A convex footprint lies within the bounds of its eight projected corners.
 * If every tile in that conservative rectangle was already accepted, neither
 * polygon construction nor SAT can add a tile. No coordinates are quantized. */
function boundsAlreadyCovered(map: Pick<GameMap, 'width' | 'height'>, points: Vec2[], tiles: Set<number>): boolean {
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
  for (const p of points) {
    loX = Math.min(loX, p.x); hiX = Math.max(hiX, p.x);
    loY = Math.min(loY, p.y); hiY = Math.max(hiY, p.y);
  }
  const minX = Math.max(0, Math.floor(loX)), maxX = Math.min(map.width - 1, Math.floor(hiX));
  const minY = Math.max(0, Math.floor(loY)), maxY = Math.min(map.height - 1, Math.floor(hiY));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (!tiles.has(y * map.width + x)) return false;
  }
  return true;
}

export function acceptedFootprintTiles(map: Pick<GameMap, 'width' | 'height'>, box: HullParams['solidBox'], poses: AcceptedHullPose[]): Set<number> {
  const tiles = new Set<number>();
  for (const pose of poses) {
    const points = projectedCorners(box, pose);
    if (tiles.size > 0 && boundsAlreadyCovered(map, points, tiles)) continue;
    const polygon = convexFootprint(points);
    const minX = Math.max(0, Math.floor(Math.min(...polygon.map(p => p.x))));
    const maxX = Math.min(map.width - 1, Math.floor(Math.max(...polygon.map(p => p.x))));
    const minY = Math.max(0, Math.floor(Math.min(...polygon.map(p => p.y))));
    const maxY = Math.min(map.height - 1, Math.floor(Math.max(...polygon.map(p => p.y))));
    let edges: EdgeProjection[] | undefined;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const key = y * map.width + x;
      // Only the first hit inserts a tile; later poses cannot change its order.
      if (tiles.has(key)) continue;
      edges ??= edgeProjections(polygon);
      if (footprintTouchesTile(edges, x, y)) tiles.add(key);
    }
  }
  return tiles;
}

