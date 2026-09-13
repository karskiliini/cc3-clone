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

/** Fill a rectangle with a soft diagonal NW-lit / SE-shadowed 3-tone gradient
 * (a lit NW quarter fading through a mid tone to a shadowed SE quarter),
 * rather than a thin edge band — reads as a painted, gently curved surface
 * instead of a diagrammatic outline. A canvas-level alpha wash (see
 * `applyGradientWash`) is layered on top for extra smoothness. */
function shadeRect(g: Grid, x0: number, y0: number, x1: number, y1: number): void {
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  for (let y = Math.max(0, y0); y <= Math.min(g.length - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(g[0].length - 1, x1); x++) {
      const nx = (x - x0) / w, ny = (y - y0) / h;
      const t = nx * 0.5 + ny * 0.5;
      g[y][x] = t < 0.36 ? 'H' : t > 0.64 ? 'd' : 'h';
    }
  }
}

/** Soft alpha sheen from the lit NW corner to a dimmed SE corner, composited
 * only over already-opaque pixels (source-atop) so it hugs the silhouette —
 * the "soft gradient" pass that sits on top of the 3-tone banding above to
 * make the whole vehicle read as a lit, curved surface rather than flat
 * pixel-art blocks. */
function applyGradientWash(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  const grad = ctx.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, 'rgba(255,255,250,0.16)');
  grad.addColorStop(0.45, 'rgba(255,255,250,0.02)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.04)');
  grad.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** Draw a wheel as a small disc — a light rim (tread catching the light)
 * around a dark hub bolt — instead of a single pixel, when the track is wide
 * enough to show it, so the road wheels read as distinct discs against the
 * dark track run. */
function drawWheel(g: Grid, cx: number, cy: number, trackW: number): void {
  if (trackW >= 3) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) put(g, cx + dx, cy + dy, 'W');
    }
    put(g, cx, cy, 'w');
  } else {
    put(g, cx, cy, 'W');
  }
}

/** Darken the lowest couple of rows of each track run to a mud/dirt tone —
 * tracks read as sitting *in* the ground rather than floating on it. */
function drawTrackMud(g: Grid, trackW: number): void {
  const h = g.length, w = g[0].length;
  const mudRows = Math.max(1, Math.round(h * 0.05));
  for (let y = h - mudRows; y < h; y++) {
    for (let x = 0; x < trackW; x++) { put(g, x, y, 'u'); put(g, w - 1 - x, y, 'u'); }
  }
}

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

/** Lighten/darken a hex color by a percentage (e.g. 0.2 = +20% toward white,
 * -0.25 = -25% toward black) — used to derive the NW-highlight/SE-shadow
 * tones from a single mid hull tone at an exact, literal contrast ratio. */
function shade(hex: string, pct: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const f = (v: number) => {
    const out = pct >= 0 ? v + (255 - v) * pct : v * (1 + pct);
    return Math.max(0, Math.min(255, Math.round(out))).toString(16).padStart(2, '0');
  };
  return '#' + f(r) + f(g) + f(b);
}

// Round-3: widen the highlight/shadow swing (+25% brighter highlight, deeper
// shadow) so the hull reads with a stronger specular pop, matching the
// reference's more saturated highlight-to-shadow contrast.
function makePalette(hullMid: string, camoBand?: string): VehPalette {
  return { hullMid, hullLight: shade(hullMid, 0.25), hullDark: shade(hullMid, -0.3), camoBand };
}

const EARLY_GERMAN_PALETTE: VehPalette = makePalette('#5e6066');
const LATE_GERMAN_PALETTE: VehPalette = makePalette('#a9956a', '#6f7a4d');
const SOVIET_PALETTE: VehPalette = makePalette('#5d6a3f');

const OUTLINE = '#0c0c0a'; // near-black, deliberately darker than any hullDark tone
// Round-3: tracks pushed to near-black (were a dark grey-brown) so the light
// wheel-rim discs (drawWheel's 'W', below) pop against them the way the
// reference's tank tracks read as a flat dark band under a lit hull.
const TRACK_DARK = '#141311';
const TRACK_LIGHT = '#2b2924';
const WHEEL_RIM = '#1c1b17';
const GRILLE = '#201f1c';
const HATCH = '#d8d2b8';
const MARK_WHITE = '#eceae0';
const MARK_BLACK = '#100f0c';
const MARK_RED = '#c8402c';
const SOOT = 'rgba(8,7,6,0.55)';
const MUD_DARK = '#141210';
const JERRYCAN = '#3a4a30';
const JERRYCAN_LIGHT = '#526a41';

function colorMapFor(pal: VehPalette): Record<string, string> {
  // Round-3: an extra-bright "hot" specular tone, 25% brighter again than
  // the standard hull highlight — used for the barrel's top-edge highlight
  // line and the NW-quarter hot-spot on the hull glacis / turret roof, so
  // those specific specular cues pop harder than the general NW-lit hull
  // face they sit on.
  const hot = shade(pal.hullLight, 0.25);
  return {
    o: OUTLINE, t: TRACK_DARK, T: TRACK_LIGHT, w: WHEEL_RIM, W: pal.hullLight,
    h: pal.hullMid, H: pal.hullLight, d: pal.hullDark, g: GRILLE, x: HATCH,
    // Barrel reads as a lit cylinder: bright top edge, mid body, dark underside.
    B: hot, b: pal.hullMid, n: pal.hullDark, k: OUTLINE,
    m: MARK_WHITE, c: MARK_BLACK, r: MARK_RED,
    a: pal.camoBand ?? pal.hullDark,
    s: 'rgba(6,6,4,0.4)',
    u: MUD_DARK, j: JERRYCAN, J: JERRYCAN_LIGHT,
    N: hot,
  };
}

/** Paint a gun barrel as a lit cylinder: 1px light top edge, mid body, 1px
 * dark underside (for width>=3); a 2px barrel gets just light/dark. Applies
 * a muzzle-brake block at the tip when requested. */
function paintBarrel(g: Grid, cx: number, len: number, widthPx: number, muzzleBrake?: boolean): void {
  const w = Math.max(2, widthPx);
  const half = Math.floor((w - 1) / 2);
  const left = cx - half;
  for (let y = 0; y < len; y++) {
    for (let i = 0; i < w; i++) {
      const ch = i === 0 ? 'B' : i === w - 1 ? 'n' : 'b';
      put(g, left + i, y, ch);
    }
  }
  if (muzzleBrake) {
    for (let y = 0; y < Math.min(2, len); y++) {
      for (let i = -1; i <= w; i++) put(g, left + i, y, 'k');
    }
  }
}

// ---------------------------------------------------------- hull families -
type HullFamily = 'boxy' | 'sloped' | 'slab' | 'light' | 'casemate' | 'halftrack';

/** Punch a small hinge tick (a 1px dark dot just outside one edge of a
 * hatch) so hatches read as hinged panels rather than flat decals. */
function drawHatchWithHinge(g: Grid, x0: number, y0: number, x1: number, y1: number, hinge: 'n' | 's' | 'e' | 'w'): void {
  fillRect(g, x0, y0, x1, y1, 'x');
  strokeRect(g, x0, y0, x1, y1, 'o');
  if (hinge === 'n') { put(g, x0, y0 - 1, 'o'); put(g, x1, y0 - 1, 'o'); }
  else if (hinge === 's') { put(g, x0, y1 + 1, 'o'); put(g, x1, y1 + 1, 'o'); }
  else if (hinge === 'w') { put(g, x0 - 1, y0, 'o'); put(g, x0 - 1, y1, 'o'); }
  else { put(g, x1 + 1, y0, 'o'); put(g, x1 + 1, y1, 'o'); }
}

/** A small stowed jerrycan (dark body, light top rim) — Soviet crews lashed
 * spare fuel cans to the rear deck. */
function drawJerrycan(g: Grid, cx: number, cy: number): void {
  fillRect(g, cx - 1, cy - 1, cx, cy + 1, 'j');
  put(g, cx - 1, cy - 1, 'J');
}

/** A small tool box (dark box with a lighter lid edge) bolted to the hull
 * side, above the track run. */
function drawToolbox(g: Grid, x0: number, y0: number, w: number, h: number): void {
  fillRect(g, x0, y0, x0 + w - 1, y0 + h - 1, 'd');
  strokeRect(g, x0, y0, x0 + w - 1, y0 + h - 1, 'o');
  fillRect(g, x0, y0, x0 + w - 1, y0, 'H');
}

/** A strip of spare track links stowed across the German glacis plate —
 * alternating tread-dark/tread-light segments cutting across the lighter
 * glacis tone. */
function drawSpareTrackStrip(g: Grid, x0: number, x1: number, y: number): void {
  for (let x = x0; x <= x1; x++) put(g, x, y, (x - x0) % 2 === 0 ? 't' : 'T');
}

interface HullOpts { wide?: boolean; taper?: number; light?: boolean; side?: Side; }

/** Shared tracked-hull skeleton (tracks + wheels + hull deck with NW/SE
 * shading, glacis plate, driver hatch, rear grille/exhaust hatch) used by
 * the boxy, sloped, slab and light families — they differ only in nose
 * taper and proportions. */
function buildTrackedSkeleton(w: number, h: number, opts: HullOpts): Grid {
  const g = blank(w, h);
  const trackW = Math.max(2, Math.round(w * (opts.wide ? 0.3 : 0.24)));
  for (let y = 0; y < h; y++) {
    const tread = Math.floor(y / 2) % 2 === 0 ? 't' : 'T';
    for (let x = 0; x < trackW; x++) { g[y][x] = tread; g[y][w - 1 - x] = tread; }
  }
  const wheelCount = opts.light ? 4 : Math.max(5, Math.min(8, Math.round(h / (opts.wide ? 7 : 5.5))));
  for (let i = 0; i < wheelCount; i++) {
    const cy = Math.round((i + 0.5) * (h / wheelCount));
    drawWheel(g, Math.floor(trackW / 2), cy, trackW);
    drawWheel(g, w - 1 - Math.floor(trackW / 2), cy, trackW);
  }
  drawTrackMud(g, trackW);
  const bx0 = trackW, bx1 = w - 1 - trackW;
  const bw = Math.max(1, bx1 - bx0);
  shadeRect(g, bx0, 0, bx1, h - 1);
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
  // Round-3: an extra-bright hot-spot on the NW quarter of the glacis plate
  // (top-plate highlight) — the top-plate is already the NW-lit face via
  // 'H', this pushes just its own NW corner brighter again for a real
  // specular pop instead of a flat highlight band.
  const nwHotW = Math.max(1, Math.round((bx1 - bx0 + 1) * 0.4));
  const nwHotH = Math.max(1, Math.ceil(glacisH / 2));
  fillRect(g, bx0, 0, bx0 + nwHotW - 1, nwHotH - 1, 'N');
  put(g, bx0 + 2, glacisH - 1, 'x');
  put(g, bx1 - 2, glacisH - 1, 'x');
  if (opts.side === 'german' && bx1 - bx0 > 8) drawSpareTrackStrip(g, bx0 + 3, bx1 - 3, Math.max(0, glacisH - 2));
  const midX = Math.floor((bx0 + bx1) / 2);
  drawHatchWithHinge(g, midX - 1, glacisH + 3, midX + 1, glacisH + 4, 'w');
  // Engine deck: exactly 3 dark grille slats plus an exhaust hatch, and a
  // stowed toolbox on the hull side above the track run.
  const deckH = Math.max(3, Math.round(h * 0.14));
  const deckY0 = h - deckH;
  for (let i = 0; i < 3; i++) {
    const y = deckY0 + Math.round(((i + 0.5) * deckH) / 3);
    if (y > 0 && y < h - 1) fillRect(g, bx0 + 2, y, bx1 - 2, y, 'g');
  }
  drawHatchWithHinge(g, midX - 2, h - 3, midX + 2, h - 2, 's');
  if (bw > 10) drawToolbox(g, bx0 + 1, Math.round(h * 0.58), 2, 3);
  if (opts.side === 'soviet' && bw > 10) {
    drawJerrycan(g, bx1 - 2, h - Math.round(deckH * 1.6));
    drawJerrycan(g, bx1 - 2, h - Math.round(deckH * 0.6));
  }
  for (let x = 0; x < w; x++) { g[0][x] = 'o'; g[h - 1][x] = 'o'; }
  for (let y = 0; y < h; y++) { g[y][0] = 'o'; g[y][w - 1] = 'o'; }
  return g;
}

function buildBoxyHull(w: number, h: number, wide: boolean, side: Side): Grid {
  return buildTrackedSkeleton(w, h, { wide, side });
}
function buildSlopedHull(w: number, h: number, side: Side): Grid {
  return buildTrackedSkeleton(w, h, { taper: 0.32, side });
}
function buildSlabHull(w: number, h: number, side: Side): Grid {
  const g = buildTrackedSkeleton(w, h, { wide: true, taper: 0.08, side });
  // Slab-sided KV-1: bolt-on fuel drums at the rear flanks.
  const w2 = g[0].length;
  fillRect(g, Math.round(w2 * 0.24), h - Math.round(h * 0.2), Math.round(w2 * 0.24) + 1, h - Math.round(h * 0.14), 'H');
  fillRect(g, Math.round(w2 * 0.7), h - Math.round(h * 0.2), Math.round(w2 * 0.7) + 1, h - Math.round(h * 0.14), 'H');
  return g;
}
function buildLightHull(w: number, h: number, side: Side): Grid {
  return buildTrackedSkeleton(w, h, { light: true, taper: 0.14, side });
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
  drawWheel(g, bx0 + Math.round(half * 0.15), noseH - 1, 3);
  drawWheel(g, bx1 - Math.round(half * 0.15), noseH - 1, 3);
  const bayY0 = noseH + 1, bayY1 = h - Math.max(2, Math.round(h * 0.14));
  shadeRect(g, bx0, bayY0, bx1, bayY1);
  strokeRect(g, bx0, bayY0, bx1, bayY1, 'o');
  // Open troop bay: exactly 4 crew helmet dots (2x2), visible from above.
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const x = Math.round(bx0 + (bx1 - bx0) * (0.3 + col * 0.4));
      const y = Math.round(bayY0 + (bayY1 - bayY0) * (0.35 + row * 0.35));
      put(g, x, y, 'x');
    }
  }
  // Pintle-mounted MG shield at the front of the bay, with the barrel
  // poking forward over the nose.
  const midX = Math.floor((bx0 + bx1) / 2);
  fillRect(g, midX - 2, bayY0, midX + 2, bayY0 + 1, 'd');
  strokeRect(g, midX - 2, bayY0, midX + 2, bayY0 + 1, 'o');
  put(g, midX, bayY0 - 1, 'b');
  put(g, midX + 1, noseH, 'b');
  // Rear engine deck (between the bay and the tail) — solid hull tone with
  // 3 dark grille slats and an exhaust hatch, not floating on transparent.
  shadeRect(g, bx0, bayY1 + 1, bx1, h - 2);
  const deckH = Math.max(1, h - 2 - (bayY1 + 1));
  for (let i = 0; i < 3; i++) {
    const y = bayY1 + 1 + Math.round(((i + 0.5) * deckH) / 3);
    if (y > bayY1 && y < h - 1) fillRect(g, bx0 + 2, y, bx1 - 2, y, 'g');
  }
  drawHatchWithHinge(g, midX - 2, h - 3, midX + 2, h - 2, 's');
  const trackW = Math.max(2, Math.round(w * 0.2));
  for (let y = noseH; y < h; y++) {
    const tread = Math.floor(y / 2) % 2 === 0 ? 't' : 'T';
    for (let x = 0; x < trackW; x++) { g[y][x] = tread; g[y][w - 1 - x] = tread; }
  }
  drawTrackMud(g, trackW);
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
  opts: { muzzleBrake?: boolean; taper?: number; side?: Side } = {},
): Grid {
  const body = buildTrackedSkeleton(w, h, { taper: opts.taper, side: opts.side });
  const boxH = Math.round(h * 0.46);
  const bx0 = Math.round(w * 0.16), bx1 = w - 1 - Math.round(w * 0.16);
  shadeRect(body, bx0, 1, bx1, boxH);
  strokeRect(body, bx0, 1, bx1, boxH, 'o');
  const midX = Math.floor((bx0 + bx1) / 2);
  drawHatchWithHinge(body, midX - 1, 3, midX + 1, 4, 'n');
  const barrel = blank(w, barrelLenPx);
  paintBarrel(barrel, midX, barrelLenPx, barrelWpx, opts.muzzleBrake);
  return [...barrel, ...body];
}

// -------------------------------------------------------- turret archetypes
interface TurretOpts {
  square?: boolean;
  cupola?: boolean;
  mantletWpx?: number;
  bustleHpx?: number;
  muzzleBrake?: boolean;
  /** Panther-style long wedge: narrower at the mantlet than at the rear. */
  wedge?: boolean;
}

/** A raised cupola ring (outline circle) with a hatch disc in the centre —
 * reads as a real fitting rather than a single dot. */
function drawCupola(g: Grid, cx: number, cy: number, r: number): void {
  const ri = Math.max(1, r);
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > ri + 0.4) continue;
      put(g, cx + dx, cy + dy, d > ri - 0.6 ? 'o' : 'x');
    }
  }
}

function buildTurretGrid(tw: number, bodyH: number, barrelLenPx: number, barrelWpx: number, opts: TurretOpts): Grid {
  const bustle = opts.bustleHpx ?? 0;
  const totalBodyH = bodyH + bustle;
  const th = barrelLenPx + totalBodyH;
  const g = blank(tw, th);
  const cx = tw / 2;
  // NW-lit top/west face, SE-shadowed bottom/east face ("under the turret
  // overhang") — a soft diagonal 3-tone gradient (see shadeRect) rather than
  // a flat fill, so the turret body reads as a curved casting.
  for (let y = 0; y < bodyH; y++) {
    for (let x = 0; x < tw; x++) {
      const nx = (x + 0.5 - cx) / (tw / 2);
      const ny = (y + 0.5) / bodyH;
      // Panther's turret is a long wedge: narrower at the mantlet (front,
      // ny=0) than at the rear (ny=1).
      const wedgeLimit = opts.wedge ? 1 - 0.3 * (1 - ny) : 1;
      const nxAdj = nx / wedgeLimit;
      // A true ellipse pinches to a point at both the front and rear; a
      // rounded-rectangle (superellipse, p=2.6) keeps the sides fuller and
      // the ends flatter/rounded, matching a real cast turret's silhouette
      // (and giving the Panther wedge a flat rear instead of a lens point).
      const p = 2.6;
      const shapeVal = opts.square
        ? Math.max(Math.abs(nxAdj), Math.abs(ny * 2 - 1))
        : Math.pow(Math.pow(Math.abs(nxAdj), p) + Math.pow(Math.abs(ny * 2 - 1), p), 1 / p);
      if (shapeVal > 1.0) continue;
      const t = ((nx + 1) / 2) * 0.5 + ny * 0.5;
      // Round-3: a tight NW hot-spot inside the general 'H' NW-lit band —
      // the turret-roof highlight the critique asked for, distinct from the
      // wider (but now also brighter) NW-lit face.
      g[barrelLenPx + y][x] = t < 0.16 ? 'N' : t < 0.36 ? 'H' : t > 0.64 ? 'd' : 'h';
    }
  }
  if (bustle > 0) {
    const bw = Math.round(tw * 0.72);
    const bx0 = Math.floor((tw - bw) / 2), bx1 = bx0 + bw - 1;
    shadeRect(g, bx0, barrelLenPx + bodyH, bx1, barrelLenPx + bodyH + bustle - 1);
  }
  outlineFill(g);
  // Barrel, extending "north" off the top of the turret body, as a lit
  // cylinder (light top edge / mid body / dark underside).
  const bcx = Math.floor(cx);
  paintBarrel(g, bcx, barrelLenPx, barrelWpx, opts.muzzleBrake);
  if (opts.mantletWpx) {
    // Mantlet reads as a darker armored block bolted to the turret front.
    const my0 = Math.max(0, barrelLenPx - 2);
    fillRect(g, bcx - Math.floor(opts.mantletWpx / 2), my0, bcx + Math.floor(opts.mantletWpx / 2), my0 + 2, 'd');
    strokeRect(g, bcx - Math.floor(opts.mantletWpx / 2), my0, bcx + Math.floor(opts.mantletWpx / 2), my0 + 2, 'o');
  }
  if (opts.cupola) {
    const r = Math.max(1, Math.round(tw * 0.09));
    drawCupola(g, Math.floor(cx + tw * 0.18), barrelLenPx + Math.floor(bodyH * 0.5), r);
  }
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
  /** Turret body length : width ratio override (Panther/IS-2 "long" turrets
   * with a pronounced overhang, per the round-2 critique) instead of the
   * default hull-length-derived body height. */
  turretElongate?: number;
  /** Force a flat-sided (square-cornered) turret body instead of a rounded
   * casting — used for the wide, boxy Tiger turret as well as the KV-1. */
  turretSquare?: boolean;
  hullCrossPos?: [number, number][];
  turretCrossPos?: [number, number];
  starPos?: [number, number];
}

const SPEC: Record<string, VehSpec> = {
  pz3j: { side: 'german', era: 'early', hullFamily: 'boxy', turret: 'germanBox', barrelFrac: 0.45, barrelWpx: 3, turretWFrac: 0.56 },
  pz4f1: { side: 'german', era: 'early', hullFamily: 'boxy', turret: 'germanBox', barrelFrac: 0.3, barrelWpx: 3, turretWFrac: 0.6 },
  pz4gh: { side: 'german', era: 'late', hullFamily: 'boxy', turret: 'germanBox', barrelFrac: 0.55, barrelWpx: 3, muzzleBrake: true, turretWFrac: 0.6 },
  stug3g: { side: 'german', era: 'late', hullFamily: 'casemate', turret: 'none', barrelFrac: 0.55, barrelWpx: 3 },
  panther: { side: 'german', era: 'late', hullFamily: 'sloped', turret: 'pantherLong', barrelFrac: 0.7, barrelWpx: 3, muzzleBrake: true, mantletWpx: 7, turretWFrac: 0.46, turretElongate: 1.6 },
  tiger: { side: 'german', era: 'late', hullFamily: 'boxy', wideTracks: true, turret: 'tigerBox', barrelFrac: 0.6, barrelWpx: 3, muzzleBrake: true, turretWFrac: 0.62, turretSquare: true },
  sdkfz251: { side: 'german', era: 'early', hullFamily: 'halftrack', turret: 'none', barrelFrac: 0, barrelWpx: 0 },
  marder3: { side: 'german', era: 'early', hullFamily: 'casemate', turret: 'none', barrelFrac: 0.65, barrelWpx: 3 },
  t26: { side: 'soviet', era: 'soviet', hullFamily: 'light', turret: 'sovietRound', barrelFrac: 0.35, barrelWpx: 3, turretWFrac: 0.48 },
  bt7: { side: 'soviet', era: 'soviet', hullFamily: 'light', turret: 'sovietRound', barrelFrac: 0.4, barrelWpx: 3, turretWFrac: 0.48 },
  t34_76: { side: 'soviet', era: 'soviet', hullFamily: 'sloped', turret: 'sovietRound', barrelFrac: 0.5, barrelWpx: 3, turretWFrac: 0.52 },
  t34_85: { side: 'soviet', era: 'soviet', hullFamily: 'sloped', turret: 'sovietRound', barrelFrac: 0.55, barrelWpx: 3, bustle: true, turretWFrac: 0.62 },
  kv1: { side: 'soviet', era: 'soviet', hullFamily: 'slab', turret: 'kvBoxy', barrelFrac: 0.5, barrelWpx: 3, turretWFrac: 0.58, turretSquare: true },
  is2: { side: 'soviet', era: 'soviet', hullFamily: 'sloped', turret: 'sovietRound', barrelFrac: 0.7, barrelWpx: 3, muzzleBrake: true, mantletWpx: 6, turretWFrac: 0.5, turretElongate: 1.6 },
  t70: { side: 'soviet', era: 'soviet', hullFamily: 'light', turret: 'sovietRound', barrelFrac: 0.35, barrelWpx: 3, turretWFrac: 0.44 },
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
  // Round-3: strengthened from 0.4 alpha to 0.45 to match the reference's
  // stronger cast shadow.
  ctx.save();
  ctx.globalAlpha = 0.45;
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
  // Soft painterly sheen on top of the 3-tone banding (see shadeRect).
  applyGradientWash(ctx, 0, 0, w, h);
  return c;
}

/** Scorch + dent + ember pass shared by hull and turret knocked-out states.
 * Burning (flame/smoke animation) is handled elsewhere; this is the static
 * "already been hit" look: soot patches, a few small dark dent rectangles
 * offset off-centre (never a perfectly symmetric hole), thin scorch streaks
 * radiating from the impact, and a small, subdued ember glow. */
function paintScorchAndDent(octx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
  octx.fillStyle = SOOT;
  octx.beginPath(); octx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); octx.fill();
  // Dent: a couple of small dark rectangles offset asymmetrically off-centre.
  octx.fillStyle = 'rgba(4,3,2,0.6)';
  octx.fillRect(cx - rx * 0.35, cy - ry * 0.4, Math.max(1, rx * 0.3), Math.max(1, ry * 0.5));
  octx.fillRect(cx + rx * 0.15, cy + ry * 0.1, Math.max(1, rx * 0.22), Math.max(1, ry * 0.35));
  // Scorch streaks radiating from the impact point.
  octx.strokeStyle = 'rgba(15,12,10,0.5)';
  octx.lineWidth = 1;
  for (const a of [-0.9, -0.3, 0.4, 1.1, 2.0]) {
    octx.beginPath();
    octx.moveTo(cx, cy);
    octx.lineTo(cx + Math.cos(a) * rx * 1.5, cy + Math.sin(a) * ry * 1.6);
    octx.stroke();
  }
  const glow = octx.createRadialGradient(cx, cy, 0, cx, cy, rx * 0.8);
  glow.addColorStop(0, 'rgba(214,110,40,0.4)');
  glow.addColorStop(1, 'rgba(214,110,40,0)');
  octx.fillStyle = glow;
  octx.beginPath(); octx.arc(cx, cy, rx * 0.8, 0, Math.PI * 2); octx.fill();
}

function applyKnockedOut(c: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const out = darken(c, 0.42);
  const octx = ctx2d(out);
  octx.save();
  octx.translate(HULL_PAD, HULL_PAD);
  paintScorchAndDent(octx, w * 0.5, h * 0.42, w * 0.34, h * 0.15);
  octx.fillStyle = SOOT;
  octx.beginPath(); octx.ellipse(w * 0.5, h * 0.82, w * 0.3, h * 0.11, 0, 0, Math.PI * 2); octx.fill();
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
      muzzleBrake: spec.muzzleBrake, taper: spec.casemateTaper, side: spec.side,
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
    const built = spec.hullFamily === 'boxy' ? buildBoxyHull(canon.w, canon.h, !!spec.wideTracks, spec.side)
      : spec.hullFamily === 'sloped' ? buildSlopedHull(canon.w, canon.h, spec.side)
      : spec.hullFamily === 'slab' ? buildSlabHull(canon.w, canon.h, spec.side)
      : buildLightHull(canon.w, canon.h, spec.side);
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
  // Round-3: SE cast shadow offset pushed from (+3,+4) to (+4,+6) alongside
  // the alpha bump in gridToCanvas, per the critique's stronger-shadow ask.
  let canvas = gridToCanvas(grid, colorMap, 4, 6);
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
  const isBoxyBody = spec.turret === 'tigerBox' || spec.turret === 'kvBoxy';
  const bodyH = spec.turretElongate
    ? Math.max(5, Math.round(tw * spec.turretElongate))
    : Math.max(5, Math.round(hullH * (isBoxyBody ? 0.34 : 0.3)));
  const bustleHpx = spec.bustle ? Math.round(hullH * 0.14) : 0;

  // Build at canonical body height then resize body/barrel independently so
  // barrel proportion (thin gun vs. hull length) is preserved across scale.
  const canonGrid = buildTurretGrid(TURRET_CANON_W, TURRET_CANON_BODY_H, 6, 3, {
    square: !!spec.turretSquare || spec.turret === 'kvBoxy',
    cupola: spec.turret !== 'sovietRound' || defId === 'is2',
    mantletWpx: spec.mantletWpx ? 5 : undefined,
    bustleHpx: spec.bustle ? 5 : 0,
    muzzleBrake: spec.muzzleBrake,
    wedge: spec.turret === 'pantherLong',
  });
  const canonBarrel = canonGrid.slice(0, 6);
  const canonBody = canonGrid.slice(6);
  const rBarrel = resize(canonBarrel, tw, barrelLenPx);
  const rBody = resize(canonBody, tw, bodyH + bustleHpx);
  let grid: Grid = [...rBarrel, ...rBody];
  // Re-draw barrel at correct absolute width in real pixels (resize above
  // already blurs the barrel's width toward tw's scale; overwrite with a
  // clean, lit-cylinder bar so it stays bold at 1x regardless of turret size).
  const bcx = Math.floor(tw / 2);
  paintBarrel(grid, bcx, barrelLenPx, spec.barrelWpx, spec.muzzleBrake);
  if (spec.mantletWpx) {
    const my0 = Math.max(0, barrelLenPx - 2);
    const mx0 = bcx - Math.floor(spec.mantletWpx / 2), mx1 = bcx + Math.floor(spec.mantletWpx / 2);
    fillRect(grid, mx0, my0, mx1, my0 + 2, 'd');
    strokeRect(grid, mx0, my0, mx1, my0 + 2, 'o');
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
    paintScorchAndDent(octx, w2 * 0.5, topPad + bodyCy, w2 * 0.42, (bodyH + bustleHpx) * 0.4);
    octx.restore();
  }
  return canvas;
}
