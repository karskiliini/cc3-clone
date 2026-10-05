/**
 * Deterministic math for the sim (backlog 045, multiplayer plan §2 D5).
 *
 * ECMAScript leaves Math.sin/cos/atan2/exp/log... "implementation-approximated", and engines do
 * differ in the last bit (Node 26 vs Chromium 151 measured in 043), which lockstep play and
 * cross-engine replays cannot tolerate. These are ports of the FreeBSD msun / Sun fdlibm routines
 * built from IEEE + - * / and sqrt only, which every engine computes exactly, so every engine gets
 * the same bits. Accuracy is fdlibm's (< 1 ulp).
 *
 * The sim (src/sim, and the sim-side helpers in src/shared) must use these instead of Math.*;
 * test/dmath.test.ts bans the Math transcendentals under src/sim.
 */

// ------------------------------------------------------------------ IEEE word access
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
/** Index of the high word: 1 on little-endian hosts (every platform a browser runs on today). */
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LO = 1 - HI;

function highWord(x: number): number {
  F64[0] = x;
  return U32[HI] | 0;
}
function lowWord(x: number): number {
  F64[0] = x;
  return U32[LO];
}
function fromWords(hi: number, lo: number): number {
  U32[HI] = hi >>> 0;
  U32[LO] = lo >>> 0;
  return F64[0];
}

// ------------------------------------------------------------------ sin / cos kernels
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

/** sin on [-pi/4, pi/4]; y is the tail of x, iy = 0 when y is known to be 0. */
function kernelSin(x: number, y: number, iy: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

/** cos on [-pi/4, pi/4]. */
function kernelCos(x: number, y: number): number {
  const z = x * x;
  let w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  w = 1.0 - hz;
  return w + (((1.0 - w) - hz) + (z * r - x * y));
}

// ------------------------------------------------------------------ argument reduction
const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;
const TWO_PI = 6.283185307179586;

/** y0 + y1 = x - n·pi/2 (Cody-Waite, fdlibm's medium path); returns n. */
let remY0 = 0;
let remY1 = 0;
function remPio2(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix > 0x413921fb) {
    // |x| > 2^20·pi/2: the sim never gets here; fold exactly into one turn first (% is exact
    // in IEEE arithmetic) so the result stays deterministic, if less accurate than fdlibm's
    // Payne-Hanek path.
    return remPio2(x % TWO_PI);
  }
  const n = Math.round(x * INV_PIO2) | 0; // Math.round is exact
  const fn = n;
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T;
  let y0 = r - w;
  const j = ix >> 20;
  let i = j - ((highWord(y0) >> 20) & 0x7ff);
  if (i > 16) {
    // second iteration, good to 118 bits
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - ((t - r) - w);
    y0 = r - w;
    i = j - ((highWord(y0) >> 20) & 0x7ff);
    if (i > 49) {
      // third iteration, 151 bits
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - ((t - r) - w);
      y0 = r - w;
    }
  }
  remY0 = y0;
  remY1 = (r - y0) - w;
  return n;
}

// ------------------------------------------------------------------ sin / cos
export function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e500000) return x; // |x| < 2^-26: sin x = x (inexact)
    return kernelSin(x, 0, 0);
  }
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelSin(remY0, remY1, 1);
    case 1: return kernelCos(remY0, remY1);
    case 2: return -kernelSin(remY0, remY1, 1);
    default: return -kernelCos(remY0, remY1);
  }
}

export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e46a09e) return 1.0; // |x| < 2^-27·sqrt(2)
    return kernelCos(x, 0);
  }
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelCos(remY0, remY1);
    case 1: return -kernelSin(remY0, remY1, 1);
    case 2: return -kernelCos(remY0, remY1);
    default: return kernelSin(remY0, remY1, 1);
  }
}

// ------------------------------------------------------------------ atan / atan2
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
  -3.65315727442169155270e-02, 1.62858201153657823623e-02,
];

export function atan(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x44100000) {
    // |x| >= 2^66
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lowWord(x) !== 0)) return x + x; // NaN
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  let id: number;
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); } // 7/16 <= |x| < 11/16
      else { id = 1; x = (x - 1.0) / (x + 1.0); } // 11/16 <= |x| < 19/16
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); } // |x| < 2.4375
    else { id = 3; x = -1.0 / x; } // 2.4375 <= |x| < 2^66
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return hx < 0 ? -r : r;
}

const PI = 3.1415926535897931160e+00;
const PI_LO = 1.2246467991473531772e-16;
const PI_O_2 = 1.5707963267948965580e+00;
const PI_O_4 = 7.8539816339744827900e-01;

export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return x + y; // NaN
  const hx = highWord(x), lx = lowWord(x);
  const hy = highWord(y), ly = lowWord(y);
  const ix = hx & 0x7fffffff, iy = hy & 0x7fffffff;
  if (hx === 0x3ff00000 && lx === 0) return atan(y); // x = 1
  const m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2); // 2·sign(x) + sign(y)
  if ((iy | ly) === 0) {
    // y = ±0
    switch (m) {
      case 0: case 1: return y; // atan(±0, +anything) = ±0
      case 2: return PI; // atan(+0, -anything) = pi
      default: return -PI; // atan(-0, -anything) = -pi
    }
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 : PI_O_2; // x = 0
  if (ix === 0x7ff00000) {
    // x = ±inf
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0: return PI_O_4;
        case 1: return -PI_O_4;
        case 2: return 3.0 * PI_O_4;
        default: return -3.0 * PI_O_4;
      }
    }
    switch (m) {
      case 0: return 0.0;
      case 1: return -0.0;
      case 2: return PI;
      default: return -PI;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 : PI_O_2; // y = ±inf
  // compute y/x
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) { z = PI_O_2 + 0.5 * PI_LO; } // |y/x| > 2^60
  else if (hx < 0 && k < -60) z = 0.0; // |y|/x < -2^60
  else z = atan(Math.abs(y / x));
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

// ------------------------------------------------------------------ exp
const LN2_HI = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
const LN2_LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const INV_LN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01;
const P2 = -2.77777777770155933842e-03;
const P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06;
const P5 = 4.13813679705723846039e-08;
const O_THRESHOLD = 7.09782712893383973096e+02;
const U_THRESHOLD = -7.45133219101941108420e+02;
const TWOM1000 = 9.33263618503218878990e-302; // 2^-1000

export function exp(x: number): number {
  const hx = highWord(x);
  const xsb = (hx >>> 31) & 1;
  const ax = hx & 0x7fffffff;
  let hi = 0, lo = 0, k = 0;
  if (ax >= 0x40862e42) {
    // |x| >= 709.78
    if (ax >= 0x7ff00000) {
      if (((ax & 0xfffff) | lowWord(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0.0; // exp(±inf) = inf / 0
    }
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0;
  }
  if (ax > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (ax < 0x3ff0a2b2) {
      // |x| < 1.5 ln2
      hi = x - LN2_HI[xsb];
      lo = LN2_LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5));
      const t = k;
      hi = x - t * LN2_HI[0];
      lo = t * LN2_LO[0];
    }
    x = hi - lo;
  } else if (ax < 0x3e300000) {
    // |x| < 2^-28
    return 1.0 + x;
  } else {
    k = 0;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
  const y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
  // scale by 2^k through the exponent field
  if (k >= -1021) return fromWords(highWord(y) + (k << 20), lowWord(y));
  return fromWords(highWord(y) + ((k + 1000) << 20), lowWord(y)) * TWOM1000;
}

// ------------------------------------------------------------------ log
const LG1 = 6.666666666666735130e-01;
const LG2 = 3.999999999940941908e-01;
const LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01;
const LG5 = 1.818357216161805012e-01;
const LG6 = 1.531383769920937332e-01;
const LG7 = 1.479819860511658591e-01;
const TWO54 = 1.80143985094819840000e+16;

export function log(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    // x < 2^-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity; // log(±0)
    if (hx < 0) return NaN; // log(-#)
    k -= 54;
    x *= TWO54; // subnormal: scale up
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  x = fromWords(hx | (i ^ 0x3ff00000), lowWord(x)); // normalize x or x/2
  k += i >> 20;
  const f = x - 1.0;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    // -2^-20 <= f < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI[0] + dk * LN2_LO[0];
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    return dk * LN2_HI[0] - ((R - dk * LN2_LO[0]) - f);
  }
  const s = f / (2.0 + f);
  const z = s * s;
  let ii = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  ii |= j;
  const R = t2 + t1;
  if (ii > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI[0] - ((hfsq - (s * (hfsq + R) + dk * LN2_LO[0])) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI[0] - ((s * (f - R) - dk * LN2_LO[0]) - f);
}

// ------------------------------------------------------------------ pow / hypot
/** x^y: exact repeated squaring for integer exponents (what the sim uses), exp(y·log x) otherwise. */
export function pow(x: number, y: number): number {
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    let n = Math.abs(y);
    let base = x;
    let r = 1;
    while (n > 0) {
      if (n & 1) r *= base;
      base *= base;
      n >>= 1;
    }
    return y < 0 ? 1 / r : r;
  }
  if (y === 0) return 1;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN; // non-integer power of a negative number
  return exp(y * log(x));
}

/** sqrt(x² + y²) — sqrt is exactly rounded in IEEE, so this is the same everywhere. Map-scale
 * arguments never come near overflow. */
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
