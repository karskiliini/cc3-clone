import { describe, it, expect } from 'vitest';
import type {
  BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind } from '@/sim/mind';
import { stepCoverSeeking } from '@/sim/coverSeek';
import { dist } from '@/shared/math';

const W = 20, H = 20;

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

function makeSoldier(id: number, teamId: number, overrides: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side: 'german', name: `S${id}`, rank: 'Gefr', weaponId: 'kar98k',
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'crouching', activity: 'defending',
    pos: { x: 10.5, y: 10.5 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: true, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(50),
    ...overrides,
  };
}

function makeTeam(id: number, soldierIds: number[], overrides: Partial<Team> = {}): Team {
  return {
    id, defId: 'test', side: 'german', name: 'Test Squad', type: 'rifle', soldierIds,
    leaderId: soldierIds[0], vehicleId: null, order: { type: 'defend', target: { x: 10.5, y: 10.5 }, issuedAt: 0 },
    facing: 0, experience: 50, morale: 80, status: 'Defending', pos: { x: 10.5, y: 10.5 },
    outOfAction: false, kills: 0, aiObjective: null,
    ...overrides,
  };
}

describe('stepCoverSeeking', () => {
  it('a defending soldier with one threat moves behind the wall on the threat side', () => {
    // Wall directly north of the soldier (10,9); threat comes from the north.
    const map = makeMap((tiles) => setTile(tiles, 10, 8, 'stonewall'));
    const state = makeState(map);
    const s = makeSoldier(1, 1, { pos: { x: 10.5, y: 12.5 } });
    s.mind.anchor = { x: 10.5, y: 12.5 };
    s.mind.threatDir = 0; // north
    s.mind.threatLevel = 1;
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1], { pos: { x: 10.5, y: 12.5 } }));

    const rng = new Rng(1);
    stepCoverSeeking(state, rng, 0.1);

    // Should have moved toward the tile just south of the wall (10, 9).
    expect(s.path.length).toBeGreaterThan(0);
    const dest = s.path[s.path.length - 1];
    expect(Math.floor(dest.x)).toBe(10);
    expect(Math.floor(dest.y)).toBe(9);
  });

  it('with two opposite threats, prefers omni cover (a trench) over a single wall', () => {
    const map = makeMap((tiles) => {
      setTile(tiles, 10, 8, 'stonewall'); // wall to the north
      setTile(tiles, 10, 11, 'trench');   // trench nearby, protects from all directions
    });
    const state = makeState(map);
    const s = makeSoldier(1, 1, { pos: { x: 10.5, y: 10.5 } });
    s.mind.anchor = { x: 10.5, y: 10.5 };
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1], { pos: { x: 10.5, y: 10.5 } }));
    s.mind.beliefs.push(
      { pos: { x: 10.5, y: 2 }, count: 1, confidence: 0.9, kind: 'seen', time: 0, deadSeen: 0 }, // north
      { pos: { x: 10.5, y: 19 }, count: 1, confidence: 0.9, kind: 'seen', time: 0, deadSeen: 0 }, // south
    );

    const rng = new Rng(2);
    stepCoverSeeking(state, rng, 0.1);

    expect(s.path.length).toBeGreaterThan(0);
    const dest = s.path[s.path.length - 1];
    expect(Math.floor(dest.x)).toBe(10);
    expect(Math.floor(dest.y)).toBe(11);
  });

  it('never moves the soldier outside a 6-tile radius of his ordered spot', () => {
    const map = makeMap((tiles) => setTile(tiles, 19, 19, 'stonewall'));
    const state = makeState(map);
    const anchor = { x: 5.5, y: 5.5 };
    const s = makeSoldier(1, 1, { pos: anchor });
    s.mind.anchor = { ...anchor };
    s.mind.threatDir = 0;
    s.mind.threatLevel = 1;
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1], { pos: anchor }));

    const rng = new Rng(3);
    for (let i = 0; i < 20; i++) stepCoverSeeking(state, rng, 0.1);

    for (const wp of s.path) {
      expect(dist(wp, anchor)).toBeLessThanOrEqual(6 + 1e-6);
    }
  });

  it('does nothing when the threat set is empty', () => {
    const map = makeMap();
    const state = makeState(map);
    const s = makeSoldier(1, 1);
    s.mind.anchor = { ...s.pos };
    state.soldiers.set(s.id, s);
    state.teams.set(1, makeTeam(1, [1], { order: null }));

    const rng = new Rng(4);
    stepCoverSeeking(state, rng, 0.1);
    expect(s.path.length).toBe(0);
  });
});
