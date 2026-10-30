import type { GameMap, Vec2, VehicleDef } from '@/shared/types';
import { TERRAIN_PROPS } from './terrain';
import { groundHeightAt, idx, inBounds } from './map';
import { TILE_M } from '@/shared/types';
import * as dm from '@/shared/dmath';
import { resolveVehiclePhysics } from '@/data/vehiclePhysics';
import { crossedCells } from './vehicleCorridor';
import { prepareTrenchApproaches } from './vehicleTrenchApproach';

type Mover = 'infantry' | 'vehicle';

/** Steepest local grade a tracked vehicle will attempt (25% ~= 14 degrees). Above that the bank
 * is a wall as far as the vehicle is concerned; infantry scramble up anything. Map relief is
 * built to stay well under this except at deliberate river banks and railway cuttings. */
export const VEHICLE_MAX_GRADE = 0.25;

export function isPassable(map: GameMap, x: number, y: number, mover: Mover, vehicleDef?: VehicleDef): boolean {
  if (!inBounds(map, x, y)) return false;
  const i = idx(map, x, y);
  const t = map.tiles[i];
  const cost = mover === 'infantry' ? TERRAIN_PROPS[t].infantryCost : TERRAIN_PROPS[t].vehicleCost;
  if (!Number.isFinite(cost)) return false;
  if (mover === 'vehicle') {
    const steep = map.groundSteep;
    if (!vehicleDef && steep && steep[i] > VEHICLE_MAX_GRADE) return false;
    if (map.bunkerId && map.bunkerId[i] >= 0) return false; // a pillbox is a solid obstacle to tracks
  }
  return true;
}

export interface VehiclePathProfile { def: VehicleDef }

/** Bare-ground directional grade; finite comfort cost preserves the terrain preference. */
export function vehicleSlopeCost(map: GameMap, from: Vec2, to: Vec2, def: VehicleDef): number {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0 || !map.ground) return 1;
  const ux = dx / length, uy = dy / length;
  const p = resolveVehiclePhysics(def), rad = Math.PI / 180;
  let cost = 1;
  // Endpoints and midpoint keep short/diagonal shortcuts under the same rule as A* edges.
  for (const t of [0, 0.5, 1]) {
    const x = from.x + dx * t, y = from.y + dy * t;
    const gx = (groundHeightAt(map, { x: x + 0.5, y }) - groundHeightAt(map, { x: x - 0.5, y })) / TILE_M;
    const gy = (groundHeightAt(map, { x, y: y + 0.5 }) - groundHeightAt(map, { x, y: y - 0.5 })) / TILE_M;
    // Keep the former climb cap independently from side stability; a safe contour can
    // traverse a steep hillside without pretending that driving up it is possible.
    if (Math.abs(gx * ux + gy * uy) > VEHICLE_MAX_GRADE) return Infinity;
    const angle = dm.atan2(Math.abs(-gx * uy + gy * ux), 1);
    if (angle > p.slopeTipDeg * rad) return Infinity;
    cost = Math.max(cost, 1 + 2 * Math.max(0, (angle - p.slopeComfortDeg * rad)
      / Math.max(1e-9, (p.slopeTipDeg - p.slopeComfortDeg) * rad)));
  }
  return cost;
}

/** Terrain base cost remains unchanged for infantry and generic callers. */
function costOf(map: GameMap, x: number, y: number, mover: Mover): number {
  const t = map.tiles[idx(map, x, y)];
  return mover === 'infantry' ? TERRAIN_PROPS[t].infantryCost : TERRAIN_PROPS[t].vehicleCost;
}

function octile(dx: number, dy: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const mn = Math.min(ax, ay), mx = Math.max(ax, ay);
  return mx - mn + mn * Math.SQRT2;
}

interface Node {
  x: number;
  y: number;
  g: number;
  f: number;
}

class BinaryHeap {
  private items: Node[] = [];

  get size(): number { return this.items.length; }

  push(node: Node): void {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.better(this.items[i], this.items[parent])) {
        [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
        i = parent;
      } else break;
    }
  }

  pop(): Node | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let smallest = i;
        if (l < n && this.better(this.items[l], this.items[smallest])) smallest = l;
        if (r < n && this.better(this.items[r], this.items[smallest])) smallest = r;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top;
  }

  /** Tie-break on heuristic: lower f first; on tie, lower (f-g)=h first. */
  private better(a: Node, b: Node): boolean {
    if (a.f !== b.f) return a.f < b.f;
    return (a.f - a.g) < (b.f - b.g);
  }
}

// Module-level A* scratch. findPath is synchronous and never re-enters itself, so one set of
// buffers is safe; they are reallocated only when the map size changes. Avoids allocating and
// filling ~400 KB of typed arrays per call (the AI re-plan tick made hundreds of calls).
let scratchSize = 0;
let scratchG = new Float64Array(0);
let scratchCame = new Int32Array(0);
let scratchSeen = new Uint32Array(0);
let scratchClosed = new Uint32Array(0);
let scratchGen = 0;

function ensureScratch(n: number): void {
  if (n === scratchSize) return;
  scratchSize = n;
  scratchG = new Float64Array(n);
  scratchCame = new Int32Array(n);
  scratchSeen = new Uint32Array(n);
  scratchClosed = new Uint32Array(n);
  scratchGen = 0;
}

function nextGen(): number {
  scratchGen++;
  if (scratchGen >= 0xffffffff) {
    scratchSeen.fill(0);
    scratchClosed.fill(0);
    scratchGen = 1;
  }
  return scratchGen;
}

/** Extra cost of stepping onto a tile, on top of its terrain cost (>= 0, so the heuristic stays
 * admissible): a danger to go round where there is a way round, never a block. */
export type TileCostFn = (x: number, y: number) => number;

export function findPath(map: GameMap, from: Vec2, to: Vec2, mover: Mover, maxNodes = 20000, extraCost?: TileCostFn, vehicleProfile?: VehiclePathProfile): Vec2[] {
  const vehicleDef = mover === 'vehicle' ? vehicleProfile?.def : undefined;
  const sx = Math.floor(from.x), sy = Math.floor(from.y);
  let tx = Math.floor(to.x), ty = Math.floor(to.y);

  if (!inBounds(map, sx, sy)) return [];

  const w = map.width, h = map.height;
  const key = (x: number, y: number) => y * w + x;

  // Reused scratch buffers (see ensureScratch): a cell's gScore/cameFrom are valid only when its
  // stamp equals the current generation; closed-ness is a second stamp array.
  ensureScratch(w * h);
  const gen = nextGen();
  const gScoreBuf = scratchG, cameFromBuf = scratchCame, seen = scratchSeen, closedStamp = scratchClosed;
  const gOf = (i: number) => (seen[i] === gen ? gScoreBuf[i] : Infinity);
  const setG = (i: number, g: number, from: number) => { seen[i] = gen; gScoreBuf[i] = g; cameFromBuf[i] = from; };
  const cameOf = (i: number) => (seen[i] === gen ? cameFromBuf[i] : -1);

  const heap = new BinaryHeap();
  setG(key(sx, sy), 0, -1);
  heap.push({ x: sx, y: sy, g: 0, f: octile(tx - sx, ty - sy) });

  let nodesExpanded = 0;
  let bestNode = key(sx, sy);
  let bestNodeDist = octile(tx - sx, ty - sy);

  const targetPassable = isPassable(map, tx, ty, mover, vehicleDef);

  while (heap.size > 0 && nodesExpanded < maxNodes) {
    const cur = heap.pop()!;
    const ci = key(cur.x, cur.y);
    if (closedStamp[ci] === gen) continue;
    closedStamp[ci] = gen;
    nodesExpanded++;

    const dRemain = octile(tx - cur.x, ty - cur.y);
    if (dRemain < bestNodeDist) {
      bestNodeDist = dRemain;
      bestNode = ci;
    }

    if (targetPassable && cur.x === tx && cur.y === ty) {
      bestNode = ci;
      break;
    }

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cur.x + dx, ny = cur.y + dy;
        if (!inBounds(map, nx, ny)) continue;
        if (!isPassable(map, nx, ny, mover, vehicleDef)) continue;
        // no corner cutting: for diagonal moves both orthogonal neighbours must be passable
        if (dx !== 0 && dy !== 0) {
          if (!isPassable(map, cur.x + dx, cur.y, mover, vehicleDef)) continue;
          if (!isPassable(map, cur.x, cur.y + dy, mover, vehicleDef)) continue;
        }
        const ni = key(nx, ny);
        if (closedStamp[ni] === gen) continue;
        const slope = vehicleDef ? vehicleSlopeCost(map,
          { x: cur.x + 0.5, y: cur.y + 0.5 }, { x: nx + 0.5, y: ny + 0.5 }, vehicleDef) : 1;
        if (!Number.isFinite(slope)) continue;
        const stepCost = slope * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * (extraCost ? costOf(map, nx, ny, mover) + extraCost(nx, ny) : costOf(map, nx, ny, mover));
        const tentativeG = cur.g + stepCost;
        if (tentativeG < gOf(ni)) {
          setG(ni, tentativeG, ci);
          heap.push({ x: nx, y: ny, g: tentativeG, f: tentativeG + octile(tx - nx, ty - ny) });
        }
      }
    }
  }

  // Reconstruct path to bestNode (either the real target, or nearest reachable node)
  if (bestNode === key(sx, sy)) return [];

  const chain: Vec2[] = [];
  let node: number = bestNode;
  while (node !== -1 && node !== key(sx, sy)) {
    const x = node % w, y = Math.floor(node / w);
    chain.push({ x: x + 0.5, y: y + 0.5 });
    node = cameOf(node);
  }
  chain.reverse();
  if (!vehicleDef) return chain;
  const budgets = new Map<readonly Vec2[], number>();
  const routeCost = (x: number, y: number): number => costOf(map, x, y, 'vehicle') + (extraCost?.(x, y) ?? 0);
  return prepareTrenchApproaches(map, vehicleDef, from, chain, (a, b, originalSpan) => {
    let budget = budgets.get(originalSpan);
    if (budget == null) {
      budget = 0;
      for (let i = 1; i < originalSpan.length; i++) crossedCells(originalSpan[i - 1], originalSpan[i], (x, y) => {
        budget = Math.max(budget!, routeCost(x, y)); return true;
      });
      budgets.set(originalSpan, budget);
    }
    return crossedCells(a, b, (x, y) => isPassable(map, x, y, 'vehicle', vehicleDef)
      && routeCost(x, y) <= budget!) && Number.isFinite(vehicleSlopeCost(map, a, b, vehicleDef));
  });
}
