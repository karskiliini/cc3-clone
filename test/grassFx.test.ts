import { describe, expect, it } from 'vitest';
import { needsStamp, STAMP_STEP_TILES } from '@/render/grassFx';

describe('grass wake stamping', () => {
  it('lays a stamp only after the vehicle has covered the step distance', () => {
    expect(needsStamp(undefined, { x: 5, y: 5 })).toBe(true);
    expect(needsStamp({ x: 5, y: 5 }, { x: 5 + STAMP_STEP_TILES * 0.5, y: 5 })).toBe(false);
    expect(needsStamp({ x: 5, y: 5 }, { x: 5, y: 5 + STAMP_STEP_TILES + 0.01 })).toBe(true);
  });
});
