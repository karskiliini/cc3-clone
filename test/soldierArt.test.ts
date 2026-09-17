// wf19 legibility rules for the 1x soldier figures, checked on the pure character grid behind
// each sprite (no canvas needed): footprint, helmet specular, weapon highlight, SE contact
// shadow, directional outline, and stance silhouettes.
import { describe, expect, it } from 'vitest';
import { soldierCells, type SoldierPose } from '@/render/soldierArt';
import type { Facing8 } from '@/shared/types';

const BODY = (c: string) => c !== '' && c !== 'X' && c !== 'x' && c !== 'z' && c !== 'q';
const FIGURE = (c: string) => BODY(c) && c !== 'w' && c !== 'W' && c !== 'K' && c !== 'J' && c !== 'G';

function bounds(n: number, cells: string[], pick: (c: string) => boolean) {
  let x0 = n, x1 = -1, y0 = n, y1 = -1, count = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!pick(cells[y * n + x])) continue;
    count++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, count, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
const count = (cells: string[], ch: string) => cells.filter((c) => c === ch).length;

describe('1x soldier legibility', () => {
  it('a standing man (without his weapon) is 12-15 px long and narrower than long', () => {
    for (const fr of [0, 1] as const) {
      const { n, cells } = soldierCells('german', 'standing', 0, fr, 1);
      const b = bounds(n, cells, FIGURE);
      expect(b.h).toBeGreaterThanOrEqual(12);
      expect(b.h).toBeLessThanOrEqual(15);
      expect(b.w).toBeLessThan(b.h);
    }
  });

  it('prone reads elongated with boots; crouched reads compact', () => {
    const stand = soldierCells('soviet', 'standing', 0, 0, 1), prone = soldierCells('soviet', 'prone', 0, 0, 1), crouch = soldierCells('soviet', 'crouching', 0, 0, 1);
    const bs = bounds(stand.n, stand.cells, FIGURE), bp = bounds(prone.n, prone.cells, FIGURE), bc = bounds(crouch.n, crouch.cells, FIGURE);
    expect(bp.h).toBeGreaterThan(bs.h);
    expect(bp.h / bp.w).toBeGreaterThan(1.6);
    expect(count(prone.cells, 'b')).toBeGreaterThanOrEqual(4); // two boots
    expect(bc.h).toBeLessThan(bs.h);
    expect(bc.h / bc.w).toBeLessThan(1.35);
  });

  it('every live pose at every facing has a helmet specular dot, a lit weapon-or-body edge and a SE shadow', () => {
    const poses: SoldierPose[] = ['standing', 'crouching', 'prone', 'wary', 'panicked', 'berserk', 'woundedCrawl'];
    for (const pose of poses) {
      for (let f = 0; f < 8; f++) {
        const { n, cells } = soldierCells('german', pose, f as Facing8, 0, 1);
        const spec = count(cells, 'P');
        expect(spec, `${pose} f${f} specular`).toBeGreaterThanOrEqual(1);
        expect(spec, `${pose} f${f} specular stays a dot`).toBeLessThanOrEqual(4);
        expect(count(cells, 'w'), `${pose} f${f} weapon highlight`).toBeGreaterThanOrEqual(2);
        expect(count(cells, 'W'), `${pose} f${f} weapon dark side`).toBeGreaterThanOrEqual(2);
        // shadow lies to the SE of the body's centre
        const body = bounds(n, cells, BODY);
        const sh = bounds(n, cells, (c) => c === 'z' || c === 'q');
        expect(sh.count, `${pose} f${f} shadow`).toBeGreaterThan(3);
        expect(sh.cx + sh.cy).toBeGreaterThan(body.cx + body.cy);
      }
    }
  });

  it('the helmet highlight sits on the NW side whatever the facing (light is fixed in screen space)', () => {
    for (let f = 0; f < 8; f++) {
      const { n, cells } = soldierCells('soviet', 'standing', f as Facing8, 0, 1);
      const helmet = bounds(n, cells, (c) => c === 'P' || c === 'h' || c === 'H' || c === 'D' || c === 'O');
      const spec = bounds(n, cells, (c) => c === 'P');
      expect(spec.cx + spec.cy).toBeLessThan(helmet.cx + helmet.cy);
    }
  });

  it('outline is directional: a lit-side hairline to the NW, the dark contact edge to the SE; no halo rings', () => {
    const { n, cells } = soldierCells('german', 'standing', 2, 0, 1);
    const lit = bounds(n, cells, (c) => c === 'x'), dark = bounds(n, cells, (c) => c === 'X');
    expect(lit.count).toBeGreaterThan(4);
    expect(dark.count).toBeGreaterThan(lit.count);
    expect(count(cells, 'Y') + count(cells, 'y')).toBe(0);
  });

  it('taller poses throw longer shadows than men lying down; 2x sprites keep all the cues', () => {
    const shadowOf = (pose: SoldierPose) => { const r = soldierCells('german', pose, 0, 0, 1); return r.cells.filter((c) => c === 'z' || c === 'q').length / bounds(r.n, r.cells, BODY).count; };
    expect(shadowOf('standing')).toBeGreaterThan(shadowOf('prone'));
    const two = soldierCells('german', 'standing', 1, 0, 2);
    expect(count(two.cells, 'P')).toBeGreaterThan(0);
    expect(count(two.cells, 'z')).toBeGreaterThan(0);
    expect(count(two.cells, 'x')).toBeGreaterThan(0);
  });
});
