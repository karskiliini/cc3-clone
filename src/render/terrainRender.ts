// ============================================================================
// terrainRender.ts — bakes the painted CC3-style terrain into offscreen chunk
// canvases and blits them each frame. Also draws craters/blood/smoke overlays.
// ============================================================================
import type { Camera, GameMap, BattleState, Terrain, Season } from '@/shared/types';
import { TILE_PX, VIEW_W, VIEW_H } from '@/shared/types';
import { hash2 } from '@/shared/rng';
import { idx, tileAt, inBounds } from '@/sim/map';
import { TERRAIN_COLORS } from '@/render/palette';
import { getTreeSprite, getSmokePuff } from '@/render/sprites';
import { worldToScreen } from '@/engine/camera';

const CHUNK_TILES = 26;
const CHUNK_PX = CHUNK_TILES * TILE_PX; // 260

const BUILDING_TERRAINS = new Set<Terrain>(['buildingWood', 'buildingStone', 'floor']);
const ROAD_TERRAINS = new Set<Terrain>(['dirtroad', 'pavedroad']);

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

interface BuildingBBox {
  minX: number; minY: number; maxX: number; maxY: number;
  kind: 'wood' | 'stone';
}

// ---------------------------------------------------------------- base fill
function paintBase(
  ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number,
  ox: number, oy: number, season: Season, seed: number,
): void {
  const t = tileAt(map, wx, wy);
  const nLeft = tileAt(map, wx - 1, wy);
  const nRight = tileAt(map, wx + 1, wy);
  const nUp = tileAt(map, wx, wy - 1);
  const nDown = tileAt(map, wx, wy + 1);
  const colorsFor = (terr: Terrain) => TERRAIN_COLORS[season][terr];
  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      let terr: Terrain = t;
      if (px < 2 && nLeft !== t && hash2(wx * 10 + px, wy * 10 + py, seed + 7) < (2 - px) * 0.22) terr = nLeft;
      else if (px > TILE_PX - 3 && nRight !== t && hash2(wx * 10 + px, wy * 10 + py, seed + 11) < (px - (TILE_PX - 3)) * 0.22) terr = nRight;
      else if (py < 2 && nUp !== t && hash2(wx * 10 + px, wy * 10 + py, seed + 13) < (2 - py) * 0.22) terr = nUp;
      else if (py > TILE_PX - 3 && nDown !== t && hash2(wx * 10 + px, wy * 10 + py, seed + 17) < (py - (TILE_PX - 3)) * 0.22) terr = nDown;
      const colors = colorsFor(terr);
      const n = hash2(wx * 10 + px, wy * 10 + py, seed);
      const shade = colors[Math.floor(n * colors.length) % colors.length];
      ctx.fillStyle = shade;
      ctx.fillRect(ox + px, oy + py, 1, 1);
    }
  }
}

// -------------------------------------------------------------- road detail
function paintRoad(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number, paved: boolean): void {
  const horiz = ROAD_TERRAINS.has(tileAt(map, wx - 1, wy)) || ROAD_TERRAINS.has(tileAt(map, wx + 1, wy));
  const vert = ROAD_TERRAINS.has(tileAt(map, wx, wy - 1)) || ROAD_TERRAINS.has(tileAt(map, wx, wy + 1));
  const dirHoriz = horiz && !vert ? true : vert && !horiz ? false : hash2(wx, wy, seed + 3) < 0.5;
  const dark = paved ? '#3a3a3a' : '#4a3a28';
  const light = paved ? '#8a8a8a' : '#8a6f4a';
  ctx.fillStyle = dark;
  if (dirHoriz) { ctx.fillRect(ox, oy + 3, TILE_PX, 1); ctx.fillRect(ox, oy + 6, TILE_PX, 1); }
  else { ctx.fillRect(ox + 3, oy, 1, TILE_PX); ctx.fillRect(ox + 6, oy, 1, TILE_PX); }
  for (let i = 0; i < 3; i++) {
    if (hash2(wx + i, wy + i, seed + 29) < 0.35) {
      const px = Math.floor(hash2(wx * 3 + i, wy * 3 + i, seed + 21) * TILE_PX);
      const py = Math.floor(hash2(wx * 3 + i + 50, wy * 3 + i + 50, seed + 23) * TILE_PX);
      ctx.fillStyle = light;
      ctx.fillRect(ox + px, oy + py, 1, 1);
    }
  }
  if (paved) {
    ctx.fillStyle = light;
    if (dirHoriz) ctx.fillRect(ox, oy + Math.floor(TILE_PX / 2), TILE_PX, 1);
    else ctx.fillRect(ox + Math.floor(TILE_PX / 2), oy, 1, TILE_PX);
    ctx.fillStyle = '#202020';
    if (!ROAD_TERRAINS.has(tileAt(map, wx - 1, wy))) ctx.fillRect(ox, oy, 1, TILE_PX);
    if (!ROAD_TERRAINS.has(tileAt(map, wx + 1, wy))) ctx.fillRect(ox + TILE_PX - 1, oy, 1, TILE_PX);
    if (!ROAD_TERRAINS.has(tileAt(map, wx, wy - 1))) ctx.fillRect(ox, oy, TILE_PX, 1);
    if (!ROAD_TERRAINS.has(tileAt(map, wx, wy + 1))) ctx.fillRect(ox, oy + TILE_PX - 1, TILE_PX, 1);
  }
}

function paintWater(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  const nearBank = ([[-1, 0], [1, 0], [0, -1], [0, 1]] as const).some(([dx, dy]) => {
    const nt = tileAt(map, wx + dx, wy + dy);
    return nt !== 'water' && nt !== 'bridge';
  });
  if (nearBank) { ctx.fillStyle = 'rgba(15,30,42,0.4)'; ctx.fillRect(ox, oy, TILE_PX, TILE_PX); }
  ctx.fillStyle = '#7fa3b0';
  for (let i = 0; i < 2; i++) {
    const ry = Math.floor(hash2(wx * 5 + i, wy * 5 + i, seed + 41) * TILE_PX);
    const rx = Math.floor(hash2(wx * 5 + i + 7, wy * 5 + i + 7, seed + 43) * (TILE_PX - 3));
    ctx.fillRect(ox + rx, oy + ry, 3, 1);
  }
}

function paintSnowSpecks(ctx: CanvasRenderingContext2D, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  for (let i = 0; i < 4; i++) {
    const px = Math.floor(hash2(wx * 7 + i, wy * 7 + i, seed + 51) * TILE_PX);
    const py = Math.floor(hash2(wx * 7 + i + 3, wy * 7 + i + 3, seed + 53) * TILE_PX);
    const v = hash2(wx + i, wy + i, seed + 55);
    ctx.fillStyle = v < 0.5 ? '#c9d6dd' : '#8a95a0';
    ctx.fillRect(ox + px, oy + py, 1, 1);
  }
}

function paintMud(ctx: CanvasRenderingContext2D, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  for (let i = 0; i < 3; i++) {
    const px = Math.floor(hash2(wx * 9 + i, wy * 9 + i, seed + 61) * TILE_PX);
    const py = Math.floor(hash2(wx * 9 + i + 4, wy * 9 + i + 4, seed + 63) * TILE_PX);
    ctx.fillStyle = 'rgba(140,150,90,0.5)';
    ctx.fillRect(ox + px, oy + py, 1, 1);
  }
}

function paintCraterTile(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  const cx = ox + TILE_PX / 2, cy = oy + TILE_PX / 2, r = TILE_PX / 2 - 1;
  ctx.beginPath(); ctx.fillStyle = '#2a2a28'; ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.strokeStyle = '#5a5a4a'; ctx.lineWidth = 1; ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
}

function paintTrench(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const horiz = tileAt(map, wx - 1, wy) === 'trench' || tileAt(map, wx + 1, wy) === 'trench';
  if (horiz) {
    ctx.fillStyle = '#5a4f3a'; ctx.fillRect(ox, oy + 2, TILE_PX, 1); ctx.fillRect(ox, oy + 7, TILE_PX, 1);
    ctx.fillStyle = '#1c1a16'; ctx.fillRect(ox, oy + 4, TILE_PX, 2);
  } else {
    ctx.fillStyle = '#5a4f3a'; ctx.fillRect(ox + 2, oy, 1, TILE_PX); ctx.fillRect(ox + 7, oy, 1, TILE_PX);
    ctx.fillStyle = '#1c1a16'; ctx.fillRect(ox + 4, oy, 2, TILE_PX);
  }
}

function paintHedge(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  const horiz = tileAt(map, wx - 1, wy) === 'hedge' || tileAt(map, wx + 1, wy) === 'hedge';
  ctx.fillStyle = '#2c3d22';
  if (horiz) ctx.fillRect(ox, oy + 3, TILE_PX, 4); else ctx.fillRect(ox + 3, oy, 4, TILE_PX);
  ctx.fillStyle = '#4c6a34';
  for (let i = 0; i < 3; i++) {
    const off = Math.floor(hash2(wx * 4 + i, wy * 4 + i, seed + 71) * TILE_PX);
    if (horiz) ctx.fillRect(ox + off, oy + 3, 1, 1); else ctx.fillRect(ox + 3, oy + off, 1, 1);
  }
}

function paintFence(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const horiz = tileAt(map, wx - 1, wy) === 'fence' || tileAt(map, wx + 1, wy) === 'fence';
  ctx.fillStyle = '#5a4326';
  if (horiz) ctx.fillRect(ox, oy + 5, TILE_PX, 1); else ctx.fillRect(ox + 5, oy, 1, TILE_PX);
  if ((wx + wy) % 2 === 0) {
    ctx.fillStyle = '#3a2c18';
    if (horiz) ctx.fillRect(ox + 4, oy + 3, 1, 5); else ctx.fillRect(ox + 3, oy + 4, 5, 1);
  }
}

function paintStonewall(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const horiz = tileAt(map, wx - 1, wy) === 'stonewall' || tileAt(map, wx + 1, wy) === 'stonewall';
  ctx.fillStyle = '#9a9a92';
  if (horiz) { ctx.fillRect(ox, oy + 4, TILE_PX, 2); ctx.fillStyle = '#4a4a42'; ctx.fillRect(ox, oy + 6, TILE_PX, 1); }
  else { ctx.fillRect(ox + 4, oy, 2, TILE_PX); ctx.fillStyle = '#4a4a42'; ctx.fillRect(ox + 6, oy, 1, TILE_PX); }
}

function paintRubble(ctx: CanvasRenderingContext2D, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  for (let i = 0; i < 6; i++) {
    const px = Math.floor(hash2(wx * 6 + i, wy * 6 + i, seed + 81) * TILE_PX);
    const py = Math.floor(hash2(wx * 6 + i + 2, wy * 6 + i + 2, seed + 83) * TILE_PX);
    const v = hash2(wx + i, wy + i, seed + 85);
    ctx.fillStyle = v < 0.4 ? '#8a4a3a' : v < 0.7 ? '#3a3a38' : '#6a6a62';
    ctx.fillRect(ox + px, oy + py, 1, 1);
  }
  ctx.fillStyle = '#55524a';
  for (let i = 0; i < 2; i++) {
    const px = Math.floor(hash2(wx * 8 + i, wy * 8 + i, seed + 87) * (TILE_PX - 2));
    const py = Math.floor(hash2(wx * 8 + i + 9, wy * 8 + i + 9, seed + 89) * (TILE_PX - 2));
    ctx.fillRect(ox + px, oy + py, 2, 2);
  }
}

function paintBridge(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const horiz = tileAt(map, wx, wy - 1) !== 'bridge' && tileAt(map, wx, wy + 1) !== 'bridge';
  if (horiz) {
    for (let px = 0; px < TILE_PX; px += 3) { ctx.fillStyle = px % 6 === 0 ? '#7a5f3a' : '#5a4626'; ctx.fillRect(ox + px, oy, 2, TILE_PX); }
  } else {
    for (let py = 0; py < TILE_PX; py += 3) { ctx.fillStyle = py % 6 === 0 ? '#7a5f3a' : '#5a4626'; ctx.fillRect(ox, oy + py, TILE_PX, 2); }
  }
}

function paintDetail(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, seed: number): void {
  const t = tileAt(map, wx, wy);
  switch (t) {
    case 'dirtroad': paintRoad(ctx, map, wx, wy, ox, oy, seed, false); break;
    case 'pavedroad': paintRoad(ctx, map, wx, wy, ox, oy, seed, true); break;
    case 'water': paintWater(ctx, map, wx, wy, ox, oy, seed); break;
    case 'snow': paintSnowSpecks(ctx, wx, wy, ox, oy, seed); break;
    case 'mud': paintMud(ctx, wx, wy, ox, oy, seed); break;
    case 'crater': paintCraterTile(ctx, ox, oy); break;
    case 'trench': paintTrench(ctx, map, wx, wy, ox, oy); break;
    case 'hedge': paintHedge(ctx, map, wx, wy, ox, oy, seed); break;
    case 'fence': paintFence(ctx, map, wx, wy, ox, oy); break;
    case 'stonewall': paintStonewall(ctx, map, wx, wy, ox, oy); break;
    case 'rubble': paintRubble(ctx, wx, wy, ox, oy, seed); break;
    case 'bridge': paintBridge(ctx, map, wx, wy, ox, oy); break;
    default: break;
  }
}

// ---------------------------------------------------------------- buildings
function paintRoof(ctx: CanvasRenderingContext2D, bb: BuildingBBox, x0: number, y0: number): void {
  const left = (bb.minX - x0) * TILE_PX;
  const top = (bb.minY - y0) * TILE_PX;
  const wTiles = bb.maxX - bb.minX + 1;
  const hTiles = bb.maxY - bb.minY + 1;
  const w = wTiles * TILE_PX;
  const h = hTiles * TILE_PX;
  const stone = bb.kind === 'stone';
  const base = stone ? '#7a7a76' : '#7a5432';
  const baseLight = stone ? '#95958e' : '#93683f';
  const eave = stone ? '#404038' : '#3a2818';

  ctx.fillStyle = base;
  ctx.fillRect(left, top, w, h);
  ctx.fillStyle = baseLight;
  ctx.fillRect(left, top, Math.max(1, Math.floor(w * 0.4)), h);
  ctx.fillRect(left, top, w, Math.max(1, Math.floor(h * 0.4)));

  ctx.fillStyle = eave;
  if (wTiles >= hTiles) ctx.fillRect(left, top + Math.floor(h / 2), w, 1);
  else ctx.fillRect(left + Math.floor(w / 2), top, 1, h);

  ctx.strokeStyle = eave;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));

  if (stone) {
    const chimSize = Math.max(2, Math.floor(TILE_PX * 0.4));
    ctx.fillStyle = '#38352e';
    ctx.fillRect(left + w - chimSize - 2, top + 2, chimSize, chimSize);
  }
}

function paintWallDetail(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number): void {
  const i = idx(map, wx, wy);
  const bid = map.buildingId[i];
  const dirs: [number, number, 'l' | 'r' | 't' | 'b'][] = [[-1, 0, 'l'], [1, 0, 'r'], [0, -1, 't'], [0, 1, 'b']];
  ctx.fillStyle = 'rgba(20,18,14,0.55)';
  for (const [dx, dy, side] of dirs) {
    const outer = !inBounds(map, wx + dx, wy + dy) || map.buildingId[idx(map, wx + dx, wy + dy)] !== bid;
    if (!outer) continue;
    if (side === 'l') ctx.fillRect(ox, oy, 1, TILE_PX);
    else if (side === 'r') ctx.fillRect(ox + TILE_PX - 1, oy, 1, TILE_PX);
    else if (side === 't') ctx.fillRect(ox, oy, TILE_PX, 1);
    else ctx.fillRect(ox, oy + TILE_PX - 1, TILE_PX, 1);
  }
  if (map.windows[i]) {
    ctx.fillStyle = 'rgba(224,214,164,0.85)';
    for (const [dx, dy, side] of dirs) {
      const outer = !inBounds(map, wx + dx, wy + dy) || map.buildingId[idx(map, wx + dx, wy + dy)] !== bid;
      if (!outer) continue;
      if (side === 'l') ctx.fillRect(ox, oy + 4, 2, 2);
      else if (side === 'r') ctx.fillRect(ox + TILE_PX - 2, oy + 4, 2, 2);
      else if (side === 't') ctx.fillRect(ox + 4, oy, 2, 2);
      else ctx.fillRect(ox + 4, oy + TILE_PX - 2, 2, 2);
    }
  }
}

// --------------------------------------------------------------------- trees
function paintTrees(ctx: CanvasRenderingContext2D, map: GameMap, wx: number, wy: number, ox: number, oy: number, season: Season, seed: number): void {
  const t = tileAt(map, wx, wy);
  if (t === 'woods') {
    const count = hash2(wx, wy, seed + 101) < 0.5 ? 2 : 3;
    for (let i = 0; i < count; i++) {
      const jx = (hash2(wx * 13 + i, wy * 13 + i, seed + 103) - 0.5) * (TILE_PX + 6);
      const jy = (hash2(wx * 13 + i + 5, wy * 13 + i + 5, seed + 107) - 0.5) * (TILE_PX + 6);
      const variant = Math.floor(hash2(wx * 17 + i, wy * 17 + i, seed + 109) * 3);
      const sprite = getTreeSprite(variant, season);
      const cx = ox + TILE_PX / 2 + jx, cy = oy + TILE_PX / 2 + jy;
      ctx.drawImage(sprite, Math.round(cx - sprite.width / 2), Math.round(cy - sprite.height / 2));
    }
  } else if (t === 'scatteredtrees') {
    if (hash2(wx, wy, seed + 111) < 0.5) {
      const jx = (hash2(wx * 19, wy * 19, seed + 113) - 0.5) * 4;
      const jy = (hash2(wx * 23, wy * 23, seed + 117) - 0.5) * 4;
      const variant = Math.floor(hash2(wx * 29, wy * 29, seed + 119) * 3);
      const sprite = getTreeSprite(variant, season);
      const cx = ox + TILE_PX / 2 + jx, cy = oy + TILE_PX / 2 + jy;
      ctx.drawImage(sprite, Math.round(cx - sprite.width / 2), Math.round(cy - sprite.height / 2));
    }
  }
}

// ============================================================================
export class TerrainRenderer {
  private map: GameMap;
  private seed: number;
  private chunksX: number;
  private chunksY: number;
  private chunks = new Map<string, HTMLCanvasElement>();
  private dirty = new Set<string>();
  private buildingBBoxes = new Map<number, BuildingBBox>();

  constructor(map: GameMap) {
    this.map = map;
    this.seed = hashStr(map.def.id) ^ (map.width * 73856093) ^ (map.height * 19349663);
    this.chunksX = Math.max(1, Math.ceil(map.width / CHUNK_TILES));
    this.chunksY = Math.max(1, Math.ceil(map.height / CHUNK_TILES));
    this.computeBuildingBBoxes();
  }

  private computeBuildingBBoxes(): void {
    const map = this.map;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = idx(map, x, y);
        const bid = map.buildingId[i];
        if (bid < 0) continue;
        const isStone = map.tiles[i] === 'buildingStone';
        let bb = this.buildingBBoxes.get(bid);
        if (!bb) {
          bb = { minX: x, minY: y, maxX: x, maxY: y, kind: isStone ? 'stone' : 'wood' };
          this.buildingBBoxes.set(bid, bb);
        } else {
          bb.minX = Math.min(bb.minX, x); bb.minY = Math.min(bb.minY, y);
          bb.maxX = Math.max(bb.maxX, x); bb.maxY = Math.max(bb.maxY, y);
          if (isStone) bb.kind = 'stone';
        }
      }
    }
  }

  private chunkKey(cx: number, cy: number): string { return `${cx},${cy}`; }

  invalidateTile(x: number, y: number): void {
    const cx = Math.floor(x / CHUNK_TILES);
    const cy = Math.floor(y / CHUNK_TILES);
    this.dirty.add(this.chunkKey(cx, cy));
  }

  private getChunk(cx: number, cy: number): HTMLCanvasElement {
    const key = this.chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (!c || this.dirty.has(key)) {
      c = this.bakeChunk(cx, cy);
      this.chunks.set(key, c);
      this.dirty.delete(key);
    }
    return c;
  }

  private bakeChunk(cx: number, cy: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_PX;
    canvas.height = CHUNK_PX;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const season = this.map.def.season;
    const x0 = cx * CHUNK_TILES, y0 = cy * CHUNK_TILES;

    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= this.map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= this.map.width) continue;
        paintBase(ctx, this.map, wx, wy, tx * TILE_PX, ty * TILE_PX, season, this.seed);
      }
    }
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= this.map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= this.map.width) continue;
        if (BUILDING_TERRAINS.has(tileAt(this.map, wx, wy))) continue;
        paintDetail(ctx, this.map, wx, wy, tx * TILE_PX, ty * TILE_PX, this.seed);
      }
    }
    for (const bb of this.buildingBBoxes.values()) {
      if (bb.maxX < x0 || bb.minX >= x0 + CHUNK_TILES || bb.maxY < y0 || bb.minY >= y0 + CHUNK_TILES) continue;
      paintRoof(ctx, bb, x0, y0);
    }
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= this.map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= this.map.width) continue;
        const t = tileAt(this.map, wx, wy);
        if (t === 'buildingWood' || t === 'buildingStone') paintWallDetail(ctx, this.map, wx, wy, tx * TILE_PX, ty * TILE_PX);
      }
    }
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const wy = y0 + ty;
      if (wy >= this.map.height) continue;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const wx = x0 + tx;
        if (wx >= this.map.width) continue;
        paintTrees(ctx, this.map, wx, wy, tx * TILE_PX, ty * TILE_PX, season, this.seed);
      }
    }
    return canvas;
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const px = TILE_PX * cam.zoom;
    const viewTilesW = VIEW_W / px;
    const viewTilesH = VIEW_H / px;
    const startCx = Math.max(0, Math.floor(cam.x / CHUNK_TILES));
    const endCx = Math.min(this.chunksX - 1, Math.floor((cam.x + viewTilesW) / CHUNK_TILES));
    const startCy = Math.max(0, Math.floor(cam.y / CHUNK_TILES));
    const endCy = Math.min(this.chunksY - 1, Math.floor((cam.y + viewTilesH) / CHUNK_TILES));
    for (let cy = startCy; cy <= endCy; cy++) {
      for (let cx = startCx; cx <= endCx; cx++) {
        const chunk = this.getChunk(cx, cy);
        const s = worldToScreen(cam, { x: cx * CHUNK_TILES, y: cy * CHUNK_TILES });
        const size = CHUNK_PX * cam.zoom;
        ctx.drawImage(chunk, s.x, s.y, size, size);
      }
    }
    ctx.restore();
  }

  thumbnail(w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const mapPxW = this.map.width * TILE_PX;
    const mapPxH = this.map.height * TILE_PX;
    const scale = Math.min(w / mapPxW, h / mapPxH);
    const offX = (w - mapPxW * scale) / 2;
    const offY = (h - mapPxH * scale) / 2;
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        const chunk = this.getChunk(cx, cy);
        const dx = offX + cx * CHUNK_TILES * TILE_PX * scale;
        const dy = offY + cy * CHUNK_TILES * TILE_PX * scale;
        ctx.drawImage(chunk, dx, dy, CHUNK_PX * scale, CHUNK_PX * scale);
      }
    }
    return canvas;
  }

  drawOverlays(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const map = state.map;
    const px = TILE_PX * cam.zoom;

    if (map.dirtyTiles && map.dirtyTiles.length) {
      for (const ti of map.dirtyTiles) this.invalidateTile(ti % map.width, Math.floor(ti / map.width));
      map.dirtyTiles.length = 0;
    }

    for (const ti of map.craters) {
      const cx = ti % map.width, cy = Math.floor(ti / map.width);
      const s = worldToScreen(cam, { x: cx + 0.5, y: cy + 0.5 });
      if (s.x < -px || s.x > VIEW_W + px || s.y < -px || s.y > VIEW_H + px) continue;
      const r = px / 2 - 1;
      ctx.beginPath(); ctx.fillStyle = '#2a2a28'; ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.strokeStyle = '#5a5a4a'; ctx.lineWidth = 1; ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#5a1a12';
    for (const p of state.bloodDecals) {
      const s = worldToScreen(cam, p);
      ctx.fillRect(Math.round(s.x - 1), Math.round(s.y - 1), 2, 2);
    }
    ctx.globalAlpha = 1;

    const viewTilesW = VIEW_W / px, viewTilesH = VIEW_H / px;
    const minX = Math.max(0, Math.floor(cam.x) - 1);
    const maxX = Math.min(map.width - 1, Math.ceil(cam.x + viewTilesW) + 1);
    const minY = Math.max(0, Math.floor(cam.y) - 1);
    const maxY = Math.min(map.height - 1, Math.ceil(cam.y + viewTilesH) + 1);
    let count = 0;
    for (let y = minY; y <= maxY && count < 400; y++) {
      for (let x = minX; x <= maxX && count < 400; x++) {
        const d = map.smoke[idx(map, x, y)];
        if (!d || d <= 0.05) continue;
        const jx = (hash2(x, y, 777) - 0.5) * 0.4;
        const jy = (hash2(x, y, 778) - 0.5) * 0.4;
        const s = worldToScreen(cam, { x: x + 0.5 + jx, y: y + 0.5 + jy });
        const sprite = getSmokePuff(24);
        ctx.globalAlpha = Math.min(1, d * 0.9);
        ctx.drawImage(sprite, Math.round(s.x - (sprite.width * cam.zoom) / 2), Math.round(s.y - (sprite.height * cam.zoom) / 2), sprite.width * cam.zoom, sprite.height * cam.zoom);
        count++;
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
