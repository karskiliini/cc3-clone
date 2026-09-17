// ============================================================================
// noise.ts — fractal value noise used by terrainRender.ts's painterly ground
// pass. Pure functions of WORLD PIXEL coordinates so texture is continuous
// across chunk boundaries (no seams when chunks are baked independently).
// ============================================================================
import { hash2 } from '@/shared/rng';

function fade(t: number): number { return t * t * (3 - 2 * t); }

/** Bilinear-interpolated value noise lattice, 0..1, at fractional coords (x,y). */
export function valueNoise(x: number, y: number, seed: number): number {
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
  return fbm(X / 5, Y / 5, 3, seed + 4401);
}

/** Slowly-varying angle field (radians), used to orient sparse directional grass-tuft strokes so
 * they read as brushed rather than randomly scattered — very low frequency (~48px wavelength) so
 * neighbouring tufts lean the same way over a patch of ground. */
export function angleField(X: number, Y: number, seed: number): number {
  return fbm(X / 48, Y / 48, 2, seed + 4501) * Math.PI * 2;
}

// ============================================================================
// Structured ground marks. The painted-ground look comes from STAMPED shapes a few pixels
// across (grass clumps, long blades, bare-earth scuffs, dead-grass tussocks), not from
// per-pixel white noise. Every mark lives in a world-space hash cell: whether the cell hosts a
// mark, where it sits, how big it is and which way it leans are all functions of the cell's
// WORLD coordinates, and each chunk stamps every cell that can reach it (cells are visited in
// the same row-major order in every chunk, so overlapping marks accumulate in the same float
// order) — the result is therefore a pure function of world position and seamless across chunk
// borders and zoom levels. Marks are rasterised at the chunk's true output resolution.
// ============================================================================

/** Three float planes the size of one chunk bake. Meaning is up to the caller; by convention
 * L = signed brightness delta (fraction, as `shade`), T = signed tint (+warm straw / -cool
 * green), E = 0..1 coverage of an overlay material (bare earth, dead stalks). */
export interface MarkLayers { L: Float32Array; T: Float32Array; E: Float32Array; size: number }

const layerPool = new Map<string, MarkLayers>();
/** Pooled + zeroed mark planes for a `size`x`size` bake. Bakes are synchronous, so a pool slot
 * is never in use twice at once; `slot` separates layers that are alive at the same time. */
export function acquireMarkLayers(size: number, slot: number): MarkLayers {
  const key = `${size}:${slot}`;
  let l = layerPool.get(key);
  if (!l) {
    const n = size * size;
    l = { L: new Float32Array(n), T: new Float32Array(n), E: new Float32Array(n), size };
    layerPool.set(key, l);
  } else { l.L.fill(0); l.T.fill(0); l.E.fill(0); }
  return l;
}

export interface TuftStyle {
  /** hash cell size, world px — one candidate mark per cell */
  cell: number;
  seed: number;
  /** half-length of the mark along its axis, world px */
  minLen: number; maxLen: number;
  /** half-width as a fraction of the half-length (1 = round dab, 0.12 = a blade) */
  minAspect: number; maxAspect: number;
  /** peak |L| */
  amp: number;
  /** weight of the flat light/dark polarity against the NW-lit emboss term (0..1) */
  flat: number;
  /** fraction of marks that are light (rest dark) */
  lightFrac: number;
  /** fraction of marks tinted warm / cool, and the peak |T| written */
  warmFrac: number; coolFrac: number; tint: number;
  /** +-radians of per-mark deviation from the wind field */
  angleJitter: number;
  /** >0: a bright seed head of this T weight at the downwind tip (tall grass) */
  seedHead: number;
  /** edge hardness: 1 = soft paraboloid falloff, 2-3 = flat-topped dab with a crisp ~1 px rim */
  crisp: number;
  /** wind direction wavelength, world px */
  windScale: number;
  /** mean lean direction (radians) and how far the wind field swings either side of it */
  windBase: number; windSwing: number;
}

/**
 * Stamps one soft-edged oriented elliptical mark per occupied hash cell into `out.L`/`out.T`.
 * Each mark is shaded like a little mound lit from the NW — lighter top-left, a darker crescent
 * along its SE base — plus a per-mark light/dark polarity, and leans with a slowly varying wind
 * field. `densityAt(X,Y)` (0..1, sampled once per mark at its anchor) thins the marks out, which
 * is what makes lusher and barer areas; return 0 to suppress marks entirely.
 */
export function stampTufts(
  out: MarkLayers, wx0: number, wy0: number, zoom: number, st: TuftStyle,
  densityAt: (X: number, Y: number) => number,
): void {
  const size = out.size, L = out.L, T = out.T;
  const cell = st.cell, seed = st.seed;
  const reach = st.maxLen + 1.5;
  const spanW = size / zoom;
  const ci0 = Math.floor((wx0 - reach) / cell), ci1 = Math.floor((wx0 + spanW + reach) / cell);
  const cj0 = Math.floor((wy0 - reach) / cell), cj1 = Math.floor((wy0 + spanW + reach) / cell);
  const inv = 1 / zoom;
  for (let cj = cj0; cj <= cj1; cj++) {
    for (let ci = ci0; ci <= ci1; ci++) {
      const h = hash2(ci, cj, seed);
      const ax = (ci + hash2(ci, cj, seed + 1)) * cell;
      const ay = (cj + hash2(ci, cj, seed + 2)) * cell;
      const dens = densityAt(ax, ay);
      if (h >= dens) continue;
      const hl = hash2(ci, cj, seed + 3), ha = hash2(ci, cj, seed + 4), hp = hash2(ci, cj, seed + 5), ht = hash2(ci, cj, seed + 6);
      const a = st.minLen + (st.maxLen - st.minLen) * hl;
      const b = Math.max(0.55, a * (st.minAspect + (st.maxAspect - st.minAspect) * ha));
      const ang = st.windBase + (valueNoise(ax / st.windScale, ay / st.windScale, seed + 7) - 0.5) * 2 * st.windSwing
        + (hash2(ci, cj, seed + 8) - 0.5) * 2 * st.angleJitter;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      // half-extents of the rotated ellipse's bounding box, and its half-extent along the light
      const ex = Math.sqrt(a * a * ca * ca + b * b * sa * sa) + 0.5;
      const ey = Math.sqrt(a * a * sa * sa + b * b * ca * ca) + 0.5;
      const cl = (ca + sa) * Math.SQRT1_2, sl = (ca - sa) * Math.SQRT1_2;
      const extL = Math.sqrt(a * a * cl * cl + b * b * sl * sl);
      const pol = hp < st.lightFrac ? 1 : -1;
      const tintV = ht < st.warmFrac ? st.tint : ht < st.warmFrac + st.coolFrac ? -st.tint : 0;
      const amp = st.amp * (0.65 + 0.7 * hash2(ci, cj, seed + 9));
      let ox0 = Math.ceil((ax - ex - wx0) * zoom - 0.5), ox1 = Math.floor((ax + ex - wx0) * zoom - 0.5);
      let oy0 = Math.ceil((ay - ey - wy0) * zoom - 0.5), oy1 = Math.floor((ay + ey - wy0) * zoom - 0.5);
      if (ox0 < 0) ox0 = 0; if (oy0 < 0) oy0 = 0; if (ox1 >= size) ox1 = size - 1; if (oy1 >= size) oy1 = size - 1;
      if (ox0 > ox1 || oy0 > oy1) continue;
      const ia = 1 / a, ib = 1 / b, iL = 1 / (extL * Math.SQRT2);
      const headU = a * 0.72;
      for (let oy = oy0; oy <= oy1; oy++) {
        const dy = wy0 + (oy + 0.5) * inv - ay;
        const row = oy * size;
        for (let ox = ox0; ox <= ox1; ox++) {
          const dx = wx0 + (ox + 0.5) * inv - ax;
          const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
          const e = u * ia * (u * ia) + v * ib * (v * ib);
          if (e >= 1) continue;
          let soft = (1 - e) * st.crisp;
          if (soft > 1) soft = 1;
          let lit = -(dx + dy) * iL;
          lit = lit < -1 ? -1 : lit > 1 ? 1 : lit;
          const i = row + ox;
          L[i] += amp * soft * (st.flat * pol + (1 - st.flat) * lit * 1.6);
          if (tintV !== 0) T[i] += tintV * soft * (lit > -0.3 ? 1 : 0.4);
          if (st.seedHead > 0 && pol > 0) {
            const du = u - headU;
            const eh = du * du + v * v;
            if (eh < 1.1) { T[i] += st.seedHead * (1 - eh / 1.1); L[i] += amp * 0.9 * (1 - eh / 1.1); }
          }
        }
      }
    }
  }
}

export interface ScuffStyle { cell: number; seed: number; minR: number; maxR: number; blobs: number; spread: number }

/** Stamps sparse irregular soft patches (a union of a few jittered ellipses per occupied cell)
 * into `out.E` as 0..1 coverage: bare-earth scuffs and dry patches in grass. */
export function stampScuffs(
  out: MarkLayers, wx0: number, wy0: number, zoom: number, st: ScuffStyle,
  chanceAt: (X: number, Y: number) => number,
): void {
  const size = out.size, E = out.E;
  const cell = st.cell, seed = st.seed;
  const reach = st.spread + st.maxR * 1.4 + 1;
  const spanW = size / zoom, inv = 1 / zoom;
  const ci0 = Math.floor((wx0 - reach) / cell), ci1 = Math.floor((wx0 + spanW + reach) / cell);
  const cj0 = Math.floor((wy0 - reach) / cell), cj1 = Math.floor((wy0 + spanW + reach) / cell);
  for (let cj = cj0; cj <= cj1; cj++) {
    for (let ci = ci0; ci <= ci1; ci++) {
      const ax = (ci + hash2(ci, cj, seed + 1)) * cell;
      const ay = (cj + hash2(ci, cj, seed + 2)) * cell;
      if (hash2(ci, cj, seed) >= chanceAt(ax, ay)) continue;
      const scale = 0.6 + 0.8 * hash2(ci, cj, seed + 3);
      for (let k = 0; k < st.blobs; k++) {
        const bx = ax + (hash2(ci * 7 + k, cj, seed + 11) - 0.5) * 2 * st.spread * scale;
        const by = ay + (hash2(ci, cj * 7 + k, seed + 12) - 0.5) * 2 * st.spread * scale * 0.7;
        const r = (st.minR + (st.maxR - st.minR) * hash2(ci * 5 + k, cj * 3, seed + 13)) * scale;
        const rx = r * (0.8 + 0.6 * hash2(ci + k, cj * 11, seed + 14)), ry = r * 0.8;
        let ox0 = Math.ceil((bx - rx - wx0) * zoom - 0.5), ox1 = Math.floor((bx + rx - wx0) * zoom - 0.5);
        let oy0 = Math.ceil((by - ry - wy0) * zoom - 0.5), oy1 = Math.floor((by + ry - wy0) * zoom - 0.5);
        if (ox0 < 0) ox0 = 0; if (oy0 < 0) oy0 = 0; if (ox1 >= size) ox1 = size - 1; if (oy1 >= size) oy1 = size - 1;
        const strength = 0.7 + 0.3 * hash2(ci, cj + k, seed + 15);
        for (let oy = oy0; oy <= oy1; oy++) {
          const dy = (wy0 + (oy + 0.5) * inv - by) / ry;
          for (let ox = ox0; ox <= ox1; ox++) {
            const dx = (wx0 + (ox + 0.5) * inv - bx) / rx;
            const e = dx * dx + dy * dy;
            if (e >= 1) continue;
            const v = (1 - e) * 1.6 * strength;
            const i = oy * size + ox;
            if (v > E[i]) E[i] = v > 1 ? 1 : v;
          }
        }
      }
    }
  }
}

export interface TussockStyle { cell: number; seed: number }

/** Winter: tussocks of dead grass poking through snow. Each occupied cell gets a small fan of
 * 1px stalks rising from a dark base, written to `out.E` (stalk coverage) and `out.T` (0 = dark
 * earth/twig .. 1 = pale straw), with a soft blue-shadow smear to the SE in `out.L` (negative). */
export function stampTussocks(
  out: MarkLayers, wx0: number, wy0: number, zoom: number, st: TussockStyle,
  densityAt: (X: number, Y: number) => number,
): void {
  const size = out.size, E = out.E, T = out.T, L = out.L;
  const cell = st.cell, seed = st.seed;
  const reach = 9;
  const spanW = size / zoom, inv = 1 / zoom;
  const ci0 = Math.floor((wx0 - reach) / cell), ci1 = Math.floor((wx0 + spanW + reach) / cell);
  const cj0 = Math.floor((wy0 - reach) / cell), cj1 = Math.floor((wy0 + spanW + reach) / cell);
  const put = (X: number, Y: number, e: number, t: number): void => {
    const ox = Math.floor((X - wx0) * zoom), oy = Math.floor((Y - wy0) * zoom);
    if (ox < 0 || oy < 0 || ox >= size || oy >= size) return;
    const i = oy * size + ox;
    if (e > E[i]) { E[i] = e; T[i] = t; }
  };
  for (let cj = cj0; cj <= cj1; cj++) {
    for (let ci = ci0; ci <= ci1; ci++) {
      const ax = (ci + hash2(ci, cj, seed + 1)) * cell;
      const ay = (cj + hash2(ci, cj, seed + 2)) * cell;
      const dens = densityAt(ax, ay);
      if (hash2(ci, cj, seed) >= dens) continue;
      const big = 0.6 + 0.9 * hash2(ci, cj, seed + 3);
      // soft blue shadow smear to the SE of the clump
      const sr = 2.2 * big + 1;
      const sx = ax + 1.6 * big, sy = ay + 1.3 * big;
      let ox0 = Math.ceil((sx - sr - wx0) * zoom - 0.5), ox1 = Math.floor((sx + sr - wx0) * zoom - 0.5);
      let oy0 = Math.ceil((sy - sr * 0.7 - wy0) * zoom - 0.5), oy1 = Math.floor((sy + sr * 0.7 - wy0) * zoom - 0.5);
      if (ox0 < 0) ox0 = 0; if (oy0 < 0) oy0 = 0; if (ox1 >= size) ox1 = size - 1; if (oy1 >= size) oy1 = size - 1;
      for (let oy = oy0; oy <= oy1; oy++) {
        const dy = (wy0 + (oy + 0.5) * inv - sy) / (sr * 0.7);
        for (let ox = ox0; ox <= ox1; ox++) {
          const dx = (wx0 + (ox + 0.5) * inv - sx) / sr;
          const e = dx * dx + dy * dy;
          if (e < 1) L[oy * size + ox] -= (1 - e) * 0.5;
        }
      }
      // stalks: a fan leaning with the wind (to the E/SE), stepped at half an output pixel
      const n = 3 + Math.floor(hash2(ci, cj, seed + 4) * 4 * big);
      const step = 0.5 * inv;
      for (let k = 0; k < n; k++) {
        const bx = ax + (hash2(ci * 3 + k, cj, seed + 21) - 0.5) * 4.4 * big;
        const by = ay + (hash2(ci, cj * 3 + k, seed + 22) - 0.5) * 2.6 * big;
        const len = (1.6 + 2.4 * hash2(ci + k, cj - k, seed + 23)) * big;
        const ang = -Math.PI / 2 + 0.5 + (hash2(ci - k, cj + k, seed + 24) - 0.5) * 1.5;
        const dxs = Math.cos(ang), dys = Math.sin(ang);
        const tone = hash2(ci + k * 5, cj, seed + 25);
        for (let d = 0; d <= len; d += step) {
          const f = d / len;
          put(bx + dxs * d, by + dys * d, 0.95 - 0.35 * f, 0.15 + 0.85 * (tone * 0.5 + f * 0.5));
        }
        put(bx, by, 1, 0); // dark root
      }
    }
  }
}

export { hash2 };
