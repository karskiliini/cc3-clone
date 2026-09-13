// ============================================================================
// noise.ts — fractal value noise used by terrainRender.ts's painterly ground
// pass. Pure functions of WORLD PIXEL coordinates so texture is continuous
// across chunk boundaries (no seams when chunks are baked independently).
// ============================================================================
import { hash2 } from '@/shared/rng';

function fade(t: number): number { return t * t * (3 - 2 * t); }

/** Bilinear-interpolated value noise lattice, 0..1, at fractional coords (x,y). */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

/**
 * Fractal Brownian motion: `octaves` layers of value noise, lacunarity 2,
 * gain 0.5, normalized to 0..1.
 */
export function fbm(x: number, y: number, octaves = 5, seed = 0): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Large mottling (~6 m patches) sampled at world pixel coords.
 * (2 octaves rather than the theoretical 5 — a per-pixel render-time budget
 * of <25ms/chunk requires trimming noise cost; visually indistinguishable at
 * this pixel density.) */
export function fbm64(X: number, Y: number, seed: number): number {
  return fbm(X / 64, Y / 64, 2, seed);
}

/** Medium mottling sampled at world pixel coords. */
export function fbm14(X: number, Y: number, seed: number): number {
  return fbm(X / 14, Y / 14, 2, seed + 5501);
}

/** Very large scale relief height field (hills), 2 octaves — sampled coarsely
 * (see reliefFactor's block cache) since its wavelength (~400px) is huge. */
export function heightField(X: number, Y: number, seed: number): number {
  return fbm(X / 400, Y / 400, 2, seed + 9911);
}

/** Mid-frequency "brush clump" band, ~6-10px wavelength, 3 octaves — this is what makes ground
 * read as dabbed-on paint patches instead of uniform speckle: `groundColorFbm` posterises this
 * into a handful of tonal steps and blends it in (see fix #2, round-3 critique). */
export function fbmClump(X: number, Y: number, seed: number): number {
  return fbm(X / 8, Y / 8, 3, seed + 4401);
}

/** Slowly-varying angle field (radians), used to orient sparse directional grass-tuft strokes so
 * they read as brushed rather than randomly scattered — very low frequency (~48px wavelength) so
 * neighbouring tufts lean the same way over a patch of ground. */
export function angleField(X: number, Y: number, seed: number): number {
  return fbm(X / 48, Y / 48, 2, seed + 4501) * Math.PI * 2;
}

export { hash2 };
