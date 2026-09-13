// ============================================================================
// coverSeek.ts — automatic directional cover seeking (spec §9). Called once
// per soldier per sim step from battle.ts's pipeline; internally throttled to
// at most once every 2 s per soldier via mind.lastCoverSeekAt.
// ============================================================================
import type { BattleState, Soldier, Team, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist, facingAngle } from '@/shared/math';
import { coverScore, omniCoverAt, type ThreatWeighted } from './cover';
import { findPath } from './path';
import { isPassable } from './path';
import { inBounds } from './map';
import { addMessage } from './messages';

const SEEK_INTERVAL_S = 2;

function buildThreatSet(state: BattleState, s: Soldier, team: Team | undefined): ThreatWeighted[] {
  const threats: ThreatWeighted[] = [];
  for (const b of s.mind.beliefs) {
    if (b.confidence <= 0.3) continue;
    threats.push({ dirRad: Math.atan2(b.pos.x - s.pos.x, -(b.pos.y - s.pos.y)), weight: b.confidence });
  }
  if (s.mind.threatDir != null && s.mind.threatLevel > 0) {
    threats.push({ dirRad: s.mind.threatDir, weight: s.mind.threatLevel });
  }
  if (team && (team.order?.type === 'defend' || team.order?.type === 'ambush')) {
    threats.push({ dirRad: facingAngle(team.facing), weight: 0.5 });
  }
  return threats;
}

function tilesWithinRadius(centre: Vec2, radius: number): Vec2[] {
  const out: Vec2[] = [];
  const cx = Math.floor(centre.x), cy = Math.floor(centre.y);
  const r = Math.floor(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      out.push({ x: cx + dx + 0.5, y: cy + dy + 0.5 });
    }
  }
  return out;
}

function occupiedByTeammate(state: BattleState, team: Team | undefined, self: Soldier, tile: Vec2): boolean {
  if (!team) return false;
  for (const id of team.soldierIds) {
    if (id === self.id) continue;
    const o = state.soldiers.get(id);
    if (!o || o.health === 'dead' || o.health === 'incapacitated') continue;
    if (Math.floor(o.pos.x) === Math.floor(tile.x) && Math.floor(o.pos.y) === Math.floor(tile.y)) return true;
  }
  return false;
}

function bestCoverTile(
  state: BattleState, s: Soldier, team: Team | undefined, centre: Vec2, radius: number, threats: ThreatWeighted[],
): { tile: Vec2; score: number } | null {
  const map = state.map;
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  let bestOmni = -Infinity;
  for (const tile of tilesWithinRadius(centre, radius)) {
    const tx = Math.floor(tile.x), ty = Math.floor(tile.y);
    if (!inBounds(map, tx, ty)) continue;
    if (!isPassable(map, tx, ty, 'infantry')) continue;
    if (occupiedByTeammate(state, team, s, tile)) continue;
    const distPenalty = 0.03 * dist(centre, tile);
    const score = coverScore(map, tile, threats) - distPenalty;
    const omni = omniCoverAt(map, tile);
    if (score > bestScore || (Math.abs(score - bestScore) < 1e-9 && omni > bestOmni)) {
      bestScore = score; bestOmni = omni; best = tile;
    }
  }
  return best ? { tile: best, score: bestScore } : null;
}

function moveTo(state: BattleState, s: Soldier, tile: Vec2): void {
  const path = findPath(state.map, s.pos, tile, 'infantry');
  if (path.length > 0) s.path = path;
}

const lookCoverMsgAt = new WeakMap<BattleState, Map<number, number>>();
function maybeAnnounceLookingForCover(state: BattleState, team: Team): void {
  let m = lookCoverMsgAt.get(state);
  if (!m) { m = new Map(); lookCoverMsgAt.set(state, m); }
  const last = m.get(team.id) ?? -Infinity;
  if (state.time - last < 60) return;
  m.set(team.id, state.time);
  addMessage(state, `${team.name}\nis looking for cover.`, 'info');
}

function seekForSoldier(state: BattleState, rng: Rng, s: Soldier): void {
  if (s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) return;
  const mind = s.mind;
  if (mind.state === 'broken' || mind.state === 'berserk') return;

  const team = state.teams.get(s.teamId);
  const threats = buildThreatSet(state, s, team);

  // --- Panicked: run to nearest cover >=0.4 against the strongest threat within 25 tiles.
  if (mind.state === 'panicked') {
    if (threats.length === 0 || s.path.length > 0) return;
    const strongest = threats.reduce((a, b) => (b.weight > a.weight ? b : a));
    const found = bestCoverTile(state, s, team, s.pos, 25, [strongest]);
    if (found && found.score >= 0.4) moveTo(state, s, found.tile);
    return;
  }

  if (state.time - mind.lastCoverSeekAt < SEEK_INTERVAL_S) return;
  if (threats.length === 0) return;

  // --- Pinned/cowering: crawl within 3 tiles if it helps by >=0.2.
  if (mind.state === 'pinned' || mind.state === 'cowering') {
    const cur = coverScore(state.map, s.pos, threats);
    const found = bestCoverTile(state, s, team, s.pos, 3, threats);
    mind.lastCoverSeekAt = state.time;
    if (found && found.score - cur >= 0.2) moveTo(state, s, found.tile);
    return;
  }

  // --- Defend/Ambush/idle (not moving): search within 6 tiles of the ordered anchor.
  const isSettled = s.activity === 'defending' || s.activity === 'ambushing' || s.activity === 'idle' || s.activity === 'hiding';
  if (isSettled) {
    const anchor = mind.anchor ?? s.pos;
    const cur = coverScore(state.map, s.pos, threats);
    let margin = 0.15;
    if (mind.trait === 'cautious') margin = 0.05;
    else if (mind.trait === 'reckless') margin = 0.3;
    const found = bestCoverTile(state, s, team, anchor, 6, threats);
    mind.lastCoverSeekAt = state.time;
    if (found && found.score - cur >= margin && dist(anchor, found.tile) <= 6) {
      moveTo(state, s, found.tile);
      if (team) maybeAnnounceLookingForCover(state, team);
    }
    return;
  }

  // --- Moving/Sneak: bound between cover tiles while threatLevel is high (Move Fast skips this).
  if ((s.activity === 'moving' || s.activity === 'sneaking') && mind.threatLevel > 0.5 && s.path.length > 0) {
    mind.lastCoverSeekAt = state.time;
    const nextWp = s.path[0];
    const found = bestCoverTile(state, s, team, nextWp, 5, threats);
    if (found) {
      const cur = coverScore(state.map, s.pos, threats);
      if (found.score - cur >= 0.15) {
        const remaining = s.path.slice();
        s.path = [...findPath(state.map, s.pos, found.tile, 'infantry'), ...remaining];
      }
    }
  }
}

/** Run automatic directional cover seeking for every living soldier (spec §9). AT guns and MGs use
 * the same logic (their `anchor` is the gun's fixed position); vehicles never seek cover here
 * (crews are handled by vehicle.ts per spec §10). */
export function stepCoverSeeking(state: BattleState, rng: Rng, dt: number): void {
  for (const s of state.soldiers.values()) {
    seekForSoldier(state, rng, s);
  }
}
