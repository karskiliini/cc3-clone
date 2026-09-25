import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Terrain, Vehicle } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { applyHESplash, craterForWeapon } from '@/sim/combat';
import { MapPainter } from '@/sim/mapdsl';
import { WEAPONS } from '@/data/weapons';
import { MAPS } from '@/data/maps';
import { buildMap } from '@/sim/map';
import { TERRAIN_PROPS } from '@/sim/terrain';
import { EarthField, fillCrater, fillFoxhole, shadeField, buildTrenchDraw, fillTrenches, craterExtentPx, paintCrater, TRACK_RUT_ALPHA } from '@/render/craterArt';

function makeState(fill: Terrain = 'grass'): BattleState {
  const W = 20, H = 20;
  const tiles: Terrain[] = new Array(W * H).fill(fill);
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 15, y: 15, w: 5, h: 5 } },
    attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = {
    mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map, phase: 'running', time: 0,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
    result: null, events: [], nextId: 10,
  } as BattleState;
}

describe('explosion craters (sim)', () => {
  it('sizes the mark by explosive', () => {
    expect(craterForWeapon(WEAPONS.grenade)).toEqual({ sizeM: 1, kind: 'grenade' });
    expect(craterForWeapon(WEAPONS.mortar81)!.sizeM).toBeCloseTo(2.5);
    const tank = craterForWeapon(WEAPONS.kwk40_75)!.sizeM;
    expect(tank).toBeGreaterThanOrEqual(3);
    expect(tank).toBeLessThanOrEqual(4);
    expect(craterForWeapon(WEAPONS.d25t_122)!.sizeM).toBe(5);
    expect(craterForWeapon(WEAPONS.kar98k)).toBeNull();
  });

  it('a mortar round digs a crater tile and leaves a sub-tile mark on grass', () => {
    const st = makeState('grass');
    applyHESplash(st, new Rng(1), { x: 10.3, y: 10.7 }, WEAPONS.mortar81, 'german');
    expect(st.map.tiles[10 * 20 + 10]).toBe('crater');
    expect(st.map.craterMarks).toEqual([{ x: 10.3, y: 10.7, sizeM: 2.5, kind: 'shell' }]);
  });

  it('a grenade leaves a small scorched hole mark', () => {
    const st = makeState('grass');
    applyHESplash(st, new Rng(1), { x: 5.5, y: 5.5 }, WEAPONS.grenade, 'german');
    expect(st.map.craterMarks).toEqual([{ x: 5.5, y: 5.5, sizeM: 1, kind: 'grenade' }]);
  });

  it('dirt roads crater but stay passable, paved roads only get a mark; buildings, bridges and water get nothing', () => {
    for (const [t, marked, tileAfter] of [['dirtroad', true, 'crater'], ['pavedroad', true, 'pavedroad'], ['buildingStone', false, 'buildingStone'], ['water', false, 'water'], ['bridge', false, 'bridge'], ['floor', false, 'floor']] as [Terrain, boolean, Terrain][]) {
      const st = makeState(t);
      applyHESplash(st, new Rng(1), { x: 8.5, y: 8.5 }, WEAPONS.kwk40_75, 'german');
      expect(st.map.tiles[8 * 20 + 8]).toBe(tileAfter);
      if (marked) expect(TERRAIN_PROPS[tileAfter].infantryCost).toBeLessThan(Infinity);
      expect((st.map.craterMarks?.length ?? 0) > 0).toBe(marked);
    }
  });

  it('a mark next to a building shrinks so its bowl never spills over the wall', () => {
    const st = makeState('grass');
    st.map.tiles[10 * 20 + 11] = 'buildingStone';
    applyHESplash(st, new Rng(1), { x: 10.6, y: 10.5 }, WEAPONS.kwk40_75, 'german');
    expect(st.map.craterMarks![0].sizeM).toBeLessThan(1);
  });

  it('a round bursting on a vehicle only scorches the ground under it, and repeats do not stack', () => {
    const st = makeState('grass');
    st.vehicles.set(1, { id: 1, pos: { x: 10.5, y: 10.5 } } as unknown as Vehicle);
    applyHESplash(st, new Rng(1), { x: 10.5, y: 10.5 }, WEAPONS.kwk40_75, 'german');
    applyHESplash(st, new Rng(1), { x: 10.5, y: 10.5 }, WEAPONS.kwk40_75, 'german');
    expect(st.map.craterMarks).toEqual([{ x: 10.5, y: 10.5, sizeM: 1.2, kind: 'grenade' }]);
  });
});

describe('foxholes (map DSL)', () => {
  it('digs a trench tile (trench cover) with facing decor, only into soft ground', () => {
    const tiles: Terrain[] = new Array(10 * 10).fill('grass');
    tiles[3 * 10 + 3] = 'dirtroad';
    const p = new MapPainter(tiles, 10, 10, 1);
    expect(p.foxhole(5.2, 5.8, { x: 5, y: 20 })).toBe(true);
    expect(tiles[5 * 10 + 5]).toBe('trench');
    expect(TERRAIN_PROPS.trench.cover).toBeGreaterThan(TERRAIN_PROPS.grass.cover);
    const d = p.decor.find((x) => x.kind === 'foxhole')!;
    expect(Math.sin(d.angle!)).toBeGreaterThan(0.8); // faces south toward (5,20)
    expect(p.foxhole(3, 3, { x: 0, y: 0 })).toBe(false);
    expect(tiles[3 * 10 + 3]).toBe('dirtroad');
  });

  it('foxholeLine keeps clear circles free', () => {
    const tiles: Terrain[] = new Array(60 * 20).fill('grass');
    const p = new MapPainter(tiles, 60, 20, 7);
    const n = p.foxholeLine([{ x: 2, y: 10 }, { x: 58, y: 10 }], { x: 30, y: 40 }, { spacing: 4, gapProb: 0, keepClear: [{ x: 30, y: 10, r: 6 }] });
    expect(n).toBeGreaterThan(6);
    for (const d of p.decor) expect(Math.hypot(d.x - 30, d.y - 10)).toBeGreaterThan(5);
  });

  it('real maps: every foxhole sits on a trench tile, never on a VL centre or inside a deploy zone', () => {
    let total = 0;
    for (const def of MAPS) {
      const map = buildMap(def);
      for (const d of def.decor ?? []) {
        if (d.kind !== 'foxhole') continue;
        total++;
        expect(map.tiles[Math.floor(d.y) * map.width + Math.floor(d.x)]).toBe('trench');
        for (const vl of def.victoryLocations) expect(Math.hypot(vl.x - d.x, vl.y - d.y)).toBeGreaterThan(2.5);
        // A foxhole may lie inside the DEFENDER's own deploy zone — those are his prepared
        // positions, and round 5 tightened the zones onto the ground each side actually holds.
        // It must never lie inside the ATTACKER's jump-off area.
        const attackerZone = def.deployZones[def.attacker];
        const inAttackerZone = d.x >= attackerZone.x && d.x < attackerZone.x + attackerZone.w
          && d.y >= attackerZone.y && d.y < attackerZone.y + attackerZone.h;
        expect(inAttackerZone, `${def.id} foxhole at ${d.x},${d.y} is in the attacker's deploy zone`).toBe(false);
      }
    }
    expect(total).toBeGreaterThan(15);
  });
});

describe('earthwork art (height fields)', () => {
  const lum = (px: Uint8ClampedArray, i: number) => px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11;

  it('a shell crater is a bowl with a raised, irregular rim, NW inner wall darker than SE', () => {
    const f = new EarthField();
    const W = 120;
    f.reset(W, W, 1, -60, -60);
    const opts = fillCrater(f, { x: 0, y: 0, diameterM: 4, kind: 'shell', old: false, seed: 99 }, 'summer');
    const at = (x: number, y: number) => f.H[(y + 60) * W + (x + 60)];
    expect(at(0, 0)).toBeLessThan(-0.5);
    // rim radius differs by direction (noise outline, not a perfect circle)
    const rimR = (dx: number, dy: number) => {
      let best = 0, bestH = -Infinity;
      for (let r = 5; r < 40; r++) { const h = at(Math.round(dx * r), Math.round(dy * r)); if (h > bestH) { bestH = h; best = r; } }
      return { best, bestH };
    };
    const rims = [rimR(1, 0), rimR(0, 1), rimR(-1, 0), rimR(0, -1), rimR(0.7, 0.7), rimR(-0.7, -0.7)];
    for (const r of rims) expect(r.bestH).toBeGreaterThan(0);
    expect(new Set(rims.map((r) => r.best)).size).toBeGreaterThan(1);
    const out = new Uint8ClampedArray(W * W * 4);
    shadeField(f, 'summer', opts, out);
    // inner walls, half the rim radius out along the NW/SE diagonal
    const nw = (60 - 9) * W + (60 - 9), se = (60 + 9) * W + (60 + 9);
    expect(lum(out, nw)).toBeLessThan(lum(out, se));
  });

  it('a vehicle track rut in snow is a faint shade over its full width, never a dark pit', () => {
    // it used to go through the shell-crater painter clipped to a 5 px box (extent in metres, not
    // px): tanks left a trail of small black squares in the snow
    const c = { x: 100, y: 100, diameterM: 3.7, kind: 'track' as const, old: false, seed: 5 };
    expect(craterExtentPx(c)).toBeGreaterThan(20); // zoom-1 px: 1.85 m x 1.3 at 10 px/m
    const stops: string[] = [];
    let filled = 0, imagePuts = 0;
    const ctx = {
      save() {}, restore() {}, beginPath() {}, arc() {}, fill() { filled++; }, drawImage() { imagePuts++; }, putImageData() { imagePuts++; },
      createRadialGradient: () => ({ addColorStop: (_o: number, col: string) => stops.push(col) }),
      canvas: { width: 512, height: 512 }, fillStyle: '',
    } as unknown as CanvasRenderingContext2D;
    paintCrater(ctx, c, 'winter', 0, 0, 1);
    expect(filled).toBe(1);
    expect(imagePuts).toBe(0); // no earth/bowl patch
    for (const col of stops) expect(Number(col.match(/,([\d.]+)\)$/)![1])).toBeLessThanOrEqual(TRACK_RUT_ALPHA);
  });

  it('a foxhole has its spoil piled on the enemy-facing side', () => {
    const f = new EarthField();
    const W = 70;
    f.reset(W, W, 1, -35, -35);
    // facing south (+y)
    fillFoxhole(f, { x: 0, y: 0, angle: Math.PI / 2, variant: 0, men: 2, seed: 3 }, 'summer');
    let front = 0, back = 0;
    for (let x = -8; x <= 8; x++) {
      for (let y = 6; y <= 18; y++) { front = Math.max(front, f.H[(35 + y) * W + 35 + x]); back = Math.max(back, f.H[(35 - y) * W + 35 + x]); }
    }
    expect(f.H[35 * W + 35]).toBeLessThan(-1);
    expect(front).toBeGreaterThan(back * 1.5);
  });

  it('a winter foxhole is an elongated slot lying across its facing (along the dug-in line)', () => {
    const W = 90; // wide enough for the scaled-up winter slot plus its halo, in either orientation
    const span = (angle: number) => {
      const f = new EarthField();
      f.reset(W, W, 1, -35, -35);
      fillFoxhole(f, { x: 0, y: 0, angle, variant: 0, men: 2, seed: 5 }, 'winter');
      let x0 = W, x1 = -1, y0 = W, y1 = -1;
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        if (f.soil[y * W + x] > 0.5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      }
      return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const south = span(Math.PI / 2); // faces south -> long axis east-west
    expect(south.w / south.h).toBeGreaterThan(1.5);
    expect(south.w / south.h).toBeLessThan(3);
    const east = span(0);
    expect(east.h / east.w).toBeGreaterThan(1.5);
  });

  it('a trench centreline is crenellated but stays inside the tile band of the source line', () => {
    const tr = buildTrenchDraw([{ x: 0, y: 5 }, { x: 40, y: 5 }], 20, { x: 400, y: 600 }, 11);
    const ys = tr.pts.map((p) => p.y / 20);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.2);
    for (const y of ys) expect(Math.abs(y - 5)).toBeLessThan(0.5);
    for (const n of tr.front) expect(n.y).toBeGreaterThan(0.9); // front faces the enemy (south)
    const f = new EarthField();
    f.reset(200, 80, 1, 100, 60);
    fillTrenches(f, [tr], 'winter');
    const col = 100;
    let minH = 0, maxFront = 0, maxBack = 0;
    for (let y = 0; y < 80; y++) {
      const h = f.H[y * 200 + col];
      minH = Math.min(minH, h);
      if (y + 60 > 110) maxFront = Math.max(maxFront, h); else if (y + 60 < 90) maxBack = Math.max(maxBack, h);
    }
    expect(minH).toBeLessThan(-1);
    expect(maxFront).toBeGreaterThan(maxBack);
  });
});
