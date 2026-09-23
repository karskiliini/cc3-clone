import { describe, expect, it } from 'vitest';
import type { Soldier, Terrain, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { dist } from '@/shared/math';
import { Rng } from '@/shared/rng';
import { applyBlastKnockback, applyHESplash, stepCombat } from '@/sim/combat';
import { detonateVehicle } from '@/sim/vehicleExplosion';
import { ragdollSample } from '@/render/soldierAnim';
import { makeSoldier, makeState, makeTeam, mortar, W } from './kitHelpers';
import { addTank } from './vehicleDamageHelpers';

const burst = { x: 10.5, y: 10.5 }, target = { x: 12, y: 10.5 };
function scene(stance: Soldier['stance'] = 'standing', terrain: Terrain = 'open', pos: Vec2 = target) {
  const state = makeState(), s = makeSoldier({ stance, pos: { ...pos } });
  state.soldiers.set(s.id, s);
  state.map.tiles[Math.floor(pos.y) * W + Math.floor(pos.x)] = terrain;
  return { state, s };
}

describe('blast protection', () => {
  it('injures exposed standing men much more often than crouching or prone men', () => {
    const injured = (stance: Soldier['stance']) => {
      let n = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const { state, s } = scene(stance);
        applyHESplash(state, new Rng(seed), burst, { ...mortar, lethality: 0.8 }, 'german');
        if (s.health !== 'healthy') n++;
      }
      return n;
    };
    const standing = injured('standing'), crouching = injured('crouching'), prone = injured('prone');
    expect(standing).toBeGreaterThan(crouching * 1.4);
    expect(crouching).toBeGreaterThan(prone * 1.5);
  });

  it.each(['trench', 'crater', 'buildingStone'] as const)('shelters a low soldier in %s from knockback, stun and most suppression', terrain => {
    const open = scene('prone'), sheltered = scene('prone', terrain);
    for (const { state, s } of [open, sheltered]) {
      applyHESplash(state, new Rng(4), burst, mortar, 'german');
      expect(s.health).toBe('healthy');
    }
    expect(sheltered.s.pos).toEqual(target);
    expect(sheltered.s.blast).toBeUndefined();
    expect(sheltered.s.stunnedUntil).toBeUndefined();
    expect(sheltered.s.dazedUntil).toBeUndefined();
    expect(sheltered.s.suppression).toBeLessThan(open.s.suppression * 0.6);
    expect(sheltered.s.mind.stress).toBeLessThan(open.s.mind.stress * 0.6);
  });

  it('protects behind the intervening wall, but not from a burst on the soldier’s side of it', () => {
    const behind = scene(), sameSide = scene();
    for (const { state } of [behind, sameSide]) state.map.tiles[10 * W + 11] = 'stonewall';
    applyBlastKnockback(behind.state, new Rng(2), behind.s, burst, mortar);
    applyBlastKnockback(sameSide.state, new Rng(2), sameSide.s, { x: 13.5, y: 10.5 }, mortar);
    expect(behind.s.pos).toEqual(target); expect(behind.s.stunnedUntil).toBeUndefined();
    expect(sameSide.s.blast).toBeDefined(); expect(sameSide.s.stunnedUntil).toBeGreaterThan(10);
  });

  it('does not treat grass or smoke as solid protection from a nearby blast', () => {
    const { state, s } = scene('standing', 'tallgrass');
    state.map.smoke.fill(1);
    applyBlastKnockback(state, new Rng(2), s, burst, mortar);
    expect(dist(s.pos, target) * TILE_M).toBeGreaterThan(2);
    expect(s.stunnedUntil).toBeGreaterThan(state.time);
  });

  it('makes standing bodies travel farther and arc higher than low bodies', () => {
    const standing = scene('standing', 'open', { x: 11, y: 10.5 });
    const prone = scene('prone', 'open', { x: 11, y: 10.5 });
    for (const { state, s } of [standing, prone]) applyBlastKnockback(state, new Rng(2), s, burst, mortar);
    expect(dist(standing.s.pos, standing.s.blast!.origin)).toBeGreaterThan(dist(prone.s.pos, prone.s.blast!.origin) * 2);
    expect(ragdollSample(standing.s.blast!, standing.s.pos, 10.25).heightM)
      .toBeGreaterThan(ragdollSample(prone.s.blast!, prone.s.pos, 10.25).heightM);
    expect(standing.s.dazedUntil!).toBeGreaterThan(prone.s.dazedUntil ?? 10);
  });

  it('uses the standing posture at impact even when the injury immediately incapacitates the soldier', () => {
    let incapacitated = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { state, s } = scene('standing', 'open', { x: 11, y: 10.5 });
      applyHESplash(state, new Rng(seed), burst, { ...mortar, lethality: 1 }, 'german');
      expect(s.blast!.force).toBeGreaterThan(0.9);
      expect(dist(s.pos, s.blast!.origin) * TILE_M).toBeGreaterThan(7);
      if (s.stance === 'prone') incapacitated++;
    }
    expect(incapacitated).toBeGreaterThan(0);
  });

  it('does not throw a man at the weak outer edge of a blast', () => {
    const { state, s } = scene('standing', 'open', { x: 13.3, y: 10.5 });
    const before = { ...s.pos };
    applyHESplash(state, new Rng(2), burst, mortar, 'german');
    expect(s.pos).toEqual(before); expect(s.blast).toBeUndefined();
    expect(s.suppression).toBeLessThan(5);
  });

  it('does not let a trench protect against a burst that lands in the same fighting position', () => {
    const { state, s } = scene('standing', 'trench', { x: 10.8, y: 10.5 });
    applyBlastKnockback(state, new Rng(2), s, burst, mortar);
    expect(s.blast!.force).toBeGreaterThan(0.8);
    expect(s.stunnedUntil).toBeGreaterThan(state.time);
  });

  it('does not reapply an unprotected knockdown pass after a vehicle detonates beside a trench', () => {
    const { state, s } = scene('prone', 'trench', { x: 15.5, y: 10.5 });
    const { v } = addTank(state, 'tiger', burst);
    const before = { ...s.pos };
    detonateVehicle(state, new Rng(8), v, 'german');
    expect(s.pos).toEqual(before); expect(s.blast).toBeUndefined();
    expect(s.stunnedUntil).toBeUndefined(); expect(s.dazedUntil).toBeUndefined();
    expect(s.suppression).toBeLessThan(20);
  });

  it('reduces actual injuries behind solid cover, without granting immunity', () => {
    let open = 0, trench = 0;
    for (let seed = 1; seed <= 400; seed++) for (const terrain of ['open', 'trench'] as const) {
      const { state, s } = scene('crouching', terrain);
      applyHESplash(state, new Rng(seed), burst, { ...mortar, lethality: 0.8 }, 'german');
      if (s.health !== 'healthy') { if (terrain === 'open') open++; else trench++; }
    }
    expect(trench).toBeGreaterThan(0); expect(trench).toBeLessThan(open * 0.35);
  });

  it('does not count the exterior walls as protection from a burst already inside the building', () => {
    const { state, s } = scene('standing', 'buildingStone');
    for (let x = 10; x <= 12; x++) { state.map.tiles[10 * W + x] = 'floor'; state.map.buildingId[10 * W + x] = 3; }
    applyBlastKnockback(state, new Rng(2), s, burst, mortar);
    expect(s.blast!.force).toBeGreaterThan(0.5);
    expect(s.stunnedUntil).toBeGreaterThan(state.time);
  });

  it.each([10, 11])('keeps a building wall at x=%s between the burst and its occupants', wallX => {
    const outside = scene('prone', 'floor'), inside = scene('prone', 'floor');
    for (const { state } of [outside, inside]) {
      for (let x = 10; x <= 12; x++) { state.map.tiles[10 * W + x] = 'floor'; state.map.buildingId[10 * W + x] = 3; }
    }
    outside.state.map.tiles[10 * W + wallX] = 'buildingStone';
    for (const { state } of [outside, inside]) applyHESplash(state, new Rng(2), burst, mortar, 'german');
    expect(outside.s.suppression).toBeLessThan(inside.s.suppression * 0.4);
    // The building itself still shakes: structure damage has its own stress contribution.
    expect(outside.s.mind.stress).toBeLessThan(inside.s.mind.stress * 0.7);
  });

  it('applies the blast to bystanders when a direct-fire explosive round targets a soldier', () => {
    let thrown = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const state = makeState();
      const shooter = makeSoldier({ id: 1, side: 'german', weaponId: 'panzerschreck', pos: { x: 3.5, y: 10.5 }, ammo: 1, ammoReserve: 0, grenades: 0, facing: 2, experience: 90 });
      const victim = makeSoldier({ id: 2, pos: { x: 12.5, y: 10.5 }, weaponId: 'none', grenades: 0 });
      const bystander = makeSoldier({ id: 3, pos: { x: 12.5, y: 10.8 }, weaponId: 'none', grenades: 0 });
      makeTeam(state, 1, [shooter]); makeTeam(state, 2, [victim, bystander]);
      state.spotted.german.add(victim.id); const rng = new Rng(seed);
      for (let i = 0; i < 200 && shooter.ammo > 0; i++) { state.time += 0.1; stepCombat(state, rng, 0.1); }
      expect(shooter.ammo).toBe(0);
      if (bystander.blast) thrown++;
    }
    expect(thrown).toBeGreaterThan(4);
  });
});
