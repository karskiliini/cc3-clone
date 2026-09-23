// Crew-served weapons worked task by task (spec 2026-09-17 §6).
import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, CrewTaskId, GameMap, MapDef, Soldier, Team, Terrain, Vec2 } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';
import { stepCombat } from '@/sim/combat';
import {
  stepCrewWeapons, crewWeaponStatus, crewWeaponVisual, crewTaskWord, taskStation, fireMissionWait, isInAction,
  AT_STATION_TILES, TASK_S, CREW_LAYOUT, weaponFramePoint, crewDrillFactor, loadTimeS,
} from '@/sim/crewWeapon';
import { createMind } from '@/sim/mind';

const W = 200, H = 60;

function makeState(): BattleState {
  const tiles: Terrain[] = new Array(W * H).fill('open');
  const def: MapDef = {
    id: 'test', name: 'Test', description: '', width: W, height: H, season: 'summer',
    paint: () => {}, victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 150, y: 30, w: 5, h: 5 } },
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
    result: null, events: [], nextId: 100,
  };
}

function soldier(id: number, teamId: number, pos: Vec2, weaponId: string, over: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side: 'german', name: `Man${id}`, rank: 'Gefr', weaponId, ammo: 20, ammoReserve: 0, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'crouching',
    activity: 'idle', pos, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: -999, cover: 0, kills: 0, mind: createMind(80), ...over,
  };
}

function mkTeam(id: number, type: Team['type'], ids: number[], side: Team['side'] = 'german'): Team {
  return {
    id, defId: 'test', side, name: `Team ${id}`, type, soldierIds: ids, leaderId: ids[0],
    vehicleId: null, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle',
    pos: { x: 0, y: 0 }, outOfAction: false, kills: 0, aiObjective: null,
  };
}

const PIVOT = { x: 50, y: 30 };

/** A gun team with `n` men (id 1 = gunner, the last = leader) round a weapon in the given state. */
function gunSetup(weaponId: string, type: Team['type'], n: number, phase: 'ready' | 'packed' | 'settingUp'): { state: BattleState; team: Team; men: Soldier[] } {
  const state = makeState();
  const men: Soldier[] = [];
  for (let i = 0; i < n; i++) {
    const s = soldier(i + 1, 1, { x: PIVOT.x - 1 + i * 0.9, y: PIVOT.y + 2.2 }, i === 0 ? weaponId : 'kar98k', { isLeader: n > 1 && i === n - 1 });
    men.push(s);
    state.soldiers.set(s.id, s);
  }
  const team = mkTeam(1, type, [men[n - 1].id, ...men.slice(0, n - 1).map((s) => s.id)]);
  team.crewWeapon = {
    weaponId, pos: { ...PIVOT }, facing: 0, phase, timer: 0, phaseTotal: 0,
    gunnerId: 1, abandoned: false, abandonedAt: 0, setAt: 0,
  };
  state.teams.set(1, team);
  return { state, team, men };
}

function step(state: BattleState, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) { state.time += SIM_DT; stepCrewWeapons(state, SIM_DT); each?.(); }
}

function until(state: BattleState, pred: () => boolean, maxS: number, each?: () => void): number {
  const t0 = state.time;
  while (state.time - t0 < maxS && !pred()) { state.time += SIM_DT; stepCrewWeapons(state, SIM_DT); each?.(); }
  return state.time - t0;
}

describe('crew tasks: bringing a gun into action', () => {
  it('a gun with no able crewman at a trail never opens it', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 3, 'settingUp');
    const cw = team.crewWeapon!;
    // everyone but the gunner is down, and the gunner is pinned: nobody can work
    men[1].health = 'dead'; men[2].health = 'incapacitated';
    men[0].activity = 'pinned'; men[0].mind.state = 'pinned';
    step(state, 30);
    expect(cw.done).toEqual([]);
    expect(crewWeaponVisual(state, cw)).toBe('limbered');
    expect(isInAction(cw)).toBe(false);
    // told once that nobody can serve the gun
    const msgs = state.messages.filter((m) => m.text.includes('No one to set up the gun!'));
    expect(msgs).toHaveLength(1);
    // he recovers: the drill starts
    men[0].activity = 'idle'; men[0].mind.state = 'calm';
    until(state, () => isInAction(cw), 60);
    expect(isInAction(cw)).toBe(true);
  });

  it('two men open both trails in parallel; one man opens them in sequence', () => {
    const two = gunSetup('pak40', 'atgun', 2, 'settingUp');
    const one = gunSetup('pak40', 'atgun', 1, 'settingUp');
    const seen = new Set<string>();
    let bothAtOnce = false;
    const tTwo = until(two.state, () => isInAction(two.team.crewWeapon!), 60, () => {
      const cw = two.team.crewWeapon!;
      seen.add(crewWeaponVisual(two.state, cw));
      if ((cw.progress!.spreadLeft ?? 0) > 0 && (cw.progress!.spreadRight ?? 0) > 0) bothAtOnce = true;
    });
    let oneAtOnce = false;
    const seenOne = new Set<string>();
    const tOne = until(one.state, () => isInAction(one.team.crewWeapon!), 60, () => {
      const cw = one.team.crewWeapon!;
      seenOne.add(crewWeaponVisual(one.state, cw));
      // the lone man finishes one leg before he touches the other
      if ((cw.progress!.spreadLeft ?? 0) > 0 && (cw.progress!.spreadRight ?? 0) > 0) oneAtOnce = true;
    });
    expect(bothAtOnce).toBe(true);
    expect(oneAtOnce).toBe(false);
    expect(tOne).toBeGreaterThan(tTwo + 3);
    expect(tTwo).toBeGreaterThan(TASK_S.unhook + TASK_S.spreadLeft + TASK_S.digLeft - 0.2);
    // a lone man shows the gun with one trail out
    expect([...seenOne].some((v) => v === 'trailLeftOpen' || v === 'trailRightOpen')).toBe(true);
    for (const v of ['limbered', 'trailsClosed', 'trailsOpen']) expect(seen.has(v)).toBe(true);
    expect(crewWeaponVisual(two.state, two.team.crewWeapon!)).toBe('emplaced');
    expect(two.state.messages.some((m) => m.text === 'Team 1\nGun ready.')).toBe(true);
  });

  it('crewmen physically walk to the station before the task progresses; nearest free man first, leader last', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 3, 'settingUp');
    const cw = team.crewWeapon!;
    step(state, SIM_DT);
    const worker = state.soldiers.get(cw.workers!.unhook!)!;
    expect(worker.isLeader).toBe(false);
    const station = taskStation(cw, 'atgun', 'unhook');
    const others = men.filter((m) => !m.isLeader && m.id !== worker.id);
    for (const o of others) expect(dist(o.pos, station)).toBeGreaterThanOrEqual(dist(worker.pos, station) - 1e-6);
    expect(worker.crewTask).toEqual({ id: 'unhook', progress: 0, walking: true });
    expect(crewTaskWord(worker)).toBe('Unhooking');
    expect(cw.progress!.unhook ?? 0).toBe(0);
    until(state, () => (cw.progress?.unhook ?? 0) > 0, 10);
    expect(dist(worker.pos, taskStation(cw, 'atgun', 'unhook'))).toBeLessThanOrEqual(AT_STATION_TILES + 1e-6);
  });

  it('killing the man mid-task pauses progress until another arrives, and the work done is kept', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 2, 'settingUp');
    const cw = team.crewWeapon!;
    until(state, () => (cw.progress?.spreadLeft ?? 0) > 1 || (cw.progress?.spreadRight ?? 0) > 1, 30);
    const task: CrewTaskId = (cw.progress!.spreadLeft ?? 0) > 1 ? 'spreadLeft' : 'spreadRight';
    const victim = state.soldiers.get(cw.workers![task]!)!;
    const other = men.find((m) => m.id !== victim.id)!;
    victim.health = 'incapacitated';
    // the other man is pinned for now: nobody works, progress stays
    other.activity = 'pinned'; other.mind.state = 'pinned';
    const kept = cw.progress![task]!;
    step(state, 5);
    expect(cw.progress![task]).toBeCloseTo(kept, 6);
    expect(cw.done).not.toContain(task);
    // he recovers, walks over and finishes it from where it was left
    other.activity = 'idle'; other.mind.state = 'calm';
    if (victim.id === cw.gunnerId) { other.weaponId = victim.weaponId; victim.weaponId = 'kar98k'; }
    const t = until(state, () => cw.done!.includes('spreadLeft') && cw.done!.includes('spreadRight'), 30);
    expect(cw.done).toContain(task);
    expect(t).toBeLessThan(2 * TASK_S.spreadLeft * crewDrillFactor(50) + 6);
  });

  it('experience scales task times: green x1.25, veteran x0.8', () => {
    expect(crewDrillFactor(10)).toBeCloseTo(1.25, 6);
    expect(crewDrillFactor(50)).toBeCloseTo(1, 6);
    expect(crewDrillFactor(90)).toBeCloseTo(0.8, 6);
    const green = gunSetup('mortar81', 'mortar', 2, 'settingUp');
    const vet = gunSetup('mortar81', 'mortar', 2, 'settingUp');
    for (const m of green.men) m.experience = 10;
    for (const m of vet.men) m.experience = 90;
    const tg = until(green.state, () => isInAction(green.team.crewWeapon!), 60);
    const tv = until(vet.state, () => isInAction(vet.team.crewWeapon!), 60);
    expect(tg).toBeGreaterThan(tv + 2);
  });

  it('status words follow the open task', () => {
    const { state, team } = gunSetup('pak40', 'atgun', 2, 'settingUp');
    const cw = team.crewWeapon!;
    const words = new Set<string>();
    until(state, () => isInAction(cw), 60, () => { const w = crewWeaponStatus(team); if (w) words.add(w); });
    expect([...words]).toEqual(['Unlimbering', 'Spreading trails', 'Digging in']);
    // breech empty: the loader loads without waiting for a target
    step(state, 0.5);
    expect(crewWeaponStatus(team)).toBe('Loading');
  });

  it('a mortar needs its baseplate and bipod brought by different men; an HMG tripod, gun, belt', () => {
    const m = gunSetup('mortar81', 'mortar', 2, 'settingUp');
    const cw = m.team.crewWeapon!;
    let bipodBy: number | undefined;
    until(m.state, () => isInAction(cw), 60, () => { if (cw.workers!.setBipod != null) bipodBy = cw.workers!.setBipod; });
    expect(cw.done).toEqual(['placeBaseplate', 'mountTube', 'setBipod']);
    expect(bipodBy).toBeDefined();
    expect(bipodBy).not.toBe(cw.baseplateBy);

    const h = gunSetup('mg42_hmg', 'mg', 2, 'settingUp');
    until(h.state, () => isInAction(h.team.crewWeapon!), 60);
    expect(h.team.crewWeapon!.done).toEqual(['placeTripod', 'mountGun', 'feedBelt']);
  });
});

describe('crew tasks: packing up', () => {
  it('a move order reverses the drill (lift spades, close trails, hook up) before the gun moves', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 2, 'ready');
    const cw = team.crewWeapon!;
    step(state, 1);
    team.order = { type: 'move', target: { x: 80, y: 30 }, issuedAt: state.time };
    for (const m of men) m.path = [{ x: 80, y: 30 }];
    const visuals: string[] = [];
    const words = new Set<string>();
    until(state, () => cw.phase === 'packed', 30, () => {
      const v = crewWeaponVisual(state, cw);
      if (visuals[visuals.length - 1] !== v) visuals.push(v);
      const w = crewWeaponStatus(team); if (w) words.add(w);
    });
    expect(cw.phase).toBe('packed');
    expect(cw.done).toEqual([]);
    expect(visuals).toEqual(['emplaced', 'trailsOpen', 'trailsClosed', 'limbered']);
    expect([...words]).toEqual(['Packing up']);
  });
});

describe('crew tasks: the firing chain', () => {
  function enemyAt(state: BattleState, pos: Vec2): Soldier {
    const e = soldier(50, 50, pos, 'kar98k', { side: 'soviet' });
    state.soldiers.set(50, e);
    state.teams.set(50, mkTeam(50, 'rifle', [50], 'soviet'));
    state.spotted.german.add(50);
    return e;
  }
  /** crew weapons + combat; enemies are kept alive and calm so only the gun drill is measured */
  function fight(state: BattleState, rng: Rng, seconds: number, onShot?: (t: number) => void): number {
    let shots = 0;
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) {
      state.time += SIM_DT;
      stepCrewWeapons(state, SIM_DT);
      stepCombat(state, rng, SIM_DT);
      for (const e of state.events) if (e.kind === 'shot' && e.weaponId === 'pak40') { shots++; onShot?.(state.time); }
      state.events.length = 0; state.explosions.length = 0; state.tracers.length = 0;
      for (const s of state.soldiers.values()) {
        if (s.side === 'soviet') { s.health = 'healthy'; s.suppression = 0; s.mind.stress = 0; s.activity = 'idle'; s.blast = undefined; s.stunnedUntil = undefined; }
      }
    }
    return shots;
  }

  it('the gun fires only after load -> lay, and the round is taken from the ammunition at load', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 2, 'ready');
    const cw = team.crewWeapon!;
    const gunner = men[0];
    enemyAt(state, { x: 50, y: 5 });
    const order: string[] = [];
    let ammoAtFirstShot = -1;
    const rng = new Rng(3);
    const shots = fight(state, rng, 0.1);
    expect(shots).toBe(0);
    expect(gunner.ammo).toBe(20);
    let shotAt = -1;
    const n = Math.round(14 / SIM_DT);
    for (let i = 0; i < n && shotAt < 0; i++) {
      const before = { ammo: gunner.ammo, laid: !!cw.laid };
      fight(state, rng, SIM_DT, (t) => { shotAt = t; ammoAtFirstShot = gunner.ammo; });
      // the round leaves the ammunition when it is loaded (the shot may follow in the same step)
      if (before.ammo === 20 && gunner.ammo === 19) order.push('load');
      if (!before.laid && cw.laid) order.push('lay');
    }
    // gun timing: LOADING (7.5 cm: 6.5 s x0.9 for an open gun) and LAYING (fine lay 4 s at 90 m) now
    // run side by side, so the shorter lay finishes first and the shot waits for the loader
    expect(shotAt).toBeGreaterThan(loadTimeS('pak40', gunner.experience) - 0.3);
    expect(order).toEqual(['lay', 'load']);
    expect(ammoAtFirstShot).toBe(19); // firing did not take a second round
    expect(cw.chambered).toBe(false);
    expect(crewWeaponVisual(state, cw)).toBe('recoil');
  });

  it('a new target needs re-laying; the same target does not', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 2, 'ready');
    const cw = team.crewWeapon!;
    const gunner = men[0];
    // The loader must walk to the breech before spending ~5.9 s loading the 7.5 cm round.
    const loadedAfter = until(state, () => !!cw.chambered, 20);
    expect(cw.chambered).toBe(true);
    expect(loadedAfter).toBeGreaterThan(loadTimeS('pak40', men[1].experience));
    const aim = { x: 50, y: 5 };
    expect(fireMissionWait(state, team, gunner, { aim, targetTeamId: 7 })).toBeGreaterThan(1);
    until(state, () => !!cw.laid, 10, () => { fireMissionWait(state, team, gunner, { aim, targetTeamId: 7 }); });
    expect(fireMissionWait(state, team, gunner, { aim, targetTeamId: 7 })).toBe(0);
    // same team a few metres on: still laid
    expect(fireMissionWait(state, team, gunner, { aim: { x: 52, y: 5 }, targetTeamId: 7 })).toBe(0);
    // it moved 14 m: short re-lay
    const relay = fireMissionWait(state, team, gunner, { aim: { x: 57, y: 5 }, targetTeamId: 7 });
    expect(relay).toBeGreaterThan(1); expect(relay).toBeLessThan(2.1);
    expect(cw.laid).toBe(false);
    // a different target far round to the flank: a whole new lay, longer by the traverse angle
    const flank = fireMissionWait(state, team, gunner, { aim: { x: 90, y: 30 }, targetTeamId: 9 });
    expect(flank).toBeGreaterThan(2.5);
    step(state, 0.2, () => { fireMissionWait(state, team, gunner, { aim: { x: 90, y: 30 }, targetTeamId: 9 }); });
    expect(crewWeaponStatus(team)).toBe('Aiming');
    expect(gunner.crewTask?.id).toBe('lay');
  });

  it('a one-man crew still fires, slowly, walking between the breech and the sight', () => {
    const full = gunSetup('pak40', 'atgun', 3, 'ready');
    const lone = gunSetup('pak40', 'atgun', 1, 'ready');
    enemyAt(full.state, { x: 50, y: 5 });
    enemyAt(lone.state, { x: 50, y: 5 });
    const breech = weaponFramePoint(PIVOT, 0, CREW_LAYOUT.atgun.loader);
    const sight = weaponFramePoint(PIVOT, 0, CREW_LAYOUT.atgun.gunner);
    let atBreech = false, atSight = false;
    const nFull = fight(full.state, new Rng(5), 60);
    let nLone = 0;
    for (let i = 0; i < 600; i++) {
      nLone += fight(lone.state, new Rng(5 + i), 0.1);
      if (dist(lone.men[0].pos, breech) < AT_STATION_TILES + 0.01) atBreech = true;
      if (dist(lone.men[0].pos, sight) < AT_STATION_TILES + 0.01) atSight = true;
    }
    expect(nLone).toBeGreaterThanOrEqual(3);
    expect(nFull).toBeGreaterThan(nLone);
    expect(atBreech && atSight).toBe(true);
  });

  it('with the loader down and the gunner pinned nobody loads: the player is told, rate-limited', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 2, 'ready');
    men[1].health = 'dead';
    men[0].activity = 'pinned'; men[0].mind.state = 'pinned';
    step(state, 45);
    expect(team.crewWeapon!.chambered).toBeFalsy();
    expect(state.messages.filter((m) => m.text === 'Team 1\nNo one to load!')).toHaveLength(2); // 3 s, then every 30 s
  });

  it('an HMG without an assistant feeds its own belts, slower', () => {
    const two = gunSetup('mg42_hmg', 'mg', 2, 'ready');
    const one = gunSetup('mg42_hmg', 'mg', 1, 'ready');
    for (const g of [two, one]) { step(g.state, 6); g.men[0].ammo = 0; g.men[0].ammoReserve = 500; }
    const t2 = until(two.state, () => two.men[0].ammo > 0, 30);
    const t1 = until(one.state, () => one.men[0].ammo > 0, 30);
    expect(two.men[0].ammo).toBe(250);
    expect(two.men[0].ammoReserve).toBe(250);
    expect(t1).toBeGreaterThan(t2 + 1);
  });
});

describe('crew tasks: determinism', () => {
  it('the same situation steps to the same state', () => {
    const run = (): string => {
      const { state, team, men } = gunSetup('pak40', 'atgun', 3, 'settingUp');
      step(state, 12);
      return JSON.stringify([team.crewWeapon, men.map((m) => [m.pos.x.toFixed(6), m.pos.y.toFixed(6), m.crewTask])]);
    };
    expect(run()).toBe(run());
  });
});

import { crewTaskAnim, progressFrame, weaponStateChain } from '@/render/soldierAnim';

describe('crew tasks: what the renderer is told', () => {
  it('a working crewman gets his task pose with the frame from the task progress; packing plays it backwards', () => {
    const s = soldier(1, 1, { x: 1, y: 1 }, 'kar98k');
    s.crewTask = { id: 'spreadLeft', progress: 0.5, walking: true };
    expect(crewTaskAnim(s, 10)).toBeNull(); // still walking to the trail: normal gait
    s.crewTask = { id: 'spreadLeft', progress: 0.5, walking: false };
    const a = crewTaskAnim(s, 10)!;
    expect(a.keys[0]).toBe('crew.trail');
    expect(a.progress).toBeCloseTo(0.5, 6);
    expect(progressFrame(a.progress!, 5)).toBe(2);
    s.crewTask = { id: 'closeLeft', progress: 0.25, walking: false };
    expect(crewTaskAnim(s, 10)!.progress).toBeCloseTo(0.75, 6);
    s.crewTask = { id: 'load', progress: 0.99, walking: false };
    expect(crewTaskAnim(s, 10)!.keys[0]).toBe('crew.load.gun');
    expect(progressFrame(0.99, 5)).toBe(4);
    expect(progressFrame(1, 5)).toBe(4);
    // laying loops on the clock; just after the shot the gunner pulls the lanyard and flinches
    s.crewTask = { id: 'lay', progress: 0.3, walking: false };
    expect(crewTaskAnim(s, 10)!.progress).toBeNull();
    s.lastFiredAt = 9.9;
    const f = crewTaskAnim(s, 10)!;
    expect(f.keys[0]).toBe('crew.fire');
    expect(f.progress).toBeCloseTo(0.2, 6);
    const keys: Record<string, string> = {
      unhook: 'crew.haul', digLeft: 'crew.dig', dropRound: 'crew.load.mortar', placeBaseplate: 'crew.baseplate', mountTube: 'crew.tube',
      setBipod: 'crew.bipod', placeTripod: 'crew.tripod', mountGun: 'crew.mountmg', feedBelt: 'crew.belt',
    };
    s.lastFiredAt = -999;
    for (const [task, key] of Object.entries(keys)) {
      s.crewTask = { id: task as CrewTaskId, progress: 0, walking: false };
      expect(crewTaskAnim(s, 10)!.keys[0]).toBe(key);
    }
  });

  it('weapon sprite states fall back to setup / half / packed when the atlas lacks the drill steps', () => {
    expect(weaponStateChain('limbered')).toEqual(['limbered', 'packed']);
    expect(weaponStateChain('trailLeftOpen')).toEqual(['trailLeftOpen']);
    expect(weaponStateChain('emplaced')).toEqual(['emplaced', 'setup']);
    expect(weaponStateChain('recoil')).toEqual(['recoil', 'emplaced', 'setup']);
  });
});

import { gunHaulers, haulStationM, towLengthM } from '@/sim/crewWeapon';
import { stepMovement } from '@/sim/movement';

describe('crew tasks: a hauled gun pivots about its axle', () => {
  it('on an L-shaped path the axle stays on the path, the tail sweeps an arc about it, and the haulers keep their stations', () => {
    const { state, team, men } = gunSetup('pak40', 'atgun', 3, 'packed');
    const cw = team.crewWeapon!;
    cw.facing = Math.PI / 2; // limbered, muzzle east
    // The haulers have already walked to the towing eye; this case isolates the axle and turn.
    men[0].pos = weaponFramePoint(cw.pos, cw.facing, haulStationM('pak40', 0));
    men[1].pos = weaponFramePoint(cw.pos, cw.facing, haulStationM('pak40', 1));
    const corner = { x: 62, y: 30 }, end = { x: 62, y: 40 };
    team.order = { type: 'move', target: end, issuedAt: 0 };
    for (const m of men) { m.path = [{ ...corner }, { ...end }]; m.activity = 'moving'; }
    const rng = new Rng(1);
    let maxOffPath = 0, maxHaulerOff = 0, tailArc = 0, turned = 0;
    let lastTail: Vec2 | null = null, lastFacing = cw.facing, axleWhileTurning = 0;
    const onPath = (p: Vec2) => Math.min(
      p.x <= corner.x ? Math.abs(p.y - 30) : Math.hypot(p.x - corner.x, p.y - 30),
      p.y >= 30 ? Math.abs(p.x - corner.x) : Math.hypot(p.x - corner.x, p.y - 30));
    for (let i = 0; i < 900 && men[0].path.length > 0; i++) {
      state.time += SIM_DT;
      const before = { ...cw.pos };
      stepMovement(state, rng, SIM_DT);
      if (cw.phase !== 'packed') continue;
      maxOffPath = Math.max(maxOffPath, onPath(cw.pos));
      const tail = weaponFramePoint(cw.pos, cw.facing, { x: 0, y: towLengthM('pak40') });
      const dF = Math.abs(cw.facing - lastFacing);
      if (dF > 1e-6 && lastTail) { tailArc += dist(tail, lastTail) * 2; turned += dF; axleWhileTurning += dist(before, cw.pos) * 2; }
      lastTail = tail; lastFacing = cw.facing;
      gunHaulers(state, team, cw).forEach((h, k) => {
        if (k === 0) maxHaulerOff = Math.max(maxHaulerOff, dist(h.pos, weaponFramePoint(cw.pos, cw.facing, haulStationM('pak40', k))) * 2);
      });
    }
    expect(maxOffPath).toBeLessThan(1e-6);          // the pose point (wheel midpoint) never leaves the path
    expect(turned).toBeGreaterThan(Math.PI / 2 - 0.2); // it slewed round the corner ...
    expect(axleWhileTurning).toBeLessThan(0.5);        // ... practically on the spot, about the axle (metres)
    expect(tailArc).toBeGreaterThan(towLengthM('pak40') * turned * 0.85); // tail swept ~3.45 m x delta-heading
    expect(tailArc).toBeLessThan(towLengthM('pak40') * turned * 1.15);
    expect(maxHaulerOff).toBeLessThan(0.3);
    const second = gunHaulers(state, team, cw)[1];
    expect(second).toBeDefined();
  });
});
