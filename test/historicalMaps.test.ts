import { describe, it, expect } from 'vitest';
import { MAPS } from '@/data/maps';
import { OPERATION } from '@/data/operation';
import { GRAND_CAMPAIGN, flattenCampaign } from '@/data/campaign';
import { buildMap } from '@/sim/map';
import { TERRAIN_PROPS } from '@/sim/terrain';
import type { GameMap, MapDef, Terrain } from '@/shared/types';

/** Item 019 (missing historical maps): every map in the set loads, its victory locations and
 * deploy zones are sane, and the campaign plays every map it says it does. The four new maps
 * (Stalingrad, Korsun, Vistula bridgehead, Reichstag quarter) carry their own stricter checks. */

const NEW_IDS = new Set(['stalingrad_1942', 'korsun_1944', 'vistula_1944', 'kremlin_1945']);

function standable(t: Terrain): boolean {
  return Number.isFinite(TERRAIN_PROPS[t].infantryCost) && t !== 'water';
}

function walkableFraction(map: GameMap, zone: { x: number; y: number; w: number; h: number }): number {
  let ok = 0;
  let total = 0;
  for (let y = zone.y; y < zone.y + zone.h; y++) {
    for (let x = zone.x; x < zone.x + zone.w; x++) {
      total++;
      if (standable(map.tiles[y * map.width + x])) ok++;
    }
  }
  return ok / Math.max(1, total);
}

describe('historical map set (item 019)', () => {
  it('every map builds, elevation is finite and bounded, no cliffs above the vehicle limit', () => {
    for (const def of MAPS) {
      const map = buildMap(def);
      expect(map.tiles.length).toBe(def.width * def.height);
      if (map.ground) {
        for (const m of map.ground) expect(Number.isFinite(m)).toBe(true);
        if (map.groundSteep) for (const g of map.groundSteep) expect(g).toBeLessThanOrEqual(0.251);
      }
    }
  });

  it('every map has sane victory locations and deploy zones', () => {
    for (const def of MAPS) {
      expect(def.victoryLocations.length).toBeGreaterThanOrEqual(5);
      const seen = new Set<string>();
      let valueTotal = 0;
      for (const vl of def.victoryLocations) {
        expect(vl.id).toBeGreaterThanOrEqual(0);
        expect(vl.x).toBeGreaterThanOrEqual(0);
        expect(vl.y).toBeGreaterThanOrEqual(0);
        expect(vl.x).toBeLessThan(def.width);
        expect(vl.y).toBeLessThan(def.height);
        expect(vl.value).toBeGreaterThanOrEqual(1);
        expect(vl.value).toBeLessThanOrEqual(3);
        valueTotal += vl.value;
        const key = `${Math.round(vl.x)},${Math.round(vl.y)}`;
        expect(seen.has(key)).toBe(false); // distinct positions
        seen.add(key);
      }
      expect(valueTotal).toBeLessThanOrEqual(10);
      const map = buildMap(def);
      for (const vl of def.victoryLocations) {
        expect(standable(map.tiles[Math.floor(vl.y) * def.width + Math.floor(vl.x)])).toBe(true);
      }
      const zones = Object.values(def.deployZones);
      expect(zones.length).toBe(2);
      const centres = zones.map((z) => ({ x: z.x + z.w / 2, y: z.y + z.h / 2 }));
      const apart = Math.hypot(centres[0].x - centres[1].x, centres[0].y - centres[1].y);
      expect(apart).toBeGreaterThanOrEqual(60); // zones one meaningful advance apart, not 190 tiles
      for (const zone of zones) {
        expect(zone.x).toBeGreaterThanOrEqual(0);
        expect(zone.y).toBeGreaterThanOrEqual(0);
        expect(zone.x + zone.w).toBeLessThanOrEqual(def.width);
        expect(zone.y + zone.h).toBeLessThanOrEqual(def.height);
        expect(zone.w).toBeGreaterThanOrEqual(20);
        expect(walkableFraction(map, zone)).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  it('the four new maps carry the item-019 completion bar', () => {
    for (const def of MAPS) {
      if (!NEW_IDS.has(def.id)) continue;
      const map = buildMap(def);
      expect(map.ground).toBeDefined(); // the landform is authored, not flat
      const zones = Object.values(def.deployZones);
      for (const zone of zones) expect(walkableFraction(map, zone)).toBeGreaterThanOrEqual(0.9);
      expect(def.bunkers).toBeDefined(); // the historical defences are modelled
    }
  });

  it('the campaign plays every authored map at the place the original put it', () => {
    const flat = flattenCampaign(GRAND_CAMPAIGN);
    expect(flat.length).toBe(18);
    expect(OPERATION.length).toBe(18);
    const played = new Set(flat.map((b) => b.mapId));
    expect(played.size).toBe(MAPS.length);
    for (const def of MAPS) expect(played.has(def.id)).toBe(true);
    // the finale: the city fight, then the Reichstag last stand
    expect(flat[flat.length - 2].mapId).toBe('berlin_1945');
    expect(flat[flat.length - 1].mapId).toBe('kremlin_1945');
    // chronological sanity: the operation years never go backwards
    let year = 0;
    for (const op of GRAND_CAMPAIGN) {
      expect(op.year).toBeGreaterThanOrEqual(year);
      year = op.year;
    }
  });

  it('each map paints deterministically', () => {
    for (const def of MAPS) {
      const a = buildMap(def);
      const b = buildMap(def);
      for (let i = 0; i < a.tiles.length; i++) expect(a.tiles[i]).toBe(b.tiles[i]);
      if (a.ground && b.ground) for (let i = 0; i < a.ground.length; i++) expect(a.ground[i]).toBe(b.ground[i]);
    }
  }, 30000);

  it('map def descriptions and seasons match their year', () => {
    for (const def of MAPS) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(['summer', 'autumn', 'winter']).toContain(def.season);
      const m = /_(\d{4})$/.exec(def.id);
      if (m && NEW_IDS.has(def.id)) {
        const year = Number(m[1]);
        if (year === 1944 && def.id === 'korsun_1944') expect(def.season).toBe('winter');
        if (year === 1944 && def.id === 'vistula_1944') expect(def.season).toBe('summer');
        if (year === 1942) expect(def.season).toBe('autumn');
      }
    }
  });
});
