import { describe, it, expect } from 'vitest';
import { FIRELIGHT_RANGE_M, observerVisibility } from '@/sim/spotting';
import { updateSpotting } from '@/sim/spotting';
import { TILE_M } from '@/shared/types';

const spotterMind = (): any => ({ state: 'steady', motivation: 80, stress: 10, fear: 5, beliefs: [], threatDir: null, threatLevel: 0, lastIncomingAt: -999, hesitation: 0, surrounded: false, helpless: false, stateSince: 0, suppression: 0 });

function stateWith(burning: { x: number; y: number } | null, target: { x: number; y: number }) {
  const W = 72;
  const idx = (p: { x: number; y: number }) => Math.round(p.y) * W + Math.round(p.x);
  const spotter = { id: 1, side: 'german', teamId: 1, health: 'ok', stance: 'standing', activity: 'idle', mind: spotterMind(), facing: 0, pos: { x: 4, y: 36 }, vehicleId: null } as any;
  const enemy = { id: 2, side: 'soviet', teamId: 2, health: 'ok', stance: 'prone', activity: 'idle', mind: spotterMind(), facing: 0, pos: target, vehicleId: null } as any;
  const veh = burning ? { id: 9, side: 'soviet', teamId: 2, defId: 't34_76', pos: burning, state: 'burning', hullFacing: 0, turretFacing: 0, speed: 0, path: [], mainAmmo: 0, coaxAmmo: 0, bowAmmo: 0 } as any : null;
  const state: any = {
    time: 10, map: { width: W, height: W, tiles: new Array(W * W).fill('open'), buildingId: new Int16Array(W * W).fill(-1), windows: new Uint8Array(W * W), smoke: new Float32Array(W * W), craters: [] },
    soldiers: new Map([[1, spotter], [2, enemy]]),
    vehicles: new Map(veh ? [[9, veh]] : []),
    teams: new Map(), spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    spottedBy: { german: new Map(), soviet: new Map() },
  };
  return { state, spotter, enemy };
}

describe('burning wrecks light their surroundings (item 014)', () => {
  it('FIRELIGHT_RANGE_M is 80 m = 40 tiles', () => {
        expect(FIRELIGHT_RANGE_M / TILE_M).toBe(40); // 2 m tiles
  });

  it('a prone enemy standing still in the open near a burning wreck is spotted', () => {
    const { state } = stateWith({ x: 40, y: 36 }, { x: 46, y: 36 }); // 6 tiles = 12 m < 80 m glow
    const before = state.spotted.german.size;
    updateSpotting(state, { next: () => 0.99, chance: () => false } as never);
    expect(state.spotted.german.has(2)).toBe(true);
  });

  it('the same prone enemy is NOT spotted without the fire', () => {
    const { state } = stateWith(null, { x: 46, y: 36 });
    updateSpotting(state, { next: () => 0.99, chance: () => false } as never);
    expect(state.spotted.german.has(2)).toBe(false);
  });

  it('an enemy beyond the glow is not revealed by the fire', () => {
    const { state } = stateWith({ x: 40, y: 36 }, { x: 82, y: 36 }); // 42 tiles = 84 m > 80 m glow
    updateSpotting(state, { next: () => 0.99, chance: () => false } as never);
    expect(state.spotted.german.has(2)).toBe(false);
  });
});
