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
function drawWheel(g: Grid, cx: number, cy: number, trackW: number, s = 1): void {
  if (s >= 2) {
    // 2x: tyre ring, lit rim, hub cap with a centre bolt and a NW glint.
    const R = Math.max(2, Math.min(5, Math.floor(trackW * 0.4)));
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > R + 0.3) continue;
        put(g, cx + dx, cy + dy, d > R - 0.8 ? 'o' : d > R * 0.5 ? 'w' : 'W');
      }
    }
    put(g, cx, cy, 'k');
    put(g, cx - Math.max(1, Math.round(R * 0.55)), cy - Math.max(1, Math.round(R * 0.55)), 'N');
    return;
  }
  if (trackW >= 3) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) put(g, cx + dx, cy + dy, 'w');
    }
    put(g, cx, cy, 'T');
  } else {
    put(g, cx, cy, 'T');
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
function outlineFill(g: Grid, ch = 'o'): void {
  const h = g.length, w = g[0].length;
  const orig = g.map((r) => r.slice());
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && orig[y][x] !== '.';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1)) g[y][x] = ch;
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
function stampMarking(g: Grid, nx: number, ny: number, kind: 'cross' | 'star', s = 1): void {
  const h = g.length, w = g[0].length;
  const cx = Math.round(nx * w), cy = Math.round(ny * h);
  if (s >= 2) {
    if (kind === 'cross') {
      // Balkenkreuz: black cross with 3px arms, white edge flanks.
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          const cheb = Math.max(Math.abs(dx), Math.abs(dy));
          const black = (Math.abs(dx) <= 1 || Math.abs(dy) <= 1) && cheb <= 4;
          const nearBlack = (Math.abs(dx) <= 2 || Math.abs(dy) <= 2) && cheb <= 5;
          if (black) put(g, cx + dx, cy + dy, 'c');
          else if (nearBlack) put(g, cx + dx, cy + dy, 'm');
        }
      }
    } else {
      // Five-pointed red star with a thin white edge.
      const inStar = (px: number, py: number, R: number) => {
        const a = Math.atan2(px, -py);
        const r = Math.hypot(px, py);
        const seg = (2 * Math.PI) / 5;
        const t = Math.abs((((a % seg) + seg) % seg) - seg / 2) / (seg / 2);
        const lim = R * 0.42 + (R - R * 0.42) * (1 - t) ** 1.6;
        return r <= lim;
      };
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          if (inStar(dx, dy, 4.6)) put(g, cx + dx, cy + dy, 'r');
          else if (inStar(dx, dy, 5.9)) put(g, cx + dx, cy + dy, 'm');
        }
      }
    }
    return;
  }
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

// wf5: early panzer grey shares the infantry's cool blue-grey cast; late
// dunkelgelb with olive bands; Soviet 4BO green.
const EARLY_GERMAN_PALETTE: VehPalette = makePalette('#5a6166');
const LATE_GERMAN_PALETTE: VehPalette = makePalette('#a9956a', '#6f7a4d');
const SOVIET_PALETTE: VehPalette = makePalette('#586840');

// Round-3: tracks pushed to near-black (were a dark grey-brown) so the light
// wheel-rim discs (drawWheel's 'W', below) pop against them the way the
// reference's tank tracks read as a flat dark band under a lit hull.
// wf4: tracks lifted back to a soft dark grey (~25% darker than the hull
// deck, as in ref_cc3_1483); wheels slightly lighter than the run.
const TRACK_DARK = '#3a3a34';
const TRACK_LIGHT = '#57554d';
const WHEEL_RIM = '#4a4840';
const GRILLE = '#201f1c';
const HATCH = '#d8d2b8';
const MARK_WHITE = '#eceae0';
const MARK_BLACK = '#100f0c';
const MARK_RED = '#c8402c';
const SOOT = 'rgba(8,7,6,0.55)';
const MUD_DARK = '#141210';
const JERRYCAN = '#3a4a30';
const JERRYCAN_LIGHT = '#526a41';

function colorMapFor(palIn: VehPalette, lift = 0): Record<string, string> {
  const pal: VehPalette = lift ? { ...palIn, hullMid: shade(palIn.hullMid, lift), hullLight: shade(palIn.hullLight, lift), hullDark: shade(palIn.hullDark, lift) } : palIn;
  // Round-3: an extra-bright "hot" specular tone, 25% brighter again than
  // the standard hull highlight — used for the barrel's top-edge highlight
  // line and the NW-quarter hot-spot on the hull glacis / turret roof, so
  // those specific specular cues pop harder than the general NW-lit hull
  // face they sit on.
  const hot = shade(pal.hullLight, 0.25);
  return {
    o: shade(pal.hullDark, -0.45), t: TRACK_DARK, T: TRACK_LIGHT, w: WHEEL_RIM, W: pal.hullLight,
    // wf19: the big NW-lit / SE-shadowed swing is no longer baked (it rotated with the hull and
    // lit south-facing tanks from the SE); plates keep only a slight painterly variation and the
    // directional light is added at draw time from the VehiclePartArt light overlays.
    h: pal.hullMid, H: shade(pal.hullMid, 0.1), d: shade(pal.hullMid, -0.1), g: GRILLE, x: HATCH,
    // Barrel reads as a lit cylinder: bright top edge, mid body, dark underside.
    B: hot, b: pal.hullMid, n: pal.hullDark, k: shade(pal.hullDark, -0.3),
    m: MARK_WHITE, c: MARK_BLACK, r: MARK_RED,
    a: pal.camoBand ?? pal.hullDark,
    s: 'rgba(6,6,4,0.4)',
    u: MUD_DARK, j: JERRYCAN, J: JERRYCAN_LIGHT,
    N: hot,
    v: shade(pal.hullDark, -0.35),
  };
}

/** Paint a gun barrel as a lit cylinder: 1px light top edge, mid body, 1px
 * dark underside (for width>=3); a 2px barrel gets just light/dark. Applies
 * a muzzle-brake block at the tip when requested. */
function paintBarrel(g: Grid, cx: number, len: number, widthPx: number, muzzleBrake?: boolean, s = 1): void {
  if (s >= 2) { paintBarrel2x(g, cx, len, widthPx, muzzleBrake); return; }
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

/** 2x barrel: a crisp 4-tone cylinder (hot top edge, two body tones, dark
 * underside), a dark bore at the muzzle, a thin collar where the barrel
 * steps down, and — when fitted — a double-baffle muzzle brake with its
 * vent slots cut through. */
function paintBarrel2x(g: Grid, cx: number, len: number, widthPx: number, muzzleBrake?: boolean): void {
  const w = Math.max(3, widthPx);
  const left = cx - Math.floor((w - 1) / 2);
  for (let y = 0; y < len; y++) {
    for (let i = 0; i < w; i++) {
      const ch = i === 0 ? 'B' : i === w - 1 ? 'n' : i === 1 ? 'b' : 'h';
      put(g, left + i, y, ch);
    }
  }
  // Collar two-thirds of the way back (where a real gun tube steps up).
  const collarY = Math.round(len * 0.62);
  if (collarY > 6 && collarY < len - 2) {
    put(g, left - 1, collarY, 'o'); put(g, left + w, collarY, 'o');
    for (let i = 0; i < w; i++) put(g, left + i, collarY, i === 0 ? 'N' : 'n');
  }
  if (muzzleBrake && len >= 8) {
    const bl = left - 1, br = left + w;
    for (let y = 0; y < 6; y++) {
      for (let x = bl; x <= br; x++) {
        const edge = x === bl || x === br;
        put(g, x, y, y === 2 || y === 3 ? (edge ? 'k' : 'n') : edge ? 'o' : x === bl + 1 ? 'B' : 'b');
      }
    }
    put(g, bl, 2, '.'); put(g, br, 2, '.');
  }
  // Bore.
  for (let i = 1; i < w - 1; i++) put(g, left + i, 0, 'k');
}

/** 2x-only rivet row: a dark rivet head with a hot NW glint every `step` px
 * along a horizontal or vertical run. */
function rivetRow(g: Grid, x0: number, y0: number, x1: number, y1: number, step: number): void {
  const horiz = y0 === y1;
  const n = horiz ? x1 - x0 : y1 - y0;
  for (let i = 0; i <= n; i += step) {
    const x = horiz ? x0 + i : x0, y = horiz ? y0 : y0 + i;
    if (y < 0 || y >= g.length || x < 0 || x >= g[0].length || g[y][x] === '.') continue;
    put(g, x, y, 'v');
  }
}

/** 2x-only weld seam: a dark line with a lit pixel row just north of it. */
function weldLine(g: Grid, x0: number, x1: number, y: number): void {
  for (let x = x0; x <= x1; x++) {
    if (y < 1 || y >= g.length || g[y][x] === '.' || g[y][x] === 'x' || g[y][x] === 'o') continue;
    put(g, x, y, 'd');
    if (g[y - 1][x] !== '.' && g[y - 1][x] !== 'o') put(g, x, y - 1, (x + y) % 3 === 0 ? 'N' : 'H');
  }
}

// ---------------------------------------------------------- hull families -
type HullFamily = 'boxy' | 'sloped' | 'slab' | 'light' | 'casemate' | 'halftrack';

/** Punch a small hinge tick (a 1px dark dot just outside one edge of a
 * hatch) so hatches read as hinged panels rather than flat decals. */
function drawHatchWithHinge(g: Grid, x0: number, y0: number, x1: number, y1: number, hinge: 'n' | 's' | 'e' | 'w', s = 1): void {
  if (s >= 2) {
    // Rimmed hatch: dark frame, lit NW inner rim, shaded SE inner rim, plate
    // with a dark grab handle, and 2px hinge blocks on the hinge side.
    fillRect(g, x0, y0, x1, y1, 'h');
    strokeRect(g, x0, y0, x1, y1, 'o');
    for (let x = x0 + 1; x < x1; x++) { put(g, x, y0 + 1, 'N'); put(g, x, y1 - 1, 'd'); }
    for (let y = y0 + 1; y < y1; y++) { put(g, x0 + 1, y, 'N'); put(g, x1 - 1, y, 'd'); }
    const mx = Math.floor((x0 + x1) / 2), my = Math.floor((y0 + y1) / 2);
    put(g, mx, my, 'k'); put(g, mx + 1, my, 'k');
    if (hinge === 'n' || hinge === 's') {
      const hy = hinge === 'n' ? y0 - 1 : y1 + 1;
      fillRect(g, x0 + 1, hy, x0 + 2, hy, 'o'); fillRect(g, x1 - 2, hy, x1 - 1, hy, 'o');
    } else {
      const hx = hinge === 'w' ? x0 - 1 : x1 + 1;
      fillRect(g, hx, y0 + 1, hx, y0 + 2, 'o'); fillRect(g, hx, y1 - 2, hx, y1 - 1, 'o');
    }
    return;
  }
  fillRect(g, x0, y0, x1, y1, 'x');
  strokeRect(g, x0, y0, x1, y1, 'o');
  if (hinge === 'n') { put(g, x0, y0 - 1, 'o'); put(g, x1, y0 - 1, 'o'); }
  else if (hinge === 's') { put(g, x0, y1 + 1, 'o'); put(g, x1, y1 + 1, 'o'); }
  else if (hinge === 'w') { put(g, x0 - 1, y0, 'o'); put(g, x0 - 1, y1, 'o'); }
  else { put(g, x1 + 1, y0, 'o'); put(g, x1 + 1, y1, 'o'); }
}

/** A small stowed jerrycan (dark body, light top rim) — Soviet crews lashed
 * spare fuel cans to the rear deck. */
function drawJerrycan(g: Grid, cx: number, cy: number, s = 1): void {
  if (s >= 2) {
    fillRect(g, cx - 2, cy - 3, cx + 1, cy + 2, 'j');
    strokeRect(g, cx - 2, cy - 3, cx + 1, cy + 2, 'o');
    put(g, cx - 1, cy - 2, 'J'); put(g, cx, cy - 2, 'J');
    put(g, cx - 1, cy, 'o'); put(g, cx, cy - 1, 'o');
    return;
  }
  fillRect(g, cx - 1, cy - 1, cx, cy + 1, 'j');
  put(g, cx - 1, cy - 1, 'J');
}

/** A small tool box (dark box with a lighter lid edge) bolted to the hull
 * side, above the track run. */
function drawToolbox(g: Grid, x0: number, y0: number, w: number, h: number, s = 1): void {
  if (s >= 2) { w *= s; h *= s; }
  fillRect(g, x0, y0, x0 + w - 1, y0 + h - 1, 'd');
  strokeRect(g, x0, y0, x0 + w - 1, y0 + h - 1, 'o');
  fillRect(g, x0, y0, x0 + w - 1, y0, 'H');
}

/** A strip of spare track links stowed across the German glacis plate —
 * alternating tread-dark/tread-light segments cutting across the lighter
 * glacis tone. */
function drawSpareTrackStrip(g: Grid, x0: number, x1: number, y: number, s = 1): void {
  if (s >= 2) {
    for (let x = x0; x <= x1; x++) {
      const k = (x - x0) % 4;
      put(g, x, y - 1, k === 3 ? 'o' : 't');
      put(g, x, y, k === 3 ? 'o' : k === 1 ? 'T' : 't');
    }
    return;
  }
  for (let x = x0; x <= x1; x++) put(g, x, y, (x - x0) % 2 === 0 ? 't' : 'T');
}

interface HullOpts { wide?: boolean; taper?: number; light?: boolean; side?: Side; s?: number }

/** 2x track run: individual links (3px plate + 1px dark gap) with a lit
 * centre guide horn per link and dark outer edge columns. */
function paintTrackRun2x(g: Grid, x0: number, x1: number, y0: number, y1: number): void {
  const mid = Math.floor((x0 + x1) / 2);
  for (let y = y0; y < y1; y++) {
    const k = y % 4;
    for (let x = x0; x <= x1; x++) {
      let ch = k === 3 ? 'o' : 't';
      if (k === 1 && x !== x0 && x !== x1) ch = 'T';
      if ((x === mid || x === mid + 1) && k !== 3) ch = k === 0 ? 'T' : 'w';
      if (x === x0 || x === x1) ch = k === 3 ? 'o' : 'u';
      put(g, x, y, ch);
    }
  }
}

/** Shared tracked-hull skeleton (tracks + wheels + hull deck with NW/SE
 * shading, glacis plate, driver hatch, rear grille/exhaust hatch) used by
 * the boxy, sloped, slab and light families — they differ only in nose
 * taper and proportions. */
function buildTrackedSkeleton(w: number, h: number, opts: HullOpts): Grid {
  const g = blank(w, h);
  const s = opts.s ?? 1;
  const trackW = Math.max(2, Math.round(w * (opts.wide ? 0.3 : 0.24)));
  if (s >= 2) {
    paintTrackRun2x(g, 0, trackW - 1, 0, h);
    paintTrackRun2x(g, w - trackW, w - 1, 0, h);
  } else {
    for (let y = 0; y < h; y++) {
      const tread = Math.floor(y / 2) % 2 === 0 ? 't' : 'T';
      for (let x = 0; x < trackW; x++) { g[y][x] = tread; g[y][w - 1 - x] = tread; }
    }
  }
  const wheelCount = opts.light ? 4 : Math.max(5, Math.min(8, Math.round(h / s / (opts.wide ? 7 : 5.5))));
  for (let i = 0; i < wheelCount; i++) {
    const cy = Math.round((i + 0.5) * (h / wheelCount));
    // 2x: sprocket/idler-style alternating inner and outer wheel rows so the
    // wheels peek out from under the track guard instead of a solid column.
    const inset = s >= 2 ? Math.floor(trackW / 2) - (i % 2) : Math.floor(trackW / 2);
    drawWheel(g, inset, cy, trackW, s);
    drawWheel(g, w - 1 - inset, cy, trackW, s);
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
  const midX = Math.floor((bx0 + bx1) / 2);
  const deckH = Math.max(3 * s, Math.round(h * 0.14));
  const deckY0 = h - deckH;
  if (s >= 2) {
    // Headlights: small lit lenses in dark housings.
    for (const hx of [bx0 + 4, bx1 - 5]) { fillRect(g, hx, glacisH - 3, hx + 1, glacisH - 2, 'x'); put(g, hx + 1, glacisH - 2, 'o'); }
    weldLine(g, bx0 + 1, bx1 - 1, glacisH);
    weldLine(g, bx0 + 1, bx1 - 1, deckY0 - 2);
    rivetRow(g, bx0 + 2, glacisH + 3, bx0 + 2, deckY0 - 4, 5);
    rivetRow(g, bx1 - 2, glacisH + 3, bx1 - 2, deckY0 - 4, 5);
    rivetRow(g, bx0 + 3, 2, bx1 - 3, 2, 5);
    if (opts.side === 'german' && bx1 - bx0 > 16) drawSpareTrackStrip(g, bx0 + 5, bx1 - 5, Math.max(1, glacisH - 5), s);
    drawHatchWithHinge(g, midX - 7, glacisH + 5, midX - 1, glacisH + 10, 'w', s);
    drawHatchWithHinge(g, midX + 1, glacisH + 5, midX + 7, glacisH + 10, 'e', s);
    // Engine deck: louvred grille slats, each a dark slot with a lit lip.
    const slats = 5;
    for (let i = 0; i < slats; i++) {
      const y = deckY0 + 1 + Math.round((i * (deckH - 6)) / slats);
      if (y > 0 && y < h - 6) { fillRect(g, bx0 + 4, y, bx1 - 4, y, 'g'); fillRect(g, bx0 + 4, y + 1, bx1 - 4, y + 1, 'H'); }
    }
    drawHatchWithHinge(g, midX - 4, h - 6, midX + 4, h - 2, 's', s);
    // Twin exhaust stubs at the tail.
    fillRect(g, bx0 + 2, h - 4, bx0 + 3, h - 2, 'k'); fillRect(g, bx1 - 3, h - 4, bx1 - 2, h - 2, 'k');
    if (bw > 20) drawToolbox(g, bx0 + 2, Math.round(h * 0.58), 2, 3, s);
    if (opts.side === 'soviet' && bw > 20) {
      drawJerrycan(g, bx1 - 4, h - Math.round(deckH * 1.6), s);
      drawJerrycan(g, bx1 - 4, h - Math.round(deckH * 0.6) - 2, s);
    }
  } else {
    put(g, bx0 + 2, glacisH - 1, 'x');
    put(g, bx1 - 2, glacisH - 1, 'x');
    if (opts.side === 'german' && bx1 - bx0 > 8) drawSpareTrackStrip(g, bx0 + 3, bx1 - 3, Math.max(0, glacisH - 2));
    drawHatchWithHinge(g, midX - 1, glacisH + 3, midX + 1, glacisH + 4, 'w');
    // Engine deck: exactly 3 dark grille slats plus an exhaust hatch, and a
    // stowed toolbox on the hull side above the track run.
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
  }
  for (let x = 0; x < w; x++) { g[0][x] = 'o'; g[h - 1][x] = 'o'; }
  for (let y = 0; y < h; y++) { g[y][0] = 'o'; g[y][w - 1] = 'o'; }
  return g;
}

function buildBoxyHull(w: number, h: number, wide: boolean, side: Side, s = 1): Grid {
  return buildTrackedSkeleton(w, h, { wide, side, s });
}
function buildSlopedHull(w: number, h: number, side: Side, s = 1): Grid {
  return buildTrackedSkeleton(w, h, { taper: 0.32, side, s });
}
function buildSlabHull(w: number, h: number, side: Side, s = 1): Grid {
  const g = buildTrackedSkeleton(w, h, { wide: true, taper: 0.08, side, s });
  // Slab-sided KV-1: bolt-on fuel drums at the rear flanks.
  const w2 = g[0].length;
  fillRect(g, Math.round(w2 * 0.24), h - Math.round(h * 0.2), Math.round(w2 * 0.24) + 1, h - Math.round(h * 0.14), 'H');
  fillRect(g, Math.round(w2 * 0.7), h - Math.round(h * 0.2), Math.round(w2 * 0.7) + 1, h - Math.round(h * 0.14), 'H');
  return g;
}
function buildLightHull(w: number, h: number, side: Side, s = 1): Grid {
  return buildTrackedSkeleton(w, h, { light: true, taper: 0.14, side, s });
}

/** Half-track: wheeled tapered nose, tracked rear two-thirds, open troop bay
 * (never a turret ring — must never read as a tank). */
function buildHalftrackHull(w: number, h: number, s = 1): Grid {
  const g = blank(w, h);
  const noseH = Math.round(h * 0.2);
  const bx0 = Math.round(w * 0.12), bx1 = w - 1 - Math.round(w * 0.12);
  const half = Math.round((bx1 - bx0) / 2);
  for (let y = 0; y < noseH; y++) {
    const cut = Math.round(half * (1 - y / noseH));
    for (let x = bx0 + cut; x <= bx1 - cut; x++) g[y][x] = 'd';
  }
  drawWheel(g, bx0 + Math.round(half * 0.15), noseH - 1, 3 * s, s);
  drawWheel(g, bx1 - Math.round(half * 0.15), noseH - 1, 3 * s, s);
  const bayY0 = noseH + 1, bayY1 = h - Math.max(2, Math.round(h * 0.14));
  shadeRect(g, bx0, bayY0, bx1, bayY1);
  strokeRect(g, bx0, bayY0, bx1, bayY1, 'o');
  // Open troop bay: exactly 4 crew helmet dots (2x2), visible from above.
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const x = Math.round(bx0 + (bx1 - bx0) * (0.3 + col * 0.4));
      const y = Math.round(bayY0 + (bayY1 - bayY0) * (0.35 + row * 0.35));
      if (s >= 2) {
        // Crew helmet: dark rim, mid dome, NW glint.
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const d = Math.hypot(dx, dy);
          if (d <= 2.2) put(g, x + dx, y + dy, d > 1.4 ? 'o' : 'j');
        }
        put(g, x - 1, y - 1, 'J');
      } else put(g, x, y, 'x');
    }
  }
  // Pintle-mounted MG shield at the front of the bay, with the barrel
  // poking forward over the nose.
  const midX = Math.floor((bx0 + bx1) / 2);
  fillRect(g, midX - 2 * s, bayY0, midX + 2 * s, bayY0 + s, 'd');
  strokeRect(g, midX - 2 * s, bayY0, midX + 2 * s, bayY0 + s, 'o');
  if (s >= 2) {
    fillRect(g, midX, noseH - 2, midX + 1, bayY0 - 1, 'k');
    put(g, midX, noseH - 2, 'B');
  } else {
    put(g, midX, bayY0 - 1, 'b');
    put(g, midX + 1, noseH, 'b');
  }
  // Rear engine deck (between the bay and the tail) — solid hull tone with
  // 3 dark grille slats and an exhaust hatch, not floating on transparent.
  shadeRect(g, bx0, bayY1 + 1, bx1, h - 2);
  const deckH = Math.max(1, h - 2 - (bayY1 + 1));
  for (let i = 0; i < 3; i++) {
    const y = bayY1 + 1 + Math.round(((i + 0.5) * deckH) / 3);
    if (y > bayY1 && y < h - 1) fillRect(g, bx0 + 2 * s, y, bx1 - 2 * s, y, 'g');
  }
  if (s >= 2) {
    weldLine(g, bx0 + 1, bx1 - 1, noseH);
    rivetRow(g, bx0 + 2, bayY0 + 2, bx0 + 2, bayY1 - 2, 5);
    rivetRow(g, bx1 - 2, bayY0 + 2, bx1 - 2, bayY1 - 2, 5);
    drawHatchWithHinge(g, midX - 4, h - 6, midX + 4, h - 2, 's', s);
  } else drawHatchWithHinge(g, midX - 2, h - 3, midX + 2, h - 2, 's');
  const trackW = Math.max(2, Math.round(w * 0.2));
  if (s >= 2) {
    paintTrackRun2x(g, 0, trackW - 1, noseH, h);
    paintTrackRun2x(g, w - trackW, w - 1, noseH, h);
  } else {
    for (let y = noseH; y < h; y++) {
      const tread = Math.floor(y / 2) % 2 === 0 ? 't' : 'T';
      for (let x = 0; x < trackW; x++) { g[y][x] = tread; g[y][w - 1 - x] = tread; }
    }
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
  opts: { muzzleBrake?: boolean; taper?: number; side?: Side; s?: number } = {},
): Grid {
  const s = opts.s ?? 1;
  const body = buildTrackedSkeleton(w, h, { taper: opts.taper, side: opts.side, s });
  const boxH = Math.round(h * 0.46);
  const bx0 = Math.round(w * 0.16), bx1 = w - 1 - Math.round(w * 0.16);
  shadeRect(body, bx0, 1, bx1, boxH);
  strokeRect(body, bx0, 1, bx1, boxH, 'd');
  const midX = Math.floor((bx0 + bx1) / 2);
  if (s >= 2) {
    drawHatchWithHinge(body, midX + 3, 7, midX + 10, 13, 'n', s);
    drawHatchWithHinge(body, midX - 10, 9, midX - 4, 14, 'n', s);
    rivetRow(body, bx0 + 2, 3, bx1 - 2, 3, 4);
    // Gun mantlet boss where the barrel leaves the superstructure.
    fillRect(body, midX - 4, 1, midX + 4, 5, 'd');
    strokeRect(body, midX - 4, 1, midX + 4, 5, 'o');
    fillRect(body, midX - 3, 2, midX - 1, 2, 'N');
  } else drawHatchWithHinge(body, midX - 1, 3, midX + 1, 4, 'n');
  const barrel = blank(w, barrelLenPx);
  paintBarrel(barrel, midX, barrelLenPx, barrelWpx, opts.muzzleBrake, s);
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
function drawCupola(g: Grid, cx: number, cy: number, r: number, s = 1): void {
  if (s >= 2) {
    // Cupola: dark outer ring broken by lit vision blocks, a lit/shadowed
    // hatch disc with a hinge bar across it.
    const R = Math.max(3, r);
    for (let dy = -R - 1; dy <= R + 1; dy++) {
      for (let dx = -R - 1; dx <= R + 1; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > R + 0.45) continue;
        if (d > R - 0.8) {
          const a = Math.atan2(dy, dx);
          const block = Math.floor(((a + Math.PI) / (2 * Math.PI)) * 14) % 2 === 0;
          put(g, cx + dx, cy + dy, block ? 'N' : 'o');
        } else if (d > R - 1.8) put(g, cx + dx, cy + dy, 'o');
        else put(g, cx + dx, cy + dy, dx + dy < 0 ? 'H' : 'd');
      }
    }
    fillRect(g, cx - R + 2, cy, cx + R - 2, cy, 'o');
    put(g, cx - 1, cy - 1, 'N');
    return;
  }
  const ri = Math.max(1, r);
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > ri + 0.4) continue;
      put(g, cx + dx, cy + dy, d > ri - 0.6 ? 'o' : 'x');
    }
  }
}

function buildTurretGrid(tw: number, bodyH: number, barrelLenPx: number, barrelWpx: number, opts: TurretOpts, s = 1): Grid {
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
  outlineFill(g, 'd');
  if (s >= 2) {
    // Crisp dark silhouette outside the shaded edge, then a rivet ring
    // inset from it and a weld seam where the bustle meets the body.
    const orig = g.map((r) => r.slice());
    for (let y = 0; y < g.length; y++) for (let x = 0; x < tw; x++) {
      if (orig[y][x] !== 'd') continue;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => (orig[y + dy]?.[x + dx] ?? '.') === '.');
      if (edge) g[y][x] = 'o';
    }
    const cyB = barrelLenPx + bodyH / 2;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const x = Math.round(cx - 0.5 + Math.cos(a) * (tw / 2 - 3)), y = Math.round(cyB + Math.sin(a) * (bodyH / 2 - 3));
      if (g[y]?.[x] && g[y][x] !== '.' && g[y][x] !== 'o') put(g, x, y, 'v');
    }
    if (bustle > 0) weldLine(g, 2, tw - 3, barrelLenPx + bodyH);
    // Loader's hatch on the opposite side of the roof to the cupola.
    const hx = Math.floor(cx - tw * 0.2), hy = barrelLenPx + Math.floor(bodyH * 0.42);
    drawHatchWithHinge(g, hx - 3, hy - 3, hx + 3, hy + 3, 'w', s);
    // Vent / periscope on the roof front.
    fillRect(g, Math.floor(cx) + 3, barrelLenPx + 4, Math.floor(cx) + 5, barrelLenPx + 5, 'k');
  }
  // Barrel, extending "north" off the top of the turret body, as a lit
  // cylinder (light top edge / mid body / dark underside).
  const bcx = Math.floor(cx);
  paintBarrel(g, bcx, barrelLenPx, barrelWpx, opts.muzzleBrake, s);
  if (opts.mantletWpx) {
    // Mantlet reads as a darker armored block bolted to the turret front.
    const my0 = Math.max(0, barrelLenPx - 2 * s);
    const mx0 = bcx - Math.floor(opts.mantletWpx / 2), mx1 = bcx + Math.floor(opts.mantletWpx / 2);
    fillRect(g, mx0, my0, mx1, my0 + 3 * s - 1, 'd');
    strokeRect(g, mx0, my0, mx1, my0 + 3 * s - 1, s >= 2 ? 'o' : 'd');
    if (s >= 2) { fillRect(g, mx0 + 1, my0 + 1, mx1 - 1, my0 + 1, 'H'); put(g, mx0 + 1, my0 + 3, 'v'); put(g, mx1 - 1, my0 + 3, 'v'); }
  }
  if (opts.cupola) {
    const r = Math.max(1, Math.round(tw * 0.09));
    drawCupola(g, Math.floor(cx + tw * 0.18), barrelLenPx + Math.floor(bodyH * 0.5), r, s);
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

/** Two-pass box blur of an alpha mask (Float32, 0..1), radius r px. */
function blurMask(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w) acc += src[y * w + x + r];
      if (x - r - 1 >= 0) acc -= src[y * w + x - r - 1];
      if (x >= 0) tmp[y * w + x] = acc / win;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h) acc += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * w + x];
      if (y >= 0) out[y * w + x] = acc / win;
    }
  }
  return out;
}

/** Padded (HULL_PAD) silhouette mask of a grid. */
function silhouette(g: Grid, pad: number): { m: Float32Array; cw: number; ch: number } {
  const w = g[0].length, h = g.length;
  const cw = w + pad * 2, ch = h + pad * 2;
  const m = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y][x] !== '.') m[(y + pad) * cw + x + pad] = 1;
  return { m, cw, ch };
}

function maskToCanvas(m: Float32Array, cw: number, ch: number, rgb: [number, number, number], alpha: number): HTMLCanvasElement {
  const c = createCanvas(cw, ch);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(cw, ch);
  for (let i = 0; i < m.length; i++) {
    if (m[i] <= 0.004) continue;
    const o = i * 4;
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2];
    img.data[o + 3] = Math.min(255, Math.round(m[i] * alpha * 255));
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const TRACK_CHARS = new Set(['t', 'T', 'w', 'u']);

function hash2i(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** wf19 weathering, painted only over the vehicle's own pixels: pale dust on the running gear
 * and the lower hull ends (heavier toward the rear, where the tracks throw it), and dark exhaust
 * stains streaking back over the rear deck. */
function applyWeathering(ctx: CanvasRenderingContext2D, g: Grid, s: number, seed: number, exhaust: boolean): void {
  const w = g[0].length, h = g.length;
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  for (let y = 0; y < h; y++) {
    const rear = y / h;
    for (let x = 0; x < w; x++) {
      const chr = g[y][x];
      if (chr === '.') continue;
      const n = hash2i(Math.floor(x / s), Math.floor(y / s), seed);
      let a = 0;
      if (TRACK_CHARS.has(chr)) a = 0.03 + 0.1 * rear * rear + (n > 0.72 ? 0.12 : 0);
      else if (exhaust && (rear > 0.9 || rear < 0.05)) a = 0.12 + (n > 0.6 ? 0.1 : 0);
      else if (n > 0.93) a = 0.1;
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(168,150,108,${a.toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  if (exhaust) {
    for (const fx of [0.3, 0.7]) {
      const cx = w * fx, cy = h * 0.87;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.2);
      grad.addColorStop(0, 'rgba(10,9,8,0.72)');
      grad.addColorStop(0.5, 'rgba(10,9,8,0.34)');
      grad.addColorStop(1, 'rgba(10,9,8,0)');
      ctx.fillStyle = grad;
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(1, 1.7); ctx.translate(-cx, -cy);
      ctx.beginPath(); ctx.arc(cx, cy, w * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

interface ComposeOpts { ao?: boolean; weatherSeed?: number; exhaust?: boolean }

function gridToCanvas(g: Grid, colorMap: Record<string, string>, s = 1, opts: ComposeOpts = {}): HTMLCanvasElement {
  const w = g[0].length, h = g.length;
  const pad = HULL_PAD * s;
  const cw = w + pad * 2, ch = h + pad * 2;
  const c = createCanvas(cw, ch);
  const ctx = ctx2d(c);
  if (opts.ao) {
    // Ambient-occlusion ring: a tight dark blur of the silhouette under the hull, so the vehicle
    // sits IN the ground instead of floating on it. (The offset cast shadow is a separate
    // sprite drawn in screen space — see buildVehiclePart.)
    const sil = silhouette(g, pad);
    ctx.drawImage(maskToCanvas(blurMask(sil.m, cw, ch, s + 1), cw, ch, [10, 10, 8], 0.85), 0, 0);
  }
  ctx.save();
  ctx.translate(pad, pad);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch2 = g[y][x];
      if (ch2 === '.') continue;
      ctx.fillStyle = colorMap[ch2] ?? '#ff00ff';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  if (opts.weatherSeed != null) applyWeathering(ctx, g, s, opts.weatherSeed, !!opts.exhaust);
  ctx.restore();
  return c;
}

/** One directional light overlay for a grid: white (lit) / black (shaded) alpha pixels for light
 * arriving from local direction (lx,ly) (unit axis vector pointing TOWARD the light):
 *  - a soft cross-hull ramp (lit half brighter, far half darker) => the top plates read as a volume;
 *  - a bright bevel on the silhouette / deck edge facing the light, a dark one on the far edge;
 *  - the raised deck's shadow falling on the running gear on the far side.
 * unitRender blends the two overlays facing the world NW light by the hull's current rotation. */
function lightOverlay(g: Grid, s: number, lx: number, ly: number, strength: number): HTMLCanvasElement {
  const w = g[0].length, h = g.length;
  const pad = HULL_PAD * s;
  const c = createCanvas(w + pad * 2, h + pad * 2);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(c.width, c.height);
  const bevel = 2 * s;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? '.' : g[y][x]);
  const level = (chr: string) => (chr === '.' ? 0 : TRACK_CHARS.has(chr) ? 1 : 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const chr = g[y][x];
      if (chr === '.') continue;
      const lv = level(chr);
      // ramp: -1 (far side) .. 1 (lit side)
      const t = lx * (((x + 0.5) / w) * 2 - 1) + ly * (((y + 0.5) / h) * 2 - 1);
      let v = t * (t > 0 ? 0.2 : 0.26);
      for (let k = 1; k <= bevel; k++) {
        const f = 1 - (k - 1) / bevel;
        const toward = level(at(x + lx * k, y + ly * k));
        const away = level(at(x - lx * k, y - ly * k));
        if (toward < lv) { v += 0.46 * f; break; }
        if (away > lv) { v -= 0.42 * f; break; }     // running gear in the shadow of the raised deck
        if (away < lv) { v -= 0.4 * f; break; }
      }
      v *= strength;
      const o = ((y + pad) * c.width + x + pad) * 4;
      const col = v > 0 ? 255 : 0;
      img.data[o] = col; img.data[o + 1] = col; img.data[o + 2] = v > 0 ? 244 : 8;
      img.data[o + 3] = Math.min(255, Math.round(Math.abs(v) * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Everything unitRender needs to draw one vehicle part as a lit volume on the ground. */
export interface VehiclePartArt {
  /** The part itself (hull: with its ambient-occlusion ring baked under it), pivot at centre. */
  body: HTMLCanvasElement;
  /** Soft silhouette shadow, same size/pivot as `body`: drawn rotated like the body but
   * translated `shadowOffset` px (1x) to the screen SE. */
  shadow: HTMLCanvasElement;
  /** Shadow throw in 1x px along each screen axis (scaled to the vehicle's height). */
  shadowOffset: number;
  /** Light overlays for light arriving from the part's local west / east / north / south. */
  light: { w: HTMLCanvasElement; e: HTMLCanvasElement; n: HTMLCanvasElement; s: HTMLCanvasElement };
}

/** Number of pre-rendered rotations per vehicle part (5.6 degree steps). */
export const VEHICLE_FACINGS = 64;

/** wf19: one ready-to-blit frame of a part at rotation step `step` (of VEHICLE_FACINGS): the soft
 * cast shadow thrown to the SCREEN south-east, the body rotated to the step's angle, and the two
 * light overlays that face the screen-NW light at that angle, weighted by how squarely they face
 * it. Square canvas, pivot at the exact centre, `scale` px per 1x px. Pre-rendering the frames
 * (cached by sprites.ts) makes a lit, shadowed vehicle cost one unrotated blit per part — cheaper
 * than the two rotated blits the flat sprites used to cost. */
export function composeVehicleFrame(art: VehiclePartArt, step: number, scale: number, shadowAlpha = 1): HTMLCanvasElement {
  const sc = scale >= 2 ? 2 : 1;
  const rad = (step / VEHICLE_FACINGS) * Math.PI * 2;
  const bw = art.body.width, bh = art.body.height;
  const off = art.shadowOffset * sc;
  const half = Math.ceil(Math.hypot(bw, bh) / 2 + off) + 1;
  const c = createCanvas(half * 2, half * 2);
  const ctx = ctx2d(c);
  if (off > 0) {
    ctx.save();
    ctx.globalAlpha = shadowAlpha;
    ctx.translate(half + off, half + off);
    ctx.rotate(rad);
    ctx.drawImage(art.shadow, -bw / 2, -bh / 2);
    ctx.restore();
  }
  const cs = Math.cos(rad), sn = Math.sin(rad);
  // unit vector toward the light (screen NW) expressed in the part's local frame
  const lx = (-cs - sn) * Math.SQRT1_2, ly = (sn - cs) * Math.SQRT1_2;
  ctx.save();
  ctx.translate(half, half);
  ctx.rotate(rad);
  ctx.drawImage(art.body, -bw / 2, -bh / 2);
  const ax = Math.abs(lx), ay = Math.abs(ly);
  if (ax > 0.02) { ctx.globalAlpha = ax; ctx.drawImage(lx < 0 ? art.light.w : art.light.e, -bw / 2, -bh / 2); }
  if (ay > 0.02) { ctx.globalAlpha = ay; ctx.drawImage(ly < 0 ? art.light.n : art.light.s, -bw / 2, -bh / 2); }
  ctx.restore();
  return c;
}

/** Approximate overall heights (m): drives the length of the cast shadow. */
const HEIGHT_M: Record<string, number> = {
  pz3j: 2.5, pz4f1: 2.68, pz4gh: 2.68, stug3g: 2.16, panther: 2.99, tiger: 3.0, sdkfz251: 1.75, marder3: 2.48,
  t26: 2.24, bt7: 2.42, t34_76: 2.45, t34_85: 2.7, kv1: 2.71, is2: 2.73, t70: 2.04, su76: 2.1, su85: 2.45,
};
/** Height of the hull deck alone (what the hull's own shadow is cast from) and turret above it. */
export function vehicleHeightM(defId: string): number { return HEIGHT_M[defId] ?? 2.5; }

function partExtras(g: Grid, s: number, shadowOffset: number, lightStrength: number): Omit<VehiclePartArt, 'body'> {
  const pad = HULL_PAD * s;
  const sil = silhouette(g, pad);
  const shadow = maskToCanvas(blurMask(sil.m, sil.cw, sil.ch, 2 * s), sil.cw, sil.ch, [6, 8, 14], 0.7);
  return {
    shadow, shadowOffset,
    light: {
      w: lightOverlay(g, s, -1, 0, lightStrength), e: lightOverlay(g, s, 1, 0, lightStrength),
      n: lightOverlay(g, s, 0, -1, lightStrength), s: lightOverlay(g, s, 0, 1, lightStrength),
    },
  };
}

/** Scorch + dent + ember pass shared by hull and turret knocked-out states.
 * Burning (flame/smoke animation) is handled elsewhere; this is the static
 * "already been hit" look: soot patches, a few small dark dent rectangles
 * offset off-centre (never a perfectly symmetric hole), thin scorch streaks
 * radiating from the impact, and a small, subdued ember glow. */
function paintScorchAndDent(octx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, s = 1): void {
  octx.fillStyle = SOOT;
  octx.beginPath(); octx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); octx.fill();
  // Dent: a couple of small dark rectangles offset asymmetrically off-centre.
  octx.fillStyle = 'rgba(4,3,2,0.6)';
  octx.fillRect(cx - rx * 0.35, cy - ry * 0.4, Math.max(1, rx * 0.3), Math.max(1, ry * 0.5));
  octx.fillRect(cx + rx * 0.15, cy + ry * 0.1, Math.max(1, rx * 0.22), Math.max(1, ry * 0.35));
  // Scorch streaks radiating from the impact point.
  octx.strokeStyle = 'rgba(15,12,10,0.5)';
  octx.lineWidth = s;
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

function applyKnockedOut(c: HTMLCanvasElement, w: number, h: number, s = 1): HTMLCanvasElement {
  const out = darken(c, 0.42);
  const octx = ctx2d(out);
  octx.save();
  octx.translate(HULL_PAD * s, HULL_PAD * s);
  // Scorch only lands on the vehicle (and its shadow), never on bare ground
  // beside a casemate's overhanging barrel.
  octx.globalCompositeOperation = 'source-atop';
  paintScorchAndDent(octx, w * 0.5, h * 0.42, w * 0.34, h * 0.15, s);
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

export function buildVehicleHull(defId: string, lengthM: number, widthM: number, state: 'ok' | 'knockedOut', scale = 1): HTMLCanvasElement {
  return hullPart(defId, lengthM, widthM, state, scale).canvas;
}

/** Hull or turret with its shadow sprite and light overlays (see VehiclePartArt). */
export function buildVehiclePart(defId: string, part: 'hull' | 'turret', lengthM: number, widthM: number, state: 'ok' | 'knockedOut', scale = 1): VehiclePartArt {
  const sc = scale >= 2 ? 2 : 1;
  const built = part === 'hull' ? hullPart(defId, lengthM, widthM, state, sc) : turretPart(defId, lengthM, widthM, state, sc);
  if (!built.grid) {
    const e = createCanvas(1, 1);
    return { body: built.canvas, shadow: e, shadowOffset: 0, light: { w: e, e, n: e, s: e } };
  }
  const hM = vehicleHeightM(defId);
  const hasTurret = specOf(defId).turret !== 'none';
  // hull: thrown from the deck height (tanks ~60% of overall height); turret: only its own rise
  // above the deck, so its shadow lies short on the hull top and the barrel's on the ground.
  const offset = part === 'hull' ? (hasTurret ? hM * 0.7 : hM * 0.9) * 3 : hM * 0.3 * 3;
  const strength = state === 'knockedOut' ? 0.55 : 1;
  return { body: built.canvas, ...partExtras(built.grid, sc, offset, strength) };
}

function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hullPart(defId: string, lengthM: number, widthM: number, state: 'ok' | 'knockedOut', scale = 1): { canvas: HTMLCanvasElement; grid: Grid | null } {
  const spec = specOf(defId);
  const pal = paletteOf(spec);
  const sc = scale >= 2 ? 2 : 1;
  const w1 = Math.max(6, Math.round(widthM * VEH_PX_PER_M));
  const h1 = Math.max(10, Math.round(lengthM * VEH_PX_PER_M));
  // 2x footprints are exactly double the 1x ones so hull/turret pivots and
  // on-screen size match between zoom levels.
  const w = w1 * sc, h = h1 * sc;
  let grid: Grid;
  if (sc >= 2) {
    // 2x: author directly at the target resolution (no resample), so thin
    // detail — track links, hub bolts, rivets, weld seams — stays 1px crisp.
    if (spec.hullFamily === 'halftrack') grid = buildHalftrackHull(w, h, sc);
    else if (spec.hullFamily === 'casemate') {
      const barrelLenPx = Math.round(h1 * spec.barrelFrac) * sc;
      grid = buildCasemateHull(w, h, barrelLenPx, spec.barrelWpx, { muzzleBrake: spec.muzzleBrake, taper: spec.casemateTaper, side: spec.side, s: sc });
    } else {
      grid = spec.hullFamily === 'boxy' ? buildBoxyHull(w, h, !!spec.wideTracks, spec.side, sc)
        : spec.hullFamily === 'sloped' ? buildSlopedHull(w, h, spec.side, sc)
        : spec.hullFamily === 'slab' ? buildSlabHull(w, h, spec.side, sc)
        : buildLightHull(w, h, spec.side, sc);
    }
  } else if (spec.hullFamily === 'halftrack') {
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
    stampMarking(grid, 0.5, Math.min(0.9, (gh - 4 * sc - (sc >= 2 ? 6 : 0)) / gh), 'cross', sc);
    if (spec.hullFamily !== 'halftrack') stampMarking(grid, 0.25, 0.5, 'cross', sc);
  } else if (spec.side === 'soviet' && spec.hullFamily === 'casemate') {
    // Star on the superstructure side, measured from the body (not the
    // barrel overhang rows) so it never floats beside the gun.
    const bodyTop = Math.round(h1 * spec.barrelFrac) * sc;
    stampMarking(grid, 0.72, (bodyTop + (gh - bodyTop) * 0.34) / gh, 'star', sc);
  }
  const colorMap = colorMapFor(pal);
  // Round-3: SE cast shadow offset pushed from (+3,+4) to (+4,+6) alongside
  // the alpha bump in gridToCanvas, per the critique's stronger-shadow ask.
  let canvas = gridToCanvas(grid, colorMap, sc, { ao: true, weatherSeed: hashStr(defId) % 9973, exhaust: true });
  if (state === 'knockedOut') canvas = applyKnockedOut(canvas, grid[0].length, gh, sc);
  return { canvas, grid };
}

// ----------------------------------------------------------- turret build -
const TURRET_CANON_BODY_H = 22;
const TURRET_CANON_W = 22;

export function buildVehicleTurret(defId: string, lengthM: number, widthM: number, state: 'ok' | 'knockedOut', scale = 1): HTMLCanvasElement {
  return turretPart(defId, lengthM, widthM, state, scale).canvas;
}

function turretPart(defId: string, lengthM: number, widthM: number, state: 'ok' | 'knockedOut', scale = 1): { canvas: HTMLCanvasElement; grid: Grid | null } {
  const spec = specOf(defId);
  if (spec.turret === 'none') return { canvas: createCanvas(1, 1), grid: null };
  const sc = scale >= 2 ? 2 : 1;
  const pal = paletteOf(spec);
  const hullW = Math.max(6, Math.round(widthM * VEH_PX_PER_M));
  const hullH = Math.max(10, Math.round(lengthM * VEH_PX_PER_M));
  const tw1 = Math.max(5, Math.round(hullW * (spec.turretWFrac ?? 0.56)));
  const barrelLen1 = Math.max(2, Math.round(hullH * spec.barrelFrac));
  const isBoxyBody = spec.turret === 'tigerBox' || spec.turret === 'kvBoxy';
  const bodyH1 = spec.turretElongate
    ? Math.max(5, Math.round(tw1 * spec.turretElongate))
    : Math.max(5, Math.round(hullH * (isBoxyBody ? 0.34 : 0.3)));
  const bustle1 = spec.bustle ? Math.round(hullH * 0.14) : 0;
  const tw = tw1 * sc, barrelLenPx = barrelLen1 * sc, bodyH = bodyH1 * sc, bustleHpx = bustle1 * sc;
  const turretOpts: TurretOpts = {
    square: !!spec.turretSquare || spec.turret === 'kvBoxy',
    cupola: spec.turret !== 'sovietRound' || defId === 'is2',
    mantletWpx: spec.mantletWpx ? 5 : undefined,
    bustleHpx: spec.bustle ? 5 : 0,
    muzzleBrake: spec.muzzleBrake,
    wedge: spec.turret === 'pantherLong',
  };

  let grid: Grid;
  const bcx = Math.floor(tw / 2);
  if (sc >= 2) {
    // 2x: author the turret directly at target size with a slim 4px barrel,
    // cupola vision blocks, loader hatch, rivet ring and mantlet bolts.
    grid = buildTurretGrid(tw, bodyH, barrelLenPx, 4, {
      ...turretOpts,
      mantletWpx: spec.mantletWpx ? spec.mantletWpx * sc : undefined,
      bustleHpx,
    }, sc);
  } else {
    // Build at canonical body height then resize body/barrel independently so
    // barrel proportion (thin gun vs. hull length) is preserved across scale.
    const canonGrid = buildTurretGrid(TURRET_CANON_W, TURRET_CANON_BODY_H, 6, 3, turretOpts);
    const canonBarrel = canonGrid.slice(0, 6);
    const canonBody = canonGrid.slice(6);
    const rBarrel = resize(canonBarrel, tw, barrelLenPx);
    const rBody = resize(canonBody, tw, bodyH + bustleHpx);
    grid = [...rBarrel, ...rBody];
    // Re-draw barrel at correct absolute width in real pixels (resize above
    // already blurs the barrel's width toward tw's scale; overwrite with a
    // clean, lit-cylinder bar so it stays bold at 1x regardless of turret size).
    paintBarrel(grid, bcx, barrelLenPx, spec.barrelWpx, spec.muzzleBrake);
    if (spec.mantletWpx) {
      const my0 = Math.max(0, barrelLenPx - 2);
      const mx0 = bcx - Math.floor(spec.mantletWpx / 2), mx1 = bcx + Math.floor(spec.mantletWpx / 2);
      fillRect(grid, mx0, my0, mx1, my0 + 2, 'd');
      strokeRect(grid, mx0, my0, mx1, my0 + 2, 'd');
    }
  }
  if (pal.camoBand) applyCamoBands(grid);
  const bodyCy = barrelLenPx + Math.floor((bodyH + bustleHpx) * 0.45);
  if (spec.side === 'german') stampMarking(grid, 0.5, (bodyCy + (sc >= 2 ? 6 : 0)) / grid.length, 'cross', sc);
  else if (spec.side === 'soviet') stampMarking(grid, 0.5, (barrelLenPx + 2 * sc + (sc >= 2 ? 5 : 0)) / grid.length, 'star', sc);

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

  // wf19: the turret roof sits higher and catches more light than the hull deck => a touch lighter.
  const colorMap = colorMapFor(pal, 0.09);
  let canvas = gridToCanvas(grid, colorMap, sc, { weatherSeed: (hashStr(defId) % 9973) + 17 });
  if (state === 'knockedOut') {
    const w2 = grid[0].length;
    canvas = darken(canvas, 0.42);
    const octx = ctx2d(canvas);
    octx.save();
    octx.translate(HULL_PAD * sc, HULL_PAD * sc);
    octx.globalCompositeOperation = 'source-atop';
    paintScorchAndDent(octx, w2 * 0.5, topPad + bodyCy, w2 * 0.42, (bodyH + bustleHpx) * 0.4, sc);
    octx.restore();
  }
  return { canvas, grid };
}
