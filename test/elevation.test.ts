// ============================================================================
// elevation.test.ts — the ground-relief layer: the DSL that paints it, the height field that
// carries it, and the four sim rules that read it (LOS masking, movement grade, vehicle
// steepness, spotting height advantage). Plus a per-map QA sweep asserting the shipped relief
// stays in the "gentle, no cliffs" band the design calls for.
// ============================================================================
import { describe, it, expect } from 'vitest';
import type { BattleState, ElevationApi, GameMap, MapDef, Soldier, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { MapPainter, ElevationPainter, computeGroundSteep } from '@/sim/mapdsl';
import { buildMap, groundHeightAt, groundAtTile } from '@/sim/map';
import { MAPS } from '@/data/maps';
import { getHeightField, heightAt, groundAt, featureHeightAt } from '@/sim/heightField';
import { hasLOS, losTrace, EYE_STANDING_M, EYE_PRONE_M, EYE_VEHICLE_M, eyeHeightM } from '@/sim/los';
import { isPassable, VEHICLE_MAX_GRADE } from '@/sim/path';
import { gradeSpeedMul, GRADE_FLOOR, GRADE_MAX, GRADE_UPHILL_VEHICLE } from '@/sim/movement';
import { heightSpotFactor, observerStandingSpotScore, spotterEyeM, HEIGHT_SPOT_CAP } from '@/sim/spotting';

/** A 60x40 test map: flat grass, plus whatever relief the caller paints. */
function elevMap(elevation?: (e: ElevationApi) => void, paint?: (p: MapPainter) => void, w = 60, h = 40): GameMap {
  const def: MapDef = {
    id: 'elev_test', name: 'Elev', description: '', width: w, height: h, season: 'summer',
    paint(tiles, W, H) {
      const p = new MapPainter(tiles, W, H, 1);
      p.fill('open');
      paint?.(p);
      def.decor = p.decor;
      def.vectors = p.vectors;
    },
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: w - 5, y: h - 5, w: 5, h: 5 } },
    attacker: 'soviet',
    elevation,
  };
  return buildMap(def);
}

/** A map with a smooth east-west ridge whose crest runs down the column x = 30. */
function ridgeMap(peakM = 8): GameMap {
  return elevMap((e) => {
    e.base(0);
    e.ridge([{ x: 30, y: -10 }, { x: 30, y: 50 }], 40, peakM);
    e.smoothElevation(1);
  });
}

function soldierAt(pos: Vec2, stance: Soldier['stance']): Soldier {
  return {
    id: 1, teamId: 1, side: 'german', name: 'X', rank: 'Gefr', weaponId: 'k98', ammo: 10, ammoReserve: 10,
    grenades: 0, health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50,
    stance, activity: 'idle', pos: { ...pos }, facing: 'e', targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false,
  } as unknown as Soldier;
}

function stateFor(map: GameMap): BattleState {
  return { map, time: 10, soldiers: new Map(), teams: new Map(), vehicles: new Map() } as unknown as BattleState;
}

// ------------------------------------------------------------------ the DSL
describe('ElevationPainter', () => {
  it('hill/ridge/valley/slope/terrace build the shapes they name', () => {
    const e = new ElevationPainter(60, 60, 7);
    e.base(5);
    expect(e.at(0, 0)).toBe(5);

    e.hill(20, 20, 10, 6);
    expect(e.at(20, 20)).toBeGreaterThan(10);      // crown ~5 + 6
    expect(e.at(20, 20)).toBeGreaterThan(e.at(25, 20));
    expect(e.at(20, 33)).toBeCloseTo(5, 5);        // outside the radius, untouched

    e.valley([{ x: 0, y: 45 }, { x: 60, y: 45 }], 12, 3);
    expect(e.at(30, 45)).toBeCloseTo(2, 0);
    expect(e.at(30, 52)).toBeCloseTo(5, 5);

    e.ridge([{ x: 0, y: 55 }, { x: 60, y: 55 }], 12, 2);
    expect(e.at(30, 55)).toBeCloseTo(7, 1);

    e.terrace({ x: 40, y: 5, w: 10, h: 10 }, 12);
    expect(e.at(45, 10)).toBeCloseTo(12, 3);

    const before = e.at(5, 30);
    e.slope({ x: 0, y: 28, w: 60, h: 6 }, 0, 4, 0);  // ramp west -> east
    expect(e.at(5, 30)).toBeCloseTo(before, 0);
    expect(e.at(55, 30)).toBeGreaterThan(e.at(5, 30) + 3);
  });

  it('smoothElevation flattens a step and conserves the rough level', () => {
    const e = new ElevationPainter(30, 30, 1);
    e.base(0);
    e.terrace({ x: 0, y: 0, w: 15, h: 30 }, 10);
    const stepBefore = Math.abs(e.at(14, 15) - e.at(17, 15));
    e.smoothElevation(6);
    const stepAfter = Math.abs(e.at(14, 15) - e.at(17, 15));
    expect(stepAfter).toBeLessThan(stepBefore);
    expect(e.at(2, 15)).toBeGreaterThan(8);   // the plateau is still a plateau
  });

  it('gradeRoad flattens a corridor over a hill to a walkable grade', () => {
    const e = new ElevationPainter(80, 40, 3);
    e.base(0);
    e.hill(40, 20, 25, 9);
    const road = [{ x: 0, y: 20 }, { x: 80, y: 20 }];
    const beforeCrest = e.at(40, 20);
    e.gradeRoad(road, 3, 5);
    // the crest of the road has been cut down toward the graded profile
    expect(e.at(40, 20)).toBeLessThan(beforeCrest - 1);
    // and no 1-tile step along the road exceeds ~5% + smoothing slack
    let worst = 0;
    for (let x = 1; x < 79; x++) worst = Math.max(worst, Math.abs(e.at(x + 1, 20) - e.at(x, 20)) / TILE_M);
    expect(worst).toBeLessThan(0.08);
  });

  it('cutRiver cuts a bed below the surrounding ground and never runs uphill', () => {
    const e = new ElevationPainter(80, 30, 5);
    e.base(10);
    e.slope({ x: 0, y: 0, w: 80, h: 30 }, 0, -4, 0); // ground falls to the east
    const river = [{ x: 2, y: 15 }, { x: 78, y: 15 }];
    e.cutRiver(river, 4, 1.5);
    for (let x = 6; x < 74; x++) {
      expect(e.at(x, 15)).toBeLessThan(e.at(x, 22)); // bed below the bank
      expect(e.at(x + 1, 15)).toBeLessThanOrEqual(e.at(x, 15) + 1e-4); // flows downhill
    }
  });

  it('limitGrade removes cliffs without destroying the landform', () => {
    const e = new ElevationPainter(40, 40, 1);
    e.base(0);
    e.terrace({ x: 0, y: 0, w: 20, h: 40 }, 12);
    expect(e.steepestGrade()).toBeGreaterThan(1);
    e.limitGrade(25);
    expect(e.steepestGrade()).toBeLessThanOrEqual(0.2502) // float32 rounding in the field;
    expect(e.at(2, 20) - e.at(37, 20)).toBeGreaterThan(6); // still high in the west, low in the east
  });
});

// ------------------------------------------------------------------ the height field
describe('height field ground layer', () => {
  it('returns ground + feature height, and ground alone on bare tiles', () => {
    const map = elevMap((e) => { e.base(0); e.hill(30, 20, 12, 6); },
      (p) => { p.line([{ x: 30.5, y: 10.5 }, { x: 30.5, y: 14.5 }], 'stonewall'); });
    const f = getHeightField(map);
    const crown = groundAt(f, 30.5, 20.5);
    expect(crown).toBeGreaterThan(5);
    expect(heightAt(f, 30.5, 20.5)).toBeCloseTo(crown, 5); // bare ground: no feature
    expect(featureHeightAt(f, 30.5, 20.5)).toBeCloseTo(0, 5);

    // on the wall the composite is the local ground plus the wall's 1.8 m
    const gWall = groundAt(f, 30.5, 12.5);
    expect(heightAt(f, 30.5, 12.5)).toBeGreaterThan(gWall + 1.5);
    expect(featureHeightAt(f, 30.5, 12.5)).toBeGreaterThan(1.5);
  });

  it('interpolates the ground smoothly between tiles (no 2 m steps)', () => {
    const map = elevMap((e) => { e.base(0); e.slope({ x: 0, y: 0, w: 60, h: 40 }, 0, 12, 0); });
    const f = getHeightField(map);
    let worst = 0;
    for (let x = 2; x < 58; x += 0.25) worst = Math.max(worst, Math.abs(groundAt(f, x + 0.25, 20) - groundAt(f, x, 20)));
    expect(worst).toBeLessThan(0.2); // 0.5 m sample spacing, ~0.4 m/tile slope
    expect(groundHeightAt(map, { x: 30, y: 20 })).toBeCloseTo(groundAt(f, 30, 20), 1);
  });

  it('a flat map has no ground field at all and behaves exactly as before', () => {
    const map = elevMap();
    expect(map.ground).toBeUndefined();
    expect(map.groundSteep).toBeUndefined();
    expect(heightAt(getHeightField(map), 20.5, 20.5)).toBe(0);
    expect(gradeSpeedMul(map, { x: 1, y: 1 }, { x: 5, y: 5 })).toBe(1);
  });
});

// ------------------------------------------------------------------ LOS
describe('terrain masking (LOS)', () => {
  it('a hill blocks the sightline from the low ground on one side to the low ground on the other', () => {
    const map = ridgeMap(8);
    const west = { x: 8.5, y: 20.5 }, east = { x: 52.5, y: 20.5 };
    expect(hasLOS(map, west, east)).toBe(false);
    const trace = losTrace(map, west, east);
    expect(trace.visibility).toBe(0);
    expect(trace.blockedAt).not.toBeNull();
    // the masking tile is on the rising west slope between the observer and the crest (the
    // sightline is cut where the ground first climbs through it, not at the summit itself)
    expect(trace.blockedAt!.x).toBeGreaterThan(8.5);
    expect(trace.blockedAt!.x).toBeLessThan(30.5);
    expect(groundAtTile(map, Math.floor(trace.blockedAt!.x), 20)).toBeGreaterThan(EYE_STANDING_M);
  });

  it('from the crest both sides are in view', () => {
    const map = ridgeMap(8);
    const crest = { x: 30.5, y: 20.5 };
    expect(hasLOS(map, crest, { x: 8.5, y: 20.5 })).toBe(true);
    expect(hasLOS(map, crest, { x: 52.5, y: 20.5 })).toBe(true);
  });

  it('a gentle uniform slope never masks itself', () => {
    const map = elevMap((e) => { e.base(0); e.slope({ x: 0, y: 0, w: 60, h: 40 }, 0, 9, 0); });
    expect(hasLOS(map, { x: 5.5, y: 20.5 }, { x: 55.5, y: 20.5 })).toBe(true);
    expect(hasLOS(map, { x: 55.5, y: 20.5 }, { x: 5.5, y: 20.5 })).toBe(true);
  });

  it('a prone soldier just behind a crest is hidden where a standing one is seen', () => {
    // a modest rise at x=30; the observer is well down the west slope, the target just behind it
    const map = elevMap((e) => {
      e.base(0);
      e.ridge([{ x: 30, y: -10 }, { x: 30, y: 50 }], 30, 3.2);
      e.smoothElevation(1);
    });
    const observer = { x: 6.5, y: 20.5 };
    let found: { target: Vec2 } | null = null;
    for (let x = 34.5; x <= 48.5 && !found; x += 1) {
      const target = { x, y: 20.5 };
      const standing = hasLOS(map, observer, target, { eyeM: EYE_STANDING_M, targetM: EYE_STANDING_M });
      const prone = hasLOS(map, observer, target, { eyeM: EYE_STANDING_M, targetM: EYE_PRONE_M });
      if (standing && !prone) found = { target };
    }
    expect(found, 'expected a band of reverse slope where prone is masked but standing is not').not.toBeNull();
  });

  it('a vehicle commander at 2.2 m sees over a crest that masks a prone rifleman', () => {
    const map = ridgeMap(8);
    const west = { x: 12.5, y: 20.5 }, east = { x: 48.5, y: 20.5 };
    let taller = 0, shorter = 0;
    for (let d = 0; d <= 16; d++) {
      const from = { x: 12.5 + d, y: 20.5 };
      if (hasLOS(map, from, east, { eyeM: EYE_VEHICLE_M })) taller++;
      if (hasLOS(map, from, east, { eyeM: EYE_PRONE_M })) shorter++;
    }
    void west;
    expect(taller).toBeGreaterThanOrEqual(shorter);
    expect(taller).toBeGreaterThan(shorter);
    expect(eyeHeightM('standing')).toBe(EYE_STANDING_M);
    expect(eyeHeightM('prone')).toBe(EYE_PRONE_M);
  });
});

// ------------------------------------------------------------------ movement
describe('slope movement', () => {
  it('uphill is slower, downhill a little faster, both bounded', () => {
    const map = elevMap((e) => { e.base(0); e.slope({ x: 0, y: 0, w: 60, h: 40 }, 0, 12, 0); });
    const low = { x: 10.5, y: 20.5 }, high = { x: 50.5, y: 20.5 };
    expect(groundAtTile(map, 50, 20)).toBeGreaterThan(groundAtTile(map, 10, 20));
    const up = gradeSpeedMul(map, low, high);
    const down = gradeSpeedMul(map, high, low);
    expect(up).toBeLessThan(1);
    expect(down).toBeGreaterThan(1);
    expect(up).toBeGreaterThanOrEqual(GRADE_FLOOR);
    expect(down).toBeLessThanOrEqual(GRADE_MAX);
  });

  it('a vehicle loses more speed on the same climb than a man does', () => {
    const map = elevMap((e) => { e.base(0); e.slope({ x: 0, y: 0, w: 60, h: 40 }, 0, 12, 0); });
    const a = { x: 20.5, y: 20.5 }, b = { x: 24.5, y: 20.5 };
    expect(gradeSpeedMul(map, a, b, GRADE_UPHILL_VEHICLE)).toBeLessThan(gradeSpeedMul(map, a, b));
  });

  it('a steep bank is impassable to vehicles but not to infantry', () => {
    const map = elevMap((e) => {
      e.base(0);
      e.terrace({ x: 0, y: 0, w: 30, h: 40 }, 9); // a bank down the middle
    });
    const steep = map.groundSteep!;
    let blocked = 0, bankX = -1;
    for (let x = 0; x < 60; x++) {
      if (steep[20 * 60 + x] > VEHICLE_MAX_GRADE) { blocked++; if (bankX < 0) bankX = x; }
    }
    expect(blocked).toBeGreaterThan(0);
    expect(isPassable(map, bankX, 20, 'vehicle')).toBe(false);
    expect(isPassable(map, bankX, 20, 'infantry')).toBe(true);
    // flat ground on either side is still fine for a vehicle
    expect(isPassable(map, 5, 20, 'vehicle')).toBe(true);
    expect(isPassable(map, 55, 20, 'vehicle')).toBe(true);
  });
});

// ------------------------------------------------------------------ spotting
describe('spotting height advantage', () => {
  it('an observer above the target spots better, and worse looking uphill', () => {
    const map = elevMap((e) => { e.base(0); e.slope({ x: 0, y: 0, w: 60, h: 40 }, 0, 20, 0); });
    const state = stateFor(map);
    const low = { x: 6.5, y: 20.5 }, high = { x: 52.5, y: 20.5 };
    const dh = groundAtTile(map, 52, 20) - groundAtTile(map, 6, 20);
    expect(dh).toBeGreaterThan(8);
    const down = heightSpotFactor(state, high, low);
    const up = heightSpotFactor(state, low, high);
    expect(down).toBeGreaterThan(1);
    expect(up).toBeLessThan(1);
    expect(down).toBeLessThanOrEqual(1 + HEIGHT_SPOT_CAP + 1e-9);
    expect(up).toBeGreaterThanOrEqual(1 - HEIGHT_SPOT_CAP - 1e-9);
    expect(down * up).toBeCloseTo(1 - (down - 1) * (down - 1), 5); // exactly mirrored
  });

  it('the bonus reaches the spot score of a real observer', () => {
    const map = elevMap((e) => { e.base(0); e.slope({ x: 0, y: 0, w: 60, h: 40 }, 0, 20, 0); });
    const state = stateFor(map);
    const low = { x: 20.5, y: 20.5 }, high = { x: 40.5, y: 20.5 };
    const fromHigh = observerStandingSpotScore(state, { pos: high, soldier: null }, low);
    const fromLow = observerStandingSpotScore(state, { pos: low, soldier: null }, high);
    expect(fromHigh).toBeGreaterThan(fromLow);
    expect(spotterEyeM({ pos: high, soldier: null })).toBe(EYE_VEHICLE_M);
    expect(spotterEyeM({ pos: high, soldier: soldierAt(high, 'prone') })).toBe(EYE_PRONE_M);
  });
});

// ------------------------------------------------------------------ the shipped maps
describe('shipped map relief', () => {
  const built = MAPS.map((def) => ({ def, map: buildMap(def) }));

  it('every map has relief in the 0-25 m band with gentle typical slopes and no cliffs', () => {
    for (const { def, map } of built) {
      const g = map.ground;
      expect(g, `${def.id} should define elevation()`).toBeDefined();
      let lo = Infinity, hi = -Infinity;
      for (const v of g!) { if (v < lo) lo = v; if (v > hi) hi = v; }
      expect(lo, def.id).toBeGreaterThanOrEqual(0);
      expect(hi, def.id).toBeLessThanOrEqual(25);
      // round-5 fix #2: the maps used to carry 5-12 m of swell, which the depth map proved was
      // invisible in play (2-6 m across a whole screen). Every map now has real landforms.
      expect(hi - lo, `${def.id} should actually have relief`).toBeGreaterThan(15);

      const steep = map.groundSteep!;
      let sum = 0, max = 0;
      for (let i = 0; i < steep.length; i++) { sum += steep[i]; if (steep[i] > max) max = steep[i]; }
      const mean = sum / steep.length;
      expect(mean, `${def.id} mean grade`).toBeGreaterThan(0.005);
      // ~15-21 m of relief on a 400 m map genuinely costs grade: typical working slopes are now
      // 4-10% with the ridge flanks and stream banks above that.
      expect(mean, `${def.id} mean grade`).toBeLessThan(0.11);
      // every map now relaxes to 24%, below VEHICLE_MAX_GRADE, so relief never strands a tank
      expect(max, `${def.id} steepest grade (no cliffs)`).toBeLessThanOrEqual(0.245);
    }
  });

  it('the relief keeps the map drivable: the great majority of open ground stays one vehicle region', () => {
    for (const { def, map } of built) {
      const steep = map.groundSteep!;
      let blocked = 0;
      for (let i = 0; i < steep.length; i++) if (steep[i] > VEHICLE_MAX_GRADE) blocked++;
      // steep ground is confined to river banks and the balka lip
      expect(blocked / steep.length, `${def.id} steep fraction`).toBeLessThan(0.05);
      // and every deploy zone's centre is still drivable ground
      for (const side of ['german', 'soviet'] as const) {
        const z = def.deployZones[side];
        const x = Math.floor(z.x + z.w / 2), y = Math.floor(z.y + z.h / 2);
        expect(steep[y * map.width + x], `${def.id} ${side} deploy centre`).toBeLessThanOrEqual(VEHICLE_MAX_GRADE);
      }
    }
  });

  it('is deterministic: two builds of the same map produce identical ground', () => {
    for (const { def, map } of built) {
      const again = buildMap(def);
      expect(Array.from(again.ground!)).toEqual(Array.from(map.ground!));
    }
  });

  it('rivers run in the low ground and roads stay walkable', () => {
    for (const { def, map } of built) {
      for (const v of def.vectors ?? []) {
        if (v.kind === 'river') {
          // the watercourse is below the ground a few tiles to either side of it
          for (const pt of v.points) {
            const x = Math.max(6, Math.min(map.width - 7, Math.floor(pt.x)));
            const y = Math.max(6, Math.min(map.height - 7, Math.floor(pt.y)));
            const bed = groundAtTile(map, x, y);
            const bank = Math.max(groundAtTile(map, x - 6, y), groundAtTile(map, x + 6, y));
            expect(bed, `${def.id} river bed at ${x},${y}`).toBeLessThan(bank + 0.05);
          }
        }
        if (v.kind === 'road' && v.points.length > 1) {
          // Sampled along the polyline, the road's own grade stays walkable. Two bounds, because
          // two different things matter: the ROAD grade (what a cart or a lorry climbs) is a
          // gradient over tens of metres, measured here over a 3-tile (6 m) window; the per-tile
          // step matters only in that it must stay drivable (VEHICLE_MAX_GRADE). A single tile
          // can be steeper than the road as a whole where two graded roads cross and the second
          // corridor overwrites the first's — a kerb at a junction, not a hill.
          const WINDOW_TILES = 3;
          for (let k = 0; k < v.points.length - 1; k++) {
            const a = v.points[k], b = v.points[k + 1];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            const n = Math.max(1, Math.round(len));
            const at = (s: number) => ({ x: a.x + (b.x - a.x) * (s / n), y: a.y + (b.y - a.y) * (s / n) });
            for (let s = 0; s < n; s++) {
              const p0 = at(s), p1 = at(s + 1);
              const run = Math.hypot(p1.x - p0.x, p1.y - p0.y) * TILE_M;
              if (run < 0.5) continue;
              const step = Math.abs(groundHeightAt(map, p1) - groundHeightAt(map, p0)) / run;
              expect(step, `${def.id} road step near ${p0.x.toFixed(0)},${p0.y.toFixed(0)}`).toBeLessThanOrEqual(VEHICLE_MAX_GRADE);
              const q1 = at(Math.min(n, s + WINDOW_TILES));
              const wrun = Math.hypot(q1.x - p0.x, q1.y - p0.y) * TILE_M;
              if (wrun < 2) continue;
              const grade = Math.abs(groundHeightAt(map, q1) - groundHeightAt(map, p0)) / wrun;
              expect(grade, `${def.id} road grade near ${p0.x.toFixed(0)},${p0.y.toFixed(0)}`).toBeLessThan(0.2);
            }
          }
        }
      }
    }
  });

  it('computeGroundSteep matches a direct neighbour scan', () => {
    const g = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0, 0]);
    const s = computeGroundSteep(g, 3, 3);
    expect(s[1]).toBeCloseTo(1 / TILE_M);
    expect(s[0]).toBeCloseTo(1 / TILE_M);
    expect(s[8]).toBe(0);
  });
});
