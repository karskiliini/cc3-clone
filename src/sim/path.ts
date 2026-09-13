import type { GameMap, Vec2 } from '@/shared/types';
import { TERRAIN_PROPS } from './terrain';
import { idx, inBounds } from './map';

type Mover = 'infantry' | 'vehicle';

export function isPassable(map: GameMap, x: number, y: number, mover: Mover): boolean {
  if (!inBounds(map, x, y)) return false;
  const t = map.tiles[idx(map, x, y)];
  const cost = mover === 'infantry' ? TERRAIN_PROPS[t].infantryCost : TERRAIN_PROPS[t].vehicleCost;
  return Number.isFinite(cost);
}

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

export function findPath(map: GameMap, from: Vec2, to: Vec2, mover: Mover, maxNodes = 20000): Vec2[] {
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

  const targetPassable = isPassable(map, tx, ty, mover);

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
        if (!isPassable(map, nx, ny, mover)) continue;
        // no corner cutting: for diagonal moves both orthogonal neighbours must be passable
        if (dx !== 0 && dy !== 0) {
          if (!isPassable(map, cur.x + dx, cur.y, mover)) continue;
          if (!isPassable(map, cur.x, cur.y + dy, mover)) continue;
        }
        const ni = key(nx, ny);
        if (closedStamp[ni] === gen) continue;
        const stepCost = (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * costOf(map, nx, ny, mover);
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
  return chain;
}
