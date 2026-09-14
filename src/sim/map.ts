import type { GameMap, MapDef, Terrain, Vec2, VictoryLocation } from '@/shared/types';
import { otherSide } from '@/shared/types';
import { TERRAIN_PROPS } from './terrain';
import { buildHeightField } from './heightField';

const BUILDING_TILES = new Set<Terrain>(['buildingWood', 'buildingStone', 'floor']);
const WALL_TILES = new Set<Terrain>(['buildingWood', 'buildingStone']);

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function idx(map: GameMap, x: number, y: number): number {
  return y * map.width + x;
}

/** Clamped tile lookup. Out-of-bounds returns 'open' (visual placeholder) but callers doing
 * pathfinding/LOS must treat true OOB (via inBounds) as impassable separately. */
export function tileAt(map: GameMap, x: number, y: number): Terrain {
  const cx = x < 0 ? 0 : x >= map.width ? map.width - 1 : x;
  const cy = y < 0 ? 0 : y >= map.height ? map.height - 1 : y;
  if (!inBounds(map, x, y)) return map.tiles[idx(map, cx, cy)] ?? 'open';
  return map.tiles[idx(map, x, y)];
}

export function setTile(map: GameMap, x: number, y: number, t: Terrain): void {
  if (!inBounds(map, x, y)) return;
  map.tiles[idx(map, x, y)] = t;
}

export function coverAt(map: GameMap, p: Vec2): number {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (!inBounds(map, x, y)) return 0;
  return TERRAIN_PROPS[tileAt(map, x, y)].cover;
}

export function concealmentAt(map: GameMap, p: Vec2): number {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (!inBounds(map, x, y)) return 0;
  const i = idx(map, x, y);
  const base = TERRAIN_PROPS[map.tiles[i]].concealment;
  const smoke = map.smoke[i] ?? 0;
  return base + smoke * 1.5;
}

function floodFillBuildings(map: GameMap): void {
  const w = map.width, h = map.height;
  map.buildingId.fill(-1);
  let nextId = 0;
  const stack: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(map, x, y);
      if (map.buildingId[i] !== -1) continue;
      if (!BUILDING_TILES.has(map.tiles[i])) continue;
      const id = nextId++;
      stack.push(i);
      map.buildingId[i] = id;
      while (stack.length) {
        const ci = stack.pop()!;
        const cx = ci % w, cy = Math.floor(ci / w);
        const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nx, ny] of neighbors) {
          if (!inBounds(map, nx, ny)) continue;
          const ni = idx(map, nx, ny);
          if (map.buildingId[ni] !== -1) continue;
          if (!BUILDING_TILES.has(map.tiles[ni])) continue;
          map.buildingId[ni] = id;
          stack.push(ni);
        }
      }
    }
  }
}

function markWindows(map: GameMap): void {
  const w = map.width, h = map.height;
  map.windows.fill(0);
  // Group wall tile indices by buildingId, walking in scan order (row-major),
  // restricted to tiles that are on the perimeter (adjacent to a non-building tile
  // or out of bounds).
  const byBuilding = new Map<number, number[]>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(map, x, y);
      if (!WALL_TILES.has(map.tiles[i])) continue;
      const bid = map.buildingId[i];
      if (bid < 0) continue;
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      let perimeter = false;
      for (const [nx, ny] of neighbors) {
        if (!inBounds(map, nx, ny) || map.buildingId[idx(map, nx, ny)] !== bid) {
          perimeter = true;
          break;
        }
      }
      if (!perimeter) continue;
      if (!byBuilding.has(bid)) byBuilding.set(bid, []);
      byBuilding.get(bid)!.push(i);
    }
  }
  for (const tiles of byBuilding.values()) {
    tiles.forEach((i, n) => {
      if (n % 3 === 2) map.windows[i] = 1;
    });
  }
  // Wall tiles adjacent to a road always get a window (door).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(map, x, y);
      if (!WALL_TILES.has(map.tiles[i])) continue;
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        if (!inBounds(map, nx, ny)) continue;
        const t = map.tiles[idx(map, nx, ny)];
        if (t === 'dirtroad' || t === 'pavedroad') {
          map.windows[i] = 1;
          break;
        }
      }
    }
  }
}

export function buildMap(def: MapDef): GameMap {
  const w = def.width, h = def.height;
  const tiles: Terrain[] = new Array(w * h).fill('open');
  def.paint(tiles, w, h);

  const defenderSide = otherSide(def.attacker);
  const victoryLocations: VictoryLocation[] = def.victoryLocations.map((vl) => ({
    ...vl,
    owner: defenderSide,
    captureTimer: 0,
    capturingSide: null,
  }));

  const map: GameMap = {
    def,
    width: w,
    height: h,
    tiles,
    buildingId: new Int16Array(w * h).fill(-1),
    windows: new Uint8Array(w * h),
    victoryLocations,
    smoke: new Float32Array(w * h),
    craters: [],
  };

  floodFillBuildings(map);
  markWindows(map);
  map.heightField = buildHeightField(map);

  return map;
}
