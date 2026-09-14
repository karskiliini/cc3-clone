// ============================================================================
// structures.ts — damage to walls, roofs, buildings, hedges and fences, and the debris casualties
// it causes.
//
// Structure values: wood building wall 60, stone wall 150, stone building wall 200, hedge 40,
// fence 15; roofs (per interior floor tile) wood 50, stone 160.
//
// HE blasts damage structure tiles within a structure-blast radius by the weapon's HE power
// (grenade small, mortar/light guns medium, 75 mm+ large, 122 mm and satchel charges very large;
// AT rockets only the tile they burst on). Direct-fire HE (tank/AT guns) mostly damages the wall
// facing the shooter. Mortar rounds that land on a building are plunging fire: they also hit the
// roof over the burst tile (x1.5 vs wood, x0.8 vs stone) and, at half strength, its neighbours.
//
// At 0:
//   - hedge/fence -> 'open' (flattened), height 0
//   - wall tile   -> breach: 'rubble' (passable, partial cover, no LOS block), +0.6 m lip
//   - roof        -> cave-in: the floor tile below turns to rubble
// A building with more than 30% of its wall tiles breached (or 60% of its roof caved) is DAMAGED:
// the roof over the breached part caves in. Above 70% breached it is RUINED: roof gone, interior
// rubble, the remaining walls reduced to 1.5-3 m stubs.
//
// Debris casualties at every stage (through combat's applyHit, so health transitions and casualty
// messages happen exactly once): a breach hits men on and just inside the breached tile, a cave-in
// hits men under it, a collapse hits everyone inside hard (survivors panic) and men beside the
// outer walls lightly. Hits on a building also stress everyone inside it. Casualty rolls use a
// per-event RNG seeded from the battle time and position, never the battle RNG.
//
// Tile terrain is the sim truth, so cover/LOS/pathing pick changes up immediately; the height
// field and the terrain renderer (map.dirtyTiles) are updated alongside.
// ============================================================================
import type { BattleState, GameMap, Soldier, Terrain, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { Rng, hash2 } from '@/shared/rng';
import { getHeightField, refreshTiles, setTileOverride, syncCraterMarks, buildingIsBig, H_BREACH_LIP } from './heightField';
import { addMessage } from './messages';
import { applyHit } from './combat';
import { addStress } from './mind';

export const STRUCTURE_HP: Partial<Record<Terrain, number>> = {
  buildingWood: 60,
  stonewall: 150,
  buildingStone: 200,
  hedge: 40,
  fence: 15,
};
export const ROOF_HP = { wood: 50, stone: 160 };
export const MORTAR_ROOF_MULT = { wood: 1.5, stone: 0.8 };

export const DAMAGED_FRACTION = 0.3;
export const RUINED_FRACTION = 0.7;
const CAVED_ROOF_DAMAGED_FRACTION = 0.6;

/** Debris casualty tuning: chance a man is hit, and the lethality of the hit. */
export const DEBRIS = {
  breach: { wood: { chance: 0.2, lethality: 0.3 }, stone: { chance: 0.3, lethality: 0.45 } },
  caveIn: { wood: { chance: 0.35, lethality: 0.5 }, stone: { chance: 0.55, lethality: 0.75 } },
  collapse: { wood: { chance: 0.6, lethality: 0.7 }, stone: { chance: 0.8, lethality: 0.9 } },
  outside: { wood: { chance: 0.1, lethality: 0.3 }, stone: { chance: 0.2, lethality: 0.4 } },
};

export type BuildingStatus = 'intact' | 'damaged' | 'ruined';

interface BuildingRec {
  id: number;
  stone: boolean;
  wallTiles: number[];
  floorTiles: number[];
  breached: Set<number>;
  caved: Set<number>;
  status: BuildingStatus;
}

interface StructState {
  hp: Float32Array;          // wall/hedge/fence value; NaN = not a structure
  roofHp: Float32Array;      // roof over a floor tile; NaN = none
  buildings: Map<number, BuildingRec>;
  lastBreachMsgAt: number;
  lastCollapseMsgAt: number;
  lastBuriedMsgAt: Map<number, number>;
  lastCrushedMsgAt: number;
}

/** One blast's accumulated consequences, resolved after all tiles are damaged. */
interface BlastEvent {
  changed: number[];
  breaches: { tile: number; bid: number; stone: boolean; power: number }[];
  caveIns: Map<number, number[]>;     // building id -> tiles caved this blast
  collapses: BuildingRec[];
}

const states = new WeakMap<GameMap, StructState>();

function getState(map: GameMap): StructState {
  let s = states.get(map);
  if (s) return s;
  const n = map.width * map.height;
  const hp = new Float32Array(n).fill(NaN);
  const roofHp = new Float32Array(n).fill(NaN);
  const buildings = new Map<number, BuildingRec>();
  for (let i = 0; i < n; i++) {
    const t = map.tiles[i];
    const v = STRUCTURE_HP[t];
    if (v !== undefined) hp[i] = v;
    const bid = map.buildingId[i];
    if (bid < 0) continue;
    let b = buildings.get(bid);
    if (!b) { b = { id: bid, stone: false, wallTiles: [], floorTiles: [], breached: new Set(), caved: new Set(), status: 'intact' }; buildings.set(bid, b); }
    if (t === 'buildingWood' || t === 'buildingStone') { b.wallTiles.push(i); if (t === 'buildingStone') b.stone = true; }
    else if (t === 'floor') b.floorTiles.push(i);
  }
  for (const b of buildings.values()) for (const fi of b.floorTiles) roofHp[fi] = b.stone ? ROOF_HP.stone : ROOF_HP.wood;
  s = { hp, roofHp, buildings, lastBreachMsgAt: -Infinity, lastCollapseMsgAt: -Infinity, lastBuriedMsgAt: new Map(), lastCrushedMsgAt: -Infinity };
  states.set(map, s);
  return s;
}

/** Remaining structure value of a tile (NaN when it is not a structure). */
export function structureHp(map: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return NaN;
  return getState(map).hp[ty * map.width + tx];
}

/** Remaining roof value over a floor tile (NaN when there is no roof). */
export function roofHp(map: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return NaN;
  return getState(map).roofHp[ty * map.width + tx];
}

export function buildingStatus(map: GameMap, bid: number): BuildingStatus {
  return getState(map).buildings.get(bid)?.status ?? 'intact';
}

/** HE power against structures and the radius (m) it reaches. AT rockets: the burst tile only. */
export function structureBlast(weapon: WeaponDef): { power: number; radiusM: number; singleTile: boolean } | null {
  if (weapon.heRadiusM <= 0 || weapon.cls === 'flamethrower') return null;
  if (weapon.cls === 'atrocket') return { power: 90, radiusM: 0, singleTile: true };
  if (weapon.cls === 'grenade') {
    // a satchel charge is a demolition charge; a stick grenade barely dents a wall
    return weapon.id === 'satchel' ? { power: 260, radiusM: 2.5, singleTile: false } : { power: 22, radiusM: 1.5, singleTile: false };
  }
  if (weapon.cls === 'mortar') return { power: 55, radiusM: 2.5, singleTile: false };
  const r = weapon.heRadiusM;
  if (r >= 8) return { power: 260, radiusM: 5, singleTile: false };     // 122 mm+
  if (r >= 4) return { power: 110, radiusM: 3, singleTile: false };     // 75-88 mm
  return { power: 55, radiusM: 2, singleTile: false };                  // 37-50 mm
}

function isCrushed(t: Terrain): boolean { return t === 'hedge' || t === 'fence'; }
function isWall(t: Terrain): boolean { return t === 'buildingWood' || t === 'buildingStone'; }

/** Where a direct-fire round came from: this tick's tracer ending at the burst. */
function shooterFor(state: BattleState, pos: Vec2, weapon: WeaponDef): Vec2 | null {
  if (weapon.cls !== 'tankgun' && weapon.cls !== 'atgun') return null;
  for (let k = state.tracers.length - 1; k >= 0 && k >= state.tracers.length - 12; k--) {
    const tr = state.tracers[k];
    if (tr.t === 0 && Math.hypot(tr.to.x - pos.x, tr.to.y - pos.y) < 1.5) return tr.from;
  }
  return null;
}

/** Damages structures around an HE burst at `pos` (tile coords) and keeps the height field's
 * craters in step with map.craterMarks. Called by combat.ts next to leaveCrater. */
export function applyBlastDamage(state: BattleState, pos: Vec2, weapon: WeaponDef): void {
  const map = state.map;
  const field = getHeightField(map);
  syncCraterMarks(map, field);
  const blast = structureBlast(weapon);
  if (!blast) return;
  const st = getState(map);
  const tx0 = Math.floor(pos.x), ty0 = Math.floor(pos.y);
  const ev: BlastEvent = { changed: [], breaches: [], caveIns: new Map(), collapses: [] };

  // ---- plunging fire: a mortar round bursting on a building hits its roof
  if (weapon.cls === 'mortar' && tx0 >= 0 && ty0 >= 0 && tx0 < map.width && ty0 < map.height) {
    const bi = ty0 * map.width + tx0;
    const bid = map.buildingId[bi];
    const b = bid >= 0 ? st.buildings.get(bid) : undefined;
    if (b && (map.tiles[bi] === 'floor' || isWall(map.tiles[bi]))) {
      const mult = b.stone ? MORTAR_ROOF_MULT.stone : MORTAR_ROOF_MULT.wood;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = tx0 + dx, y = ty0 + dy;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          const i = y * map.width + x;
          if (map.buildingId[i] !== bid) continue;
          damageRoof(state, st, b, i, blast.power * mult * (dx === 0 && dy === 0 ? 1 : 0.5), ev);
        }
      }
    }
  }

  // ---- walls, hedges and fences within the blast radius
  const hits: { i: number; dmg: number }[] = [];
  if (blast.singleTile) {
    hits.push(...singleTileHit(map, st, pos, blast.power));
  } else {
    const shooter = shooterFor(state, pos, weapon);
    const rT = blast.radiusM / TILE_M;
    const reach = Math.ceil(rT);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = tx0 + dx, y = ty0 + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const i = y * map.width + x;
        if (Number.isNaN(st.hp[i])) continue;
        // distance (m) from the burst to the nearest point of the tile
        const ex = Math.max(x - pos.x, 0, pos.x - (x + 1));
        const ey = Math.max(y - pos.y, 0, pos.y - (y + 1));
        const dM = Math.hypot(ex, ey) * TILE_M;
        if (dM > blast.radiusM) continue;
        let dmg = blast.power * (1 - 0.75 * (dM / Math.max(0.01, blast.radiusM)));
        if (shooter && dM > 0) {
          // direct fire: the face toward the gun takes the blast, walls behind the burst much less
          const vx = x + 0.5 - pos.x, vy = y + 0.5 - pos.y, sx = shooter.x - pos.x, sy = shooter.y - pos.y;
          const dot = (vx * sx + vy * sy) / Math.max(1e-6, Math.hypot(vx, vy) * Math.hypot(sx, sy));
          if (dot < -0.2) dmg *= 0.35;
        }
        hits.push({ i, dmg });
      }
    }
  }
  for (const h of hits) damageTile(state, st, h.i, h.dmg, blast.power, ev);

  resolveCasualties(state, st, ev, pos);
  stressOccupants(state, pos, blast.power);
  if (ev.changed.length) finishChanges(state, ev.changed);
}

/** The structure tile an AT rocket bursts on: the burst tile itself, else the nearest adjacent
 * structure tile (the round detonates against the wall face). */
function singleTileHit(map: GameMap, st: StructState, pos: Vec2, power: number): { i: number; dmg: number }[] {
  const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
  let best = -1, bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = tx + dx, y = ty + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const i = y * map.width + x;
      if (Number.isNaN(st.hp[i])) continue;
      const d = Math.hypot(x + 0.5 - pos.x, y + 0.5 - pos.y);
      if (d < bestD && d <= 1.2) { bestD = d; best = i; }
    }
  }
  return best >= 0 ? [{ i: best, dmg: power }] : [];
}

function damageRoof(state: BattleState, st: StructState, b: BuildingRec, i: number, dmg: number, ev: BlastEvent): void {
  if (Number.isNaN(st.roofHp[i]) || state.map.tiles[i] !== 'floor') return;
  st.roofHp[i] = Math.max(0, st.roofHp[i] - dmg);
  if (st.roofHp[i] > 0) return;
  caveIn(state, st, b, i, ev);
  if (b.status === 'intact' && b.floorTiles.length > 0 && b.caved.size / b.floorTiles.length >= CAVED_ROOF_DAMAGED_FRACTION) {
    b.status = 'damaged';
    for (const wi of b.wallTiles) ev.changed.push(wi);
  }
}

function caveIn(state: BattleState, st: StructState, b: BuildingRec, i: number, ev: BlastEvent): void {
  const map = state.map;
  if (map.tiles[i] !== 'floor') return;
  map.tiles[i] = 'rubble';
  st.roofHp[i] = NaN;
  b.caved.add(i);
  ev.changed.push(i);
  let arr = ev.caveIns.get(b.id);
  if (!arr) { arr = []; ev.caveIns.set(b.id, arr); }
  arr.push(i);
}

function damageTile(state: BattleState, st: StructState, i: number, dmg: number, power: number, ev: BlastEvent): void {
  if (Number.isNaN(st.hp[i]) || st.hp[i] <= 0) return;
  st.hp[i] = Math.max(0, st.hp[i] - dmg);
  if (st.hp[i] > 0) return;
  destroyTile(state, st, i, power, ev);
}

function destroyTile(state: BattleState, st: StructState, i: number, power: number, ev: BlastEvent): void {
  const map = state.map;
  const t = map.tiles[i];
  const x = i % map.width, y = (i / map.width) | 0;
  st.hp[i] = NaN;
  if (isCrushed(t)) {
    map.tiles[i] = 'open';
    ev.changed.push(i);
    return;
  }
  // wall breach
  const stone = t !== 'buildingWood';
  map.tiles[i] = 'rubble';
  map.windows[i] = 0;
  ev.changed.push(i);
  setTileOverride(map, x, y, H_BREACH_LIP);
  notifyBreach(state, st, { x: x + 0.5, y: y + 0.5 });
  const bid = map.buildingId[i];
  ev.breaches.push({ tile: i, bid, stone, power });
  if (bid >= 0) {
    const b = st.buildings.get(bid);
    if (b) { b.breached.add(i); updateBuilding(state, st, b, ev); }
  }
}

function updateBuilding(state: BattleState, st: StructState, b: BuildingRec, ev: BlastEvent): void {
  const map = state.map;
  if (b.wallTiles.length === 0) return;
  const frac = b.breached.size / b.wallTiles.length;
  const prev = b.status;
  if (frac > RUINED_FRACTION) b.status = 'ruined';
  else if (frac > DAMAGED_FRACTION && b.status === 'intact') b.status = 'damaged';

  if (b.status === 'ruined') {
    if (prev === 'ruined') return;
    for (const fi of b.floorTiles) if (map.tiles[fi] === 'floor') { map.tiles[fi] = 'rubble'; st.roofHp[fi] = NaN; b.caved.add(fi); ev.changed.push(fi); }
    for (const wi of b.wallTiles) {
      const wt = map.tiles[wi];
      if (!isWall(wt)) continue;
      const wx = wi % map.width, wy = (wi / map.width) | 0;
      if (b.stone) {
        // a jagged stub of the outer wall still stands: low stone wall (cover, blocks sight)
        map.tiles[wi] = 'stonewall';
        st.hp[wi] = STRUCTURE_HP.stonewall! * 0.5;
        setTileOverride(map, wx, wy, 2 + hash2(wx, wy, 6101) * 1);
      } else {
        map.tiles[wi] = 'rubble';
        st.hp[wi] = NaN;
        setTileOverride(map, wx, wy, 1.5);
      }
      map.windows[wi] = 0;
      ev.changed.push(wi);
    }
    ev.collapses.push(b);
    notifyCollapse(state, st, b);
  } else if (b.status === 'damaged') {
    // the roof caves in over the breached part: floor within 2 tiles of a breach
    for (const fi of b.floorTiles) {
      if (map.tiles[fi] !== 'floor') continue;
      const fx = fi % map.width, fy = (fi / map.width) | 0;
      for (const bi of b.breached) {
        const bx = bi % map.width, by = (bi / map.width) | 0;
        if (Math.abs(bx - fx) <= 2 && Math.abs(by - fy) <= 2) { caveIn(state, st, b, fi, ev); break; }
      }
    }
  }
  if (prev !== b.status) for (const wi of b.wallTiles) ev.changed.push(wi); // roof look changed
}

// ------------------------------------------------------------------ casualties
function debrisWeapon(lethality: number): WeaponDef {
  return {
    id: 'debris', name: 'Falling masonry', cls: 'grenade', rangeM: 0, rate: 0, burst: 1, accuracy: 1,
    lethality, suppression: 0.8, penetrationMm: 0, heRadiusM: 0, ammo: 0, reloadS: 0,
  };
}

function alive(s: Soldier): boolean {
  return s.health !== 'dead' && s.health !== 'incapacitated' && s.vehicleId == null;
}

function soldiersOnTiles(state: BattleState, tiles: Set<number>): Soldier[] {
  const map = state.map;
  const out: Soldier[] = [];
  for (const s of state.soldiers.values()) {
    if (!alive(s)) continue;
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
    if (tiles.has(y * map.width + x)) out.push(s);
  }
  return out;
}

/** One debris hit through combat's applyHit (health transitions + the single casualty message).
 * A player-side death's message is reworded to "was crushed by debris." (rate-limited; otherwise
 * applyHit's own message stands) — never a second message. */
function debrisHit(state: BattleState, st: StructState, s: Soldier, lethality: number, rng: Rng): void {
  const lastBefore = state.messages[state.messages.length - 1];
  applyHit(state, s, debrisWeapon(lethality), rng);
  if (s.health !== 'dead' || s.side !== state.config.playerSide) return;
  const msg = state.messages[state.messages.length - 1];
  if (!msg || msg === lastBefore || !/has been killed\.$/.test(msg.text)) return;
  if (state.time - st.lastCrushedMsgAt < 3) return;
  st.lastCrushedMsgAt = state.time;
  msg.text = msg.text.replace(/has been killed\.$/, 'was crushed by debris.');
}

function eventRng(state: BattleState, pos: Vec2, salt: number): Rng {
  return new Rng((Math.floor(state.time * 10) * 7919 + Math.floor(pos.x * 16) * 104729 + Math.floor(pos.y * 16) * 1299709 + salt * 15485863) >>> 0);
}

function resolveCasualties(state: BattleState, st: StructState, ev: BlastEvent, pos: Vec2): void {
  const map = state.map;
  const rng = eventRng(state, pos, ev.changed.length);
  const w = map.width;

  // (a) breaches: men on the breached tile and directly inside it
  for (const br of ev.breaches) {
    if (br.bid < 0) continue;
    const tiles = new Set<number>([br.tile]);
    const bx = br.tile % w, by = (br.tile / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = bx + dx, ny = by + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
      const ni = ny * w + nx;
      if (map.buildingId[ni] === br.bid && map.tiles[ni] !== 'stonewall' && !isWall(map.tiles[ni])) tiles.add(ni);
    }
    const tune = br.stone ? DEBRIS.breach.stone : DEBRIS.breach.wood;
    const chance = tune.chance * Math.max(0.5, Math.min(1.4, br.power / 110));
    for (const s of soldiersOnTiles(state, tiles)) if (rng.chance(chance)) debrisHit(state, st, s, tune.lethality, rng);
  }

  // (b) roof cave-ins: men under the caved part
  for (const [bid, caved] of ev.caveIns) {
    const b = st.buildings.get(bid);
    if (!b || ev.collapses.includes(b)) continue;
    const tune = b.stone ? DEBRIS.caveIn.stone : DEBRIS.caveIn.wood;
    const victims = soldiersOnTiles(state, new Set(caved));
    const teams = new Set<number>();
    for (const s of victims) {
      if (s.side === state.config.playerSide) teams.add(s.teamId);
      addStress(s.mind, 25);
      if (rng.chance(tune.chance)) debrisHit(state, st, s, tune.lethality, rng);
    }
    for (const tid of teams) notifyBuried(state, st, tid);
  }

  // (c) collapse: everyone inside hard, survivors panic; (d) men beside the outer walls lightly
  for (const b of ev.collapses) {
    const inside = new Set<number>([...b.wallTiles, ...b.floorTiles]);
    const outside = new Set<number>();
    for (const wi of b.wallTiles) {
      const x = wi % w, y = (wi / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
        const ni = ny * w + nx;
        if (map.buildingId[ni] !== b.id) outside.add(ni);
      }
    }
    const tIn = b.stone ? DEBRIS.collapse.stone : DEBRIS.collapse.wood;
    const tOut = b.stone ? DEBRIS.outside.stone : DEBRIS.outside.wood;
    for (const s of soldiersOnTiles(state, inside)) {
      if (rng.chance(tIn.chance)) debrisHit(state, st, s, tIn.lethality, rng);
      if (alive(s)) {
        addStress(s.mind, 60);
        s.mind.state = 'panicked';
        s.mind.stateSince = state.time;
        s.activity = 'panicked';
        s.path = [];
      }
    }
    for (const s of soldiersOnTiles(state, outside)) {
      if (rng.chance(tOut.chance)) debrisHit(state, st, s, tOut.lethality, rng);
      else addStress(s.mind, 20);
    }
  }
}

/** Dust and falling plaster: men inside a building within 4 tiles of a hit on it take stress
 * (experienced men less). */
function stressOccupants(state: BattleState, pos: Vec2, power: number): void {
  const map = state.map;
  const tx = Math.floor(pos.x), ty = Math.floor(pos.y);
  // buildings touched by the burst (its tile and neighbours)
  const hit = new Set<number>();
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = tx + dx, y = ty + dy;
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
    const bid = map.buildingId[y * map.width + x];
    if (bid >= 0) hit.add(bid);
  }
  if (!hit.size) return;
  const base = 6 + power / 20;
  for (const s of state.soldiers.values()) {
    if (!alive(s)) continue;
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
    if (!hit.has(map.buildingId[y * map.width + x])) continue;
    const d = Math.hypot(s.pos.x - pos.x, s.pos.y - pos.y);
    if (d > 4) continue;
    addStress(s.mind, base * (1 - d / 5) * (1.3 - s.experience / 100));
  }
}

// ------------------------------------------------------------------ messages
function nearPlayerUnits(state: BattleState, p: Vec2, rTiles: number): boolean {
  const side = state.config.playerSide;
  for (const s of state.soldiers.values()) {
    if (s.side !== side || s.health === 'dead') continue;
    if (Math.abs(s.pos.x - p.x) <= rTiles && Math.abs(s.pos.y - p.y) <= rTiles) return true;
  }
  return false;
}

function notifyBreach(state: BattleState, st: StructState, p: Vec2): void {
  if (state.time - st.lastBreachMsgAt < 8) return;
  if (!nearPlayerUnits(state, p, 25)) return;
  st.lastBreachMsgAt = state.time;
  addMessage(state, 'Wall breached.', 'warn');
}

function notifyCollapse(state: BattleState, st: StructState, b: BuildingRec): void {
  if (state.time - st.lastCollapseMsgAt < 5) return;
  st.lastCollapseMsgAt = state.time;
  const name = b.stone ? (buildingIsBig(state.map, b.id) ? 'Tenement block' : 'Stone house') : 'Wooden house';
  addMessage(state, `${name} has collapsed.`, 'warn');
}

function notifyBuried(state: BattleState, st: StructState, teamId: number): void {
  const last = st.lastBuriedMsgAt.get(teamId) ?? -Infinity;
  if (state.time - last < 6) return;
  st.lastBuriedMsgAt.set(teamId, state.time);
  const team = state.teams.get(teamId);
  addMessage(state, `${team?.name ?? 'Report'}\nWe're being buried in here!`, 'bad');
}

function finishChanges(state: BattleState, changed: number[]): void {
  const map = state.map;
  refreshTiles(map, changed);
  const dirty = (map.dirtyTiles ??= []);
  if (dirty.length < 20000) for (const i of changed) dirty.push(i);
}

/** A vehicle drove over a crushable tile (hedge/fence): flatten it through the same path as a
 * blast so the height field and renderer stay in step. Returns true when the tile changed. */
export function crushTile(map: GameMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  const i = ty * map.width + tx;
  const t = map.tiles[i];
  if (t === 'open') return false;
  const st = states.get(map);
  if (st) st.hp[i] = NaN;
  map.tiles[i] = 'open';
  if (map.heightField) refreshTiles(map, [i]);
  const dirty = (map.dirtyTiles ??= []);
  if (dirty.length < 20000) dirty.push(i);
  return true;
}
