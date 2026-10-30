import type { GameMap, Vec2, VehicleDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { angleTo, dist } from '@/shared/math';
import * as dm from '@/shared/dmath';
import { crossedCells } from './vehicleCorridor';
import { isPassable, vehicleSlopeCost } from './path';

/** Water has no tyre/track support. Test the oriented hull against its actual bank cells. */
export function bankHullClear(map: GameMap, def: VehicleDef, p: Vec2, heading: number): boolean {
  const halfW = def.widthM / (2 * TILE_M), halfL = def.lengthM / (2 * TILE_M);
  const c = dm.cos(heading), s = dm.sin(heading), ac = Math.abs(c), as = Math.abs(s);
  const ex = halfW * ac + halfL * as, ey = halfW * as + halfL * ac;
  for (let y = Math.floor(p.y - ey); y <= Math.floor(p.y + ey); y++) {
    for (let x = Math.floor(p.x - ex); x <= Math.floor(p.x + ex); x++) {
      if (x >= 0 && y >= 0 && x < map.width && y < map.height && map.tiles[y * map.width + x] !== 'water') continue;
      const dx = x + 0.5 - p.x, dy = y + 0.5 - p.y;
      if (Math.abs(dx) < ex + 0.5 && Math.abs(dy) < ey + 0.5
        && Math.abs(dx * c + dy * s) < halfW + (ac + as) * 0.5
        && Math.abs(-dx * s + dy * c) < halfL + (ac + as) * 0.5) return false;
    }
  }
  return true;
}

export function bankTurningRoom(map: GameMap, def: VehicleDef, p: Vec2): boolean {
  const radius = dm.hypot(def.widthM, def.lengthM) / (2 * TILE_M);
  for (let y = Math.floor(p.y - radius); y <= Math.floor(p.y + radius); y++) {
    for (let x = Math.floor(p.x - radius); x <= Math.floor(p.x + radius); x++) {
      if (x >= 0 && y >= 0 && x < map.width && y < map.height && map.tiles[y * map.width + x] !== 'water') continue;
      const dx = Math.max(x - p.x, 0, p.x - x - 1), dy = Math.max(y - p.y, 0, p.y - y - 1);
      if (dx * dx + dy * dy < radius * radius) return false;
    }
  }
  return true;
}

export interface BankCoverApproach { target: Vec2; route: Vec2[]; staging: Vec2 }
/** A point route can turn across a bank before the rear of a real hull clears it. Continue
 * its incoming leg to supported turning ground, then choose a supported arrival inside the
 * same cover neighbourhood. The final segment must support the whole aligned hull. */
export function bankCoverApproach(map: GameMap, def: VehicleDef, from: Vec2, route: Vec2[],
  validCover: (p: Vec2) => boolean): BankCoverApproach | null | undefined {
  for (let i = 0; i + 1 < route.length; i++) {
    const previous = i === 0 ? from : route[i - 1], corner = route[i], next = route[i + 1];
    const ax = corner.x - previous.x, ay = corner.y - previous.y;
    const bx = next.x - corner.x, by = next.y - corner.y, length = dist(previous, corner);
    if (length === 0 || Math.abs(ax * by - ay * bx) < 1e-8 || bankTurningRoom(map, def, corner)) continue;
    const passable = (x: number, y: number) => isPassable(map, x, y, 'vehicle', def);
    const stepCount = Math.ceil(def.lengthM / TILE_M / 0.25);
    let staging: Vec2 | undefined;
    for (let k = 1; k <= stepCount; k++) {
      const extension = Math.min(k * 0.25, def.lengthM / TILE_M);
      const p = { x: corner.x + ax / length * extension, y: corner.y + ay / length * extension };
      if (!crossedCells(corner, p, passable) || !Number.isFinite(vehicleSlopeCost(map, corner, p, def))) break;
      if (bankTurningRoom(map, def, p)) { staging = p; break; }
    }
    if (!staging) return null;
    const original = route[route.length - 1], options: Vec2[] = [];
    const extent = Math.ceil(def.widthM / TILE_M / 0.25);
    for (let dy = -extent; dy <= extent; dy++) for (let dx = -extent; dx <= extent; dx++) {
      const p = { x: original.x + dx * 0.25, y: original.y + dy * 0.25 };
      if (validCover(p)) options.push(p);
    }
    options.sort((a, b) => dist(a, original) - dist(b, original) || dist(from, a) - dist(from, b));
    for (const target of options) {
      if (!crossedCells(staging, target, passable)) continue;
      const heading = angleTo(staging, target), steps = Math.max(1, Math.ceil(dist(staging, target) / 0.1));
      let clear = true, previousPoint = staging;
      for (let k = 0; k <= steps; k++) {
        const p = { x: staging.x + (target.x - staging.x) * k / steps,
          y: staging.y + (target.y - staging.y) * k / steps };
        if (!bankHullClear(map, def, p, heading) || !Number.isFinite(vehicleSlopeCost(map, previousPoint, p, def))) { clear = false; break; }
        previousPoint = p;
      }
      if (clear) return { target, route: [...route.slice(0, i), staging, target], staging };
    }
    return null;
  }
  return undefined;
}
