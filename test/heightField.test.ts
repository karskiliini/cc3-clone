import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Terrain, Vehicle } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { MapPainter } from '@/sim/mapdsl';
import { buildMap, idx } from '@/sim/map';
import { MAPS } from '@/data/maps';
import { WEAPONS } from '@/data/weapons';
import { applyCrater, buildHeightField, canopyAt, craterDepthM, getHeightField, heightAt } from '@/sim/heightField';
import { applyBlastDamage, buildingStatus, structureHp } from '@/sim/structures';
import { applyHESplash } from '@/sim/combat';
import { hasLOS } from '@/sim/los';
import { isPassable } from '@/sim/path';
import { stepVehicles } from '@/sim/vehicle';
import { TERRAIN_PROPS } from '@/sim/terrain';
import { contourBand, depthColor, rasterizeDepth } from '@/render/depthOverlay';
import { cycleTeamKey, handleDepthMapKey, offsetOrderPoints } from '@/ui/screens/viewKeys';

function mapFrom(paint: (p: MapPainter) => void, w = 40, h = 40, season: MapDef['season'] = 'summer'): GameMap {
  let painter: MapPainter | null = null;
  const def: MapDef = {
    id: 'hf_test', name: 'HF', description: '', width: w, height: h, season,
    paint(tiles, W, H) {
      painter = new MapPainter(tiles, W, H, 1);
      painter.fill('grass');
      paint(painter);
      def.decor = painter.decor;
      def.vectors = painter.vectors;
    },
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: w - 5, y: h - 5, w: 5, h: 5 } },
    attacker: 'soviet',
  };
  const map = buildMap(def);
  void painter;
  return map;
}

function stateFor(map: GameMap): BattleState {
  const config: BattleConfig = {
    mapId: map.def.id, playerSide: 'german', year: 1943, seed: 1, durationS: 1200,
    difficulty: 'normal', forces: { german: [], soviet: [] },
  };
  return {
    config, map, phase: 'running', time: 10,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [],
    result: null, events: [], nextId: 100,
  } as BattleState;
}

const t = (map: GameMap, x: number, y: number): Terrain => map.tiles[idx(map, x, y)];

describe('height field model', () => {
  it('ground is 0 and a crater is a bowl with a raised rim', () => {
    const map = mapFrom(() => {});
    const f = getHeightField(map);
    expect(heightAt(f, 20.5, 20.5)).toBe(0);
    const v0 = f.version;
    applyCrater(f, { x: 20.5, y: 20.5 }, 2.5); // mortar
    expect(f.version).toBeGreaterThan(v0);
    expect(heightAt(f, 20.5, 20.5)).toBeLessThan(-0.75);
    expect(heightAt(f, 20.5, 20.5)).toBeGreaterThan(-1.05);
    // rim ~1.25-1.9 m from the centre (0.65-0.95 tiles)
    let rim = -Infinity;
    for (let d = 0.6; d <= 1.0; d += 0.05) rim = Math.max(rim, heightAt(f, 20.5 + d, 20.5));
    expect(rim).toBeGreaterThan(0.08);
    expect(rim).toBeLessThanOrEqual(0.21);
    expect(craterDepthM(1)).toBeCloseTo(-0.3);
    expect(craterDepthM(5)).toBeCloseTo(-1.8);
    expect(craterDepthM(3.2)).toBeLessThanOrEqual(-1.0);
    expect(craterDepthM(3.2)).toBeGreaterThanOrEqual(-1.3);
  });

  it('a foxhole is -1.2 m with a spoil mound on the enemy side; a trench is -1.5 m', () => {
    const map = mapFrom((p) => {
      p.foxhole(10, 10, { x: 30, y: 10 }, 0); // facing east
      p.line([{ x: 5.5, y: 30.5 }, { x: 35.5, y: 30.5 }], 'trench');
    });
    const f = getHeightField(map);
    expect(heightAt(f, 10.5, 10.5)).toBeLessThan(-1.0);
    // the decor angle is jittered a little, so take the highest point in front vs behind
    let front = -Infinity, back = -Infinity;
    for (let dy = -0.4; dy <= 0.4; dy += 0.1) {
      for (let dx = 0.5; dx <= 1.0; dx += 0.05) {
        front = Math.max(front, heightAt(f, 10.5 + dx, 10.5 + dy));
        back = Math.max(back, heightAt(f, 10.5 - dx, 10.5 + dy));
      }
    }
    expect(front).toBeGreaterThan(0.25);
    expect(front).toBeLessThanOrEqual(0.41);
    expect(back).toBeLessThan(0.1);
    expect(heightAt(f, 20.5, 30.5)).toBeCloseTo(-1.5, 1);
    expect(t(map, 20, 29)).toBe('grass');
  });

  it('walls, hedges, fences, buildings and woods have their heights', () => {
    const map = mapFrom((p) => {
      p.line([{ x: 2.5, y: 5.5 }, { x: 12.5, y: 5.5 }], 'stonewall');
      p.line([{ x: 2.5, y: 8.5 }, { x: 12.5, y: 8.5 }], 'hedge');
      p.line([{ x: 2.5, y: 11.5 }, { x: 12.5, y: 11.5 }], 'fence');
      p.building(20, 4, 6, 5, 'wood');
      p.building(20, 14, 8, 6, 'stone');
      p.woods(10, 30, 4, 4);
      p.rect(30, 30, 5, 5, 'rubble');
      p.rect(30, 20, 3, 1, 'water');
    });
    const f = getHeightField(map);
    expect(heightAt(f, 7.5, 5.5)).toBeCloseTo(1.8, 1);
    expect(heightAt(f, 7.5, 8.5)).toBeCloseTo(1.5, 1);
    expect(heightAt(f, 7.375, 11.375)).toBeCloseTo(1.1, 1);
    // fence is thin: the tile's edge is open ground
    expect(heightAt(f, 7.5, 11.95)).toBeLessThan(0.3);
    // wooden house: 4 m eaves, 6 m ridge along its long (E-W) axis
    const woodRidge = heightAt(f, 23, 6.5);
    expect(woodRidge).toBeGreaterThan(5);
    expect(woodRidge).toBeLessThanOrEqual(6.01);
    expect(heightAt(f, 23, 4.2)).toBeGreaterThan(3.9);
    expect(heightAt(f, 23, 4.2)).toBeLessThan(5);
    // stone house 8-12 m (+ridge)
    const stone = heightAt(f, 24, 17);
    expect(stone).toBeGreaterThanOrEqual(8);
    expect(stone).toBeLessThanOrEqual(14);
    // woods: canopy 8-12 m over ground-level floor
    expect(canopyAt(f, 10.5, 30.5)).toBeGreaterThan(7);
    expect(heightAt(f, 10.5, 30.5)).toBe(0);
    const rub = heightAt(f, 32.5, 32.5);
    expect(rub).toBeGreaterThanOrEqual(0.6);
    expect(rub).toBeLessThanOrEqual(1.6);
    expect(heightAt(f, 31.5, 20.5)).toBeCloseTo(-0.5, 2);
  });

  it('builds for every shipped map quickly with finite values', () => {
    for (const def of MAPS) {
      const map = buildMap(def);
      const t0 = performance.now();
      const f = buildHeightField(map);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(1500);
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < f.height.length; i++) { const v = f.height[i]; if (!Number.isFinite(v)) throw new Error('NaN'); min = Math.min(min, v); max = Math.max(max, v); }
      expect(max).toBeGreaterThan(1);
      expect(min).toBeLessThanOrEqual(0);
    }
  });
});

describe('structure damage', () => {
  it('a mortar blast next to a fence flattens it and drops its height to 0', () => {
    const map = mapFrom((p) => p.line([{ x: 2.5, y: 10.5 }, { x: 20.5, y: 10.5 }], 'fence'));
    const st = stateFor(map);
    const f = getHeightField(map);
    expect(heightAt(f, 10.5, 10.5)).toBeGreaterThan(1);
    applyHESplash(st, new Rng(1), { x: 10.5, y: 11.3 }, WEAPONS.mortar81, 'soviet');
    expect(t(map, 10, 10)).toBe('open');
    expect(heightAt(f, 10.5, 10.5)).toBeLessThan(0.3);
    expect(map.dirtyTiles).toContain(idx(map, 10, 10));
    // a fence far from the burst still stands
    expect(t(map, 3, 10)).toBe('fence');
  });

  it('enough HE breaches a stone wall tile: passable rubble that no longer blocks LOS', () => {
    const map = mapFrom((p) => p.line([{ x: 20.5, y: 2.5 }, { x: 20.5, y: 37.5 }], 'stonewall'));
    const st = stateFor(map);
    const a = { x: 15.5, y: 20.5 }, b = { x: 25.5, y: 20.5 };
    expect(hasLOS(map, a, b)).toBe(false);
    expect(isPassable(map, 20, 20, 'vehicle')).toBe(false);
    let n = 0;
    while (t(map, 20, 20) === 'stonewall' && n < 10) { applyBlastDamage(st, { x: 20.5, y: 20.5 }, WEAPONS.kwk40_75); n++; }
    expect(n).toBeGreaterThan(1); // a single 75 mm round does not breach 150 of stone
    expect(t(map, 20, 20)).toBe('rubble');
    expect(TERRAIN_PROPS.rubble.cover).toBeGreaterThan(0);
    expect(isPassable(map, 20, 20, 'infantry')).toBe(true);
    expect(isPassable(map, 20, 20, 'vehicle')).toBe(true);
    expect(hasLOS(map, a, b)).toBe(true);
    expect(heightAt(getHeightField(map), 20.5, 20.5)).toBeCloseTo(0.6, 0);
    // neighbours keep standing (damaged, not destroyed)
    expect(t(map, 20, 18)).toBe('stonewall');
    expect(structureHp(map, 20, 18)).toBeGreaterThan(0);
  });

  it('a stick grenade dents a wall; an AT rocket only damages the tile it hits', () => {
    const map = mapFrom((p) => p.line([{ x: 20.5, y: 2.5 }, { x: 20.5, y: 37.5 }], 'stonewall'));
    const st = stateFor(map);
    applyBlastDamage(st, { x: 20.5, y: 20.5 }, WEAPONS.grenade);
    expect(t(map, 20, 20)).toBe('stonewall');
    expect(structureHp(map, 20, 20)).toBeLessThan(150);
    applyBlastDamage(st, { x: 19.9, y: 25.5 }, WEAPONS.panzerschreck);
    expect(structureHp(map, 20, 25)).toBeLessThan(150);
    expect(structureHp(map, 20, 24)).toBe(150);
    expect(structureHp(map, 20, 26)).toBe(150);
  });

  it('a building crosses the damaged and ruined thresholds', () => {
    const map = mapFrom((p) => p.building(10, 10, 8, 6, 'stone'));
    const st = stateFor(map);
    st.messages.length = 0;
    const bid = map.buildingId[idx(map, 10, 10)];
    const f = getHeightField(map);
    const roof0 = heightAt(f, 14, 13);
    expect(roof0).toBeGreaterThan(7);
    // a German soldier inside (for the collapse-casualty path and "near player units")
    const soldier = { id: 1, teamId: 1, side: 'german', health: 'healthy', pos: { x: 13.5, y: 12.5 }, vehicleId: null, name: 'A', rank: 'Gefr', weaponId: 'kar98k', morale: 60, mind: {} } as unknown as Soldier;
    st.soldiers.set(1, soldier);
    const walls: { x: number; y: number }[] = [];
    for (let x = 10; x < 18; x++) { walls.push({ x, y: 10 }, { x, y: 15 }); }
    for (let y = 11; y < 15; y++) { walls.push({ x: 10, y }, { x: 17, y }); }
    let i = 0;
    const blastAt = (w: { x: number; y: number }) => {
      for (let k = 0; k < 4 && t(map, w.x, w.y) === 'buildingStone'; k++) applyBlastDamage(st, { x: w.x + 0.5, y: w.y + 0.5 }, WEAPONS.panzerfaust);
    };
    while (buildingStatus(map, bid) === 'intact' && i < walls.length) blastAt(walls[i++]);
    expect(buildingStatus(map, bid)).toBe('damaged');
    const breached = walls.filter((w) => t(map, w.x, w.y) === 'rubble').length;
    expect(breached / walls.length).toBeGreaterThan(0.3);
    expect(map.tiles.some((tt, k) => tt === 'rubble' && map.buildingId[k] === bid && !walls.some((w) => idx(map, w.x, w.y) === k))).toBe(true);
    expect(st.messages.some((m) => m.text === 'Wall breached.')).toBe(true);
    while (buildingStatus(map, bid) !== 'ruined' && i < walls.length) blastAt(walls[i++]);
    expect(buildingStatus(map, bid)).toBe('ruined');
    expect(st.messages.some((m) => /has collapsed\./.test(m.text))).toBe(true);
    // roof gone, interior rubble, remaining walls are stubs
    expect(t(map, 14, 13)).toBe('rubble');
    expect(heightAt(f, 14, 13)).toBeLessThan(1.8);
    const stubs = walls.filter((w) => t(map, w.x, w.y) === 'stonewall');
    for (const s of stubs) {
      const h = heightAt(f, s.x + 0.5, s.y + 0.5);
      expect(h).toBeGreaterThanOrEqual(1.4);
      expect(h).toBeLessThanOrEqual(3.1);
    }
    expect(map.tiles.some((tt, k) => map.buildingId[k] === bid && (tt === 'floor' || tt === 'buildingStone'))).toBe(false);
  });

  it('a tank crushing a hedge updates the height field', () => {
    const map = mapFrom((p) => p.line([{ x: 2.5, y: 10.5 }, { x: 30.5, y: 10.5 }], 'hedge'));
    const st = stateFor(map);
    const f = getHeightField(map);
    expect(heightAt(f, 10.5, 10.5)).toBeCloseTo(1.5, 1);
    const v0 = f.version;
    const tank = {
      id: 5, teamId: 9, side: 'german', defId: 'pz4gh', pos: { x: 10.5, y: 10.5 }, hullFacing: Math.PI, turretFacing: Math.PI,
      state: 'ok', mainAmmo: 10, coaxAmmo: 10, path: [{ x: 10.5, y: 14.5 }], speed: 0,
      targetVehicleId: null, targetSoldierId: null, targetPoint: null, mainFireTimer: 0, coaxFireTimer: 0, burnTimer: 0, hits: 0,
    } as unknown as Vehicle;
    st.vehicles.set(5, tank);
    stepVehicles(st, new Rng(1), 0.1);
    expect(t(map, 10, 10)).toBe('open');
    expect(f.version).toBeGreaterThan(v0);
    expect(heightAt(f, 10.5, 10.5)).toBeLessThan(0.3);
  });
});

describe('depth view', () => {
  it('colour ramp and contours', () => {
    const deep = depthColor(-1.5), ground = depthColor(0), wall = depthColor(1.5), tall = depthColor(16);
    expect(deep[2]).toBeGreaterThan(deep[1]); // blue-violet
    expect(ground[0]).toBe(ground[1]);
    expect(wall[0]).toBeGreaterThan(wall[2] + 100); // yellow-orange
    expect(tall).toEqual([255, 255, 255]);
    expect(contourBand(-0.3)).not.toBe(contourBand(-0.7));
    expect(contourBand(0.5)).toBe(contourBand(1.5));
    expect(contourBand(1.5)).not.toBe(contourBand(2.5));
  });

  it('rasterises a full viewport within budget', () => {
    const def = MAPS.find((m) => m.id === 'berlin_1945') ?? MAPS[0];
    const map = buildMap(def);
    const f = getHeightField(map);
    rasterizeDepth(f, { x0: 0, y0: 0, cols: 8, rows: 8, ppt: 8 }); // warm up
    const cols = Math.min(map.width, 64), rows = Math.min(map.height, 48);
    const t0 = performance.now();
    const img = rasterizeDepth(f, { x0: 0, y0: 0, cols, rows, ppt: 8 });
    const ms = performance.now() - t0;
    expect(img.w).toBe(cols * 8);
    // generous in CI; the browser number is reported separately
    expect(ms).toBeLessThan(80);
  });
});

describe('view keys', () => {
  it('Tab toggles the depth map; . and , cycle teams', () => {
    const settings = { volume: 1, unitLabels: false, losLines: true, speed: 1 as const };
    expect(handleDepthMapKey(new Set(['tab']), settings)).toBe(true);
    expect(settings).toMatchObject({ showDepthMap: true });
    handleDepthMapKey(new Set(['tab']), settings);
    expect(settings).toMatchObject({ showDepthMap: false });
    expect(handleDepthMapKey(new Set(['.']), settings)).toBe(false);
    const ids = [3, 7, 9];
    expect(cycleTeamKey(new Set(['.']), ids, 7)).toBe(9);
    expect(cycleTeamKey(new Set(['.']), ids, 9)).toBe(3);
    expect(cycleTeamKey(new Set([',']), ids, 3)).toBe(9);
    expect(cycleTeamKey(new Set([',']), ids, null)).toBe(9);
    expect(cycleTeamKey(new Set(['.']), ids, null)).toBe(3);
    expect(cycleTeamKey(new Set(['tab']), ids, 3)).toBeNull();
  });

  it('group move orders offset every waypoint and the final target', () => {
    const r = offsetOrderPoints({ x: 10, y: 10 }, [{ x: 2, y: 2 }, { x: 5, y: 6 }], { x: 1, y: -1 });
    expect(r).toEqual({ target: { x: 11, y: 9 }, waypoints: [{ x: 3, y: 1 }, { x: 6, y: 5 }] });
  });
});
