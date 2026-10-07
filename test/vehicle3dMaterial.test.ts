import { describe, it, expect } from 'vitest';
import { MeshLambertMaterial } from 'three';
import { nodeMaterial, BURNT_GAIN } from '@/render/vehicle3d/models';

describe('nodeMaterial', () => {
  it('every look is matte (diffuse only, no sheen)', () => {
    for (const n of ['hull_ok', 'turret_ok', 'hull_ko', 'turret_blown']) expect(nodeMaterial(n, null)).toBeInstanceOf(MeshLambertMaterial);
  });
  it('live looks keep the baked colour; burnt looks are lifted to the sprites', () => {
    expect(nodeMaterial('hull_ok', null).color.r).toBe(1);
    for (const n of ['hull_ko', 'hull_blown', 'turret_ko', 'turret_blown']) expect(nodeMaterial(n, null).color.r).toBeCloseTo(BURNT_GAIN, 6);
  });
});
