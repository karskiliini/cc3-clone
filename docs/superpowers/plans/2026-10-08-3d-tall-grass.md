# 3D Tall Grass and Crops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3D-drawn vehicles standing in tall grass or wheat get a local patch of 3D blades that part around the hull, lie flat in its wake and fade into the painted field.

**Architecture:** A pure, world-anchored blade field (`grassField.ts`) decides every blade near each 3D vehicle — position, shape, bend, fade — from hashes, the hulls and a crushed-ground grid (`grassCrush.ts`) that `GrassFx` stamps together with its painted wake. A `GrassLayer` (`grassPatch.ts`, two three.js `InstancedMesh`es with a bend/dither shader patch) lives in the existing `VehicleScene` and is drawn in the vehicles' WebGL pass. `drawVehicles` fills it each frame and tells `GrassFx.drawStanding` which vehicles no longer need the 2D fringe.

**Tech Stack:** TypeScript, three.js (InstancedMesh, MeshLambertMaterial + onBeforeCompile), Canvas2D, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-3d-tall-grass-design.md`

Repo: `~/work/cc3_clone-glm`, branch `vehicles-3d-p1`. Run tests with `npx vitest run <file>`; typecheck with `npx tsc --noEmit`.

## Global Constraints

- Render side only: nothing under `src/sim`, `src/shared`, `src/net` imports `three` or `src/render` (guarded by `test/vehicle3dIsolation.test.ts`). The sim and its determinism are untouched.
- World metres: x east, z south (`TILE_M = 2` m per tile). Compass directions: 0 = north, clockwise (as `hullFacing`): direction `d` ↔ vector `(sin d, −cos d)`.
- `CELL_M = 0.2` (25 blades/m²), `PATCH_PAD_M = 5`, `FADE_M = 2.5`, `PUSH_M = 1.0`, push angle `70° · (1 − d / PUSH_M)²`, bow wave above 0.3 m/s, `CRUSH_CELL_M = 0.5`, `MAX_BLADES = 40000`.
- Grass 0.6–0.9 m tall, 4–6 cm wide, tip offset 15–30 % of height; wheat 1.0–1.2 m, tip offset ≤ 8 %, ear over the top 15 %, one step lighter. Colours from `BLADES[season][growth].up`.
- Under a hull (footprint grown by 0.15 m): flat, height scale 0.08. Crushed (level ≥ 0.5): flat along the stored direction, height scale 0.12.
- Same visibility rule as `GrassFx`: only vehicles the player sees stamp the crush map or get a patch.
- Sprite-drawn vehicles (no model, no WebGL, `?vehicles=sprites`, lost context, failed draw) keep the 2D fringe; so do 3D vehicles whose patch the budget dropped.
- Comments match the codebase: a header block per new file, short `/** */` on exported things, no narration.

**Deviations from the spec, decided here** (an executor follows these):
1. The pure field/bend code lives in `src/render/vehicle3d/grassField.ts`; `grassPatch.ts` holds only the three.js `GrassLayer`. (Spec put both in `grassPatch.ts`; split for size and Node testing.)
2. The crush map is reached through `crushMapFor(state.map)` (module `WeakMap`, `src/render/grassCrush.ts`) instead of a `GrassFx.crushAt` method, so `drawVehicles` needs no new parameter. `GrassFx` still does all the stamping and clearing.
3. Bow wave reaches `BOW_PUSH_M = 2` m ahead of a moving bow (same falloff shape). Ahead of the hull the "away" direction already is forward, so with the spec's 1 m reach the wave would be invisible.
4. **Wake gap**: a moving vehicle's strip behind its tail, up to `WAKE_GAP_M = 0.9` m (one `STAMP_STEP_TILES` of 0.7 m plus margin) and within the hull width, lies flat (height scale 0.12, along travel), so blades do not stand up between wake stamps and then pop flat.

## Review Focus

1. **Moving tank, between wake stamps** — the strip just behind the tail is not yet in the crush map; blades there must already lie flat, not stand up and pop. Test: Task 4 "wake gap".
2. **Lost WebGL context or a failed draw mid-battle** — every vehicle in a field must get the 2D fringe back that frame. Test: Task 5 `grassHandOver(…, drewOk = false)` is empty.
3. **A hidden enemy driving through a field** — must not crush growth (no betraying wake) nor get a patch. Test: Task 2 "hidden enemy".
4. **Restarting / rewinding on the same map** — old crush cells must vanish with the painted trail. Test: Task 2 "time jump back".
5. **Frame cost with several tanks in fields** — rebuilding up to 40 000 blades per frame must not stutter. Check: Task 8 timing with `__vbUnitsMs`, acceptance ≤ 6 ms extra per unit-layer draw at zoom 1.

---

## File structure

- Create `src/render/grassCrush.ts` — `CrushMap` (0.5 m flattened-ground grid + travel direction) and `crushMapFor(map)`.
- Modify `src/render/grassFx.ts` — export `BLADES`, `seasonKey`, `SeasonKey`; stamp/clear the crush map; `drawStanding(..., skip)`.
- Create `src/render/vehicle3d/grassField.ts` — constants, `bladeAt`, `hullLocal`, `patchFade`, `bendBlade`, `bladesFor`, `grassHandOver`.
- Create `src/render/vehicle3d/grassPatch.ts` — `bendPoint`, `bladeGeometry`, `patchBladeMaterial`, `GrassLayer`.
- Modify `src/render/vehicle3d/vehicleScene.ts` — owns a `GrassLayer`; `reset()` clears it.
- Modify `src/render/unitRender.ts` — builds patches in `drawVehicles`; exports `vehiclesWithGrass3d()`.
- Modify `src/ui/screens/battle.ts` — passes `vehiclesWithGrass3d()` to `drawStanding`.
- Modify `tools/vehicleBattle.ts` — `fill=` param and grass layers, for the visual check.
- Tests: `test/grassCrush.test.ts` (new), `test/grassFx.test.ts` (extend), `test/grassField.test.ts` (new), `test/grassLayer.test.ts` (new).

---

### Task 1: Crush map

**Files:**
- Create: `src/render/grassCrush.ts`
- Test: `test/grassCrush.test.ts`

**Interfaces:**
- Produces: `CRUSH_CELL_M = 0.5`; `interface Crush { level: number; dirRad: number }`; `class CrushMap { constructor(widthTiles: number, heightTiles: number); stampBand(from: Vec2, to: Vec2, halfWidthM: number): void; at(p: Vec2): Crush | null; clear(): void }` (positions in tile coords); `crushMapFor(map: GameMap): CrushMap`.

- [ ] **Step 1: Write the failing test** — `test/grassCrush.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { GameMap } from '@/shared/types';
import { CrushMap, crushMapFor } from '@/render/grassCrush';

describe('CrushMap', () => {
  it('knows nothing until something is stamped', () => {
    expect(new CrushMap(20, 20).at({ x: 10, y: 10 })).toBeNull();
  });
  it('flattens the band driven, half-width either side, with the travel direction', () => {
    const c = new CrushMap(20, 20);
    c.stampBand({ x: 10, y: 10 }, { x: 10, y: 6 }, 1.5);          // 8 m north
    expect(c.at({ x: 10, y: 8 })).toEqual({ level: 1, dirRad: 0 });
    expect(c.at({ x: 10.5, y: 8 })?.level).toBe(1);               // 1 m aside: inside 1.5 m
    expect(c.at({ x: 11, y: 8 })).toBeNull();                      // 2 m aside
    expect(c.at({ x: 10, y: 11 })).toBeNull();                     // behind the start
    expect(c.at({ x: 10, y: 5 })).toBeNull();                      // beyond the end
  });
  it('stores eastward travel as a quarter turn', () => {
    const c = new CrushMap(20, 20);
    c.stampBand({ x: 4, y: 10 }, { x: 8, y: 10 }, 1);
    expect(c.at({ x: 6, y: 10 })!.dirRad).toBeCloseTo(Math.PI / 2, 1);
  });
  it('clear forgets everything; points off the map are null', () => {
    const c = new CrushMap(20, 20);
    c.stampBand({ x: 10, y: 10 }, { x: 10, y: 6 }, 1.5);
    expect(c.at({ x: -1, y: 8 })).toBeNull();
    c.clear();
    expect(c.at({ x: 10, y: 8 })).toBeNull();
  });
  it('one crush map per game map', () => {
    const a = { width: 20, height: 20 } as GameMap, b = { width: 20, height: 20 } as GameMap;
    expect(crushMapFor(a)).toBe(crushMapFor(a));
    expect(crushMapFor(a)).not.toBe(crushMapFor(b));
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run test/grassCrush.test.ts`. Expected: FAIL, cannot resolve `@/render/grassCrush`.

- [ ] **Step 3: Implement** — `src/render/grassCrush.ts`:

```ts
// ============================================================================
// grassCrush.ts — where tall growth has been driven flat: a map-sized grid of
// 0.5 m cells (level + travel direction) that the 3D grass reads. GrassFx
// stamps it together with its painted wake, so the two always agree.
// Render side only; never read by the sim.
// ============================================================================
import type { GameMap, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';

export const CRUSH_CELL_M = 0.5;
const PER_TILE = TILE_M / CRUSH_CELL_M;
const TAU = Math.PI * 2;

/** level 0..1 (1 = flat), dirRad = the way it was pressed (0 = north, clockwise) */
export interface Crush { level: number; dirRad: number }

export class CrushMap {
  readonly cols: number;
  readonly rows: number;
  // allocated on the first stamp: most battles never drive through a field
  private level: Uint8Array | null = null;
  private dir: Uint8Array | null = null;

  constructor(widthTiles: number, heightTiles: number) {
    this.cols = Math.ceil(widthTiles * PER_TILE);
    this.rows = Math.ceil(heightTiles * PER_TILE);
  }

  /** Flattens the band swept from `from` to `to` (tile coords), halfWidthM either side of the line. */
  stampBand(from: Vec2, to: Vec2, halfWidthM: number): void {
    const ax = from.x * TILE_M, az = from.y * TILE_M, bx = to.x * TILE_M, bz = to.y * TILE_M;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-4) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const dirRad = Math.atan2(ux, -uz);
    const q = Math.round(((((dirRad % TAU) + TAU) % TAU) / TAU) * 256) & 255;
    this.level ??= new Uint8Array(this.cols * this.rows);
    this.dir ??= new Uint8Array(this.cols * this.rows);
    const r = halfWidthM;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / CRUSH_CELL_M));
    const c1 = Math.min(this.cols - 1, Math.floor((Math.max(ax, bx) + r) / CRUSH_CELL_M));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz) - r) / CRUSH_CELL_M));
    const r1 = Math.min(this.rows - 1, Math.floor((Math.max(az, bz) + r) / CRUSH_CELL_M));
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        const px = (i + 0.5) * CRUSH_CELL_M - ax, pz = (j + 0.5) * CRUSH_CELL_M - az;
        const t = px * ux + pz * uz, n = Math.abs(-px * uz + pz * ux);
        if (t < 0 || t > len || n > r) continue;
        const k = j * this.cols + i;
        this.level[k] = 255;
        this.dir[k] = q;
      }
    }
  }

  at(p: Vec2): Crush | null {
    if (!this.level || !this.dir) return null;
    const i = Math.floor(p.x * PER_TILE), j = Math.floor(p.y * PER_TILE);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return null;
    const k = j * this.cols + i, l = this.level[k];
    return l ? { level: l / 255, dirRad: (this.dir[k] / 256) * TAU } : null;
  }

  clear(): void { this.level = null; this.dir = null; }
}

const maps = new WeakMap<GameMap, CrushMap>();

/** The battle map's crush grid (one per map object; a new battle's map gets a fresh one). */
export function crushMapFor(map: GameMap): CrushMap {
  let c = maps.get(map);
  if (!c) { c = new CrushMap(map.width, map.height); maps.set(map, c); }
  return c;
}
```

- [ ] **Step 4: Run it** — `npx vitest run test/grassCrush.test.ts`. Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/render/grassCrush.ts test/grassCrush.test.ts
git commit -m "Crush map: where tall growth has been driven flat, for the 3D grass"
```

---

### Task 2: GrassFx stamps and clears the crush map

**Files:**
- Modify: `src/render/grassFx.ts` (`BLADES`/`seasonKey` exports; `update` reset; `stamp`)
- Test: `test/grassFx.test.ts` (extend)

**Interfaces:**
- Consumes: `crushMapFor(map).stampBand / .clear / .at` (Task 1).
- Produces: `export const BLADES`, `export type SeasonKey = 'summer' | 'autumn' | 'winter'`, `export function seasonKey(season: Season | undefined): SeasonKey` (all from `@/render/grassFx`, used by Tasks 3 and 7).

- [ ] **Step 1: Write the failing tests** — append to `test/grassFx.test.ts` (add the imports at the top):

```ts
import { GrassFx } from '@/render/grassFx';
import { crushMapFor } from '@/render/grassCrush';
import { VEHICLE_DEFS } from '@/data/units';
import { TILE_M } from '@/shared/types';
import type { BattleState } from '@/shared/types';
import { addTank, makeState, W } from './vehicleDamageHelpers';

function tallField(state: BattleState): void {
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) state.map.tiles[y * W + x] = 'tallgrass';
}

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
```

- [ ] **Step 2: Run** — `npx vitest run test/grassFx.test.ts`. Expected: the first and third new tests FAIL (`c?.level` undefined); "hidden enemy" passes already (nothing stamps yet) — that is fine, it guards the rule.

- [ ] **Step 3: Implement** in `src/render/grassFx.ts`:
  - Add `import { crushMapFor } from './grassCrush';`.
  - Change `const BLADES: Record<'summer' | 'autumn' | 'winter', …>` to `export const BLADES: Record<SeasonKey, …>`, add `export type SeasonKey = 'summer' | 'autumn' | 'winter';` above it, and make `seasonKey` exported with return type `SeasonKey`.
  - In `update`, the reset line becomes:

```ts
    if (state.map !== this.mapRef || state.time < this.lastTime - 0.5) {
      this.reset(); this.mapRef = state.map;
      crushMapFor(state.map).clear();
    }
```

  - In `stamp`, move the canvas check below the geometry and stamp the crush band first. The beginning of `stamp` becomes:

```ts
  private stamp(state: BattleState, f: Footprint, growth: TallGrowth, season: SeasonKey, from: Vec2): void {
    const dx = f.pos.x - from.x, dy = f.pos.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return;
    // the 3D grass lies flat over the same stretch the painted wake covers: old tail -> new tail
    const tail = f.lengthM / 2 / TILE_M, ux = dx / len, uy = dy / len;
    crushMapFor(state.map).stampBand({ x: from.x - ux * tail, y: from.y - uy * tail }, { x: f.pos.x - ux * tail, y: f.pos.y - uy * tail }, f.widthM / 2);
    const g = this.ensure(state);
    if (!g) return;
    const k = TRAIL_PX_PER_TILE, mPx = k / TILE_M;
    const pal = BLADES[season][growth];
    const ang = Math.atan2(dx, -dy); // 0 = north, clockwise
```

  and delete the now-duplicated `dx/dy/len/if (len < 1e-4) return;/ang` lines that followed. The rest of `stamp` is unchanged.

- [ ] **Step 4: Run** — `npx vitest run test/grassFx.test.ts`. Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/render/grassFx.ts test/grassFx.test.ts
git commit -m "Grass wakes also mark the crush map; hidden vehicles and rewinds leave none"
```

---

### Task 3: The blade field

**Files:**
- Create: `src/render/vehicle3d/grassField.ts`
- Test: `test/grassField.test.ts`

**Interfaces:**
- Consumes: `BLADES`, `SeasonKey`, `TallGrowth` from `@/render/grassFx`; `hash2` from `@/shared/rng`.
- Produces: constants `CELL_M, PATCH_PAD_M, FADE_M, PUSH_M, BOW_PUSH_M, WAKE_GAP_M, MAX_BLADES`; `type BladeKind = 'grass' | 'wheat'`; `type GrowthAt = (xM: number, zM: number) => TallGrowth | null`; `interface Blade { kind: BladeKind; xM: number; zM: number; heightM: number; widthM: number; restAngle: number; restDir: number; colour: number }`; `bladeAt(cx: number, cz: number, growthAt: GrowthAt, season: SeasonKey): Blade | null`.

- [ ] **Step 1: Write the failing test** — `test/grassField.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bladeAt, CELL_M, type GrowthAt } from '@/render/vehicle3d/grassField';

const grass: GrowthAt = () => 'tallgrass';
const crops: GrowthAt = () => 'crops';
const none: GrowthAt = () => null;
/** horizontal tip offset (fraction of length) of a blade bent into an arc of `a` radians */
const tipOffset = (a: number): number => (a < 1e-6 ? 0 : (1 - Math.cos(a)) / a);

describe('blade field', () => {
  it('the same cell always grows the same blade, inside that cell', () => {
    const a = bladeAt(1234, 567, grass, 'summer')!, b = bladeAt(1234, 567, grass, 'summer')!;
    expect(a).toEqual(b);
    expect(a.xM).toBeGreaterThanOrEqual(1234 * CELL_M); expect(a.xM).toBeLessThan(1235 * CELL_M);
    expect(a.zM).toBeGreaterThanOrEqual(567 * CELL_M); expect(a.zM).toBeLessThan(568 * CELL_M);
  });
  it('no blade where nothing tall grows', () => {
    expect(bladeAt(10, 10, none, 'summer')).toBeNull();
  });
  it('tall grass grows curved grass blades, crops grow straight wheat', () => {
    for (let i = 0; i < 300; i++) {
      const g = bladeAt(i, 3 * i, grass, 'summer')!, w = bladeAt(i, 3 * i, crops, 'summer')!;
      expect(g.kind).toBe('grass'); expect(w.kind).toBe('wheat');
      expect(g.heightM).toBeGreaterThanOrEqual(0.6); expect(g.heightM).toBeLessThanOrEqual(0.9);
      expect(w.heightM).toBeGreaterThanOrEqual(1.0); expect(w.heightM).toBeLessThanOrEqual(1.2);
      expect(g.widthM).toBeGreaterThanOrEqual(0.04); expect(g.widthM).toBeLessThanOrEqual(0.06);
      expect(tipOffset(g.restAngle)).toBeGreaterThanOrEqual(0.14); expect(tipOffset(g.restAngle)).toBeLessThanOrEqual(0.31);
      expect(tipOffset(w.restAngle)).toBeLessThanOrEqual(0.08);
    }
  });
  it('colours come from the season palette', () => {
    const s = bladeAt(5, 9, grass, 'summer')!, w = bladeAt(5, 9, grass, 'winter')!;
    expect(s.colour).not.toBe(w.colour);
    expect([0x4c5823, 0x5c6829, 0x6e7831, 0x80883b]).toContain(s.colour);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/grassField.test.ts`. Expected: FAIL, cannot resolve `@/render/vehicle3d/grassField`.

- [ ] **Step 3: Implement** — `src/render/vehicle3d/grassField.ts` (Tasks 4–5 append to it):

```ts
// ============================================================================
// The 3D tall grass around vehicles (spec 2026-10-08-3d-tall-grass): which
// blades stand where (a world-anchored hashed field, so nothing pops as a
// hull moves), how hulls and wakes bend them, and how a patch fades into the
// painted field. Pure; tested in Node. World metres: x east, z south.
// Compass directions: 0 = north, clockwise.
// ============================================================================
import { hash2 } from '@/shared/rng';
import { BLADES, type SeasonKey, type TallGrowth } from '@/render/grassFx';

/** one blade per cell: 25 per m² */
export const CELL_M = 0.2;
/** a patch reaches this far (m) outside the hull; its outer FADE_M thins into the painted field */
export const PATCH_PAD_M = 5;
export const FADE_M = 2.5;
/** a standing hull pushes blades over within this distance (m) of its sides */
export const PUSH_M = 1.0;
/** ...and a moving bow this far ahead of it */
export const BOW_PUSH_M = 2.0;
/** behind a moving tail, flat this far (m): the wake stamps come every 0.7 m */
export const WAKE_GAP_M = 0.9;
export const MAX_BLADES = 40000;
const TAU = Math.PI * 2;

export type BladeKind = 'grass' | 'wheat';
export type GrowthAt = (xM: number, zM: number) => TallGrowth | null;

export interface Blade {
  kind: BladeKind;
  xM: number;
  zM: number;
  heightM: number;
  widthM: number;
  /** the blade's own curve: arc angle (rad) and the compass direction it bends toward */
  restAngle: number;
  restDir: number;
  /** 0xRRGGBB */
  colour: number;
}

/** The blade of field cell (cx, cz), or null where nothing tall grows. */
export function bladeAt(cx: number, cz: number, growthAt: GrowthAt, season: SeasonKey): Blade | null {
  const xM = (cx + hash2(cx, cz, 701)) * CELL_M, zM = (cz + hash2(cx, cz, 702)) * CELL_M;
  const growth = growthAt(xM, zM);
  if (!growth) return null;
  const h = hash2(cx, cz, 703), w = hash2(cx, cz, 704), c = hash2(cx, cz, 705);
  const wheat = growth === 'crops';
  const tones = BLADES[season][growth].up;
  return {
    kind: wheat ? 'wheat' : 'grass', xM, zM,
    heightM: wheat ? 1.0 + 0.2 * h : 0.6 + 0.3 * h,
    widthM: wheat ? 0.025 : 0.04 + 0.02 * w,
    // tip offset (1 - cos a) / a: 0.15..0.30 for grass, <= 0.08 for wheat
    restAngle: wheat ? 0.16 * w : 0.3 + 0.32 * w,
    restDir: hash2(cx, cz, 706) * TAU,
    // mostly the darker tones, as the 2D fringe: the light ones are the rare sunlit tips
    colour: parseInt(tones[Math.min(tones.length - 1, Math.floor(c * c * tones.length))].slice(1), 16),
  };
}
```

- [ ] **Step 4: Run** — `npx vitest run test/grassField.test.ts`. Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/render/vehicle3d/grassField.ts test/grassField.test.ts
git commit -m "3D grass: a world-anchored field of grass blades and wheat stalks"
```

---

### Task 4: Fade and bending

**Files:**
- Modify: `src/render/vehicle3d/grassField.ts` (append)
- Test: `test/grassField.test.ts` (append)

**Interfaces:**
- Consumes: `Blade`, constants (Task 3); `Crush` type from `@/render/grassCrush`.
- Produces: `interface HullPatch { id: number; xM: number; zM: number; facing: number; halfLenM: number; halfWidM: number; speedMs: number }`; `hullLocal(h, xM, zM): { lx: number; ly: number; d: number; awayX: number; awayZ: number }`; `patchFade(d: number): number`; `type CrushAt = (xM: number, zM: number) => Crush | null`; `interface Bend { dirX: number; dirZ: number; angle: number; heightScale: number }`; `bendBlade(b: Blade, hulls: readonly HullPatch[], crush: CrushAt | null): Bend`; `FLAT = Math.PI / 2`.

- [ ] **Step 1: Write the failing tests** — append to `test/grassField.test.ts` (merge the import line):

```ts
import { bendBlade, FLAT, patchFade, PUSH_M, type Blade, type HullPatch } from '@/render/vehicle3d/grassField';

// a north-facing 7 x 3 m hull at the origin: its right side (east) is x = 1.5, its bow z = -3.5
const hull = (over: Partial<HullPatch> = {}): HullPatch => ({ id: 1, xM: 0, zM: 0, facing: 0, halfLenM: 3.5, halfWidM: 1.5, speedMs: 0, ...over });
const blade = (xM: number, zM: number): Blade => ({ kind: 'grass', xM, zM, heightM: 0.8, widthM: 0.05, restAngle: 0, restDir: 0, colour: 0 });

describe('patch fade', () => {
  it('is full near the hull, gone at the patch edge, and never rises outward', () => {
    expect(patchFade(0)).toBe(1); expect(patchFade(2.5)).toBe(1);
    expect(patchFade(5)).toBe(0); expect(patchFade(7)).toBe(0);
    let last = 1;
    for (let d = 2.5; d <= 5; d += 0.1) { const f = patchFade(d); expect(f).toBeLessThanOrEqual(last); last = f; }
  });
});

describe('bending', () => {
  it('under the hull the growth lies flat along the hull', () => {
    const b = bendBlade(blade(0.5, 1), [hull()], null);
    expect(b.angle).toBe(FLAT); expect(b.heightScale).toBe(0.08);
    expect(b.dirZ).toBeCloseTo(-1);                       // facing north
  });
  it('beside the hull blades lean away from it, more the closer they stand', () => {
    const near = bendBlade(blade(1.7, 0), [hull()], null), far = bendBlade(blade(2.3, 0), [hull()], null);
    expect(near.dirX).toBeCloseTo(1); expect(near.dirZ).toBeCloseTo(0);
    expect(near.angle).toBeGreaterThan(far.angle);
    expect(far.angle).toBeGreaterThan(0);
    expect(bendBlade(blade(1.5 + PUSH_M + 0.5, 0), [hull()], null).angle).toBe(0);   // rest
  });
  it('a moving bow pushes the blades ahead of it forward, further out than a parked one', () => {
    const parked = bendBlade(blade(0, -5), [hull()], null);
    const moving = bendBlade(blade(0, -5), [hull({ speedMs: 4 })], null);
    expect(parked.angle).toBe(0);
    expect(moving.angle).toBeGreaterThan(0); expect(moving.dirZ).toBeCloseTo(-1);
  });
  it('reversing pushes the blades behind the stern backward', () => {
    const b = bendBlade(blade(0, 5), [hull({ speedMs: -2 })], null);
    expect(b.dirZ).toBeCloseTo(1); expect(b.angle).toBeGreaterThan(0);
  });
  it('wake gap: right behind a moving tail the growth already lies flat', () => {
    const b = bendBlade(blade(0.3, 3.5 + 0.6), [hull({ speedMs: 4 })], null);
    expect(b.angle).toBe(FLAT); expect(b.heightScale).toBe(0.12); expect(b.dirZ).toBeCloseTo(-1);
    expect(bendBlade(blade(0.3, 3.5 + 0.6), [hull()], null).heightScale).toBe(1);   // parked: no gap
  });
  it('crushed ground lies flat the way it was driven', () => {
    const b = bendBlade(blade(20, 20), [hull()], () => ({ level: 1, dirRad: Math.PI / 2 }));
    expect(b.angle).toBe(FLAT); expect(b.heightScale).toBe(0.12); expect(b.dirX).toBeCloseTo(1);
  });
  it('between two hulls the stronger push wins', () => {
    const a = hull(), b = hull({ id: 2, xM: 4 });            // b's left side at x = 2.5
    const r = bendBlade(blade(2.3, 0), [a, b], null);        // 0.8 m from a, 0.2 m from b
    expect(r.dirX).toBeCloseTo(-1);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/grassField.test.ts`. Expected: FAIL, `bendBlade` / `patchFade` not exported.

- [ ] **Step 3: Implement** — append to `src/render/vehicle3d/grassField.ts` (and add `import type { Crush } from '@/render/grassCrush';` to the imports):

```ts
/** A vehicle the field grows round: its centre, compass facing, half extents and signed speed (m/s, < 0 reversing). */
export interface HullPatch { id: number; xM: number; zM: number; facing: number; halfLenM: number; halfWidM: number; speedMs: number }

/** A point in the hull's frame: lx right, ly forward, d its distance outside the hull rectangle
 * (0 inside), away the unit vector pointing from the nearest hull edge to it (0 inside). */
export function hullLocal(h: HullPatch, xM: number, zM: number): { lx: number; ly: number; d: number; awayX: number; awayZ: number } {
  const fx = Math.sin(h.facing), fz = -Math.cos(h.facing), rx = Math.cos(h.facing), rz = Math.sin(h.facing);
  const px = xM - h.xM, pz = zM - h.zM;
  const lx = px * rx + pz * rz, ly = px * fx + pz * fz;
  const ex = Math.max(Math.abs(lx) - h.halfWidM, 0), ey = Math.max(Math.abs(ly) - h.halfLenM, 0);
  const d = Math.hypot(ex, ey);
  if (d === 0) return { lx, ly, d, awayX: 0, awayZ: 0 };
  const sx = (Math.sign(lx) * ex) / d, sy = (Math.sign(ly) * ey) / d;
  return { lx, ly, d, awayX: sx * rx + sy * fx, awayZ: sx * rz + sy * fz };
}

/** How much of a blade at d metres outside the hull survives: 1 out to PATCH_PAD_M - FADE_M, then smoothly to 0. */
export function patchFade(d: number): number {
  if (d <= PATCH_PAD_M - FADE_M) return 1;
  if (d >= PATCH_PAD_M) return 0;
  const t = (PATCH_PAD_M - d) / FADE_M;
  return t * t * (3 - 2 * t);
}

export type CrushAt = (xM: number, zM: number) => Crush | null;

/** A blade's pose: it bends toward (dirX, dirZ) into an arc of `angle` rad; heightScale squashes it toward the ground. */
export interface Bend { dirX: number; dirZ: number; angle: number; heightScale: number }

/** lying down: the arc's tip runs along the ground */
export const FLAT = Math.PI / 2;
const UNDER_PAD_M = 0.15;
const PUSH_MAX_RAD = (70 * Math.PI) / 180;
const BOW_SPEED_MS = 0.3;

/** How the hulls and the wakes bend a blade (strongest wins): under a hull flat; in a moving hull's
 * wake gap or on crushed ground flat along the travel; beside a hull pushed away from it (ahead of
 * a moving bow, forward); otherwise its own curve. */
export function bendBlade(b: Blade, hulls: readonly HullPatch[], crush: CrushAt | null): Bend {
  const local = hulls.map((h) => hullLocal(h, b.xM, b.zM));
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i], l = local[i];
    const s = Math.sign(h.speedMs), fx = Math.sin(h.facing), fz = -Math.cos(h.facing);
    if (Math.abs(l.lx) <= h.halfWidM + UNDER_PAD_M && Math.abs(l.ly) <= h.halfLenM + UNDER_PAD_M) {
      return { dirX: fx, dirZ: fz, angle: FLAT, heightScale: 0.08 };
    }
    // the stretch the tail has just left and the next wake stamp has not yet reached
    if (Math.abs(h.speedMs) > BOW_SPEED_MS && Math.abs(l.lx) <= h.halfWidM) {
      const behind = -s * l.ly - h.halfLenM;
      if (behind > 0 && behind <= WAKE_GAP_M) return { dirX: s * fx, dirZ: s * fz, angle: FLAT, heightScale: 0.12 };
    }
  }
  const c = crush?.(b.xM, b.zM);
  if (c && c.level >= 0.5) return { dirX: Math.sin(c.dirRad), dirZ: -Math.cos(c.dirRad), angle: FLAT, heightScale: 0.12 };
  let best: Bend = { dirX: Math.sin(b.restDir), dirZ: -Math.cos(b.restDir), angle: b.restAngle, heightScale: 1 };
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i], l = local[i];
    const s = Math.sign(h.speedMs);
    const ahead = Math.abs(h.speedMs) > BOW_SPEED_MS && s * l.ly > h.halfLenM && Math.abs(l.lx) <= h.halfWidM + 0.3;
    const reach = ahead ? BOW_PUSH_M : PUSH_M;
    if (l.d <= 0 || l.d >= reach) continue;
    const angle = PUSH_MAX_RAD * (1 - l.d / reach) ** 2;
    if (angle <= best.angle) continue;
    best = ahead
      ? { dirX: s * Math.sin(h.facing), dirZ: -s * Math.cos(h.facing), angle, heightScale: 1 }
      : { dirX: l.awayX, dirZ: l.awayZ, angle, heightScale: 1 };
  }
  return best;
}
```

- [ ] **Step 4: Run** — `npx vitest run test/grassField.test.ts`. Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src/render/vehicle3d/grassField.ts test/grassField.test.ts
git commit -m "3D grass: hulls push blades aside, bows push them forward, wakes lay them flat"
```

---

### Task 5: Patches, budget and hand-over

**Files:**
- Modify: `src/render/vehicle3d/grassField.ts` (append)
- Test: `test/grassField.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: `interface BladeInst extends Blade, Bend { fade: number }`; `bladesFor(hulls: readonly HullPatch[], growthAt: GrowthAt, crush: CrushAt | null, season: SeasonKey, viewXM: number, viewZM: number, budget?: number): { blades: BladeInst[]; dropped: number[] }`; `grassHandOver(patchIds: readonly number[], dropped: readonly number[], drewOk: boolean): Set<number>`.

- [ ] **Step 1: Write the failing tests** — append to `test/grassField.test.ts` (merge imports):

```ts
import { bladesFor, grassHandOver, hullLocal, MAX_BLADES } from '@/render/vehicle3d/grassField';

describe('patches', () => {
  const H = hull({ xM: 100, zM: 100 });
  it('fill the rounded rectangle 5 m round the hull at 25 blades per m²', () => {
    const { blades } = bladesFor([H], grass, null, 'summer', 100, 100);
    const area = (7 + 10) * (3 + 10) - (4 - Math.PI) * 25;      // 199.5 m²
    expect(blades.length).toBeGreaterThan(area * 25 * 0.95);
    expect(blades.length).toBeLessThan(area * 25 * 1.05);
  });
  it('grow nothing where nothing tall grows, and wheat only on crops', () => {
    expect(bladesFor([H], none, null, 'summer', 100, 100).blades).toHaveLength(0);
    const half: GrowthAt = (x) => (x > 100 ? 'crops' : 'tallgrass');
    for (const b of bladesFor([H], half, null, 'summer', 100, 100).blades) expect(b.kind).toBe(b.xM > 100 ? 'wheat' : 'grass');
  });
  it('fade full within 2.5 m of the hull and never reach 5 m', () => {
    for (const b of bladesFor([H], grass, null, 'summer', 100, 100).blades) {
      const d = hullLocal(H, b.xM, b.zM).d;
      if (d <= 2.5) expect(b.fade).toBe(1);
      expect(d).toBeLessThan(5);
      expect(b.fade).toBeGreaterThan(0);
    }
  });
  it('two hulls side by side share one field: no blade twice', () => {
    const { blades } = bladesFor([H, hull({ id: 2, xM: 104, zM: 100 })], grass, null, 'summer', 100, 100);
    expect(new Set(blades.map((b) => `${b.xM},${b.zM}`)).size).toBe(blades.length);
  });
  it('a moving hull drives through a fixed field: the blades away from it keep their places and shapes', () => {
    const key = (b: BladeInst): string => `${b.xM},${b.zM}`;
    const a = new Map(bladesFor([H], grass, null, 'summer', 100, 100).blades.map((b) => [key(b), b]));
    let shared = 0;
    for (const b of bladesFor([hull({ xM: 100, zM: 99.7 })], grass, null, 'summer', 100, 100).blades) {
      const o = a.get(key(b));
      if (!o) continue;
      shared++;
      expect(b.heightM).toBe(o.heightM); expect(b.colour).toBe(o.colour);
    }
    expect(shared).toBeGreaterThan(4000);
  });
  it('the budget keeps the nearest patches whole and reports the rest as dropped', () => {
    const one = bladesFor([H], grass, null, 'summer', 100, 100).blades.length;
    const near = H, mid = hull({ id: 2, xM: 140, zM: 100 }), far = hull({ id: 3, xM: 180, zM: 100 });
    const r = bladesFor([far, near, mid], grass, null, 'summer', 100, 100, Math.round(one * 1.5));
    expect(r.blades.length).toBe(one);
    expect(r.dropped.sort()).toEqual([2, 3]);
    expect(bladesFor([near, mid, far], grass, null, 'summer', 100, 100).blades.length).toBeLessThanOrEqual(MAX_BLADES);
  });
});

describe('hand-over to the 2D fringe', () => {
  it('3D grass replaces the fringe only for drawn, undropped patches', () => {
    expect([...grassHandOver([1, 2, 3], [2], true)].sort()).toEqual([1, 3]);
  });
  it('a failed or lost GL draw gives every vehicle its 2D fringe back', () => {
    expect(grassHandOver([1, 2, 3], [], false).size).toBe(0);
  });
});
```

(`BladeInst` joins the type imports.)

- [ ] **Step 2: Run** — `npx vitest run test/grassField.test.ts`. Expected: FAIL, `bladesFor` / `grassHandOver` not exported.

- [ ] **Step 3: Implement** — append to `src/render/vehicle3d/grassField.ts`:

```ts
/** One blade as drawn this frame: where it stands, how it bends, how much of it survives the patch fade. */
export interface BladeInst extends Blade, Bend { fade: number }

/** The blades of every hull's patch, nearest to the view centre first. A patch that would overrun
 * the budget is dropped whole (its vehicle keeps the 2D fringe). Cells shared by two patches grow
 * one blade, bent by every hull near it. */
export function bladesFor(
  hulls: readonly HullPatch[], growthAt: GrowthAt, crush: CrushAt | null, season: SeasonKey,
  viewXM: number, viewZM: number, budget = MAX_BLADES,
): { blades: BladeInst[]; dropped: number[] } {
  const reach = (h: HullPatch): number => Math.hypot(h.halfLenM, h.halfWidM) + PATCH_PAD_M;
  const dist = (h: HullPatch): number => Math.hypot(h.xM - viewXM, h.zM - viewZM);
  const order = [...hulls].sort((a, b) => dist(a) - dist(b) || a.id - b.id);
  const blades: BladeInst[] = [], dropped: number[] = [];
  const seen = new Set<number>();
  for (const h of order) {
    const near = hulls.filter((o) => Math.hypot(o.xM - h.xM, o.zM - h.zM) <= reach(h) + reach(o));
    const r = reach(h);
    const cx0 = Math.floor((h.xM - r) / CELL_M), cx1 = Math.floor((h.xM + r) / CELL_M);
    const cz0 = Math.floor((h.zM - r) / CELL_M), cz1 = Math.floor((h.zM + r) / CELL_M);
    const mine: BladeInst[] = [], keys: number[] = [];
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cx * 100000 + cz;
        if (seen.has(key)) continue;
        if (hullLocal(h, (cx + 0.5) * CELL_M, (cz + 0.5) * CELL_M).d >= PATCH_PAD_M + CELL_M) continue;
        const b = bladeAt(cx, cz, growthAt, season);
        if (!b || hullLocal(h, b.xM, b.zM).d >= PATCH_PAD_M) continue;
        let fade = 0;
        for (const o of near) fade = Math.max(fade, patchFade(hullLocal(o, b.xM, b.zM).d));
        if (fade <= 0) continue;
        mine.push({ ...b, ...bendBlade(b, near, crush), fade });
        keys.push(key);
      }
    }
    if (blades.length + mine.length > budget) { dropped.push(h.id); continue; }
    for (const k of keys) seen.add(k);
    for (const b of mine) blades.push(b);
  }
  return { blades, dropped };
}

/** The vehicles whose 2D fringe the 3D grass replaces this frame: none if the GL draw failed. */
export function grassHandOver(patchIds: readonly number[], dropped: readonly number[], drewOk: boolean): Set<number> {
  return drewOk ? new Set(patchIds.filter((id) => !dropped.includes(id))) : new Set();
}
```

- [ ] **Step 4: Run** — `npx vitest run test/grassField.test.ts`. Expected: 20 passed.

- [ ] **Step 5: Commit**

```bash
git add src/render/vehicle3d/grassField.ts test/grassField.test.ts
git commit -m "3D grass: patches round each hull under a blade budget, and the 2D hand-over rule"
```

---

### Task 6: GrassLayer (three.js)

**Files:**
- Create: `src/render/vehicle3d/grassPatch.ts`
- Modify: `src/render/vehicle3d/vehicleScene.ts` (owns the layer; `reset` clears it)
- Test: `test/grassLayer.test.ts`

**Interfaces:**
- Consumes: `BladeInst`, `BladeKind`, `MAX_BLADES` (Tasks 3–5).
- Produces: `bendPoint(h: number, angle: number): [number, number]`; `bladeGeometry(kind: BladeKind): BufferGeometry`; `patchBladeShader(shader: { vertexShader: string; fragmentShader: string }): void`; `class GrassLayer { readonly grass: InstancedMesh; readonly wheat: InstancedMesh; constructor(capacity?: number); update(blades: readonly BladeInst[]): void; clear(): void }`; `VehicleScene.grass: GrassLayer`.

- [ ] **Step 1: Write the failing test** — `test/grassLayer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InstancedBufferAttribute, Matrix4, ShaderLib, Vector3 } from 'three';
import { bendPoint, bladeGeometry, GrassLayer, patchBladeShader } from '@/render/vehicle3d/grassPatch';
import type { BladeInst } from '@/render/vehicle3d/grassField';
import { VehicleScene } from '@/render/vehicle3d/vehicleScene';

const inst = (over: Partial<BladeInst> = {}): BladeInst => ({ kind: 'grass', xM: 10, zM: 20, heightM: 0.8, widthM: 0.05, restAngle: 0.4, restDir: 0, colour: 0x5c6829,
  dirX: 1, dirZ: 0, angle: 0.5, heightScale: 1, fade: 0.75, ...over });

describe('blade bend (TS mirror of the shader)', () => {
  it('straight when unbent, an arc otherwise', () => {
    expect(bendPoint(1, 0)).toEqual([1, 0]);
    const [up, along] = bendPoint(1, Math.PI / 2);
    expect(up).toBeCloseTo(2 / Math.PI); expect(along).toBeCloseTo(2 / Math.PI);
    expect(bendPoint(1, 0.3)[1]).toBeCloseTo(0.149, 2);
  });
});

describe('blade geometry', () => {
  it('grass: a 3-segment tapered strip, base to tip, darker at the base', () => {
    const g = bladeGeometry('grass');
    expect(g.index!.count / 3).toBe(6);
    const y = g.getAttribute('position'), c = g.getAttribute('color');
    let minY = 1, maxY = 0;
    for (let i = 0; i < y.count; i++) { minY = Math.min(minY, y.getY(i)); maxY = Math.max(maxY, y.getY(i)); }
    expect(minY).toBe(0); expect(maxY).toBe(1);
    expect(c.getX(0)).toBeLessThan(c.getX(c.count - 1));
  });
  it('wheat: a stem with a wider, lighter ear on top', () => {
    const g = bladeGeometry('wheat'), p = g.getAttribute('position');
    let earHalf = 0, stemHalf = 0;
    for (let i = 0; i < p.count; i++) (p.getY(i) >= 0.85 ? (earHalf = Math.max(earHalf, Math.abs(p.getX(i)))) : (stemHalf = Math.max(stemHalf, Math.abs(p.getX(i)))));
    expect(earHalf).toBeGreaterThan(stemHalf);
  });
});

describe('blade shader patch', () => {
  it('the lambert chunks it hooks into exist in this three.js', () => {
    expect(ShaderLib.lambert.vertexShader).toContain('#include <begin_vertex>');
    expect(ShaderLib.lambert.vertexShader).toContain('#include <beginnormal_vertex>');
    expect(ShaderLib.lambert.fragmentShader).toContain('#include <clipping_planes_fragment>');
  });
  it('bends the vertices and dithers the fade', () => {
    const sh = { vertexShader: ShaderLib.lambert.vertexShader, fragmentShader: ShaderLib.lambert.fragmentShader };
    patchBladeShader(sh);
    expect(sh.vertexShader).toContain('aBendFade');
    expect(sh.vertexShader).not.toContain('#include <begin_vertex>');
    expect(sh.fragmentShader).toContain('discard');
  });
});

describe('GrassLayer', () => {
  it('places each blade at its spot, turned toward its bend, with its bend and fade', () => {
    const L = new GrassLayer(100);
    L.update([inst(), inst({ xM: 11 }), inst({ kind: 'wheat', heightM: 1.1 })]);
    expect(L.grass.count).toBe(2); expect(L.wheat.count).toBe(1);
    const m = new Matrix4(); L.grass.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixPosition(m).toArray()).toEqual([10, 0, 20]);
    const bendWay = new Vector3(0, 0, 1).transformDirection(m);
    expect(bendWay.x).toBeCloseTo(1); expect(bendWay.z).toBeCloseTo(0);   // local +z -> east
    const a = L.grass.geometry.getAttribute('aBendFade') as InstancedBufferAttribute;
    expect(a.getX(0)).toBeCloseTo(0.5); expect(a.getY(0)).toBeCloseTo(0.75);
  });
  it('never exceeds its capacity, and clears to nothing', () => {
    const L = new GrassLayer(2);
    L.update([inst(), inst(), inst(), inst()]);
    expect(L.grass.count).toBe(2);
    L.clear();
    expect(L.grass.count).toBe(0); expect(L.wheat.count).toBe(0);
  });
  it('lives in the vehicle scene; a new battle clears it', () => {
    const vs = new VehicleScene({ get: () => null });
    expect(vs.scene.children).toContain(vs.grass.grass);
    expect(vs.scene.children).toContain(vs.grass.wheat);
    vs.grass.update([inst()]);
    vs.reset();
    expect(vs.grass.grass.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/grassLayer.test.ts`. Expected: FAIL, cannot resolve `@/render/vehicle3d/grassPatch`.

- [ ] **Step 3: Implement** — `src/render/vehicle3d/grassPatch.ts`:

```ts
// ============================================================================
// The 3D grass on the GPU: one InstancedMesh of grass blades and one of wheat
// stalks, drawn in the vehicles' pass so the depth buffer sorts blades and
// hulls both ways. Each instance is a unit blade placed, turned toward its bend
// and scaled; the vertex shader bends it into an arc, the fragment shader
// dithers away the patch's fading edge (the 2x supersample smooths it).
// ============================================================================
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import { MAX_BLADES, type BladeInst, type BladeKind } from './grassField';

/** The shader's bend in TS: a unit-length blade bent into a circular arc of `angle` rad; returns
 * [up, along the bend] at fraction h of its length. */
export function bendPoint(h: number, angle: number): [number, number] {
  if (Math.abs(angle) < 1e-4) return [h, 0];
  return [Math.sin(angle * h) / angle, (1 - Math.cos(angle * h)) / angle];
}

/** A unit blade: width along x (centred), length along y 0..1, facing +z (the way it bends); the
 * vertex colour darkens the base and lightens the tip. */
export function bladeGeometry(kind: BladeKind): BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const shade = (h: number): number => 0.62 + 0.5 * h;
  const row = (h: number, half: number, k = shade(h)): number => {
    const i = pos.length / 3;
    pos.push(-half, h, 0, half, h, 0);
    col.push(k, k, k, k, k, k);
    return i;
  };
  const quad = (a: number, b: number): void => { idx.push(a, a + 1, b, a + 1, b + 1, b); };
  if (kind === 'grass') {
    const r = [row(0, 0.5), row(1 / 3, 0.4), row(2 / 3, 0.25), row(1, 0.04)];
    quad(r[0], r[1]); quad(r[1], r[2]); quad(r[2], r[3]);
  } else {
    const s = [row(0, 0.5), row(0.42, 0.45), row(0.85, 0.4)];
    quad(s[0], s[1]); quad(s[1], s[2]);
    // the ear: wider than the stem and one step lighter
    quad(row(0.85, 1.6, 1.25), row(1, 1.0, 1.3));
  }
  const g = new BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new Float32BufferAttribute(pos.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  return g;
}

/** Bends each vertex by its instance's aBendFade.x (bendPoint, in GLSL) and discards fragments by
 * an interleaved-gradient dither below aBendFade.y. */
export function patchBladeShader(sh: { vertexShader: string; fragmentShader: string }): void {
  sh.vertexShader = 'attribute vec2 aBendFade;\nvarying float vFade;\n' + sh.vertexShader
    .replace('#include <beginnormal_vertex>', 'float bendN = aBendFade.x * position.y;\nvec3 objectNormal = vec3(0.0, -sin(bendN), cos(bendN));')
    .replace('#include <begin_vertex>', [
      'float bendA = aBendFade.x;',
      'float bendUp = abs(bendA) < 1e-4 ? position.y : sin(bendA * position.y) / bendA;',
      'float bendAlong = abs(bendA) < 1e-4 ? 0.0 : (1.0 - cos(bendA * position.y)) / bendA;',
      'vec3 transformed = vec3(position.x, bendUp, bendAlong);',
      'vFade = aBendFade.y;',
    ].join('\n'));
  sh.fragmentShader = 'varying float vFade;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>', [
    '#include <clipping_planes_fragment>',
    'if (vFade < 1.0 && vFade <= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;',
  ].join('\n'));
}

function bladeMesh(kind: BladeKind, capacity: number): InstancedMesh {
  const g = bladeGeometry(kind);
  g.setAttribute('aBendFade', new InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
  const mat = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  mat.onBeforeCompile = patchBladeShader;
  const m = new InstancedMesh(g, mat, capacity);
  m.name = `grass3d_${kind}`;
  m.count = 0;
  m.frustumCulled = false;            // instances spread far beyond the unit blade's bounds
  m.receiveShadow = true;             // the hull's shadow falls on the blades
  m.setColorAt(0, new Color(1, 1, 1));
  return m;
}

const M = new Matrix4(), Q = new Quaternion(), P = new Vector3(), S = new Vector3(), UP = new Vector3(0, 1, 0), C = new Color();

export class GrassLayer {
  readonly grass: InstancedMesh;
  readonly wheat: InstancedMesh;

  constructor(private readonly capacity = MAX_BLADES) {
    this.grass = bladeMesh('grass', capacity);
    this.wheat = bladeMesh('wheat', capacity);
  }

  /** This frame's blades (bladesFor), past the capacity dropped. */
  update(blades: readonly BladeInst[]): void {
    const n = { grass: 0, wheat: 0 };
    for (const b of blades) {
      const mesh = b.kind === 'wheat' ? this.wheat : this.grass, i = n[b.kind];
      if (i >= this.capacity) continue;
      // local +z (the bend) turned onto (dirX, dirZ); y = length squashed by heightScale
      Q.setFromAxisAngle(UP, Math.atan2(b.dirX, b.dirZ));
      M.compose(P.set(b.xM, 0, b.zM), Q, S.set(b.widthM, b.heightM * b.heightScale, b.heightM));
      mesh.setMatrixAt(i, M);
      mesh.setColorAt(i, C.setHex(b.colour));
      (mesh.geometry.getAttribute('aBendFade') as InstancedBufferAttribute).setXY(i, b.angle, b.fade);
      n[b.kind] = i + 1;
    }
    for (const [mesh, count] of [[this.grass, n.grass], [this.wheat, n.wheat]] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.getAttribute('aBendFade').needsUpdate = true;
    }
  }

  clear(): void { this.grass.count = 0; this.wheat.count = 0; }
}
```

  In `src/render/vehicle3d/vehicleScene.ts`:
  - `import { GrassLayer } from './grassPatch';`
  - add the field `readonly grass = new GrassLayer();` next to `sun`;
  - in the constructor, after `this.scene.add(sun, …)`: `this.scene.add(this.grass.grass, this.grass.wheat);`
  - in `reset()`, add `this.grass.clear();` as the last line.

- [ ] **Step 4: Run** — `npx vitest run test/grassLayer.test.ts test/vehicle3dScene.test.ts`. Expected: all pass (grassLayer: 8). If `Vector3.transformDirection` on `m` includes the non-uniform scale, the normalised result still points east — the assertion holds.

- [ ] **Step 5: Commit**

```bash
git add src/render/vehicle3d/grassPatch.ts src/render/vehicle3d/vehicleScene.ts test/grassLayer.test.ts
git commit -m "3D grass on the GPU: instanced blades and stalks bent in the shader, dithered fade"
```

---

### Task 7: Wire it into the battle view

**Files:**
- Modify: `src/render/unitRender.ts` (`drawVehicles`, new export `vehiclesWithGrass3d`)
- Modify: `src/render/grassFx.ts` (`drawStanding` gains `skip`)
- Modify: `src/ui/screens/battle.ts:847`
- Test: `test/grassFx.test.ts` (append)

**Interfaces:**
- Consumes: `bladesFor`, `grassHandOver`, `HullPatch` (Task 5); `VehicleScene.grass` (Task 6); `crushMapFor` (Task 1); `tallGrowthAt`, `seasonKey` (`@/render/grassFx`).
- Produces: `vehiclesWithGrass3d(): ReadonlySet<number>` from `@/render/unitRender`; `GrassFx.drawStanding(ctx, cam, state, playerSide, skip?: ReadonlySet<number>)`.

- [ ] **Step 1: Write the failing test** — append to `test/grassFx.test.ts` (merge imports: `TILE_PX, VIEW_H, VIEW_W` from `@/shared/types`):

```ts
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
```

- [ ] **Step 2: Run** — `npx vitest run test/grassFx.test.ts`. Expected: FAIL — the second count is > 0 (the extra argument is ignored).

- [ ] **Step 3: Implement**
  - `src/render/grassFx.ts` `drawStanding`: signature becomes `drawStanding(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, skip: ReadonlySet<number> = NO_IDS): void`, with `const NO_IDS: ReadonlySet<number> = new Set();` at module level, and the first line inside the vehicle loop: `if (skip.has(v.id)) continue;   // the 3D grass stands round this one`. Update its doc comment: `/** Blades in front of everything standing in tall growth (vehicles in \`skip\` stand in the 3D grass instead). Draw after the units. */`.
  - `src/render/unitRender.ts`:
    - imports: `import { bladesFor, grassHandOver, type HullPatch } from '@/render/vehicle3d/grassField';`, `import { crushMapFor } from '@/render/grassCrush';`, `import { seasonKey, tallGrowthAt } from '@/render/grassFx';`; make sure `TILE_M`, `TILE_PX`, `VIEW_W`, `VIEW_H` and `VEHICLE_DEFS` are imported (add the missing ones to the existing import lines).
    - above `drawVehicles`:

```ts
let grass3d: ReadonlySet<number> = new Set();
/** Vehicles that stood in 3D grass in the last drawn frame: GrassFx.drawStanding skips their 2D fringe. */
export function vehiclesWithGrass3d(): ReadonlySet<number> { return grass3d; }

function hullPatch(veh: Vehicle, look: VehicleLook): HullPatch {
  const def = VEHICLE_DEFS[veh.defId];
  return { id: veh.id, xM: veh.pos.x * TILE_M, zM: veh.pos.y * TILE_M, facing: veh.hullFacing,
    halfLenM: (def?.lengthM ?? 6) / 2, halfWidM: (def?.widthM ?? 3) / 2, speedMs: look.ko ? 0 : veh.speed };
}
```

    - `drawVehicles` becomes (the overlay loop after it is unchanged):

```ts
function drawVehicles(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
  const gl = vehicles3d();
  const shown: { veh: Vehicle; look: VehicleLook }[] = [];
  const in3d: VehicleLook[] = [];
  const patches: HullPatch[] = [];
  grass3d = new Set();
  gl?.scene.begin();
  for (const veh of state.vehicles.values()) {
    if (!isEnemyVisible(state, playerSide, veh.side, veh.id, true)) continue;
    if (!visible(veh.pos, cam)) continue;
    const look = vehicleLook(veh, state);
    if (gl && gl.scene.add(look)) {
      in3d.push(look);
      if (tallGrowthAt(state, veh.pos)) patches.push(hullPatch(veh, look));
    } else drawVehicleLookSprite(ctx, cam, look);
    shown.push({ veh, look });
  }
  if (gl) {
    gl.scene.end();
    // the 3D grass round the hulls standing in tall growth, nearest the view centre first
    const ppt = TILE_PX * cam.zoom, crush = crushMapFor(state.map);
    const field = bladesFor(patches,
      (x, z) => tallGrowthAt(state, { x: x / TILE_M, y: z / TILE_M }),
      (x, z) => crush.at({ x: x / TILE_M, y: z / TILE_M }),
      seasonKey(state.map.def.season),
      (cam.x + VIEW_W / (2 * ppt)) * TILE_M, (cam.y + VIEW_H / (2 * ppt)) * TILE_M);
    gl.scene.grass.update(field.blades);
    // a lost context or a renderer failure mid-frame: this frame's 3D vehicles are drawn as sprites
    const ok = gl.out.draw(ctx, gl.scene, cam);
    if (!ok) for (const look of in3d) drawVehicleLookSprite(ctx, cam, look);
    grass3d = grassHandOver(patches.map((p) => p.id), field.dropped, ok);
  }
```

  - `src/ui/screens/battle.ts:847`: `this.grassFx.drawStanding(ctx, cam, state, battle.playerSide(), vehiclesWithGrass3d());` and add `vehiclesWithGrass3d` to the existing `@/render/unitRender` import (or a new import line if there is none).

- [ ] **Step 4: Run** — `npx vitest run test/grassFx.test.ts && npx tsc --noEmit && npx vitest run`. Expected: grassFx 5 passed; tsc clean; full suite green (1266 + the new tests, 2 skipped). If the full suite shows a failure, use superpowers:systematic-debugging before changing anything.

- [ ] **Step 5: Commit**

```bash
git add src/render/unitRender.ts src/render/grassFx.ts src/ui/screens/battle.ts test/grassFx.test.ts
git commit -m "Battle view: 3D grass round 3D vehicles in tall growth, the 2D fringe for the rest"
```

---

### Task 8: Visual check and frame cost

**Files:**
- Modify: `tools/vehicleBattle.ts` (`fill=` param; grass wakes and fringe drawn like the battle view)
- Scratch: a Playwright capture script in the session scratchpad (not committed)

**Interfaces:**
- Consumes: `GrassFx`, `vehiclesWithGrass3d` (Task 7).

- [ ] **Step 1: Add the preview hooks** — in `tools/vehicleBattle.ts`:
  - imports: `import { GrassFx } from '@/render/grassFx';` and add `vehiclesWithGrass3d` to the `@/render/unitRender` import.
  - after `battle.start();`:

```ts
// fill=tallgrass|crops: every open/grass tile becomes that growth (3D grass check)
const fill = q.get('fill');
if (fill === 'tallgrass' || fill === 'crops') {
  const tiles = battle.state.map.tiles;
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === 'open' || tiles[i] === 'grass') tiles[i] = fill;
}
const grassFx = new GrassFx();
```

  - the step loop becomes `for (let i = 0; i < steps && battle.state.phase === 'running'; i++) { battle.step(SIM_DT); grassFx.update(battle.state, 'german'); }`
  - `frame` becomes:

```ts
  const frame = (): void => {
    terrain.draw(ctx, cam);
    terrain.drawOverlays(ctx, cam, state);
    grassFx.drawTrails(ctx, cam);
    drawUnits(ctx, cam, state, focus?.side ?? 'german', [], settings);
    grassFx.drawStanding(ctx, cam, state, focus?.side ?? 'german', vehiclesWithGrass3d());
    drawEffects(ctx, cam, state);
  };
```

  Run `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 2: Capture** — find a winter map: `grep -ln "season: 'winter'" src/data/maps/*.ts` (use its id; if none exists, capture summer and autumn and say so). With the dev server running (`http://localhost:5173/`, restart vite first — see the headless-capture memory), write a Playwright script in the scratchpad that, for each combination of `fill ∈ {tallgrass, crops}`, `t ∈ {0 (parked), 25 (driving)}`, `zoom ∈ {1, 2}`, renderer `∈ {3D (default), ?vehicles=sprites}`, and the summer map plus the winter map, opens `/tools/vehicleBattle.html?map=<id>&fill=<f>&t=<t>&zoom=<z>[&vehicles=sprites]`, waits for `window.__vbReady` plus 3 s (terrain bake), and saves `canvas#game.toDataURL()` as PNG. Use Chromium from `~/Library/Caches/ms-playwright/chromium-1234` as `executablePath`.

- [ ] **Step 3: Look** — open the zoom-2 3D vs sprite pairs (Read the PNGs). Check against the spec's success line: blades in front of the hull cover its lower part, blades behind are hidden by it, a parked hull visibly parts the growth, a driving hull's wake lies flat behind it with no standing strip at the tail, and no edge is visible where the patch meets the painted field. Wheat must read as wheat (straight, ears), winter as dry pale stalks. Any failure: fix with a test first (superpowers:test-driven-development), re-capture.

- [ ] **Step 4: Frame cost** — in the same script, on `?fill=tallgrass&t=25&zoom=1` and on the same URL without `fill`, call `window.__vbUnitsMs(30)` three times each and take the medians. Acceptance: the `fill` median is at most 6 ms above the no-fill median. Record both numbers for the report; if over, note it as a finding for the final review (it does not block).

- [ ] **Step 5: Commit**

```bash
git add tools/vehicleBattle.ts
git commit -m "vehicleBattle preview: fill= tall growth, grass wakes and fringe as in battle"
```

  Then show the user the zoom-2 before/after captures (grass parked, grass driving, wheat driving, winter) and the frame-cost numbers.
