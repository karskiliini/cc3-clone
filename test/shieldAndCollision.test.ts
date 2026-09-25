import { describe, it, expect } from 'vitest';
import type { BattleState, CrewWeaponState, Soldier, Team, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { createMind } from '@/sim/mind';
import { gunShieldShadow, GUN_SHIELD_HALF_WIDTH_M, GUN_SHIELD_ARC_RAD } from '@/sim/crewWeapon';
import { stepVehicleCollisions } from '@/sim/vehicle';
import { stepCombat, stepBowMgForTest } from '@/sim/combat';
import { resolveSoldierOverlapForTest } from '@/sim/movement';
import { VEHICLE_DEFS } from '@/data/units';

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
  return {
    config: { mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map: { def: { id: 'test', name: '', description: '', width: 24, height: 24, season: 'summer', paint: () => {}, victoryLocations: [], deployZones: {}, attacker: 'german' }, width: 24, height: 24, tiles: new Array(24 * 24).fill('open'), buildingId: new Int16Array(576).fill(-1), windows: new Uint8Array(576), victoryLocations: [], smoke: new Float32Array(576), craters: [] },
    phase: 'running', time: 10, soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [], result: null, events: [], nextId: 10,
  } as never;
}

function makeCw(facing: number, pos = { x: 10.5, y: 10.5 }): CrewWeaponState {
  return {
    weaponId: 'pak40', pos, facing, phase: 'ready', timer: 0, phaseTotal: 0,
    gunnerId: 1, abandoned: false, abandonedAt: 0, setAt: 0, goal: 'deploy', done: ['unhook', 'spreadLeft', 'spreadRight', 'digLeft', 'digRight'], progress: {}, workers: {}, open: [],
  };
}

function addTeam(state: BattleState, side: 'german' | 'soviet', cw?: CrewWeaponState): Team {
  const team: Team = { id: side === 'german' ? 1 : 2, side, name: side, soldierIds: [], statusWord: 'Holding', outOfAction: false, kills: 0, aiObjective: null, crewWeapon: cw } as never;
  state.teams.set(team.id, team);
  return team;
}

describe('gun shield shadow', () => {
  const cw = makeCw(0); // facing north (muzzle -y)

  it('shelters a man behind the plate against frontal fire', () => {
    const man = { x: cw.pos.x, y: cw.pos.y + 0.4 }; // 0.8 m behind the gun
    expect(gunShieldShadow(cw, man, { x: cw.pos.x, y: cw.pos.y - 10 })).toBe(true);
  });

  it('gives nothing against fire from behind or the broadside', () => {
    const man = { x: cw.pos.x, y: cw.pos.y + 0.4 };
    expect(gunShieldShadow(cw, man, { x: cw.pos.x, y: cw.pos.y + 10 })).toBe(false); // rear
    expect(gunShieldShadow(cw, man, { x: cw.pos.x - 10, y: cw.pos.y })).toBe(false); // side
  });

  it('is plate-shaped in METRES: the assistant 1.9 m lateral is past the plate edge', () => {
    // CREW_LAYOUT.atgun.assistant = { x: 1.9, y: 2.1 } metres = 0.95 tiles lateral: with the
    // tile-vs-metre bug (0.95 <= 1.2) he was wrongly "shielded"; in metres he is exposed
    const assistant = { x: cw.pos.x + 1.9 / TILE_M, y: cw.pos.y + 2.1 / TILE_M };
    expect(gunShieldShadow(cw, assistant, { x: cw.pos.x, y: cw.pos.y - 10 })).toBe(false);
    // a man just inside the plate width (1.0 m lateral) IS sheltered
    const inW = { x: cw.pos.x + 1.0 / TILE_M, y: cw.pos.y + 0.5 / TILE_M };
    expect(gunShieldShadow(cw, inW, { x: cw.pos.x, y: cw.pos.y - 10 })).toBe(true);
    // just past the edge (1.4 m lateral) is NOT
    const past = { x: cw.pos.x + 1.4 / TILE_M, y: cw.pos.y + 0.5 / TILE_M };
    expect(gunShieldShadow(cw, past, { x: cw.pos.x, y: cw.pos.y - 10 })).toBe(false);
  });

  it('expires beyond the frontal arc', () => {
    const man = { x: cw.pos.x, y: cw.pos.y + 0.4 };
    // fire from a bearing past GUN_SHIELD_ARC_RAD off the muzzle
    const a = GUN_SHIELD_ARC_RAD + 0.4;
    const shooter = { x: cw.pos.x - Math.sin(a) * 10, y: cw.pos.y - Math.cos(a) * 10 };
    expect(gunShieldShadow(cw, man, shooter)).toBe(false);
  });
});

describe('soldier overlap', () => {
  it('nudges a resting man OFF a comrade he stopped on, sideways not backward', () => {
    const state = makeState();
    const a = makeSoldier({ id: 1, pos: { x: 10.5, y: 10.5 }, facing: 0, path: [] }); // facing north (index 0)
    const b = makeSoldier({ id: 2, pos: { x: 10.52, y: 10.5 }, path: [] });
    state.soldiers.set(1, a); state.soldiers.set(2, b);
    resolveSoldierOverlapForTest(state, a, new Rng(1));
    // he moved aside, and NOT further north/backward than he was
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)).toBeGreaterThanOrEqual(0.8);
    expect(a.pos.y).toBeLessThanOrEqual(10.5 + 1e-9); // never pushed backward (south) past his rest spot
  });

  it('shove direction honours Facing8 as an INDEX: at facing 5 (south-west) he is never pushed backward (north-east)', () => {
    const state = makeState();
    // facing 5 = 225 deg (south-west); he stopped on a comrade
    const a = makeSoldier({ id: 1, pos: { x: 10.5, y: 10.5 }, facing: 5, path: [] });
    const b = makeSoldier({ id: 2, pos: { x: 10.52, y: 10.52 }, path: [] });
    state.soldiers.set(1, a); state.soldiers.set(2, b);
    resolveSoldierOverlapForTest(state, a, new Rng(1));
    // the shove must be PERPENDICULAR to travel (225 deg): with the facing-index-as-radians bug
    // (5 rad ≈ 286 deg) the direction is wrong and the dot product with travel is far from 0
    const dx = a.pos.x - 10.5, dy = a.pos.y - 10.5;
    const travelRad = 5 * Math.PI / 4;
    const along = dx * Math.sin(travelRad) - dy * Math.cos(travelRad); // |projection on travel|
    expect(Math.abs(along)).toBeLessThan(0.05);
  });

  it('never touches a man still walking', () => {
    const state = makeState();
    const a = makeSoldier({ id: 1, pos: { x: 10.5, y: 10.5 }, path: [] });
    const b = makeSoldier({ id: 2, pos: { x: 10.5, y: 10.5 }, path: [{ x: 12.5, y: 10.5 }] });
    state.soldiers.set(1, a); state.soldiers.set(2, b);
    const before = { ...a.pos };
    resolveSoldierOverlapForTest(state, a, new Rng(1));
    expect(a.pos).toEqual(before);
  });
});

describe('vehicle collision', () => {
  function makeVehicle(state: BattleState, id: number, side: 'german' | 'soviet', pos: { x: number; y: number }, speed: number): Vehicle {
    const v: Vehicle = {
      id, teamId: side === 'german' ? 1 : 2, side, defId: 'pz4gh', pos,
      hullFacing: 0, turretFacing: 0, state: 'ok', mainAmmo: 10, coaxAmmo: 10, path: [],
      speed, targetVehicleId: null, targetSoldierId: null, targetPoint: null,
      mainFireTimer: 0, coaxFireTimer: 0, burnTimer: 0, hits: 0,
    };
    state.vehicles.set(id, v);
    return v;
  }

  it('a ram at speed damages running gear on BOTH hulls', () => {
    const state = makeState();
    addTeam(state, 'german'); addTeam(state, 'soviet');
    const a = makeVehicle(state, 1, 'german', { x: 10, y: 12 }, 6);
    const b = makeVehicle(state, 2, 'soviet', { x: 10, y: 12 + 1.6 }, 0);
    stepVehicleCollisions(state, new Rng(7), 0.1);
    const hit = (v: Vehicle) => Object.values(v.damage ?? {}).filter((s) => s !== 'ok').length;
    expect(hit(a)).toBeGreaterThan(0);
    expect(hit(b)).toBeGreaterThan(0);
  });

  it('hard-blocks: the faster hull stops at contact and never rides over the other', () => {
    const state = makeState();
    addTeam(state, 'german'); addTeam(state, 'soviet');
    const a = makeVehicle(state, 1, 'german', { x: 10, y: 12 }, 4); // closing at 4 m/s from the south
    const b = makeVehicle(state, 2, 'soviet', { x: 10, y: 12 + 1.6 }, 0); // 3.2 m apart: inside the damage sphere
    stepVehicleCollisions(state, new Rng(1), 0.1);
    expect(a.speed).toBe(0);
    expect(a.path).toEqual([]);
    expect(Math.abs(a.pos.y - b.pos.y) * TILE_M).toBeGreaterThan(0);
  });

  it('nose-on approach: two hulls nose-to-tail cannot interpenetrate (footprint, not radius)', () => {
    const state = makeState();
    addTeam(state, 'german'); addTeam(state, 'soviet');
    // nose-on: both facing along the approach; footprint sum ≈ lengthM ≈ 5.9 m, beyond the 4.5 m
    // damage sphere — the block must still hold at ~hull contact, and no overlap may occur
    const a = makeVehicle(state, 1, 'german', { x: 10, y: 12 }, 5);
    a.hullFacing = 0; // facing north, toward b
    const b = makeVehicle(state, 2, 'soviet', { x: 10, y: 12 + 2.2 }, 0); // 4.4 m: outside damage sphere
    b.hullFacing = Math.PI; // facing south, toward a
    stepVehicleCollisions(state, new Rng(1), 0.1);
    // blocked distance: ellipse radii nose-on ≈ full half-lengths; 4.4 m < 5.9 m → blocked or damaged, never overlapping
    const sepM = Math.abs(a.pos.y - b.pos.y) * TILE_M;
    expect(sepM).toBeGreaterThanOrEqual(4.4 - 1e-6); // a never crossed into b
  });

  it('ignores a gentle nudge: two parked hulls close together take no damage', () => {
    const state = makeState();
    addTeam(state, 'german'); addTeam(state, 'soviet');
    const a = makeVehicle(state, 1, 'german', { x: 10, y: 12 }, 0);
    const b = makeVehicle(state, 2, 'soviet', { x: 10.5, y: 12 }, 0);
    stepVehicleCollisions(state, new Rng(1), 0.1);
    expect(a.damage).toBeUndefined();
    expect(b.damage).toBeUndefined();
    expect(a.speed).toBe(0); // still blocked
  });
});

describe('vehicle damage def sanity', () => {
  it('pz4gh footprint feeds the ellipse block (length > width)', () => {
    expect(VEHICLE_DEFS['pz4gh'].lengthM).toBeGreaterThan(VEHICLE_DEFS['pz4gh'].widthM);
  });
});

describe('vehicle MGs vs the gun shield', () => {
  function makeVehicle(pos: { x: number; y: number }): { state: BattleState; vehicle: Vehicle } {
    const state = makeState();
    const vehicle: Vehicle = {
      id: 1, teamId: 99, side: 'soviet', defId: 'pz4gh', pos,
      hullFacing: Math.PI, turretFacing: Math.PI, state: 'ok', mainAmmo: 0, coaxAmmo: 100, bowAmmo: 100,
      path: [], speed: 0, targetVehicleId: null, targetSoldierId: null, targetPoint: null,
      mainFireTimer: 0, coaxFireTimer: 0, bowFireTimer: 0, burnTimer: 0, hits: 0,
    };
    state.vehicles.set(1, vehicle);
    const tankTeam = addTeam(state, 'soviet');
    tankTeam.id = 99; tankTeam.vehicleId = 1;
    tankTeam.soldierIds.push(11);
    state.teams.set(99, tankTeam);
    const tankCrew = makeSoldier({ id: 11, teamId: 99, side: 'soviet', pos: { ...pos }, vehicleId: 1 });
    state.soldiers.set(11, tankCrew);
    vehicle.seats = { radioOp: 11 };
    return { state, vehicle };
  }

  it('a tank bow MG can never wound a shielded AT-gun crewman: the plate sparks, the man stands', () => {
    // gun faces NORTH (facing 0, muzzle -y); the SOVIET tank sits NORTH of it at 28 m: the fire
    // arrives in the frontal arc, the crewman is behind the plate. Tank outside grenade reach
    // (28 m > 25 m) and main gun starved (mainAmmo 0) so ONLY the bow MG engages.
    const gunPos = { x: 10.5, y: 18 }; // near the map's south edge so the tank 14 tiles north stays in bounds
    const { state, vehicle } = makeVehicle({ x: gunPos.x, y: gunPos.y - 14 });
    const gunTeam = addTeam(state, 'german', makeCw(0, gunPos));
    const crew = makeSoldier({ id: 10, teamId: gunTeam.id, side: 'german', weaponId: 'pak40', pos: { x: gunPos.x, y: gunPos.y + 0.25 }, path: [] });
    gunTeam.soldierIds.push(10);
    state.soldiers.set(10, crew);
    state.spotted.soviet.add(10);
    const rng = new Rng(3);
    for (let i = 0; i < 60; i++) stepBowMgForTest(state, rng, vehicle, VEHICLE_DEFS['pz4gh']);
    // the MG engaged (bursts flew) yet every round was stopped by the plate
    const bullets = state.tracers.filter((t) => t.kind === 'bullet');
    expect(bullets.length).toBeGreaterThan(0);
    // blocked rounds RECORD as plate hits (tracer hit:true) but never wound:
    expect(state.events.filter((e) => e.kind === 'shieldRicochet').length).toBeGreaterThan(0);
    expect(state.sparks.some((sp) => sp.kind === 'armor')).toBe(true);
    expect(crew.health).toBe('healthy');
  });

  it('the same bow MG DOES wound an unshielded man (the gate is what protects, not luck)', () => {
    const gunPos = { x: 10.5, y: 18 };
    const { state, vehicle } = makeVehicle({ x: gunPos.x, y: gunPos.y - 14 });
    // NO crew weapon team: a bare rifleman standing where the shielded man would be
    const man = makeSoldier({ id: 10, teamId: 2, side: 'german', pos: { x: gunPos.x, y: gunPos.y + 0.25 }, path: [] });
    state.soldiers.set(10, man);
    state.teams.set(2, { id: 2, side: 'german', name: 'german', soldierIds: [10], statusWord: 'Holding', outOfAction: false, kills: 0, aiObjective: null } as never);
    state.spotted.soviet.add(10);
    const rng = new Rng(3);
    for (let i = 0; i < 60; i++) stepBowMgForTest(state, rng, vehicle, VEHICLE_DEFS['pz4gh']);
    const bullets = state.tracers.filter((t) => t.kind === 'bullet');
    expect(bullets.length).toBeGreaterThan(0);
    expect(man.health).not.toBe('healthy'); // without a shield he is hit
    expect(state.events.filter((e) => e.kind === 'shieldRicochet').length).toBe(0);
  });
});
