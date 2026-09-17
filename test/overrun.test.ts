// Tank overrun (spec 2026-09-17 §7).
import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Terrain, Vehicle } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind } from '@/sim/mind';
import { stepVehicles, canReactToOverrun, overrunDodgeChance } from '@/sim/vehicle';
import { stepMovement } from '@/sim/movement';

const W = 120, H = 60;

function makeState(): BattleState {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 1, h: 1 }, soviet: { x: 0, y: 0, w: 1, h: 1 } },
    attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'soviet', year: 1943, seed: 1, durationS: 1200,
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
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId: 100,
  };
}

function man(id: number, teamId: number, side: 'german' | 'soviet', pos: { x: number; y: number }, over: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side, name: `Ivanov${id}`, rank: 'Pvt', weaponId: 'mosin', ammo: 5, ammoReserve: 20, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'idle',
    pos, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0,
    fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(80), ...over,
  };
}

function team(id: number, side: 'german' | 'soviet', ids: number[], vehicleId: number | null = null): Team {
  return {
    id, defId: 'test', side, name: `Team ${id}`, type: vehicleId != null ? 'tank' : 'rifle', soldierIds: ids, leaderId: ids[0],
    vehicleId, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle', pos: { x: 0, y: 0 },
    outOfAction: false, kills: 0, aiObjective: null,
  };
}

/** A German Pz IV at (20,30) driving east along y=30 (or parked when `moving` is false). */
function tankSetup(moving = true): { state: BattleState; tank: Vehicle } {
  const state = makeState();
  const tank: Vehicle = {
    id: 1, teamId: 1, side: 'german', defId: 'pz4gh', pos: { x: 20.5, y: 30.5 }, hullFacing: Math.PI / 2, turretFacing: Math.PI / 2,
    state: 'ok', mainAmmo: 50, coaxAmmo: 200, path: moving ? [{ x: 60.5, y: 30.5 }] : [], speed: 0,
    targetVehicleId: null, targetSoldierId: null, targetPoint: null, mainFireTimer: 1e9, coaxFireTimer: 1e9, burnTimer: 0, hits: 0,
  };
  state.vehicles.set(1, tank);
  const cmdr = man(90, 1, 'german', { ...tank.pos }, { vehicleId: 1, isLeader: true });
  state.soldiers.set(90, cmdr);
  state.teams.set(1, team(1, 'german', [90], 1));
  return { state, tank };
}

function addInfantry(state: BattleState, id: number, side: 'german' | 'soviet', pos: { x: number; y: number }, over: Partial<Soldier> = {}): Soldier {
  const s = man(id, id + 100, side, pos, over);
  state.soldiers.set(id, s);
  state.teams.set(id + 100, team(id + 100, side, [id]));
  return s;
}

function drive(state: BattleState, rng: Rng, seconds: number): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) { state.time += SIM_DT; stepVehicles(state, rng, SIM_DT); stepMovement(state, rng, SIM_DT); }
}

describe('tank overrun', () => {
  it('a prone pinned enemy under a moving tank dies, crushed along the direction of travel; witnesses are shaken', () => {
    const { state } = tankSetup();
    const victim = addInfantry(state, 2, 'soviet', { x: 30.5, y: 30.5 }, { stance: 'prone', activity: 'pinned' });
    victim.mind.state = 'pinned';
    const witness = addInfantry(state, 3, 'soviet', { x: 33.5, y: 34.5 });
    const farAway = addInfantry(state, 4, 'soviet', { x: 30.5, y: 50.5 });
    const before = witness.mind.stress;
    drive(state, new Rng(1), 12);
    expect(victim.health).toBe('dead');
    expect(victim.crushed).toBeDefined();
    expect(victim.crushed!.dir).toBeCloseTo(Math.PI / 2, 1);
    expect(witness.mind.stress).toBeGreaterThan(before + 10);
    expect(farAway.mind.stress).toBeLessThan(5);
    expect(state.sides.german.kills).toBe(1);
    expect(state.sides.soviet.losses).toBe(1);
    expect(state.messages.map((m) => m.text)).toContain('Team 102\nPvt. Ivanov2 was run down.');
    expect(canReactToOverrun(state, victim)).toBe(false);
  });

  it('a standing calm veteran usually dodges (and is badly shaken); green men less often', () => {
    let vetSurvived = 0, greenSurvived = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      for (const [exp, green] of [[85, false], [20, true]] as const) {
        const { state } = tankSetup();
        const s = addInfantry(state, 2, 'soviet', { x: 30.5, y: 30.3 }, { experience: exp });
        drive(state, new Rng(100 + i), 8);
        if (s.health !== 'dead') {
          if (green) greenSurvived++; else vetSurvived++;
          expect(Math.abs(s.pos.y - 30.5)).toBeGreaterThan(0.6); // out from under the hull
          expect(s.mind.stress).toBeGreaterThanOrEqual(15);
        }
      }
    }
    expect(overrunDodgeChance(man(1, 1, 'soviet', { x: 0, y: 0 }, { experience: 85 }))).toBe(0.95);
    expect(overrunDodgeChance(man(1, 1, 'soviet', { x: 0, y: 0 }, { experience: 20 }))).toBe(0.7);
    expect(vetSurvived).toBeGreaterThan(N * 0.8);
    expect(greenSurvived).toBeLessThan(vetSurvived);
    expect(greenSurvived).toBeGreaterThan(N * 0.4);
  });

  it('a friendly is never crushed, even lying pinned in the way', () => {
    for (let i = 0; i < 20; i++) {
      const { state } = tankSetup();
      const a = addInfantry(state, 2, 'german', { x: 30.5, y: 30.5 }, { stance: 'prone', activity: 'pinned' });
      const b = addInfantry(state, 3, 'german', { x: 36.5, y: 30.7 });
      drive(state, new Rng(i), 12);
      expect(a.health).toBe('healthy');
      expect(b.health).toBe('healthy');
      expect(a.crushed).toBeUndefined();
    }
  });

  it('a stationary tank crushes no one', () => {
    const { state, tank } = tankSetup(false);
    const s = addInfantry(state, 2, 'soviet', { x: tank.pos.x + 0.2, y: tank.pos.y }, { stance: 'prone', activity: 'pinned' });
    drive(state, new Rng(1), 5);
    expect(s.health).toBe('healthy');
  });

  it('is deterministic for a given seed', () => {
    const run = (): string => {
      const { state } = tankSetup();
      for (let k = 0; k < 6; k++) addInfantry(state, 2 + k, 'soviet', { x: 26.5 + k * 3, y: 30.2 + (k % 3) * 0.3 }, { experience: 30 + k * 10 });
      drive(state, new Rng(42), 12);
      return JSON.stringify([...state.soldiers.values()].map((s) => [s.id, s.health, s.pos.x.toFixed(5), s.pos.y.toFixed(5), s.crushed?.dir.toFixed(4) ?? null]));
    };
    expect(run()).toBe(run());
  });
});
