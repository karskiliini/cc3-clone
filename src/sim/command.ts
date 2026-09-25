import type { BattleState, Soldier, Team } from '@/shared/types';
import { TILE_M } from '@/shared/types';

// ============================================================================
// command.ts — command radius (roadmap Shell G11-G16).
//
// In CC3, teams fight under their side's command net: a team within range of an
// operational command team (HQ) receives orders and recovers morale normally.
// Out of command, orders are refused ("no contact with HQ") and morale
// recovery degrades — the men are on their own.
// ============================================================================

/** Command radio range in tiles (60 tiles = 300 m). */
export const COMMAND_RADIUS_TILES = 60;

/** True when the soldier's side has an operational command team within radio range.
 * A side with NO operational command team at all is treated as in command: the penalty
 * models a broken link to the HQ, not the absence of any HQ (small actions, late-war
 * ad-hoc units must stay controllable). */
export function inCommand(state: BattleState, s: Soldier): boolean {
  let hq = false;
  for (const t of state.teams.values()) {
    if (t.side !== s.side || t.type !== 'command') continue;
    hq = true;
    if (t.outOfAction) continue;
    const cmd = state.soldiers.get(t.leaderId);
    if (!cmd || cmd.health === 'dead' || cmd.health === 'incapacitated') return false;
    if (distTiles(cmd.pos, s.pos) <= COMMAND_RADIUS_TILES) return true;
  }
  return !hq;
}
export function teamInCommand(state: BattleState, team: Team): boolean {
  const leader = state.soldiers.get(team.leaderId);
  if (!leader) return false;
  return inCommand(state, leader);
}

function distTiles(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
