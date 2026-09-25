import type { BattleState, Side, Team, Vec2 } from '@/shared/types';
import { otherSide, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';

// ============================================================================
// initiative.ts — subordinate initiative (roadmap G18).
//
// In the original, an AI-subordinated friendly team occasionally acted on its
// own: an intact, confident leader whose team is sitting idle takes the
// nearest worthwhile enemy-held victory location on his own bat and assaults
// it, and the commander is told so he can endorse or overrule (E13: Ulrich's
// squad). Player teams get no stepAI — this is the small, deliberate
// exception.
// ============================================================================

/** Roughly one side-wide initiative episode per battle (E13 flavour). */
const INITIATIVE_CHANCE_PER_TICK = 0.002;
/** A team with this much morale does not crack under its own plan. */
const MIN_MORALE = 60;
/** Never initiative within this range of an already-set objective. */
const OBJECTIVE_EPSILON_M = 10;

export interface InitiativeResult {
  teamId: number;
  target: Vec2;
  vlId: number | null;
}
function enemyVLs(state: BattleState, side: Side, from: { x: number; y: number }): { vl: BattleState['map']['victoryLocations'][number]; distM: number }[] {
  return state.map.victoryLocations
    .filter((vl) => vl.owner === otherSide(side))
    .map((vl) => ({ vl, distM: Math.hypot(vl.x - from.x, vl.y - from.y) * TILE_M }))
    .sort((a, b) => a.distM - b.distM);
}


/** Rolls each player-side team for subordinate initiative. Returns the acting
 * team (with its order issued) or null. Called from the AI tick only for the
 * human side. */
export function stepSubordinateInitiative(state: BattleState, rng: Rng, issue: (teamId: number, target: Vec2) => void): InitiativeResult | null {
  if (state.phase !== 'running') return null;
  const playerSide: Side = state.config.playerSide;

  for (const team of state.teams.values()) {
    if (team.side !== playerSide || team.outOfAction) continue;
    const leader = state.soldiers.get(team.leaderId);
    if (!leader || leader.health === 'dead' || leader.health === 'incapacitated') continue;
    if (team.morale < MIN_MORALE) continue;
    // only teams with no standing player order (or a plain hold) may act
    if (team.order && team.order.type !== 'defend') continue;
    // squads whose men are all cowering/pinned are in no state to plan
    const men = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s) => s && s.health !== 'dead');
    if (men.length === 0 || men.every((s) => s!.mind.state === 'broken')) continue;

    if (!rng.chance(INITIATIVE_CHANCE_PER_TICK)) continue;

    // pick one of the two nearest enemy-held VLs (from THIS team), within a sane march
    const options = enemyVLs(state, playerSide, team.pos).filter((o) => o.distM <= 400);
    if (options.length === 0) continue;
    const pick = options[rng.int(0, Math.min(2, options.length) - 1)];
    const target = { x: pick.vl.x, y: pick.vl.y };
    if (team.aiObjective && Math.hypot(team.aiObjective.x - target.x, team.aiObjective.y - target.y) * TILE_M < OBJECTIVE_EPSILON_M) continue;

    team.aiObjective = target;
    issue(team.id, target);
    return { teamId: team.id, target, vlId: pick.vl.id };
  }
  return null;
}

export function isInitiativeCandidate(team: Team, state: BattleState): boolean {
  const leader = state.soldiers.get(team.leaderId);
  return !team.outOfAction && !!leader && leader.health === 'healthy' && team.morale >= MIN_MORALE;
}
