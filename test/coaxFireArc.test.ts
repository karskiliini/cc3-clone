import { describe, it, expect } from 'vitest';
import { makeState, addTank, soldier } from './vehicleDamageHelpers';
import { stepCombat } from '@/sim/combat';
import { Rng } from '@/shared/rng';

const DEG = Math.PI / 180;
const at = (deg: number, m: number) => ({ x: 200.5 + Math.sin(deg * DEG) * (m / 2), y: 200.5 - Math.cos(deg * DEG) * (m / 2) });

function scene(turretDeg: number, targetDeg: number) {
  const state = makeState(1943);
  const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 50);
  v.turretFacing = turretDeg * DEG;
  const victim = soldier(1, 900, 'german', at(targetDeg, 60), 'kar98k');
  state.soldiers.set(1, victim);
  state.teams.set(900, { id: 900, side: 'german', soldierIds: [1], outOfAction: false, order: { type: 'defend', target: victim.pos, issuedAt: 0 }, pos: victim.pos, facing: 0 } as never);
  state.spotted.german = new Set([1]);
  return { state, v, victim };
}

describe('coax fires only within its field of fire (item 016)', () => {
  it('does not engage infantry 90 deg off the turret bearing even with LOS', () => {
    const { state } = scene(0, 90);
    const rng = new Rng(5);
    let coaxTracers = 0;
    for (let t = 0; t < 300; t++) {
      stepCombat(state, rng, 1 / 30);
      coaxTracers = state.tracers.filter((tr) => tr.kind === 'mg').length;
    }
    // no coax burst in that direction (the main gun may still be laying)
    expect(coaxTracers).toBe(0);
  });
  it('engages infantry the turret bears on', () => {
    const { state, victim } = scene(90, 90);
    const rng = new Rng(5);
    let fired = false;
    for (let t = 0; t < 300 && !fired; t++) {
      stepCombat(state, rng, 1 / 30);
      fired = victim.health !== 'healthy' || victim.suppression > 0;
    }
    expect(fired).toBe(true);
  });
});
