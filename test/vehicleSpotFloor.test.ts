import { describe, it, expect } from 'vitest';
import { updateSpotting, collectSpotters, ALWAYS_SPOT_RANGE_M, item14FloorM } from '@/sim/spotting';
import { TILE_M } from '@/shared/types';
import type { BattleState, Vehicle, Soldier, Team } from '@/shared/types';

const M = (): any => ({ state: 'steady', motivation: 80, stress: 10, fear: 5, beliefs: [], threatDir: null, threatLevel: 0, lastIncomingAt: -999, hesitation: 0, surrounded: false, helpless: false, stateSince: 0, suppression: 0 });

const W = 300; // 600 m — room to be beyond the 400 m vehicle spot range

function rig(engineOnFire: boolean, engineDamage?: 'damaged' | 'destroyed', ridge = false): { state: BattleState; target: Vehicle; spotterSoldier: Soldier } {
  const spotterSoldier = {
    id: 1, teamId: 1, side: 'german', name: 'Obs', rank: 'Sgt', health: 'healthy', activity: 'idle',
    stance: 'standing', pos: { x: 8, y: 48 }, vehicleId: null, experience: 60, morale: 80, mind: M(), facing: 0, path: [],
  } as unknown as Soldier;
  const target = {
    id: 9, teamId: 2, side: 'soviet', defId: 'pz4gh', pos: { x: 262, y: 48 }, hullFacing: 0, turretFacing: 0,
    state: engineOnFire ? 'ok' : 'ok', engineOnFire, damage: engineDamage ? { engine: engineDamage } : undefined,
    mainAmmo: 0, coaxAmmo: 0, bowAmmo: 0, path: [], speed: 0,
  } as unknown as Vehicle;
  const burning = {
    id: 10, teamId: 2, side: 'soviet', defId: 't34_76', pos: { x: 258, y: 48 }, hullFacing: 0, turretFacing: 0,
    state: 'burning', mainAmmo: 0, coaxAmmo: 0, bowAmmo: 0, path: [], speed: 0,
  } as unknown as Vehicle;
  const team1 = { id: 1, side: 'german', name: 'Zug', soldierIds: [1], leaderId: 1 } as unknown as Team;
  const state = {
    time: 10, config: { playerSide: 'german' },
    map: { def: { vectors: [], labels: [] }, width: W, height: W, tiles: new Array(W * W).fill('open'), buildingId: new Int16Array(W * W).fill(-1), windows: new Uint8Array(W * W), smoke: new Float32Array(W * W), craters: [],
    ground: ridge ? (() => { const g = new Float32Array(W * W); for (let y = 40; y < 56; y++) g[y * W + 12] = 6; return g; })() : new Float32Array(W * W) },
    teams: new Map([[1, team1]]),
    soldiers: new Map([[1, spotterSoldier]]),
    vehicles: new Map(engineOnFire || engineDamage ? [[9, target]] : [[9, target], [10, burning]]),
    sides: { german: { kills: 0, losses: 0 }, soviet: { kills: 0, losses: 0 } },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    spottedBy: { german: new Map(), soviet: new Map() },
    events: [], messages: [],
  } as unknown as BattleState;
  return { state, target, spotterSoldier };
}

describe('vehicle spot floor (item 014 + engine regression)', () => {
  // Observer at x=8, fire at x=258, target at x=262: (258-8)*2 = 500 m — beyond the 400 m
  // vehicle spot range, so ordinary spotting CANNOT see anything. The fire's LOS check is
  // range-free, so only the firelight path can reveal the target.
  it('a vehicle in a burning wreck\'s glow is revealed by LOS TO THE FIRE, even beyond spot range', () => {
    const { state, target } = rig(false); // burning wreck at 288, target at 292
    updateSpotting(state, { next: () => 0.99, chance: () => false } as never);
    expect(state.spottedVehicles.german.has(9)).toBe(true);
    // control: without the fire the same target stays hidden
    const { state: s2, target: t2 } = rig(false);
    (s2.vehicles as Map<number, Vehicle>).delete(10);
    updateSpotting(s2, { next: () => 0.99, chance: () => false } as never);
    expect(s2.spottedVehicles.german.has(9)).toBe(false);
    expect(t2).toBe(t2); // noop keep target referenced
  });

  it('an unlit vehicle beyond spot range is never revealed (fire-only path)', () => {
    const { state } = rig(false);
    (state.vehicles as Map<number, Vehicle>).delete(10);
    updateSpotting(state, { next: () => 0.99, chance: () => false } as never);
    expect(state.spottedVehicles.german.has(9)).toBe(false);
  });

  it('the engine-floor regression: damaged engine takes the 1.5x floor with NO LOS (ridge blocks)', () => {
    // 6 m ridge at column 12 masks everything behind it; the ONLY spotting route left is the
    // floor's distance short-circuit. Damaged engine = 15 m floor: 14 m spotted, 18 m not.
    const { state, target } = rig(false, undefined, true);
    (state.vehicles as Map<number, Vehicle>).delete(10);
    (target as any).damage = { engine: 'damaged' };
    (target as any).pos = { x: 15, y: 48 }; // 7 tiles = 14 m < 15 m floor
    updateSpotting(state, { next: () => 0.99, chance: () => false } as never);
    expect(state.spottedVehicles.german.has(9)).toBe(true);
    // negative control: same ridge-masked vehicle 18 m out — beyond the 15 m floor → hidden
    (target as any).pos = { x: 17, y: 48 };
    updateSpotting(state, { next: () => 0.99, chance: () => false } as never);
    expect(state.spottedVehicles.german.has(9)).toBe(false);
  });
});
