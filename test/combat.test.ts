import { describe, it, expect } from 'vitest';
import type { Soldier, WeaponDef } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { hitChance, penetrates, applyHESplash, applyHit, getSmallArmsStats, stepCombat } from '@/sim/combat';
import type { BattleConfig, BattleState, GameMap, MapDef, Team, Terrain } from '@/shared/types';
import { createMind } from '@/sim/mind';

function makeSoldier(overrides: Partial<Soldier> = {}): Soldier {
  return {
    id: 1,
    teamId: 1,
    side: 'german',
    name: 'Test',
    rank: 'Gefr',
    weaponId: 'kar98k',
    ammo: 5,
    ammoReserve: 20,
    grenades: 0,
    health: 'healthy',
    morale: 80,
    fatigue: 0,
    suppression: 0,
    experience: 50,
    stance: 'standing',
    activity: 'defending',
    pos: { x: 0, y: 0 },
    facing: 0,
    targetSoldierId: null,
    targetVehicleId: null,
    targetPoint: null,
    path: [],
    reloadTimer: 0,
    fireTimer: 0,
    animFrame: 0,
    isLeader: false,
    vehicleId: null,
    formationOffset: { x: 0, y: 0 },
    lastFiredAt: -999,
    cover: 0,
    kills: 0,
    mind: createMind(50),
    ...overrides,
  };
}

const rifle: WeaponDef = {
  id: 'kar98k', name: 'Kar98k', cls: 'rifle', rangeM: 400, rate: 0.4, burst: 1,
  accuracy: 0.35, lethality: 0.55, suppression: 0.15, penetrationMm: 0, heRadiusM: 0,
  ammo: 5, reloadS: 3,
};

const kwk40_75: WeaponDef = {
  id: 'kwk40_75', name: '7.5cm KwK 40', cls: 'tankgun', rangeM: 1400, rate: 0.4, burst: 1,
  accuracy: 0.55, lethality: 0.75, suppression: 0.35, penetrationMm: 110, heRadiusM: 4,
  ammo: 87, reloadS: 3,
};

describe('hitChance', () => {
  it('decreases with distance', () => {
    const shooter = makeSoldier();
    const near = hitChance(rifle, 50, 0, 'standing', shooter, false);
    const far = hitChance(rifle, 350, 0, 'standing', shooter, false);
    expect(far).toBeLessThan(near);
  });

  it('decreases with target cover', () => {
    const shooter = makeSoldier();
    const noCover = hitChance(rifle, 100, 0, 'standing', shooter, false);
    const withCover = hitChance(rifle, 100, 0.8, 'standing', shooter, false);
    expect(withCover).toBeLessThan(noCover);
  });

  it('decreases when target is prone vs standing', () => {
    const shooter = makeSoldier();
    const standing = hitChance(rifle, 100, 0, 'standing', shooter, false);
    const prone = hitChance(rifle, 100, 0, 'prone', shooter, false);
    expect(prone).toBeLessThan(standing);
  });

  it('is 0 beyond weapon range', () => {
    const shooter = makeSoldier();
    expect(hitChance(rifle, 500, 0, 'standing', shooter, false)).toBe(0);
  });
});

describe('penetrates', () => {
  it('kwk40_75 penetrates 45mm at 500m', () => {
    const rng = new Rng(42);
    expect(penetrates(kwk40_75, 500, 45, rng)).toBe(true);
  });

  it('kwk40_75 does not penetrate 100mm at 1000m', () => {
    const rng = new Rng(42);
    expect(penetrates(kwk40_75, 1000, 100, rng)).toBe(false);
  });
});

describe('applyHESplash', () => {
  const heWeapon: WeaponDef = { ...kwk40_75, heRadiusM: 4 };

  function makeState(): BattleState {
    const W = 20, H = 20;
    const tiles: Terrain[] = new Array(W * H).fill('open');
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
    };
  }

  it('does not roll casualties/suppression against vehicle crew at the impact point (armor protects them)', () => {
    // Regression: fireAtVehicle used to call applyHESplash unconditionally, even when the shell
    // failed to penetrate — and applyHESplash treated crew (whose pos == the vehicle's pos, with
    // cover effectively 0) exactly like exposed infantry, giving free casualty rolls and heavy
    // suppression on every non-penetrating hit against the vehicle they were riding in.
    const state = makeState();
    const crew = makeSoldier({ id: 1, side: 'soviet', pos: { x: 10, y: 10 }, vehicleId: 42 });
    state.soldiers.set(crew.id, crew);
    const rng = new Rng(7);
    applyHESplash(state, rng, { x: 10, y: 10 }, heWeapon, 'german');
    expect(crew.health).toBe('healthy');
    expect(crew.suppression).toBe(0);
  });

  it('still rolls casualties/suppression against exposed infantry near the impact point', () => {
    const state = makeState();
    const infantry = makeSoldier({ id: 2, side: 'soviet', pos: { x: 10, y: 10 }, vehicleId: null });
    state.soldiers.set(infantry.id, infantry);
    const rng = new Rng(7);
    applyHESplash(state, rng, { x: 10, y: 10 }, heWeapon, 'german');
    // With this seed/weapon at distance 0 the soldier must be hit or at least suppressed.
    expect(infantry.health !== 'healthy' || infantry.suppression > 0).toBe(true);
  });

  function makeTeam(id: number, side: 'german' | 'soviet', soldierIds: number[]): Team {
    return {
      id, defId: 'test', side, name: 'Test Squad', type: 'rifle', soldierIds, leaderId: soldierIds[0],
      vehicleId: null, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle',
      pos: { x: 0, y: 0 }, outOfAction: false, kills: 0, aiObjective: null,
    };
  }

  it('a heavily suppressed soldier (>85) does not return fire (balance round 4)', () => {
    const state = makeState();
    const shooter = makeSoldier({ id: 1, side: 'german', pos: { x: 5, y: 5 }, suppression: 90 });
    const enemy = makeSoldier({ id: 2, side: 'soviet', pos: { x: 6, y: 5 } });
    state.soldiers.set(shooter.id, shooter);
    state.soldiers.set(enemy.id, enemy);
    state.teams.set(1, makeTeam(1, 'german', [shooter.id]));
    state.spotted.german.add(enemy.id);

    const rng = new Rng(1);
    for (let i = 0; i < 50; i++) stepCombat(state, rng, 0.1);
    expect(getSmallArmsStats(state).fired).toBe(0);
    expect(shooter.ammo).toBe(5); // unchanged — never fired
  });

  it('a moderately suppressed soldier (>60) fires at a reduced rate, not the full rate (balance round 4)', () => {
    const withSuppression = (suppression: number): number => {
      const state = makeState();
      const shooter = makeSoldier({ id: 1, side: 'german', pos: { x: 5, y: 5 }, suppression });
      const enemy = makeSoldier({ id: 2, side: 'soviet', pos: { x: 6, y: 5 } });
      state.soldiers.set(shooter.id, shooter);
      state.soldiers.set(enemy.id, enemy);
      state.teams.set(1, makeTeam(1, 'german', [shooter.id]));
      state.spotted.german.add(enemy.id);
      const rng = new Rng(3);
      let fired = 0;
      for (let i = 0; i < 200; i++) {
        const before = getSmallArmsStats(state).fired;
        stepCombat(state, rng, 0.1);
        if (getSmallArmsStats(state).fired > before) fired++;
        // This measures fire RATE, not lethality: keep the target alive (a dead/incapacitated
        // enemy is correctly excluded from targeting since the combat.ts regression fix — without
        // this reset the run would end early the moment the enemy goes down, which is a lethality
        // artifact of this seed, not a suppression-rate effect).
        if (enemy.health !== 'healthy') { enemy.health = 'healthy'; enemy.activity = 'defending'; }
      }
      return fired;
    };
    const suppressedFires = withSuppression(70);
    const calmFires = withSuppression(0);
    expect(suppressedFires).toBeLessThan(calmFires);
  });

  it('never fires the kill event/message/kill-count twice for one soldier (regression)', () => {
    // Regression: the same "has been killed" message and kill event used to fire twice for one
    // soldier because an already-incapacitated victim stayed targetable and applyHit re-rolled a
    // fresh outcome (and re-pushed the kill event / incremented kills again) on a later shot that
    // landed on the same, already-down body.
    const state = makeState();
    const killer = makeSoldier({ id: 1, side: 'german' });
    const victim = makeSoldier({ id: 2, side: 'soviet' });
    state.soldiers.set(killer.id, killer);
    state.soldiers.set(victim.id, victim);
    const weapon: WeaponDef = {
      id: 'test_gun', name: 'Test Gun', cls: 'rifle', rangeM: 400, rate: 1, burst: 1,
      accuracy: 1, lethality: 1, suppression: 0.2, penetrationMm: 0, heRadiusM: 0, ammo: 5, reloadS: 1,
    };
    const rng = new Rng(1);
    applyHit(state, victim, weapon, rng, 'german', killer);
    expect(victim.health).not.toBe('healthy');
    const killsAfterFirst = killer.kills;
    const koEventsAfterFirst = state.events.filter((e) => e.kind === 'kill').length;

    // A second shot lands on the same, already-down body.
    applyHit(state, victim, weapon, rng, 'german', killer);
    expect(killer.kills).toBe(killsAfterFirst);
    expect(state.events.filter((e) => e.kind === 'kill').length).toBe(koEventsAfterFirst);
  });

  it('excludes an incapacitated soldier from target selection', () => {
    const state = makeState();
    const shooter = makeSoldier({ id: 1, side: 'german', pos: { x: 5, y: 5 } });
    const downed = makeSoldier({ id: 2, side: 'soviet', pos: { x: 6, y: 5 }, health: 'incapacitated', activity: 'incapacitated' });
    const other = makeSoldier({ id: 3, side: 'soviet', pos: { x: 20, y: 20 } }); // out of range/LOS-irrelevant here
    state.soldiers.set(shooter.id, shooter);
    state.soldiers.set(downed.id, downed);
    state.soldiers.set(other.id, other);
    state.teams.set(1, makeTeam(1, 'german', [shooter.id]));
    state.spotted.german.add(downed.id);
    state.spotted.german.add(other.id);

    const rng = new Rng(1);
    for (let i = 0; i < 10; i++) stepCombat(state, rng, 0.1);
    // The shooter must never have fired at the downed soldier specifically (it is not a valid
    // candidate at all) — the only way `fired` can be > 0 here is by targeting `other`, which is
    // far enough that this loop shouldn't reach it either at rate 0.4/s within 1s; assert instead
    // that downed's health/activity never changed (i.e. it was never re-resolved as a target).
    expect(downed.health).toBe('incapacitated');
  });
});
