// ============================================================================
// pickup.ts — picking things up is an individual decision (spec 2026-09-17 §9).
//
// Each able soldier looks around him at most once a second (staggered by id) for kit on the ground
// (sim/items.ts) within about 3 m — 5 m when he is out of ammunition, 20 m for his own squad's
// machine gun — provided he is not pinned, cowering, panicked or stunned and nobody is firing at
// him right now. He walks to it, stoops for 2-3 s (`<posture>.pickup`), and takes it:
//   1. ammunition he can use (same cartridge family) when below half load;
//   2. his squad's MG when its gunner is down — only the nearest able man goes;
//   3. grenades when he has fewer than two (topped up to GRENADE_CAP); a Panzerfaust / satchel
//      charge when the team has no AT weapon and enemy armour is known;
//   4. a better weapon for where he is: pistol < bolt rifle < semi-auto / SMG < LMG; SMG over
//      rifle in woods and buildings, rifle over SMG in the open. Captured weapons come with only
//      the rounds found with them.
// He drops what he replaces. Leaders and specialists keep their role weapons unless out of
// ammunition. Green troops loot less under stress. Emplaced crew-served weapons are not items and
// their crews (Team.crewWeapon) do not loot: crewWeapon.ts keeps its own takeover.
// Deterministic: seeded Rng only; ties break by item id / soldier id.
// ============================================================================
import type { Activity, BattleState, GroundItem, Soldier, Team, Terrain, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { tileAt } from './map';
import { findPath, isPassable } from './path';
import { addMessage } from './messages';
import { isDazed } from './daze';
import { UNARMED, addItem, ammoSprite, cartridgeFamily, dropSpareAmmo, dropWeapon, fullLoad, removeItem } from './items';

export const GRENADE_CAP = 3;
const REACH_TILES = 3 / TILE_M;
const REACH_EMPTY_TILES = 5 / TILE_M;
const REACH_SQUAD_MG_TILES = 20 / TILE_M;
/** How close he must be to stoop for it. */
const ARRIVE_TILES = 0.35;
/** Seconds without incoming fire before he will go for something. */
const QUIET_S = 4;
/** Incoming fire this recent makes him give it up. */
const ABORT_FIRE_S = 1;
const GIVE_UP_S = 25;
const CELL = 3;
const MSG_GAP_S = 10;

const CLOSE_TERRAIN = new Set<Terrain>(['woods', 'scatteredtrees', 'buildingWood', 'buildingStone', 'floor', 'rubble']);
const MOVING = new Set<Activity>(['moving', 'movingFast', 'sneaking']);
const NO_LOOT_STATES = new Set(['pinned', 'cowering', 'panicked', 'broken', 'berserk']);
const NO_LOOT_ACTIVITIES = new Set<Activity>(['surrendered', 'routed', 'hiding', 'ambushing', 'panicked', 'cowering', 'pinned', 'berserk', 'dead', 'incapacitated']);

interface PickupTrack { active: Set<number>; lastMsgAt: Map<number, number> }
const tracks = new WeakMap<BattleState, PickupTrack>();
function getTrack(state: BattleState): PickupTrack {
  let t = tracks.get(state);
  if (!t) { t = { active: new Set(), lastMsgAt: new Map() }; tracks.set(state, t); }
  return t;
}

// ------------------------------------------------------------------ who may loot
function roundsOn(s: Soldier): number { return s.ammo + s.ammoReserve; }

function isStunned(s: Soldier, time: number): boolean { return s.stunnedUntil != null && time < s.stunnedUntil; }

/** Able to go for an item at all (spec: not pinned, cowering, panicked or stunned). */
export function ableToLoot(state: BattleState, s: Soldier): boolean {
  if (s.carryingMgMount != null) return false;
  if (s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) return false;
  if (isStunned(s, state.time) || isDazed(s, state.time) || s.dodgeUntil != null || s.crewTask) return false;
  if (NO_LOOT_STATES.has(s.mind.state) || NO_LOOT_ACTIVITIES.has(s.activity)) return false;
  return true;
}

function underFire(state: BattleState, s: Soldier, quietS: number): boolean {
  return state.time - s.mind.lastIncomingAt < quietS;
}

/** Green troops loot less under stress; veterans scavenge readily. */
function tooShaken(s: Soldier): boolean {
  return s.mind.stress > 25 + s.experience * 0.6;
}

/** Leaders and specialists (MG gunner, sniper, AT man, engineer) keep their role weapon. */
function keepsRoleWeapon(s: Soldier): boolean {
  if (s.isLeader) return true;
  const w = WEAPONS[s.weaponId];
  if (!w) return false;
  if (s.weaponId.endsWith('_scoped')) return true;
  return w.cls !== 'rifle' && w.cls !== 'smg' && w.cls !== 'pistol';
}

/** Weapon rank for the ground he stands on: pistol < bolt rifle < semi-auto / SMG < LMG. */
export function weaponRank(weaponId: string, closeTerrain: boolean): number {
  const w = WEAPONS[weaponId];
  if (!w) return 0;
  switch (w.cls) {
    case 'pistol': return 1;
    case 'rifle': return w.rate >= 0.6 ? 3 : weaponId.endsWith('_scoped') ? 2.4 : 2;
    case 'smg': return closeTerrain ? 3.2 : 1.8;
    case 'lmg': return 4;
    default: return 0; // special kit is never "a better weapon"; it is taken for its own reason
  }
}

function isAtKit(w: WeaponDef | undefined): boolean {
  return !!w && (w.cls === 'atrocket' || w.id === 'satchel');
}

function teamHasAt(state: BattleState, team: Team): boolean {
  for (const id of team.soldierIds) {
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
    const w = WEAPONS[o.weaponId];
    if (w && (w.cls === 'atrocket' || w.cls === 'atrifle' || w.cls === 'atgun' || w.id === 'satchel')) return true;
  }
  return false;
}

function enemyArmourKnown(state: BattleState, s: Soldier): boolean {
  for (const id of state.spottedVehicles[s.side]) {
    const v = state.vehicles.get(id);
    if (v && v.state !== 'knockedOut' && v.state !== 'burning' && v.state !== 'abandoned') return true;
  }
  return false;
}

// ------------------------------------------------------------------ spatial lookup
type Grid = Map<number, GroundItem[]>;
const cellKey = (cx: number, cy: number): number => cx * 4096 + cy;

function buildGrid(items: readonly GroundItem[]): Grid {
  const grid: Grid = new Map();
  for (const it of items) {
    if (it.kind === 'helmet' || it.kind === 'pack') continue;
    const k = cellKey(Math.floor(it.pos.x / CELL), Math.floor(it.pos.y / CELL));
    const arr = grid.get(k);
    if (arr) arr.push(it); else grid.set(k, [it]);
  }
  return grid;
}

function forNear(grid: Grid, p: Vec2, r: number, fn: (it: GroundItem, d: number) => void): void {
  const x0 = Math.floor((p.x - r) / CELL), x1 = Math.floor((p.x + r) / CELL);
  const y0 = Math.floor((p.y - r) / CELL), y1 = Math.floor((p.y + r) / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const arr = grid.get(cellKey(cx, cy));
      if (!arr) continue;
      for (const it of arr) { const d = dist(it.pos, p); if (d <= r) fn(it, d); }
    }
  }
}

// ------------------------------------------------------------------ the decision
/** Is `s` the nearest able man of his squad to its fallen MG? (non-leaders first, ties by id) */
function isNearestAbleFor(state: BattleState, team: Team, s: Soldier, item: GroundItem): boolean {
  const score = (o: Soldier): number => dist(o.pos, item.pos) + (o.isLeader ? 1000 : 0);
  const mine = score(s);
  for (const id of team.soldierIds) {
    if (id === s.id) continue;
    const o = state.soldiers.get(id);
    if (!o || !ableToLoot(state, o) || underFire(state, o, QUIET_S)) continue;
    const w = WEAPONS[o.weaponId];
    if (w && w.cls === 'lmg' && roundsOn(o) > 0) continue; // already serves a gun
    if (keepsRoleWeapon(o) && !o.isLeader && roundsOn(o) > 0) continue;
    const sc = score(o);
    if (sc < mine || (sc === mine && o.id < s.id)) return false;
  }
  return true;
}

/** Spare belts / clips lying with a weapon count as its rounds. */
function roundsWith(grid: Grid, item: GroundItem): number {
  let n = item.rounds ?? 0;
  const fam = cartridgeFamily(item.weaponId ?? '');
  forNear(grid, item.pos, 1.5, (o) => {
    if (o.kind === 'ammo' && o.weaponId && cartridgeFamily(o.weaponId) === fam) n += o.rounds ?? 0;
  });
  return n;
}

/** Priority (1 = highest) of `item` for `s` right now, or 0 when he has no use for it. */
export function pickupPriority(state: BattleState, s: Soldier, team: Team, item: GroundItem, d: number, grid: Grid): number {
  const w = WEAPONS[s.weaponId];
  const total = roundsOn(s);
  const empty = !w || total <= 0;
  const reach = empty ? REACH_EMPTY_TILES : REACH_TILES;
  const iw = item.weaponId ? WEAPONS[item.weaponId] : undefined;
  const hasTarget = s.targetSoldierId != null || s.targetVehicleId != null;

  // 1. ammunition he can use, below half load
  if (w && d <= reach && total < fullLoad(w) * 0.5 && item.weaponId && (item.rounds ?? 0) > 0
    && cartridgeFamily(item.weaponId) === cartridgeFamily(s.weaponId)
    && (item.kind === 'ammo' || (item.kind === 'weapon' && iw?.cls !== 'lmg'))) return 1;

  if (item.kind === 'weapon' && iw) {
    const role = keepsRoleWeapon(s) && !empty;
    // 2. the squad's machine gun, its gunner down
    if (iw.cls === 'lmg' && item.teamId === team.id && item.side === s.side && d <= REACH_SQUAD_MG_TILES
      && (!role || s.isLeader) && w?.cls !== 'lmg' && roundsWith(grid, item) > 0
      && isNearestAbleFor(state, team, s, item)) return 2;
    if (d > reach) return 0;
    // 3b. an AT weapon when the team has none and enemy armour is known
    if (isAtKit(iw) && !role && !hasTarget && (item.rounds ?? 0) > 0 && !teamHasAt(state, team) && enemyArmourKnown(state, s)) return 3;
    // 4. a better weapon for where he is
    if (role || (hasTarget && !empty)) return 0;
    const close = CLOSE_TERRAIN.has(tileAt(state.map, Math.floor(s.pos.x), Math.floor(s.pos.y)));
    const mine = empty ? 0 : weaponRank(s.weaponId, close);
    const sameFamily = cartridgeFamily(item.weaponId!) === cartridgeFamily(s.weaponId);
    const usable = roundsWith(grid, item) + (sameFamily ? total : 0);
    if (usable > 0 && weaponRank(item.weaponId!, close) >= mine + 1) return 4;
    return 0;
  }
  // 3a. grenades
  if (item.kind === 'grenades' && d <= reach && !hasTarget && s.grenades < 2 && (item.count ?? 0) > 0 && w?.cls !== 'lmg') return 3;
  return 0;
}

function chooseItem(state: BattleState, s: Soldier, team: Team, grid: Grid): { item: GroundItem; priority: number } | null {
  let best: GroundItem | null = null, bestP = 99, bestD = Infinity;
  forNear(grid, s.pos, REACH_SQUAD_MG_TILES, (it, d) => {
    if (it.claimedBy != null && it.claimedBy !== s.id) return;
    if (it.thrownAt != null && state.time - it.thrownAt < 2) return; // still in the air
    const p = pickupPriority(state, s, team, it, d, grid);
    if (p === 0) return;
    if (p < bestP || (p === bestP && (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && it.id < best!.id)))) { best = it; bestP = p; bestD = d; }
  });
  return best ? { item: best, priority: bestP } : null;
}

function startPickup(state: BattleState, s: Soldier, item: GroundItem, priority: number, track: PickupTrack): void {
  const d = dist(s.pos, item.pos);
  let path: Vec2[] = [];
  if (d > ARRIVE_TILES) {
    const sameTile = Math.floor(s.pos.x) === Math.floor(item.pos.x) && Math.floor(s.pos.y) === Math.floor(item.pos.y);
    path = sameTile ? [] : findPath(state.map, s.pos, item.pos, 'infantry', 1500);
    if (!sameTile && path.length === 0) return; // cannot get there
    if (isPassable(state.map, Math.floor(item.pos.x), Math.floor(item.pos.y), 'infantry')) {
      if (path.length > 0) path.pop(); // the tile centre gives way to the item itself
      path.push({ x: item.pos.x, y: item.pos.y });
    }
    if (path.length === 0) return;
  }
  const dest = s.path.length > 0 ? { ...s.path[s.path.length - 1] } : null;
  s.pickup = { itemId: item.id, priority, startedAt: state.time, resume: { dest, activity: s.activity } };
  item.claimedBy = s.id;
  s.path = path;
  if (path.length > 0 && !MOVING.has(s.activity)) s.activity = 'moving';
  track.active.add(s.id);
}

function endPickup(state: BattleState, s: Soldier, track: PickupTrack, item: GroundItem | undefined, done: boolean): void {
  const pk = s.pickup;
  s.pickup = undefined;
  track.active.delete(s.id);
  if (item && item.claimedBy === s.id) item.claimedBy = undefined;
  if (!pk || s.health === 'dead' || s.health === 'incapacitated') return;
  if (NO_LOOT_STATES.has(s.mind.state)) return; // his state drives him now
  const walkingToItem = pk.until == null;
  const resume = pk.resume;
  if (walkingToItem && !done) {
    // gave up on the way: if an order has not replaced his path, go back to what he was doing
    const last = s.path[s.path.length - 1];
    const stillToItem = !!item && !!last && dist(last, item.pos) < 0.05;
    if (!stillToItem && s.path.length > 0) return;
    s.path = [];
  }
  if (s.path.length > 0) { if (!MOVING.has(s.activity)) s.activity = 'moving'; return; }
  if (resume?.dest) {
    s.path = findPath(state.map, s.pos, resume.dest, 'infantry', 3000);
    s.activity = s.path.length > 0 ? (MOVING.has(resume.activity) ? resume.activity : 'moving') : 'idle';
  } else {
    s.activity = resume && (resume.activity === 'defending' || resume.activity === 'idle') ? resume.activity : 'idle';
  }
}

// ------------------------------------------------------------------ taking it
function say(state: BattleState, track: PickupTrack, team: Team, s: Soldier, text: string): void {
  if (team.side !== state.config.playerSide) return;
  const last = track.lastMsgAt.get(team.id) ?? -Infinity;
  if (state.time - last < MSG_GAP_S) return;
  track.lastMsgAt.set(team.id, state.time);
  addMessage(state, `${team.name}\n${s.rank}. ${s.name} ${text}`, 'info');
}

function takeRounds(s: Soldier, item: GroundItem, want: number): number {
  const take = Math.max(0, Math.min(want, item.rounds ?? 0));
  item.rounds = (item.rounds ?? 0) - take;
  s.ammoReserve += take;
  return take;
}

/** Hands-on: the item becomes his. Exported for tests. */
export function takeItem(state: BattleState, rng: Rng, s: Soldier, item: GroundItem, priority?: number): void {
  const track = getTrack(state);
  const team = state.teams.get(s.teamId);
  const w = WEAPONS[s.weaponId];
  const iw = item.weaponId ? WEAPONS[item.weaponId] : undefined;
  // why he went for it was settled when he set off; asked afresh only when called directly
  const p = priority ?? (team ? pickupPriority(state, s, team, item, Math.min(dist(s.pos, item.pos), REACH_TILES), buildGrid(state.items ?? [])) : 0);

  if (item.kind === 'grenades') {
    const take = Math.min(GRENADE_CAP - s.grenades, item.count ?? 0);
    if (take <= 0) return;
    s.grenades += take;
    item.count = (item.count ?? 0) - take;
    if ((item.count ?? 0) <= 0) removeItem(state, item);
    s.kitDropped = false;
    if (team) say(state, track, team, s, 'picks up grenades.');
    return;
  }
  if (p === 1 && w) {
    // ammunition: fill up to a full load (a weapon on the ground is unloaded, and left there)
    if (takeRounds(s, item, fullLoad(w) - roundsOn(s)) <= 0) return;
    if (item.kind === 'ammo' && (item.rounds ?? 0) <= 0) removeItem(state, item);
    s.kitDropped = false;
    if (team) say(state, track, team, s, 'picks up ammunition.');
    return;
  }
  if (item.kind !== 'weapon' || !iw || p === 0) return;

  // a weapon: drop what it replaces; spare rounds of another cartridge are no use with it
  const oldId = s.weaponId;
  const sameFamily = !!w && cartridgeFamily(oldId) === cartridgeFamily(iw.id);
  const hadOld = dropWeapon(state, rng, s) != null;
  if (!sameFamily) { if (hadOld || s.ammoReserve > 0) dropSpareAmmo(state, rng, s, oldId); s.ammoReserve = 0; }
  s.weaponId = iw.id;
  const found = item.rounds ?? 0;
  s.ammo = Math.min(iw.ammo, found);
  s.ammoReserve += found - s.ammo;
  removeItem(state, item);
  // the belts / clips lying with it
  const fam = cartridgeFamily(iw.id);
  for (const o of (state.items ?? []).slice()) {
    if (o.kind !== 'ammo' || !o.weaponId || cartridgeFamily(o.weaponId) !== fam) continue;
    if (o.claimedBy != null && o.claimedBy !== s.id) continue;
    if (dist(o.pos, s.pos) > 1.5) continue;
    takeRounds(s, o, fullLoad(iw) - roundsOn(s));
    if ((o.rounds ?? 0) <= 0) removeItem(state, o);
  }
  s.reloadTimer = 0;
  s.fireTimer = Math.max(s.fireTimer, 1);
  if (s.activity === 'reloading') s.activity = 'idle';
  s.kitDropped = false;
  if (team) say(state, track, team, s, iw.cls === 'lmg' ? `takes over the ${iw.name}.` : `picks up a ${iw.name}.`);
}

// ------------------------------------------------------------------ step
/** Once per sim step: advance the men already going for something, then let each able soldier
 * whose turn it is (one decision per soldier per second) look around. */
export function stepPickups(state: BattleState, rng: Rng, _dt: number): void {
  const track = getTrack(state);
  const items = state.items;

  if (track.active.size > 0) {
    for (const id of Array.from(track.active).sort((a, b) => a - b)) {
      const s = state.soldiers.get(id);
      if (!s || !s.pickup) { track.active.delete(id); continue; }
      const pk = s.pickup;
      const item = items?.find((it) => it.id === pk.itemId);
      if (!item || (item.claimedBy != null && item.claimedBy !== s.id) || !ableToLoot(state, s)
        || underFire(state, s, ABORT_FIRE_S) || state.time - pk.startedAt > GIVE_UP_S) {
        endPickup(state, s, track, item, false);
        continue;
      }
      if (pk.until != null) {
        if (state.time >= pk.until) { takeItem(state, rng, s, item, pk.priority); endPickup(state, s, track, item, true); }
        continue;
      }
      if (dist(s.pos, item.pos) <= ARRIVE_TILES) {
        pk.from = state.time;
        pk.until = state.time + rng.range(2, 3);
        s.path = [];
        if (s.stance === 'standing') s.stance = 'crouching';
        if (MOVING.has(s.activity)) s.activity = 'idle';
        continue;
      }
      // an order (or cover seeking) has sent him elsewhere: let it
      const last = s.path[s.path.length - 1];
      if (!last || dist(last, item.pos) > 0.05) endPickup(state, s, track, item, false);
    }
  }

  if (!items || items.length === 0) return;
  const tick = Math.round(state.time * 10);
  let grid: Grid | null = null;
  for (const s of state.soldiers.values()) {
    if ((tick + s.id) % 10 !== 0) continue;
    if (s.pickup || !ableToLoot(state, s)) continue;
    const team = state.teams.get(s.teamId);
    if (!team || (team.crewWeapon && !team.crewWeapon.lightMode) || team.vehicleId != null) continue;
    if (underFire(state, s, QUIET_S) || tooShaken(s)) continue;
    if (!grid) grid = buildGrid(items);
    if (grid.size === 0) return;
    const pick = chooseItem(state, s, team, grid);
    if (pick) startPickup(state, s, pick.item, pick.priority, track);
  }
}

/** For tests / tools: the ammo item sprite etc. are in items.ts; re-exported helpers. */
export { addItem, ammoSprite, UNARMED };
