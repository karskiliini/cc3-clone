import { describe, expect, it } from 'vitest';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { traceRound } from '@/sim/shotTrace';
import { hasLOS, hasLineOfFire } from '@/sim/los';
import { tileStanding } from '@/sim/growth';
import { makeState } from './vehicleDamageHelpers';

const from = { x: 10.5, y: 10.5 }, to = { x: 30.5, y: 10.5 };

describe('rounds through vegetation', () => {
  it('cuts low growth along the physical path and reduces its concealment', () => {
    const state = makeState();
    for (let x = 11; x < 30; x++) state.map.tiles[10 * state.map.width + x] = 'crops';
    traceRound(state, new Rng(1), from, to, WEAPONS.mg34, { eyeM: 0.4, targetM: 0.4 });
    expect(tileStanding(state.map, 10 * state.map.width + 20)).toBeLessThan(1);
    expect(state.sparks.some((s) => s.kind === 'leaf')).toBe(true);
  });

  it('does not cut growth below an elevated round', () => {
    const state = makeState();
    state.map.tiles[10 * state.map.width + 20] = 'crops';
    traceRound(state, new Rng(1), from, to, WEAPONS.mg34, { eyeM: 2.2, targetM: 2.2 });
    expect(tileStanding(state.map, 10 * state.map.width + 20)).toBe(1);
  });

  it('can deflect a bullet, records a bent path, and removes a repeatedly hit hedge', () => {
    const state = makeState();
    state.time = 50;
    const index = 10 * state.map.width + 20;
    state.map.tiles[index] = 'hedge';
    const rng = new Rng(8);
    let deflected = false;
    for (let i = 0; i < 150; i++) {
      const shot = traceRound(state, rng, from, to, WEAPONS.mg34, { eyeM: 1, targetM: 1 });
      if (shot.deflected) {
        deflected = true;
        expect(shot.points.length).toBeGreaterThan(2);
        expect(shot.impact.y).not.toBe(to.y);
      }
    }
    expect(deflected).toBe(true);
    expect(state.map.tiles[index]).toBe('open');
    expect(state.map.dirtyTiles).toContain(index);
    expect(state.sparks.some((s) => s.kind === 'ricochet' && s.t === 50)).toBe(true);
  });

  it('a shell fells an intervening tree and bursts there', () => {
    const state = makeState();
    const index = 10 * state.map.width + 20;
    state.map.tiles[index] = 'woods';
    const shot = traceRound(state, new Rng(1), from, to, WEAPONS.kwk40_75);
    expect(state.map.tiles[index]).toBe('open');
    expect(shot.blocked).toBe(true);
    expect(Math.floor(shot.impact.x)).toBe(20);
  });

  it('kinetic AP shot can cut through a tree without acquiring an HE burst', () => {
    const state = makeState();
    state.map.tiles[10 * state.map.width + 20] = 'woods';
    // Combat passes the actual round profile: AP/APCR have no explosive radius.
    const shot = traceRound(state, new Rng(1), from, to, { ...WEAPONS.kwk40_75, heRadiusM: 0 });
    expect(state.map.tiles[10 * state.map.width + 20]).toBe('open');
    expect(shot.blocked).toBe(false);
    expect(shot.impact).toEqual(to);
  });

  it('rounds stop at hard cover before touching growth behind it', () => {
    const state = makeState();
    state.map.tiles[10 * state.map.width + 15] = 'buildingStone';
    state.map.tiles[10 * state.map.width + 20] = 'crops';
    const shot = traceRound(state, new Rng(1), from, to, WEAPONS.mg34, { eyeM: 0.4, targetM: 0.4 });
    expect(shot.blocked).toBe(true);
    expect(Math.floor(shot.impact.x)).toBe(15);
    expect(tileStanding(state.map, 10 * state.map.width + 20)).toBe(1);
  });

  it('permits concealed fire but still rejects intervening hills and walls', () => {
    const state = makeState(), map = state.map;
    map.tiles[10 * map.width + 20] = 'woods';
    expect(hasLOS(map, from, to)).toBe(false);
    expect(hasLineOfFire(map, from, to)).toBe(true);
    map.tiles[10 * map.width + 25] = 'stonewall';
    expect(hasLineOfFire(map, from, to)).toBe(false);
    map.tiles[10 * map.width + 25] = 'open';
    map.ground = new Float32Array(map.width * map.height);
    map.ground[10 * map.width + 25] = 10;
    expect(hasLineOfFire(map, from, to)).toBe(false);
  });

  it('replays the same physical paths and vegetation changes with the same seed', () => {
    const run = () => {
      const state = makeState();
      state.map.tiles[10 * state.map.width + 20] = 'woods';
      const rng = new Rng(42);
      const shots = Array.from({ length: 12 }, () => traceRound(state, rng, from, to, WEAPONS.mg34));
      return { shots, sparks: state.sparks, tile: state.map.tiles[10 * state.map.width + 20] };
    };
    expect(run()).toEqual(run());
  });
});
