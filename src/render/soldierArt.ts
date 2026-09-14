// ============================================================================
// soldierArt.ts — procedural top-down infantry sprites, at 10 px/metre
// (TILE_PX/TILE_M) per sprite scale unit.
//
// wf5: soldiers are no longer hand-placed character grids that get scaled
// with nearest-neighbour. Each stance is a small list of vector-ish shape
// primitives (rects, capsules, a shaded helmet dome, a torso trapezoid)
// authored in "grid units" (1 unit = 1 px at 1x, i.e. 0.1 m). A sprite is
// produced by rasterising that list directly at the requested scale and
// facing: every output pixel centre is inverse-rotated into the north-facing
// pose and the topmost primitive covering it decides its colour.
//
//  - 1x keeps the small, bold silhouette the game has always used.
//  - 2x samples the same shapes at twice the density, and primitives flagged
//    `min: 2` add genuine extra detail that has no room at 1x: 4-5 tone
//    helmet shading, a slim rifle with a lit barrel, wooden fore-stock and
//    butt, bolt handle and sling, laced boots, belt, Y-straps / bedroll,
//    bread bag, hands and forearms.
//  - Diagonal facings are sampled analytically, so the helmet stays round and
//    edges stay clean without the old post-rotation helmet re-stamp.
//  - Lighting (helmet highlight, uniform lit/shadow edges, winter smock SE
//    shade) is evaluated in screen space, so the sun stays NW whatever the
//    soldier's facing.
//  - The dark outline ring, and the halo (enemies) or faint team-colour rim
//    (the player's own soldiers) outside it, are grown on the rasterised grid
//    in output pixels, one ring per scale step, so their on-screen weight is
//    the same at zoom 1 and zoom 2.
// ============================================================================
import type { Side, Season, Stance, Facing8 } from '@/shared/types';
import { createCanvas, ctx2d } from '@/render/pixelUtil';

/** Whose soldier this sprite is, relative to the viewing player. */
export type SoldierOutline = 'friendly' | 'enemy';

// ------------------------------------------------------------ primitives ---
interface OpBase {
  ch: string;
  /** Only rasterised at scale >= min (detail that has no room at 1x). */
  min?: number;
  /** Only rasterised at scale <= max (the chunky 1x stand-in for a detail). */
  max?: number;
}
/** Axis-aligned rect [x0,x1) x [y0,y1). `edge` recolours the 1-output-pixel
 * border facing away from the light; `lit` (2x+) the border facing it.
 * `edgeY` also shades the north/south borders (x borders always shade).
 * `round` trims the corners with a quarter-circle of that radius (2x+). */
interface RectOp extends OpBase { k: 'rect'; x0: number; y0: number; x1: number; y1: number; edge?: string; lit?: string; edgeY?: boolean; round?: number }
/** Capsule (thick line with round caps) of width `w`. */
interface SegOp extends OpBase { k: 'seg'; x0: number; y0: number; x1: number; y1: number; w: number }
/** Ellipse centred at (cx,cy). */
interface EllOp extends OpBase { k: 'ell'; cx: number; cy: number; rx: number; ry: number; edge?: string }
/** Shaded steel helmet dome. */
interface HelmetOp extends OpBase { k: 'helmet'; cx: number; cy: number; r: number; flare: boolean }
/** Torso trapezoid for prone/dead figures: y in [y0,y1), half width
 * interpolated from hw0 at y0 to hw1 at y1 around cx. */
interface TrapOp extends OpBase { k: 'trap'; cx: number; y0: number; y1: number; hw0: number; hw1: number; edge?: string; lit?: string }
type Op = RectOp | SegOp | EllOp | HelmetOp | TrapOp;

interface Figure {
  ops: Op[];
  /** North-pose pivot (sprite centre) in grid units. */
  px: number; py: number;
  /** Max distance of any painted unit from the pivot. */
  extent: number;
}

interface Sampler {
  s: number;
  pix: number; // one output pixel in units
  cos: number; sin: number;
}

const SQRT1_2 = Math.SQRT1_2;

/** How much a unit-space surface normal faces the NW light, once rotated
 * into screen space (-1 = faces away, 1 = faces the light). */
function lightOf(sm: Sampler, nx: number, ny: number): number {
  const sx = nx * sm.cos - ny * sm.sin;
  const sy = nx * sm.sin + ny * sm.cos;
  return -(sx + sy) * SQRT1_2;
}

function sampleOp(op: Op, gx: number, gy: number, sm: Sampler): string | null {
  switch (op.k) {
    case 'rect': {
      if (gx < op.x0 || gx >= op.x1 || gy < op.y0 || gy >= op.y1) return null;
      const dl = gx - op.x0, dr = op.x1 - gx, dt = gy - op.y0, db = op.y1 - gy;
      if (op.round && sm.s >= 2) {
        const r = op.round;
        const cx = dl < r ? op.x0 + r : dr < r ? op.x1 - r : NaN;
        const cy = dt < r ? op.y0 + r : db < r ? op.y1 - r : NaN;
        if (!Number.isNaN(cx) && !Number.isNaN(cy) && Math.hypot(gx - cx, gy - cy) > r) return null;
      }
      if (!op.edge) return op.ch;
      const shadeY = op.edgeY || sm.s >= 2;
      let best = Math.min(dl, dr);
      let nx = dl < dr ? -1 : 1, ny = 0;
      if (shadeY && Math.min(dt, db) < best) { best = Math.min(dt, db); nx = 0; ny = dt < db ? -1 : 1; }
      if (best >= sm.pix) return op.ch;
      const l = lightOf(sm, nx, ny);
      if (l > 0.3) return op.lit && sm.s >= 2 ? op.lit : op.ch;
      return op.edge;
    }
    case 'seg': {
      const vx = op.x1 - op.x0, vy = op.y1 - op.y0;
      const len2 = vx * vx + vy * vy;
      let t = len2 > 0 ? ((gx - op.x0) * vx + (gy - op.y0) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = gx - (op.x0 + vx * t), dy = gy - (op.y0 + vy * t);
      return dx * dx + dy * dy <= (op.w * 0.5) * (op.w * 0.5) ? op.ch : null;
    }
    case 'ell': {
      const nx = (gx - op.cx) / op.rx, ny = (gy - op.cy) / op.ry;
      const d = nx * nx + ny * ny;
      if (d > 1) return null;
      if (op.edge && sm.s >= 2 && d > 0.55 && lightOf(sm, nx, ny) < 0) return op.edge;
      return op.ch;
    }
    case 'trap': {
      if (gy < op.y0 || gy >= op.y1) return null;
      const t = (gy - op.y0) / (op.y1 - op.y0);
      const hw = op.hw0 + (op.hw1 - op.hw0) * t;
      const dx = gx - op.cx;
      if (Math.abs(dx) > hw) return null;
      if (!op.edge) return op.ch;
      const side = hw - Math.abs(dx);
      const endD = Math.min(gy - op.y0, op.y1 - gy);
      let nx = dx < 0 ? -1 : 1, ny = 0, best = side;
      if (sm.s >= 2 && endD < best) { best = endD; nx = 0; ny = gy - op.y0 < op.y1 - gy ? -1 : 1; }
      if (best >= sm.pix) return op.ch;
      if (lightOf(sm, nx, ny) > 0.3) return op.lit && sm.s >= 2 ? op.lit : op.ch;
      return op.edge;
    }
    case 'helmet': {
      const dx = gx - op.cx, dy = gy - op.cy;
      const d = Math.hypot(dx, dy);
      if (d > op.r) return null;
      // Rim: 1 unit at 1x; at 2x a finer 1-1.5 px rim (wider for the flared
      // German Stahlhelm skirt than the smooth Soviet SSh-40 dome).
      const rimW = sm.s >= 2 ? (op.flare ? 0.8 : 0.55) : 1;
      if (d > op.r - rimW) return 'O';
      const inner = op.r - rimW;
      const nd = d / inner;
      const z = Math.sqrt(Math.max(0, 1 - nd * nd));
      // Screen-space offset for world-fixed NW light.
      const sx = dx * sm.cos - dy * sm.sin, sy = dx * sm.sin + dy * sm.cos;
      const lit = (-(sx + sy) * SQRT1_2) / inner;
      const v = 0.6 * lit + 0.4 * z;
      if (sm.s >= 2) {
        if (v > 0.66) return 'P';
        if (v > 0.38) return 'h';
        if (v > 0.02) return 'H';
        return 'D';
      }
      if (v > 0.72) return 'P';
      if (v > 0.34) return 'h';
      return 'H';
    }
  }
}

// ------------------------------------------------------------- figures ----
const rect = (x0: number, y0: number, x1: number, y1: number, ch: string, extra: Partial<RectOp> = {}): RectOp =>
  ({ k: 'rect', x0, y0, x1, y1, ch, ...extra });
const seg = (x0: number, y0: number, x1: number, y1: number, w: number, ch: string, extra: Partial<SegOp> = {}): SegOp =>
  ({ k: 'seg', x0, y0, x1, y1, w, ch, ...extra });
const ell = (cx: number, cy: number, rx: number, ry: number, ch: string, extra: Partial<EllOp> = {}): EllOp =>
  ({ k: 'ell', cx, cy, rx, ry, ch, ...extra });

/** A rifle carried pointing north with its muzzle at (x, yTop): chunky
 * 2-unit bar + stock at 1x; at 2x a slim lit barrel, wooden fore-stock,
 * receiver with bolt handle, shaped butt and a webbing sling. */
function rifleOps(x: number, yTop: number, len: number, hand: boolean): Op[] {
  const stockY = yTop + len;
  const ops: Op[] = [
    // 1x: 2-wide barrel + 2-unit wood stock + grip pixel.
    rect(x, yTop, x + 2, stockY, 'W', { max: 1 }),
    rect(x, stockY, x + 2, stockY + 2, 'K', { max: 1 }),
  ];
  if (hand) ops.push(rect(x, stockY + 2, x + 1, stockY + 3, 'G', { max: 1 }));
  const cx = x + 1;
  const foreY0 = yTop + len * 0.42;
  const recvY = yTop + len * 0.78;
  ops.push(
    // Sling: webbing strap along the outer (east) side, slack in the middle.
    seg(cx + 0.9, yTop + len * 0.2, cx + 1.25, yTop + len * 0.6, 0.5, 'Q', { min: 2 }),
    seg(cx + 1.25, yTop + len * 0.6, cx + 0.8, stockY + 1.5, 0.5, 'Q', { min: 2 }),
    // Wooden fore-stock and hand guard (wider than the barrel).
    rect(cx - 0.75, foreY0, cx + 0.75, recvY, 'K', { edge: 'J', lit: 'K', min: 2 }),
    // Barrel: lit west half, dark east half; muzzle / front sight.
    rect(cx - 0.5, yTop, cx, foreY0, 'w', { min: 2 }),
    rect(cx, yTop, cx + 0.5, foreY0, 'W', { min: 2 }),
    rect(cx - 0.5, yTop, cx + 0.5, yTop + 0.5, 'W', { min: 2 }),
    // Receiver + bolt handle.
    rect(cx - 0.5, recvY, cx + 0.5, stockY, 'W', { min: 2 }),
    rect(cx + 0.5, recvY + 0.5, cx + 1.25, recvY + 1, 'w', { min: 2 }),
    // Butt: narrow wrist widening to the butt plate.
    rect(cx - 0.5, stockY, cx + 0.5, stockY + 1, 'K', { min: 2 }),
    rect(cx - 0.75, stockY + 1, cx + 0.75, stockY + 2.5, 'K', { edge: 'J', lit: 'K', min: 2 }),
    rect(cx - 0.75, stockY + 2.5, cx + 0.75, stockY + 3, 'J', { min: 2 }),
  );
  return ops;
}

/** Belt kit seen from above on a torso spanning x0..x1 whose waist is at
 * waistY. German: Y-straps + bread bag + entrenching tool; Soviet: rolled
 * greatcoat (skatka) slung across the body + a canvas bag. 2x only. */
function beltKitOps(side: Side, x0: number, x1: number, shoulderY: number, waistY: number): Op[] {
  const mid = (x0 + x1) / 2;
  const ops: Op[] = [rect(x0, waistY - 0.5, x1, waistY, 'E', { min: 2 }), rect(mid - 0.25, waistY - 0.5, mid + 0.25, waistY, 'Z', { min: 2 })];
  if (side === 'german') {
    ops.push(
      seg(x0 + 1.25, shoulderY + 0.25, mid - 0.5, waistY - 0.5, 0.5, 'E', { min: 2 }),
      seg(x1 - 1.25, shoulderY + 0.25, mid + 0.5, waistY - 0.5, 0.5, 'E', { min: 2 }),
      rect(x1 - 1.75, waistY - 0.25, x1 - 0.25, waistY + 1.25, 'e', { edge: 'E', min: 2 }),
      rect(x0 + 0.25, waistY - 0.25, x0 + 1.25, waistY + 1.5, 'E', { min: 2 }),
    );
  } else {
    ops.push(
      seg(x0 + 0.5, shoulderY + 0.5, x1 - 0.75, waistY - 0.75, 1.2, 'e', { min: 2 }),
      seg(x0 + 0.5, shoulderY + 0.5, x1 - 0.75, waistY - 0.75, 0.4, 'E', { min: 2 }),
      rect(x0 + 0.25, waistY - 0.25, x0 + 2, waistY + 1.25, 'e', { edge: 'E', min: 2 }),
    );
  }
  return ops;
}

/** A leg trailing behind the body: trouser + boot at 2x, a solid dark boot
 * bar at 1x. */
function legOps(x: number, y0: number, len: number): Op[] {
  const y1 = y0 + len;
  return [
    rect(x, y0, x + 2, y1 - 1, 'b', { max: 1 }),
    rect(x, y1 - 1, x + 2, y1, 'k', { max: 1 }),
    rect(x, y0, x + 2, y1 - 3.5, 'T', { edge: 'S', min: 2, round: 0.5 }),
    rect(x, y1 - 3.5, x + 2, y1, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }),
    rect(x + 0.5, y1 - 0.5, x + 1.5, y1, 'k', { min: 2 }),
  ];
}

function helmetOf(cx: number, cy: number, r: number, side: Side): HelmetOp {
  return { k: 'helmet', cx, cy, r, flare: side === 'german', ch: 'H' };
}

function standingFigure(side: Side, frame: 0 | 1): Figure {
  const ops: Op[] = [];
  ops.push(...legOps(6, 12.5, frame === 0 ? 7 : 6), ...legOps(10, 12.5, frame === 0 ? 6 : 7));
  // Torso mass under the helmet: shoulders wider than the hips.
  ops.push(rect(5.5, 8.5, 12.5, 13.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5.5, 12.5, 9, 13.5));
  // Right forearm to the grip, left arm reaching across to the fore-stock.
  ops.push(seg(11.5, 11, 13, 11.5, 1.4, 'U', { min: 2 }), rect(12.75, 10.75, 13.75, 11.75, 'G', { min: 2 }));
  ops.push(seg(6.5, 10, 12.25, 5.5, 1.3, 'S', { min: 2 }), rect(12.75, 4.75, 13.75, 5.75, 'G', { min: 2 }));
  ops.push(...rifleOps(12.25, 0.5, 8.5, true));
  ops.push(helmetOf(9, 7.5, 3.5, side));
  return { ops, px: 9.5, py: 10.5, extent: 11.5 };
}

function crouchingFigure(side: Side, frame: 0 | 1): Figure {
  const ops: Op[] = [];
  const wob = frame === 1 ? 1 : 0;
  // Tucked boot, nudged sideways for the settle-into-cover cycle.
  ops.push(rect(7 + wob, 12, 9 + wob, 14, 'b', { max: 1 }), rect(7 + wob, 14, 9 + wob, 15, 'k', { max: 1 }));
  ops.push(rect(7 + wob, 12, 9 + wob, 15, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  // Kneeling leg bent diagonally back.
  ops.push(seg(10.3, 12, 13.3, 14.8, 1.9, 'b', { max: 1 }), rect(13.5, 14.5, 14.5, 15.5, 'k', { max: 1 }));
  ops.push(seg(10.3, 11.8, 12.3, 13.8, 2, 'T', { min: 2 }), seg(12.1, 13.6, 13.7, 15.1, 1.9, 'b', { min: 2 }), seg(13.4, 14.9, 13.9, 15.4, 1, 'k', { min: 2 }));
  ops.push(rect(5, 8, 12.5, 12.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5, 12.5, 8.5, 12.5));
  ops.push(seg(11, 10.5, 12.75, 9.5, 1.4, 'U', { min: 2 }), rect(12.75, 9, 13.75, 10, 'G', { min: 2 }));
  ops.push(seg(6.5, 9, 12.25, 4.5, 1.3, 'S', { min: 2 }), rect(12.75, 3.5, 13.75, 4.5, 'G', { min: 2 }));
  ops.push(...rifleOps(12.25, 2, 5, true));
  ops.push(helmetOf(9, 7, 4, side));
  return { ops, px: 9, py: 9, extent: 9.5 };
}

/** Shared prone/dead body: helmet at the north end, torso tapering from the
 * shoulders to the hips, two boots splayed at the south end. */
function proneBody(side: Side): Op[] {
  const ops: Op[] = [];
  ops.push(rect(3, 21, 5, 22, 'b', { max: 1 }), rect(3, 22, 5, 23, 'k', { max: 1 }));
  ops.push(rect(7, 21, 9, 22, 'b', { max: 1 }), rect(7, 22, 9, 23, 'k', { max: 1 }));
  ops.push(rect(2.75, 20, 5, 23, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  ops.push(rect(7, 20, 9.25, 23, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  ops.push({ k: 'trap', cx: 6.5, y0: 13, y1: 21, hw0: 4.5, hw1: 3, ch: 'U', edge: 'S', lit: 'L' });
  ops.push(rect(3.5, 18.5, 9.5, 21, 'T', { min: 2 }), rect(6.25, 19, 6.75, 21, 'S', { min: 2 }));
  ops.push(...beltKitOps(side, 3.5, 9.5, 13, 18.5));
  return ops;
}

function proneFigure(side: Side): Figure {
  const ops = proneBody(side);
  // 1x: arm bumps beside the helmet, rifle 6 units beyond it.
  ops.push(rect(3, 10, 5, 12, 'U', { max: 1 }), rect(8, 10, 10, 12, 'U', { max: 1 }));
  ops.push(rect(5, 0, 7, 6, 'W', { max: 1 }));
  // 2x: both arms reaching forward to the rifle, hands on stock and grip.
  ops.push(seg(3.5, 13, 4.5, 7.5, 1.6, 'U', { min: 2 }), seg(9.5, 13, 7.5, 9, 1.6, 'U', { min: 2 }));
  ops.push(rect(4.5, 6.5, 5.5, 7.5, 'G', { min: 2 }), rect(6.75, 8.5, 7.75, 9.5, 'G', { min: 2 }));
  ops.push(...rifleOps(5.5, 0, 6, false).filter((o) => o.min === 2).map((o) => ({ ...o })));
  ops.push(helmetOf(6.5, 9.5, 3.5, side));
  return { ops, px: 6, py: 12, extent: 12.2 };
}

function deadFigure(side: Side): Figure {
  const ops: Op[] = [];
  // Irregular blood pool under the torso.
  ops.push(rect(5, 15, 7, 16, 'R', { max: 1 }), rect(6, 16, 8, 17, 'R', { max: 1 }));
  ops.push(ell(6.5, 16, 2.3, 1.4, 'R', { min: 2 }), ell(8, 17.5, 1.3, 1, 'R', { min: 2 }), ell(4.8, 14.8, 0.9, 0.7, 'R', { min: 2 }));
  ops.push(...proneBody(side));
  // One arm tucked, the other flung out wide.
  ops.push(rect(3, 10, 5, 12, 'U', { max: 1 }), rect(9, 9, 12, 11, 'U', { max: 1 }));
  ops.push(seg(3.5, 13, 3.2, 10, 1.6, 'U', { min: 2 }), seg(9.5, 13, 11.8, 9.5, 1.6, 'U', { min: 2 }), rect(11.5, 8.5, 12.5, 9.5, 'G', { min: 2 }));
  // Weapon dropped beside the body.
  ops.push(rect(8, 0, 10, 6, 'W', { max: 1 }));
  ops.push(...rifleOps(8.5, -1, 5, false).filter((o) => o.min === 2));
  ops.push(helmetOf(6.5, 9.5, 3.5, side));
  return { ops, px: 6, py: 12, extent: 12.2 };
}

// ------------------------------------------------------------- palette ----
const BOOT = '#1a1712';
const WEAPON = '#141412';
const WEAPON_HI = '#4c4c48';
const STOCK = '#6e4a2a';
const SKIN = '#c9a37c';
const LEATHER = '#241c14';
const BUCKLE = '#8a8a7c';
const OUTLINE_COLOR = 'rgba(26,27,22,0.88)';
const HALO_COLOR = 'rgba(8,8,6,0.4)';
/** wf5: the player's own soldiers get a faint pale-gold rim outside the dark
 * outline (period-feel "your men" cue, not an RTS selection glow). Slightly
 * deeper and stronger on snow, where pale gold alone would vanish. */
const FRIENDLY_RIM: Record<'summer' | 'winter', string> = {
  summer: 'rgba(236,212,122,0.35)',
  winter: 'rgba(200,160,40,0.5)',
};

interface UniformPalette { u: string; s: string; helmetMid: string; helmetLight: string; kit: string; sling: string }
// wf5 side readability: German field grey with a cool blue-grey cast and a
// darker helmet; Soviet warm khaki / olive-brown with a lighter, more olive
// helmet. The two now differ in hue (blue-grey vs brown) AND helmet value.
const GERMAN_SUMMER: UniformPalette = { u: '#5d686c', s: '#465055', helmetMid: '#454b4e', helmetLight: '#5c6366', kit: '#7a7458', sling: '#3a3a2e' };
const SOVIET_SUMMER: UniformPalette = { u: '#8f7a4b', s: '#6c5734', helmetMid: '#7b7e48', helmetLight: '#969a5e', kit: '#8c8458', sling: '#5a4a2a' };
const WINTER_SMOCK = { u: '#cacbc4', s: '#a8aaa2' };
const WINTER_SE_SHADE = '#aeb0aa';

function parseHex(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function toHex(r: number, g: number, b: number): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
function darkenHex(hex: string, factor: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r * factor, g * factor, b * factor);
}
function lightenHex(hex: string, factor: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r + (255 - r) * factor, g + (255 - g) * factor, b + (255 - b) * factor);
}
function desaturateHex(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  const gray = (r + g + b) / 3;
  return toHex(r + (gray - r) * amount, g + (gray - g) * amount, b + (gray - b) * amount);
}

/** Uniform colours per side/season (exported for tests / the preview). */
export function uniformColors(side: Side, season: Season): { uniform: string; helmet: string } {
  const pal = paletteFor(side, season);
  return { uniform: pal.u, helmet: pal.helmetMid };
}

function paletteFor(side: Side, season: Season): UniformPalette {
  const base = side === 'german' ? GERMAN_SUMMER : SOVIET_SUMMER;
  if (season === 'winter') return { ...base, u: WINTER_SMOCK.u, s: WINTER_SMOCK.s };
  return base;
}

function colorsFor(side: Side, season: Season, dead: boolean, outline: SoldierOutline): Record<string, string> {
  const pal = paletteFor(side, season);
  const winter = season === 'winter';
  const base: Record<string, string> = {
    U: pal.u,
    L: lightenHex(pal.u, 0.18),
    S: darkenHex(pal.s, 0.72),
    V: WINTER_SE_SHADE,
    T: winter ? darkenHex(WINTER_SMOCK.s, 0.92) : darkenHex(pal.s, 0.85),
    H: pal.helmetMid,
    h: lightenHex(pal.helmetLight, 0.22),
    D: darkenHex(pal.helmetMid, 0.78),
    W: WEAPON, w: WEAPON_HI, K: STOCK, J: darkenHex(STOCK, 0.62), Q: winter ? '#6e6a5c' : pal.sling,
    G: SKIN,
    b: BOOT, B: '#3a342a', k: darkenHex(BOOT, 0.55),
    E: winter ? '#6a665a' : LEATHER, e: winter ? '#b8b6a8' : pal.kit, Z: BUCKLE,
    R: 'rgba(96,24,16,0.72)',
  };
  base.O = darkenHex(base.H, 0.6);
  base.P = lightenHex(base.h, 0.55);
  if (dead) {
    const fix = (c: string) => (c.startsWith('#') ? darkenHex(desaturateHex(c, 0.45), 0.58) : c);
    for (const k of Object.keys(base)) base[k] = fix(base[k]);
  }
  const friendly = outline === 'friendly' && !dead;
  base.X = OUTLINE_COLOR;
  base.Y = friendly ? FRIENDLY_RIM[winter ? 'winter' : 'summer'] : HALO_COLOR;
  base.y = friendly ? FRIENDLY_RIM[winter ? 'winter' : 'summer'].replace(/[\d.]+\)$/, (m) => `${(parseFloat(m) * 0.55).toFixed(2)})`) : 'rgba(8,8,6,0.16)';
  return base;
}

// ---------------------------------------------------------- rasterise -----
function parseColor(c: string): [number, number, number, number] {
  if (c.startsWith('#')) { const [r, g, b] = parseHex(c); return [r, g, b, 255]; }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return [255, 0, 255, 255];
  const p = m[1].split(',').map((v) => parseFloat(v));
  return [p[0], p[1], p[2], Math.round((p[3] ?? 1) * 255)];
}

function figureFor(side: Side, stance: Stance | 'dead', frame: 0 | 1): Figure {
  if (stance === 'dead') return deadFigure(side);
  if (stance === 'prone') return proneFigure(side);
  if (stance === 'crouching') return crouchingFigure(side, frame);
  return standingFigure(side, frame);
}

/** Rasterise a figure at `scale` and `facing` into an N x N character grid
 * (row-major, '' = empty) with the pivot exactly at the canvas centre. */
function rasterise(fig: Figure, facing: Facing8, scale: number, winter: boolean): { n: number; cells: string[] } {
  const rings = 2;
  const half = Math.ceil(fig.extent + 1) * scale + rings * scale;
  const n = half * 2;
  const ang = (facing * Math.PI) / 4;
  let cos = Math.cos(ang), sin = Math.sin(ang);
  if (facing % 2 === 0) { cos = Math.round(cos); sin = Math.round(sin); }
  const sm: Sampler = { s: scale, pix: 1 / scale, cos, sin };
  const ops = fig.ops.filter((o) => (o.min == null || scale >= o.min) && (o.max == null || scale <= o.max));
  const cells = new Array<string>(n * n).fill('');
  for (let py = 0; py < n; py++) {
    const sy = (py + 0.5 - half) / scale;
    for (let px = 0; px < n; px++) {
      const sx = (px + 0.5 - half) / scale;
      // Inverse-rotate the screen offset into the north-facing pose.
      const ux = sx * cos + sy * sin;
      const uy = -sx * sin + sy * cos;
      if (ux * ux + uy * uy > (fig.extent + 1) * (fig.extent + 1)) continue;
      const gx = ux + fig.px, gy = uy + fig.py;
      let ch = '';
      for (let i = ops.length - 1; i >= 0; i--) {
        const hit = sampleOp(ops[i], gx, gy, sm);
        if (hit) { ch = hit; break; }
      }
      // Winter smock: the SE half (in screen space) takes the shade tone so
      // a white figure keeps its volume against snow.
      if (winter && ch === 'U' && sx + sy >= 0) ch = 'V';
      cells[py * n + px] = ch;
    }
  }
  return { n, cells };
}

/** Grow the dark outline ring and the halo/rim rings on the raster, in
 * output pixels: 1x = outline + 1 halo ring; 2x = outline + 2 halo rings
 * (the outer one softer), so the rings carry the same screen weight. */
function growRings(n: number, cells: string[], scale: number): void {
  const grow = (from: (c: string) => boolean, ch: string, diag: boolean) => {
    const add: number[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (cells[i] !== '') continue;
        const at = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < n && yy < n && from(cells[yy * n + xx]);
        if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)
          || (diag && (at(x - 1, y - 1) || at(x + 1, y - 1) || at(x - 1, y + 1) || at(x + 1, y + 1)))) add.push(i);
      }
    }
    for (const i of add) cells[i] = ch;
  };
  const any = (c: string) => c !== '';
  grow(any, 'X', false);
  grow(any, 'Y', scale >= 2);
  if (scale >= 2) grow(any, 'y', false);
}

function paint(n: number, cells: string[], colors: Record<string, string>): HTMLCanvasElement {
  const c = createCanvas(n, n);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(n, n);
  const rgba = new Map<string, [number, number, number, number]>();
  for (let i = 0; i < cells.length; i++) {
    const ch = cells[i];
    if (!ch) continue;
    let col = rgba.get(ch);
    if (!col) { col = parseColor(colors[ch] ?? '#ff00ff'); rgba.set(ch, col); }
    const o = i * 4;
    img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = col[3];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Build one oriented soldier sprite. The canvas is square, the soldier's
 * position is its exact centre, and it is authored for `scale` sprite pixels
 * per 1x pixel — draw it at `canvas.width * zoom / scale`. Cached by the
 * caller (sprites.ts). */
export function buildSoldierSprite(
  side: Side, season: Season, stance: Stance | 'dead', facing: Facing8, frame: 0 | 1,
  outline: SoldierOutline = 'enemy', scale = 1,
): HTMLCanvasElement {
  const s = scale >= 2 ? 2 : 1;
  const fig = figureFor(side, stance, stance === 'dead' || stance === 'prone' ? 0 : frame);
  const { n, cells } = rasterise(fig, facing, s, season === 'winter');
  growRings(n, cells, s);
  return paint(n, cells, colorsFor(side, season, stance === 'dead', stance === 'dead' ? 'enemy' : outline));
}

// ============================================================================
// CREW POSES — gun, mortar and HMG crews working their weapon (the weapon
// itself is drawn by weaponArt.ts on the ground under them), plus the carry /
// haul poses of a crew moving with a packed weapon. Same shape primitives and
// rasteriser as the infantry stances above.
// ============================================================================

export type CrewPose =
  | 'gunnerKneel'   // kneeling at the sight, both hands forward on the weapon
  | 'loaderRound'   // crouched holding a mortar bomb (frame 1: dropping it down the tube)
  | 'loaderShell'   // crouched holding an AT shell (frame 1: ramming it into the breech)
  | 'mgProne'       // prone behind a tripod / wheeled MG, hands on the grips
  | 'carryTube'     // walking with the mortar tube across the back
  | 'carryPlate'    // walking with the mortar baseplate on the back
  | 'carryMg'       // walking with the MG over the shoulder
  | 'carryTripod'   // walking with the folded tripod on the back
  | 'haul';         // walking, both arms back on the gun trail (towing an AT gun)

export const CREW_POSES: CrewPose[] = ['gunnerKneel', 'loaderRound', 'loaderShell', 'mgProne', 'carryTube', 'carryPlate', 'carryMg', 'carryTripod', 'haul'];

/** Kneeling body (boot, bent leg, torso, belt kit, helmet) without arms or weapon. */
function kneelBodyOps(side: Side, frame: 0 | 1): Op[] {
  const ops: Op[] = [];
  const wob = frame === 1 ? 0.5 : 0;
  ops.push(rect(7 + wob, 12, 9 + wob, 14, 'b', { max: 1 }), rect(7 + wob, 14, 9 + wob, 15, 'k', { max: 1 }));
  ops.push(rect(7 + wob, 12, 9 + wob, 15, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  ops.push(seg(10.3, 12, 13.3, 14.8, 1.9, 'b', { max: 1 }), rect(13.5, 14.5, 14.5, 15.5, 'k', { max: 1 }));
  ops.push(seg(10.3, 11.8, 12.3, 13.8, 2, 'T', { min: 2 }), seg(12.1, 13.6, 13.7, 15.1, 1.9, 'b', { min: 2 }), seg(13.4, 14.9, 13.9, 15.4, 1, 'k', { min: 2 }));
  ops.push(rect(5, 8, 12.5, 12.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5, 12.5, 8.5, 12.5));
  return ops;
}

/** Standing / walking body without arms or weapon (legs swap with the walk frame). */
function walkBodyOps(side: Side, frame: 0 | 1): Op[] {
  const ops: Op[] = [];
  ops.push(...legOps(6, 12.5, frame === 0 ? 7 : 6), ...legOps(10, 12.5, frame === 0 ? 6 : 7));
  ops.push(rect(5.5, 8.5, 12.5, 13.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5.5, 12.5, 9, 13.5));
  return ops;
}

/** Two arms from the shoulders to hands at (lx,ly) and (rx,ry): sleeves + skin at 2x, sleeve
 * nubs at 1x. */
function armsTo(shY: number, lx: number, ly: number, rx: number, ry: number): Op[] {
  return [
    seg(6.2, shY, lx, ly, 1.5, 'S', { min: 2 }), seg(11.8, shY, rx, ry, 1.5, 'U', { min: 2 }),
    rect(lx - 0.5, ly - 0.5, lx + 0.5, ly + 0.5, 'G', { min: 2 }), rect(rx - 0.5, ry - 0.5, rx + 0.5, ry + 0.5, 'G', { min: 2 }),
    seg(6.2, shY, lx, ly, 2, 'U', { max: 1 }), seg(11.8, shY, rx, ry, 2, 'U', { max: 1 }),
  ];
}

function crewFigure(side: Side, pose: CrewPose, frame: 0 | 1): Figure {
  switch (pose) {
    case 'gunnerKneel': {
      const ops = kneelBodyOps(side, 0);
      // hands forward on the sight / traverse wheel; frame 1 nudges the hands (laying the gun)
      ops.push(...armsTo(9, 5.4, frame ? 1.4 : 2.0, 12.6, frame ? 2.4 : 1.8));
      ops.push(helmetOf(9, 7, 4, side));
      // hands reach out past the helmet onto the sight / traverse wheel
      ops.push(rect(4.9, frame ? 0.9 : 1.5, 5.9, frame ? 1.9 : 2.5, 'G'), rect(12.1, frame ? 1.9 : 1.3, 13.1, frame ? 2.9 : 2.3, 'G'));
      return { ops, px: 9, py: 9, extent: 9.5 };
    }
    case 'loaderRound': {
      const ops = kneelBodyOps(side, 0);
      const by = frame ? -1.6 : 0.4;
      ops.push(...armsTo(9, 6.6, by + 2.2, 11.4, by + 2.2));
      ops.push(helmetOf(9, 7, 4, side));
      // mortar bomb held out in front (frame 1: lowered into the muzzle): olive body, brass fuze, fins
      ops.push(ell(9, by, 1.2, 2.0, 'M'));
      ops.push(rect(8.6, by - 2.5, 9.4, by - 1.7, 'N'));
      ops.push(rect(8.1, by + 1.7, 9.9, by + 2.4, 'k'));
      ops.push(rect(6.1, by + 1.7, 7.1, by + 2.7, 'G'), rect(10.9, by + 1.7, 11.9, by + 2.7, 'G'));
      return { ops, px: 9, py: 9, extent: 10.5 };
    }
    case 'loaderShell': {
      const ops = kneelBodyOps(side, 0);
      const sy = frame ? 0 : 2;
      ops.push(...armsTo(9, 6.4, sy + 1.2, 11.6, sy + 1.2));
      ops.push(helmetOf(9, 7.2, 4, side));
      // brass case with a dark projectile, carried in both hands pointing forward
      ops.push(rect(8.1, sy - 1, 9.9, sy + 3.4, 'N', { edge: 'n' }));
      ops.push(rect(8.3, sy - 3, 9.7, sy - 1, 'W'));
      ops.push(rect(8.7, sy - 3.7, 9.3, sy - 3, 'W', { min: 2 }));
      ops.push(rect(5.9, sy + 0.7, 6.9, sy + 1.7, 'G'), rect(11.1, sy + 0.7, 12.1, sy + 1.7, 'G'));
      return { ops, px: 9, py: 9, extent: 10.5 };
    }
    case 'mgProne': {
      const ops = proneBody(side);
      ops.push(rect(3, 9, 5, 11, 'U', { max: 1 }), rect(8, 9, 10, 11, 'U', { max: 1 }));
      ops.push(seg(3.5, 13, 5, 7.5, 1.6, 'U', { min: 2 }), seg(9.5, 13, 8, 7.5, 1.6, 'U', { min: 2 }));
      ops.push(rect(4.5, 6.5, 5.5, 7.5, 'G', { min: 2 }), rect(7.5, 6.5, 8.5, 7.5, 'G', { min: 2 }));
      ops.push(helmetOf(6.5, 10, 3.5, side));
      return { ops, px: 6, py: 12, extent: 12.2 };
    }
    case 'carryTube': {
      const ops = walkBodyOps(side, frame);
      ops.push(...armsTo(9.5, 5.4, 12.6, 12.6, 6.8));
      ops.push(seg(4.2, 15.5, 13.4, 5.2, 2.2, 'W'));
      ops.push(seg(4.6, 15.1, 13, 5.6, 0.6, 'w', { min: 2 }));
      ops.push(ell(13.4, 5.2, 1.1, 1.1, 'k', { min: 2 }));
      ops.push(helmetOf(9, 7.5, 3.5, side));
      return { ops, px: 9.5, py: 10.5, extent: 11.5 };
    }
    case 'carryPlate': {
      const ops = walkBodyOps(side, frame);
      ops.push(...armsTo(9.5, 5, 11, 13, 11));
      ops.push(ell(9, 12.8, 3.6, 3.3, 'W', { edge: 'k' }));
      ops.push(ell(9, 12.8, 2.2, 2.0, 'w', { min: 2 }));
      ops.push(ell(9, 12.8, 1.6, 1.4, 'W', { min: 2 }));
      ops.push(helmetOf(9, 7.5, 3.5, side));
      return { ops, px: 9.5, py: 10.5, extent: 11.5 };
    }
    case 'carryMg': {
      const ops = walkBodyOps(side, frame);
      ops.push(...armsTo(9.5, 6, 12.5, 12.8, 5.2));
      // MG over the right shoulder, muzzle forward, butt behind
      ops.push(rect(12.1, -0.5, 13.5, 8, 'W'));
      ops.push(rect(12.3, 8, 13.3, 15.5, 'W'));
      ops.push(rect(12.4, 0.5, 13.2, 7, 'w', { min: 2 }));
      ops.push(helmetOf(9, 7.5, 3.5, side));
      return { ops, px: 9.5, py: 10.5, extent: 11.5 };
    }
    case 'carryTripod': {
      const ops = walkBodyOps(side, frame);
      ops.push(...armsTo(9.5, 5.2, 12, 12.8, 12));
      ops.push(seg(5.5, 16.5, 12.5, 4.5, 1.7, 'w'));
      ops.push(seg(7.5, 17, 13.5, 6.5, 1.1, 'W'));
      ops.push(ell(5.5, 16.5, 0.9, 0.9, 'k', { min: 2 }), ell(7.5, 17, 0.8, 0.8, 'k', { min: 2 }));
      ops.push(helmetOf(9, 7.5, 3.5, side));
      return { ops, px: 9.5, py: 10.5, extent: 11.5 };
    }
    case 'haul': {
      const ops = walkBodyOps(side, frame);
      // leaning into it: both arms reaching back to the trail behind him
      ops.push(...armsTo(10, 6.5, 17.2, 11.5, 17.2));
      ops.push(helmetOf(9, 6.8, 3.5, side));
      return { ops, px: 9.5, py: 10.5, extent: 11.5 };
    }
  }
}

const crewPoseCache = new Map<string, HTMLCanvasElement>();
const CREW_POSE_CACHE_CAP = 700;

/** Oriented crew-pose sprite (square, centred on the soldier, `scale` px per 1x px — draw at
 * `width * zoom / scale`), cached here with a simple bounded LRU. */
export function getCrewPoseSprite(
  side: Side, season: Season, pose: CrewPose, facing: Facing8, frame: 0 | 1,
  outline: SoldierOutline = 'enemy', scale = 1,
): HTMLCanvasElement {
  const s = scale >= 2 ? 2 : 1;
  const winter = season === 'winter';
  const key = `${side}|${winter ? 'w' : 's'}|${pose}|${facing}|${frame}|${outline}|${s}`;
  const hit = crewPoseCache.get(key);
  if (hit) { crewPoseCache.delete(key); crewPoseCache.set(key, hit); return hit; }
  const fig = crewFigure(side, pose, frame);
  const { n, cells } = rasterise(fig, facing, s, winter);
  growRings(n, cells, s);
  const colors = { ...colorsFor(side, season, false, outline), M: '#56594a', N: '#b39a52', n: '#7c6a34' };
  const c = paint(n, cells, colors);
  crewPoseCache.set(key, c);
  if (crewPoseCache.size > CREW_POSE_CACHE_CAP) crewPoseCache.delete(crewPoseCache.keys().next().value as string);
  return c;
}
