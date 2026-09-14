import { describe, it, expect } from 'vitest';
import type { BattleState, MapDef, Side, Soldier, Terrain, Vehicle, Facing8 } from '@/shared/types';
import { SIDES, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { buildMap } from '@/sim/map';
import { updateSpotting, observerVisibility, observerStandingSpotScore, collectSpotters, SOLDIER_SPOT_RANGE_M } from '@/sim/spotting';
import { createMind } from '@/sim/mind';

function makeDef(paint: (tiles: Terrain[], w: number, h: number) => void, w = 120, h = 40): MapDef {
  return {
    id: 'test', name: 'Test', description: '', width: w, height: h, season: 'summer', paint,
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
}

let nextId = 1;
function makeSoldier(o: Partial<Soldier>): Soldier {
  return {
    id: nextId++, teamId: 1, side: 'german', name: 'T', rank: 'Pvt', weaponId: 'kar98k', ammo: 10, ammoReserve: 0,
    grenades: 0, health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing',
    activity: 'idle', pos: { x: 0, y: 0 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(50), ...o,
  };
}

function makeVehicle(o: Partial<Vehicle>): Vehicle {
  return {
    id: nextId++, teamId: 1, side: 'german', defId: 'pz4', pos: { x: 0, y: 0 }, hullFacing: 0, turretFacing: 0,
    state: 'idle' as Vehicle['state'], mainAmmo: 10, coaxAmmo: 100, path: [], speed: 0, targetVehicleId: null,
    targetSoldierId: null, targetPoint: null, mainFireTimer: 0, coaxFireTimer: 0, burnTimer: 0, hits: 0, ...o,
  };
}

function makeState(map: ReturnType<typeof buildMap>): BattleState {
  const spotted = {} as Record<Side, Set<number>>;
  const spottedVehicles = {} as Record<Side, Set<number>>;
  for (const s of SIDES) { spotted[s] = new Set(); spottedVehicles[s] = new Set(); }
  return {
    config: { mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map, phase: 'running', time: 100, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 100, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted, spottedVehicles, messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId: 1000,
  };
}

const MIX: Terrain[] = ['open', 'open', 'open', 'grass', 'grass', 'tallgrass', 'crops', 'hedge', 'woods', 'buildingStone', 'stonewall', 'scatteredtrees', 'fence'];

/** A mixed random battlefield with both sides scattered over it; returns a digest of every spotting
 * outcome (spotted sets + belief counts) over several ticks with movement in between. */
function spottingDigest(seed: number): string {
  nextId = 1;
  const layout = new Rng(seed * 7919);
  const def = makeDef((tiles) => { for (let i = 0; i < tiles.length; i++) tiles[i] = layout.pick(MIX); });
  const map = buildMap(def);
  for (let i = 0; i < map.smoke.length; i++) if (layout.chance(0.03)) map.smoke[i] = layout.range(0, 0.6);
  const state = makeState(map);
  const stances = ['standing', 'crouching', 'prone'] as const;
  const acts = ['idle', 'moving', 'movingFast', 'sneaking', 'firing'] as const;
  for (const side of SIDES) {
    for (let k = 0; k < 30; k++) {
      const s = makeSoldier({
        side, pos: { x: layout.range(0, map.width), y: layout.range(0, map.height) },
        stance: layout.pick(stances), activity: layout.pick(acts) as Soldier['activity'],
        facing: layout.int(0, 7) as Facing8, lastFiredAt: layout.chance(0.2) ? 98 : -999,
        health: layout.chance(0.1) ? 'dead' : 'healthy',
      });
      if (layout.chance(0.3)) s.mind.threatDir = layout.range(-Math.PI, Math.PI);
      state.soldiers.set(s.id, s);
    }
    for (let k = 0; k < 3; k++) {
      const v = makeVehicle({ side, pos: { x: layout.range(0, map.width), y: layout.range(0, map.height) } });
      state.vehicles.set(v.id, v);
    }
  }
  const rng = new Rng(seed);
  const out: string[] = [];
  for (let tick = 0; tick < 12; tick++) {
    updateSpotting(state, rng);
    for (const side of SIDES) {
      out.push(`${side}:${[...state.spotted[side]].sort((a, b) => a - b).join(',')}|${[...state.spottedVehicles[side]].sort((a, b) => a - b).join(',')}`);
    }
    out.push([...state.soldiers.values()].map((s) => s.mind.beliefs.length).join(''));
    for (const s of state.soldiers.values()) {
      s.pos = { x: Math.min(map.width - 0.01, Math.max(0, s.pos.x + layout.range(-3, 3))), y: Math.min(map.height - 0.01, Math.max(0, s.pos.y + layout.range(-3, 3))) };
    }
    state.time += 1;
  }
  return out.join('\n');
}

function fnv(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

describe('spotting outcomes are unchanged by the observerVisibility refactor', () => {
  it('matches the pre-refactor digest for fixed seeds', () => {
    const digests = [1, 2, 3, 4].map((seed) => fnv(spottingDigest(seed)));
    expect(digests).toEqual(GOLDEN);
  });
});

// Recorded from the pre-refactor spotting.ts (inline range checks + losTrace cache).
const GOLDEN: string[] = ['b87af327', '3f996815', '6e7e59b1', 'f3ac84a4'];

describe('observerVisibility', () => {
  const openMap = () => buildMap(makeDef((tiles) => tiles.fill('open'), 200, 20));

  it('open ground within range is visible', () => {
    const state = makeState(openMap());
    const obs = { pos: { x: 5.5, y: 10.5 }, soldier: null };
    const v = observerVisibility(state, obs, { x: 45.5, y: 10.5 }); // 80 m
    expect(v).toBeGreaterThan(0.7);
    expect(observerStandingSpotScore(state, obs, { x: 45.5, y: 10.5 })).toBeCloseTo(v);
  });

  it('beyond detection range is 0 even with a clear line', () => {
    const state = makeState(openMap());
    const obs = { pos: { x: 5.5, y: 10.5 }, soldier: null };
    const rangeTiles = SOLDIER_SPOT_RANGE_M / TILE_M;
    expect(observerVisibility(state, obs, { x: 5.5 + rangeTiles - 1, y: 10.5 })).toBeGreaterThan(0);
    expect(observerVisibility(state, obs, { x: 5.5 + rangeTiles + 2, y: 10.5 })).toBe(0);
    expect(observerStandingSpotScore(state, obs, { x: 5.5 + rangeTiles + 2, y: 10.5 })).toBe(0);
  });

  it('a wall blocks', () => {
    const map = buildMap(makeDef((tiles, w) => {
      tiles.fill('open');
      for (let y = 0; y < 20; y++) tiles[y * w + 20] = 'stonewall';
    }, 200, 20));
    const state = makeState(map);
    const obs = { pos: { x: 5.5, y: 10.5 }, soldier: null };
    expect(observerVisibility(state, obs, { x: 15.5, y: 10.5 })).toBeGreaterThan(0);
    expect(observerVisibility(state, obs, { x: 30.5, y: 10.5 })).toBe(0);
  });

  it('concealing terrain along the line gives partial visibility', () => {
    const map = buildMap(makeDef((tiles, w) => {
      tiles.fill('open');
      tiles[10 * w + 10] = 'hedge';
    }, 200, 20));
    const state = makeState(map);
    const obs = { pos: { x: 5.5, y: 10.5 }, soldier: null };
    const v = observerVisibility(state, obs, { x: 15.5, y: 10.5 });
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.5);
  });

  it('soldier spotters behind their facing get the mind 0.6 factor; crew in vehicles are not spotters', () => {
    const state = makeState(openMap());
    const s = makeSoldier({ side: 'german', pos: { x: 50.5, y: 10.5 }, facing: 2 as Facing8 }); // facing east
    const crew = makeSoldier({ side: 'german', pos: { x: 50.5, y: 10.5 }, vehicleId: 99 });
    state.soldiers.set(s.id, s);
    state.soldiers.set(crew.id, crew);
    const spotters = collectSpotters(state, 'german');
    expect(spotters.length).toBe(1);
    const ahead = observerStandingSpotScore(state, spotters[0], { x: 70.5, y: 10.5 });
    const behind = observerStandingSpotScore(state, spotters[0], { x: 30.5, y: 10.5 });
    expect(behind).toBeCloseTo(ahead * 0.6);
  });
});

describe.runIf(!!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VISPERF)('visibility overlay perf (VISPERF=1)', () => {
  it('measures one full pass on the largest map', async () => {
    const { Battle } = await import('@/sim/battle');
    const { MAPS } = await import('@/data/maps');
    const { DEFAULT_FORCES } = await import('@/data/operation');
    const { centerCamera, clampCamera } = await import('@/engine/camera');
    const ov = await import('@/render/visibilityOverlay');
    const biggest = [...MAPS].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const year = Number(/(\d{4})$/.exec(biggest.id)?.[1] ?? 1943);
    const battle = new Battle({ mapId: biggest.id, playerSide: 'german', year, seed: 3, durationS: 1200, difficulty: 'normal', forces: DEFAULT_FORCES[year] ?? DEFAULT_FORCES[1943] });
    const teams = battle.selectableTeams('german');
    const tank = teams.filter((t) => t.vehicleId != null).slice(0, 1);
    const inf = teams.filter((t) => t.vehicleId == null && t.soldierIds.length >= 6).slice(0, 3);
    for (const [label, sel] of [['1 tank', tank], ['3 infantry squads', inf]] as const) {
      for (const zoom of [1, 0.5]) {
        const cam = { x: 0, y: 0, zoom };
        centerCamera(cam, sel[0].pos);
        clampCamera(cam, battle.state.map.width, battle.state.map.height);
        const spotters = collectSpotters(battle.state, 'german', new Set(sel.map((t) => t.id)));
        const groups = ov.groupSpotters(spotters);
        const r = ov.overlayRegion(battle.state.map.width, battle.state.map.height, cam);
        let best = Infinity;
        const counts = [0, 0, 0];
        for (let rep = 0; rep < 3; rep++) {
          const t0 = performance.now();
          counts.fill(0);
          for (let cy = 0; cy < r.rows; cy++) for (let cx = 0; cx < r.cols; cx++) {
            counts[ov.classifyVisibility(battle.state, groups, r.x0 + cx * r.step + r.step / 2, r.y0 + cy * r.step + r.step / 2)]++;
          }
          best = Math.min(best, performance.now() - t0);
        }
        console.log(`${biggest.id} ${label} (${spotters.length} spotters, ${groups.length} tiles) zoom ${zoom}: ${r.cols}x${r.rows} cells, ${best.toFixed(1)} ms; clear/obscured/blocked ${counts.join('/')}`);
      }
    }
  });
});
