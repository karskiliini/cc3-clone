import { describe, expect, it, vi } from 'vitest';
import { GrassFx, needsStamp, STAMP_STEP_TILES } from '@/render/grassFx';
import { crushMapFor } from '@/render/grassCrush';
import { VEHICLE_DEFS } from '@/data/units';
import { TILE_M, TILE_PX, VIEW_H, VIEW_W } from '@/shared/types';
import type { BattleState } from '@/shared/types';
import { addTank, makeState, soldier, W } from './vehicleDamageHelpers';

function tallField(state: BattleState): void {
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) state.map.tiles[y * W + x] = 'tallgrass';
}

describe('grass wake stamping', () => {
  it('lays a stamp only after the vehicle has covered the step distance', () => {
    expect(needsStamp(undefined, { x: 5, y: 5 })).toBe(true);
    expect(needsStamp({ x: 5, y: 5 }, { x: 5 + STAMP_STEP_TILES * 0.5, y: 5 })).toBe(false);
    expect(needsStamp({ x: 5, y: 5 }, { x: 5, y: 5 + STAMP_STEP_TILES + 0.01 })).toBe(true);
  });
});

describe('grass wake: the crush map for the 3D grass', () => {
  it('a visible vehicle driving through tall grass flattens the stretch its tail left', () => {
    const state = makeState(); tallField(state);
    const { v } = addTank(state, 'pz4gh', { x: 30, y: 30 }, 0, 50, 'german');
    const fx = new GrassFx();
    fx.update(state, 'german');
    v.pos = { x: 30, y: 28 }; state.time = 1;
    fx.update(state, 'german');
    const tail = VEHICLE_DEFS.pz4gh.lengthM / 2 / TILE_M;
    const c = crushMapFor(state.map).at({ x: 30, y: 29 + tail });
    expect(c?.level).toBe(1);
    expect(c!.dirRad).toBeCloseTo(0, 1);
    expect(crushMapFor(state.map).at({ x: 30, y: 27 })).toBeNull();   // ahead of the new tail
  });
  it('hidden enemy: an unspotted vehicle crushes nothing', () => {
    const state = makeState(); tallField(state);
    const { v } = addTank(state, 't34_76', { x: 30, y: 30 }, 0, 50, 'soviet');
    const fx = new GrassFx();
    fx.update(state, 'german');
    v.pos = { x: 30, y: 28 }; state.time = 1;
    fx.update(state, 'german');
    expect(crushMapFor(state.map).at({ x: 30, y: 30.5 })).toBeNull();
  });
  it('time jump back: the crush map is cleared with the painted trail', () => {
    const state = makeState(); tallField(state);
    const { v } = addTank(state, 'pz4gh', { x: 30, y: 30 }, 0, 50, 'german');
    const fx = new GrassFx();
    fx.update(state, 'german');
    v.pos = { x: 30, y: 28 }; state.time = 1;
    fx.update(state, 'german');
    state.time = 0.2;
    fx.update(state, 'german');
    const tail = VEHICLE_DEFS.pz4gh.lengthM / 2 / TILE_M;
    expect(crushMapFor(state.map).at({ x: 30, y: 29 + tail })).toBeNull();
  });
});

/** A 2D context that only counts strokes. */
function strokeCounter(): { ctx: CanvasRenderingContext2D; strokes: () => number } {
  let n = 0;
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k === 'stroke' ? () => { n++; } : k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, strokes: () => n };
}

describe('2D fringe hand-over', () => {
  it('a vehicle standing in 3D grass gets no 2D fringe; the others keep theirs', () => {
    const state = makeState(); tallField(state);
    const { v } = addTank(state, 'pz4gh', { x: 30, y: 30 }, 0, 50, 'german');
    const cam = { x: 30 - VIEW_W / (2 * TILE_PX), y: 30 - VIEW_H / (2 * TILE_PX), zoom: 1 };
    const fx = new GrassFx();
    const with2d = strokeCounter(), with3d = strokeCounter();
    fx.drawStanding(with2d.ctx, cam, state, 'german');
    fx.drawStanding(with3d.ctx, cam, state, 'german', new Set([v.id]));
    expect(with2d.strokes()).toBeGreaterThan(10);
    expect(with3d.strokes()).toBe(0);
  });
});


describe('soldier mini-trails', () => {
  function walk(prone = false, spotted = true, x = 30) {
    const state = makeState();
    tallField(state);
    const man = soldier(91, 1, 'soviet', { x, y: 30 }, 'mosin', { stance: prone ? 'prone' : 'standing' });
    state.soldiers.set(man.id, man);
    if (spotted) state.spotted.german.add(man.id);
    const fx = new GrassFx();
    fx.update(state, 'german');
    for (let i = 1; i <= 40; i++) {
      man.pos = { x, y: 30 - i * 0.25 };
      state.time = i * 0.1;
      fx.update(state, 'german');
    }
    const cells = Array.from({ length: 40 }, (_, i) =>
      crushMapFor(state.map).at({ x, y: 29.875 - i * 0.25 })?.level ?? 0);
    return { state, man, fx, cells };
  }

  it('a spotted walking rifleman presses some but not all cells over 20m', () => {
    const cells = walk().cells;
    const share = cells.filter(Boolean).length / cells.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.6);
  });
  it('a crawling man presses the whole completed path at diverse cell offsets', () => {
    for (const x of [30, 30.125, 30.249]) {
      expect(walk(true, true, x).cells.filter(Boolean).length).toBeGreaterThanOrEqual(39);
    }
  });
  it('an unspotted enemy presses nothing', () => {
    expect(walk(false, false).cells.some(Boolean)).toBe(false);
  });
  it('the same walk produces the identical crushed set', () => {
    const first = walk().cells;
    expect(first.some(Boolean)).toBe(true);
    expect(first).toEqual(walk().cells);
  });
  it.each(['hidden', 'aboard', 'dead', 'open'] as const)('%s does not connect stale movement', (gap) => {
    const { state, man, fx, cells } = walk(true);
    expect(cells.some(Boolean)).toBe(true);
    if (gap === 'hidden') state.spotted.german.clear();
    if (gap === 'aboard') man.vehicleId = 22;
    if (gap === 'dead') man.health = 'dead';
    if (gap === 'open') state.map.tiles[20 * W + 30] = 'open';
    fx.update(state, 'german');
    man.vehicleId = null;
    man.health = 'healthy';
    man.pos = { x: 30, y: 10 };
    state.time += 1;
    state.spotted.german.add(man.id);
    fx.update(state, 'german');
    expect(crushMapFor(state.map).at({ x: 30, y: 15 })).toBeNull();
  });
  it('paints one faint narrow band and two stalk lines without vehicle ruts', () => {
    const rects: { alpha: number; width: number; style: string }[] = [];
    const { ctx, strokes } = strokeCounter();
    ctx.fillRect = (_x, _y, width) => rects.push({ alpha: ctx.globalAlpha, width, style: String(ctx.fillStyle) });
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });
    try {
      const state = makeState();
      tallField(state);
      const man = soldier(92, 1, 'german', { x: 30, y: 30 }, 'kar98k', { stance: 'prone' });
      state.soldiers.set(man.id, man);
      const fx = new GrassFx();
      fx.update(state, 'german');
      man.pos = { x: 30, y: 29.25 };
      state.time = 1;
      fx.update(state, 'german');
      expect(rects).toEqual([{ alpha: 0.16, width: 3, style: '#8f9450' }]);
      expect(strokes()).toBe(2);
      expect(ctx.globalAlpha).toBe(0.3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('rewinding clears soldier trail history with the crush map', () => {
    const { state, man, fx, cells } = walk(true);
    expect(cells.some(Boolean)).toBe(true);
    state.time = 0;
    man.pos = { x: 30, y: 10 };
    fx.update(state, 'german');
    expect(crushMapFor(state.map).at({ x: 30, y: 25 })).toBeNull();
    expect(crushMapFor(state.map).at({ x: 30, y: 15 })).toBeNull();
  });
});
