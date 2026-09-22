import { describe, it, expect } from 'vitest';
import type { BattleState, MapDef, Side, Soldier, Terrain } from '@/shared/types';
import { SIDES } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { buildMap } from '@/sim/map';
import { MapPainter } from '@/sim/mapdsl';
import { updateSpotting } from '@/sim/spotting';
import { createMind } from '@/sim/mind';

function makeDef(paint: (tiles: Terrain[], w: number, h: number) => void, w = 120, h = 20): MapDef {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    width: w,
    height: h,
    season: 'summer',
    paint,
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
}

let nextSoldierId = 1;
function makeSoldier(overrides: Partial<Soldier>): Soldier {
  return {
    id: nextSoldierId++,
    teamId: 1,
    side: 'german',
    name: 'Test',
    rank: 'Pvt',
    weaponId: 'kar98k',
    ammo: 10,
    ammoReserve: 0,
    grenades: 0,
    health: 'healthy',
    morale: 80,
    fatigue: 0,
    suppression: 0,
    experience: 50,
    stance: 'standing',
    activity: 'idle',
    pos: { x: 0, y: 0 },
    facing: 0,
    targetSoldierId: null,
    targetVehicleId: null,
    targetPoint: null,
    path: [],
    reloadTimer: 0,
    fireTimer: 0,
    animFrame: 0,
    isLeader: false,
    vehicleId: null,
    formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999,
    cover: 0,
    kills: 0,
    mind: createMind(50),
    ...overrides,
  };
}

function makeState(map: ReturnType<typeof buildMap>): BattleState {
  const spotted = {} as Record<Side, Set<number>>;
  const spottedVehicles = {} as Record<Side, Set<number>>;
  for (const s of SIDES) { spotted[s] = new Set(); spottedVehicles[s] = new Set(); }
  return {
    config: { mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map,
    phase: 'running',
    time: 100,
    soldiers: new Map(),
    teams: new Map(),
    vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted,
    spottedVehicles,
    messages: [],
    explosions: [],
    tracers: [],
    flashes: [],
    bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
    result: null,
    events: [],
    nextId: 1000,
  };
}

describe('spotting', () => {
  it('reveals a firing enemy soldier at 150m in the open', () => {
    const def = makeDef((tiles, w, h) => new MapPainter(tiles, w, h, 1).fill('open'));
    const map = buildMap(def);
    const state = makeState(map);

    const spotter = makeSoldier({ side: 'german', pos: { x: 5, y: 10 } });
    const target = makeSoldier({
      side: 'soviet',
      pos: { x: 5 + 75, y: 10 }, // 75 tiles * 2m/tile = 150m
      stance: 'standing',
      activity: 'firing',
      lastFiredAt: state.time,
    });
    state.soldiers.set(spotter.id, spotter);
    state.soldiers.set(target.id, target);

    updateSpotting(state, new Rng(1));

    expect(state.spotted.german.has(target.id)).toBe(true);
  });

  it('mostly does not spot a prone soldier sneaking through tallgrass at 150m', () => {
    const def = makeDef((tiles, w, h) => {
      const p = new MapPainter(tiles, w, h, 1);
      p.fill('tallgrass');
    });
    const map = buildMap(def);
    const state = makeState(map);

    const spotter = makeSoldier({ side: 'german', pos: { x: 5, y: 10 } });
    const target = makeSoldier({
      side: 'soviet',
      pos: { x: 5 + 75, y: 10 },
      stance: 'prone',
      activity: 'sneaking',
      lastFiredAt: -999,
    });
    state.soldiers.set(spotter.id, spotter);
    state.soldiers.set(target.id, target);

    // deterministic across seeds because concealment accumulates past 1.0 over dense tallgrass,
    // fully blocking LOS (visibility 0) regardless of rng roll.
    for (let seed = 1; seed <= 5; seed++) {
      const s = makeState(map);
      s.soldiers.set(spotter.id, { ...spotter });
      s.soldiers.set(target.id, { ...target });
      updateSpotting(s, new Rng(seed));
      expect(s.spotted.german.has(target.id)).toBe(false);
    }
  });

  it('always spots anything within 10m with clear LOS', () => {
    const def = makeDef((tiles, w, h) => new MapPainter(tiles, w, h, 1).fill('open'));
    const map = buildMap(def);
    const state = makeState(map);

    const spotter = makeSoldier({ side: 'german', pos: { x: 5, y: 10 } });
    const target = makeSoldier({
      side: 'soviet',
      pos: { x: 6, y: 10 }, // 2 tiles = 4m
      stance: 'prone',
      activity: 'sneaking',
    });
    state.soldiers.set(spotter.id, spotter);
    state.soldiers.set(target.id, target);

    updateSpotting(state, new Rng(42));
    expect(state.spotted.german.has(target.id)).toBe(true);
  });

  it('does not spot soldiers crewing a vehicle individually', () => {
    const def = makeDef((tiles, w, h) => new MapPainter(tiles, w, h, 1).fill('open'));
    const map = buildMap(def);
    const state = makeState(map);

    const spotter = makeSoldier({ side: 'german', pos: { x: 5, y: 10 } });
    const crew = makeSoldier({ side: 'soviet', pos: { x: 6, y: 10 }, vehicleId: 1 });
    state.soldiers.set(spotter.id, spotter);
    state.soldiers.set(crew.id, crew);

    updateSpotting(state, new Rng(7));
    expect(state.spotted.german.has(crew.id)).toBe(false);
  });
});
