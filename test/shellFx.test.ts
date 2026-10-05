import { describe, it, expect } from 'vitest';
import { WEAPONS } from '@/data/weapons';
import { dist, angleTo } from '@/shared/math';
import { armourRicochet, groundStrike, missPoint } from '@/sim/shellFx';
import { makeState } from './vehicleDamageHelpers';

const AP = { ...WEAPONS.kwk40_75, heRadiusM: 0 };
const HE = { ...WEAPONS.kwk40_75, heRadiusM: 5 };

describe('shell strikes and ricochets (visual)', () => {
  it('a miss lands beyond the target on the line of fire, never on it', () => {
    const state = makeState();
    const from = { x: 200, y: 260 }, target = { x: 200, y: 200 };
    for (let t = 0; t < 3; t += 0.37) {
      const m = missPoint(state, from, target, t);
      expect(dist(from, m)).toBeGreaterThan(dist(from, target) + 1); // at least 2 m past
      expect(Math.abs(m.x - target.x)).toBeLessThan(2.5);
    }
  });

  it('solid shot throws up the ground and skips on; HE only splashes (its burst is its own)', () => {
    const state = makeState();
    groundStrike(state, { x: 200, y: 200 }, 0, 5, AP);
    expect(state.sparks.some((s) => s.kind === 'groundSplash' && s.t === 5)).toBe(true);
    const skip = state.projectiles.find((p) => p.kind === 'ricochet')!;
    expect(skip.t0).toBe(5);
    expect(Math.abs(angleTo(skip.from, skip.to))).toBeLessThan(0.3); // on along the line of fire (north)
    const he = makeState();
    groundStrike(he, { x: 200, y: 200 }, 0, 5, HE);
    expect(he.projectiles).toHaveLength(0);
  });

  it('a shot that bounces off armour glances off to one side', () => {
    const state = makeState();
    armourRicochet(state, { x: 200, y: 200 }, 0, 2, AP);
    const r = state.projectiles.find((p) => p.kind === 'ricochet')!;
    expect(r.t0).toBe(2);
    expect(Math.abs(angleTo(r.from, r.to))).toBeGreaterThan(0.4);
  });
});
