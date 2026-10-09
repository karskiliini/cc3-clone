import { describe, expect, it } from 'vitest';
import { GrassFx, needsStamp, STAMP_STEP_TILES } from '@/render/grassFx';
import { crushMapFor } from '@/render/grassCrush';
import { VEHICLE_DEFS } from '@/data/units';
import { TILE_M } from '@/shared/types';
import type { BattleState } from '@/shared/types';
import { addTank, makeState, W } from './vehicleDamageHelpers';

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
