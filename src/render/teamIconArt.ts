// ============================================================================
// teamIconArt.ts — hand-authored 40x26 painted-miniature team icons for the
// battle HUD team grid and the Requisition force pool, replacing the old
// flat vector silhouettes. Each icon is built as a 2D grid of characters (one
// char per pixel), following the same method as soldierArt.ts/vehicleArt.ts:
// dedicated builder code stamps small pixel groups (helmet, tunic, legs,
// weapon, tracks...) onto a blank grid, which is then painted onto a canvas
// via a small palette. The lower third of every icon carries a soft pale
// "ground wash" band (like the original's little painted vignettes); the
// rest of the canvas stays transparent so the HUD's maroon panel shows
// through around the figures/vehicles.
// ============================================================================
import { createCanvas, ctx2d, putPixelArt } from '@/render/pixelUtil';

export const ICON_W = 40;
export const ICON_H = 26;

// --------------------------------------------------------------- palette ---
// Icons are side-neutral (one set serves both German and Soviet force
// pools): a neutral olive stands in for field-grey/khaki uniforms.
const PALETTE: Record<string, string> = {
  k: '#1a1712', // outline
  g: '#707a58', // olive uniform (main)
  G: '#8d9672', // olive uniform (light/highlight)
  h: '#4e5545', // helmet
  f: '#c9a37c', // skin
  w: '#2b2b28', // weapon metal
  b: '#6b4a2e', // wood (stock/handle)
  a: '#6c6f66', // armour plate
  A: '#8d9088', // armour plate (light)
  r: '#3a3a36', // rubber / roadwheel
  t: '#2e2c26', // track
  d: '#7a6a48', // ground line
  y: '#b8b09a', // pale background wash
};

// ----------------------------------------------------------------- grid ---
type Grid = string[][];

function blank(w: number, h: number): Grid {
  return Array.from({ length: h }, () => Array<string>(w).fill('.'));
}

function put(g: Grid, x: number, y: number, ch: string): void {
  const xi = Math.round(x), yi = Math.round(y);
  if (yi < 0 || yi >= g.length || xi < 0 || xi >= g[0].length) return;
  g[yi][xi] = ch;
}

function rect(g: Grid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) put(g, x, y, ch);
  }
}

/** Bresenham line, used for weapon barrels/tubes/arms. */
function line(g: Grid, x0: number, y0: number, x1: number, y1: number, ch: string, w = 1): void {
  let ix0 = Math.round(x0), iy0 = Math.round(y0);
  const ix1 = Math.round(x1), iy1 = Math.round(y1);
  const dx = Math.abs(ix1 - ix0), dy = -Math.abs(iy1 - iy0);
  const sx = ix0 < ix1 ? 1 : -1, sy = iy0 < iy1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    put(g, ix0, iy0, ch);
    if (w > 1) put(g, ix0, iy0 + 1, ch);
    if (ix0 === ix1 && iy0 === iy1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; ix0 += sx; }
    if (e2 <= dx) { err += dx; iy0 += sy; }
  }
}

function toRows(g: Grid): string[] {
  return g.map((row) => row.join(''));
}

// ------------------------------------------------------------ ground wash --
const GROUND_LINE = 21; // darker ground-line row
const WASH_TOP = 17; // pale wash band starts here (lower third of 26px)

function paintWash(g: Grid): void {
  rect(g, 0, WASH_TOP, ICON_W - 1, ICON_H - 1, 'y');
  rect(g, 0, GROUND_LINE, ICON_W - 1, GROUND_LINE, 'd');
}

// ------------------------------------------------------------- figures ----
const GY = 21; // feet/baseline row for standing figures

interface ManOpts {
  crouch?: boolean;
  prone?: boolean;
  facesRight?: boolean;
}

/** Small painted soldier: helmet, face sliver, tunic (2-tone), legs, boots.
 * `cx` is the horizontal centre; the figure occupies roughly 7px wide. */
function drawMan(g: Grid, cx: number, groundY: number, opts: ManOpts = {}): void {
  const { crouch, prone } = opts;
  if (prone) {
    const y = groundY - 1;
    // Long low body lying flat, helmet bump at the near end.
    rect(g, cx - 6, y, cx + 5, y, 'g');
    rect(g, cx - 6, y - 1, cx - 2, y - 1, 'g');
    put(g, cx - 7, y, 'h');
    put(g, cx - 7, y - 1, 'h');
    put(g, cx - 8, y, 'k');
    rect(g, cx - 6, y + 1, cx + 5, y + 1, 'k');
    put(g, cx - 6, y - 2, 'k');
    return;
  }
  const top = groundY - (crouch ? 9 : 12);
  // Helmet (2 rows: dome + brim shadow).
  rect(g, cx - 1, top, cx + 1, top, 'h');
  rect(g, cx - 1, top + 1, cx + 1, top + 1, 'h');
  put(g, cx - 2, top + 1, 'k');
  put(g, cx + 2, top + 1, 'k');
  put(g, cx, top - 1, 'k');
  // Face sliver under the brim.
  put(g, cx - 1, top + 2, 'f');
  put(g, cx, top + 2, 'f');
  put(g, cx + 1, top + 2, 'k');
  // Tunic: 2-tone body.
  const tTop = top + 3;
  const tBot = tTop + (crouch ? 3 : 5);
  rect(g, cx - 2, tTop, cx + 2, tBot, 'g');
  rect(g, cx, tTop, cx, tBot, 'G');
  rect(g, cx - 3, tTop, cx - 3, tBot, 'k');
  rect(g, cx + 3, tTop, cx + 3, tBot, 'k');
  // Legs: walking stride, boots dark.
  const lTop = tBot + 1;
  rect(g, cx - 2, lTop, cx - 1, groundY - 1, 'g');
  rect(g, cx + 1, lTop, cx + 2, groundY - 1, 'g');
  rect(g, cx - 2, groundY, cx - 1, groundY, 'k');
  rect(g, cx + 1, groundY, cx + 2, groundY, 'k');
  put(g, cx, lTop, 'k');
}

/** Kneeling figure — shorter torso, one bent leg forward. Used for gun
 * crews, the mortar man, the AT rocket team and the engineer. */
function drawKneelingMan(g: Grid, cx: number, groundY: number): void {
  const top = groundY - 8;
  rect(g, cx - 1, top, cx + 1, top, 'h');
  put(g, cx - 2, top, 'k');
  put(g, cx + 2, top, 'k');
  put(g, cx - 1, top + 1, 'f');
  put(g, cx, top + 1, 'f');
  const tTop = top + 2;
  const tBot = tTop + 3;
  rect(g, cx - 2, tTop, cx + 2, tBot, 'g');
  rect(g, cx, tTop, cx, tBot, 'G');
  rect(g, cx - 3, tTop, cx - 3, tBot, 'k');
  rect(g, cx + 3, tTop, cx + 3, tBot, 'k');
  // Bent knee forward, shin down to the ground.
  rect(g, cx - 2, tBot + 1, cx - 1, groundY - 1, 'g');
  rect(g, cx + 1, tBot + 1, cx + 3, tBot + 1, 'g');
  rect(g, cx - 2, groundY, cx - 1, groundY, 'k');
  rect(g, cx + 1, tBot + 2, cx + 3, tBot + 2, 'k');
}

// --------------------------------------------------------------- vehicles -
function drawTankSide(g: Grid, cx: number, groundY: number, hasTurret: boolean): void {
  const hullW = 26, hullH = 6, hullX = cx - hullW / 2, hullY = groundY - hullH;
  rect(g, hullX, hullY, hullX + hullW, groundY, 'a');
  rect(g, hullX, hullY, hullX + hullW, hullY, 'A');
  rect(g, hullX, hullY, hullX, groundY, 'k');
  rect(g, hullX + hullW, hullY, hullX + hullW, groundY, 'k');
  // Track band + 5 road wheels.
  rect(g, hullX - 1, groundY, hullX + hullW + 1, groundY, 't');
  for (let i = 0; i < 5; i++) put(g, hullX + 3 + i * ((hullW - 6) / 4), groundY, 'r');
  if (hasTurret) {
    const tw = 11, th = 5, tx = cx - tw / 2, ty = hullY - th;
    rect(g, tx, ty, tx + tw - 2, hullY, 'a');
    rect(g, tx, ty, tx + tw - 2, ty, 'A');
    rect(g, tx, ty, tx, hullY, 'k');
    rect(g, tx + tw - 2, ty, tx + tw - 2, hullY, 'k');
    line(g, tx + tw - 2, ty + 1, hullX + hullW + 7, ty - 1, 'w', 1);
  } else {
    // Casemate superstructure biased forward, gun straight out.
    const bw = 13, bh = 6, bx = hullX + 3, by = hullY - bh;
    rect(g, bx, by, bx + bw, hullY, 'a');
    rect(g, bx, by, bx + bw, by, 'A');
    rect(g, bx, by, bx, hullY, 'k');
    line(g, bx + bw, by + 2, hullX + hullW + 8, by + 1, 'w', 1);
  }
}

// ============================================================= builder ====
function buildGrid(id: string): Grid {
  const g = blank(ICON_W, ICON_H);
  paintWash(g);
  const gy = GY;
  switch (id) {
    case 'rifle':
      drawMan(g, 12, gy); line(g, 14, gy - 12, 21, gy - 16, 'w');
      drawMan(g, 27, gy); line(g, 29, gy - 12, 36, gy - 16, 'w');
      break;
    case 'smg':
      drawMan(g, 13, gy); line(g, 15, gy - 11, 20, gy - 13, 'w');
      drawMan(g, 27, gy); line(g, 29, gy - 11, 34, gy - 13, 'w');
      break;
    case 'mg': {
      drawKneelingMan(g, 12, gy);
      // Prone gunner with a bipod MG, muzzle forward.
      // Prone body: a proper 2-row block (not a hairline) so it reads as a
      // gunner, not a stray pixel.
      const by = gy - 2;
      rect(g, 17, by, 29, gy - 1, 'g');
      rect(g, 17, by, 20, by, 'G'); // shoulder highlight
      put(g, 15, by, 'h'); put(g, 15, by + 1, 'h'); // helmet at the near end
      put(g, 14, by + 1, 'k');
      rect(g, 17, gy, 29, gy, 'k'); // ground-contact shading
      line(g, 22, by - 1, 34, by - 2, 'w'); // MG barrel forward
      line(g, 30, by - 2, 29, gy, 'k'); // bipod leg
      line(g, 30, by - 2, 32, gy, 'k'); // bipod leg
      break;
    }
    case 'mortar': {
      const bx = 12;
      line(g, bx, gy, bx + 9, gy - 15, 'w', 1); // tube at ~60deg
      line(g, bx, gy, bx + 9, gy - 15, 'b');
      rect(g, bx - 4, gy, bx + 5, gy, 'k'); // baseplate
      rect(g, bx - 3, gy - 1, bx + 4, gy - 1, 'a');
      drawKneelingMan(g, 27, gy);
      break;
    }
    case 'atgun': {
      // Wheeled gun with a shield, one crewman.
      rect(g, 8, gy - 8, 12, gy - 1, 'a');
      rect(g, 8, gy - 8, 12, gy - 8, 'A');
      rect(g, 8, gy - 8, 8, gy - 1, 'k');
      put(g, 10, gy - 5, 'w');
      line(g, 12, gy - 5, 30, gy - 9, 'w');
      put(g, 10, gy, 'r'); put(g, 9, gy, 'k'); put(g, 11, gy, 'k');
      drawKneelingMan(g, 21, gy);
      break;
    }
    case 'sniper':
      drawMan(g, 22, gy, { prone: true });
      line(g, 20, gy - 3, 34, gy - 6, 'w');
      put(g, 30, gy - 5, 'b');
      break;
    case 'atteam':
      drawKneelingMan(g, 11, gy);
      line(g, 13, gy - 8, 34, gy - 11, 'b', 2); // rocket tube on the shoulder
      put(g, 33, gy - 12, 'w'); put(g, 34, gy - 11, 'w'); put(g, 33, gy - 10, 'w'); // warhead
      break;
    case 'tank':
      drawTankSide(g, ICON_W / 2, gy, true);
      break;
    case 'spg':
      drawTankSide(g, ICON_W / 2, gy, false);
      break;
    case 'halftrack': {
      // Armoured open-top troop compartment: front wheel, rear tracks, two
      // round helmets visible above the rim.
      const hullX = 5, hullW = 30, hullY = gy - 6;
      rect(g, hullX, hullY, hullX + hullW, gy - 1, 'a');
      rect(g, hullX, hullY, hullX + hullW, hullY, 'A'); // top rim highlight
      rect(g, hullX, hullY, hullX, gy - 1, 'k');
      rect(g, hullX + hullW, hullY, hullX + hullW, gy - 1, 'k');
      // Two round helmets poking above the rim (dome shape, not a spike).
      rect(g, hullX + 9, hullY - 1, hullX + 11, hullY - 1, 'h');
      put(g, hullX + 9, hullY - 2, 'k'); put(g, hullX + 10, hullY - 2, 'h'); put(g, hullX + 11, hullY - 2, 'k');
      rect(g, hullX + 18, hullY - 1, hullX + 20, hullY - 1, 'h');
      put(g, hullX + 18, hullY - 2, 'k'); put(g, hullX + 19, hullY - 2, 'h'); put(g, hullX + 20, hullY - 2, 'k');
      // Front road wheel (rounded blob, not a bare square).
      rect(g, hullX + 1, gy - 2, hullX + 3, gy - 1, 'r');
      put(g, hullX + 2, gy, 'r');
      rect(g, hullX + 1, gy - 3, hullX + 3, gy - 3, 'k');
      // Rear tracks: a solid dark band with a run of road wheels on top.
      rect(g, hullX + 15, gy - 1, hullX + hullW - 1, gy, 't');
      rect(g, hullX + 15, gy - 2, hullX + hullW - 1, gy - 2, 'k');
      for (let i = 0; i < 4; i++) rect(g, hullX + 16 + i * 4, gy - 1, hullX + 17 + i * 4, gy - 1, 'r');
      break;
    }
    case 'command': {
      // Officer with a peaked cap and a raised arm.
      drawMan(g, 13, gy);
      put(g, 13, gy - 13, 'k');
      line(g, 14, gy - 12, 18, gy - 18, 'g'); // raised arm
      put(g, 18, gy - 18, 'f');
      // Radioman with a compact pack and antenna on his back.
      drawMan(g, 27, gy);
      rect(g, 29, gy - 13, 31, gy - 9, 'a'); // radio pack
      rect(g, 29, gy - 13, 31, gy - 13, 'A');
      line(g, 30, gy - 13, 32, gy - 18, 'k'); // antenna
      break;
    }
    case 'engineer':
      drawKneelingMan(g, 14, gy);
      // Shovel resting over the shoulder: wood handle diagonal, flat blade.
      line(g, 17, gy - 7, 25, gy - 16, 'b');
      rect(g, 24, gy - 18, 27, gy - 15, 'w');
      rect(g, 24, gy - 18, 27, gy - 18, 'k');
      // Satchel at the hip.
      rect(g, 18, gy - 5, 22, gy - 1, 'b');
      rect(g, 18, gy - 5, 22, gy - 5, 'k');
      rect(g, 18, gy - 1, 22, gy - 1, 'k');
      break;
    default:
      rect(g, 1, 1, ICON_W - 2, 1, 'k');
      rect(g, 1, ICON_H - 2, ICON_W - 2, ICON_H - 2, 'k');
      rect(g, 1, 1, 1, ICON_H - 2, 'k');
      rect(g, ICON_W - 2, 1, ICON_W - 2, ICON_H - 2, 'k');
  }
  return g;
}

export function buildTeamIcon(id: string): HTMLCanvasElement {
  const c = createCanvas(ICON_W, ICON_H);
  ctx2d(c); // ensure smoothing disabled before paint
  putPixelArt(c, toRows(buildGrid(id)), PALETTE);
  return c;
}
