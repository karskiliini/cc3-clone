import { describe, expect, it } from 'vitest';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { penetrates } from '@/sim/ballistics';
import { penetrationChance, penRating } from '@/sim/penChance';
import { Rng } from '@/shared/rng';

describe('penetrationChance', () => {
  it('matches the Monte-Carlo rate of penetrates()', () => {
    const w = WEAPONS.pak38;
    const rng = new Rng(7);
    for (const [distM, armor] of [[100, 45], [300, 45], [100, 60], [500, 30]] as const) {
      let n = 0;
      for (let i = 0; i < 20000; i++) if (penetrates(w, distM, armor, rng)) n++;
      expect(penetrationChance(w, distM, armor)).toBeCloseTo(n / 20000, 1);
    }
  });

  it('rates a light gun against a KV-1 by the face it sees', () => {
    const kv = VEHICLE_DEFS.kv1.armor;
    const light = WEAPONS.m1937_45mm;
    expect(penRating(penetrationChance(light, 200, kv.front))).toBe('none');
    const strong = WEAPONS.pak40;
    expect(penRating(penetrationChance(strong, 200, kv.rear))).toBe('likely');
    expect(penetrationChance(strong, 200, kv.rear)).toBeGreaterThanOrEqual(penetrationChance(strong, 200, kv.front));
  });

  it('gives a Panzer III a black cross on a KV-1 front at battle range and green on a T-26', () => {
    const gun = WEAPONS.kwk39_50;
    expect(penRating(penetrationChance(gun, 300, VEHICLE_DEFS.kv1.armor.front))).toBe('none');
    expect(penRating(penetrationChance(gun, 300, VEHICLE_DEFS.t26.armor.front))).toBe('likely');
    // point blank it is no longer hopeless, and the rear is a better bet than the front
    const front = penetrationChance(gun, 16, VEHICLE_DEFS.kv1.armor.front);
    const rear = penetrationChance(gun, 16, VEHICLE_DEFS.kv1.armor.rear);
    expect(penRating(front)).toBe('maybe');
    expect(rear).toBeGreaterThan(front);
  });

  it('is zero for weapons without penetration', () => {
    expect(penetrationChance(WEAPONS.mortar81, 100, 10)).toBe(0);
  });
});
