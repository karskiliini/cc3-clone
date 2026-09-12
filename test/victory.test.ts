import { describe, expect, it } from 'vitest';
import { computeResult, stepVictory } from '@/sim/victory';
import { VL_CAPTURE_SECONDS } from '@/shared/types';
import type { BattleState, Side, Soldier, Vec2 } from '@/shared/types';

function makeState(): BattleState {
  return {
    config: { mapId: 'x', playerSide: 'german', year: 1941, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map: {
      def: {
        id: 'x', name: 'x', description: '', width: 100, height: 100, season: 'summer',
        paint: () => {},
        victoryLocations: [],
        deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 50, y: 50, w: 5, h: 5 } },
        attacker: 'german',
      },
      width: 100,
      height: 100,
      tiles: [],
      buildingId: new Int16Array(0),
      windows: new Uint8Array(0),
      victoryLocations: [{ id: 1, name: 'Crossroads', x: 10, y: 10, value: 2, owner: null, captureTimer: 0, capturingSide: null }],
      smoke: new Float32Array(0),
      craters: [],
    },
    phase: 'running',
    time: 0,
    soldiers: new Map(),
    teams: new Map(),
    vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [],
    explosions: [],
    tracers: [],
    flashes: [],
    bloodDecals: [],
    result: null,
    events: [],
    nextId: 1,
  };
}

let nextId = 1;
function makeSoldier(side: Side, pos: Vec2): Soldier {
  return {
    id: nextId++,
    teamId: 1,
    side,
    name: 'Test',
    rank: 'Pte',
    weaponId: 'kar98k',
    ammo: 5,
    ammoReserve: 30,
    grenades: 2,
    health: 'healthy',
    morale: 80,
    fatigue: 0,
    suppression: 0,
    experience: 50,
    stance: 'standing',
    activity: 'idle',
    pos,
    facing: 0,
    targetSoldierId: null,
    targetVehicleId: null,
    targetPoint: null,
    path: [],
    reloadTimer: 0,
    fireTimer: 0,
    animFrame: 0,
    isLeader: true,
    vehicleId: null,
    formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999,
    cover: 0,
    kills: 0,
  };
}

describe('victory', () => {
  it('flips VL ownership after uncontested capture time', () => {
    const state = makeState();
    const vl = state.map.victoryLocations[0];
    const s = makeSoldier('german', { x: vl.x, y: vl.y });
    state.soldiers.set(s.id, s);

    const dt = 0.5;
    const steps = Math.ceil((VL_CAPTURE_SECONDS + 1) / dt);
    for (let i = 0; i < steps; i++) stepVictory(state, dt);

    expect(vl.owner).toBe('german');
  });

  it('does not flip a contested VL', () => {
    const state = makeState();
    const vl = state.map.victoryLocations[0];
    const g = makeSoldier('german', { x: vl.x, y: vl.y });
    const r = makeSoldier('soviet', { x: vl.x + 1, y: vl.y });
    state.soldiers.set(g.id, g);
    state.soldiers.set(r.id, r);

    const dt = 0.5;
    const steps = Math.ceil((VL_CAPTURE_SECONDS + 2) / dt);
    for (let i = 0; i < steps; i++) stepVictory(state, dt);

    expect(vl.owner).toBeNull();
  });

  it('computes result thresholds from the player perspective', () => {
    const state = makeState();

    state.sides.german.score = 100; state.sides.soviet.score = 0; // (120)/(20) = 6
    expect(computeResult(state)).toBe('decisive');

    state.sides.german.score = 10; state.sides.soviet.score = 0; // (30)/(20) = 1.5
    expect(computeResult(state)).toBe('victory');

    state.sides.german.score = 0; state.sides.soviet.score = 0; // (20)/(20) = 1
    expect(computeResult(state)).toBe('draw');

    state.sides.german.score = 0; state.sides.soviet.score = 100; // (20)/(120) ~= 0.167
    expect(computeResult(state)).toBe('defeat');
  });
});
