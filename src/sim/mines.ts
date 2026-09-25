import type { BattleState, GameMap, Soldier, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { addMessage } from './messages';
import { applyHit } from './combat';
import { WEAPONS } from '@/data/weapons';

// ============================================================================
// mines.ts — minefields (roadmap G6).
//
// Map-authored per-tile mine arrays on GameMap: 0 = none, 1 = anti-personnel,
// 2 = anti-tank. Hidden until triggered (CC3: mines are unseen until they blow
// or are cleared); a detonation consumes the tile. Infantry trigger AP mines,
// vehicles trigger AT mines; engineer teams can clear.
// ============================================================================

export const MINE_NONE = 0;
export const MINE_AP = 1;
export const MINE_AT = 2;

/** Weapon-like def for AP mine hits: blast+frag, lethal at point-blank range. */
const AP_MINE_WEAPON_ID = 'mortar_he_81';
/** AT mines attack vehicle armour directly (handled in stepVehicles' damage path). */
export const AT_MINE_DAMAGE = 55; // heavy hull damage / likely immobilisation

export function minesArray(map: GameMap): Int8Array {
  if (!map.mines) map.mines = new Int8Array(map.width * map.height);
  return map.mines;
}

export function mineAt(map: GameMap, x: number, y: number): number {
  if (!map.mines || x < 0 || y < 0 || x >= map.width || y >= map.height) return MINE_NONE;
  return map.mines[y * map.width + x];
}

export function setMineAt(map: GameMap, x: number, y: number, kind: number): void {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return;
  minesArray(map)[y * map.width + x] = kind;
}

function tileIdx(map: GameMap, x: number, y: number): number {
  return Math.floor(y) * map.width + Math.floor(x);
}

function consumeMine(map: GameMap, idx: number): void {
  map.mines![idx] = MINE_NONE;
  if (map.craterMarks) map.craterMarks.push({ x: (idx % map.width) + 0.5, y: Math.floor(idx / map.width) + 0.5, sizeM: 4, kind: 'grenade' });
  if (map.dirtyTiles) map.dirtyTiles.push(idx);
}
/** Clear the mine tile nearest a soldier (engineer work, ~8 s of digging handled by
 * the caller's repeat-call pattern: each call consumes one tile and logs). */
export function clearMineNear(state: BattleState, s: Soldier): boolean {
  const map = state.map;
  const tx = Math.floor(s.pos.x);
  const ty = Math.floor(s.pos.y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (mineAt(map, tx + dx, ty + dy) !== MINE_NONE) {
        const idx = tileIdx(map, tx + dx, ty + dy);
        consumeMine(map, idx);
        addMessage(state, 'Engineers cleared the mines.');
        return true;
      }
    }
  }
  return false;
}

/** Mine trigger checks for one soldier: called every sim step from the movement
 * path; a soldier only detonates a mine when he ENTERS the tile (his tile index
 * changes), tracked via s.mineTileSeen. */
export function soldierMineCheck(state: BattleState, s: Soldier, rng: Rng): void {
  const kind = mineAt(state.map, s.pos.x, s.pos.y);
  if (kind === MINE_NONE) return;
  const idx = tileIdx(state.map, s.pos.x, s.pos.y);
  if (s.mineTileSeen === idx) return;
  s.mineTileSeen = idx;
  // chance to step between the mines: field density makes a hit probable, not certain
  if (!rng.chance(0.7)) return;
  consumeMine(state.map, idx);
  state.explosions.push({ pos: { x: s.pos.x, y: s.pos.y }, radiusM: 3, t: 0, kind: 'small' });
  addMessage(state, 'A mine explodes.', 'bad');
  if (kind === MINE_AP) {
    const weapon = WEAPONS[AP_MINE_WEAPON_ID];
    if (weapon) applyHit(state, s, weapon, rng, s.side === 'german' ? 'soviet' : 'german');
  }
  // AT mines do not hurt infantry on foot (vehicle trigger below handles armour)
}

/** Vehicle mine trigger: AT mines only; AP mines are ignored by tracked hulls. */
export function vehicleMineCheck(state: BattleState, v: Vehicle, rng: Rng): void {
  const kind = mineAt(state.map, v.pos.x, v.pos.y);
  if (kind !== MINE_AT) return;
  const idx = tileIdx(state.map, v.pos.x, v.pos.y);
  if (v.mineTileSeen === idx) return;
  v.mineTileSeen = idx;
  if (!rng.chance(0.8)) return;
  consumeMine(state.map, idx);
  addMessage(state, `${v.defId}: hit a mine!`, 'bad');
  // immobilise the hull outright (track damage), crew shaken
  v.state = 'immobilized';
  v.hits += AT_MINE_DAMAGE;
}
