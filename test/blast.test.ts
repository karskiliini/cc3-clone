// Spec 2026-09-17 §4, sim side: blast record, knockback (scaled by force, blocked by walls), and
// the knock-down stun that keeps a survivor from acting. Deterministic (seeded Rng only).
import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Terrain, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { applyBlastKnockback, applyHESplash, blastForce, isStunned, stepCombat } from '@/sim/combat';
import { stepMovement } from '@/sim/movement';
import { createMind } from '@/sim/mind';

function makeSoldier(o: Partial<Soldier> = {}): Soldier {
  return {
    id: 1, teamId: 1, side: 'soviet', name: 'T', rank: 'Pvt', weaponId: 'mosin', ammo: 5, ammoReserve: 20, grenades: 2,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos: { x: 10.5, y: 10.5 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [],
    reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null, formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(50), ...o,
  };
}
function makeState(): BattleState {
  const W = 24, H = 24;
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer', paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 18, y: 18, w: 5, h: 5 } }, attacker: 'german',
  };
  const map: GameMap = {
    def, width: W, height: H, tiles, buildingId: new Int16Array(W * H).fill(-1), windows: new Uint8Array(W * H),
    victoryLocations: [], smoke: new Float32Array(W * H), craters: [],
  };
  const config: BattleConfig = { mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } };
  return {
    config, map, phase: 'running', time: 10, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [], result: null, events: [], nextId: 10,
  };
}
const mortar: WeaponDef = {
  id: 'mortar81', name: '8cm', cls: 'mortar', rangeM: 1000, rate: 0.15, burst: 1, accuracy: 0.15, lethality: 0, suppression: 0.6,
  penetrationMm: 0, heRadiusM: 6, ammo: 3, reloadS: 8,
};
const grenade: WeaponDef = { ...mortar, id: 'grenade', cls: 'grenade', heRadiusM: 3 };

describe('blast knockback', () => {
  it('force falls off with distance and scales with the explosive', () => {
    expect(blastForce(mortar, 0.5)).toBeGreaterThan(blastForce(mortar, 2));
    expect(blastForce(mortar, 1)).toBeGreaterThan(blastForce(grenade, 1));
    expect(blastForce(mortar, mortar.heRadiusM / TILE_M + 0.1)).toBe(0);
  });

  it('throws a man 1-15 m straight away from the burst, further for a closer / bigger burst, and records the blast', () => {
    const throwOf = (w: WeaponDef, dTiles: number) => {
      const state = makeState();
      const s = makeSoldier({ pos: { x: 10.5 + dTiles, y: 10.5 } });
      state.soldiers.set(s.id, s);
      applyBlastKnockback(state, new Rng(3), s, { x: 10.5, y: 10.5 }, w);
      expect(s.pos.y).toBeCloseTo(10.5, 6);            // straight away: along +x only
      expect(s.blast).toBeDefined();
      expect(s.blast!.origin).toEqual({ x: 10.5 + dTiles, y: 10.5 });
      expect(s.blast!.from).toEqual({ x: 10.5, y: 10.5 });
      expect(s.blast!.time).toBe(10);
      return (s.pos.x - (10.5 + dTiles)) * TILE_M;
    };
    const near = throwOf(mortar, 0.5), far = throwOf(mortar, 2), small = throwOf(grenade, 0.5);
    for (const m of [near, far, small]) { expect(m).toBeGreaterThanOrEqual(1 - 1e-6); expect(m).toBeLessThanOrEqual(15 + 1e-6); }
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(small);
  });

  it('is blocked by a wall: never through it, stops at the last passable point', () => {
    const state = makeState();
    for (let y = 0; y < 24; y++) state.map.tiles[y * 24 + 12] = 'stonewall';
    const s = makeSoldier({ pos: { x: 11.6, y: 10.5 } });
    state.soldiers.set(s.id, s);
    applyBlastKnockback(state, new Rng(3), s, { x: 11.0, y: 10.5 }, mortar);
    expect(s.pos.x).toBeLessThan(12);
    expect(s.pos.x).toBeGreaterThanOrEqual(11.6);
    // the same blast in the open throws him well past where the wall stood
    const open = makeState();
    const t = makeSoldier({ pos: { x: 11.6, y: 10.5 } });
    open.soldiers.set(t.id, t);
    applyBlastKnockback(open, new Rng(3), t, { x: 11.0, y: 10.5 }, mortar);
    expect(t.pos.x).toBeGreaterThan(12);
  });

  it('knocks down survivors in the inner half of the radius only; a stunned man cannot move, fire or throw', () => {
    const state = makeState();
    const inner = makeSoldier({ id: 1, pos: { x: 11, y: 10.5 }, path: [{ x: 20, y: 10 }], activity: 'moving' });
    // no grenades for the bystanders: a grenade thrown at the nearby enemy would (rightly) throw the stunned man again
    const outer = makeSoldier({ id: 2, grenades: 0, pos: { x: 12.8, y: 10.5 } });
    state.soldiers.set(1, inner); state.soldiers.set(2, outer);
    const stress0 = inner.mind.stress;
    applyHESplash(state, new Rng(5), { x: 10.5, y: 10.5 }, mortar, 'german'); // lethality 0: both survive
    expect(inner.health).toBe('healthy');
    expect(inner.stunnedUntil).toBeGreaterThanOrEqual(state.time + 1.5);
    expect(inner.stunnedUntil).toBeLessThanOrEqual(state.time + 4);
    expect(inner.stance).toBe('prone');
    expect(inner.path.length).toBe(0);
    expect(inner.mind.stress).toBeGreaterThan(stress0);
    expect(outer.stunnedUntil).toBeUndefined();
    expect(outer.blast).toBeDefined();
    expect(isStunned(inner, state.time)).toBe(true);

    // give him a path and an enemy in plain view: while stunned he neither moves nor fires
    // no grenades: a grenade landing on the stunned man would (rightly) throw him again
    const enemy = makeSoldier({ id: 3, side: 'german', weaponId: 'kar98k', grenades: 0, pos: { x: 16, y: 10.5 } });
    state.soldiers.set(3, enemy);
    state.spotted.soviet.add(3);
    inner.path = [{ x: 20, y: 10.5 }];
    inner.targetSoldierId = 3;
    const before = { ...inner.pos };
    const rng = new Rng(9);
    for (let i = 0; i < 10; i++) { stepMovement(state, rng, 0.1); stepCombat(state, rng, 0.1); state.time += 0.1; }
    expect(inner.pos).toEqual(before);
    expect(inner.lastFiredAt).toBe(-999);
    expect(inner.grenades).toBe(2);
    expect(isStunned(inner, inner.stunnedUntil! + 0.01)).toBe(false);
  });

  it('green and wounded men stay down longer; same seed => same result', () => {
    const run = (o: Partial<Soldier>) => {
      const state = makeState();
      const s = makeSoldier({ pos: { x: 11, y: 10.5 }, ...o });
      state.soldiers.set(s.id, s);
      applyBlastKnockback(state, new Rng(11), s, { x: 10.5, y: 10.5 }, mortar);
      return { stun: s.stunnedUntil! - state.time, x: s.pos.x };
    };
    expect(run({ experience: 20 }).stun).toBeGreaterThan(run({ experience: 60 }).stun);
    expect(run({ health: 'wounded' }).stun).toBeGreaterThan(run({}).stun);
    expect(run({})).toEqual(run({}));
  });
});
