import type { BattleState, GameMap, Soldier, Vehicle } from '@/shared/types';
import { addMessage } from './messages';

// ============================================================================
// wire.ts — wire entanglements (roadmap G7).
//
// Per-tile wire on GameMap: 0 = none, 1 = intact, 2 = cut. Intact wire slows
// infantry hard and blocks vehicles (tracks can force through with a chance of
// consuming the tile); engineers cut wire directly. Wire gives no cover (CC3).
// ============================================================================

export const WIRE_NONE = 0;
export const WIRE_INTACT = 1;
export const WIRE_CUT = 2;

/** Infantry speed multiplier through intact wire (CC3: a crawl, not a walk). */
export const WIRE_SPEED_MUL = 0.35;
/** Chance a vehicle's tracks force through a wire tile, consuming it. */
export const VEHICLE_BREAK_CHANCE = 0.5;

export function wireAt(map: GameMap, x: number, y: number): number {
  if (!map.wire || x < 0 || y < 0 || x >= map.width || y >= map.height) return WIRE_NONE;
  return map.wire[Math.floor(y) * map.width + Math.floor(x)];
}

/** Infantry movement multiplier for the tile being entered (1 = unaffected). */
export function wireSpeedMul(map: GameMap, x: number, y: number): number {
  return wireAt(map, x, y) === WIRE_INTACT ? WIRE_SPEED_MUL : 1;
}

/** Vehicles cannot enter intact wire outright; tracks may force through. */
export function vehicleWireBlock(state: BattleState, v: Vehicle, rng: import('@/shared/rng').Rng): boolean {
  if (wireAt(state.map, v.pos.x, v.pos.y) !== WIRE_INTACT) return false;
  if (!rng.chance(VEHICLE_BREAK_CHANCE)) return true; // held up this step
  consumeWire(state.map, Math.floor(v.pos.y) * state.map.width + Math.floor(v.pos.x));
  addMessage(state, 'Wire crushed under the tracks.');
  return false;
}

export function consumeWire(map: GameMap, idx: number): void {
  map.wire![idx] = WIRE_CUT;
  if (map.dirtyTiles) map.dirtyTiles.push(idx);
}

/** Engineer work: cut the wire tile nearest the soldier (3x3 scan). One tile per call. */
export function cutWireNear(state: BattleState, s: Soldier): boolean {
  const map = state.map;
  if (!map.wire) return false;
  const tx = Math.floor(s.pos.x);
  const ty = Math.floor(s.pos.y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (wireAt(map, tx + dx, ty + dy) === WIRE_INTACT) {
        const idx = (ty + dy) * map.width + (tx + dx);
        consumeWire(map, idx);
        addMessage(state, 'Wire cut.');
        return true;
      }
    }
  }
  return false;
}
