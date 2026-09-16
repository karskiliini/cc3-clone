import { describe, expect, it } from 'vitest';
import { computeResult, prisonerCount, sideScore, stepVictory } from '@/sim/victory';
import { SIDES, VL_CAPTURE_SECONDS } from '@/shared/types';
import type { BattleState, Side, Soldier, Vec2 } from '@/shared/types';
import { createMind } from '@/sim/mind';

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
    mind: createMind(50),
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

    state.sides.german.score = 140; state.sides.soviet.score = 0; // (160)/(20) = 8
    expect(computeResult(state)).toBe('totalVictory');

    state.sides.german.score = 60; state.sides.soviet.score = 0; // (80)/(20) = 4
    expect(computeResult(state)).toBe('decisiveVictory');

    state.sides.german.score = 20; state.sides.soviet.score = 0; // (40)/(20) = 2
    expect(computeResult(state)).toBe('majorVictory');

    state.sides.german.score = 5; state.sides.soviet.score = 0; // (25)/(20) = 1.25
    expect(computeResult(state)).toBe('minorVictory');

    state.sides.german.score = 0; state.sides.soviet.score = 0; // (20)/(20) = 1
    expect(computeResult(state)).toBe('draw');

    state.sides.german.score = 0; state.sides.soviet.score = 5; // (20)/(25) = 0.8
    expect(computeResult(state)).toBe('minorDefeat');

    state.sides.german.score = 0; state.sides.soviet.score = 20; // (20)/(40) = 0.5
    expect(computeResult(state)).toBe('majorDefeat');

    state.sides.german.score = 0; state.sides.soviet.score = 60; // (20)/(80) = 0.25
    expect(computeResult(state)).toBe('decisiveDefeat');

    state.sides.german.score = 0; state.sides.soviet.score = 140; // (20)/(160) = 0.125
    expect(computeResult(state)).toBe('totalDefeat');
  });

  it('grades a lopsided rout (round5 critique #10: 40 losses to 13, 0/8 VLs) as a decisive-or-worse defeat, not "Minor Defeat"', () => {
    const state = makeState();
    // German (player) got wiped out and held none of the 8 victory locations the enemy holds.
    state.sides.german.kills = 12;
    state.sides.german.losses = 40;
    state.sides.soviet.kills = 40;
    state.sides.soviet.losses = 12;
    for (let i = 0; i < 8; i++) {
      state.map.victoryLocations.push({ id: 10 + i, name: `VL${i}`, x: 0, y: 0, value: 1, owner: 'soviet', captureTimer: 0, capturingSide: null });
    }
    for (const s of SIDES) state.sides[s].score = sideScore(state, s);
    const result = computeResult(state);
    expect(['majorDefeat', 'decisiveDefeat', 'totalDefeat']).toContain(result);
  });

  it('counts surrendered enemy soldiers as prisoners worth 3x a kill in score (balance round 3)', () => {
    const state = makeState();
    const prisoner = makeSoldier('soviet', { x: 0, y: 0 });
    prisoner.activity = 'surrendered';
    state.soldiers.set(prisoner.id, prisoner);

    expect(prisonerCount(state, 'german')).toBe(1);
    expect(prisonerCount(state, 'soviet')).toBe(0); // a soviet soldier surrendering isn't soviet's own prisoner

    state.sides.german.kills = 0;
    state.sides.german.losses = 0;
    // score = vlPoints(0) + kills*2(0) + prisoners*2*3(1*6) - losses(0)
    expect(sideScore(state, 'german')).toBe(6);
  });

  it('does not force a morale-based ceasefire before the 5-minute floor', () => {
    const state = makeState();
    state.sides.german.morale = 5; // well below the <10 ceasefire threshold
    state.time = 60; // 1 minute in
    stepVictory(state, 0.1);
    expect(state.phase).toBe('running');
  });

  it('does force a morale-based ceasefire once past the 5-minute floor', () => {
    const state = makeState();
    state.sides.german.morale = 5;
    state.time = 5 * 60 + 1;
    stepVictory(state, 0.1);
    expect(state.phase).toBe('ended');
  });
});
