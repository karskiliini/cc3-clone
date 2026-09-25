import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, CrewWeaponState, GameMap, MapDef, Soldier, Team, Terrain } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind, stepMinds } from '@/sim/mind';
import { VEHICLE_DEFS } from '@/data/units';

const W = 30, H = 30;

function makeMap(): GameMap {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {},
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 25, y: 25, w: 5, h: 5 } },
    attacker: 'german',
  };
  return {
    def, width: W, height: H, tiles,
    buildingId: new Int16Array(W * H).fill(-1),
    windows: new Uint8Array(W * H),
    victoryLocations: [],
    smoke: new Float32Array(W * H),
    craters: [],
  };
}

function makeSoldier(id: number, teamId: number, side: 'german' | 'soviet', overrides: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side, name: `S${id}`, rank: 'Gefr', weaponId: 'kar98k',
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos: { x: 5, y: 5 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: id === 1, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(50),
    ...overrides,
  };
}

function makeState(): BattleState {
  const map = makeMap();
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

const DT = 0.25;

function run(s: BattleState, seconds: number): void {
  const rng = new Rng(7);
  for (let t = 0; t < seconds; t += DT) {
    s.time += DT;
    stepMinds(s, rng, DT);
  }
}

describe('item 039: broken men recover once the fight moves away (moraleRecovery)', () => {
  // Item 039 regression: routed AT-gun survivors fell morale 71→0 by t=34 and stayed broken to the
  // battle's end because (1) a stale belief held mind.threatLevel at the 0.4 floor forever — the
  // stress decay sat at 3/s instead of 6/s and the fear never cleared 60 — and (2) shareBeliefs
  // re-shared that belief every 2 s, refreshing its `time` through addOrMergeBelief, so the floor
  // never aged out. Broken→panicked recovery needs morale ≥ 35 and the morale only climbs while
  // fear < 20: with fear pinned high the ratchet never opened.

  it('stale belief stops holding the threat floor: fear drains, morale recovers, state climbs out of broken', () => {
    const stale = makeState();
    const man = makeSoldier(1, 1, 'german', {
      morale: 0, activity: 'routed',
    });
    man.mind.state = 'broken';
    man.mind.stress = 60;
    man.mind.threatLevel = 0.4;
    // the sighting is 70 s old when the battle record starts: the fight is long gone
    man.mind.beliefs = [{ pos: { x: 12, y: 12 }, count: 1, confidence: 0.9, kind: 'seen', time: -70, deadSeen: 0 }];
    stale.soldiers.set(1, man);
    const team: Team = {
      id: 1, defId: 'test_team', side: 'german', name: 'Rifle Squad', type: 'rifle',
      soldierIds: [1], leaderId: 1, vehicleId: null, order: null, facing: 0,
      experience: 50, morale: 20, status: 'Routed', pos: { x: 5, y: 5 }, outOfAction: false,
      kills: 0, aiObjective: null,
    };
    stale.teams.set(1, team);

    // fresh-belief control: the same man with a just-sighted enemy keeps the 0.4 threat floor,
    // so his stress decays at 3/s instead of 6/s while the floor is up
    const fresh = makeState();
    const freshMan = makeSoldier(1, 1, 'german', { morale: 0, activity: 'routed' });
    freshMan.mind = { ...man.mind };
    freshMan.mind.beliefs = [{ pos: { x: 12, y: 12 }, count: 1, confidence: 0.9, kind: 'seen', time: 0, deadSeen: 0 }];
    fresh.soldiers.set(1, freshMan);
    const freshTeam: Team = { ...team, morale: 20, status: 'Routed' };
    fresh.teams.set(1, freshTeam);

    const rngA = new Rng(7);
    const rngB = new Rng(7);
    for (let t = 0; t < 10; t += DT) {
      stale.time += DT; stepMinds(stale, rngA, DT);
      fresh.time += DT; stepMinds(fresh, rngB, DT);
    }
    // differential: the stale report does not hold the threat up, so the stress drains twice as
    // fast with no incoming fire (item 039)
    expect(man.mind.stress).toBeLessThan(freshMan.mind.stress);

    run(stale, 230);

    expect(man.mind.threatLevel).toBeLessThan(0.3);
    expect(['panicked', 'cowering', 'pinned', 'shaken', 'wary', 'alert', 'calm']).toContain(man.mind.state);
    expect(man.morale).toBeGreaterThanOrEqual(35);
  });

  it('a re-shared reported belief does not refresh the sighting age', () => {
    const s = makeState();
    const reporter = makeSoldier(1, 1, 'german');
    const receiver = makeSoldier(2, 1, 'german');
    receiver.pos = { x: 6, y: 6 };
    reporter.mind.beliefs = [{ pos: { x: 12, y: 12 }, count: 1, confidence: 1.0, kind: 'seen', time: 40, deadSeen: 0 }];
    s.soldiers.set(1, reporter);
    s.soldiers.set(2, receiver);
    const team: Team = {
      id: 1, defId: 'test_team', side: 'german', name: 'Rifle Squad', type: 'rifle',
      soldierIds: [1, 2], leaderId: 1, vehicleId: null, order: null, facing: 0,
      experience: 50, morale: 80, status: 'Idle', pos: { x: 5, y: 5 }, outOfAction: false,
      kills: 0, aiObjective: null,
    };
    s.teams.set(1, team);

    s.time = 50;
    run(s, 5);

    const received = receiver.mind.beliefs.find((b) => b.kind === 'reported');
    expect(received).toBeDefined();
    if (!received) return;
    // 50 s of battle time minus the 40 s sighting: the report must carry the ORIGINAL sighting
    // age (~10 s), not reset it to 0 every time shareBeliefs fires (item 039)
    expect(s.time - received.time).toBeGreaterThan(9);
    expect(s.time - received.time).toBeLessThan(16);
  });

  it('intact AT gun crew feels no tank stress from a spotted tank; destroyed gun restores it', () => {
    const tankDef = Object.values(VEHICLE_DEFS).find((d) => d.kind === 'tank')!;
    const s = makeState();
    const gunner = makeSoldier(1, 1, 'soviet');
    const team: Team = {
      id: 1, defId: 'atgun_team', side: 'soviet', name: '45mm AT Gun', type: 'atgun',
      soldierIds: [1], leaderId: 1, vehicleId: null, order: null, facing: 0,
      experience: 50, morale: 80, status: 'Idle', pos: { x: 5, y: 5 }, outOfAction: false,
      kills: 0, aiObjective: null,
    };
    const cw: CrewWeaponState = {
      weaponId: 'm1937_45mm', pos: { x: 5, y: 5 }, facing: 0, phase: 'ready', timer: 0,
      phaseTotal: 0, gunnerId: 1, abandoned: false, abandonedAt: 0, setAt: 0,
    };
    team.crewWeapon = cw;
    s.soldiers.set(1, gunner);
    s.teams.set(1, team);

    const vehicle = {
      id: 10, side: 'german', defId: tankDef.id, pos: { x: 15, y: 15 }, facing: 0,
      hullFacing: 0, turretFacing: 0, state: 'ok' as const, crew: tankDef.crew, hull: tankDef.armor.front,
      speed: 0, ammo: tankDef.mainAmmo, path: [], route: [],
    };
    s.vehicles.set(10, vehicle as never);
    s.spottedVehicles.soviet.add(10);

    // seed the stress so both arms start identical: with an intact gun the tank stress adds
    // nothing (0.6/s is dwarfed by the 3/s decay), with the piece smashed it feeds the fear
    gunner.mind.stress = 40;
    gunner.mind.threatLevel = 0.9;
    run(s, 5);
    const intactAfter = gunner.mind.stress;

    const destroyedGunner = makeSoldier(1, 1, 'soviet');
    destroyedGunner.mind.stress = 40;
    destroyedGunner.mind.threatLevel = 0.9;
    s.soldiers.set(1, destroyedGunner);
    const s2 = makeState();
    s2.teams.set(1, { ...team });
    s2.teams.get(1)!.crewWeapon!.destroyed = true;
    s2.soldiers.set(1, destroyedGunner);
    s2.vehicles.set(10, vehicle as never);
    s2.spottedVehicles.soviet.add(10);
    run(s2, 5);

    // destroyed gun: the crew keeps tank stress with no incoming fire (item 039)
    expect(intactAfter).toBeLessThan(destroyedGunner.mind.stress);
  });
});
