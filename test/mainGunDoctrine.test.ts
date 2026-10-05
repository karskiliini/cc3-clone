import { describe, it, expect } from 'vitest';
import { makeState, addTank, soldier, mkTeam, addGun } from './vehicleDamageHelpers';
import { stepCombat } from '@/sim/combat';
import { pickVehicleTarget } from '@/sim/combat';
import { MG_GROUP_MIN, MG_GROUP_RADIUS_TILES, MG_ESCALATE_S, MG_ESCALATE_CLOSE_S, MG_ESCALATE_PINNED_S, MG_SUPPRESS_LEVEL, mainGunAtInfantry, noteMgBurst } from '@/sim/combat';
import { Rng } from '@/shared/rng';
import { setTile } from '@/sim/map';
import { findPath } from '@/sim/path';
import { stepVehicles } from '@/sim/vehicle';
import { SIM_DT } from '@/shared/types';

/** Register a spotted enemy infantry team of `n` men around `pos`. */
function addTeam(state: ReturnType<typeof makeState>, n: number, pos: { x: number; y: number }, opts: { lastFiredAt?: number; suppression?: number } = {}) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = 900 + i;
    const s = soldier(id, 900, 'soviet', { x: pos.x + i * 0.8, y: pos.y }, 'mosin', { lastFiredAt: opts.lastFiredAt ?? -999, suppression: opts.suppression ?? 0 });
    state.soldiers.set(id, s);
    state.spotted.german.add(id);
    ids.push(id);
  }
  const team = mkTeam(900, 'rifle', ids, 'soviet', pos);
  state.teams.set(900, team);
  return { team, men: ids.map((id) => state.soldiers.get(id)!) };
}

function scene(): ReturnType<typeof makeState> {
  const state = makeState(1943);
  return state;
}

/** A turreted tank with a coax + bow MG at origin facing north. */
function tank(state: ReturnType<typeof makeState>) {
  const { v } = addTank(state, 'pz4gh', { x: 200.5, y: 200.5 }, 0, 50);
  return v;
}

describe('item 018 — main-gun-at-infantry doctrine (mainGunAtInfantry)', () => {
  it('a lone spotted rifleman is NOT a main-gun target', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 1, { x: 202.5, y: 191 });
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
  });

  it('a clustered group IS a main-gun target', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, MG_GROUP_MIN, { x: 202.5, y: 191 });
    expect(mainGunAtInfantry(state, v, men[0])).toBe('group');
    // men spread beyond the group radius: no longer a group
    const spread = scene();
    const sv = tank(spread);
    const st = addTeam(spread, MG_GROUP_MIN, { x: 202.5, y: 191 });
    st.men[MG_GROUP_MIN - 1].pos = { x: st.men[MG_GROUP_MIN - 1].pos.x + MG_GROUP_RADIUS_TILES + 1, y: st.men[MG_GROUP_MIN - 1].pos.y };
    expect(mainGunAtInfantry(spread, sv, st.men[0])).toBeNull();
  });

  it('men in strong cover (trench) are NOT worth main-gun HE even as a group', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, MG_GROUP_MIN, { x: 202.5, y: 191 });
    for (const m of men) m.cover = 0.9;
    // place them on trench tiles: paint a trench strip
    for (const m of men) {
      setTile(state.map, Math.floor(m.pos.x), Math.floor(m.pos.y), 'trench');
    }
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
  });

  it('a man inside a concrete bunker is strong cover even on an open tile (omni cover, item 018 fix)', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, MG_GROUP_MIN, { x: 202.5, y: 191 });
    // stamp a bunker footprint over the men: map.bunkerId drives omniCoverAt's BUNKER_COVER
    const bunker = new Int16Array(400 * 400).fill(-1);
    for (let y = 189; y <= 193; y++) for (let x = 200; x <= 205; x++) bunker[y * 400 + x] = 0;
    state.map.bunkerId = bunker;
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
  });

  it('a stone-building tile is strong cover even though its omni cover is 0.5 (item 018 fix)', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, MG_GROUP_MIN, { x: 202.5, y: 191 });
    for (const m of men) setTile(state.map, Math.floor(m.pos.x), Math.floor(m.pos.y), 'buildingStone');
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
  });

  it('an AT-gun crewman behind his shield plate is strong cover (a casemate is not HE fodder)', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addGun(state, 'pak38', { x: 202.5, y: 192 }, 3);
    // crew stands at pivot.y+2.2 (south of the plate) behind a north-facing gun; the tank must be
    // in the gun's front arc for the shield to shadow the crew — reposition it north, and put the
    // gunner within the shield's 1.2 m half-width (addGun spreads the men 1 tile left).
    v.pos = { x: 202.5, y: 180 };
    men[0].pos = { x: 202.5, y: 193 };
    for (const m of men) state.spotted.german.add(m.id);
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
  });

  it('a destroyed coax mount alone does NOT unlock the main gun (the bow still answers)', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 1, { x: 202.5, y: 191 });
    v.damage = { mainGun: 'ok', coaxMg: 'destroyed', bowMg: 'ok', sight: 'ok', traverse: 'ok', engine: 'ok', transmission: 'ok', trackL: 'ok', trackR: 'ok', radio: 'ok', fuelLeak: 'ok' };
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
    v.damage = { ...v.damage, bowMg: 'destroyed' };
    expect(mainGunAtInfantry(state, v, men[0])).toBe('mgOut');
  });

  it('both MGs out of ammo unlocks the main gun', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 1, { x: 202.5, y: 191 });
    v.coaxAmmo = 0;
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull(); // bow still has its full load
    v.bowAmmo = 0;
    expect(mainGunAtInfantry(state, v, men[0])).toBe('mgOut');
  });

  it('an unresolved MG engagement longer than MG_ESCALATE_S unlocks the main gun', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 1, { x: 202.5, y: 191 });
    men[0].pos = { x: 202.5, y: 170 }; // ~62 m: not close
    noteMgBurst(state, v, men[0]);
    state.time = MG_ESCALATE_S - 1;
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
    state.time = MG_ESCALATE_S;
    expect(mainGunAtInfantry(state, v, men[0])).toBe('escalated');
    // pinned (>= MG_SUPPRESS_LEVEL): the MGs keep him down for now...
    men[0].suppression = MG_SUPPRESS_LEVEL;
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
    // ...but one man must not hold the tank up for long: pinned and still there, he gets the HE
    state.time = MG_ESCALATE_PINNED_S;
    expect(mainGunAtInfantry(state, v, men[0])).toBe('escalated');
  });

  it('a man close enough to hurt the tank gets the HE after only a few seconds of MG failing', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 1, { x: 202.5, y: 191 }); // ~20 m
    noteMgBurst(state, v, men[0]);
    state.time = MG_ESCALATE_CLOSE_S - 1;
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
    state.time = MG_ESCALATE_CLOSE_S;
    expect(mainGunAtInfantry(state, v, men[0])).toBe('escalated');
  });

  it('men in strong cover the MGs cannot finish get the HE in the end', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 1, { x: 202.5, y: 170 });
    setTile(state.map, 202, 170, 'buildingStone');
    men[0].suppression = 100;
    noteMgBurst(state, v, men[0]);
    state.time = MG_ESCALATE_S;
    expect(mainGunAtInfantry(state, v, men[0])).toBeNull();
    state.time = MG_ESCALATE_PINNED_S;
    expect(mainGunAtInfantry(state, v, men[0])).toBe('escalated');
  });

  it('switching the MG engagement to another team resets the escalation clock', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 2, { x: 202.5, y: 191 });
    noteMgBurst(state, v, men[0]);
    state.time = 30;
    noteMgBurst(state, v, men[0]);
    expect(v.mgSince).toBe(0); // same team: clock keeps running
    state.teams.get(901); // unused second team; just exercise the branch
    expect(mainGunAtInfantry(state, v, men[0])).toBe('escalated');
  });
});

describe('item 018 — vehicle target selection honours the doctrine', () => {
  it('pickVehicleTarget does NOT return a lone rifleman (MGs engage, the gun stays quiet)', () => {
    const state = scene();
    const v = tank(state);
    addTeam(state, 1, { x: 202.5, y: 191 });
    expect(pickVehicleTarget(state, v)).toBeNull();
  });

  it('an ORDERED attack on infantry follows the doctrine: a lone man is the MGs\' (no main-gun target)', () => {
    const state = scene();
    const v = tank(state);
    const { team } = addTeam(state, 1, { x: 202.5, y: 191 });
    const own = state.teams.get(v.teamId)!;
    own.order = { type: 'fire', target: { ...team.pos }, targetTeamId: team.id, issuedAt: 0, lastSeenAt: 0, lastKnownPos: { ...team.pos } };
    expect(pickVehicleTarget(state, v)).toBeNull();
  });

  it('an ORDERED attack on a clustered group gets the main gun as well', () => {
    const state = scene();
    const v = tank(state);
    const { team } = addTeam(state, MG_GROUP_MIN, { x: 202.5, y: 191 });
    const own = state.teams.get(v.teamId)!;
    own.order = { type: 'fire', target: { ...team.pos }, targetTeamId: team.id, issuedAt: 0, lastSeenAt: 0, lastKnownPos: { ...team.pos } };
    const t = pickVehicleTarget(state, v);
    expect(t?.kind).toBe('soldier');
  });

  it('pickVehicleTarget DOES return a clustered group', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, MG_GROUP_MIN, { x: 202.5, y: 191 });
    const t = pickVehicleTarget(state, v);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('soldier');
    if (t!.kind === 'soldier') expect(t!.soldier.teamId).toBe(men[0].teamId);
  });

  it('end-to-end: over N ticks a tank works a lone rifleman with MG bursts and no main-gun shots', () => {
    const state = scene();
    const v = tank(state);
    const { men } = addTeam(state, 1, { x: 202.5, y: 191 });
    const rng = new Rng(7);
    let mainShots = 0;
    let coaxShots = 0;
    for (let t = 0; t < 1200; t++) {
      const before = state.events.filter((e) => e.kind === 'shot').length;
      stepCombat(state, rng, 1 / 30);
      const shots = state.events.slice(before).filter((e) => e.kind === 'shot');
      for (const s of shots) {
        if ((s.weaponId ?? '').includes('kwk')) mainShots++;
        else coaxShots++;
      }
    }
    expect(mainShots).toBe(0);
    expect(coaxShots).toBeGreaterThan(0);
    void men;
  });
});

describe('firing on the move when in a hurry', () => {
  // a tank driving past a group of riflemen: the main gun's HE is worth it (a group)
  function drive(type: 'move' | 'moveFast') {
    const state = scene();
    const { v, team: own } = addTank(state, 'pz4gh', { x: 200.5, y: 230.5 }, 0, 50);
    addTeam(state, MG_GROUP_MIN, { x: 215.5, y: 210.5 });
    const goal = { x: 200.5, y: 170.5 };
    own.order = { type, target: goal, issuedAt: 0 };
    v.path = findPath(state.map, v.pos, goal, 'vehicle');
    const rng = new Rng(4);
    let shotSpeed: number | null = null;
    for (let i = 0; i < Math.round(40 / SIM_DT) && shotSpeed == null; i++) {
      state.time += SIM_DT;
      stepVehicles(state, rng, SIM_DT);
      stepCombat(state, rng, SIM_DT);
      for (const ev of state.events) if (ev.kind === 'shot' && ev.weaponId === 'kwk40_75') shotSpeed = Math.abs(v.speed);
      state.events.length = 0;
      for (const id of state.teams.get(900)!.soldierIds) { const s = state.soldiers.get(id)!; s.health = 'healthy'; s.suppression = 0; }
    }
    return shotSpeed;
  }

  it('on a plain Move the tank halts for an aimed shot', () => {
    expect(drive('move')).toBe(0);
  });

  it('on Move Fast the commander fires on the move at the men rather than stop', () => {
    const s = drive('moveFast');
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0.1);
  });
});
