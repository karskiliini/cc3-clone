// Item 038 regression: armoured engagements fizzle — vehicles never re-acquire and the AI
// drives them blind.
//
// Covered here:
//  - the hull-down model: the commander's eye (2.2 m) sees over a crest the main gun's muzzle
//    (1.5 m) cannot, so the tank creeps forward until the gun clears and only then fires;
//  - the belief-aim continuation: a lost target keeps its lay on the last-known aim;
//  - a seeded AI-vs-AI armour battle produces ongoing main-gun exchanges.
import { describe, it, expect } from 'vitest';
import { makeState, addTank } from './vehicleDamageHelpers';
import { stepCombat, pickVehicleTarget, vehicleAreaTarget } from '@/sim/combat';
import { stepVehicles } from '@/sim/vehicle';
import { hasLOS, hasLineOfFire, EYE_VEHICLE_M, VEHICLE_GUN_M } from '@/sim/los';
import { Battle } from '@/sim/battle';
import { DEFAULT_FORCES } from '@/data/operation';
import { Rng } from '@/shared/rng';
import type { BattleConfig, BattleState, Vehicle } from '@/shared/types';

const W = 400, H = 400;

/** A 2.0 m crest across x=20..21 (the hull-down profile). `slope` gives the flank rise in m/tile
 * (0.4 = grade 0.2, climbable; 0.8 = grade 0.4, steeper than the 25% vehicle limit); 'cliff'
 * drops 2 m on both faces so the tank can never mount the crest. Computes `groundSteep` so
 * vehicle movement honours the grade. */
function withCrest(state: BattleState, shape: 'slope' | 'cliff', slope = 0.4): void {
  const ground = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let h = 0;
      if (shape === 'cliff') {
        if (x === 20 || x === 21) h = 2.0;
      } else {
        if (x >= 20 && x <= 21) h = 2.0;
        else if (x >= 22 && x <= 25) h = 2.0 - (x - 21) * slope;
        else if (x >= 16 && x <= 19) h = (x - 15) * slope;
      }
      ground[y * W + x] = Math.max(0, h);
    }
  }
  const steep = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const h = ground[i];
      let m = 0;
      if (x > 0) m = Math.max(m, Math.abs(ground[i - 1] - h));
      if (x < W - 1) m = Math.max(m, Math.abs(ground[i + 1] - h));
      if (y > 0) m = Math.max(m, Math.abs(ground[i - W] - h));
      if (y < H - 1) m = Math.max(m, Math.abs(ground[i + W] - h));
      steep[i] = m / 2; // TILE_M = 2 m: rise/run per tile
    }
  }
  (state.map as unknown as { ground: Float32Array; groundSteep: Float32Array }).ground = ground;
  (state.map as unknown as { ground: Float32Array; groundSteep: Float32Array }).groundSteep = steep;
}

/** A T-34 west of a 2.0 m crest, a Pz III J east of it; both have fresh beliefs and spots. */
function hullDownScene(shape: 'slope' | 'cliff' = 'slope', slope = 0.4): { state: BattleState; own: Vehicle; enemy: Vehicle } {
  const state = makeState(1941);
  withCrest(state, shape, slope);
  const own = addTank(state, 't34_76', { x: 12.5, y: 200.5 });
  const enemy = addTank(state, 'pz3j', { x: 30.5, y: 200.5 }, 180, 50, 'german');
  own.crew[0].mind.beliefs.push({ pos: { ...enemy.v.pos }, kind: 'seen', confidence: 1, count: 3, time: state.time, deadSeen: 0 });
  enemy.crew[0].mind.beliefs.push({ pos: { ...own.v.pos }, kind: 'seen', confidence: 1, count: 3, time: state.time, deadSeen: 0 });
  state.spottedVehicles.soviet.add(enemy.v.id);
  state.spottedVehicles.german.add(own.v.id);
  return { state, own: own.v, enemy: enemy.v };
}

describe('item 038 — hull-down: eye over the crest, gun line below it', () => {
  it('the eye sees over a 2.0 m crest the 1.5 m muzzle cannot', () => {
    const { state } = hullDownScene();
    const from = { x: 12.5, y: 200.5 }, to = { x: 30.5, y: 200.5 };
    expect(hasLOS(state.map, from, to, { eyeM: EYE_VEHICLE_M })).toBe(true);
    expect(hasLineOfFire(state.map, from, to, { eyeM: EYE_VEHICLE_M })).toBe(true);
    expect(hasLineOfFire(state.map, from, to, { eyeM: VEHICLE_GUN_M })).toBe(false);
  });

  it('a hull-down tank lays on the visible target but holds fire, creeps out, then fires', () => {
    const { state, own } = hullDownScene();
    const rng = new Rng(4);
    let firedAt = -1;
    let creptAt = -1;
    const startX = own.pos.x;
    for (let i = 0; i < 120; i++) {
      stepVehicles(state, rng, 0.25);
      stepCombat(state, rng, 0.25);
      state.time += 0.25;
      if (creptAt < 0 && own.creepForGun) creptAt = state.time;
      const shot = state.events.find((e) => e.kind === 'shot' && (e as { weaponId?: string }).weaponId === 'f34_76' && (e as { side?: string }).side === 'soviet');
      if (shot && firedAt < 0) firedAt = state.time;
      state.events.length = 0;
      if (firedAt > 0) break;
    }
    expect(creptAt, 'hull-down tank must set the creep flag before firing').toBeGreaterThan(0);
    expect(creptAt, 'creep must set while the gun line is still blocked (no shot yet)').toBeLessThan(firedAt);
    expect(own.pos.x, 'tank creeps forward toward the crest').toBeGreaterThan(startX);
    expect(firedAt, 'gun fires once the muzzle clears the crest').toBeGreaterThan(0);
  });

  it('a tank facing an unclimbable crest never fires from hull-down once the creep lapses', () => {
    const { state, own } = hullDownScene('cliff');
    const rng = new Rng(4);
    let fired = false;
    let creepSeen = false;
    for (let i = 0; i < 200; i++) {
      stepVehicles(state, rng, 0.25);
      stepCombat(state, rng, 0.25);
      state.time += 0.25;
      if (own.creepForGun) creepSeen = true;
      for (const e of state.events) if ((e as { weaponId?: string }).weaponId === 'f34_76') fired = true;
      state.events.length = 0;
    }
    expect(creepSeen, 'the blocked muzzle is noticed').toBe(true);
    expect(fired, 'the gun never fires while the muzzle stays blocked').toBe(false);
  });
});

describe('item 038 — the belief-aim continuation', () => {
  it('a vehicle whose sight is lost keeps its lay on the last-known belief position', () => {
    const state = makeState(1941);
    const own = addTank(state, 't34_76', { x: 200.5, y: 200.5 });
    const enemy = addTank(state, 'pz3j', { x: 230.5, y: 200.5 }, 180, 50, 'german');
    // fresh belief of the enemy (a team sighting shared to this tank's commander)
    own.crew[0].mind.beliefs.push({ pos: { ...enemy.v.pos }, kind: 'seen', confidence: 0.9, count: 3, time: state.time, deadSeen: 0 });
    const t = vehicleAreaTarget(state, own.v, 400);
    expect(t && t.kind === 'point' ? t : null).not.toBeNull();
    if (t && t.kind === 'point') {
      expect(t.pos.x).toBeCloseTo(230.5, 5);
      expect(t.pos.y).toBeCloseTo(200.5, 5);
    }
    // the belief decays: past the 30 s window the lay is deliberately dropped
    state.time = 45;
    expect(vehicleAreaTarget(state, own.v, 400)).toBeNull();
  });

  it('pickVehicleTarget returns the belief point when nothing is visibly spotted', () => {
    const state = makeState(1941);
    const own = addTank(state, 't34_76', { x: 200.5, y: 200.5 });
    const enemy = addTank(state, 'pz3j', { x: 230.5, y: 200.5 }, 180, 50, 'german');
    state.spottedVehicles.soviet.clear();
    own.crew[0].mind.beliefs.push({ pos: { ...enemy.v.pos }, kind: 'seen', confidence: 0.9, count: 3, time: state.time, deadSeen: 0 });
    expect(pickVehicleTarget(state, own.v)!.kind).toBe('point');
  });
});

describe('item 038 — seeded armour exchange (moscow_1941, seed 9)', () => {
  it('main guns exchange rounds across a 300 s AI-vs-AI battle', () => {
    const config: BattleConfig = {
      mapId: 'moscow_1941', playerSide: 'german', year: 1941, seed: 9, durationS: 300,
      difficulty: 'normal', aiBothSides: true,
      forces: { german: DEFAULT_FORCES[1941].german, soviet: DEFAULT_FORCES[1941].soviet },
    };
    const battle = new Battle(config);
    battle.start();
    const MAIN = new Set(['kwk39_50', 'kwk37_75', 'kv_zis5', '45mm_20k', 'pak38', 'pak36', 'zis3_76', 'f34_76']);
    const bySide = { german: 0, soviet: 0 };
    for (let i = 0; i < 300; i++) {
      battle.step(1);
      for (const e of battle.drainEvents()) {
        const ev = e as { kind: string; weaponId?: string; side?: string };
        if (ev.kind !== 'shot' || !ev.weaponId || !MAIN.has(ev.weaponId)) continue;
        if (ev.side === 'german') bySide.german++;
        else if (ev.side === 'soviet') bySide.soviet++;
      }
    }
    const total = bySide.german + bySide.soviet;
    expect(total, `ongoing exchanges: ${total} main-gun rounds in 300 s`).toBeGreaterThanOrEqual(10);
    expect(bySide.german).toBeGreaterThanOrEqual(1);
    expect(bySide.soviet).toBeGreaterThanOrEqual(1);
  }, 120000);
});
