import { describe, it, expect } from 'vitest';
import { makeState, addTank, soldier, mkTeam } from './vehicleDamageHelpers';
import { stepCombat, stepPendingBursts } from '@/sim/combat';
import { stepCrewWeapons } from '@/sim/crewWeapon';
import { Rng } from '@/shared/rng';
import { SIM_DT } from '@/shared/types';
import type { BattleState, Vec2 } from '@/shared/types';

/** Register a spotted enemy infantry team of `n` men around `pos` (trench cover: they survive a
 * rocket splash, so a whole salvo can walk without the cluster dissolving). */
function addCluster(state: BattleState, n: number, pos: Vec2) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = 900 + i;
    const s = soldier(id, 900, 'soviet', { x: pos.x + i * 0.8, y: pos.y }, 'mosin', { cover: 0.9 });
    state.soldiers.set(id, s);
    state.spotted.german.add(id);
    ids.push(id);
  }
  const team = mkTeam(900, 'rifle', ids, 'soviet', pos);
  state.teams.set(900, team);
  return team;
}

function towedNebel(state: BattleState, pos: Vec2) {
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = soldier(700 + i, 800, 'german', { x: pos.x + i * 0.8, y: pos.y + 1.5 }, i === 0 ? 'nebel41' : 'kar98k', { isLeader: i === 3 });
    s.ammo = i === 0 ? 6 : 20;
    s.ammoReserve = i === 0 ? 30 : 0;
    state.soldiers.set(s.id, s);
    ids.push(s.id);
  }
  const team = mkTeam(800, 'rocket', [ids[3], ...ids.slice(0, 3)], 'german', pos);
  state.teams.set(800, team);
  const gunner = state.soldiers.get(ids[0])!;
  team.crewWeapon = {
    weaponId: 'nebel41', pos: { ...pos }, facing: 0, phase: 'ready', timer: 0, phaseTotal: 0,
    gunnerId: gunner.id, abandoned: false, abandonedAt: 0, setAt: 0,
  };
  return { team, gunner };
}
function run(state: BattleState, seconds: number, rng: Rng) {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    state.time += SIM_DT;
    stepCrewWeapons(state, SIM_DT);
    stepCombat(state, rng, SIM_DT);
    stepPendingBursts(state, rng);
  }
}

describe('item 020 — vehicle-mounted rocket salvos', () => {
  it('a BM-13 walks a full salvo of rail shots at a spotted cluster without any LOS', () => {
    const state = makeState(1943);
    const v = addTank(state, 'bm13', { x: 200.5, y: 300.5 }, 0, 50, 'german').v;
    const target: Vec2 = { x: 200.5, y: 60.5 };
    addCluster(state, 4, target);
    const rng = new Rng(7);
    run(state, 0.1, rng);
    const rockets = state.tracers.filter((t) => t.kind === 'rocket');
    expect(rockets.length).toBe(1);
    expect(v.mainAmmo).toBe(7);
    expect(v.rocketSalvoLeft).toBe(7);
    // the round flies on its own; the HE burst lands ~flightS later (481 m ≈ 5.2 s)
    expect(state.explosions.length).toBe(0);

    // the rest of the salvo: one rail every 0.5 s until the racks are empty
    run(state, 4.2, rng);
    expect(v.mainAmmo).toBe(0);
    expect(v.mainFireTimer).toBeGreaterThan(55);
    run(state, 6.5, rng); // the last rocket's burst lands
    expect(state.explosions.some((e) => e.kind === 'he' && Math.hypot(e.pos.x - target.x, e.pos.y - target.y) < 12)).toBe(true);
    run(state, 2, rng);
    expect(state.tracers.filter((t) => t.kind === 'rocket').length).toBe(8);
  });

  it('rails cannot reach a target behind the launcher: nothing fires and the crew says so', () => {
    const state = makeState(1943);
    // hull faces east; the spotted cluster is due north, outside the mount's 10° arc
    const v = addTank(state, 'bm13', { x: 200.5, y: 300.5 }, Math.PI / 2, 50, 'german').v;
    addCluster(state, 4, { x: 200.5, y: 60.5 });
    const rng = new Rng(7);

    run(state, 30, rng);
    expect(state.tracers.filter((t) => t.kind === 'rocket').length).toBe(0);
    expect(v.mainAmmo).toBe(8);
    const warns = state.messages.filter((m) => m.text.includes('Launch rails cannot reach that bearing'));
    // said at t≈0.1 then re-said every 12 s: 3 warnings in 30 s
    expect(warns.length).toBe(3);
  });

  it('a launcher out of rockets is not a threat: no tracers ever', () => {
    const state = makeState(1943);
    const v = addTank(state, 'bm13', { x: 200.5, y: 300.5 }, 0, 50, 'german').v;
    addCluster(state, 4, { x: 200.5, y: 60.5 });
    v.mainAmmo = 0;
    const rng = new Rng(7);

    run(state, 3, rng);
    expect(state.tracers.filter((t) => t.kind === 'rocket').length).toBe(0);
  });
});

describe('item 020 — towed 15cm Nebelwerfer', () => {
  it('lays, then fires a paced salvo of six, then reloads the next six from the crates', () => {
    const state = makeState(1943);
    const { team, gunner } = towedNebel(state, { x: 200.5, y: 300.5 });
    addCluster(state, 4, { x: 200.5, y: 60.5 });
    const rng = new Rng(11);

    // the lay (range-scaled, ~7-10 s for a 481 m mission) completes, then the first tubes go off
    run(state, 12, rng);
    const rockets = state.tracers.filter((t) => t.kind === 'rocket');
    expect(rockets.length).toBeGreaterThanOrEqual(1);
    expect(gunner.ammo).toBeLessThan(6);

    // tubes empty: the crew loads the next six from the reserve (36 total = six salvos)
    const t0 = state.time;
    let reloaded = false;
    for (let i = 0; i < 2000 && !reloaded && state.time - t0 < 70; i++) {
      state.time += SIM_DT;
      stepCrewWeapons(state, SIM_DT);
      stepCombat(state, rng, SIM_DT);
      if (gunner.ammo === 6 && gunner.ammoReserve === 24) reloaded = true;
    }
    expect(reloaded).toBe(true);
    void team;
  });
});
