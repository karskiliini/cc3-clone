// ============================================================================
// craterArt.ts — procedural earthworks: shell craters, grenade holes, foxholes
// and trenches. Every feature is modelled as a small HEIGHT FIELD in metres
// (bowl + raised rim + ejecta for a crater, a steep-sided pit + spoil mound for
// a foxhole, a crenellated cut + parapet for a trench) sampled per output pixel,
// then shaded in one shared pass:
//   * slope lighting from the NW (the NW inner wall of a pit faces away from the
//     light and goes dark, the SE inner wall and NW-facing outer rim slopes light)
//   * a soft cast shadow found by propagating a sun-horizon along the NW->SE
//     diagonal (fills a foxhole floor with deep shadow, casts a rim shadow SE)
//   * layered materials: scorch, loose earth (ejecta/spoil, darker when deep),
//     clods, sandbags, logs, duckboards, snow dusting, puddles, grass regrowth.
// Noise is sampled in zoom-1 WORLD pixel coordinates, so a feature baked at
// zoom 2 is the same shape as at zoom 1 (just finer), and a trench crossing a
// chunk seam is continuous. The result is an RGBA patch drawn over the baked
// ground with source-over, so it inherits whatever grass/snow/road is beneath.
// All art is original and procedural; nothing is sampled from reference images.
// ============================================================================
import type { Season, Vec2 } from '@/shared/types';
import { hash2 } from '@/shared/rng';

/** zoom-1 world pixels per metre (TILE_PX 20 / TILE_M 2). */
const PX_PER_M = 10;

type RGB = readonly [number, number, number];
interface EarthPalette {
  soil: RGB; soilLight: RGB; pitDeep: RGB; scorch: RGB; snow: RGB; snowShade: RGB;
  sandbag: RGB; log: RGB; board: RGB; grass: RGB; water: RGB; shadow: RGB; clodLight: RGB;
}

const PALETTES: Record<Season, EarthPalette> = {
  summer: {
    soil: [104, 76, 38], soilLight: [170, 136, 84], pitDeep: [38, 20, 4], scorch: [34, 28, 12],
    snow: [236, 240, 244], snowShade: [150, 162, 184], sandbag: [150, 134, 96], log: [84, 60, 36],
    board: [96, 76, 46], grass: [86, 94, 34], water: [46, 44, 30], shadow: [18, 14, 4], clodLight: [184, 150, 96],
  },
  autumn: {
    soil: [96, 72, 44], soilLight: [150, 120, 82], pitDeep: [32, 20, 10], scorch: [30, 24, 14],
    snow: [236, 240, 244], snowShade: [150, 162, 184], sandbag: [140, 126, 94], log: [80, 58, 38],
    board: [92, 74, 48], grass: [100, 94, 44], water: [48, 48, 40], shadow: [18, 14, 8], clodLight: [164, 134, 94],
  },
  winter: {
    soil: [88, 60, 40], soilLight: [138, 104, 76], pitDeep: [30, 16, 6], scorch: [62, 50, 40],
    snow: [238, 241, 245], snowShade: [158, 168, 188], sandbag: [168, 162, 146], log: [78, 56, 36],
    board: [110, 84, 54], grass: [86, 94, 34], water: [80, 92, 100], shadow: [66, 76, 100], clodLight: [150, 110, 72],
  },
};

// --------------------------------------------------------------------- noise
function vnoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  let fx = x - x0, fy = y - y0;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** 2-octave value noise, roughly -0.5..0.5. */
function noise2(x: number, y: number, seed: number): number {
  return vnoise(x, y, seed) * 0.667 + vnoise(x * 2.1, y * 2.1, seed + 101) * 0.333 - 0.5;
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, v: number) => { const t = clamp01((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// --------------------------------------------------------------------- field
/** Material ids stored per pixel. */
const MAT_NONE = 0, MAT_CLOD = 1, MAT_SANDBAG = 2, MAT_LOG = 3, MAT_BOARD = 4, MAT_SEAM = 5;

/** Reusable per-pixel buffers for one earthwork patch (grown on demand, never shrunk). */
export class EarthField {
  w = 0; h = 0; zoom = 1;
  /** zoom-1 world px of the patch's top-left pixel corner */
  ox = 0; oy = 0;
  H = new Float32Array(0);      // height, metres (negative = dug)
  soil = new Float32Array(0);   // loose-earth coverage 0..1
  scorch = new Float32Array(0); // blast scorch 0..1
  snow = new Float32Array(0);   // snow cover 0..1 (winter only)
  aux = new Float32Array(0);    // scratch (trench distance)
  aux2 = new Float32Array(0);   // scratch (trench along-coordinate)
  aux3 = new Float32Array(0);   // scratch (trench side)
  mat = new Uint8Array(0);

  reset(w: number, h: number, zoom: number, ox: number, oy: number): void {
    this.w = w; this.h = h; this.zoom = zoom; this.ox = ox; this.oy = oy;
    const n = w * h;
    if (this.H.length < n) {
      const cap = Math.ceil(n * 1.25);
      this.H = new Float32Array(cap); this.soil = new Float32Array(cap); this.scorch = new Float32Array(cap);
      this.snow = new Float32Array(cap); this.aux = new Float32Array(cap); this.aux2 = new Float32Array(cap);
      this.aux3 = new Float32Array(cap); this.mat = new Uint8Array(cap);
    } else {
      this.H.fill(0, 0, n); this.soil.fill(0, 0, n); this.scorch.fill(0, 0, n); this.snow.fill(0, 0, n); this.mat.fill(0, 0, n);
    }
  }
}
const FIELD = new EarthField();
let horizon = new Float32Array(0);

interface ShadeOpts {
  /** depth (m) at which exposed earth reaches the palette's deepest pit colour */
  depthRef: number;
  /** old map-placed feature: eroded, puddles/grass regrowth (summer/autumn) */
  old: boolean;
  seed: number;
  puddles: boolean;
}

// light from the NW, ~40 degrees above the horizon
const LX = -0.46, LY = -0.46, LZ = 0.76;
const TAN_ELEV = 0.62;

/** Shades a filled field into RGBA (non-premultiplied, straight alpha). */
export function shadeField(f: EarthField, season: Season, o: ShadeOpts, out: Uint8ClampedArray): void {
  const pal = PALETTES[season];
  const { w, h, zoom } = f;
  const n = w * h;
  const mpp = 1 / (PX_PER_M * zoom);
  const H = f.H, soilA = f.soil, scorchA = f.scorch, snowA = f.snow, mat = f.mat;
  if (horizon.length < n) horizon = new Float32Array(Math.ceil(n * 1.25));
  const S = horizon;
  const drop = mpp * Math.SQRT2 * TAN_ELEV;
  const winter = season === 'winter';
  const inv2 = 1 / (2 * mpp);
  const shadowSoft = 0.16;
  const [shR, shG, shB] = pal.shadow;
  const shadowStrength = winter ? 0.5 : 0.6;
  const seed = o.seed;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    const Y = f.oy + (y + 0.5) / zoom;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const hi = H[i];
      // sun horizon carried down the NW->SE diagonal (ground level beyond the patch edge)
      const prev = (x > 0 && y > 0 ? S[i - w - 1] : 0) - drop;
      S[i] = hi > prev ? hi : prev;
      const shadowDepth = prev - hi;
      const sa = soilA[i], sc = scorchA[i], sn = snowA[i], m = mat[i];
      if (sa <= 0 && sc <= 0 && shadowDepth <= 0.005 && hi === 0 && sn <= 0) {
        // nothing here — but a neighbour's slope may still exist; cheap test via 4-neighbours
        const l = x > 0 ? H[i - 1] : 0, r = x < w - 1 ? H[i + 1] : 0;
        const u = y > 0 ? H[i - w] : 0, d = y < h - 1 ? H[i + w] : 0;
        if (l === 0 && r === 0 && u === 0 && d === 0) { const p = i * 4; out[p + 3] = 0; continue; }
      }
      const X = f.ox + (x + 0.5) / zoom;

      // ---- slope lighting
      const hl = x > 0 ? H[i - 1] : hi, hr = x < w - 1 ? H[i + 1] : hi;
      const hu = y > 0 ? H[i - w] : hi, hd = y < h - 1 ? H[i + w] : hi;
      const gx = (hr - hl) * inv2 * (x > 0 && x < w - 1 ? 1 : 2);
      const gy = (hd - hu) * inv2 * (y > 0 && y < h - 1 ? 1 : 2);
      const nl = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      let lam = (-gx * LX - gy * LY + LZ) * nl / LZ;
      lam = lam < 0.18 ? 0.18 : lam > 1.75 ? 1.75 : lam;
      const shadow = clamp01(shadowDepth / shadowSoft) * shadowStrength;

      let R = 0, G = 0, B = 0, A = 0; // premultiplied accumulator
      const over = (r: number, g: number, b: number, a: number) => {
        if (a <= 0) return;
        const k = 1 - a;
        R = r * a + R * k; G = g * a + G * k; B = b * a + B * k; A = a + A * k;
      };

      // ---- scorch on the surrounding ground
      if (sc > 0) over(pal.scorch[0], pal.scorch[1], pal.scorch[2], sc);

      // ---- relief shading of the uncovered ground itself (ejecta mound slopes)
      const bare = 1 - sa;
      if (bare > 0) {
        if (lam < 1) over(shR, shG, shB, (1 - lam) * 0.75 * bare);
        else over(255, 255, 240, (lam - 1) * (winter ? 0.12 : 0.28) * bare);
      }

      // ---- loose earth / materials
      if (sa > 0) {
        const blot = noise2(X / 3.2, Y / 3.2, seed + 11);
        const grain = hash2(Math.floor(X * zoom), Math.floor(Y * zoom), seed + 12) - 0.5;
        let t = clamp01(0.4 + blot * 1.3 + (hi > 0 ? hi * 0.7 : 0));
        let r = pal.soil[0] + (pal.soilLight[0] - pal.soil[0]) * t;
        let g = pal.soil[1] + (pal.soilLight[1] - pal.soil[1]) * t;
        let b = pal.soil[2] + (pal.soilLight[2] - pal.soil[2]) * t;
        if (hi < 0) {
          const dt = Math.pow(clamp01(-hi / o.depthRef), 0.75);
          r += (pal.pitDeep[0] - r) * dt; g += (pal.pitDeep[1] - g) * dt; b += (pal.pitDeep[2] - b) * dt;
        }
        if (m === MAT_CLOD) {
          t = grain > 0 ? 0.85 : 0.2;
          r = r + (pal.clodLight[0] - r) * t * 0.6; g = g + (pal.clodLight[1] - g) * t * 0.6; b = b + (pal.clodLight[2] - b) * t * 0.6;
          if (grain <= 0) { r *= 0.62; g *= 0.6; b *= 0.58; }
        } else if (m === MAT_SANDBAG) {
          [r, g, b] = pal.sandbag;
          const v = 1 + blot * 0.25; r *= v; g *= v; b *= v;
        } else if (m === MAT_LOG) {
          [r, g, b] = pal.log;
          const v = 1 + (hash2(Math.floor(X * zoom), 0, seed + 13) - 0.5) * 0.3; r *= v; g *= v; b *= v;
        } else if (m === MAT_BOARD) {
          [r, g, b] = pal.board;
        } else if (m === MAT_SEAM) {
          r *= 0.55; g *= 0.52; b *= 0.5;
        }
        const tex = 1 + grain * 0.24;
        const light = lam * tex;
        over(r * light, g * light, b * light, sa);
      }

      // ---- old features: puddle in the bottom, grass creeping back over the rim
      if (o.old && !winter) {
        if (o.puddles && hi < -o.depthRef * 0.62) {
          const edge = clamp01((-hi - o.depthRef * 0.62) / (o.depthRef * 0.12) + noise2(X / 2, Y / 2, seed + 21) * 0.8);
          const glint = 1 + clamp01(noise2(X / 1.5, Y / 1.5, seed + 22) * 2) * 0.45;
          over(pal.water[0] * glint, pal.water[1] * glint, pal.water[2] * glint, edge * 0.8);
        }
        if (sa > 0) {
          const gg = noise2(X / 2.4, Y / 2.4, seed + 23) + (hash2(Math.floor(X * zoom), Math.floor(Y * zoom), seed + 24) - 0.5) * 0.5;
          const ga = clamp01((gg - 0.06) * 2.4) * sa * (hi > -o.depthRef * 0.35 ? 0.5 : 0.15);
          if (ga > 0) over(pal.grass[0] * lam, pal.grass[1] * lam, pal.grass[2] * lam, ga);
        }
      }

      // ---- snow: patchy by noise, fills flats, thins on steep walls
      if (winter && sn > 0 && sa > 0) {
        const pn = noise2(X / 4.5, Y / 4.5, seed + 31) + (hash2(Math.floor(X * zoom), Math.floor(Y * zoom), seed + 32) - 0.5) * 0.12;
        const steep = clamp01(1 - (gx * gx + gy * gy) * 0.25);
        const a = clamp01((sn - 0.5 + pn) * 3) * (0.35 + 0.65 * steep) * sa;
        if (a > 0) {
          const k = clamp01((lam - 0.55) / 0.6);
          over(pal.snowShade[0] + (pal.snow[0] - pal.snowShade[0]) * k,
            pal.snowShade[1] + (pal.snow[1] - pal.snowShade[1]) * k,
            pal.snowShade[2] + (pal.snow[2] - pal.snowShade[2]) * k, a);
        }
      }

      // ---- cast shadow
      if (shadow > 0) {
        // blue sky-lit shadow on snow/grass, but a plain dark-earth shadow down inside a hole
        const k = sa > 0 ? sa : 0;
        over(shR + (16 - shR) * k, shG + (10 - shG) * k, shB + (4 - shB) * k, shadow);
      }

      const p = i * 4;
      if (A <= 0.003) { out[p + 3] = 0; continue; }
      out[p] = R / A; out[p + 1] = G / A; out[p + 2] = B / A; out[p + 3] = A * 255;
    }
  }
}

// ------------------------------------------------------------ canvas output
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;
let scratchImg: ImageData | null = null;

function blit(ctx: CanvasRenderingContext2D, f: EarthField, season: Season, o: ShadeOpts, dx: number, dy: number): void {
  const { w, h } = f;
  if (w <= 0 || h <= 0) return;
  if (!scratch) { scratch = document.createElement('canvas'); scratchCtx = scratch.getContext('2d')!; }
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w); scratch.height = Math.max(scratch.height, h);
    scratchImg = null;
  }
  if (!scratchImg || scratchImg.width !== w || scratchImg.height !== h) scratchImg = scratchCtx!.createImageData(w, h);
  shadeField(f, season, o, scratchImg.data);
  scratchCtx!.clearRect(0, 0, w, h);
  scratchCtx!.putImageData(scratchImg, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, w, h, dx, dy, w, h);
  ctx.restore();
}

// =================================================================== craters
export type CraterKind = 'shell' | 'grenade';
export interface CraterDraw {
  /** centre, zoom-1 world px */
  x: number; y: number;
  /** rim-to-rim diameter in metres (grenade: scorched pit diameter) */
  diameterM: number;
  kind: CraterKind;
  /** true for map-placed craters from earlier fighting (eroded, puddles / regrowth / snow-filled) */
  old: boolean;
  seed: number;
}

/** Outer radius in zoom-1 world px that the crater (ejecta, scorch, shadow) can touch. */
export function craterExtentPx(c: CraterDraw): number {
  const R = c.diameterM / 2;
  const m = c.kind === 'grenade' ? R * 2.9 + 0.2 : R * (c.old ? 2.1 : 3.3) + 0.4;
  return m * PX_PER_M;
}

/** Fills FIELD for a crater; returns shading options. Exported for tests. */
export function fillCrater(f: EarthField, c: CraterDraw, season: Season): ShadeOpts {
  const { w, h, zoom } = f;
  const seed = c.seed | 0;
  const winter = season === 'winter';
  const R = c.diameterM / 2;
  // outline wobble: a few low harmonics, so no two craters share an outline
  const K = 6;
  const amps = new Float32Array(K + 1), phs = new Float32Array(K + 1);
  const ampScale = [0, 0, 0.075, 0.055, 0.04, 0.03, 0.022];
  for (let k = 2; k <= K; k++) {
    amps[k] = (hash2(k, 1, seed + 401) - 0.5) * 2 * ampScale[k];
    phs[k] = hash2(k, 2, seed + 402) * Math.PI * 2;
  }
  const n1 = 9 + Math.floor(hash2(3, 3, seed + 403) * 6), n2 = n1 + 4 + Math.floor(hash2(4, 4, seed + 404) * 5);
  const p1 = hash2(5, 5, seed + 405) * 6.283, p2 = hash2(6, 6, seed + 406) * 6.283;
  const grenade = c.kind === 'grenade';
  const old = c.old;
  const D = grenade ? R * 0.55 : R * (old ? 0.32 : 0.5);
  const Hr = grenade ? 0.015 : R * (old ? 0.09 : 0.19);
  const ejR = grenade ? 1.9 : old ? 2.05 : winter ? 2.7 : 2.3;
  const decay = old ? 4.2 : 3.0;
  const H = f.H, soil = f.soil, scorch = f.scorch, snow = f.snow, mat = f.mat;

  for (let y = 0; y < h; y++) {
    const Y = f.oy + (y + 0.5) / zoom;
    const dym = (Y - c.y) / PX_PER_M;
    for (let x = 0; x < w; x++) {
      const X = f.ox + (x + 0.5) / zoom;
      const dxm = (X - c.x) / PX_PER_M;
      const d = Math.sqrt(dxm * dxm + dym * dym);
      const th = Math.atan2(dym, dxm);
      let wob = 0;
      for (let k = 2; k <= K; k++) wob += amps[k] * Math.cos(k * th + phs[k]);
      const nf = noise2(X / 3.4, Y / 3.4, seed + 407);
      const rr = R * (1 + wob + nf * 0.06);
      const u = d / rr;
      if (u > ejR * 1.45 + 0.4) continue;
      const i = y * w + x;
      let hh: number;
      if (u < 1) {
        const q = 1 - u * u;
        hh = Hr - (Hr + D) * (grenade ? q : Math.pow(q, 1.5));
      } else {
        hh = Hr * Math.exp(-(u - 1) * decay);
      }
      if (!grenade) hh += nf * 0.1 * R * clamp01(2.3 - u);
      let s = old ? smooth(1.4, 0.9, u) : smooth(1.16, 0.98, u);
      if (grenade) {
        const cell = hash2(Math.floor(X * 1.1), Math.floor(Y * 1.1), seed + 408);
        if (u > 0.95 && u < ejR && cell > 0.8 - 0.25 * (ejR - u)) { s = Math.max(s, 0.85); mat[i] = MAT_CLOD; }
        const rag = u + noise2(X / 1.6, Y / 1.6, seed + 409) * 1.1;
        scorch[i] = clamp01((2.35 - rag) / 1.0) * (old ? 0.3 : 0.8);
      } else {
        // ejecta blanket: fades with distance, broken into radial streaks
        const radial = clamp01((ejR - u) / (ejR - 1));
        const ray1 = Math.pow(0.5 + 0.5 * Math.cos(n1 * th + p1 + nf * 3), 4);
        const ray2 = Math.pow(0.5 + 0.5 * Math.cos(n2 * th + p2 - nf * 2), 6);
        const ray = ray1 > ray2 * 0.8 ? ray1 : ray2 * 0.8;
        let ej = Math.pow(radial, 1.3) * (0.62 + 0.38 * ray);
        if (!old) {
          // long thin thrown-earth streaks past the blanket — the winter star-burst
          const reach = ejR * (winter ? 1.45 : 1.25);
          const streak = Math.pow(ray, winter ? 5 : 7) * clamp01((reach - u) / (reach - 1.1));
          if (streak > ej) ej = streak;
        }
        const blot = noise2(X / 1.7, Y / 1.7, seed + 410) + (hash2(Math.floor(X * zoom), Math.floor(Y * zoom), seed + 412) - 0.5) * 0.35;
        ej *= clamp01(0.75 + blot * 1.6 + ej * 0.3);
        ej *= old ? (winter ? 0.5 : 0.95) : 1.0;
        if (ej > s) s = ej;
        // clods: small lumps on the rim and blanket, a few in the pit bottom
        const cell = hash2(Math.floor(X / 1.3), Math.floor(Y / 1.3), seed + 411);
        const clodP = old ? 0.985 : 0.965;
        if ((u > 0.85 && u < ejR * 0.85 && cell > clodP) || (u < 0.45 && cell > 0.95)) {
          mat[i] = MAT_CLOD; hh += 0.05; s = Math.max(s, 0.95);
        }
        if (!old) scorch[i] = Math.pow(clamp01((ejR * 1.2 - u) / (ejR * 0.9)), 1.3) * (winter ? 0.28 : 0.26);
      }
      H[i] = hh;
      soil[i] = s;
      if (winter && old) snow[i] = u < 0.45 ? 0.45 : u < 0.9 ? 0.22 : u < 1.3 ? 0.6 : 0.85;
    }
  }
  return { depthRef: Math.max(0.12, D * (old ? 1.25 : 0.9)), old, seed, puddles: !grenade && c.diameterM >= 2.2 && hash2(seed, 3, 7002) < 0.45 };
}

/** Draws a crater onto `ctx` (whose pixels map to world px via originX/originY and `zoom`,
 * i.e. canvas px = (world - origin) * zoom; any current transform is ignored). */
export function paintCrater(ctx: CanvasRenderingContext2D, c: CraterDraw, season: Season, originX: number, originY: number, zoom: number): void {
  const ext = craterExtentPx(c);
  const px0 = Math.floor((c.x - ext - originX) * zoom), py0 = Math.floor((c.y - ext - originY) * zoom);
  const px1 = Math.ceil((c.x + ext - originX) * zoom), py1 = Math.ceil((c.y + ext - originY) * zoom);
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  if (px1 <= 0 || py1 <= 0 || px0 >= cw || py0 >= ch) return;
  FIELD.reset(px1 - px0, py1 - py0, zoom, originX + px0 / zoom, originY + py0 / zoom);
  const o = fillCrater(FIELD, c, season);
  blit(ctx, FIELD, season, o, px0, py0);
}

// ================================================================== foxholes
export interface FoxholeDraw {
  x: number; y: number;      // centre, zoom-1 world px
  /** direction the position faces (toward the enemy), radians, 0 = +x (east), PI/2 = +y (south) */
  angle: number;
  /** 0 plain spoil, 1 sandbag parapet, 2 log parapet */
  variant: number;
  /** 1- or 2-man hole */
  men: 1 | 2;
  seed: number;
}

export function foxholeExtentPx(): number { return 3.3 * PX_PER_M; }

export function fillFoxhole(f: EarthField, fx: FoxholeDraw, season: Season): ShadeOpts {
  const { w, h, zoom } = f;
  const seed = fx.seed | 0;
  const winter = season === 'winter';
  const fwdX = Math.cos(fx.angle), fwdY = Math.sin(fx.angle);
  const sideX = -fwdY, sideY = fwdX;
  const A = (fx.men === 2 ? 1.08 : 0.72) * (0.9 + hash2(1, 0, seed + 501) * 0.2); // half length along the front
  const B = (fx.men === 2 ? 0.52 : 0.5) * (0.9 + hash2(2, 0, seed + 502) * 0.2);  // half width
  const rr = Math.min(A, B) * (fx.men === 2 ? 0.7 : 0.9);
  const H = f.H, soil = f.soil, snow = f.snow, mat = f.mat;
  const depth = 1.3;
  for (let y = 0; y < h; y++) {
    const Y = f.oy + (y + 0.5) / zoom;
    const dym = (Y - fx.y) / PX_PER_M;
    for (let x = 0; x < w; x++) {
      const X = f.ox + (x + 0.5) / zoom;
      const dxm = (X - fx.x) / PX_PER_M;
      const s = dxm * sideX + dym * sideY;
      const fy = dxm * fwdX + dym * fwdY;
      const qx = Math.abs(s) - (A - rr), qy = Math.abs(fy) - (B - rr);
      const nf = noise2(X / 3.2, Y / 3.2, seed + 503);
      let sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
      sd += nf * 0.2;
      if (sd > 1.9) continue;
      const i = y * w + x;
      if (sd < 0) {
        H[i] = -depth * smooth(0, 0.22, -sd);
        soil[i] = 1;
        if (winter) snow[i] = 0.75;
        continue;
      }
      const frontW = smooth(-B * 0.9, B * 1.1, fy);
      const crest = 0.2 + 0.4 * frontW;
      const width = 0.26 + 0.24 * frontW;
      const t = (sd - crest) / (sd > crest ? width * 1.25 : width);
      const lump = 0.82 + 0.36 * vnoise(s * 2.2 + 9, fy * 2.2 + 9, seed + 505);
      let mound = (0.08 + 0.42 * frontW) * lump * Math.exp(-t * t);
      mound += nf * 0.06 * frontW;
      let hh = mound;
      let sa = clamp01(mound / 0.07);
      // thrown-out spoil specks a little beyond the bank
      if (sd < 0.9) {
        const cell = hash2(Math.floor(X * zoom), Math.floor(Y * zoom), seed + 504);
        if (cell > 0.8 + sd * 0.25) { sa = Math.max(sa, 0.7); mat[i] = MAT_CLOD; }
      }
      // earth trodden and thrown over the surrounding ground: a soft brown fade outward
      const halo = Math.exp(-Math.max(0, sd - crest) / (winter ? 0.4 : 0.28)) * (winter ? 0.42 : 0.25) * clamp01(0.7 + nf * 1.6);
      if (halo > sa) sa = halo;
      const taper = smooth(1.85, 1.2, sd);
      sa *= taper; hh *= taper;
      if (fx.variant === 1 && frontW > 0.45 && sd > 0.03 && sd < 0.64 && Math.abs(s) < A + 0.3) {
        // two staggered rows of sandbags on the parapet
        const rowF = (sd - 0.03) / 0.305;
        const row = Math.floor(rowF);
        const along = (s + row * 0.2 + 10) / 0.4;
        const bx = Math.sin(Math.PI * (along - Math.floor(along)));
        const by = Math.sin(Math.PI * (rowF - row));
        const bag = Math.sqrt(Math.max(0, bx)) * Math.sqrt(Math.max(0, by));
        hh = Math.max(hh, 0.16 + 0.22 * bag - row * 0.06);
        mat[i] = bag > 0.32 ? MAT_SANDBAG : MAT_SEAM;
        sa = 1;
      } else if (fx.variant === 2 && frontW > 0.5 && sd > 0.02 && sd < 0.42 && Math.abs(s) < A + 0.45) {
        const cross = (sd - 0.22) / 0.2;
        hh = Math.max(hh, 0.1 + 0.26 * Math.sqrt(Math.max(0, 1 - cross * cross)));
        mat[i] = Math.abs(cross) > 0.86 ? MAT_SEAM : MAT_LOG;
        sa = 1;
      }
      H[i] = hh;
      soil[i] = sa;
      if (winter) snow[i] = 0.36;
    }
  }
  return { depthRef: depth * 0.75, old: false, seed, puddles: false };
}

export function paintFoxhole(ctx: CanvasRenderingContext2D, fx: FoxholeDraw, season: Season, originX: number, originY: number, zoom: number): void {
  const ext = foxholeExtentPx();
  const px0 = Math.floor((fx.x - ext - originX) * zoom), py0 = Math.floor((fx.y - ext - originY) * zoom);
  const px1 = Math.ceil((fx.x + ext - originX) * zoom), py1 = Math.ceil((fx.y + ext - originY) * zoom);
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  if (px1 <= 0 || py1 <= 0 || px0 >= cw || py0 >= ch) return;
  FIELD.reset(px1 - px0, py1 - py0, zoom, originX + px0 / zoom, originY + py0 / zoom);
  const o = fillFoxhole(FIELD, fx, season);
  blit(ctx, FIELD, season, o, px0, py0);
}

// ================================================================== trenches
export interface TrenchDraw {
  /** crenellated centreline, zoom-1 world px */
  pts: Vec2[];
  /** per segment: unit normal pointing to the FRONT (enemy side) */
  front: Vec2[];
  /** cumulative along-length (m) at each point */
  along: number[];
  boards: boolean;
  seed: number;
  minX: number; minY: number; maxX: number; maxY: number;
}

const TRENCH_REACH_M = 1.7;

/** Turns a map trench polyline (tile coords) into a crenellated centreline in world px: fire
 * bays ~3-4 m long, alternately stepped ~0.45 m to either side with short traverse jogs, so the
 * trench reads as a dug zig-zag rather than a ruler line. `toward` (world px) picks the front. */
export function buildTrenchDraw(points: Vec2[], tilePx: number, toward: Vec2, seed: number): TrenchDraw {
  const src = points.map((p) => ({ x: p.x * tilePx, y: p.y * tilePx }));
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < src.length - 1; i++) { const l = Math.hypot(src[i + 1].x - src[i].x, src[i + 1].y - src[i].y); segLen.push(l); total += l; }
  const at = (dist: number): { p: Vec2; nx: number; ny: number } => {
    let dd = Math.max(0, Math.min(total, dist));
    for (let i = 0; i < segLen.length; i++) {
      if (dd <= segLen[i] || i === segLen.length - 1) {
        const a = src[i], b = src[i + 1];
        const L = segLen[i] || 1;
        const t = Math.min(1, dd / L);
        const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
        return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, nx: -uy, ny: ux };
      }
      dd -= segLen[i];
    }
    return { p: src[0], nx: 0, ny: 1 };
  };
  const pts: Vec2[] = [];
  const offPx = 0.32 * PX_PER_M;
  const jog = 1.3 * PX_PER_M;
  let d = 0, bay = 0;
  while (d < total) {
    const len = (3.6 + hash2(bay, 7, seed + 601) * 2.4) * PX_PER_M;
    const off = (bay % 2 === 0 ? 1 : -1) * offPx * (0.55 + hash2(bay, 8, seed + 602) * 0.7);
    const s0 = d, s1 = Math.min(total, d + len);
    const a = at(s0 === 0 ? 0 : s0 + jog * 0.5), b = at(Math.max(s0, s1 - jog * 0.5));
    pts.push({ x: a.p.x + a.nx * off, y: a.p.y + a.ny * off });
    pts.push({ x: b.p.x + b.nx * off, y: b.p.y + b.ny * off });
    d = s1; bay++;
  }
  const front: Vec2[] = [];
  const along: number[] = [0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    if (i === pts.length - 1) break;
    const q = pts[i + 1];
    const L = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    along.push(along[i] + L / PX_PER_M);
    // front normal from the ORIGINAL segment direction at this point, so the traverses don't flip it
    const base = at(Math.min(total, (i / Math.max(1, pts.length - 1)) * total));
    let nx = base.nx, ny = base.ny;
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    if ((toward.x - mx) * nx + (toward.y - my) * ny < 0) { nx = -nx; ny = -ny; }
    front.push({ x: nx, y: ny });
  }
  const pad = TRENCH_REACH_M * PX_PER_M + 2;
  return { pts, front, along, boards: hash2(1, 1, seed + 603) < 0.5, seed, minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** Fills FIELD for every trench overlapping it (distance field to the crenellated centreline). */
export function fillTrenches(f: EarthField, trenches: TrenchDraw[], season: Season): ShadeOpts {
  const { w, h, zoom } = f;
  const winter = season === 'winter';
  const n = w * h;
  const Dist = f.aux, Along = f.aux2, Side = f.aux3;
  Dist.fill(1e9, 0, n);
  const reachPx = TRENCH_REACH_M * PX_PER_M;
  const fx1 = f.ox + w / zoom, fy1 = f.oy + h / zoom;
  let boardsSeed = 0;
  for (const tr of trenches) {
    if (tr.maxX < f.ox || tr.minX > fx1 || tr.maxY < f.oy || tr.minY > fy1) continue;
    boardsSeed = tr.seed;
    for (let s = 0; s < tr.pts.length - 1; s++) {
      const a = tr.pts[s], b = tr.pts[s + 1];
      const sx0 = Math.min(a.x, b.x) - reachPx, sx1 = Math.max(a.x, b.x) + reachPx;
      const sy0 = Math.min(a.y, b.y) - reachPx, sy1 = Math.max(a.y, b.y) + reachPx;
      if (sx1 < f.ox || sx0 > fx1 || sy1 < f.oy || sy0 > fy1) continue;
      const ix0 = Math.max(0, Math.floor((sx0 - f.ox) * zoom)), ix1 = Math.min(w - 1, Math.ceil((sx1 - f.ox) * zoom));
      const iy0 = Math.max(0, Math.floor((sy0 - f.oy) * zoom)), iy1 = Math.min(h - 1, Math.ceil((sy1 - f.oy) * zoom));
      const abx = b.x - a.x, aby = b.y - a.y;
      const L2 = abx * abx + aby * aby || 1;
      const L = Math.sqrt(L2);
      const fr = tr.front[s];
      const boardFlag = tr.boards ? 2 : 1;
      for (let iy = iy0; iy <= iy1; iy++) {
        const Y = f.oy + (iy + 0.5) / zoom;
        for (let ix = ix0; ix <= ix1; ix++) {
          const X = f.ox + (ix + 0.5) / zoom;
          let t = ((X - a.x) * abx + (Y - a.y) * aby) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = a.x + abx * t, cy = a.y + aby * t;
          const dx = X - cx, dy = Y - cy;
          const dd = dx * dx + dy * dy;
          const i = iy * w + ix;
          if (dd < Dist[i]) {
            Dist[i] = dd;
            Along[i] = tr.along[s] + (t * L) / PX_PER_M;
            Side[i] = (dx * fr.x + dy * fr.y >= 0 ? 1 : -1) * boardFlag;
          }
        }
      }
    }
  }
  const H = f.H, soil = f.soil, snow = f.snow, mat = f.mat;
  const seed = boardsSeed;
  const halfW = 0.55, depth = 1.6;
  const reach2 = reachPx * reachPx;
  for (let i = 0; i < n; i++) {
    if (Dist[i] > reach2) continue;
    const x = i % w, y = (i / w) | 0;
    const X = f.ox + (x + 0.5) / zoom, Y = f.oy + (y + 0.5) / zoom;
    const nf = noise2(X / 2.4, Y / 2.4, 611);
    const d = Math.sqrt(Dist[i]) / PX_PER_M + nf * 0.13;
    // Side encodes (front ? +1 : -1) * (duckboards ? 2 : 1)
    const sideRaw = Side[i];
    const front = sideRaw > 0;
    const hasBoards = sideRaw > 1.5 || sideRaw < -1.5;
    if (d < halfW) {
      H[i] = -depth * smooth(0, 0.2, halfW - d);
      soil[i] = 1;
      if (hasBoards && d < 0.24 && vnoise(Along[i] / 5, 3.5, seed + 614) > 0.5) {
        // duckboards along some stretches of the floor: slats only resolve at zoom 2
        if (zoom >= 2) {
          const a = Along[i] / 0.42;
          mat[i] = a - Math.floor(a) < 0.74 ? MAT_BOARD : MAT_SEAM;
        } else mat[i] = MAT_BOARD;
      } else if (winter) snow[i] = 0.32;
      continue;
    }
    const e = d - halfW;
    let mound: number;
    const lump = 0.7 + 0.6 * vnoise(X / 7, Y / 7, 613);
    if (front) { const t = (e - 0.55) / (e > 0.55 ? 0.75 : 0.45); mound = 0.42 * lump * Math.exp(-t * t); }
    else { const t = (e - 0.3) / (e > 0.3 ? 0.45 : 0.26); mound = 0.14 * lump * Math.exp(-t * t); }
    mound += nf * 0.06 * (front ? 1 : 0.4);
    let sa = clamp01(mound / 0.07);
    if (e < (front ? 1.1 : 0.7)) {
      const cell = hash2(Math.floor(X * zoom), Math.floor(Y * zoom), seed + 612);
      if (cell > 0.84 + e * 0.2) { sa = Math.max(sa, 0.7); mat[i] = MAT_CLOD; }
    }
    H[i] = mound;
    soil[i] = sa;
    if (winter) snow[i] = front ? 0.56 : 0.62;
  }
  return { depthRef: depth * 1.15, old: false, seed: seed + 7, puddles: false };
}

/** Paints all trenches overlapping the rectangle [originX, originX + w/zoom) x ... of `ctx`,
 * padded so shadows and banks crossing the canvas edge match the neighbouring chunk. */
export function paintTrenches(ctx: CanvasRenderingContext2D, trenches: TrenchDraw[], season: Season, originX: number, originY: number, zoom: number): void {
  if (!trenches.length) return;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const viewX1 = originX + cw / zoom, viewY1 = originY + ch / zoom;
  // union bbox of trenches overlapping the view, clipped to the view padded by the reach
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pad = TRENCH_REACH_M * PX_PER_M + 4;
  for (const tr of trenches) {
    if (tr.maxX < originX - pad || tr.minX > viewX1 + pad || tr.maxY < originY - pad || tr.minY > viewY1 + pad) continue;
    x0 = Math.min(x0, tr.minX); y0 = Math.min(y0, tr.minY); x1 = Math.max(x1, tr.maxX); y1 = Math.max(y1, tr.maxY);
  }
  if (x0 === Infinity) return;
  x0 = Math.max(x0, originX - pad); y0 = Math.max(y0, originY - pad);
  x1 = Math.min(x1, viewX1 + 2); y1 = Math.min(y1, viewY1 + 2);
  if (x1 <= x0 || y1 <= y0) return;
  const px0 = Math.floor((x0 - originX) * zoom), py0 = Math.floor((y0 - originY) * zoom);
  const px1 = Math.ceil((x1 - originX) * zoom), py1 = Math.ceil((y1 - originY) * zoom);
  FIELD.reset(px1 - px0, py1 - py0, zoom, originX + px0 / zoom, originY + py0 / zoom);
  const o = fillTrenches(FIELD, trenches, season);
  blit(ctx, FIELD, season, o, px0, py0);
}

// ============================================================ sizing helpers
/** Rim diameter (m) for a map-placed shell hole / crater tile, varied by hash. */
export function oldCraterDiameter(seed: number, minM: number, maxM: number): number {
  return minM + hash2(seed, 17, 7001) * (maxM - minM);
}
