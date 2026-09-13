import { describe, it, expect } from 'vitest';
import type {
  BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import { stepMorale, moraleWord } from '@/sim/morale';

const W = 20, H = 20;

function makeMap(): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {},
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 15, y: 15, w: 5, h: 5 } },
    attacker: 'german',
  };
  return {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1),
    windows: new Uint8Array(W * H),
    victoryLocations: [],
    smoke: new Float32Array(W * H),
    craters: [],
  };
}

function makeSoldier(id: number, teamId: number, overrides: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side: 'german', name: `S${id}`, rank: 'Gefr', weaponId: 'kar98k',
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos: { x: 5, y: 5 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: id === 1, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0,
    ...overrides,
  };
}

function makeState(): BattleState {
  const map = makeMap();
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  const soldiers = new Map<number, Soldier>();
  const s1 = makeSoldier(1, 1);
  const s2 = makeSoldier(2, 1);
  const s3 = makeSoldier(3, 1);
  soldiers.set(1, s1); soldiers.set(2, s2); soldiers.set(3, s3);

  const team: Team = {
    id: 1, defId: 'test_team', side: 'german', name: 'Rifle Squad', type: 'rifle',
    soldierIds: [1, 2, 3], leaderId: 1, vehicleId: null, order: null, facing: 0,
    experience: 50, morale: 80, status: 'Idle', pos: { x: 5, y: 5 }, outOfAction: false,
    kills: 0, aiObjective: null,
  };
  const teams = new Map<number, Team>();
  teams.set(1, team);

  return {
    config, map, phase: 'running', time: 0,
    soldiers, teams, vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId: 10,
  };
}

describe('stepMorale', () => {
  it('suppression above 85 transitions a soldier to cowering', () => {
    const state = makeState();
    const rng = new Rng(1);
    const s = state.soldiers.get(1)!;
    s.suppression = 90;
    stepMorale(state, rng, 0.1);
    expect(s.activity).toBe('cowering');
    expect(s.stance).toBe('prone');
  });

  it('morale below 10 transitions a soldier to routed', () => {
    const state = makeState();
    const rng = new Rng(1);
    const s = state.soldiers.get(1)!;
    s.morale = 5;
    stepMorale(state, rng, 0.1);
    expect(s.activity).toBe('routed');
  });

  it('suppression above 60 (but not 85) transitions to pinned', () => {
    const state = makeState();
    const rng = new Rng(1);
    const s = state.soldiers.get(1)!;
    s.suppression = 70;
    stepMorale(state, rng, 0.1);
    expect(s.activity).toBe('pinned');
  });

  it('does not break vehicle crew from suppression/morale alone (armor protects them)', () => {
    // Regression: crew soldiers (soldier.vehicleId set) share the vehicle's position, so any near
    // miss/HE splash landing on the vehicle used to suppress and morale-break them exactly like
    // exposed infantry — observed in playtesting as e.g. "PzKw III J has broken" seconds into a
    // battle. Crew should only lose morale via an actual crew casualty (handled elsewhere), not via
    // the suppression/pinned/cowering/panicked/routed cascade.
    const state = makeState();
    const rng = new Rng(1);
    const s = state.soldiers.get(1)!;
    s.vehicleId = 42;
    s.suppression = 95;
    s.morale = 5;
    stepMorale(state, rng, 0.1);
    expect(s.activity).not.toBe('cowering');
    expect(s.activity).not.toBe('pinned');
    expect(s.activity).not.toBe('routed');
    expect(s.activity).not.toBe('panicked');
  });

  it('team status is Routed once a majority (not necessarily all) of the squad is routed', () => {
    // Regression (balance round 3): computeTeamStatus used to require EVERY alive soldier to be
    // routed simultaneously, which combined with individual recovery (a soldier snapping back to
    // defending once morale/suppression improve) meant team.status essentially never showed
    // Routed/Surrendered/Broken in practice. A strict majority is enough.
    const state = makeState();
    const rng = new Rng(1);
    const s1 = state.soldiers.get(1)!;
    const s2 = state.soldiers.get(2)!;
    const s3 = state.soldiers.get(3)!;
    s1.morale = 5; s2.morale = 5; // stays routed (morale<10 keeps it routed every tick)
    s3.morale = 80; // this one is fine
    stepMorale(state, rng, 0.1);
    expect(s1.activity).toBe('routed');
    expect(s2.activity).toBe('routed');
    const team = state.teams.get(1)!;
    expect(team.status).toBe('Routed');
  });

  it('team status is Broken when average team morale drops below 25', () => {
    const state = makeState();
    const rng = new Rng(1);
    for (const id of [1, 2, 3]) {
      const s = state.soldiers.get(id)!;
      s.morale = 20; // below 25, but not low enough to trigger the routed/panicked cascade paths
      s.suppression = 0;
    }
    stepMorale(state, rng, 0.1);
    const team = state.teams.get(1)!;
    expect(team.status).toBe('Broken');
  });

  it('caches team morale and status', () => {
    const state = makeState();
    const rng = new Rng(1);
    stepMorale(state, rng, 0.1);
    const team = state.teams.get(1)!;
    expect(team.morale).toBeGreaterThan(0);
    expect(team.status).toBeDefined();
  });
});

describe('moraleWord', () => {
  it('maps thresholds correctly', () => {
    expect(moraleWord(90)).toBe('Fanatic');
    expect(moraleWord(70)).toBe('Confident');
    expect(moraleWord(50)).toBe('Steady');
    expect(moraleWord(30)).toBe('Shaken');
    expect(moraleWord(10)).toBe('Broken');
  });
});
