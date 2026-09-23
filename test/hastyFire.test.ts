import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { clearInfantryAim, infantryAimReady } from '@/sim/infantryAim';
import { hitChance } from '@/sim/ballistics';
import { stepCombat } from '@/sim/combat';
import { makeState, mkTeam, soldier } from './vehicleDamageHelpers';

function scene(weapon = 'kar98k', seed = 7) {
  const state = makeState(), rng = new Rng(seed);
  const s = soldier(1, 1, 'german', { x: 20, y: 20 }, weapon, { ammo: WEAPONS[weapon].ammo, facing: 2 });
  const enemy = soldier(2, 2, 'soviet', { x: 40, y: 20 }, 'none');
  const team = mkTeam(1, 'rifle', [1], 'german', s.pos);
  team.order = { type: 'assault', target: enemy.pos, issuedAt: 0 };
  state.soldiers.set(1, s); state.soldiers.set(2, enemy); state.teams.set(1, team); state.spotted.german.add(2);
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / 0.1); i++) { state.time += 0.1; stepCombat(state, rng, 0.1); }
  };
  return { state, s, enemy, team, rng, tick };
}

describe('hurried infantry fire', () => {
  it.each(['kar98k', 'pistol_p38', 'mp40', 'mg34'])('can snap fire a %s during a close assault, with worse accuracy', (weapon) => {
    const { s, team, enemy, rng } = scene(weapon);
    const gun = WEAPONS[weapon], target = { kind: 'soldier' as const, soldier: enemy };
    infantryAimReady(s, gun, target, team, 0, rng);
    expect(s.aiming?.hasty).toBe('assault');
    expect(s.aiming!.readyAt).toBeLessThan(0.85);
    const hurried = hitChance(gun, 40, 0, 'standing', s, false);
    clearInfantryAim(s); team.order!.type = 'defend';
    infantryAimReady(s, gun, target, team, 0, rng);
    expect(s.aiming?.hasty).toBeUndefined();
    expect(s.aiming!.readyAt).toBeGreaterThan(0.85);
    expect(hitChance(gun, 40, 0, 'standing', s, false)).toBeGreaterThan(hurried * 1.8);
  });

  it('returns hurried defensive fire under pressure but keeps distant shots deliberate', () => {
    const { s, team, enemy, rng } = scene(); team.order!.type = 'defend'; s.suppression = 70;
    infantryAimReady(s, WEAPONS.kar98k, { kind: 'soldier', soldier: enemy }, team, 0, rng);
    expect(s.aiming?.hasty).toBe('pressure'); expect(s.aiming!.readyAt).toBeLessThan(1);
    clearInfantryAim(s); enemy.pos.x = 170;
    infantryAimReady(s, WEAPONS.kar98k, { kind: 'soldier', soldier: enemy }, team, 0, rng);
    expect(s.aiming?.hasty).toBeUndefined(); expect(s.aiming!.readyAt).toBeGreaterThan(2);
  });

  it('does not bypass rifle cycling, reloading, or target visibility', () => {
    const { s, state, tick } = scene();
    tick(0.8); expect(s.ammo).toBe(4); const fired = s.lastFiredAt;
    tick(0.5); expect(s.ammo).toBe(4); expect(s.lastFiredAt).toBe(fired);
    s.ammo = 0; s.ammoReserve = 5; s.fireTimer = 0;
    tick(0.1); expect(s.activity).toBe('reloading');
    tick(1); expect(s.ammo).toBe(0);
    state.spotted.german.clear(); tick(10); expect(s.ammo).toBe(5);
  });

  it('allows occasional brief panic fire, with most soldiers hesitating and no unseen targets', () => {
    let firing = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { s, tick } = scene('mp40', seed);
      s.mind.state = 'panicked'; s.activity = 'panicked'; s.suppression = 95;
      tick(2); if (s.ammo < 32) firing++;
      expect(s.ammo).toBeGreaterThan(0); // Brief erratic opportunity, not perpetual effective fire.
      expect(s.smgBurst).toBeUndefined();
    }
    expect(firing).toBeGreaterThan(0); expect(firing).toBeLessThan(20);
    const { s, state, tick } = scene('mp40', 7);
    s.mind.state = 'panicked'; s.activity = 'panicked'; state.spotted.german.clear();
    tick(20); expect(s.ammo).toBe(32);
  });

  it.each(['cowering', 'broken'] as const)('keeps %s soldiers from hurried fire', (mind) => {
    const { s, tick } = scene(); s.mind.state = mind; tick(8); expect(s.ammo).toBe(5);
  });
});
