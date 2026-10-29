import type { BattleState, Soldier, Team, Vec2 } from '@/shared/types';
import { angleTo, dist, facingAngle, facingFromAngle } from '@/shared/math';
import * as dm from '@/shared/dmath';
import { hasLineOfFire, eyeHeightM } from './los';
import { findPath, isPassable } from './path';
import { inBounds } from './map';
import { isDazed } from './daze';
import { fireHazards, nearFireHazard } from './vehicleExplosion';

/** Interior infantry choose an actual reachable opening, keeping the team's issued order.
 * Called behind coverSeek's two-second throttle. Crew guns have their own placement drill. */
export function seekBuildingStation(state: BattleState, s: Soldier, team: Team | undefined): boolean {
  const map = state.map, x = Math.floor(s.pos.x), y = Math.floor(s.pos.y);
  if (!inBounds(map, x, y) || s.path.length || s.vehicleId != null || s.hatch || s.carrying || s.carryingMgMount != null
    || s.pickup || s.crewTask || s.reloadTimer > 0 || (s.bandageUntil ?? 0) > state.time || (s.stunnedUntil ?? 0) > state.time || isDazed(s, state.time)
    || s.health === 'dead' || s.health === 'incapacitated' || s.activity === 'surrendered'
    || ['pinned', 'cowering', 'panicked', 'broken', 'berserk'].includes(s.mind.state)
    || (team?.crewWeapon && !team.crewWeapon.abandoned && !team.crewWeapon.lightMode)
    || (team?.order && !['fire', 'defend', 'ambush'].includes(team.order.type))) return false;
  const bid = map.buildingId[y * map.width + x];
  if (bid < 0) return false;
  const terrain = map.tiles[y * map.width + x];
  if (terrain !== 'floor' && terrain !== 'buildingStone' && terrain !== 'buildingWood') return false;
  if (s.smgBurst && state.time < s.smgBurst.until) return true;
  s.mind.lastCoverSeekAt = state.time;
  const direction = facingAngle(team?.facing ?? s.facing);
  const target: Vec2 = team?.order?.type === 'fire' ? team.order.target : {
    x: Math.max(0.5, Math.min(map.width - 0.5, s.pos.x + dm.sin(direction) * 30)),
    y: Math.max(0.5, Math.min(map.height - 0.5, s.pos.y - dm.cos(direction) * 30)),
  };
  // An enemy inside the same building is a room fight, not a reason to face an outside window.
  const targetIndex = Math.floor(target.y) * map.width + Math.floor(target.x);
  if (map.buildingId[targetIndex] === bid) return false;
  const heights = { eyeM: eyeHeightM('crouching'), targetM: 1.5 };
  if (map.windows[y * map.width + x] && hasLineOfFire(map, s.pos, target, heights)) {
    s.facing = facingFromAngle(angleTo(s.pos, target)); return true;
  }
  const candidates: { pos: Vec2; score: number }[] = [];
  const hazards = fireHazards(state);
  for (let wy = Math.max(0, y - 12); wy <= Math.min(map.height - 1, y + 12); wy++) {
    for (let wx = Math.max(0, x - 12); wx <= Math.min(map.width - 1, x + 12); wx++) {
      const i = wy * map.width + wx;
      if (map.buildingId[i] !== bid || !map.windows[i] || !isPassable(map, wx, wy, 'infantry')) continue;
      const pos = { x: wx + 0.5, y: wy + 0.5 };
      if (nearFireHazard(hazards, pos, 1)) continue;
      if (!hasLineOfFire(map, pos, target, heights)) continue;
      let occupied = false;
      for (const other of state.soldiers.values()) {
        if (other.id === s.id || other.side !== s.side || other.vehicleId != null || other.health === 'dead' || other.health === 'incapacitated') continue;
        if (dist(other.pos, pos) < 0.7 || (other.path.length && dist(other.path[other.path.length - 1], pos) < 0.7)) { occupied = true; break; }
      }
      if (!occupied) candidates.push({ pos, score: dist(s.pos, pos) });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
  for (const { pos } of candidates) {
    const path = findPath(map, s.pos, pos, 'infantry', 2000);
    if (!path.length || dist(path[path.length - 1], pos) > 0.6) continue;
    // Stay in this building. Do not walk outside around a partition to reach a firing window.
    if (path.some(p => map.buildingId[Math.floor(p.y) * map.width + Math.floor(p.x)] !== bid)) continue;
    s.path = path; s.activity = 'moving'; s.stance = 'crouching';
    s.aiming = undefined; s.smgBurst = undefined;
    return true;
  }
  return true;
}
