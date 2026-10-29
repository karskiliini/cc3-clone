import { describe, expect, it } from 'vitest';
import { bloodSeverity, stainUniform } from '@/render/casualtyArt';

function figure() {
  const pixels = new Uint8ClampedArray(20 * 20 * 4);
  const dot = (x: number, y: number, rgb: number[], alpha = 255) => pixels.set([...rgb, alpha], (y * 20 + x) * 4);
  for (let y = 4; y < 16; y++) for (let x = 6; x < 14; x++) dot(x, y, [110, 115, 90]);
  dot(9, 2, [210, 160, 120]); // skin
  dot(16, 10, [95, 55, 30]); // wooden stock
  dot(15, 10, [32, 34, 36]); // gun metal
  dot(10, 18, [10, 12, 9], 100); // shadow
  return pixels;
}
const redCount = (pixels: Uint8ClampedArray) => Array.from({ length: pixels.length / 4 }, (_, i) => i * 4)
  .filter(p => pixels[p] > pixels[p + 1] * 2 && pixels[p + 2] < 50 && pixels[p + 3] > 200).length;

describe('casualty sprite finish', () => {
  it('makes the wounds visible, with heavier staining on incapacitated and dead figures', () => {
    const wound = figure(), fallen = figure();
    stainUniform(wound, 20, 20, 'wounded'); stainUniform(fallen, 20, 20, 'fallen');
    expect(redCount(wound)).toBeGreaterThan(8);
    expect(redCount(fallen)).toBeGreaterThan(redCount(wound) * 1.3);
    expect(bloodSeverity('healthy')).toBeNull(); expect(bloodSeverity('wounded')).toBe('wounded');
    expect(bloodSeverity('incapacitated')).toBe('fallen'); expect(bloodSeverity('dead')).toBe('fallen');
  });
  it('preserves silhouette, alpha, skin, guns and ground shadows', () => {
    const before = figure(), after = before.slice(); stainUniform(after, 20, 20, 'fallen');
    for (let i = 0; i < before.length; i += 4) {
      expect(after[i + 3]).toBe(before[i + 3]);
      if (before[i + 1] !== 115) expect(after.slice(i, i + 4)).toEqual(before.slice(i, i + 4));
    }
  });
  it('is stable across redraws and leaves empty cells untouched', () => {
    const a = figure(), b = figure(); stainUniform(a, 20, 20, 'fallen'); stainUniform(b, 20, 20, 'fallen');
    expect(a).toEqual(b);
    const empty = new Uint8ClampedArray(20 * 20 * 4); stainUniform(empty, 20, 20, 'fallen');
    expect(empty.every(v => v === 0)).toBe(true);
  });
});
