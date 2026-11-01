import { describe, expect, it } from 'vitest';
import { TEAM_DEFS, VEHICLE_DEFS } from '@/data/units';
import { hullParams, VEHICLE_PHYSICS_PROVENANCE } from '@/data/vehiclePhysics';
import { Battle } from '@/sim/battle';
import { spawnTeam, vehicleDeploySpacing } from '@/sim/spawn';
import { spawnMortarCarriers } from '@/sim/mortarCarriers';
import { isPassable } from '@/sim/path';

function emptyBattle(): Battle {
  return new Battle({ mapId: 'border_1941', playerSide: 'german', year: 1942, seed: 7,
    durationS: 120, difficulty: 'normal', forces: { german: [], soviet: [] } });
}

describe('organic mortar transport', () => {
  it('keeps real one-driver crews distinct from passenger seats, with an explicitly estimated Jeep', () => {
    for (const [teamId, capacity] of [['ger_kettenkrad', 2], ['ger_kubelwagen', 3], ['sov_jeep', 3]] as const) {
      const def = TEAM_DEFS[teamId], vehicle = VEHICLE_DEFS[def.vehicleDefId!];
      expect(def.soldiers).toHaveLength(1);
      expect(vehicle.crew).toBe(1);
      expect(vehicle.passengers).toBe(capacity);
      expect(vehicle.lightTransport!.passengerSeats).toHaveLength(capacity);
      expect(vehicle.lightTransport!.towMaxKg).toBeGreaterThan(0);
      const seats = [vehicle.lightTransport!.driverSeat, ...vehicle.lightTransport!.passengerSeats];
      expect(new Set(seats.map(s => `${s.x}/${s.y}/${s.z}`)).size).toBe(capacity + 1);
    }
    const jeep = hullParams(VEHICLE_DEFS.jeep);
    expect(jeep.massKg).toBe(1150);
    expect(jeep.cgHeightM).toBe(0.65);
    expect(jeep.driveKind).toBe('wheeled');
    expect(jeep.contacts).toHaveLength(4);
    expect(jeep.contacts.filter(c => c.driven)).toHaveLength(4);
    expect(jeep.contacts.filter(c => c.steer)).toHaveLength(2);
    expect(jeep.contacts.map(c => c.local.y)).toEqual([-1.02, 1.02, -1.02, 1.02]);
    expect(VEHICLE_PHYSICS_PROVENANCE.jeep.provenance.geometry.status).toBe('estimated for simulation');
    expect(VEHICLE_PHYSICS_PROVENANCE.jeep.provenance.massT.status).toBe('estimated for simulation');
  });

  it('assigns the German pair and two Soviet Jeeps with separate mounted drivers and enough places', () => {
    const b = emptyBattle(), state = b.state;
    const mortars = [
      spawnTeam(state, TEAM_DEFS.ger_mortar81, 'german', { x: 12.5, y: 20.5 }, b.rng),
      spawnTeam(state, TEAM_DEFS.sov_mortar120, 'soviet', { x: 100.5, y: 20.5 }, b.rng),
    ];
    spawnMortarCarriers(state, b.rng);
    for (const mortar of mortars) {
      const vehicles = mortar.assignedVehicleIds!.map(id => state.vehicles.get(id)!);
      expect(vehicles.map(v => v.defId)).toEqual(mortar.side === 'german' ? ['kettenkrad', 'kubelwagen'] : ['jeep', 'jeep']);
      expect(vehicles.reduce((n, v) => n + VEHICLE_DEFS[v.defId].lightTransport!.passengerSeats.length, 0))
        .toBeGreaterThanOrEqual(mortar.soldierIds.length);
      for (const v of vehicles) {
        const driverTeam = state.teams.get(v.teamId)!;
        expect(driverTeam.supportForTeamId).toBe(mortar.id);
        expect(driverTeam.soldierIds).toHaveLength(1);
        expect(state.soldiers.get(driverTeam.soldierIds[0])!.vehicleId).toBe(v.id);
        expect(isPassable(state.map, Math.floor(v.pos.x), Math.floor(v.pos.y), 'vehicle')).toBe(true);
      }
      const [a, c] = vehicles;
      expect(Math.hypot(a.pos.x - c.pos.x, a.pos.y - c.pos.y)).toBeGreaterThanOrEqual(vehicleDeploySpacing(a.defId, c.defId));
    }
    const nextId = state.nextId, rng = b.rng.state(), count = state.teams.size;
    spawnMortarCarriers(state, b.rng);
    expect(state.teams.size).toBe(count);
    expect(state.nextId).toBe(nextId);
    expect(b.rng.state()).toBe(rng);
    expect(new Set([...state.teams.keys(), ...state.soldiers.keys(), ...state.vehicles.keys()]).size)
      .toBe(state.teams.size + state.soldiers.size + state.vehicles.size);
  });

  it('does not give organic drivers campaign UIDs or mutate the roster payload', () => {
    const b = emptyBattle(), state = b.state;
    const mortar = spawnTeam(state, TEAM_DEFS.ger_mortar81, 'german', { x: 12.5, y: 20.5 }, b.rng);
    const roster = { german: [['mortar'], ['wrong-driver-1'], ['wrong-driver-2']], soviet: [] };
    state.config.rosterUids = roster;
    const config = state.config, before = structuredClone(roster);
    spawnMortarCarriers(state, b.rng);
    expect(state.config).toBe(config);
    expect(state.config.rosterUids).toBe(roster);
    expect(roster).toEqual(before);
    for (const id of mortar.assignedVehicleIds!) {
      const team = state.teams.get(state.vehicles.get(id)!.teamId)!;
      expect(state.soldiers.get(team.leaderId)!.uid).toBeUndefined();
    }
  });
});


it('keeps assigned carriers with a mortar moved during deployment and never deploy-teleports in battle', () => {
  const battle=new Battle({mapId:'border_1941',playerSide:'german',year:1942,seed:42,durationS:600,difficulty:'normal',forces:{german:['ger_mortar81'],soviet:[]}});
  const state=battle.state, mortar=[...state.teams.values()].find(t=>t.type==='mortar')!;
  const before=mortar.assignedVehicleIds!.map(id=>({...state.vehicles.get(id)!.pos}));
  const zone=state.map.def.deployZones.german;
  let point={...mortar.pos};
  outer:for(let y=zone.y+2;y<zone.y+zone.h-2;y++)for(let x=zone.x+2;x<zone.x+zone.w-2;x++){
    if(Math.hypot(x-mortar.pos.x,y-mortar.pos.y)>8 && battle.canDeployTeam(mortar.id,{x,y})){point={x,y};break outer;}
  }
  expect(battle.deployTeam(mortar.id,point)).toBe(true);
  expect(mortar.assignedVehicleIds!.some((id,i)=>JSON.stringify(state.vehicles.get(id)!.pos)!==JSON.stringify(before[i]))).toBe(true);
  for(const id of mortar.assignedVehicleIds!){const v=state.vehicles.get(id)!;const t=state.teams.get(v.teamId)!;
    expect(t.pos).toEqual(v.pos);expect(state.soldiers.get(t.soldierIds[0])!.pos).toEqual(v.pos);}
  state.phase='running';const positions=mortar.assignedVehicleIds!.map(id=>({...state.vehicles.get(id)!.pos}));
  expect(battle.deployTeam(mortar.id,{x:point.x+1,y:point.y})).toBe(false);
  expect(mortar.assignedVehicleIds!.map(id=>state.vehicles.get(id)!.pos)).toEqual(positions);
});
