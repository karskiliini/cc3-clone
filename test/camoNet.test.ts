import { describe, it, expect } from 'vitest';
import { makeState, soldier } from './vehicleDamageHelpers';
import { updateSpotting } from '@/sim/spotting';
import { Rng } from '@/shared/rng';

function scene(camouflaged: boolean) {
  const state = makeState(1943);
  // observer (german) 100m north of target (soviet ambusher, prone, still)
  const obs = soldier(1, 10, 'german', { x: 200.5, y: 195.5 }, 'kar98k');
  const tgt = soldier(2, 20, 'soviet', { x: 200.5, y: 300.5 }, 'mosin');
  tgt.stance = 'prone'; tgt.activity = 'ambushing';
  state.soldiers.set(1, obs); state.soldiers.set(2, tgt);
  state.teams.set(10, { id: 10, side: 'german', soldierIds: [1], outOfAction: false, order: { type: 'defend', target: { x: 200, y: 195 }, issuedAt: 0 }, pos: { x: 200.5, y: 195.5 }, facing: 4 } as never);
  state.teams.set(20, { id: 20, side: 'soviet', soldierIds: [2], outOfAction: false, order: { type: 'ambush', target: { x: 200, y: 300 }, issuedAt: 0 }, pos: { x: 200.5, y: 300.5 }, facing: 0, camouflaged } as never);
  return { state, obs, tgt };
}

describe('G31 camouflage nets', () => {
  it('a camouflaged ambushing team is spotted far less often than a plain ambushing one', () => {
    let plainSpots = 0, camoSpots = 0;
    for (let rep = 0; rep < 40; rep++) {
      const rngA = new Rng(100 + rep), rngB = new Rng(500 + rep);
      { const { state } = scene(false);
        for (let t = 0; t < 120; t++) { updateSpotting(state, rngA); if (state.spotted.german.has(2)) { plainSpots++; break; } } }
      { const { state } = scene(true);
        for (let t = 0; t < 120; t++) { updateSpotting(state, rngB); if (state.spotted.german.has(2)) { camoSpots++; break; } } }
    }
    expect(plainSpots).toBeGreaterThan(20); // open-ground prone man is found regularly
    expect(camoSpots).toBe(0); // beyond CAMO_NET_MAX_SPOT_M the net hides him completely
  });
  it('the flag clears when the team is ordered to move', async () => {
    const { applyOrder } = await import('@/sim/orders');
    const { state } = scene(true);
    const team = state.teams.get(20)!;
    applyOrder(state, team, { type: 'move', target: { x: 210, y: 215 }, issuedAt: 0 }, new Rng(3));
    expect(team.camouflaged).toBe(false);
  });
});
