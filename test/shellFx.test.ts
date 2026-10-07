import { describe, it, expect } from 'vitest';
import { WEAPONS } from '@/data/weapons';
import { angleTo } from '@/shared/math';
import { TILE_M } from '@/shared/types';
import { armourRicochet, groundStrike, missPoint } from '@/sim/shellFx';
import { makeState } from './vehicleDamageHelpers';

const AP = { ...WEAPONS.kwk40_75, heRadiusM: 0 };
const HE = { ...WEAPONS.kwk40_75, heRadiusM: 5 };

describe('shell strikes and ricochets (visual)', () => {
  // A miss is a real trajectory: from the muzzle (~2 m up) a flat, fast round that passed over the
  // hull keeps flying for hundreds of metres; one that came in low strikes the ground in front;
  // only one that went wide of the silhouette may land close behind it.
  function missesOf(halfM: number, speedMs = 600) {
    const state = makeState();
    const from = { x: 200, y: 260 }, target = { x: 200, y: 200 };   // 120 m, firing north
    const out: { past: number; sideM: number }[] = [];
    for (let t = 0; t < 30; t += 0.137) {
      const m = missPoint(state, from, target, t, halfM, speedMs);
      const along = (from.y - m.y) * TILE_M, rangeM = (from.y - target.y) * TILE_M;
      out.push({ past: along - rangeM, sideM: Math.abs(m.x - target.x) * TILE_M * (rangeM / along) });
    }
    return out;
  }

  it('a miss never lands just behind a target it would have had to fly through', () => {
    for (const m of missesOf(1.5)) {
      const wide = m.sideM > 1.5;                    // passed beside the hull at the target's range
      if (!wide && m.past > -3) expect(m.past).toBeGreaterThan(60);   // over: flies on, far beyond
    }
  });

  it('misses fall short, go over and go wide', () => {
    const ms = missesOf(1.5);
    expect(ms.some((m) => m.past < -3)).toBe(true);
    expect(ms.some((m) => m.sideM <= 1.5 && m.past > 60)).toBe(true);
    expect(ms.some((m) => m.sideM > 1.5)).toBe(true);
  });

  it('a target seen side-on is longer: a wide miss clears its length', () => {
    for (const m of missesOf(3.4)) if (m.past > -3 && m.past < 60) expect(m.sideM).toBeGreaterThan(3.4);
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
