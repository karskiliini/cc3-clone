// ============================================================================
// hoverInfo.ts — the word or two by the pointer naming what is under it on the
// battle map: a unit ("Rifle Squad", "PzKw IV H", "T-34/76 (burning)", "Dead"),
// a victory location, a building ("Stone house", "Barn") or the ground itself
// ("Wheat field", "Woods", "Road", "Crater"). Only what the player's side can
// know: enemy men and vehicles are named only while spotted.
//
// It shares one small box with the elevation readout (and the fire-order
// status word), placed below-right of the pointer and pushed clear of the
// hovered unit so the label never covers it.
// ============================================================================
import type { BattleState, Camera, GameMap, Season, Side, Soldier, Terrain, Vec2, Vehicle } from '@/shared/types';
import { TILE_M, TILE_PX, VIEW_W } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { dist } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import { drawText, textWidth } from '@/render/pixelfont';

export type HoverTone = 'own' | 'enemy' | 'dead' | 'place';

export interface HoverInfo {
  text: string;
  tone: HoverTone;
  /** The hovered unit (tile coords) and its size, so the label can be kept off it. */
  anchor?: Vec2;
  clearM?: number;
}

export const HOVER_TONE_COLOR: Record<HoverTone, string> = {
  own: '#bfe6a4',
  enemy: '#f4a488',
  dead: '#a8a8a0',
  place: '#f0ead0',
};

/** Pick radius around a man, in screen px (as forgiving as selection). */
const SOLDIER_PICK_PX = 12;
/** Extra slop around a vehicle's hull, in screen px. */
const HULL_SLOP_PX = 4;
/** A victory location's name shows within this many metres of its flag. */
const VL_RADIUS_M = 6;

function known(state: BattleState, viewer: Side, side: Side, id: number, vehicle: boolean): boolean {
  if (side === viewer) return true;
  return (vehicle ? state.spottedVehicles[viewer] : state.spotted[viewer]).has(id);
}

function onHull(v: Vehicle, p: Vec2, slopTiles: number): boolean {
  const def = VEHICLE_DEFS[v.defId];
  if (!def) return dist(v.pos, p) <= 1.5;
  const dx = p.x - v.pos.x, dy = p.y - v.pos.y;
  const sin = Math.sin(v.hullFacing), cos = Math.cos(v.hullFacing); // 0 = north, clockwise
  const along = dx * sin - dy * cos;
  const across = dx * cos + dy * sin;
  return Math.abs(along) <= def.lengthM / TILE_M / 2 + slopTiles && Math.abs(across) <= def.widthM / TILE_M / 2 + slopTiles;
}

/** "T-34/76", with what the player can tell of its state: "(burning)", "(KO)", "(abandoned)";
 * for his own vehicles also "(immobilized)". */
export function vehicleLabel(v: Vehicle, viewer: Side): string {
  const name = VEHICLE_DEFS[v.defId]?.name ?? 'Vehicle';
  const tag = v.state === 'burning' ? 'burning' : v.state === 'knockedOut' ? 'KO' : v.state === 'abandoned' ? 'abandoned'
    : v.state === 'immobilized' && v.side === viewer ? 'immobilized' : '';
  return tag ? `${name} (${tag})` : name;
}

const TERRAIN_NAME: Record<Terrain, string> = {
  open: 'Open ground', grass: 'Grass', tallgrass: 'Tall grass', crops: 'Wheat field',
  dirtroad: 'Dirt road', pavedroad: 'Road', woods: 'Woods', scatteredtrees: 'Trees',
  buildingWood: 'Wooden house', buildingStone: 'Stone house', floor: 'House',
  rubble: 'Rubble', stonewall: 'Stone wall', hedge: 'Hedge', fence: 'Fence', water: 'Water',
  bridge: 'Bridge', snow: 'Snow', mud: 'Mud', crater: 'Crater', trench: 'Trench',
};

/** The ground's name, with the season's look: bare ground and grass read as snow in winter. */
export function terrainLabel(t: Terrain, season: Season): string {
  if (season === 'winter') {
    if (t === 'open' || t === 'grass') return 'Snow';
    if (t === 'crops') return 'Snowy field';
    if (t === 'water') return 'Ice';
  }
  return TERRAIN_NAME[t] ?? 'Ground';
}

interface BuildingInfo { tiles: number; stone: number; wood: number }
const buildingCache = new WeakMap<GameMap, Map<number, BuildingInfo>>();

function buildingInfo(map: GameMap, id: number): BuildingInfo | undefined {
  let byId = buildingCache.get(map);
  if (!byId) {
    byId = new Map();
    for (let i = 0; i < map.buildingId.length; i++) {
      const b = map.buildingId[i];
      if (b < 0) continue;
      let info = byId.get(b);
      if (!info) { info = { tiles: 0, stone: 0, wood: 0 }; byId.set(b, info); }
      info.tiles++;
      if (map.tiles[i] === 'buildingStone') info.stone++;
      else if (map.tiles[i] === 'buildingWood') info.wood++;
    }
    buildingCache.set(map, byId);
  }
  return byId.get(id);
}

/** A building's name from its material and footprint (in tiles, as first laid out): small wooden
 * ones are sheds, big ones barns, the rest houses; stone ones are houses or, when large, buildings. */
export function buildingLabel(stone: boolean, tiles: number): string {
  if (stone) return tiles <= 16 ? 'Stone shed' : tiles >= 150 ? 'Stone building' : 'Stone house';
  return tiles <= 16 ? 'Shed' : tiles >= 35 ? 'Barn' : 'Wooden house';
}

/** What the ground under `p` is called: a victory location near its flag, a building, a foxhole,
 * a crater, a wreck on the map dressing, or the terrain type. */
export function placeLabelAt(map: GameMap, p: Vec2): string | null {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  for (const vl of map.victoryLocations) {
    if (dist(vl, p) * TILE_M <= VL_RADIUS_M) return vl.name;
  }
  const i = y * map.width + x;
  const t = map.tiles[i];
  const bid = map.buildingId[i];
  if (bid >= 0 && (t === 'buildingWood' || t === 'buildingStone' || t === 'floor')) {
    const info = buildingInfo(map, bid);
    if (info) return buildingLabel(info.stone > info.wood, info.tiles);
  }
  for (const d of map.def.decor ?? []) {
    if (d.kind === 'foxhole' && dist(d, p) <= 1) return 'Foxhole';
    if (d.kind === 'wreck' && dist(d, p) <= 1.5) return 'Wreck';
  }
  if (t !== 'crater' && (map.craters.includes(i)
    || (map.craterMarks ?? []).some((c) => c.kind === 'shell' && dist(c, p) * TILE_M <= Math.max(1, c.sizeM / 2)))) return 'Crater';
  return terrainLabel(t, map.def.season);
}

/** What the player's side can tell is under the map point `p` (tile coords): a man or vehicle of
 * its own, a spotted enemy one, or else the place. `pxPerTile` sets the pick radii so a man is as
 * easy to point at at any zoom. Hidden enemies never show: an unspotted man or tank reads as the
 * ground he stands on. */
export function hoverInfoAt(state: BattleState, viewer: Side, p: Vec2, pxPerTile: number = TILE_PX, showDead = true): HoverInfo | null {
  const pickTiles = SOLDIER_PICK_PX / pxPerTile;
  // a man in the open (not riding): the nearest living one first, then the fallen
  let live: { d: number; s: Soldier } | null = null;
  let fallen: { d: number; s: Soldier } | null = null;
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null) continue;
    const d = dist(s.pos, p);
    if (d > pickTiles) continue;
    if (!known(state, viewer, s.side, s.id, false)) continue;
    const down = s.health === 'dead' || s.health === 'incapacitated';
    if (down) { if ((showDead || s.health !== 'dead') && (!fallen || d < fallen.d)) fallen = { d, s }; }
    else if (!live || d < live.d) live = { d, s };
  }
  const manInfo = (s: Soldier): HoverInfo => {
    const tone: HoverTone = s.health === 'dead' ? 'dead' : s.side === viewer ? 'own' : 'enemy';
    let text: string;
    if (s.health === 'dead') text = 'Dead';
    else if (s.health === 'incapacitated') text = 'Wounded';
    else if (s.activity === 'surrendered') text = 'Surrendered';
    else text = state.teams.get(s.teamId)?.name ?? 'Soldier';
    return { text, tone, anchor: s.pos, clearM: 1 };
  };
  if (live) return manInfo(live.s);
  // a vehicle hull (wrecks included)
  const slop = HULL_SLOP_PX / pxPerTile;
  let veh: Vehicle | null = null;
  for (const v of state.vehicles.values()) {
    if (!known(state, viewer, v.side, v.id, true)) continue;
    if (onHull(v, p, slop) && (!veh || dist(v.pos, p) < dist(veh.pos, p))) veh = v;
  }
  if (veh) {
    const def = VEHICLE_DEFS[veh.defId];
    const dead = veh.state === 'knockedOut' || veh.state === 'burning' || veh.state === 'abandoned';
    return {
      text: vehicleLabel(veh, viewer), tone: dead ? 'dead' : veh.side === viewer ? 'own' : 'enemy',
      anchor: veh.pos, clearM: def ? Math.max(def.lengthM, def.widthM) / 2 : 3,
    };
  }
  if (fallen) return manInfo(fallen.s);
  const place = placeLabelAt(state.map, p);
  return place ? { text: place, tone: 'place' } : null;
}

export interface ReadoutLine { text: string; color: string }

/** Top-left of the pointer readout box: below-right of the pointer (further out while the big
 * aiming cross is up), pushed below the hovered unit so it never covers it, flipped left at the
 * right edge of the view. */
export function readoutOrigin(mouse: Vec2, boxW: number, opts: { bigCursor?: boolean; clearBelowY?: number } = {}): Vec2 {
  const off = opts.bigCursor ? 24 : 16;
  let x = Math.round(mouse.x + off);
  let y = Math.round(mouse.y + (opts.bigCursor ? 26 : 18));
  if (opts.clearBelowY != null) y = Math.max(y, Math.round(opts.clearBelowY + 4));
  if (x + boxW + 3 > VIEW_W) x = Math.round(mouse.x - boxW - off + 4);
  return { x, y };
}

const LINE_H = 9;

/** Draws the pointer readout: one small dark box with a line per entry in the HUD pixel font. */
export function drawPointerReadout(
  ctx: CanvasRenderingContext2D, cam: Camera, mouse: Vec2, lines: ReadoutLine[],
  opts: { bigCursor?: boolean; hover?: HoverInfo | null } = {},
): void {
  if (lines.length === 0) return;
  const w = Math.max(...lines.map((l) => textWidth(l.text)));
  let clearBelowY: number | undefined;
  const h = opts.hover;
  if (h?.anchor && h.clearM != null) {
    const a = worldToScreen(cam, h.anchor);
    const r = h.clearM * (TILE_PX * cam.zoom) / TILE_M;
    // only when the box would otherwise land on the unit
    if (mouse.y + 18 < a.y + r) clearBelowY = a.y + r;
  }
  const o = readoutOrigin(mouse, w, { bigCursor: opts.bigCursor, clearBelowY });
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(o.x - 3, o.y - 2, w + 6, lines.length * LINE_H + 2);
  lines.forEach((l, i) => drawText(ctx, l.text, o.x, o.y + i * LINE_H, l.color));
}
