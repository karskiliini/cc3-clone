import { describe, it, expect } from 'vitest';
import { makeState, addTank, soldier } from './vehicleDamageHelpers';
import { stepCombat } from '@/sim/combat';
import { stepVehicles } from '@/sim/vehicle';
import { Rng } from '@/shared/rng';

describe('flame tanks', () => {
  it('an OT-34 with its coax silent burns nearby infantry and the tracer is a flame jet', () => {
    const state = makeState(1942);
    const { v, team } = addTank(state, 'ot34', { x: 200.5, y: 200.5 }, 0, 50);
    team.order = { type: 'defend', target: { x: 200, y: 200 }, issuedAt: 0 };
    v.coaxAmmo = 0; // the flame is the tank's only working weapon here
    const enemy = soldier(1, 900, 'german', { x: 202.5, y: 206.5 }, 'kar98k');
    state.soldiers.set(1, enemy);
    state.teams.set(900, { id: 900, side: 'german', soldierIds: [1], outOfAction: false, order: { type: 'defend' } } as never);
    state.spotted.soviet = new Set([1]);
    const rng = new Rng(7);
    let flame = 0;
    for (let t = 0; t < 3600 && flame === 0; t++) {
      stepVehicles(state, rng, 1 / 30);
      stepCombat(state, rng, 1 / 30);
      flame = state.tracers.filter((tr) => tr.kind === 'flame').length;
    }
    expect(flame).toBeGreaterThan(0);
    expect(enemy.health === 'dead' || enemy.health === 'incapacitated' || enemy.suppression > 0).toBe(true);
    // a shell tracer would mean the flame was treated as a tank gun
    expect(state.tracers.some((tr) => tr.kind === 'shell')).toBe(false);
  });
});
