// ============================================================================
// vehicleArt.ts — hand-authored pixel-art grids for vehicle hulls and
// turrets, at 10 px/metre (matches TILE_PX/TILE_M). Replaces the old flat
// parametric slab-and-ring rendering with bold, readable silhouettes: dark
// contrasting track runs with wheels, a lit/shadowed hull deck with
// hatches/grilles, a thick gun barrel with a highlighted top edge, NW
// lighting and a soft SE cast shadow.
//
// Method: each vehicle is assigned one of 6 hull "families" and (if turreted)
// one of 5 turret "archetypes". Each family/archetype is built as a 2D grid
// of characters (a Grid, i.e. string[][]) by a dedicated builder function —
// this *is* the hand-authored pixel art: every character placed is a
// deliberate pixel (track, wheel, hull plate, hatch, grille, barrel, marking,
// shadow), just placed by parametrised helper code instead of literal string
// literals, so the same silhouette scales correctly across the 16 vehicles'
// differing lengthM/widthM without redrawing every rivet by hand 16 times.
// Grids are authored at a generous canonical resolution then resampled with
// nearest-neighbour to each vehicle's exact lengthM x widthM * 10 px/m
// footprint, exactly as the brief's own "tractable" method prescribes for
// the German boxy family.
// ============================================================================
import { createCanvas, ctx2d, darken } from '@/render/pixelUtil';
import type { Side } from '@/shared/types';

export const VEH_PX_PER_M = 10;

// ---------------------------------------------------------------- grid ----
type Grid = string[][];

function blank(w: number, h: number, fill = '.'): Grid {
  return Array.from({ length: h }, () => Array<string>(w).fill(fill));
}
function put(g: Grid, x: number, y: number, ch: string): void {
  if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = ch;
}
function fillRect(g: Grid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  const h = g.length, w = g[0].length;
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) g[y][x] = ch;
  }
}
function strokeRect(g: Grid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let x = x0; x <= x1; x++) { put(g, x, y0, ch); put(g, x, y1, ch); }
  for (let y = y0; y <= y1; y++) { put(g, x0, y, ch); put(g, x1, y, ch); }
}
function rowsOf(g: Grid): string[] { return g.map((r) => r.join('')); }

/** Nearest-neighbour resample of a character grid to an exact target size
 * (independent horizontal/vertical factors, so non-square scaling — e.g. a
 * longer, narrower hull — comes out proportioned to the real vehicle). */
function resize(g: Grid, tw: number, th: number): Grid {
  const sh = g.length, sw = g[0].length;
  const out = blank(tw, th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / tw));
      out[y][x] = g[sy][sx];
    }
  }
  return out;
}

/** Mark the outer boundary of a filled shape ('.'-is-empty) as outline 'o',
 * without disturbing interior shading — used for turret bodies so a rounded
 * casting or slab reads with a crisp silhouette edge. */
function outlineFill(g: Grid): void {
  const h = g.length, w = g[0].length;
  const orig = g.map((r) => r.slice());
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && orig[y][x] !== '.';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1)) g[y][x] = 'o';
    }
  }
}

/** Diagonal olive camouflage bands (late-war German dunkelgelb) painted onto
 * hull-tone cells only — tracks, outline, hatches and markings stay put. */
function applyCamoBands(g: Grid): void {
  const h = g.length, w = g[0].length;
  const hullTone = new Set(['h', 'H', 'd']);
  const bandWidth = Math.max(2, Math.round(w * 0.22));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hullTone.has(g[y][x])) continue;
      const d1 = x * 1.4 - y + h * 0.05;
      const d2 = x * 1.4 - y - h * 0.55;
      if (Math.abs(d1) < bandWidth * 0.5 || Math.abs(d2) < bandWidth * 0.5) g[y][x] = 'a';
    }
  }
}

/** Stamp a small fixed-pixel-size marking (5x5) into a grid at a normalised
 * (0..1, 0..1) position, regardless of the vehicle's final scaled size, so
 * crosses/stars read crisply instead of stretching with the hull. */
function stampMarking(g: Grid, nx: number, ny: number, kind: 'cross' | 'star'): void {
  const h = g.length, w = g[0].length;
  const cx = Math.round(nx * w), cy = Math.round(ny * h);
  if (kind === 'cross') {
    strokeRect(g, cx - 2, cy - 2, cx + 2, cy + 2, 'm');
    fillRect(g, cx - 1, cy - 1, cx + 1, cy + 1, 'c');
    put(g, cx, cy - 2, 'c'); put(g, cx, cy + 2, 'c');
    put(g, cx - 2, cy, 'c'); put(g, cx + 2, cy, 'c');
  } else {
    strokeRect(g, cx - 2, cy - 2, cx + 2, cy + 2, 'm');
    fillRect(g, cx - 1, cy - 1, cx + 1, cy + 1, 'r');
    put(g, cx, cy - 2, 'r'); put(g, cx, cy + 2, 'r');
  }
}

// -------------------------------------------------------------- palette ---
export interface VehPalette {
  hullMid: string; hullLight: string; hullDark: string;
  camoBand?: string;
}
const EARLY_GERMAN_PALETTE: VehPalette = { hullMid: '#5e6066', hullLight: '#7c7e84', hullDark: '#3f4147' };
const LATE_GERMAN_PALETTE: VehPalette = { hullMid: '#a9956a', hullLight: '#c4b184', hullDark: '#7d6d48', camoBand: '#6f7a4d' };
const SOVIET_PALETTE: VehPalette = { hullMid: '#5d6a3f', hullLight: '#7a8858', hullDark: '#3f4a2a' };

const OUTLINE = '#1a1a14';
const TRACK_DARK = '#252420';
const TRACK_LIGHT = '#413f38';
const WHEEL = '#67655a';
const GRILLE = '#201f1c';
const HATCH = '#d8d2b8';
const MARK_WHITE = '#eceae0';
const MARK_BLACK = '#100f0c';
const MARK_RED = '#c8402c';
const SOOT = 'rgba(8,7,6,0.55)';

function colorMapFor(pal: VehPalette): Record<string, string> {
  return {
    o: OUTLINE, t: TRACK_DARK, T: TRACK_LIGHT, w: WHEEL, W: pal.hullLight,
    h: pal.hullMid, H: pal.hullLight, d: pal.hullDark, g: GRILLE, x: HATCH,
    b: pal.hullDark, B: pal.hullLight, k: OUTLINE,
    m: MARK_WHITE, c: MARK_BLACK, r: MARK_RED,
    a: pal.camoBand ?? pal.hullDark,
    s: 'rgba(6,6,4,0.35)',
  };
}

// ---------------------------------------------------------- hull families -
type HullFamily = 'boxy' | 'sloped' | 'slab' | 'light' | 'casemate' | 'halftrack';

/** Shared tracked-hull skeleton (tracks + wheels + hull deck with NW/SE
 * shading, glacis plate, driver hatch, rear grille/exhaust hatch) used by
 * the boxy, sloped, slab and light families — they differ only in nose
 * taper and proportions. */
function buildTrackedSkeleton(w: number, h: number, opts: { wide?: boolean; taper?: number; light?: boolean }): Grid {
  const g = blank(w, h);
  const trackW = Math.max(2, Math.round(w * (opts.wide ? 0.3 : 0.24)));
  for (let y = 0; y < h; y++) {
    const tread = Math.floor(y / 2) % 2 === 0 ? 't' : 'T';
    for (let x = 0; x < trackW; x++) { g[y][x] = tread; g[y][w - 1 - x] = tread; }
  }
  const wheelCount = opts.light ? 4 : Math.max(5, Math.min(8, Math.round(h / (opts.wide ? 7 : 5.5))));
  for (let i = 0; i < wheelCount; i++) {
    const cy = Math.round((i + 0.5) * (h / wheelCount));
    put(g, Math.floor(trackW / 2), cy, 'w');
    put(g, w - 1 - Math.floor(trackW / 2), cy, 'w');
  }
  const bx0 = trackW, bx1 = w - 1 - trackW;
  const bw = Math.max(1, bx1 - bx0);
  for (let y = 0; y < h; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const t = ((x - bx0) / bw) * 0.45 + (y / h) * 0.55;
      g[y][x] = t < 0.32 ? 'H' : t > 0.68 ? 'd' : 'h';
    }
  }
  const glacisH = Math.max(1, Math.round(h * (opts.light ? 0.14 : 0.18)));
  if (opts.taper) {
    const taper = Math.max(1, Math.round(bw * opts.taper));
    for (let y = 0; y < glacisH; y++) {
      const cut = Math.round(taper * (1 - y / glacisH));
      for (let x = bx0; x < bx0 + cut; x++) g[y][x] = '.';
      for (let x = bx1 - cut + 1; x <= bx1; x++) g[y][x] = '.';
    }
  }
  fillRect(g, bx0, 0, bx1, glacisH - 1, 'H');
  put(g, bx0 + 2, glacisH - 1, 'x');
  put(g, bx1 - 2, glacisH - 1, 'x');
  const midX = Math.floor((bx0 + bx1) / 2);
  fillRect(g, midX - 1, glacisH + 3, midX + 1, glacisH + 4, 'x');
  const deckY0 = h - Math.max(3, Math.round(h * 0.14));
  for (let y = deckY0; y < h - 1; y += 2) fillRect(g, bx0 + 2, y, bx1 - 2, y, 'g');
  fillRect(g, midX - 2, h - 3, midX + 2, h - 2, 'x');
  for (let x = 0; x < w; x++) { g[0][x] = 'o'; g[h - 1][x] = 'o'; }
  for (let y = 0; y < h; y++) { g[y][0] = 'o'; g[y][w - 1] = 'o'; }
  return g;
}

function buildBoxyHull(w: number, h: number, wide: boolean): Grid {
  return buildTrackedSkeleton(w, h, { wide });
}
function buildSlopedHull(w: number, h: number): Grid {
  return buildTrackedSkeleton(w, h, { taper: 0.32 });
}
function buildSlabHull(w: number, h: number): Grid {
  const g = buildTrackedSkeleton(w, h, { wide: true, taper: 0.08 });
  // Slab-sided KV-1: bolt-on fuel drums at the rear flanks.
  const w2 = g[0].length;
  fillRect(g, Math.round(w2 * 0.24), h - Math.round(h * 0.2), Math.round(w2 * 0.24) + 1, h - Math.round(h * 0.14), 'H');
  fillRect(g, Math.round(w2 * 0.7), h - Math.round(h * 0.2), Math.round(w2 * 0.7) + 1, h - Math.round(h * 0.14), 'H');
  return g;
}
function buildLightHull(w: number, h: number): Grid {
  return buildTrackedSkeleton(w, h, { light: true, taper: 0.14 });
}

/** Half-track: wheeled tapered nose, tracked rear two-thirds, open troop bay
 * (never a turret ring — must never read as a tank). */
function buildHalftrackHull(w: number, h: number): Grid {
  const g = blank(w, h);
  const noseH = Math.round(h * 0.2);
  const bx0 = Math.round(w * 0.12), bx1 = w - 1 - Math.round(w * 0.12);
  const half = Math.round((bx1 - bx0) / 2);
  for (let y = 0; y < noseH; y++) {
    const cut = Math.round(half * (1 - y / noseH));
    for (let x = bx0 + cut; x <= bx1 - cut; x++) g[y][x] = 'd';
  }
  put(g, bx0 + Math.round(half * 0.15), noseH - 1, 'w');
  put(g, bx1 - Math.round(half * 0.15), noseH - 1, 'w');
  const bayY0 = noseH + 1, bayY1 = h - Math.max(2, Math.round(h * 0.14));
  fillRect(g, bx0, bayY0, bx1, bayY1, 'H');
  strokeRect(g, bx0, bayY0, bx1, bayY1, 'o');
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 3; i++) {
      const x = Math.round(bx0 + (bx1 - bx0) * (0.2 + i * 0.3));
      const y = Math.round(bayY0 + (bayY1 - bayY0) * (0.32 + row * 0.4));
      put(g, x, y, 'x');
    }
  }
  const trackW = Math.max(2, Math.round(w * 0.2));
  for (let y = noseH; y < h; y++) {
    const tread = Math.floor(y / 2) % 2 === 0 ? 't' : 'T';
    for (let x = 0; x < trackW; x++) { g[y][x] = tread; g[y][w - 1 - x] = tread; }
  }
  for (let y = h - 4; y < h - 1; y += 2) fillRect(g, bx0 + 2, y, bx1 - 2, y, 'g');
  for (let x = 0; x < w; x++) { if (g[h - 1][x] !== '.') g[h - 1][x] = 'o'; }
  for (let y = 0; y < h; y++) {
    if (g[y][0] !== '.') g[y][0] = 'o';
    if (g[y][w - 1] !== '.') g[y][w - 1] = 'o';
  }
  return g;
}

/** Casemate: low fixed superstructure with the main gun mounted directly in
 * the hull (no separate turret sprite is ever drawn for these defIds). The
 * barrel is prepended as extra rows above the footprint so it visibly
 * overhangs the nose, matching the reference's StuG/Marder silhouettes. */
function buildCasemateHull(
  w: number, h: number, barrelLenPx: number, barrelWpx: number,
  opts: { muzzleBrake?: boolean; taper?: number } = {},
): Grid {
  const body = buildTrackedSkeleton(w, h, { taper: opts.taper });
  const boxH = Math.round(h * 0.46);
  const bx0 = Math.round(w * 0.16), bx1 = w - 1 - Math.round(w * 0.16);
  fillRect(body, bx0, 1, bx1, boxH, 'H');
  strokeRect(body, bx0, 1, bx1, boxH, 'o');
  const midX = Math.floor((bx0 + bx1) / 2);
  fillRect(body, midX - 1, 3, midX + 1, 4, 'x');
  const barrel = blank(w, barrelLenPx);
  const half = Math.max(1, Math.floor(barrelWpx / 2));
  for (let y = 0; y < barrelLenPx; y++) {
    for (let dx = -half; dx <= half; dx++) barrel[y][midX + dx] = dx === -half ? 'B' : 'b';
  }
  if (opts.muzzleBrake) {
    for (let y = 0; y < Math.min(2, barrelLenPx); y++) {
      for (let dx = -half - 1; dx <= half + 1; dx++) barrel[y][midX + dx] = 'k';
    }
  }
  return [...barrel, ...body];
}

// -------------------------------------------------------- turret archetypes
interface TurretOpts {
  square?: boolean;
  cupola?: boolean;
  mantletWpx?: number;
  bustleHpx?: number;
  muzzleBrake?: boolean;
}

function buildTurretGrid(tw: number, bodyH: number, barrelLenPx: number, barrelWpx: number, opts: TurretOpts): Grid {
  const bustle = opts.bustleHpx ?? 0;
  const totalBodyH = bodyH + bustle;
  const th = barrelLenPx + totalBodyH;
  const g = blank(tw, th);
  const cx = tw / 2;
  for (let y = 0; y < bodyH; y++) {
    for (let x = 0; x < tw; x++) {
      const nx = (x + 0.5 - cx) / (tw / 2);
      const ny = (y + 0.5) / bodyH;
      const shapeVal = opts.square
        ? Math.max(Math.abs(nx), Math.abs(ny * 2 - 1))
        : Math.sqrt(nx * nx + Math.pow(ny * 2 - 1, 2));
      if (shapeVal > 1.0) continue;
      const t = ((nx + 1) / 2) * 0.5 + ny * 0.5;
      g[barrelLenPx + y][x] = t < 0.32 ? 'H' : t > 0.68 ? 'd' : 'h';
    }
  }
  if (bustle > 0) {
    const bw = Math.round(tw * 0.72);
    const bx0 = Math.floor((tw - bw) / 2), bx1 = bx0 + bw - 1;
    for (let y = 0; y < bustle; y++) {
      const t = 0.5 + (y / bustle) * 0.3;
      fillRect(g, bx0, barrelLenPx + bodyH + y, bx1, barrelLenPx + bodyH + y, t < 0.5 ? 'h' : 'd');
    }
  }
  outlineFill(g);
  // Barrel, extending "north" off the top of the turret body.
  const bcx = Math.floor(cx);
  const half = Math.max(1, Math.floor(barrelWpx / 2));
  for (let y = 0; y < barrelLenPx; y++) {
    for (let dx = -half; dx <= half; dx++) g[y][bcx + dx] = dx === -half ? 'B' : 'b';
  }
  if (opts.muzzleBrake) {
    for (let y = 0; y < Math.min(2, barrelLenPx); y++) {
      for (let dx = -half - 1; dx <= half + 1; dx++) put(g, bcx + dx, y, 'k');
    }
  }
  if (opts.mantletWpx) {
    const my0 = Math.max(0, barrelLenPx - 2);
    fillRect(g, bcx - Math.floor(opts.mantletWpx / 2), my0, bcx + Math.floor(opts.mantletWpx / 2), my0 + 2, 'H');
  }
  if (opts.cupola) put(g, Math.floor(cx + tw * 0.18), barrelLenPx + Math.floor(bodyH * 0.5), 'x');
  return g;
}

// --------------------------------------------------------------- specs ----
type TurretKind = 'germanBox' | 'tigerBox' | 'pantherLong' | 'sovietRound' | 'kvBoxy' | 'none';

interface VehSpec {
  side: Side;
  era: 'early' | 'late' | 'soviet';
  hullFamily: HullFamily;
  wideTracks?: boolean;
  turret: TurretKind;
  barrelFrac: number;
  barrelWpx: number;
  muzzleBrake?: boolean;
  mantletWpx?: number;
  bustle?: boolean;
  turretWFrac?: number;
  casemateTaper?: number;
  hullCrossPos?: [number, number][];
  turretCrossPos?: [number, number];
  starPos?: [number, number];
}

const SPEC: Record<string, VehSpec> = {
  pz3j: { side: 'german', era: 'early', hullFamily: 'boxy', turret: 'germanBox', barrelFrac: 0.45, barrelWpx: 2, turretWFrac: 0.56 },
  pz4f1: { side: 'german', era: 'early', hullFamily: 'boxy', turret: 'germanBox', barrelFrac: 0.3, barrelWpx: 3, turretWFrac: 0.6 },
  pz4gh: { side: 'german', era: 'late', hullFamily: 'boxy', turret: 'germanBox', barrelFrac: 0.55, barrelWpx: 3, muzzleBrake: true, turretWFrac: 0.6 },
  stug3g: { side: 'german', era: 'late', hullFamily: 'casemate', turret: 'none', barrelFrac: 0.55, barrelWpx: 3 },
  panther: { side: 'german', era: 'late', hullFamily: 'sloped', turret: 'pantherLong', barrelFrac: 0.7, barrelWpx: 3, mantletWpx: 5, turretWFrac: 0.5 },
  tiger: { side: 'german', era: 'late', hullFamily: 'boxy', wideTracks: true, turret: 'tigerBox', barrelFrac: 0.6, barrelWpx: 3, muzzleBrake: true, turretWFrac: 0.56 },
  sdkfz251: { side: 'german', era: 'early', hullFamily: 'halftrack', turret: 'none', barrelFrac: 0, barrelWpx: 0 },
  marder3: { side: 'german', era: 'early', hullFamily: 'casemate', turret: 'none', barrelFrac: 0.65, barrelWpx: 3 },
  t26: { side: 'soviet', era: 'soviet', hullFamily: 'light', turret: 'sovietRound', barrelFrac: 0.35, barrelWpx: 2, turretWFrac: 0.48 },
  bt7: { side: 'soviet', era: 'soviet', hullFamily: 'light', turret: 'sovietRound', barrelFrac: 0.4, barrelWpx: 2, turretWFrac: 0.48 },
  t34_76: { side: 'soviet', era: 'soviet', hullFamily: 'sloped', turret: 'sovietRound', barrelFrac: 0.5, barrelWpx: 3, turretWFrac: 0.52 },
  t34_85: { side: 'soviet', era: 'soviet', hullFamily: 'sloped', turret: 'sovietRound', barrelFrac: 0.55, barrelWpx: 3, bustle: true, turretWFrac: 0.62 },
  kv1: { side: 'soviet', era: 'soviet', hullFamily: 'slab', turret: 'kvBoxy', barrelFrac: 0.5, barrelWpx: 3, turretWFrac: 0.58 },
  is2: { side: 'soviet', era: 'soviet', hullFamily: 'sloped', turret: 'sovietRound', barrelFrac: 0.7, barrelWpx: 3, muzzleBrake: true, turretWFrac: 0.55 },
  t70: { side: 'soviet', era: 'soviet', hullFamily: 'light', turret: 'sovietRound', barrelFrac: 0.35, barrelWpx: 2, turretWFrac: 0.44 },
  su76: { side: 'soviet', era: 'soviet', hullFamily: 'casemate', turret: 'none', barrelFrac: 0.55, barrelWpx: 3 },
  su85: { side: 'soviet', era: 'soviet', hullFamily: 'casemate', turret: 'none', barrelFrac: 0.65, barrelWpx: 3, casemateTaper: 0.32 },
};

const DEFAULT_SPEC: VehSpec = { side: 'german', era: 'early', hullFamily: 'boxy', turret: 'germanBox', barrelFrac: 0.5, barrelWpx: 3 };

function specOf(defId: string): VehSpec { return SPEC[defId] ?? DEFAULT_SPEC; }

function paletteOf(spec: VehSpec): VehPalette {
  if (spec.side === 'soviet') return SOVIET_PALETTE;
  return spec.era === 'late' ? LATE_GERMAN_PALETTE : EARLY_GERMAN_PALETTE;
}

// --------------------------------------------------------- canvas compose -
const HULL_PAD = 6; // padding reserved for the SE cast shadow, both axes

function gridToCanvas(g: Grid, colorMap: Record<string, string>, shadowDx: number, shadowDy: number): HTMLCanvasElement {
  const w = g[0].length, h = g.length;
  const cw = w + HULL_PAD * 2, ch = h + HULL_PAD * 2;
  const c = createCanvas(cw, ch);
  const ctx = ctx2d(c);
  // Soft SE cast shadow: the hull's own silhouette, shifted and dimmed.
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.translate(HULL_PAD + shadowDx, HULL_PAD + shadowDy);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y][x] === '.') continue;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
  // Hull/turret art on top.
  ctx.translate(HULL_PAD, HULL_PAD);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch2 = g[y][x];
      if (ch2 === '.') continue;
      ctx.fillStyle = colorMap[ch2] ?? '#ff00ff';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

function applyKnockedOut(c: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const out = darken(c, 0.42);
  const octx = ctx2d(out);
  octx.save();
  octx.translate(HULL_PAD, HULL_PAD);
  octx.fillStyle = SOOT;
  octx.beginPath(); octx.ellipse(w * 0.5, h * 0.42, w * 0.34, h * 0.15, 0, 0, Math.PI * 2); octx.fill();
  octx.beginPath(); octx.ellipse(w * 0.5, h * 0.82, w * 0.3, h * 0.11, 0, 0, Math.PI * 2); octx.fill();
  const glow = octx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.42, w * 0.32);
  glow.addColorStop(0, 'rgba(224,120,40,0.55)');
  glow.addColorStop(1, 'rgba(224,120,40,0)');
  octx.fillStyle = glow;
  octx.beginPath(); octx.arc(w * 0.5, h * 0.42, w * 0.32, 0, Math.PI * 2); octx.fill();
  octx.restore();
  return out;
}

// ------------------------------------------------------------- hull build -
const HULL_CANON: Record<HullFamily, { w: number; h: number }> = {
  boxy: { w: 30, h: 60 }, sloped: { w: 30, h: 60 }, slab: { w: 33, h: 62 },
  light: { w: 24, h: 46 }, casemate: { w: 28, h: 56 }, halftrack: { w: 21, h: 58 },
};

export function buildVehicleHull(defId: string, lengthM: number, widthM: number, state: 'ok' | 'knockedOut'): HTMLCanvasElement {
  const spec = specOf(defId);
  const pal = paletteOf(spec);
  const w = Math.max(6, Math.round(widthM * VEH_PX_PER_M));
  const h = Math.max(10, Math.round(lengthM * VEH_PX_PER_M));
  let grid: Grid;
  if (spec.hullFamily === 'halftrack') {
    grid = resize(buildHalftrackHull(HULL_CANON.halftrack.w, HULL_CANON.halftrack.h), w, h);
  } else if (spec.hullFamily === 'casemate') {
    const canon = HULL_CANON.casemate;
    const barrelLenCanon = Math.round(canon.h * spec.barrelFrac);
    const built = buildCasemateHull(canon.w, canon.h, barrelLenCanon, Math.max(2, spec.barrelWpx - 1), {
      muzzleBrake: spec.muzzleBrake, taper: spec.casemateTaper,
    });
    // Resize hull footprint and barrel overhang independently by height so
    // the barrel keeps its own proportion instead of stretching with hull.
    const barrelLenPx = Math.round(h * spec.barrelFrac);
    const barrelPortion = built.slice(0, barrelLenCanon);
    const bodyPortion = built.slice(barrelLenCanon);
    const rBarrel = resize(barrelPortion, w, Math.max(1, barrelLenPx));
    const rBody = resize(bodyPortion, w, h);
    grid = [...rBarrel, ...rBody];
  } else {
    const canon = HULL_CANON[spec.hullFamily];
    const built = spec.hullFamily === 'boxy' ? buildBoxyHull(canon.w, canon.h, !!spec.wideTracks)
      : spec.hullFamily === 'sloped' ? buildSlopedHull(canon.w, canon.h)
      : spec.hullFamily === 'slab' ? buildSlabHull(canon.w, canon.h)
      : buildLightHull(canon.w, canon.h);
    grid = resize(built, w, h);
  }
  if (pal.camoBand) applyCamoBands(grid);
  const gh = grid.length;
  if (spec.side === 'german') {
    stampMarking(grid, 0.5, Math.min(0.9, (gh - 4) / gh), 'cross');
    if (spec.hullFamily !== 'halftrack') stampMarking(grid, 0.25, 0.5, 'cross');
  } else if (spec.side === 'soviet' && spec.hullFamily === 'casemate') {
    stampMarking(grid, 0.7, 0.32, 'star');
  }
  const colorMap = colorMapFor(pal);
  let canvas = gridToCanvas(grid, colorMap, 2, 3);
  if (state === 'knockedOut') canvas = applyKnockedOut(canvas, grid[0].length, gh);
  return canvas;
}

// ----------------------------------------------------------- turret build -
const TURRET_CANON_BODY_H = 22;
const TURRET_CANON_W = 22;

export function buildVehicleTurret(defId: string, lengthM: number, widthM: number, state: 'ok' | 'knockedOut'): HTMLCanvasElement {
  const spec = specOf(defId);
  if (spec.turret === 'none') return createCanvas(1, 1);
  const pal = paletteOf(spec);
  const hullW = Math.max(6, Math.round(widthM * VEH_PX_PER_M));
  const hullH = Math.max(10, Math.round(lengthM * VEH_PX_PER_M));
  const tw = Math.max(5, Math.round(hullW * (spec.turretWFrac ?? 0.56)));
  const barrelLenPx = Math.max(2, Math.round(hullH * spec.barrelFrac));
  const bodyH = Math.max(5, Math.round(hullH * (spec.turret === 'tigerBox' || spec.turret === 'kvBoxy' ? 0.34 : 0.3)));
  const bustleHpx = spec.bustle ? Math.round(hullH * 0.14) : 0;

  // Build at canonical body height then resize body/barrel independently so
  // barrel proportion (thin gun vs. hull length) is preserved across scale.
  const canonGrid = buildTurretGrid(TURRET_CANON_W, TURRET_CANON_BODY_H, 6, 3, {
    square: spec.turret === 'kvBoxy',
    cupola: spec.turret !== 'sovietRound' || defId === 'is2',
    mantletWpx: spec.mantletWpx ? 5 : undefined,
    bustleHpx: spec.bustle ? 5 : 0,
    muzzleBrake: spec.muzzleBrake,
  });
  const canonBarrel = canonGrid.slice(0, 6);
  const canonBody = canonGrid.slice(6);
  const rBarrel = resize(canonBarrel, tw, barrelLenPx);
  const rBody = resize(canonBody, tw, bodyH + bustleHpx);
  let grid: Grid = [...rBarrel, ...rBody];
  // Re-draw barrel at correct absolute width in real pixels (resize above
  // already blurs the barrel's width toward tw's scale; overwrite with a
  // clean N-px-wide bar so it stays bold at 1x regardless of turret size).
  const bcx = Math.floor(tw / 2);
  const half = Math.max(1, Math.floor(spec.barrelWpx / 2));
  for (let y = 0; y < barrelLenPx; y++) {
    for (let dx = -half; dx <= half; dx++) put(grid, bcx + dx, y, dx === -half ? 'B' : 'b');
  }
  if (spec.muzzleBrake) {
    for (let y = 0; y < Math.min(2, barrelLenPx); y++) {
      for (let dx = -half - 1; dx <= half + 1; dx++) put(grid, bcx + dx, y, 'k');
    }
  }
  if (pal.camoBand) applyCamoBands(grid);
  const bodyCy = barrelLenPx + Math.floor((bodyH + bustleHpx) * 0.45);
  if (spec.side === 'german') stampMarking(grid, 0.5, bodyCy / grid.length, 'cross');
  else if (spec.side === 'soviet') stampMarking(grid, 0.5, (barrelLenPx + 2) / grid.length, 'star');

  // The turret ring (pivot the game rotates the sprite around) sits at the
  // body's own centre, not the mid-point of the barrel+body canvas — pad the
  // grid symmetrically so the canvas's geometric centre lands exactly on the
  // ring, matching unitRender's "turret sprite centred on its pivot" pivot.
  const pivotFromTop = barrelLenPx + Math.floor(bodyH / 2);
  const southExtent = grid.length - pivotFromTop;
  const halfH = Math.max(pivotFromTop, southExtent);
  const totalH = halfH * 2;
  const topPad = Math.round(halfH - pivotFromTop);
  if (topPad > 0 || grid.length < totalH) {
    const w2 = grid[0].length;
    const padded = blank(w2, totalH);
    for (let y = 0; y < grid.length; y++) padded[topPad + y] = grid[y];
    grid = padded;
  }

  const colorMap = colorMapFor(pal);
  let canvas = gridToCanvas(grid, colorMap, 0, 0);
  if (state === 'knockedOut') {
    const w2 = grid[0].length;
    canvas = darken(canvas, 0.42);
    const octx = ctx2d(canvas);
    octx.save();
    octx.translate(HULL_PAD, HULL_PAD);
    octx.fillStyle = SOOT;
    octx.beginPath(); octx.ellipse(w2 * 0.5, topPad + bodyCy, w2 * 0.42, (bodyH + bustleHpx) * 0.4, 0, 0, Math.PI * 2); octx.fill();
    octx.restore();
  }
  return canvas;
}
