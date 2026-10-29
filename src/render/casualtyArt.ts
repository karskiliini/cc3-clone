import type { Health } from '@/shared/types';

export type BloodSeverity = 'wounded' | 'fallen';
export function bloodSeverity(health: Health): BloodSeverity | null {
  return health === 'healthy' ? null : health === 'wounded' ? 'wounded' : 'fallen';
}

/** Texture finish over the existing Blender figure. Find the largest connected cloth surface,
 * then soak an irregular patch into it. Transparent pixels, shadows, skin and weapons retain
 * their original pixels. Coordinates follow the actual rendered pose, including prone bodies. */
export function stainUniform(pixels: Uint8ClampedArray, width: number, height: number, severity: BloodSeverity): void {
  const cloth = new Uint8Array(width * height);
  for (let i = 0; i < cloth.length; i++) {
    const p = i * 4, r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    const skin = r > g * 1.22 && g > b * 1.12;
    cloth[i] = Number(pixels[p + 3] >= 200 && !skin && Math.max(r, g, b) >= 44
      && Math.max(r, g, b) <= 225 && g >= r * 0.77 && b <= g * 1.13 && b >= r * 0.40);
  }
  let largest: number[] = [];
  for (let start = 0; start < cloth.length; start++) {
    if (!cloth[start]) continue;
    const group = [start]; cloth[start] = 0;
    for (let k = 0; k < group.length; k++) {
      const i = group[k], x = i % width;
      for (const next of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
        if (next < 0 || next >= cloth.length || !cloth[next]) continue;
        cloth[next] = 0; group.push(next);
      }
    }
    if (group.length > largest.length) largest = group;
  }
  if (largest.length < 3) return;
  const xs = largest.map(i => i % width).sort((a, b) => a - b);
  const ys = largest.map(i => Math.floor(i / width)).sort((a, b) => a - b);
  const cx = xs[Math.floor(xs.length * 0.48)], cy = ys[Math.floor(ys.length * 0.44)];
  const radius = Math.max(1.5, Math.sqrt(largest.length) * (severity === 'fallen' ? 0.62 : 0.40));
  for (const i of largest) {
    const x = i % width, y = Math.floor(i / width), p = i * 4;
    const noise = ((x * 37 + y * 61 + x * y * 7) % 17) / 17;
    const d = Math.hypot(x - cx, (y - cy) * 0.88) / radius;
    if (d > 0.8 + noise * 0.4) continue;
    const soak = d < 0.6 ? 0.88 : 0.65;
    // Burgundy soaked cloth with small fresh-red highlights; preserve the baked lighting.
    const light = Math.max(pixels[p], pixels[p + 1], pixels[p + 2]) / 150;
    const red = (noise > 0.73 ? 155 : 112) * Math.min(1.2, Math.max(0.65, light));
    pixels[p] = Math.round(pixels[p] * (1 - soak) + red * soak);
    pixels[p + 1] = Math.round(pixels[p + 1] * (1 - soak) + 13 * soak);
    pixels[p + 2] = Math.round(pixels[p + 2] * (1 - soak) + 18 * soak);
  }
}

const cells = new WeakMap<object, Map<string, HTMLCanvasElement>>();
const unreadable = new WeakSet<object>();
const CACHE_CELLS = 512; // At scale 2, about 10 MiB per loaded atlas; released with its image.

export function bloodyCell(image: CanvasImageSource, rect: { sx: number; sy: number; sw: number; sh: number }, severity: BloodSeverity): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || unreadable.has(image)) return null;
  let cache = cells.get(image);
  if (!cache) { cache = new Map(); cells.set(image, cache); }
  const { sx, sy, sw, sh } = rect, key = `${sx},${sy},${sw},${sh},${severity}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const canvas = document.createElement('canvas'); canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh);
    stainUniform(data.data, sw, sh, severity); ctx.putImageData(data, 0, 0);
  } catch { unreadable.add(image); return null; }
  if (cache.size >= CACHE_CELLS) cache.delete(cache.keys().next().value!);
  cache.set(key, canvas); return canvas;
}
