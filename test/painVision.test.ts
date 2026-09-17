// Tests for sim/spotting.ts's painVisionFactor: a wounded man's visibility suffers periodically.
import { describe, it, expect } from 'vitest';
import type { Soldier } from '@/shared/types';
import { createMind } from '@/sim/mind';
import {
  painVisionFactor, PAIN_MILD_FACTOR, PAIN_BOUT_FACTOR, PAIN_BOUT_FACTOR_LOW_MORALE, PAIN_BOUT_FACTOR_VETERAN,
} from '@/sim/spotting';

let nextId = 1;
function makeSoldier(over: Partial<Soldier> = {}): Soldier {
  return {
    id: nextId++, teamId: 1, side: 'german', name: 'T', rank: 'Pvt', weaponId: 'kar98k', ammo: 10, ammoReserve: 0,
    grenades: 0, health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing',
    activity: 'idle', pos: { x: 0, y: 0 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(50), ...over,
  };
}

describe('painVisionFactor', () => {
  it('is 1 for a healthy man at every time', () => {
    const s = makeSoldier({ health: 'healthy' });
    for (let t = 0; t < 500; t += 37) expect(painVisionFactor(s, t)).toBe(1);
  });

  it('is 1 for dead/incapacitated men (moot — they do not spot, but never a phantom penalty)', () => {
    for (const health of ['dead', 'incapacitated'] as const) {
      const s = makeSoldier({ health });
      expect(painVisionFactor(s, 123)).toBe(1);
    }
  });

  it('is deterministic and identical across repeated calls, including on a fresh equal soldier object', () => {
    const s1 = makeSoldier({ health: 'wounded', experience: 50, morale: 80 });
    const id = s1.id;
    const a = painVisionFactor(s1, 42.5);
    const b = painVisionFactor(s1, 42.5);
    expect(b).toBe(a);
    const s2 = makeSoldier({ id, health: 'wounded', experience: 50, morale: 80 });
    expect(painVisionFactor(s2, 42.5)).toBe(a);
  });

  it('a wounded man alternates between a mild penalty and periodic strong bouts', () => {
    const s = makeSoldier({ health: 'wounded', experience: 50, morale: 80 });
    const seen = new Set<number>();
    for (let t = 0; t < 200; t += 0.5) seen.add(painVisionFactor(s, t));
    expect(seen.has(PAIN_MILD_FACTOR)).toBe(true);
    expect(seen.has(PAIN_BOUT_FACTOR)).toBe(true);
    // never anything outside the documented set for a mid-experience, mid-morale man
    for (const v of seen) expect([PAIN_MILD_FACTOR, PAIN_BOUT_FACTOR]).toContain(v);
  });

  it('bouts hit harder on green/shaken troops and lighter on veterans', () => {
    const green = makeSoldier({ health: 'wounded', experience: 10, morale: 80 });
    const shaken = makeSoldier({ health: 'wounded', experience: 50, morale: 10 });
    const veteran = makeSoldier({ health: 'wounded', experience: 80, morale: 80 });
    const worst = (s: Soldier): number => {
      let m = 1;
      for (let t = 0; t < 200; t += 0.5) m = Math.min(m, painVisionFactor(s, t));
      return m;
    };
    expect(worst(green)).toBeCloseTo(PAIN_BOUT_FACTOR_LOW_MORALE, 6);
    expect(worst(shaken)).toBeCloseTo(PAIN_BOUT_FACTOR_LOW_MORALE, 6);
    expect(worst(veteran)).toBeCloseTo(PAIN_BOUT_FACTOR_VETERAN, 6);
  });

  it('bouts cover roughly 15-35% of the time on average across many soldiers', () => {
    const DURATION = 4000, STEP = 0.25;
    let totalFrac = 0, n = 0;
    for (let id = 1; id <= 25; id++) {
      const s = makeSoldier({ id, health: 'wounded' });
      let inBout = 0, samples = 0;
      for (let t = 0; t < DURATION; t += STEP) {
        if (painVisionFactor(s, t) !== PAIN_MILD_FACTOR) inBout++;
        samples++;
      }
      totalFrac += inBout / samples;
      n++;
    }
    const avg = totalFrac / n;
    expect(avg).toBeGreaterThan(0.15);
    expect(avg).toBeLessThan(0.35);
  });

  it('does not touch the seeded Rng stream (pure function of soldier + time only)', () => {
    // painVisionFactor takes no Rng — this is really a compile-time guarantee, but assert the
    // runtime side too: calling it a different number of times never changes anything else that
    // depends only on wall/battle time, i.e. it carries no hidden mutable state.
    const s = makeSoldier({ health: 'wounded' });
    const before = painVisionFactor(s, 10);
    for (let i = 0; i < 50; i++) painVisionFactor(s, i);
    const after = painVisionFactor(s, 10);
    expect(after).toBe(before);
  });
});
