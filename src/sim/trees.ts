// Trees are crushable obstacles. Felled trunks become low rubble cover, retaining a
// direction and time for the renderer's falling animation. Wheels do not flatten woods.
import type { BattleState, GameMap, Side, Soldier, Terrain, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { tileAt, idx, inBounds } from './map';
import { TERRAIN_PROPS } from './terrain';
import { crushTile } from './structures';
import { refreshTiles } from './heightField';
import { addMessage } from './messages';
import { addStress } from './mind';
import { applyHit } from './combat';
import * as dm from '@/shared/dmath';

/** A burning tree tile burns this many seconds before dying to rubble. */
export const TREE_BURN_S = 45;
/** Seconds between spread checks on one burning tile. */
export const TREE_SPREAD_INTERVAL_S = 2;
/** Base chance per check that ONE adjacent tree tile catches. */
export const TREE_SPREAD_CHANCE = 0.35;
/** HE blast with at least this radius can ignite a felled tree tile. */
export const TREE_IGNITE_RADIUS_M = 3;
/** Chance an HE burst of igniting size sets the tree alight. */
export const TREE_IGNITE_CHANCE = 0.4;
/** Damage a soldier standing IN fire takes per second (roll gate). */
export const FIRE_TICK_S = 1;
/** Chance per tick of a lethal-grade hit for a man IN the fire; adjacent: half, and mostly wounds. */
export const FIRE_IN_CHANCE = 0.3;
export const FIRE_ADJACENT_CHANCE = 0.1;

interface TreeFire {
  ignitedAt: number;
  lastSpreadAt: number;
  lastDamageAt: number;
}
const fires = new WeakMap<GameMap, Map<number, TreeFire>>();

function fireMap(map: GameMap): Map<number, TreeFire> {
  let m = fires.get(map);
  if (!m) { m = new Map(); fires.set(map, m); }
  return m;
}

export function treeTileAt(map: GameMap, x: number, y: number): Terrain | null {
  if (!inBounds(map, Math.floor(x), Math.floor(y))) return null;
  const t = tileAt(map, Math.floor(x), Math.floor(y));
  return t === 'woods' || t === 'scatteredtrees' ? t : null;
}

const TREE_TILES = new Set<Terrain>(['woods', 'scatteredtrees']);

const shotDamage = new WeakMap<GameMap, Map<number, number>>();
/** Branch/trunk damage persists across bursts. Removal uses the terrain/height/render refresh
 * path used by vehicle crushing, so a cleared lane really becomes visible and passable. */
export function damageVegetation(map: GameMap, tx: number, ty: number, damage: number): boolean {
  if (!inBounds(map, tx, ty)) return false;
  const terrain = tileAt(map, tx, ty);
  const strength = terrain === 'woods' ? 40 : terrain === 'scatteredtrees' ? 24 : terrain === 'hedge' ? 10 : 0;
  if (!strength) return false;
  let hits = shotDamage.get(map);
  if (!hits) { hits = new Map(); shotDamage.set(map, hits); }
  const i = idx(map, tx, ty), total = (hits.get(i) ?? 0) + damage;
  if (total < strength) { hits.set(i, total); return false; }
  hits.delete(i);
  fires.get(map)?.delete(i);
  return terrain === 'hedge' ? crushTile(map, tx, ty) : fellTree(map, tx, ty, 0, 0);
}

/** Replace canopy by low trunk/brash cover; keep this persistent even after the dust clears. */
function fellTree(map: GameMap, tx: number, ty: number, facing: number, time: number): boolean {
  if (!treeTileAt(map, tx, ty)) return false;
  crushTile(map, tx, ty);
  const i = idx(map, tx, ty);
  map.tiles[i] = 'rubble';
  (map.fallenTrees ??= new Map()).set(i, { facing, fellAt: time });
  if (map.heightField) refreshTiles(map, [i]);
  return true;
}

/** Called only for tracked armour, including light tanks. */
export function treeCrushByVehicle(map: GameMap, tx: number, ty: number, lengthM: number, facing = 0, time = 0): boolean {
  if (!inBounds(map, tx, ty) || lengthM <= 0) return false;
  return fellTree(map, tx, ty, facing, time);
}

/** HE burst at `pos` with `weapon`: fell trees it reaches; large HE may ignite
 * the felled wood. Called from combat's heBurstAt paths. */
export function treesInBlast(state: BattleState, rng: Rng, pos: Vec2, weapon: WeaponDef): void {
  const map = state.map;
  const rTiles = weapon.heRadiusM / TILE_M;
  if (rTiles <= 0) return;
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y);
  const r = Math.ceil(rTiles);
  for (let ty = cy - r; ty <= cy + r; ty++) {
    for (let tx = cx - r; tx <= cx + r; tx++) {
      if (!inBounds(map, tx, ty)) continue;
      const t = tileAt(map, tx, ty);
      if (!TREE_TILES.has(t)) continue;
      const d = dm.hypot(tx + 0.5 - pos.x, ty + 0.5 - pos.y);
      if (d > rTiles) continue;
      const crushed = fellTree(map, tx, ty, dm.atan2(tx + 0.5 - pos.x, -(ty + 0.5 - pos.y)), state.time);
      if (crushed && weapon.heRadiusM >= TREE_IGNITE_RADIUS_M && rng.chance(TREE_IGNITE_CHANCE)) {
        igniteTree(state, tx, ty);
      }
    }
  }
}

export function igniteTree(state: BattleState, tx: number, ty: number): void {
  const map = state.map;
  if (!inBounds(map, tx, ty)) return;
  const i = idx(map, tx, ty);
  if (!TREE_TILES.has(tileAt(map, tx, ty)) && !map.fallenTrees?.has(i)) return;
  const m = fireMap(map);
  if (m.has(i)) return;
  m.set(i, { ignitedAt: state.time, lastSpreadAt: state.time, lastDamageAt: state.time });
}

/** Positions of burning tree tiles (dodge/avoid machinery reads this). */
export function treeFires(map: GameMap): Vec2[] {
  const m = fires.get(map);
  if (!m || m.size === 0) return [];
  const out: Vec2[] = [];
  for (const i of m.keys()) out.push({ x: (i % map.width) + 0.5, y: ((i / map.width) | 0) + 0.5 });
  return out;
}

export function treeBurningAt(map: GameMap, x: number, y: number): boolean {
  const i = Math.floor(y) * map.width + Math.floor(x);
  return fires.get(map)?.has(i) ?? false;
}

const NEIGHBOURS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Per sim step: spread, age out, damage men. Deterministic seeded rng. */
export function stepTreeFires(state: BattleState, rng: Rng, dt: number): void {
  const map = state.map;
  const m = fireMap(map);
  if (m.size === 0) return;
  const dead: number[] = [];
  for (const [i, f] of m) {
    const tx = i % map.width, ty = (i / map.width) | 0;
    // spread
    if (state.time - f.lastSpreadAt >= TREE_SPREAD_INTERVAL_S) {
      f.lastSpreadAt = state.time;
      const age = state.time - f.ignitedAt;
      const p = TREE_SPREAD_CHANCE * Math.min(1, age / 10);
      if (rng.chance(p)) {
        const [dx, dy] = NEIGHBOURS[(rng.next() * NEIGHBOURS.length) | 0];
        const nx = tx + dx, ny = ty + dy;
        if (inBounds(map, nx, ny) && TREE_TILES.has(tileAt(map, nx, ny))) igniteTree(state, nx, ny);
      }
    }
    // burn out
    if (state.time - f.ignitedAt >= TREE_BURN_S) {
      fellTree(map, tx, ty, 0, state.time); // standing trees fall into charcoal and brash
      dead.push(i);
      continue;
    }
    // damage men on / beside the fire
    if (state.time - f.lastDamageAt < FIRE_TICK_S) continue;
    f.lastDamageAt = state.time;
    const centre = { x: tx + 0.5, y: ty + 0.5 };
    for (const s of state.soldiers.values()) {
      if (s.health === 'dead' || s.vehicleId != null) continue;
      const dTiles = dist(s.pos, centre);
      const inFire = dTiles <= 0.75;
      const adjacent = !inFire && dTiles <= 1.5;
      if (!inFire && !adjacent) continue;
      if (rng.chance(inFire ? FIRE_IN_CHANCE : FIRE_ADJACENT_CHANCE)) {
        applyHit(state, s, fakeFireWeapon(), rng, undefined);
      }
      addStress(s.mind, inFire ? 12 : 5);
      if (inFire) dodgeFire(state, s);
    }
  }
  for (const i of dead) m.delete(i);
}

/** A man standing in fire sprints away: straight path to the nearest tile not
 * within 2 tiles of any burning tree, at dodge speed (movement.ts honours
 * `dodgeUntil` whatever his state). */
function dodgeFire(state: BattleState, s: Soldier): void {
  const fires = treeFires(state.map);
  if (fires.length === 0) return;
  const clear = (p: Vec2): boolean => fires.every((f) => dist(f, p) > 2);
  if (clear(s.pos)) return;
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (let r = 2; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = { x: Math.floor(s.pos.x) + dx + 0.5, y: Math.floor(s.pos.y) + dy + 0.5 };
        if (!clear(p)) continue;
        const d = dist(p, s.pos);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    if (best) break;
  }
  if (!best) return;
  s.path = [best];
  s.dodgeUntil = state.time + 2;
  const team = state.teams.get(s.teamId);
  if (team && !team.outOfAction) addMessage(state, `${team.name}\nMen are getting clear of the fire!`, 'warn', team.side);
}

let fireWeapon: WeaponDef | null = null;
/** The hit profile of fire itself: no penetration, no splash, brutal up close. */
function fakeFireWeapon(): WeaponDef {
  fireWeapon ??= {
    id: 'treefire', name: 'Fire', cls: 'flamethrower', rangeM: 0, rate: 0, burst: 1,
    accuracy: 0, lethality: 0.85, suppression: 0.3, penetrationMm: 0, heRadiusM: 0,
    ammo: 0, reloadS: 0,
  };
  return fireWeapon;
}

/** coverSeek / mind threat extension: burning trees weigh into cover choice via
 * the same hazard list burning vehicles use. Re-exported for orders.ts's route cost. */
export function treeFireHazardCostTiles(map: GameMap): number {
  return fires.get(map)?.size ?? 0;
}
