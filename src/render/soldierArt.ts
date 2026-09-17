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
  /** Height class for the baked SE cast shadow: 1 = lying, 2 = kneeling, 3 = upright (default). */
  tall?: 1 | 2 | 3;
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
      let l = lightOf(sm, nx, ny);
      // an edge running exactly along the light (NW-SE diagonals) faces it on neither side:
      // break the tie toward the north-facing edge so a diagonal weapon keeps its highlight
      if (Math.abs(l) < 0.3) l = -(nx * sm.sin + ny * sm.cos);
      if (l > 0.3) return op.lit ?? op.ch;
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
      if (lightOf(sm, nx, ny) > 0.3) return op.lit ?? op.ch;
      return op.edge;
    }
    case 'helmet': {
      const dx = gx - op.cx, dy = gy - op.cy;
      const d = Math.hypot(dx, dy);
      if (d > op.r) return null;
      // Rim: 1 unit at 1x; at 2x a finer 1-1.5 px rim (wider for the flared
      // German Stahlhelm skirt than the smooth Soviet SSh-40 dome).
      // Screen-space offset for world-fixed NW light.
      const sx = dx * sm.cos - dy * sm.sin, sy = dx * sm.sin + dy * sm.cos;
      if (sm.s < 2) {
        // wf19 1x: no full dark rim (it turned the head into a dark blob). The dome is lit
        // from the NW across its whole radius: a 1-2 px specular dot, a light band, the mid
        // tone, and a dark crescent only on the SE rim.
        const lit1 = (-(sx + sy) * SQRT1_2) / op.r;
        const nd1 = d / op.r;
        const v1 = 0.62 * lit1 + 0.38 * Math.sqrt(Math.max(0, 1 - nd1 * nd1));
        // specular: the pixel(s) nearest a fixed spot NW of the crown. A 0.72 px disc always
        // holds at least one pixel centre (and at most four), so every facing gets its dot.
        const sp = op.r * 0.3;
        if (Math.hypot(sx + sp, sy + sp) < 0.72) return 'P';
        if (v1 > 0.26) return 'h';
        if (v1 > -0.22) return 'H';
        return nd1 > 0.7 ? 'O' : 'D';
      }
      const rimW = op.flare ? 0.8 : 0.55;
      if (d > op.r - rimW) return 'O';
      const inner = op.r - rimW;
      const nd = d / inner;
      const z = Math.sqrt(Math.max(0, 1 - nd * nd));
      const lit = (-(sx + sy) * SQRT1_2) / inner;
      const v = 0.6 * lit + 0.4 * z;
      if (v > 0.66) return 'P';
      if (v > 0.38) return 'h';
      if (v > 0.02) return 'H';
      return 'D';
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

/** wf19 1x weapon bar: 2 units wide, the half facing the NW light drawn in light steel and the
 * other half near-black, so the weapon line (and with it the facing) reads at a glance on dark
 * and bright ground alike. */
function gun1x(x: number, y0: number, y1: number): RectOp {
  return rect(x, y0, x + 2, y1, 'w', { edge: 'W', max: 1 });
}

/** A rifle carried pointing north with its muzzle at (x, yTop): chunky
 * 2-unit bar + stock at 1x; at 2x a slim lit barrel, wooden fore-stock,
 * receiver with bolt handle, shaped butt and a webbing sling. */
function rifleOps(x: number, yTop: number, len: number, hand: boolean): Op[] {
  const stockY = yTop + len;
  const ops: Op[] = [
    // 1x: 2-wide barrel + 2-unit wood stock + grip pixel.
    gun1x(x, yTop, stockY),
    rect(x, stockY, x + 2, stockY + 2, 'K', { edge: 'J', max: 1 }),
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
    rect(x, y0, x + 2, y1 - 2, 'T', { edge: 'S', max: 1 }),
    rect(x, y1 - 2, x + 2, y1, 'b', { max: 1 }),
    rect(x, y0, x + 2, y1 - 3.5, 'T', { edge: 'S', min: 2, round: 0.5 }),
    rect(x, y1 - 3.5, x + 2, y1, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }),
    rect(x + 0.5, y1 - 0.5, x + 1.5, y1, 'k', { min: 2 }),
  ];
}

function helmetOf(cx: number, cy: number, r: number, side: Side): HelmetOp {
  return { k: 'helmet', cx, cy, r, flare: side === 'german', ch: 'H' };
}

/** Walking legs. 2x keeps the long detailed legs; 1x (wf19) uses a shorter, clearer stride: the
 * trailing leg shows 5.5 units behind the hips, the leading one only 3, swapping per frame, so
 * a standing man is ~14 px from helmet to boot and visibly steps when he moves. */
function strideLegs(frame: 0 | 1): Op[] {
  return [
    ...legOps(6, 12.5, frame === 0 ? 7 : 6).filter((o) => o.min === 2), ...legOps(10, 12.5, frame === 0 ? 6 : 7).filter((o) => o.min === 2),
    ...legOps(6, 12.5, frame === 0 ? 5.5 : 3).filter((o) => o.max === 1), ...legOps(10, 12.5, frame === 0 ? 3 : 5.5).filter((o) => o.max === 1),
  ];
}

function standingFigure(side: Side, frame: 0 | 1): Figure {
  const ops: Op[] = [];
  ops.push(...strideLegs(frame));
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
  ops.push(rect(7 + wob, 12, 9 + wob, 13.5, 'T', { max: 1 }), rect(7 + wob, 13.5, 9 + wob, 15, 'b', { max: 1 }));
  ops.push(rect(7 + wob, 12, 9 + wob, 15, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  // Kneeling leg bent diagonally back.
  ops.push(seg(10.3, 12, 12.6, 14.1, 1.9, 'T', { max: 1 }), seg(12.9, 14.4, 13.8, 15.3, 1.7, 'b', { max: 1 }));
  ops.push(seg(10.3, 11.8, 12.3, 13.8, 2, 'T', { min: 2 }), seg(12.1, 13.6, 13.7, 15.1, 1.9, 'b', { min: 2 }), seg(13.4, 14.9, 13.9, 15.4, 1, 'k', { min: 2 }));
  ops.push(rect(5, 8, 12.5, 12.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5, 12.5, 8.5, 12.5));
  ops.push(seg(11, 10.5, 12.75, 9.5, 1.4, 'U', { min: 2 }), rect(12.75, 9, 13.75, 10, 'G', { min: 2 }));
  ops.push(seg(6.5, 9, 12.25, 4.5, 1.3, 'S', { min: 2 }), rect(12.75, 3.5, 13.75, 4.5, 'G', { min: 2 }));
  ops.push(...rifleOps(12.25, 2, 5, true));
  ops.push(helmetOf(9, 7, 4, side));
  return { ops, px: 9, py: 9, extent: 9.5, tall: 2 };
}

/** Shared prone/dead body: helmet at the north end, torso tapering from the
 * shoulders to the hips, two boots splayed at the south end. */
function proneBody(side: Side): Op[] {
  const ops: Op[] = [];
  // 1x (wf19): two separate trouser legs with a gap of ground between them, dark boots at the
  // ends — the long body + boots is what says "prone" at a glance.
  ops.push(rect(3.5, 18, 5.5, 21.5, 'T', { edge: 'S', max: 1 }), rect(7.5, 18, 9.5, 21.5, 'T', { edge: 'S', max: 1 }));
  ops.push(rect(3, 21.5, 5, 23.5, 'b', { max: 1 }), rect(8, 21.5, 10, 23.5, 'b', { max: 1 }));
  ops.push(rect(2.75, 20, 5, 23, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  ops.push(rect(7, 20, 9.25, 23, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  ops.push({ k: 'trap', cx: 6.5, y0: 13, y1: 21, hw0: 4.5, hw1: 3, ch: 'U', edge: 'S', lit: 'L', min: 2 });
  ops.push({ k: 'trap', cx: 6.5, y0: 12.5, y1: 18.5, hw0: 4, hw1: 3, ch: 'U', edge: 'S', lit: 'L', max: 1 });
  ops.push(rect(3.5, 18.5, 9.5, 21, 'T', { min: 2 }), rect(6.25, 19, 6.75, 21, 'S', { min: 2 }));
  ops.push(...beltKitOps(side, 3.5, 9.5, 13, 18.5));
  return ops;
}

function proneFigure(side: Side): Figure {
  const ops = proneBody(side);
  // 1x: arm bumps beside the helmet, rifle 6 units beyond it.
  ops.push(rect(3, 10, 5, 12, 'U', { max: 1 }), rect(8, 10, 10, 12, 'U', { max: 1 }));
  ops.push(gun1x(5, 0, 6.5));
  // 2x: both arms reaching forward to the rifle, hands on stock and grip.
  ops.push(seg(3.5, 13, 4.5, 7.5, 1.6, 'U', { min: 2 }), seg(9.5, 13, 7.5, 9, 1.6, 'U', { min: 2 }));
  ops.push(rect(4.5, 6.5, 5.5, 7.5, 'G', { min: 2 }), rect(6.75, 8.5, 7.75, 9.5, 'G', { min: 2 }));
  ops.push(...rifleOps(5.5, 0, 6, false).filter((o) => o.min === 2).map((o) => ({ ...o })));
  ops.push(helmetOf(6.5, 9.5, 3.5, side));
  return { ops, px: 6, py: 12, extent: 12.6, tall: 1 };
}

/** A corpse must read as unmistakably dead at 1x (round5 critique fix #4): flatter than a
 * living prone man (no raised torso trapezoid, just a thin flattened slab), limbs splayed wide
 * and asymmetrically rather than tucked forward, a visible blood pool, and no weapon presented
 * — any weapon lies well clear of the hands, never aimed. Colours are darkened/desaturated by
 * `colorsFor(..., dead=true, ...)`. */
function deadFigure(side: Side): Figure {
  const ops: Op[] = [];
  // Irregular blood pool under the torso — bigger and darker than a living scene ever shows.
  ops.push(rect(4, 14, 8, 17, 'R', { max: 1 }), rect(6, 16, 9, 18, 'R', { max: 1 }));
  ops.push(ell(6.5, 15.5, 3, 2, 'R', { min: 2 }), ell(8.5, 17.7, 1.7, 1.3, 'R', { min: 2 }), ell(4, 14.5, 1.2, 0.9, 'R', { min: 2 }));
  // Flattened body: a thin slab (shorter than proneBody's raised trapezoid), legs splayed
  // apart (not parallel) and one boot twisted outward.
  ops.push(rect(3, 20.5, 5.2, 21.6, 'k', { max: 1 }), rect(8, 21.3, 10.4, 22.4, 'k', { max: 1 }));
  ops.push(rect(2.6, 19.8, 5.4, 22, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.6 }));
  ops.push(rect(7.6, 20.6, 10.6, 22.8, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.6 }));
  ops.push({ k: 'trap', cx: 6.7, y0: 14.5, y1: 20.2, hw0: 4, hw1: 2.6, ch: 'T', edge: 'S', lit: 'T' });
  ops.push(rect(4, 18, 9.5, 19.8, 'S', { min: 2 }));
  ops.push(...beltKitOps(side, 4, 9.5, 12.5, 18));
  // Arms flung wide and asymmetrically — one straight out to the side, one bent back —
  // nothing reaching toward a weapon.
  ops.push(rect(2, 8, 4, 11, 'U', { max: 1 }), rect(10, 6, 13.5, 8.5, 'U', { max: 1 }));
  ops.push(seg(3.5, 12.5, 1.5, 8, 1.6, 'U', { min: 2 }), seg(9.5, 12, 13, 7, 1.6, 'U', { min: 2 }));
  ops.push(rect(0.8, 6.8, 1.9, 7.9, 'G', { min: 2 }), rect(13, 5.8, 14, 6.9, 'G', { min: 2 }));
  // Weapon dropped clear of the body, off to one side at an angle — never pointed forward.
  ops.push(rect(11, 15, 13, 21, 'w', { edge: 'W', max: 1 }));
  ops.push(seg(11.5, 21, 13.5, 14.5, 0.9, 'W', { min: 2 }), seg(11.6, 20.6, 13.2, 15.3, 0.35, 'w', { min: 2 }));
  ops.push(helmetOf(6.5, 9.5, 3.4, side));
  return { ops, px: 6, py: 12, extent: 12.6, tall: 1 };
}

/** Wounded but alive: crawls low, still gripping his weapon (spec §1 item 3). Similar silhouette
 * to `proneFigure` (so a glance still reads "man on the ground") but the head is lifted and one
 * arm drags the body forward while the other keeps the rifle close to the chest rather than
 * aimed out front — distinct from both calm prone (weapon presented forward) and a corpse (no
 * weapon, flat, blood pool). */
function woundedCrawlFigure(side: Side): Figure {
  const ops = proneBody(side);
  ops.push(rect(2, 11, 4, 13, 'U', { max: 1 }), rect(9, 9, 11, 11, 'U', { max: 1 }));
  ops.push(gun1x(4, 1, 6.5));
  // Dragging arm reaches far forward-side; the other cradles the weapon in close.
  ops.push(seg(3, 13.5, 2, 8, 1.6, 'U', { min: 2 }), seg(9, 13, 8.3, 10, 1.6, 'U', { min: 2 }));
  ops.push(rect(1.5, 7.3, 2.5, 8.3, 'G', { min: 2 }), rect(7.8, 9.3, 8.8, 10.3, 'G', { min: 2 }));
  ops.push(...rifleOps(4.5, 3.5, 4.5, false).filter((o) => o.min === 2).map((o) => ({ ...o })));
  ops.push(helmetOf(6.5, 10.2, 3.5, side));
  return { ops, px: 6, py: 12, extent: 12.6, tall: 1 };
}

/** Pinned: flat on the ground, head down, holding still — no weapon presented, hands drawn in
 * under the chest rather than out front aiming (spec §1 item "pinned (flat prone, head down)").
 * Lower profile than the calm prone pose (no forward-reaching arms/rifle silhouette) but not as
 * flattened/splayed as a corpse and no blood. */
function pinnedFigure(side: Side): Figure {
  const ops = proneBody(side);
  ops.push(rect(4, 10, 6, 12, 'U', { max: 1 }), rect(7, 10, 9, 12, 'U', { max: 1 }));
  ops.push(seg(4.5, 13, 5.5, 10.8, 1.4, 'U', { min: 2 }), seg(8.5, 13, 7.5, 10.8, 1.4, 'U', { min: 2 }));
  ops.push(rect(5, 10.2, 6, 11.2, 'G', { min: 2 }), rect(7, 10.2, 8, 11.2, 'G', { min: 2 }));
  // Head tucked low: the helmet sits lower and closer to the shoulders than any other pose.
  ops.push(helmetOf(6.5, 11.5, 3.1, side));
  return { ops, px: 6, py: 12, extent: 12.6, tall: 1 };
}

/** Cowering: curled into the smallest possible ball, knees drawn to the chest, head buried
 * between the shoulders, weapon slack on the ground beside him rather than presented. Much
 * shorter/rounder footprint than crouching so it reads instantly at 1x. */
function cowerFigure(side: Side): Figure {
  const ops: Op[] = [];
  ops.push(rect(7.5, 12, 10.5, 13, 'T', { max: 1 }), rect(7.5, 13, 10.5, 14.5, 'b', { max: 1 }));
  ops.push(rect(7.5, 12, 10.5, 14.5, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.9 }));
  // A rounded huddled mass — no shoulder-vs-hip taper, the whole body pulled inward.
  ops.push(ell(9, 10, 4, 3.2, 'U', { edge: 'S', min: 2 }));
  ops.push(rect(5.2, 8.5, 12.8, 12.6, 'U', { edge: 'S', lit: 'L', round: 3, max: 1 }));
  ops.push(...beltKitOps(side, 5.5, 12.5, 9.5, 12.6));
  // Arms wrapped up over the head, hugging it down — never reaching for the weapon.
  ops.push(rect(5.5, 6.8, 8, 9.3, 'U', { max: 1 }), rect(10, 6.8, 12.5, 9.3, 'U', { max: 1 }));
  ops.push(seg(6.2, 10.2, 7.4, 7, 1.3, 'S', { min: 2 }), seg(11.8, 10.2, 10.6, 7, 1.3, 'U', { min: 2 }));
  // Weapon left lying flat on the ground beside him.
  ops.push(rect(12, 12.2, 16.5, 14.2, 'w', { edge: 'W', edgeY: true, max: 1 }));
  ops.push(seg(12, 13, 16.5, 13, 0.7, 'W', { min: 2 }), seg(12.2, 13, 16.2, 13, 0.28, 'w', { min: 2 }));
  ops.push(helmetOf(9, 7.2, 2.9, side));
  return { ops, px: 9, py: 10, extent: 9.5, tall: 2 };
}

/** Panicked / broken: running crouched low with the weapon lowered/trailing and both arms
 * flung wide for balance — nothing like the disciplined crouch of `crouchingFigure`. Wide
 * asymmetric leg stride reads as a man in flight even at 1x. */
function panickedFigure(side: Side, frame: 0 | 1): Figure {
  const ops: Op[] = [];
  const lead = frame === 0 ? 1 : -1;
  ops.push(...legOps(4 + lead, 12.5, 8), ...legOps(11 - lead, 13.5, 5));
  ops.push(rect(5, 8.5, 13, 13.5, 'U', { edge: 'S', lit: 'L', round: 1 }));
  ops.push(...beltKitOps(side, 5, 13, 9, 13.5));
  // Arms flung wide, well away from the body — no weapon in a firing grip.
  ops.push(rect(2, 8, 4.5, 10, 'U', { max: 1 }), rect(13.5, 7.5, 16, 9.5, 'U', { max: 1 }));
  ops.push(seg(6, 10, 2.5, 8.5, 1.4, 'S', { min: 2 }), seg(12, 9.5, 15.5, 8, 1.4, 'U', { min: 2 }));
  ops.push(rect(1.5, 7.5, 2.5, 8.5, 'G', { min: 2 }), rect(15, 7, 16, 8, 'G', { min: 2 }));
  // Weapon dragged low behind him by a sling, never raised.
  ops.push(rect(-1, 14, 5, 16, 'w', { edge: 'W', edgeY: true, max: 1 }));
  ops.push(seg(-1, 15, 5.5, 15.4, 0.7, 'W', { min: 2 }), seg(-0.8, 15, 5.2, 15.4, 0.28, 'w', { min: 2 }));
  ops.push(helmetOf(9, 7, 3.4, side));
  return { ops, px: 9, py: 10, extent: 11 };
}

/** Wary / alert: a deeper, more tense crouch than the ordinary crouching stance, weapon raised
 * and levelled with both hands (rather than the relaxed one-hand grip), facing the threat
 * direction the caller passes in as `facing`. */
function waryFigure(side: Side, frame: 0 | 1): Figure {
  const ops: Op[] = [];
  const wob = frame === 1 ? 0.6 : 0;
  ops.push(rect(6.5 + wob, 12.5, 8.5 + wob, 14.5, 'T', { max: 1 }), rect(6.5 + wob, 14.5, 8.5 + wob, 16, 'b', { max: 1 }));
  ops.push(rect(6.5 + wob, 12.5, 8.5 + wob, 16, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  ops.push(seg(10, 12.5, 12, 14.9, 2, 'T', { max: 1 }), seg(12.3, 15.2, 13.1, 16.1, 1.7, 'b', { max: 1 }));
  ops.push(seg(10, 12.2, 11.8, 14.4, 2, 'T', { min: 2 }), seg(11.7, 14.2, 13, 15.9, 1.9, 'b', { min: 2 }), seg(12.7, 15.6, 13.3, 16.1, 1, 'k', { min: 2 }));
  // Lower, tighter torso than the calm crouch — hunkered down watching the threat direction.
  ops.push(rect(5, 7.8, 12, 12.6, 'U', { edge: 'S', lit: 'L', round: 1.2 }));
  ops.push(...beltKitOps(side, 5, 12, 8.2, 12.6));
  // Weapon shouldered and levelled two-handed, held higher/further forward than the calm pose.
  ops.push(seg(10.6, 9.5, 12.4, 8, 1.5, 'U', { min: 2 }), rect(12.2, 7.4, 13.2, 8.4, 'G', { min: 2 }));
  ops.push(seg(6, 8.6, 11.6, 3.6, 1.4, 'S', { min: 2 }), rect(12, 2.8, 13, 3.8, 'G', { min: 2 }));
  ops.push(...rifleOps(11.6, -0.5, 8, true));
  ops.push(helmetOf(8.5, 6.5, 3.7, side));
  return { ops, px: 8.5, py: 9, extent: 10, tall: 2 };
}

/** Berserk: upright, leaning hard into a charge, weapon presented aggressively out front
 * (bayonet-forward) — a wider, more forward-leaning stride than the calm standing walk. */
function berserkFigure(side: Side, frame: 0 | 1): Figure {
  const ops: Op[] = [];
  ops.push(...legOps(5, 12.5, frame === 0 ? 9 : 7), ...legOps(11, 12.5, frame === 0 ? 7 : 9));
  // Torso pitched forward: shifted north of the hip pivot with a pronounced lean.
  ops.push(rect(5, 6.5, 12.5, 12.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5, 12.5, 7, 12.5));
  ops.push(seg(11.5, 8.5, 13.5, 8, 1.4, 'U', { min: 2 }), rect(13.25, 7.25, 14.25, 8.25, 'G', { min: 2 }));
  ops.push(seg(6.5, 7.5, 12.5, 2, 1.3, 'S', { min: 2 }), rect(12.75, 1.25, 13.75, 2.25, 'G', { min: 2 }));
  // Rifle thrust out ahead of the body, further forward than the calm presented pose.
  ops.push(...rifleOps(12.5, -3.5, 9, true));
  ops.push(helmetOf(8.75, 5.5, 3.5, side));
  return { ops, px: 8.75, py: 9.5, extent: 12.5 };
}

/** Surrendered: standing straight, both arms raised high, weapon absent — must be unmistakable
 * even at 1x, so the raised arms are drawn as two long light bars well clear of the silhouette. */
function surrenderedFigure(side: Side): Figure {
  const ops: Op[] = [];
  ops.push(...legOps(6, 12.5, 6.5), ...legOps(10, 12.5, 6.5));
  ops.push(rect(5.5, 8.5, 12.5, 13.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5.5, 12.5, 9, 13.5));
  // Both arms raised and converging to a point just above the helmet — a narrow "V", which
  // (unlike a weapon silhouette, always a single bar off to one side) stays close to the body
  // and reads as "hands up" under any facing rotation rather than smearing into a long spike.
  ops.push(seg(6.6, 8.7, 9, 1.2, 1.3, 'S', { max: 1 }), seg(11.4, 8.7, 9, 1.2, 1.3, 'U', { max: 1 }));
  ops.push(rect(8.3, 0.3, 9.7, 1.7, 'G', { max: 1 }));
  ops.push(seg(6.6, 8.5, 9, 0.6, 1.1, 'S', { min: 2 }), seg(11.4, 8.5, 9, 0.6, 1.1, 'U', { min: 2 }));
  ops.push(rect(8.4, 0, 9.6, 1.3, 'G', { min: 2 }));
  ops.push(helmetOf(9, 7.5, 3.5, side));
  return { ops, px: 9.5, py: 10.5, extent: 11 };
}

// ------------------------------------------------------------- palette ----
const BOOT = '#241f18';
const WEAPON = '#141412';
const WEAPON_HI = '#4c4c48';
/** 1x weapon highlight: light steel, clearly brighter than any ground tone. */
const WEAPON_HI_1X = '#b4b6ac';
const STOCK = '#6e4a2a';
const SKIN = '#c9a37c';
const LEATHER = '#241c14';
const BUCKLE = '#8a8a7c';
/** wf19: the dark outline is now a thin directional edge, strong only on the side away from the
 * NW light ('X'); the lit side ('x') is a faint dark hairline for enemies and a thin warm edge
 * light for the player's own men (replaces the old gold halo ring). */
const OUTLINE_COLOR = 'rgba(18,18,14,0.86)';
const OUTLINE_LIT_COLOR = 'rgba(18,18,14,0.42)';
/** Baked SE contact / cast shadow: 'z' the crisp core next to the body, 'q' the soft tip. */
const SHADOW_CORE: Record<'summer' | 'winter', string> = { summer: 'rgba(8,10,6,0.55)', winter: 'rgba(36,44,70,0.5)' };
const SHADOW_TIP: Record<'summer' | 'winter', string> = { summer: 'rgba(8,10,6,0.28)', winter: 'rgba(36,44,70,0.26)' };
/** wf5: the player's own soldiers get a faint pale-gold rim outside the dark
 * outline (period-feel "your men" cue, not an RTS selection glow). Slightly
 * deeper and stronger on snow, where pale gold alone would vanish. */
const FRIENDLY_RIM: Record<'summer' | 'winter', string> = {
  summer: 'rgba(255,232,160,0.62)',
  winter: 'rgba(196,150,40,0.7)',
};

interface UniformPalette { u: string; s: string; helmetMid: string; helmetLight: string; kit: string; sling: string }
// wf5 side readability: German field grey with a cool blue-grey cast and a
// darker helmet; Soviet warm khaki / olive-brown with a lighter, more olive
// helmet. The two now differ in hue (blue-grey vs brown) AND helmet value.
// wf19: both uniforms lifted well clear of the ground's value range (the old ones sat at the
// same luminance as summer grass and read as dark blobs); hue still separates the sides.
const GERMAN_SUMMER: UniformPalette = { u: '#85938f', s: '#5b6a6b', helmetMid: '#5a6468', helmetLight: '#7d898c', kit: '#8a8466', sling: '#3a3a2e' };
const SOVIET_SUMMER: UniformPalette = { u: '#c0a468', s: '#8f7442', helmetMid: '#777c46', helmetLight: '#969c5c', kit: '#9c9464', sling: '#5a4a2a' };
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

function colorsFor(side: Side, season: Season, dead: boolean, outline: SoldierOutline, scale = 1): Record<string, string> {
  const pal = paletteFor(side, season);
  const winter = season === 'winter';
  const base: Record<string, string> = {
    U: pal.u,
    L: lightenHex(pal.u, 0.3),
    S: darkenHex(pal.s, 0.72),
    V: WINTER_SE_SHADE,
    T: winter ? darkenHex(WINTER_SMOCK.s, 0.92) : darkenHex(pal.s, 0.85),
    H: pal.helmetMid,
    h: lightenHex(pal.helmetLight, 0.22),
    D: darkenHex(pal.helmetMid, 0.78),
    W: WEAPON, w: scale >= 2 ? WEAPON_HI : WEAPON_HI_1X, K: STOCK, J: darkenHex(STOCK, 0.62), Q: winter ? '#6e6a5c' : pal.sling,
    G: SKIN,
    b: BOOT, B: '#3a342a', k: darkenHex(BOOT, 0.55),
    E: winter ? '#6a665a' : LEATHER, e: winter ? '#b8b6a8' : pal.kit, Z: BUCKLE,
    R: 'rgba(96,24,16,0.72)',
  };
  base.O = darkenHex(base.H, 0.6);
  base.P = lightenHex(base.h, scale >= 2 ? 0.55 : 0.72);
  if (dead) {
    const fix = (c: string) => (c.startsWith('#') ? darkenHex(desaturateHex(c, 0.45), 0.58) : c);
    for (const k of Object.keys(base)) base[k] = fix(base[k]);
  }
  const friendly = outline === 'friendly' && !dead;
  const sk = winter ? 'winter' : 'summer';
  base.X = OUTLINE_COLOR;
  base.x = friendly ? FRIENDLY_RIM[sk] : OUTLINE_LIT_COLOR;
  base.z = SHADOW_CORE[sk];
  base.q = SHADOW_TIP[sk];
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

/** Every pose `unitRender.ts` can ask for: the three calm stances, `dead`, and the mental-state
 * / health poses from round5-battle.md fix #4 §1/§3 — cowering, panicked (also used for
 * routed/broken, which likewise "cannot act"), pinned, wary (also used for shaken), berserk,
 * surrendered, and woundedCrawl (incapacitated but alive). */
export type SoldierPose =
  | Stance | 'dead' | 'cowering' | 'panicked' | 'pinned' | 'wary' | 'berserk' | 'surrendered' | 'woundedCrawl';

function figureFor(side: Side, stance: SoldierPose, frame: 0 | 1): Figure {
  switch (stance) {
    case 'dead': return deadFigure(side);
    case 'woundedCrawl': return woundedCrawlFigure(side);
    case 'pinned': return pinnedFigure(side);
    case 'cowering': return cowerFigure(side);
    case 'panicked': return panickedFigure(side, frame);
    case 'wary': return waryFigure(side, frame);
    case 'berserk': return berserkFigure(side, frame);
    case 'surrendered': return surrenderedFigure(side);
    case 'prone': return proneFigure(side);
    case 'crouching': return crouchingFigure(side, frame);
    default: return standingFigure(side, frame);
  }
}

/** Poses that hold still (no run-cycle second frame) share frame 0 regardless of the caller's
 * animation frame, same as the existing prone/dead handling. */
const STILL_POSES = new Set<SoldierPose>(['dead', 'prone', 'pinned', 'cowering', 'surrendered', 'woundedCrawl']);

/** Rasterise a figure at `scale` and `facing` into an N x N character grid
 * (row-major, '' = empty) with the pivot exactly at the canvas centre. */
function rasterise(fig: Figure, facing: Facing8, scale: number, winter: boolean): { n: number; cells: string[] } {
  const rings = 1 + (fig.tall ?? 3); // outline + the baked SE shadow
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

/** wf19: grow (a) a 1-output-pixel outline that is dark on the side away from the NW light
 * ('X') and a faint hairline / warm friendly edge light on the lit side ('x'), and (b) the baked
 * contact shadow: the silhouette cast to the SE, `tall` steps long (in 1x px), its first half a
 * crisp dark core ('z'), the rest a soft tip ('q'). Replaces the old full dark ring + halo rings
 * that turned 1x soldiers into dark blobs. */
function growRings(n: number, cells: string[], scale: number, tall: number): void {
  const solid = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < n && yy < n && cells[yy * n + xx] !== '';
  const ring: [number, string][] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (cells[y * n + x] !== '') continue;
      const w = solid(x - 1, y), e = solid(x + 1, y), no = solid(x, y - 1), so = solid(x, y + 1);
      if (!(w || e || no || so)) continue;
      // body only to the east / south of this pixel => it sits on the lit NW edge
      ring.push([y * n + x, (e || so) && !w && !no ? 'x' : 'X']);
    }
  }
  for (const [i, ch] of ring) cells[i] = ch;
  const steps = tall * scale;
  const core = Math.max(1, Math.ceil(steps / 2));
  const shadow: [number, string][] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (cells[y * n + x] !== '') continue;
      for (let k = 1; k <= steps; k++) {
        if (solid(x - k, y - k)) { shadow.push([y * n + x, k <= core ? 'z' : 'q']); break; }
      }
    }
  }
  for (const [i, ch] of shadow) cells[i] = ch;
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
  side: Side, season: Season, stance: SoldierPose, facing: Facing8, frame: 0 | 1,
  outline: SoldierOutline = 'enemy', scale = 1,
): HTMLCanvasElement {
  const s = scale >= 2 ? 2 : 1;
  const fig = figureFor(side, stance, STILL_POSES.has(stance) ? 0 : frame);
  const { n, cells } = rasterise(fig, facing, s, season === 'winter');
  growRings(n, cells, s, fig.tall ?? 3);
  return paint(n, cells, colorsFor(side, season, stance === 'dead', stance === 'dead' ? 'enemy' : outline, s));
}

/** The character grid behind a soldier sprite (row-major, '' = empty; 'X'/'x' outline, 'z'/'q'
 * baked shadow, 'P' helmet specular, 'w'/'W' weapon, ...). Pure — for tests and tools. */
export function soldierCells(side: Side, stance: SoldierPose, facing: Facing8, frame: 0 | 1 = 0, scale = 1, winter = false): { n: number; cells: string[] } {
  const s = scale >= 2 ? 2 : 1;
  const fig = figureFor(side, stance, STILL_POSES.has(stance) ? 0 : frame);
  const out = rasterise(fig, facing, s, winter);
  growRings(out.n, out.cells, s, fig.tall ?? 3);
  return out;
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
  ops.push(rect(7 + wob, 12, 9 + wob, 13.5, 'T', { max: 1 }), rect(7 + wob, 13.5, 9 + wob, 15, 'b', { max: 1 }));
  ops.push(rect(7 + wob, 12, 9 + wob, 15, 'b', { edge: 'k', lit: 'B', min: 2, round: 0.75 }));
  ops.push(seg(10.3, 12, 12.6, 14.1, 1.9, 'T', { max: 1 }), seg(12.9, 14.4, 13.8, 15.3, 1.7, 'b', { max: 1 }));
  ops.push(seg(10.3, 11.8, 12.3, 13.8, 2, 'T', { min: 2 }), seg(12.1, 13.6, 13.7, 15.1, 1.9, 'b', { min: 2 }), seg(13.4, 14.9, 13.9, 15.4, 1, 'k', { min: 2 }));
  ops.push(rect(5, 8, 12.5, 12.5, 'U', { edge: 'S', lit: 'L', round: 1.5 }));
  ops.push(...beltKitOps(side, 5, 12.5, 8.5, 12.5));
  return ops;
}

/** Standing / walking body without arms or weapon (legs swap with the walk frame). */
function walkBodyOps(side: Side, frame: 0 | 1): Op[] {
  const ops: Op[] = [];
  ops.push(...strideLegs(frame));
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
      return { ops, px: 9, py: 9, extent: 9.5, tall: 2 };
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
      return { ops, px: 9, py: 9, extent: 10.5, tall: 2 };
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
      return { ops, px: 9, py: 9, extent: 10.5, tall: 2 };
    }
    case 'mgProne': {
      const ops = proneBody(side);
      ops.push(rect(3, 9, 5, 11, 'U', { max: 1 }), rect(8, 9, 10, 11, 'U', { max: 1 }));
      ops.push(seg(3.5, 13, 5, 7.5, 1.6, 'U', { min: 2 }), seg(9.5, 13, 8, 7.5, 1.6, 'U', { min: 2 }));
      ops.push(rect(4.5, 6.5, 5.5, 7.5, 'G', { min: 2 }), rect(7.5, 6.5, 8.5, 7.5, 'G', { min: 2 }));
      ops.push(helmetOf(6.5, 10, 3.5, side));
      return { ops, px: 6, py: 12, extent: 12.6, tall: 1 };
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
  growRings(n, cells, s, fig.tall ?? 3);
  const colors = { ...colorsFor(side, season, false, outline, s), M: '#56594a', N: '#b39a52', n: '#7c6a34' };
  const c = paint(n, cells, colors);
  crewPoseCache.set(key, c);
  if (crewPoseCache.size > CREW_POSE_CACHE_CAP) crewPoseCache.delete(crewPoseCache.keys().next().value as string);
  return c;
}
