// Item 028: a tank rolling over an enemy crew-served gun smashes it; the wreck never fires
// again, takes no orders, and friendly guns under a friendly hull are never crushed.
import { describe, it, expect } from 'vitest';
import type { BattleState, CrewWeaponState, GameMap, MapDef, Soldier, Team, Terrain, Vehicle } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind } from '@/sim/mind';
import { stepOverrun } from '@/sim/vehicle';
import { hasChamberedRound } from '@/sim/crewWeapon';

const W = 120, H = 60;

function makeMap(): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
  return {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
}

function makeState(playerSide: 'german' | 'soviet'): BattleState {
  const config: BattleState['config'] = {
    mapId: 'test', playerSide, year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map: makeMap(), phase: 'running', time: 0,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
    result: null, events: [], nextId: 100,
  };
}

function man(id: number, teamId: number, side: 'german' | 'soviet', pos: { x: number; y: number }): Soldier {
  return {
    id, teamId, side, name: `M${id}`, rank: 'Pvt', weaponId: 'mosin', ammo: 5, ammoReserve: 20, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'idle',
    pos, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0,
    fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(80),
  };
}

function pakTeam(id: number, side: 'german' | 'soviet', ids: number[], pos: { x: number; y: number }): Team {
  const cw: CrewWeaponState = {
    weaponId: side === 'german' ? 'pak40' : 'zis3', pos, facing: 0, phase: 'ready', timer: 0, phaseTotal: 0,
    gunnerId: ids[0], abandoned: false, abandonedAt: 0, setAt: 0,
    goal: 'deploy', done: ['unhook', 'spreadLeft', 'spreadRight', 'digLeft', 'digRight'], progress: {}, workers: {}, open: [],
  };
  return {
    id, defId: 'test', side, name: `AT ${id}`, type: 'atgun', soldierIds: ids, leaderId: ids[0],
    vehicleId: null, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle', pos,
    outOfAction: false, kills: 0, aiObjective: null, crewWeapon: cw,
  };
}

function tank(id: number, teamId: number, side: 'german' | 'soviet', pos: { x: number; y: number }): Vehicle {
  return {
    id, teamId, side, defId: 'pz4gh', pos, hullFacing: Math.PI / 2, turretFacing: Math.PI / 2,
    state: 'ok', mainAmmo: 50, coaxAmmo: 200, path: [], speed: 2,
    targetVehicleId: null, targetSoldierId: null, targetPoint: null, mainFireTimer: 1e9, coaxFireTimer: 1e9, burnTimer: 0, hits: 0,
  };
}

describe('item 028: tank overrun destroys AT guns', () => {
  it('an enemy gun under the hull is destroyed: flagged, no mission, no orders, never fires', () => {
    const state = makeState('soviet');
    const tv = tank(1, 1, 'german', { x: 20.5, y: 30.5 });
    state.vehicles.set(1, tv);
    const cmdr = man(90, 1, 'german', { ...tv.pos });
    cmdr.vehicleId = 1;
    state.soldiers.set(90, cmdr);
    state.teams.set(1, { id: 1, defId: 't', side: 'german', name: 'T', type: 'tank', soldierIds: [90], leaderId: 90, vehicleId: 1, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle', pos: { ...tv.pos }, outOfAction: false, kills: 0, aiObjective: null });

    const gunner = man(10, 2, 'soviet', { x: 21.4, y: 30.6 });
    gunner.path = [{ x: 25, y: 30 }]; // he dodges clear; the gun cannot
    state.soldiers.set(10, gunner);
    state.teams.set(2, pakTeam(2, 'soviet', [10], { x: 20.7, y: 30.5 }));

    stepOverrun(state, new Rng(7), tv, Math.PI / 2);
    const cw = state.teams.get(2)!.crewWeapon!;
    expect(cw.destroyed).toBe(true);
    expect(cw.mission).toBeUndefined();
    // and the chambered-round accessor refuses a destroyed gun
    expect(hasChamberedRound(state.teams.get(2), gunner)).toBe(false);
    // message went out
    expect(state.messages.some((m) => m.text.includes('smashed'))).toBe(true);
  });

  it('a friendly gun under a friendly hull is NOT destroyed', () => {
    const state = makeState('german');
    const tv = tank(1, 1, 'german', { x: 20.5, y: 30.5 });
    state.vehicles.set(1, tv);
    const cmdr = man(90, 1, 'german', { ...tv.pos });
    cmdr.vehicleId = 1;
    state.soldiers.set(90, cmdr);
    state.teams.set(1, { id: 1, defId: 't', side: 'german', name: 'T', type: 'tank', soldierIds: [90], leaderId: 90, vehicleId: 1, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle', pos: { ...tv.pos }, outOfAction: false, kills: 0, aiObjective: null });

    const gunner = man(10, 2, 'german', { x: 21.4, y: 30.6 });
    gunner.path = [{ x: 25, y: 30 }];
    state.soldiers.set(10, gunner);
    state.teams.set(2, pakTeam(2, 'german', [10], { x: 20.7, y: 30.5 }));

    stepOverrun(state, new Rng(7), tv, Math.PI / 2);
    expect(state.teams.get(2)!.crewWeapon!.destroyed).toBeUndefined();
  });
});
