import type { BattleState, Team, TeamDef, Side, Vec2, Soldier, Vehicle } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, vadd } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { randomName } from '@/data/names';

const RELOAD_HEAVY = new Set(['mortar', 'atgun', 'atrocket']);

function formationOffset(index: number): Vec2 {
  if (index === 0) return { x: 0, y: 0 };
  const n = index - 1;
  const row = 1 + Math.floor(n / 4);
  const col = n % 4;
  const x = (col - 1.5) * 1.5;
  const y = row * 1.5;
  return { x, y };
}

/** Create a Team (and its soldiers, and its Vehicle if the def specifies one) at `pos`. */
export function spawnTeam(state: BattleState, def: TeamDef, side: Side, pos: Vec2, rng: Rng): Team {
  const teamId = state.nextId++;
  const soldierIds: number[] = [];

  const team: Team = {
    id: teamId,
    defId: def.id,
    side,
    name: def.name,
    type: def.type,
    soldierIds,
    leaderId: -1,
    vehicleId: null,
    order: null,
    facing: 0,
    experience: 0,
    morale: 80,
    status: 'Idle',
    pos: { x: pos.x, y: pos.y },
    outOfAction: false,
    kills: 0,
    aiObjective: null,
  };

  let vehicle: Vehicle | null = null;
  if (def.vehicleDefId) {
    const vdef = VEHICLE_DEFS[def.vehicleDefId];
    const centre = { x: state.map.width / 2, y: state.map.height / 2 };
    const facing = angleTo(pos, centre);
    vehicle = {
      id: state.nextId++,
      teamId,
      side,
      defId: def.vehicleDefId,
      pos: { x: pos.x, y: pos.y },
      hullFacing: facing,
      turretFacing: facing,
      state: 'ok',
      mainAmmo: vdef ? vdef.mainAmmo : 0,
      coaxAmmo: 250,
      path: [],
      speed: 0,
      targetVehicleId: null,
      targetSoldierId: null,
      targetPoint: null,
      mainFireTimer: 0,
      coaxFireTimer: 0,
      burnTimer: 0,
      hits: 0,
    };
    state.vehicles.set(vehicle.id, vehicle);
    team.vehicleId = vehicle.id;
  }

  let totalExp = 0;
  def.soldiers.forEach((sd, i) => {
    const weapon = WEAPONS[sd.weaponId];
    const ammo = weapon ? weapon.ammo : 0;
    const reserveMul = weapon && RELOAD_HEAVY.has(weapon.cls) ? 12 : 6;
    const isCrew = !!def.vehicleDefId;
    const grenades = sd.grenades ?? (isCrew ? 0 : (weapon && (weapon.cls === 'rifle' || weapon.cls === 'smg') ? 2 : 0));
    const experience = rng.range(20, 60);
    totalExp += experience;
    const offset = formationOffset(i);
    const soldierPos = vehicle ? { x: vehicle.pos.x, y: vehicle.pos.y } : vadd(pos, offset);

    const soldier: Soldier = {
      id: state.nextId++,
      teamId,
      side,
      name: `${sd.rank}. ${randomName(side, rng)}`,
      rank: sd.rank,
      weaponId: sd.weaponId,
      ammo,
      ammoReserve: ammo * reserveMul,
      grenades,
      health: 'healthy',
      morale: rng.range(70, 90),
      fatigue: 0,
      suppression: 0,
      experience,
      stance: 'standing',
      activity: 'idle',
      pos: soldierPos,
      facing: 0,
      targetSoldierId: null,
      targetVehicleId: null,
      targetPoint: null,
      path: [],
      reloadTimer: 0,
      fireTimer: 0,
      animFrame: 0,
      isLeader: i === 0,
      vehicleId: vehicle ? vehicle.id : null,
      formationOffset: offset,
      lastFiredAt: -999,
      cover: 0,
      kills: 0,
    };
    state.soldiers.set(soldier.id, soldier);
    soldierIds.push(soldier.id);
    if (i === 0) team.leaderId = soldier.id;
  });

  team.experience = def.soldiers.length ? totalExp / def.soldiers.length : 50;
  state.teams.set(teamId, team);
  return team;
}
