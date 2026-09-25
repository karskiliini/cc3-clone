// ============================================================================
// items.ts — kit as objects on the ground (spec 2026-09-17 §9).
//
// `state.items` holds what men leave behind. When a man is killed, incapacitated or surrenders his
// weapon (with the rounds left in it), spare ammunition and grenades become items at his position,
// scattered a little; a man who panics may throw his weapon away. Crew-served weapons (HMG,
// mortar, AT gun) are NOT kit: they belong to the team (`Team.crewWeapon`, sim/crewWeapon.ts) and
// keep their own takeover. Blasts throw items like bodies, and can knock a helmet or pack off a
// man as a purely visual item. Picking things up is sim/pickup.ts.
// Deterministic: seeded Rng only, array / Map iteration order only.
// ============================================================================
import type { BattleState, GroundItem, ItemKind, MentalState, Soldier, Vec2, WeaponClass, WeaponDef } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { inBounds } from './map';
import { isPassable } from './path';
import { blastThrowEnd, blastThrowM } from './debris';

export const ITEM_CAP = 600;
/** weaponId of a man with empty hands (no WEAPONS entry, so he cannot fire). */
export const UNARMED = 'none';

/** Personal weapons a man can drop / pick up. Crew-served and vehicle weapons never are. */
const PERSONAL_CLASSES = new Set<WeaponClass>(['rifle', 'smg', 'lmg', 'pistol', 'atrocket', 'atrifle', 'grenade', 'flamethrower']);

const FAMILY: Record<string, string> = {
  kar98k: 'ger792', kar98k_scoped: 'ger792', mg34: 'ger792', mg42: 'ger792',
  mp40: 'ger9', pistol_p38: 'ger9',
  mosin: 'sov762r', mosin_scoped: 'sov762r', svt40: 'sov762r', dp28: 'sov762r',
  ppsh41: 'sov762t', pistol_tt: 'sov762t',
};
/** Cartridge family: weapons of one family share ammunition; anything else only its own. */
export function cartridgeFamily(weaponId: string): string { return FAMILY[weaponId] ?? weaponId; }

/** Rounds a man starts with for this weapon (magazine + spare), as spawn.ts issues them. */
export function fullLoad(weapon: WeaponDef): number {
  return weapon.ammo * (1 + (weapon.cls === 'mortar' || weapon.cls === 'atgun' || weapon.cls === 'atrocket' ? 12 : 6));
}

export function isPersonalWeapon(state: BattleState, s: Soldier): boolean {
  const w = WEAPONS[s.weaponId];
  if (!w || !PERSONAL_CLASSES.has(w.cls)) return false;
  const team = state.teams.get(s.teamId);
  return !(team?.crewWeapon && team.crewWeapon.weaponId === s.weaponId);
}

/** Lazily created (test literals build a BattleState without it). */
export function itemsOf(state: BattleState): GroundItem[] {
  return state.items ?? (state.items = []);
}

export function ammoSprite(weaponId: string): string {
  const cls = WEAPONS[weaponId]?.cls;
  if (cls === 'lmg' || cls === 'hmg') return 'belt_box';
  if (cls === 'rifle' || cls === 'smg' || cls === 'pistol') return 'ammo_pouch';
  return cls === 'mortar' ? 'mortar_bomb' : 'ammo_box';
}

export function addItem(state: BattleState, item: Omit<GroundItem, 'id'>): GroundItem {
  const items = itemsOf(state);
  const full: GroundItem = { id: state.nextId++, ...item };
  items.push(full);
  if (items.length > ITEM_CAP) {
    // oldest purely visual item first, else the oldest of all
    let i = items.findIndex((it) => it.kind === 'helmet' || it.kind === 'pack');
    if (i < 0 || items[i] === full) i = 0;
    items.splice(i, 1);
  }
  return full;
}

export function removeItem(state: BattleState, item: GroundItem): void {
  const items = state.items;
  if (!items) return;
  const i = items.indexOf(item);
  if (i >= 0) items.splice(i, 1);
}

function scatter(state: BattleState, rng: Rng, p: Vec2, r = 0.45): Vec2 {
  const q = { x: p.x + rng.range(-r, r), y: p.y + rng.range(-r, r) };
  const tx = Math.floor(q.x), ty = Math.floor(q.y);
  return inBounds(state.map, tx, ty) && isPassable(state.map, tx, ty, 'infantry') ? q : { x: p.x, y: p.y };
}

function place(state: BattleState, rng: Rng, s: Soldier, kind: ItemKind, sprite: string, extra: Partial<GroundItem>): GroundItem {
  return addItem(state, { kind, side: s.side, pos: scatter(state, rng, s.pos), dir: rng.range(0, Math.PI * 2), sprite, teamId: s.teamId, ...extra });
}

/** Drop the weapon in his hands (with the rounds in it). Leaves him UNARMED. */
export function dropWeapon(state: BattleState, rng: Rng, s: Soldier): GroundItem | null {
  if (!isPersonalWeapon(state, s)) return null;
  const item = place(state, rng, s, 'weapon', s.weaponId, { weaponId: s.weaponId, rounds: s.ammo });
  s.weaponId = UNARMED;
  s.ammo = 0;
  return item;
}

/** Drop his spare ammunition for `weaponId` as one item. */
export function dropSpareAmmo(state: BattleState, rng: Rng, s: Soldier, weaponId: string): GroundItem | null {
  if (s.ammoReserve <= 0) return null;
  const item = place(state, rng, s, 'ammo', ammoSprite(weaponId), { weaponId, rounds: s.ammoReserve });
  s.ammoReserve = 0;
  return item;
}

/** Everything he carries becomes items where he is: a casualty or a man giving himself up.
 * `weaponOnly`: a man throwing his weapon away in panic keeps his pouches and grenades on him (the
 * spare rounds go with the weapon: they are no use to him without it). Idempotent via
 * `kitDropped` (cleared again by pickup.ts when he takes something). */
export function dropKit(state: BattleState, rng: Rng, s: Soldier, weaponOnly = false): void {
  if (s.kitDropped) return;
  s.kitDropped = true;
  if (s.vehicleId != null) return; // a crewman's kit stays in his vehicle
  if (isPersonalWeapon(state, s)) {
    const weaponId = s.weaponId;
    dropWeapon(state, rng, s);
    dropSpareAmmo(state, rng, s, weaponId);
  }
  if (!weaponOnly && s.grenades > 0) {
    place(state, rng, s, 'grenades', s.side === 'german' ? 'grenade_german' : 'grenade_soviet', { count: s.grenades });
    s.grenades = 0;
  }
}

// ------------------------------------------------------------------ per-step sweep
interface DropTrack { prevState: Map<number, MentalState>; bareHeaded: Set<number>; wasStunned: Set<number> }
const tracks = new WeakMap<BattleState, DropTrack>();
function getTrack(state: BattleState): DropTrack {
  let t = tracks.get(state);
  if (!t) { t = { prevState: new Map(), bareHeaded: new Set(), wasStunned: new Set() }; tracks.set(state, t); }
  return t;
}

/** Chance a man throws his weapon away as he panics: green troops do, veterans hardly ever. */
export function panicDropChance(experience: number): number {
  return Math.min(0.3, Math.max(0.03, 0.3 - experience / 250));
}

/** Once per sim step: casualties and prisoners leave their kit; a man who has just panicked may
 * throw his weapon away. Whatever killed him (bullet, blast, tracks, a falling roof), this sweep
 * catches it, so no casualty path needs its own hook. */
export function stepItemDrops(state: BattleState, rng: Rng): void {
  const track = getTrack(state);
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null) continue;
    if (s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered') {
      if (!s.kitDropped) dropKit(state, rng, s);
      continue;
    }
    const prev = track.prevState.get(s.id);
    const now = s.mind.state;
    if (prev !== now) {
      track.prevState.set(s.id, now);
      if (now === 'panicked' && prev !== undefined && !s.kitDropped && isPersonalWeapon(state, s)
        && WEAPONS[s.weaponId].cls !== 'grenade' && rng.chance(panicDropChance(s.experience))) {
        dropKit(state, rng, s, true);
      }
    }
    // Knocked down (blast/vehicle impact — lying stunned): often loses his grip on the
    // weapon, which is then seen on the ground beside him. Rolled ONCE on entering the
    // stun (wasStunned gate — never per step), so the chance stays the stated chance.
    // He can pick it (or better) back up when he recovers — pickup.ts handles that.
    const stunned = s.stunnedUntil != null && state.time < s.stunnedUntil;
    const was = track.wasStunned.has(s.id);
    if (stunned && !was && prev !== undefined && !s.kitDropped && isPersonalWeapon(state, s)
      && WEAPONS[s.weaponId].cls !== 'grenade'
      && rng.chance(panicDropChance(s.experience) * 0.8)) {
      dropKit(state, rng, s, true);
    }
    if (stunned) track.wasStunned.add(s.id); else track.wasStunned.delete(s.id);
  }
}

// ------------------------------------------------------------------ blasts
/** A burst throws the items lying inside its radius, exactly like bodies (debris.ts trace). */
export function throwItems(state: BattleState, rng: Rng, burst: Vec2, radiusTiles: number, forceAt: (dTiles: number) => number): void {
  const items = state.items;
  if (!items || items.length === 0 || radiusTiles <= 0) return;
  for (const it of items) {
    if (Math.abs(it.pos.x - burst.x) > radiusTiles || Math.abs(it.pos.y - burst.y) > radiusTiles) continue;
    const d = dist(it.pos, burst);
    if (d > radiusTiles) continue;
    const force = forceAt(d);
    if (force <= 0.05) continue;
    const ang = d > 1e-3 ? Math.atan2(it.pos.y - burst.y, it.pos.x - burst.x) : rng.range(0, Math.PI * 2);
    const from = { x: it.pos.x, y: it.pos.y };
    it.pos = blastThrowEnd(state, from, ang + rng.range(-0.25, 0.25), blastThrowM(force) * rng.range(0.6, 1.15));
    it.dir = rng.range(0, Math.PI * 2);
    it.from = from; it.thrownAt = state.time; it.force = force;
  }
}

/** A hard blast can take a man's helmet or pack off: a purely visual item that lands beyond him. */
export function shedGearInBlast(state: BattleState, rng: Rng, s: Soldier, burst: Vec2, force: number): void {
  if (force < 0.5 || s.vehicleId != null) return;
  const track = getTrack(state);
  if (track.bareHeaded.has(s.id)) return;
  if (!rng.chance(0.4)) return;
  track.bareHeaded.add(s.id);
  const origin = s.blast?.origin ?? s.pos;
  const ang = Math.atan2(s.pos.y - burst.y, s.pos.x - burst.x) + rng.range(-0.6, 0.6);
  const helmet = rng.chance(0.7);
  addItem(state, {
    kind: helmet ? 'helmet' : 'pack', side: s.side,
    sprite: helmet ? (s.side === 'german' ? 'helmet_german' : 'helmet_soviet') : (s.side === 'german' ? 'backpack' : 'backpack_soviet'),
    pos: blastThrowEnd(state, origin, ang, blastThrowM(force) * rng.range(0.8, 1.3)), dir: rng.range(0, Math.PI * 2),
    from: { x: origin.x, y: origin.y }, thrownAt: state.time, force,
  });
}
