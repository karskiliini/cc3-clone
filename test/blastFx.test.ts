import { describe, expect, it } from 'vitest';
import { BlastFx, SHAKE_LIFE_S, shakeAmplitude } from '@/render/blastFx';

describe('vehicle explosion effects', () => {
  it('shake is strongest at once and near, and gone after its lifetime', () => {
    expect(shakeAmplitude(0, 18, 0)).toBeGreaterThan(shakeAmplitude(0.4, 18, 0));
    expect(shakeAmplitude(0, 18, 0)).toBeGreaterThan(shakeAmplitude(0, 18, 40));
    expect(shakeAmplitude(0, 18, 0)).toBeGreaterThan(shakeAmplitude(0, 6, 0));
    expect(shakeAmplitude(SHAKE_LIFE_S, 18, 0)).toBe(0);
    expect(shakeAmplitude(0, 18, 100)).toBe(0);
  });
  it('only a vehicle explosion shakes the camera', () => {
    const fx = new BlastFx();
    const cam = { x: 0, y: 0, zoom: 1 };
    fx.onEvents([{ kind: 'cookOffPop', pos: { x: 25, y: 19 } } as never], 10);
    expect(fx.shake(cam, 10.05)).toEqual({ x: 0, y: 0 });
    fx.onEvents([{ kind: 'vehicleExplosion', pos: { x: 25, y: 19 }, radiusM: 18 } as never], 10);
    let moved = false;
    for (let t = 10; t < 10.5; t += 1 / 30) { const s = fx.shake(cam, t); if (s.x || s.y) moved = true; }
    expect(moved).toBe(true);
    expect(fx.shake(cam, 12)).toEqual({ x: 0, y: 0 });
  });
});
