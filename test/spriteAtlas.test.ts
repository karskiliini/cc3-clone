// Atlas contract maths (spec 2026-09-17 §5) against the placeholder atlases built in the same
// JSON format the Blender scripts will emit.
import { describe, it, expect } from 'vitest';
import {
  atlasCellCount, atlasCellRect, atlasDestRect, atlasFrameIndex, atlasScaleForZoom, battleAtlasNames, drawAtlasFrame,
  drawSoldier, registerAtlas, soldierAtlasName, turretPivotM, validateAtlasMeta, weaponMuzzleM, freeAllAtlases, type AtlasMeta,
} from '@/render/spriteAtlas';
import { entryKeyChain, resolveEntryKey } from '@/render/soldierAnim';
import { buildSoldierPlaceholder, buildVehiclePlaceholder, buildWeaponPlaceholder } from '../tools/placeholderAtlas';

const SPEC_META: AtlasMeta = {
  scale: 1, cell: { w: 40, h: 40 }, anchor: { x: 20, y: 24 }, columns: 32, dirs: 16,
  entries: { 'standing.walk': { start: 0, frames: 6, fps: 9, loop: true }, 'kneeling.fire': { start: 96, frames: 3, fps: 12, loop: false } },
};

describe('atlas index maths', () => {
  it('frame index = start + dir * frames + frame; grid = (index % columns, floor(index / columns))', () => {
    const walk = SPEC_META.entries['standing.walk'], fire = SPEC_META.entries['kneeling.fire'];
    expect(atlasFrameIndex(walk, 16, 0, 0)).toBe(0);
    expect(atlasFrameIndex(walk, 16, 3, 4)).toBe(22);
    expect(atlasFrameIndex(fire, 16, 15, 2)).toBe(96 + 15 * 3 + 2);
    expect(atlasCellRect(SPEC_META, 22)).toEqual({ sx: 22 * 40, sy: 0, sw: 40, sh: 40 });
    expect(atlasCellRect(SPEC_META, 96 + 47)).toEqual({ sx: ((96 + 47) % 32) * 40, sy: Math.floor((96 + 47) / 32) * 40, sw: 40, sh: 40 });
  });

  it('directions wrap, looping frames wrap, one-shot frames clamp', () => {
    const walk = SPEC_META.entries['standing.walk'], fire = SPEC_META.entries['kneeling.fire'];
    expect(atlasFrameIndex(walk, 16, 16, 0)).toBe(atlasFrameIndex(walk, 16, 0, 0));
    expect(atlasFrameIndex(walk, 16, -1, 0)).toBe(atlasFrameIndex(walk, 16, 15, 0));
    expect(atlasFrameIndex(walk, 16, 2, 7)).toBe(atlasFrameIndex(walk, 16, 2, 1));
    expect(atlasFrameIndex(fire, 16, 2, 9)).toBe(atlasFrameIndex(fire, 16, 2, 2));
  });

  it('the anchor pixel lands on the ground position at every zoom / atlas scale', () => {
    expect(atlasDestRect(SPEC_META, 100, 100, 1)).toEqual({ dx: 80, dy: 76, dw: 40, dh: 40 });
    const two: AtlasMeta = { ...SPEC_META, scale: 2, cell: { w: 80, h: 80 }, anchor: { x: 40, y: 48 } };
    expect(atlasDestRect(two, 100, 100, 2)).toEqual({ dx: 60, dy: 52, dw: 80, dh: 80 });   // 1:1 blit
    expect(atlasDestRect(SPEC_META, 100, 100, 0.5)).toEqual({ dx: 90, dy: 88, dw: 20, dh: 20 });
    expect(atlasScaleForZoom(0.5)).toBe(1); expect(atlasScaleForZoom(1)).toBe(1); expect(atlasScaleForZoom(2)).toBe(2);
  });

  it('names the atlases a battle needs', () => {
    expect(soldierAtlasName('german', 'autumn', 1)).toBe('soldiers_german_summer_1');
    expect(battleAtlasNames(['german', 'soviet'], 'winter')).toEqual([
      'soldiers_german_winter_1', 'soldiers_soviet_winter_1', 'weapons_1', 'items_1', 'parts_german_winter_1', 'parts_soviet_winter_1',
      'soldiers_german_winter_2', 'soldiers_soviet_winter_2', 'weapons_2', 'items_2', 'parts_german_winter_2', 'parts_soviet_winter_2',
    ]);
  });

  it('rejects malformed JSON metas', () => {
    expect(validateAtlasMeta(SPEC_META)).toBeNull();
    expect(validateAtlasMeta({})).not.toBeNull();
    expect(validateAtlasMeta({ ...SPEC_META, entries: { x: { start: 0, frames: 0, fps: 1, loop: true } } })).not.toBeNull();
    expect(validateAtlasMeta('<!doctype html>')).not.toBeNull();
  });
});

describe('placeholder atlases follow the contract', () => {
  for (const built of [buildSoldierPlaceholder('german', 'summer', 1), buildVehiclePlaceholder(1), buildWeaponPlaceholder(2)]) {
    it(`${built.name}: entries tile the grid without overlap and the pixels cover every cell`, () => {
      expect(validateAtlasMeta(built.meta)).toBeNull();
      const used = new Set<number>();
      for (const e of Object.values(built.meta.entries)) {
        for (let d = 0; d < built.meta.dirs; d++) for (let f = 0; f < e.frames; f++) {
          const i = atlasFrameIndex(e, built.meta.dirs, d, f);
          expect(used.has(i)).toBe(false);
          used.add(i);
        }
      }
      expect(used.size).toBe(atlasCellCount(built.meta));
      expect(built.width).toBe(built.meta.columns * built.meta.cell.w);
      expect(built.height).toBe(Math.ceil(atlasCellCount(built.meta) / built.meta.columns) * built.meta.cell.h);
      expect(built.rgba.length).toBe(built.width * built.height * 4);
      // the last frame of the last entry really has pixels in its cell
      const last = Object.values(built.meta.entries).at(-1)!;
      const r = atlasCellRect(built.meta, atlasFrameIndex(last, built.meta.dirs, built.meta.dirs - 1, last.frames - 1));
      let opaque = 0;
      for (let y = r.sy; y < r.sy + r.sh; y++) for (let x = r.sx; x < r.sx + r.sw; x++) if (built.rgba[(y * built.width + x) * 4 + 3] > 0) opaque++;
      expect(opaque).toBeGreaterThan(10);
    });
  }

  it('soldier directions differ (dir 0 north vs dir 4 east) and vehicles carry turretPivotM', () => {
    const a = buildSoldierPlaceholder('soviet', 'summer', 1);
    const e = a.meta.entries['standing.aim'];
    const cell = (dir: number) => { const r = atlasCellRect(a.meta, atlasFrameIndex(e, 16, dir, 0)); const out: number[] = []; for (let y = 0; y < r.sh; y++) for (let x = 0; x < r.sw; x++) out.push(a.rgba[((r.sy + y) * a.width + r.sx + x) * 4 + 3]); return out.join(','); };
    expect(cell(0)).not.toBe(cell(4));
    const v = buildVehiclePlaceholder(1);
    expect(v.meta.dirs).toBe(64);
    expect(turretPivotM(v.meta, 't34_76')).toEqual({ x: 0, y: -0.8 });
    expect(turretPivotM(v.meta, 'unknown')).toEqual({ x: 0, y: 0 });
    // per-vehicle atlases store the pivot with +y forward; the game wants +y aft
    const own = { ...v.meta, vehicle: 'kv1', turretPivotM: { x: 0, y: 0.62 } } as AtlasMeta;
    expect(turretPivotM(own, 'kv1')).toEqual({ x: 0, y: -0.62 });
    expect(turretPivotM(own, 't34_76')).toEqual({ x: 0, y: 0 });
    expect(buildWeaponPlaceholder(1).meta.dirs).toBe(32);
  });
});

describe('drawing and fallback', () => {
  const calls: number[][] = [];
  const ctx = { drawImage: (_img: unknown, ...n: number[]) => { calls.push(n); } } as unknown as CanvasRenderingContext2D;
  const built = buildSoldierPlaceholder('german', 'summer', 1);
  const atlas = registerAtlas('test_soldiers', built.meta, {} as CanvasImageSource);

  it('blits the right source cell with the anchor on the unit', () => {
    calls.length = 0;
    expect(drawAtlasFrame(ctx, atlas, 'standing.walk', 3, 2, 200, 150, 1)).toBe(true);
    const e = built.meta.entries['standing.walk'];
    const r = atlasCellRect(built.meta, e.start + 3 * e.frames + 2);
    expect(calls[0]).toEqual([r.sx, r.sy, 40, 40, 200 - 20, 150 - 24, 40, 40]);
  });

  it('missing atlas / entry => false so the caller draws the code-made sprite', () => {
    expect(drawAtlasFrame(ctx, null, 'standing.walk', 0, 0, 0, 0, 1)).toBe(false);
    expect(drawAtlasFrame(ctx, atlas, 'no.such.entry', 0, 0, 0, 0, 1)).toBe(false);
    expect(drawSoldier(ctx, null, ['standing.idle'], 0, () => 0, 0, 0, 1)).toBeNull();
    expect(drawSoldier(ctx, atlas, ['nope', 'nope2'], 0, () => 0, 0, 0, 1)).toBeNull();
  });

  it('key fallback chain: mood variant -> base action -> idle', () => {
    const entries = built.meta.entries;
    // the placeholder has standing.run.panicked but no kneeling.aim.shaken and no @smg variants
    expect(resolveEntryKey(entries, entryKeyChain('standing', 'run', 'panicked', 'rifle'))).toBe('standing.run.panicked');
    expect(resolveEntryKey(entries, entryKeyChain('kneeling', 'aim', 'shaken', 'smg'))).toBe('kneeling.aim');
    expect(resolveEntryKey(entries, entryKeyChain('standing', 'idle', 'calm', 'lmg'))).toBe('standing.idle@lmg');
    expect(resolveEntryKey({ 'crouched.idle': 1 }, entryKeyChain('crouched', 'sneak', 'alert', 'rifle'))).toBe('crouched.idle');
    expect(resolveEntryKey({ 'standing.idle': 1 }, entryKeyChain('prone', 'crawl', 'pinned', null))).toBe('standing.idle');
    expect(resolveEntryKey({}, entryKeyChain('prone', 'crawl', 'pinned', null))).toBeNull();
    expect(drawSoldier(ctx, atlas, entryKeyChain('kneeling', 'aim', 'shaken', 'smg'), Math.PI / 2, () => 1, 10, 10, 1)).toBe('kneeling.aim');
  });
});

describe('crew weapon muzzle', () => {
  it('comes from the weapons atlas (y forward there, aft here), with a mirrored table before it loads', () => {
    freeAllAtlases();
    expect(weaponMuzzleM('pak40')).toEqual({ x: 0, y: -3.31 });
    expect(weaponMuzzleM('unknown')).toEqual({ x: 0, y: -1 });
    const meta = { scale: 1, cell: { w: 8, h: 8 }, anchor: { x: 4, y: 4 }, columns: 4, dirs: 32, entries: {},
      weapons: { pak40: { muzzleM: { x: 0.1, y: 3.5 } } } };
    registerAtlas('weapons_1', meta as unknown as AtlasMeta, null);
    expect(weaponMuzzleM('pak40')).toEqual({ x: 0.1, y: -3.5 });
    freeAllAtlases();
  });
});
