import type { BattleState, GameMap, Soldier, Vec2 } from '@/shared/types';
import { dist } from '@/shared/math';
import { inBounds, tileAt } from './map';
import { findPath, isPassable } from './path';
import { buildThreatSet, coverScore } from './cover';
import { fireHazards, nearFireHazard } from './vehicleExplosion';

/** Existing gentle separation distance: a physical minimum, rather than one man per tile. */
export const SOLDIER_MIN_SPACE_TILES = 0.3;
const SEARCH_RADIUS = 6;
const indoor = (map: GameMap, p: Vec2): boolean => {
  const t = tileAt(map, Math.floor(p.x), Math.floor(p.y));
  return t === 'buildingWood' || t === 'buildingStone' || t === 'floor';
};

/** Current building geometry; destroyed rooms retain connectivity but cannot supply indoor slots.
 * Hand-painted maps without building ids use connected live building tiles. No persistent cache. */
export function buildingTiles(map: GameMap, at: Vec2): Vec2[] {
  const x = Math.floor(at.x), y = Math.floor(at.y);
  if (!inBounds(map, x, y) || !indoor(map, at)) return [];
  const id = map.buildingId[y * map.width + x], stack = [y * map.width + x], seen = new Set<number>(stack), out: Vec2[] = [];
  while (stack.length) {
    const key = stack.pop()!, tx = key % map.width, ty = Math.floor(key / map.width), p = { x: tx + 0.5, y: ty + 0.5 };
    if (indoor(map, p)) out.push(p);
    for (const [nx, ny] of [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]]) {
      const k = ny * map.width + nx;
      if (!inBounds(map, nx, ny) || seen.has(k)) continue;
      if (id >= 0 ? map.buildingId[k] !== id : !indoor(map, { x: nx, y: ny })) continue;
      seen.add(k); stack.push(k);
    }
  }
  return out;
}

export function inSameBuilding(map: GameMap, a: Vec2, b: Vec2): boolean {
  if (!indoor(map, a) || !indoor(map, b)) return false;
  const ai = map.buildingId[Math.floor(a.y) * map.width + Math.floor(a.x)];
  const bi = map.buildingId[Math.floor(b.y) * map.width + Math.floor(b.x)];
  return ai >= 0 && bi >= 0 ? ai === bi : buildingTiles(map, a).some(p => Math.floor(p.x) === Math.floor(b.x) && Math.floor(p.y) === Math.floor(b.y));
}

function personalCover(state: BattleState, s: Soldier, p: Vec2): number {
  return coverScore(state.map, p, buildThreatSet(state, s, state.teams.get(s.teamId)));
}
function crowdingMargin(s: Soldier): number {
  return s.mind.trait === 'cautious' ? 0.05 : s.mind.trait === 'reckless' ? 0.3 : 0.15;
}

/** A sidestep may improve personal space, but must not leave markedly better building cover. */
export function canStepAside(state: BattleState, s: Soldier, to: Vec2): boolean {
  if (!inBounds(state.map, Math.floor(to.x), Math.floor(to.y)) || !isPassable(state.map, Math.floor(to.x), Math.floor(to.y), 'infantry')) return false;
  if (!indoor(state.map, s.pos) || inSameBuilding(state.map, s.pos, to)) return true;
  return personalCover(state, s, s.pos) - personalCover(state, s, to) < crowdingMargin(s);
}

/** Every ordered man considers the whole house. Empty rooms precede crowding; outdoor overflow
 * needs real cover comparable to the best remaining indoor place. Only friendly occupancy and
 * this soldier's own threat set enter the decision. */
export function buildingDestination(state: BattleState, s: Soldier, target: Vec2, slot: Vec2): Vec2 | null {
  const rooms = buildingTiles(state.map, target);
  if (!rooms.length) return null;
  const map = state.map, keys = new Set(rooms.map(p => Math.floor(p.y) * map.width + Math.floor(p.x)));
  const occupied: Vec2[] = [];
  for (const other of state.soldiers.values()) {
    if (other.id === s.id || other.side !== s.side || other.health === 'dead' || other.vehicleId != null) continue;
    occupied.push(other.pos);
    // Men already approaching the house keep their space, including during re-evaluation.
    if (other.health !== 'incapacitated' && other.path.length) occupied.push(other.path[other.path.length - 1]);
  }
  const threats = buildThreatSet(state, s, state.teams.get(s.teamId)), hazards = fireHazards(state);
  const safe = (p: Vec2) => isPassable(map, Math.floor(p.x), Math.floor(p.y), 'infantry') && !nearFireHazard(hazards, p);
  const free = (p: Vec2) => !occupied.some(o => dist(o, p) < SOLDIER_MIN_SPACE_TILES);
  const takenTile = (p: Vec2) => occupied.some(o => Math.floor(o.x) === Math.floor(p.x) && Math.floor(o.y) === Math.floor(p.y));
  const quality = (p: Vec2) => coverScore(map, p, threats);
  const rank = (p: Vec2) => quality(p) - 0.01 * dist(slot, p) - 0.01 * dist(s.pos, p);
  const reachable = new Map<number, boolean>();
  const best = (points: Vec2[]): Vec2 | null => {
    // Try good places first; share reachability between sub-tile slots in the same room.
    for (const p of points.sort((a, b) => rank(b) - rank(a))) {
      const key = Math.floor(p.y) * map.width + Math.floor(p.x);
      let ok = reachable.get(key);
      if (ok === undefined) {
        const sameTile = Math.floor(s.pos.x) === Math.floor(p.x) && Math.floor(s.pos.y) === Math.floor(p.y);
        const path = sameTile ? [] : findPath(map, s.pos, p, 'infantry');
        const end = path.at(-1);
        ok = sameTile || !!end && Math.floor(end.x) === Math.floor(p.x) && Math.floor(end.y) === Math.floor(p.y);
        reachable.set(key, ok);
      }
      if (ok) return p;
    }
    return null;
  };
  const roomy = best(rooms.filter(p => safe(p) && !takenTile(p)));
  if (roomy) return roomy;
  const packed: Vec2[] = [], count = Math.floor(1 / SOLDIER_MIN_SPACE_TILES);
  for (const room of rooms) for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
    const p = { x: Math.floor(room.x) + (x + 0.5) / count, y: Math.floor(room.y) + (y + 0.5) / count };
    if (safe(p) && free(p)) packed.push(p);
  }
  const inside = best(packed), outside: Vec2[] = [];
  const xs = rooms.map(p => Math.floor(p.x)), ys = rooms.map(p => Math.floor(p.y));
  for (let y = Math.max(0, Math.min(...ys) - SEARCH_RADIUS); y <= Math.min(map.height - 1, Math.max(...ys) + SEARCH_RADIUS); y++) {
    for (let x = Math.max(0, Math.min(...xs) - SEARCH_RADIUS); x <= Math.min(map.width - 1, Math.max(...xs) + SEARCH_RADIUS); x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (keys.has(y * map.width + x) || takenTile(p) || !safe(p) || quality(p) <= 0) continue;
      if (rooms.some(r => dist(r, p) <= SEARCH_RADIUS)) outside.push(p);
    }
  }
  const overflow = best(outside);
  if (inside && (!overflow || quality(inside) - quality(overflow) >= crowdingMargin(s))) return inside;
  // With no safe capacity left he waits rather than being assigned an exposed formation slot.
  return overflow ?? inside ?? { ...s.pos };
}
