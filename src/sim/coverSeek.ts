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
import { isDazed } from './daze';
import { fireHazards, nearFireHazard } from './vehicleExplosion';

const SEEK_INTERVAL_S = 2;
/** Search radius (tiles) for a spot clear of a burning vehicle: 15 m plus room to choose. */
const HAZARD_SEARCH_TILES = 12;

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
  const hazards = fireHazards(state);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  let bestOmni = -Infinity;
  for (const tile of tilesWithinRadius(centre, radius)) {
    const tx = Math.floor(tile.x), ty = Math.floor(tile.y);
    if (!inBounds(map, tx, ty)) continue;
    if (!isPassable(map, tx, ty, 'infantry')) continue;
    if (occupiedByTeammate(state, team, s, tile)) continue;
    // nobody takes cover beside a burning vehicle: it may blow up (sim/vehicleExplosion.ts)
    if (hazards.length > 0 && nearFireHazard(hazards, tile, 1)) continue;
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
  if (team.side !== state.config.playerSide) return; // flavour text is player-side only (spec §11)
  let m = lookCoverMsgAt.get(state);
  if (!m) { m = new Map(); lookCoverMsgAt.set(state, m); }
  const last = m.get(team.id) ?? -Infinity;
  if (state.time - last < 180) return;
  m.set(team.id, state.time);
  addMessage(state, `${team.name}\nis looking for cover.`, 'info');
}

function seekForSoldier(state: BattleState, rng: Rng, s: Soldier): void {
  if (s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) return;
  if (s.hatch || s.bailRun) return; // hatch motion and emergency passenger flight own their paths
  if (isDazed(s, state.time)) return; // his crawl for cover is daze.ts's alone
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

  // --- A burning vehicle within 15 m: a man with nowhere to go gets clear of it before anything
  // else (its ammunition may cook off), to the best cover outside that circle.
  // (a gun crew stays with its emplaced gun)
  if (s.path.length === 0 && !s.bailRun && !(team?.crewWeapon && !team.crewWeapon.abandoned)) {
    const hazards = fireHazards(state);
    if (hazards.length > 0 && nearFireHazard(hazards, s.pos)) {
      mind.lastCoverSeekAt = state.time;
      const found = bestCoverTile(state, s, team, s.pos, HAZARD_SEARCH_TILES, threats);
      if (found) {
        moveTo(state, s, found.tile);
        // he hurries (movement.ts walks a path only in a moving activity; arriving restores it)
        if (s.path.length > 0 && mind.state !== 'pinned' && mind.state !== 'cowering') s.activity = 'movingFast';
        else if (s.path.length > 0) s.activity = 'sneaking';
        // his post moves with him: he must not drift back while it burns
        if (mind.anchor && nearFireHazard(hazards, mind.anchor)) mind.anchor = { ...found.tile };
      }
      return;
    }
  }
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
      // Only announce under real danger: settling into cover behind a Defend/Ambush facing before
      // any contact happens quietly.
      const inDanger = mind.threatLevel > 0.3
        || mind.beliefs.some((b) => b.confidence > 0.3)
        || (state.time - mind.lastIncomingAt) < 30;
      if (team && inDanger) maybeAnnounceLookingForCover(state, team);
    }
    return;
  }

  // --- Moving/Sneak: duck 1 tile aside for cover while threatLevel is high (Move Fast skips
  // this). Balance regression fix: this used to search a 5-tile radius around the NEXT waypoint
  // and splice a fresh sub-path in front of the remaining route, re-evaluated every 2s for as long
  // as threatLevel stayed >0.5 — which is most of an assault. Each re-trigger replaced the path
  // before the soldier had gone far along the previous detour, so under sustained fire an attacker
  // would sidestep repeatedly and never net-advance (harness: attacker shot counts collapsed to a
  // fraction of the defender's, attacker win rate went from ~41% to 0%). A "duck for cover while
  // still advancing" instinct should cost at most one tile of detour, not repeatedly reroute the
  // whole approach.
  if ((s.activity === 'moving' || s.activity === 'sneaking') && mind.threatLevel > 0.5 && s.path.length > 0) {
    mind.lastCoverSeekAt = state.time;
    const cur = coverScore(state.map, s.pos, threats);
    const found = bestCoverTile(state, s, team, s.pos, 1, threats);
    if (found && found.score - cur >= 0.25 && dist(s.pos, found.tile) <= 1.5) {
      // A single-tile sidestep, then resume the existing path from there — never touches the
      // remaining route beyond this one detour tile.
      s.path = [found.tile, ...s.path];
    }
  }
}

/** Best cover tile within `radius` tiles of the soldier against his own threat set, with the score
 * of where he is now (`current`). Near a burning hull, look far enough to find somewhere outside
 * its danger zone: the normal dazed crawl radius can otherwise lie entirely inside it. Read-only. */
export function bestCoverNear(state: BattleState, s: Soldier, radius: number): { tile: Vec2; score: number; current: number } | null {
  const team = state.teams.get(s.teamId);
  const threats = buildThreatSet(state, s, team);
  const reach = nearFireHazard(fireHazards(state), s.pos) ? Math.max(radius, HAZARD_SEARCH_TILES) : radius;
  const found = bestCoverTile(state, s, team, s.pos, reach, threats);
  return found ? { tile: found.tile, score: found.score, current: coverScore(state.map, s.pos, threats) } : null;
}

/** Run automatic directional cover seeking for every living soldier (spec §9). AT guns and MGs use
 * the same logic (their `anchor` is the gun's fixed position); vehicles never seek cover here
 * (crews are handled by vehicle.ts per spec §10). */
export function stepCoverSeeking(state: BattleState, rng: Rng, dt: number): void {
  for (const s of state.soldiers.values()) {
    seekForSoldier(state, rng, s);
  }
}

/** Arrival settling for move orders: the best tile within `radius` of a soldier's formation `slot`,
 * scored with the same directional cover model as automatic cover seeking (his threat set plus the
 * direction of travel at weight 0.5 — an advancing squad expects the enemy ahead) minus a small
 * distance penalty, so an arriving squad spreads along hedges, walls and craters instead of
 * standing in its formation pattern. `taken(tx, ty)` rejects tiles already claimed by teammates.
 * Returns the slot itself when it is passable and nothing nearby is clearly better. Pure function
 * of the map and soldier state (no rng), at most ~13 tiles x coverScore. */
export function settleTile(
  state: BattleState, s: Soldier, slot: Vec2, headingRad: number, radius: number,
  taken: (tx: number, ty: number) => boolean,
): Vec2 | null {
  const map = state.map;
  const team = state.teams.get(s.teamId);
  const threats = buildThreatSet(state, s, team);
  threats.unshift({ dirRad: headingRad, weight: 0.5 });
  const hazards = fireHazards(state);
  const sx = Math.floor(slot.x), sy = Math.floor(slot.y);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (const tile of tilesWithinRadius(slot, radius)) {
    const tx = Math.floor(tile.x), ty = Math.floor(tile.y);
    if (!inBounds(map, tx, ty) || !isPassable(map, tx, ty, 'infantry') || taken(tx, ty)) continue;
    const own = tx === sx && ty === sy;
    if (!own && hazards.length > 0 && nearFireHazard(hazards, tile)) continue; // not beside a burning vehicle
    // off-slot tiles keep the slot's sub-tile jitter (softened) so men never line up on tile centres
    const p = own ? slot : { x: tx + 0.5 + (slot.x - sx - 0.5) * 0.6, y: ty + 0.5 + (slot.y - sy - 0.5) * 0.6 };
    // own tile gets a small stickiness bonus so open ground keeps the loose formation shape
    const score = coverScore(map, tile, threats) - 0.06 * dist(slot, tile) + (own ? 0.05 : 0);
    if (score > bestScore + 1e-9) { bestScore = score; best = { x: p.x, y: p.y }; }
  }
  return best;
}
