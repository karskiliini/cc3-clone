import { describe, it, expect } from 'vitest';
import { buildMap } from '@/sim/map';
import { village_1942 } from '@/data/maps/village_1942';
import { omniCoverAt } from '@/sim/cover';

describe('bunkers', () => {
  it('authored bunkers give heavy omni cover and render as concrete decor', () => {
    const map = buildMap(village_1942);
    expect(map.bunkerId).toBeDefined();
    const b = village_1942.bunkers![0];
    // interior tiles are covered
    const cov = omniCoverAt(map, { x: b.x + 0.5, y: b.y + 0.5 });
    expect(cov).toBeGreaterThanOrEqual(0.8);
    // one decor item per bunker, centred
    const dec = (map.decor ?? []).filter((d) => d.kind === 'bunker');
    expect(dec).toHaveLength(1);
    expect(dec[0].x).toBe(b.x + b.w / 2);
  });
  it('open ground near the bunker is not covered', () => {
    const map = buildMap(village_1942);
    const cov = omniCoverAt(map, { x: village_1942.bunkers![0].x + 5, y: village_1942.bunkers![0].y });
    expect(cov).toBeLessThan(0.5);
  });
});

import { isPassable } from '@/sim/path';

describe('bunker pathing', () => {
  it('vehicles cannot path through the bunker footprint; infantry can occupy it', () => {
    const map = buildMap(village_1942);
    const b = village_1942.bunkers![0];
    expect(isPassable(map, b.x, b.y, 'vehicle')).toBe(false);
    expect(isPassable(map, b.x + 1, b.y, 'vehicle')).toBe(false);
    expect(isPassable(map, b.x, b.y, 'infantry')).toBe(true);
  });
});
