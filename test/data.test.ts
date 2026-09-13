import { describe, expect, it } from 'vitest';
import type { Terrain } from '@/shared/types';
import { WEAPONS, ALL_WEAPON_IDS } from '@/data/weapons';
import { TEAM_DEFS, VEHICLE_DEFS, teamsForYear } from '@/data/units';
import { randomName, RANKS } from '@/data/names';
import { MAPS, getMap } from '@/data/maps';
import { OPERATION, DEFAULT_FORCES, initialForcePool } from '@/data/operation';
import { Rng } from '@/shared/rng';

describe('weapons', () => {
  it('every weapon id in ALL_WEAPON_IDS exists in WEAPONS and is self-consistent', () => {
    for (const id of ALL_WEAPON_IDS) {
      expect(WEAPONS[id]).toBeDefined();
      expect(WEAPONS[id].id).toBe(id);
    }
  });
});

describe('units', () => {
  it('every TeamDef soldier weaponId exists in WEAPONS', () => {
    for (const def of Object.values(TEAM_DEFS)) {
      for (const s of def.soldiers) {
        expect(WEAPONS[s.weaponId], `${def.id} soldier weapon ${s.weaponId}`).toBeDefined();
      }
    }
  });

  it('every TeamDef.vehicleDefId exists in VEHICLE_DEFS', () => {
    for (const def of Object.values(TEAM_DEFS)) {
      if (def.vehicleDefId) {
        expect(VEHICLE_DEFS[def.vehicleDefId], `${def.id} vehicle ${def.vehicleDefId}`).toBeDefined();
      }
    }
  });

  it('every VehicleDef weapon id exists in WEAPONS', () => {
    for (const v of Object.values(VEHICLE_DEFS)) {
      if (v.mainWeaponId) expect(WEAPONS[v.mainWeaponId], `${v.id} main weapon`).toBeDefined();
      if (v.coaxWeaponId) expect(WEAPONS[v.coaxWeaponId], `${v.id} coax weapon`).toBeDefined();
    }
  });

  it('vehicle team defs have soldier count matching crew', () => {
    for (const def of Object.values(TEAM_DEFS)) {
      if (def.vehicleDefId) {
        const v = VEHICLE_DEFS[def.vehicleDefId];
        expect(def.soldiers.length).toBe(v.crew);
      }
    }
  });

  it('teamsForYear filters by side and year', () => {
    const g41 = teamsForYear('german', 1941);
    expect(g41.length).toBeGreaterThan(0);
    for (const d of g41) {
      expect(d.side).toBe('german');
      expect(d.years).toContain(1941);
    }
    const s45 = teamsForYear('soviet', 1945);
    expect(s45.length).toBeGreaterThan(0);
    for (const d of s45) {
      expect(d.side).toBe('soviet');
      expect(d.years).toContain(1945);
    }
  });

  it('every side has at least one team def available in every year 1941-1945', () => {
    for (const side of ['german', 'soviet'] as const) {
      for (const year of [1941, 1942, 1943, 1944, 1945]) {
        expect(teamsForYear(side, year).length, `${side} ${year}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('names', () => {
  it('randomName returns a non-empty string for both sides', () => {
    const rng = new Rng(42);
    expect(randomName('german', rng).length).toBeGreaterThan(0);
    expect(randomName('soviet', rng).length).toBeGreaterThan(0);
  });

  it('RANKS has entries for both sides', () => {
    expect(RANKS.german.length).toBeGreaterThan(0);
    expect(RANKS.soviet.length).toBeGreaterThan(0);
  });
});

describe('maps', () => {
  it('MAPS has exactly the six expected maps', () => {
    const ids = MAPS.map((m) => m.id);
    expect(ids).toEqual(['border_1941', 'moscow_1941', 'village_1942', 'steppe_1943', 'forest_1944', 'berlin_1945']);
  });

  it('getMap resolves each id', () => {
    for (const m of MAPS) expect(getMap(m.id)).toBe(m);
  });

  it('every map paints without throwing and produces the right tile count', () => {
    for (const def of MAPS) {
      const tiles: Terrain[] = new Array(def.width * def.height).fill('open');
      expect(() => def.paint(tiles, def.width, def.height)).not.toThrow();
      expect(tiles.length).toBe(def.width * def.height);
      for (const t of tiles) expect(typeof t).toBe('string');
    }
  });

  it('victory locations and deploy zones lie inside map bounds', () => {
    for (const def of MAPS) {
      for (const vl of def.victoryLocations) {
        expect(vl.x).toBeGreaterThanOrEqual(0);
        expect(vl.y).toBeGreaterThanOrEqual(0);
        expect(vl.x).toBeLessThan(def.width);
        expect(vl.y).toBeLessThan(def.height);
      }
      for (const side of ['german', 'soviet'] as const) {
        const z = def.deployZones[side];
        expect(z.x).toBeGreaterThanOrEqual(0);
        expect(z.y).toBeGreaterThanOrEqual(0);
        expect(z.x + z.w).toBeLessThanOrEqual(def.width);
        expect(z.y + z.h).toBeLessThanOrEqual(def.height);
      }
    }
  });

  it('victory locations sit on passable, non-water tiles (once src/sim/terrain exists)', async () => {
    let TERRAIN_PROPS: Record<string, { infantryCost: number }> | null = null;
    try {
      const mod = await import('@/sim/terrain');
      TERRAIN_PROPS = mod.TERRAIN_PROPS as any;
    } catch {
      // sim/terrain.ts not yet available from the parallel agent that owns it - skip.
      TERRAIN_PROPS = null;
    }
    if (!TERRAIN_PROPS) return;
    for (const def of MAPS) {
      const tiles: Terrain[] = new Array(def.width * def.height).fill('open');
      def.paint(tiles, def.width, def.height);
      for (const vl of def.victoryLocations) {
        const x = Math.floor(vl.x), y = Math.floor(vl.y);
        const t = tiles[y * def.width + x];
        expect(t, `${def.id} VL ${vl.name} tile`).not.toBe('water');
        const props = TERRAIN_PROPS[t];
        if (props) expect(props.infantryCost, `${def.id} VL ${vl.name} passable`).not.toBe(Infinity);
      }
    }
  });
});

describe('operation', () => {
  it('OPERATION has 6 battles referencing valid maps and team ids', () => {
    expect(OPERATION.length).toBe(6);
    const mapIds = new Set(MAPS.map((m) => m.id));
    for (const battle of OPERATION) {
      expect(mapIds.has(battle.mapId), battle.mapId).toBe(true);
      for (const side of ['german', 'soviet'] as const) {
        expect(battle.aiForces[side].length).toBeGreaterThan(0);
        for (const id of battle.aiForces[side]) {
          expect(TEAM_DEFS[id], `${battle.mapId} ${side} ${id}`).toBeDefined();
          expect(TEAM_DEFS[id].side).toBe(side);
        }
      }
    }
  });

  it('DEFAULT_FORCES references valid team ids for every year', () => {
    for (const [year, forces] of Object.entries(DEFAULT_FORCES)) {
      for (const side of ['german', 'soviet'] as const) {
        for (const id of forces[side]) {
          expect(TEAM_DEFS[id], `${year} ${side} ${id}`).toBeDefined();
        }
      }
    }
  });

  it('initialForcePool returns a non-empty pool of valid team defs for both sides', () => {
    for (const side of ['german', 'soviet'] as const) {
      const pool = initialForcePool(side);
      expect(pool.length).toBeGreaterThan(0);
      for (const entry of pool) {
        expect(TEAM_DEFS[entry.defId], entry.defId).toBeDefined();
      }
    }
  });
});
