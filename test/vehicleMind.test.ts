import { describe, it, expect } from 'vitest';
import type {
  BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain, Vehicle,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind, baseMotivation } from '@/sim/mind';
import { stepVehicleMinds, stepVehicles, onVehicleHit, onVehicleNearMiss } from '@/sim/vehicle';
import { applyOrder } from '@/sim/orders';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { dist } from '@/shared/math';
import { hasLOS } from '@/sim/los';

const W = 200, H = 200;

function makeMap(setup?: (tiles: Terrain[]) => void): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  setup?.(tiles);
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

function setTile(tiles: Terrain[], x: number, y: number, t: Terrain): void {
  tiles[y * W + x] = t;
}

function makeState(map: GameMap): BattleState {
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map, phase: 'running', time: 0,
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

function makeCommander(id: number, teamId: number, overrides: Partial<Soldier> = {}): Soldier {
  const experience = overrides.experience ?? 50;
  return {
    id, teamId, side: 'german', name: `Cmdr${id}`, rank: 'Uffz', weaponId: 'kar98k',
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience, stance: 'standing', activity: 'defending',
    pos: { x: 10.5, y: 10.5 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: true, vehicleId: 1, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(baseMotivation(experience, true)),
    ...overrides,
  };
}

function makeVehicle(id: number, teamId: number, defId: string, overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id, teamId, side: 'german', defId, pos: { x: 10.5, y: 10.5 }, hullFacing: 0, turretFacing: 0,
    state: 'ok', mainAmmo: 50, coaxAmmo: 200, path: [], speed: 0,
    targetVehicleId: null, targetSoldierId: null, targetPoint: null,
    mainFireTimer: 0, coaxFireTimer: 0, burnTimer: 0, hits: 0,
    ...overrides,
  };
}

function makeTeam(id: number, vehicleId: number, soldierIds: number[]): Team {
  return {
    id, defId: 'test', side: 'german', name: 'Test Tank', type: 'tank', soldierIds,
    leaderId: soldierIds[0], vehicleId, order: null, facing: 0, experience: 50,
    morale: 80, status: 'Idle', pos: { x: 10.5, y: 10.5 }, outOfAction: false, kills: 0, aiObjective: null,
  };
}

function makeAtGunSoldier(id: number, pos: { x: number; y: number }): Soldier {
  return {
    id, teamId: 900, side: 'soviet', name: 'PakCrew', rank: 'Gefr', weaponId: 'pak40',
    ammo: 20, ammoReserve: 40, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'prone', activity: 'defending',
    pos, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: true, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(60),
  };
}

describe('vehicle crew mind: cover-seeking (spec §10)', () => {
  it('a tank shot at by a visible PaK turns and drives into side cover blocking LOS to it', () => {
    // The building sits off to the side (not on the vehicle's current north-south line of sight to
    // the PaK, which starts clear) so that only a nearby tile behind it is actually better cover.
    const map = makeMap((tiles) => setTile(tiles, 12, 10, 'buildingStone'));
    const state = makeState(map);

    const v = makeVehicle(1, 1, 'pz4gh', { pos: { x: 10.5, y: 10.5 }, hullFacing: 0 });
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1);
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));

    const pak = makeAtGunSoldier(50, { x: 10.5, y: 2.5 }); // due north, 8 tiles = 16m away
    state.soldiers.set(pak.id, pak);
    state.spotted.german.add(pak.id);

    onVehicleHit(state, v, WEAPONS.pak40, false, { ...pak.pos });

    const rng = new Rng(1);
    for (let i = 0; i < 14 / 0.05; i++) { state.time += 0.05; stepVehicleMinds(state, rng, 0.05); }

    expect(cmdr.mind.threatLevel).toBeGreaterThan(0);
    // Cover lies to the side: the hull must turn to drive there, instead of facing north while
    // the whole tank translates sideways. Cover remains a reachable, LOS-screened destination.
    expect(dist(v.pos, { x: 10.5, y: 10.5 })).toBeGreaterThan(1);
    expect(hasLOS(state.map, v.pos, pak.pos)).toBe(false);
  });

  it('a tank under rifle fire alone does not move (small arms never raise threatLevel above 0.3)', () => {
    const map = makeMap();
    const state = makeState(map);
    const v = makeVehicle(1, 1, 'pz4gh');
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1, { experience: 50 });
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));

    for (let i = 0; i < 20; i++) onVehicleHit(state, v, WEAPONS.kar98k, false, null);

    const rng = new Rng(1);
    const startPos = { ...v.pos };
    for (let i = 0; i < 10; i++) stepVehicleMinds(state, rng, 0.5);

    expect(cmdr.mind.threatLevel).toBeLessThanOrEqual(0.3);
    expect(v.pos).toEqual(startPos);
  });

  it('a Tiger vs a T-26 (45mm) at 300 m holds and fires (danger too low to flee)', () => {
    const map = makeMap();
    const state = makeState(map);
    const v = makeVehicle(1, 1, 'tiger', { pos: { x: 10.5, y: 10.5 } });
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1, { experience: 60 });
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));

    const enemy = makeVehicle(2, 2, 't26', { side: 'soviet', pos: { x: 10.5, y: 10.5 + 150 } }); // 300m south
    state.vehicles.set(enemy.id, enemy);
    state.spottedVehicles.german.add(enemy.id);

    const rng = new Rng(1);
    const startPos = { ...v.pos };
    for (let i = 0; i < 10; i++) stepVehicleMinds(state, rng, 0.5);

    expect(v.pos).toEqual(startPos); // holds ground
  });

  it('a PzKw IV F1 vs a KV-1 at 300 m reverses to cover (danger high, disadvantaged in a shootout)', () => {
    // Off to the side, as in the PaK test above, so the vehicle's current tile starts exposed.
    const map = makeMap((tiles) => setTile(tiles, 12, 10, 'buildingStone'));
    const state = makeState(map);
    const v = makeVehicle(1, 1, 'pz4f1', { pos: { x: 10.5, y: 10.5 } });
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1, { experience: 60 });
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));

    const enemy = makeVehicle(2, 2, 'kv1', { side: 'soviet', pos: { x: 10.5, y: 10.5 + 150 } }); // 300m south
    state.vehicles.set(enemy.id, enemy);
    state.spottedVehicles.german.add(enemy.id);

    const rng = new Rng(1);
    // historical hull rate: the Pz IV pivots at 18 deg/s, so bringing its front round to a threat
    // dead astern takes 10 s before it can back away (was under 5 s at the old 43 deg/s)
    for (let i = 0; i < 30; i++) stepVehicleMinds(state, rng, 0.5);

    expect(cmdr.mind.threatLevel).toBeGreaterThan(0);
    // PzKw IV F1 (front 50mm) vs KV-1's 76mm ZiS-5 (pen 70 @300m => ~49mm) is a losing exchange for
    // the PzIV, and it should be seeking cover rather than holding station.
    expect(v.pos.y).not.toBeCloseTo(10.5, 1);
  });
});

describe('vehicle crew fear from non-penetrating hits (spec §10.2)', () => {
  it('200 MG rounds on a T-26 with a 20-experience crew leave the commander shaken/cowering', () => {
    const map = makeMap();
    const state = makeState(map);
    const v = makeVehicle(1, 1, 't26');
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1, { experience: 20 });
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));

    for (let i = 0; i < 200; i++) onVehicleHit(state, v, WEAPONS.mg42, false, null);
    const rng = new Rng(1);
    stepVehicleMinds(state, rng, 0.1);

    expect(['shaken', 'cowering', 'panicked']).toContain(cmdr.mind.state);
  });

  it('the same 200 MG rounds on a Tiger with an 80-experience crew leave the commander calm/alert', () => {
    const map = makeMap();
    const state = makeState(map);
    const v = makeVehicle(1, 1, 'tiger');
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1, { experience: 80 });
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));

    for (let i = 0; i < 200; i++) onVehicleHit(state, v, WEAPONS.mg42, false, null);
    const rng = new Rng(1);
    stepVehicleMinds(state, rng, 0.1);

    expect(['calm', 'alert']).toContain(cmdr.mind.state);
  });
});

describe('vehicle crew alarm from AT near misses (spec §10c)', () => {
  it('a PaK round missing an unspotted tank alarms the crew and starts a drive to cover', () => {
    const map = makeMap((tiles) => setTile(tiles, 12, 10, 'buildingStone'));
    const state = makeState(map);
    const v = makeVehicle(1, 1, 'pz4gh', { pos: { x: 10.5, y: 10.5 }, hullFacing: 0 });
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1);
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));
    const pakPos = { x: 10.5, y: 2.5 }; // never spotted

    onVehicleNearMiss(state, v, WEAPONS.pak40, pakPos);
    expect(cmdr.mind.threatLevel).toBeGreaterThanOrEqual(0.8);

    const rng = new Rng(1);
    for (let i = 0; i < 14 / 0.05; i++) { state.time += 0.05; stepVehicleMinds(state, rng, 0.05); }
    expect(dist(v.pos, { x: 10.5, y: 10.5 })).toBeGreaterThan(1);
    expect(hasLOS(state.map, v.pos, pakPos)).toBe(false);
  });

  it('small-arms misses do not alarm a tank crew', () => {
    const state = makeState(makeMap());
    const v = makeVehicle(1, 1, 'pz4gh');
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1);
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));
    onVehicleNearMiss(state, v, WEAPONS.kar98k, { x: 10.5, y: 2.5 });
    expect(cmdr.mind.threatLevel).toBe(0);
  });
});

describe('dead hulls stay put (round-4 units finding 2)', () => {
  for (const dead of ['burning', 'knockedOut', 'abandoned'] as const) {
    it(`a ${dead} tank with a path left over stops dead and drops the path`, () => {
      const state = makeState(makeMap());
      const v = makeVehicle(1, 1, 'pz4gh', {
        state: dead, hullFacing: Math.PI / 2, speed: 5,
        path: [{ x: 30.5, y: 10.5 }, { x: 50.5, y: 10.5 }],
      });
      state.vehicles.set(v.id, v);
      const cmdr = makeCommander(1, 1);
      state.soldiers.set(cmdr.id, cmdr);
      state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));
      const start = { ...v.pos };
      const rng = new Rng(1);
      for (let i = 0; i < 20; i++) stepVehicles(state, rng, 0.25);
      expect(v.pos).toEqual(start);
      expect(v.speed).toBe(0);
      expect(v.path).toEqual([]);
    });
  }

  it('a move order to a burning tank (before morale marks the team out of action) gives it no path', () => {
    const state = makeState(makeMap());
    const v = makeVehicle(1, 1, 'pz4gh', { state: 'burning' });
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1);
    state.soldiers.set(cmdr.id, cmdr);
    const team = makeTeam(1, v.id, [cmdr.id]);
    state.teams.set(1, team);
    applyOrder(state, team, { type: 'move', target: { x: 40.5, y: 10.5 }, issuedAt: 0 }, new Rng(1));
    expect(v.path).toEqual([]);
    const start = { ...v.pos };
    for (let i = 0; i < 10; i++) stepVehicles(state, new Rng(2), 0.25);
    expect(v.pos).toEqual(start);
  });

  it('an ok tank with the same path does drive (control)', () => {
    const state = makeState(makeMap());
    const v = makeVehicle(1, 1, 'pz4gh', { hullFacing: Math.PI / 2, path: [{ x: 30.5, y: 10.5 }] });
    state.vehicles.set(v.id, v);
    const cmdr = makeCommander(1, 1);
    state.soldiers.set(cmdr.id, cmdr);
    state.teams.set(1, makeTeam(1, v.id, [cmdr.id]));
    const rng = new Rng(1);
    for (let i = 0; i < 20; i++) stepVehicles(state, rng, 0.25);
    expect(v.pos.x).not.toBeCloseTo(10.5, 1);
  });
});
