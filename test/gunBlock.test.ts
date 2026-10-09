import { describe, expect, it } from 'vitest';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { stepVehicles } from '@/sim/vehicle';
import { stepCombat } from '@/sim/combat';
import { stepMorale } from '@/sim/morale';
import { ensureDamage } from '@/sim/vehicleDamage';
import { gunBlockText, mainGunBlock } from '@/sim/gunBlock';
import { targetableEnemyAt, targetStatusText } from '@/ui/targetHover';
import { addTank, makeState } from './vehicleDamageHelpers';

/** A StuG at (200, 360) facing north, a T-34 `rangeT` tiles north of it facing it. */
function setup(rangeT = 200) {
  const state = makeState(1943);
  const stug = addTank(state, 'stug3g', { x: 200.5, y: 360.5 }, 0, 60, 'german');
  const t34 = addTank(state, 't34_76', { x: 200.5, y: 360.5 - rangeT }, Math.PI, 60, 'soviet');
  t34.team.order = { type: 'defend', target: t34.v.pos, issuedAt: 0 };
  state.spottedVehicles.german.add(t34.v.id);
  return { state, stug, t34 };
}

describe('why a vehicle main gun cannot fire', () => {
  it('a sound StuG can fire at a T-34 400 m ahead', () => {
    const { state, stug, t34 } = setup();
    expect(mainGunBlock(state, stug.v, t34.v.pos)).toBeNull();
  });

  it('a destroyed sight leaves only point-blank fire over the barrel', () => {
    const { state, stug, t34 } = setup();
    ensureDamage(stug.v).sight = 'destroyed';
    expect(mainGunBlock(state, stug.v, t34.v.pos)).toBe('sightOut');
    expect(mainGunBlock(state, stug.v, { x: 200.5, y: 330.5 })).toBeNull();   // 60 m
    expect(gunBlockText('sightOut')).toMatch(/sight/i);
  });

  it('a destroyed gun, no rounds left, or a target beyond the gun\'s range', () => {
    const a = setup();
    ensureDamage(a.stug.v).mainGun = 'destroyed';
    expect(mainGunBlock(a.state, a.stug.v, a.t34.v.pos)).toBe('gunDestroyed');
    const b = setup();
    b.stug.v.mainAmmo = 0; b.stug.v.loadedRound = undefined;
    expect(mainGunBlock(b.state, b.stug.v, b.t34.v.pos)).toBe('noAmmo');
    const c = setup();
    expect(mainGunBlock(c.state, c.stug.v, { x: 200.5, y: -400 })).toBe('outOfRange');   // 1520 m, past the L/48's 1400
  });

  it('an immobilised StuG cannot swing its gun onto a target off to its side; a mobile one can', () => {
    const { state, stug } = setup();
    const east = { x: 300.5, y: 360.5 };
    expect(mainGunBlock(state, stug.v, east)).toBeNull();
    ensureDamage(stug.v).trackL = 'destroyed';
    expect(mainGunBlock(state, stug.v, east)).toBe('cantBear');
  });

  it('ordered to fire and unable to: one message saying why, "Can\'t Fire" status, no shot', () => {
    const { state, stug, t34 } = setup();
    ensureDamage(stug.v).sight = 'destroyed';
    stug.team.order = { type: 'fire', target: { ...t34.v.pos }, targetTeamId: t34.team.id, targetVehicleId: t34.v.id, issuedAt: 0 };
    const rng = new Rng(3);
    let shots = 0;
    for (let i = 0; i < 150; i++) {
      state.time += SIM_DT; state.events.length = 0;
      state.spottedVehicles.german.add(t34.v.id);
      stepVehicles(state, rng, SIM_DT); stepCombat(state, rng, SIM_DT); stepMorale(state, rng, SIM_DT);
      shots += state.events.filter((e) => e.kind === 'shot' && e.side === 'german' && e.weaponId === 'stuk40').length;
    }
    expect(shots).toBe(0);
    const msgs = state.messages.filter((m) => m.side === 'german' && /can't fire/i.test(m.text));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/sight/i);
    expect(stug.team.status).toBe("Can't Fire");
  });

  it('hovering the target with the StuG selected says why it cannot fire', () => {
    const { state, stug, t34 } = setup();
    ensureDamage(stug.v).sight = 'destroyed';
    const h = targetableEnemyAt(state, 'german', [stug.team], t34.v.pos)!;
    expect(targetStatusText(h)).toBe(gunBlockText('sightOut'));
  });
});
