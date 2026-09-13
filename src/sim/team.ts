import type { BattleState, Team, Soldier, TeamType } from '@/shared/types';
import { moraleWord } from './morale';

export { moraleWord };

const SMOKE_CAPABLE: TeamType[] = ['rifle', 'smg', 'engineer', 'mortar', 'tank'];

/** Alive (not dead/incapacitated) soldiers of a team, in team order. */
export function aliveSoldiers(state: BattleState, team: Team): Soldier[] {
  const out: Soldier[] = [];
  for (const id of team.soldierIds) {
    const s = state.soldiers.get(id);
    if (s && s.health !== 'dead' && s.health !== 'incapacitated') out.push(s);
  }
  return out;
}

/** Whether the team can deploy/throw/fire smoke (mortars, tanks with smoke rounds, or squads
 * that carry smoke grenades — rifle/smg/engineer squads per spec). */
export function teamHasSmoke(state: BattleState, team: Team): boolean {
  return SMOKE_CAPABLE.includes(team.type);
}

/** Whether the team has any means to fire (alive soldiers with ammo, or an operational vehicle). */
export function teamCanFire(state: BattleState, team: Team): boolean {
  if (team.outOfAction) return false;
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    return !!v && (v.state === 'ok' || v.state === 'immobilized');
  }
  return aliveSoldiers(state, team).some((s) => s.ammo > 0 || s.ammoReserve > 0 || s.grenades > 0);
}

