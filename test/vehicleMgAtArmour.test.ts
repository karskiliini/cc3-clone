import { describe, expect, it } from 'vitest';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { stepVehicles } from '@/sim/vehicle';
import { stepCombat } from '@/sim/combat';
import type { BattleState } from '@/shared/types';
import { addTank, makeState } from './vehicleDamageHelpers';

/** MG bursts per side over `seconds` of a duel kept in sight of each other. */
function duel(enemyDef: string, seconds: number, enemySide: 'soviet' | 'german' = 'soviet'): Record<string, number> {
  const state: BattleState = makeState(1943);
  const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 360.5 }, 0, 60, 'german');
  const { v: t, team: tt } = addTank(state, enemyDef, { x: 200.5, y: 200.5 }, Math.PI, 60, enemySide);
  tt.order = { type: 'defend', target: t.pos, issuedAt: 0 };
  const rng = new Rng(3);
  const mg: Record<string, number> = { german: 0, soviet: 0 };
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    state.time += SIM_DT; state.events.length = 0;
    state.spottedVehicles.german.add(t.id); state.spottedVehicles.soviet.add(v.id);
    stepVehicles(state, rng, SIM_DT); stepCombat(state, rng, SIM_DT);
    if (t.state !== 'ok') break;   // a crew bailing out of a wreck is fair game
    for (const e of state.events) if (e.kind === 'shot' && e.side && /^(coax|bow)_/.test(e.weaponId ?? '')) mg[e.side]++;
  }
  return mg;
}

describe('vehicle machine guns and enemy armour', () => {
  it('tanks in a duel with no infantry about do not spray each other with MG fire', () => {
    expect(duel('t34_76', 30)).toEqual({ german: 0, soviet: 0 });
  });

  it('an open-topped vehicle still draws MG fire into its fighting compartment', () => {
    expect(duel('marder3', 30).german).toBeGreaterThan(0);
  });
});
