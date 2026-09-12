import type { BattleState, Team, Soldier, TeamStatusWord, TeamType, Vec2 } from '@/shared/types';
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

/** Average position of alive soldiers, or the vehicle's position for vehicle teams. */
export function teamCentre(state: BattleState, team: Team): Vec2 {
  if (team.vehicleId != null) {
    const v = state.vehicles.get(team.vehicleId);
    if (v) return { x: v.pos.x, y: v.pos.y };
  }
  const alive = aliveSoldiers(state, team);
  if (alive.length === 0) return team.pos;
  let sx = 0, sy = 0;
  for (const s of alive) { sx += s.pos.x; sy += s.pos.y; }
  return { x: sx / alive.length, y: sy / alive.length };
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

function majority(pool: Soldier[], pred: (s: Soldier) => boolean): boolean {
  if (pool.length === 0) return false;
  let n = 0;
  for (const s of pool) if (pred(s)) n++;
  return n > pool.length / 2;
}

/** Derive the display status word for a team from its soldiers'/vehicle's state, per spec §6.2/6.7. */
export function teamStatus(state: BattleState, team: Team): TeamStatusWord {
  const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
  const alive = aliveSoldiers(state, team);

  if (team.vehicleId != null) {
    if (!vehicle) return 'Destroyed';
    if (vehicle.state === 'knockedOut' || vehicle.state === 'burning') return 'Knocked Out';
  } else if (alive.length === 0) {
    return 'Destroyed';
  }

  if (majority(alive, (s) => s.activity === 'surrendered')) return 'Surrendered';
  if (majority(alive, (s) => s.activity === 'routed')) return 'Routed';
  if (team.morale < 25) return 'Broken';
  if (majority(alive, (s) => s.activity === 'panicked')) return 'Panicked';
  if (majority(alive, (s) => s.activity === 'cowering')) return 'Cowering';
  if (majority(alive, (s) => s.activity === 'pinned')) return 'Pinned';

  switch (team.order?.type) {
    case 'moveFast': return 'Moving Fast';
    case 'sneak': return 'Sneaking';
    case 'fire': return 'Firing';
    case 'defend': return 'Defending';
    case 'ambush': return 'Ambushing';
    case 'move': return 'Moving';
    default: break;
  }

  if (majority(alive, (s) => s.activity === 'moving')) return 'Moving';
  if (majority(alive, (s) => s.activity === 'movingFast')) return 'Moving Fast';
  if (majority(alive, (s) => s.activity === 'sneaking')) return 'Sneaking';
  if (majority(alive, (s) => s.activity === 'firing')) return 'Firing';
  if (majority(alive, (s) => s.activity === 'defending')) return 'Defending';
  if (majority(alive, (s) => s.activity === 'ambushing')) return 'Ambushing';
  return 'Idle';
}
