import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { applyOrder } from '@/sim/orders';
import { stepCrewWeapons, setupTimeS, packTimeS, pivotFromGunner, weaponFramePoint, CREW_LAYOUT, crewWeaponView } from '@/sim/crewWeapon';
import type { BattleConfig, Soldier, Team } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { dist } from '@/shared/math';

function config(german: string[]): BattleConfig {
  return {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 3, durationS: 600,
    difficulty: 'normal', forces: { german, soviet: ['sov_rifle_41'] },
  };
}

/** rng whose obedience rolls always pass, so a test order is obeyed at once */
function obedient(rng: Rng): Rng {
  return new Proxy(rng, {
    get(obj, prop) {
      if (prop === 'chance') return () => true;
      const v = Reflect.get(obj, prop);
      return typeof v === 'function' ? v.bind(obj) : v;
    },
  }) as Rng;
}

function setup(defId: string, weaponId: string): { battle: Battle; team: Team; gunner: Soldier } {
  const battle = new Battle(config([defId]));
  battle.start();
  const team = battle.selectableTeams('german')[0];
  const gunner = team.soldierIds.map((id) => battle.state.soldiers.get(id)!).find((s) => s.weaponId === weaponId)!;
  // (the enemy stays in its far deploy zone for the few seconds these tests run)
  return { battle, team, gunner };
}

function runUntil(battle: Battle, pred: () => boolean, maxS: number): number {
  let t = 0;
  while (t < maxS && !pred()) { battle.step(SIM_DT); t += SIM_DT; }
  return t;
}

describe('crew-served weapons: set-up time', () => {
  it('a deployed mortar starts set up and ready, with its baseplate beside the gunner', () => {
    const { battle, team, gunner } = setup('ger_mortar81', 'mortar81');
    battle.step(SIM_DT);
    const cw = team.crewWeapon!;
    expect(cw).toBeDefined();
    expect(cw.phase).toBe('ready');
    expect(cw.abandoned).toBe(false);
    // the gunner kneels at his layout slot next to the weapon, not on top of it
    const slot = weaponFramePoint(cw.pos, cw.facing, CREW_LAYOUT.mortar.gunner);
    expect(dist(slot, gunner.pos)).toBeLessThan(0.3);
    expect(dist(cw.pos, gunner.pos)).toBeGreaterThan(0.25); // 0.6 m left of the tube (the art's gunner station)
  });

  it('moving packs the weapon task by task (crew held until it is packed), then the crew sets it up again before it can fire', () => {
    const { battle, team, gunner } = setup('ger_mortar81', 'mortar81');
    battle.step(3);
    const start = { ...gunner.pos };
    applyOrder(battle.state, team, { type: 'move', target: { x: start.x + 6, y: start.y }, issuedAt: battle.state.time }, obedient(battle.rng));
    battle.step(SIM_DT);
    const cw = team.crewWeapon!;
    expect(cw.phase).toBe('packing');
    expect(team.status).toBe('Packing up');
    // held with the weapon while packing (he only walks between its stations)
    battle.step(1);
    expect(cw.phase).toBe('packing');
    expect(dist(gunner.pos, start)).toBeLessThan(2);
    expect(gunner.fireTimer).toBeGreaterThan(0);
    const packT = runUntil(battle, () => cw.phase === 'packed', 15);
    expect(packT).toBeGreaterThan(packTimeS('mortar81') - 1.2);
    expect(packT).toBeLessThan(15);
    // moving: carried, cannot fire
    battle.step(1.5);
    expect(cw.phase).toBe('packed');
    expect(dist(gunner.pos, start)).toBeGreaterThan(0.2);
    stepCrewWeapons(battle.state, SIM_DT);
    expect(gunner.fireTimer).toBeGreaterThan(0);
    // arrives and sets up: no sooner than the drill's working time
    runUntil(battle, () => cw.phase === 'settingUp', 40);
    expect(cw.phase).toBe('settingUp');
    expect(team.status).toBe('Setting up');
    const expected = setupTimeS('mortar81', gunner.experience);
    expect(expected).toBeGreaterThan(5);
    const t = runUntil(battle, () => cw.phase === 'ready', 40);
    expect(t).toBeGreaterThan(expected - 0.35);
    expect(t).toBeLessThan(expected + 12); // plus the walking between stations
    battle.step(1);
    expect(team.status).not.toBe('Setting up');
  });

  it('while not in action the gunner cannot fire; once in action the gate lifts', () => {
    const { battle, team, gunner } = setup('ger_mg34_hmg', 'mg34_hmg');
    battle.step(SIM_DT);
    const cw = team.crewWeapon!;
    const done = cw.done!;
    cw.done = ['placeTripod'];
    gunner.fireTimer = 0;
    stepCrewWeapons(battle.state, SIM_DT);
    expect(cw.phase).toBe('settingUp');
    expect(gunner.fireTimer).toBeGreaterThan(0);
    cw.done = done;
    gunner.fireTimer = 0;
    stepCrewWeapons(battle.state, SIM_DT);
    expect(cw.phase).toBe('ready');
    expect(gunner.fireTimer).toBe(0);
  });

  it('veterans set up faster than green crews', () => {
    expect(setupTimeS('pak40', 90)).toBeLessThan(setupTimeS('pak40', 20));
    expect(setupTimeS('mortar81', 50)).toBeCloseTo(7, 5);
    expect(setupTimeS('mg42_hmg', 50)).toBeCloseTo(7, 5);
    expect(setupTimeS('pak40', 50)).toBeCloseTo(7, 5);
  });
});

describe('crew-served weapons: placement and abandonment', () => {
  it('pivotFromGunner and weaponFramePoint are inverse for every facing', () => {
    for (let f = 0; f < 16; f++) {
      const facing = (f * Math.PI) / 8;
      const g = { x: 10.3, y: 20.7 };
      const pivot = pivotFromGunner('atgun', g, facing);
      const back = weaponFramePoint(pivot, facing, CREW_LAYOUT.atgun.gunner);
      expect(dist(back, g)).toBeLessThan(1e-9);
    }
  });

  it('a fleeing crew leaves the gun where it stands; the gunner re-mans it when he comes back', () => {
    const { battle, team, gunner } = setup('ger_pak38', 'pak38');
    battle.step(SIM_DT);
    const cw = team.crewWeapon!;
    const gunPos = { ...cw.pos };
    gunner.activity = 'panicked';
    gunner.mind.state = 'panicked';
    stepCrewWeapons(battle.state, SIM_DT);
    expect(cw.abandoned).toBe(true);
    // he runs off; the gun does not follow
    gunner.pos = { x: gunner.pos.x + 8, y: gunner.pos.y };
    stepCrewWeapons(battle.state, SIM_DT);
    expect(dist(cw.pos, gunPos)).toBeLessThan(1e-9);
    gunner.fireTimer = 0;
    gunner.activity = 'idle';
    gunner.mind.state = 'calm';
    stepCrewWeapons(battle.state, SIM_DT);
    expect(gunner.fireTimer).toBeGreaterThan(0); // cannot fire the gun from 16 m away
    // back beside the gun: re-manned; the work done on it stands, he only has to lay it again
    gunner.pos = weaponFramePoint(cw.pos, cw.facing, CREW_LAYOUT.atgun.gunner);
    gunner.path = [];
    stepCrewWeapons(battle.state, SIM_DT);
    expect(cw.abandoned).toBe(false);
    expect(cw.phase).toBe('ready');
    expect(cw.laid).toBeFalsy();
    expect(dist(cw.pos, gunPos)).toBeLessThan(1e-9);
  });

  it('when the gunner falls the next crewman takes the weapon over', () => {
    const { battle, team, gunner } = setup('ger_mortar81', 'mortar81');
    battle.step(SIM_DT);
    const cw = team.crewWeapon!;
    const mate = team.soldierIds.map((id) => battle.state.soldiers.get(id)!).find((s) => s.id !== gunner.id && !s.isLeader)!;
    gunner.health = 'dead';
    gunner.activity = 'dead';
    mate.pos = { ...cw.pos };
    mate.path = [];
    mate.experience = 95; // the quickest of the crew to take over (crews are no longer all 20-60)
    battle.step(1);
    expect(cw.abandoned).toBe(true);
    battle.step(5);
    expect(cw.abandoned).toBe(false);
    expect(cw.gunnerId).toBe(mate.id);
    expect(mate.weaponId).toBe('mortar81');
  });

  it('the deploy-screen view puts a set-up weapon at the gunner without writing state', () => {
    const battle = new Battle(config(['ger_pak40']));
    const team = battle.selectableTeams('german')[0];
    const view = crewWeaponView(battle.state, team)!;
    expect(view.phase).toBe('ready');
    expect(team.crewWeapon).toBeUndefined();
  });
});
