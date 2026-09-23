import { describe, expect, it } from 'vitest';
import { burstArt } from '@/render/effects';
import { fxFrameAt } from '@/render/fxSprites';
import { burnStage, FIRE_STAGES_S } from '@/render/fireFx';

describe('combat FX art selection', () => {
  it('picks the burst flipbook by weapon, then by blast radius', () => {
    expect(burstArt({ pos: { x: 0, y: 0 }, radiusM: 4, t: 0, kind: 'he', weaponId: 'grenade' })?.key).toBe('grenade');
    expect(burstArt({ pos: { x: 0, y: 0 }, radiusM: 4, t: 0, kind: 'he', weaponId: 'kwk40_75' })?.key).toBe('he');
    expect(burstArt({ pos: { x: 0, y: 0 }, radiusM: 6, t: 0, kind: 'he', weaponId: 'mortar81' })?.key).toBe('he');
    expect(burstArt({ pos: { x: 0, y: 0 }, radiusM: 14, t: 0, kind: 'he', weaponId: 'ammo_explosion' })?.key).toBe('he.big');
    expect(burstArt({ pos: { x: 0, y: 0 }, radiusM: 0, t: 0, kind: 'small' })?.key).toBe('impact');
    expect(burstArt({ pos: { x: 0, y: 0 }, radiusM: 3, t: 0, kind: 'smoke' })?.key).toBe('smoke');
    // a bigger shell draws a bigger burst
    const small = burstArt({ pos: { x: 0, y: 0 }, radiusM: 3, t: 0, kind: 'he', weaponId: 'pak38' })!;
    const big = burstArt({ pos: { x: 0, y: 0 }, radiusM: 5, t: 0, kind: 'he', weaponId: 'zis3' })!;
    expect(big.scale).toBeGreaterThan(small.scale);
  });

  it('plays eased flipbooks by their frame times and ends them', () => {
    const e = { frames: 4, fps: 10, loop: false, times: [0, 0.1, 0.4, 1.0] };
    expect(fxFrameAt(e, 0)).toBe(0);
    expect(fxFrameAt(e, 0.05)).toBe(0);
    expect(fxFrameAt(e, 0.1)).toBe(1);
    expect(fxFrameAt(e, 0.9)).toBe(2);
    expect(fxFrameAt(e, 1.1)).toBe(3);
    expect(fxFrameAt(e, 2)).toBe(-1);
    expect(fxFrameAt({ frames: 8, fps: 16, loop: true }, 0.5)).toBe(8);
  });

  it('a vehicle fire smokes first, flames only while the sim has it burning, then smoulders', () => {
    expect(burnStage(1, true, 1).flame).toBe(0);
    expect(burnStage(1, true, 1).smoke).toBeGreaterThan(0.5);
    expect(burnStage(4, true, 4).flame).toBeGreaterThan(0);
    expect(burnStage(20, true, 20).flame).toBe(1);
    // the sim ended the fire at 30 s: no flames after, thick then thinning smoke, a wisp for good
    expect(burnStage(31, false, 30).flame).toBe(0);
    expect(burnStage(31, false, 30).smoke).toBeGreaterThan(burnStage(30 + FIRE_STAGES_S.smoulder, false, 30).smoke);
    expect(burnStage(1000, false, 30).smoke).toBeGreaterThan(0.1);
  });
});
