// Leaving and re-entering vehicles (spec 2026-09-17 §10).
import { describe, it, expect } from 'vitest';
import type { BattleState, Soldier, Team, Vehicle } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { VEHICLE_DEFS } from '@/data/units';
import { stepVehicles } from '@/sim/vehicle';
import { stepMovement } from '@/sim/movement';
import { stepMinds } from '@/sim/mind';
import { stepCombat } from '@/sim/combat';
import { stepMorale } from '@/sim/morale';
import { applyOrder } from '@/sim/orders';
import { bailOut, crewEffects, ensureDamage, seatOccupant, vehicleLayout, resolveVehicleHit } from '@/sim/vehicleDamage';
import { CLIMB_MIN_S, WILL_NOT_GO_BACK, crewReturnRefusal, isServiceable } from '@/sim/vehicleCrew';
import { WEAPONS } from '@/data/weapons';
import { dist } from '@/shared/math';
import { makeState, addTank, soldier, mkTeam } from './vehicleDamageHelpers';

function step(state: BattleState, rng: Rng, seconds: number, opts: { combat?: boolean; each?: () => void } = {}): void {
  for (let i = 0; i < seconds / SIM_DT; i++) {
    state.time += SIM_DT;
    stepMovement(state, rng, SIM_DT);
    stepVehicles(state, rng, SIM_DT);
    stepMinds(state, rng, SIM_DT);
    if (opts.combat) stepCombat(state, rng, SIM_DT);
    stepMorale(state, rng, SIM_DT);
    opts.each?.();
    state.events.length = 0; state.tracers.length = 0; state.explosions.length = 0;
  }
}
const down = (s: Soldier): boolean => s.health === 'dead' || s.health === 'incapacitated';
const inside = (crew: Soldier[], v: Vehicle): Soldier[] => crew.filter((c) => c.vehicleId === v.id);
const climbing = (crew: Soldier[]): Soldier[] => crew.filter((c) => !!c.hatch);
const stateOf = (v: Vehicle): string => v.state;
const said = (state: BattleState, text: string): boolean => state.messages.some((m) => m.text.includes(text));

function tank(defId = 'pz4gh', experience = 50): { state: BattleState; v: Vehicle; team: Team; crew: Soldier[] } {
  const state = makeState(1943);
  const t = addTank(state, defId, { x: 100, y: 100 }, 0, experience);
  return { state, ...t };
}

describe('bailing out is seen and takes time', () => {
  it('the crew is not outside at once: men come out hatch by hatch over seconds, from the hull to beside it', () => {
    const { state, v, team, crew } = tank();
    const rng = new Rng(1);
    bailOut(state, v, team, 'abandoned');
    expect(v.state).toBe('abandoned');
    expect(said(state, 'Crew bails out!')).toBe(true);
    // the first men are on the hatches, the rest still inside
    expect(climbing(crew).length).toBeGreaterThan(0);
    expect(inside(crew, v).length).toBeGreaterThan(0);
    const def = VEHICLE_DEFS[v.defId];
    for (const c of climbing(crew)) expect(dist(c.pos, v.pos) * TILE_M).toBeLessThan(def.lengthM / 2);
    step(state, rng, 0.5);
    expect(inside(crew, v).length + climbing(crew).length).toBeGreaterThan(0);
    let t = 0.5;
    while ((inside(crew, v).length > 0 || climbing(crew).length > 0) && t < 20) { step(state, rng, 0.1); t += 0.1; }
    // five men through four hatches (the turret crew of three shares two): at least two climbs
    expect(t).toBeGreaterThan(2 * CLIMB_MIN_S * 0.6 - 0.2);
    expect(t).toBeLessThan(12);
    for (const c of crew) {
      expect(c.vehicleId).toBeNull();
      expect(c.hatch).toBeUndefined();
    }
  });

  it('an orderly dismount takes 1.5 to 2.5 s per man and ends kneeling by the vehicle; a panicked one is faster and ends in a run', () => {
    const a = tank('pz4gh', 80);
    bailOut(a.state, a.v, a.team, 'abandoned', null, { panicked: false, cause: 'shortCrew' });
    const first = climbing(a.crew)[0];
    const dur = first.hatch!.until - first.hatch!.start;
    expect(dur).toBeGreaterThanOrEqual(1.5);
    expect(dur).toBeLessThanOrEqual(2.5);
    const rng = new Rng(2);
    step(a.state, rng, dur + 0.1);
    expect(first.hatch).toBeUndefined();
    expect(first.stance).toBe('crouching');
    expect(first.activity).not.toBe('panicked');
    const half = VEHICLE_DEFS[a.v.defId].widthM / 2;
    expect(dist(first.pos, a.v.pos) * TILE_M).toBeGreaterThan(half);
    expect(dist(first.pos, a.v.pos) * TILE_M).toBeLessThan(half + 3);

    const b = tank('pz4gh', 30);
    bailOut(b.state, b.v, b.team, 'abandoned');
    const runner = climbing(b.crew)[0];
    const quick = runner.hatch!.until - runner.hatch!.start;
    expect(quick).toBeLessThan(dur);
    step(b.state, new Rng(2), quick + 0.05);
    expect(runner.hatch).toBeUndefined();
    expect(runner.activity).toBe('panicked');
    step(b.state, new Rng(2), 1);
    expect(dist(runner.pos, b.v.pos) * TILE_M).toBeGreaterThan(VEHICLE_DEFS[b.v.defId].widthM / 2 + 2); // already running

    // a wounded man takes longer
    const c = tank('pz4gh', 80);
    c.crew[0].health = 'wounded';
    bailOut(c.state, c.v, c.team, 'abandoned', null, { panicked: false });
    expect(c.crew[0].hatch!.until - c.crew[0].hatch!.start).toBeGreaterThan(dur * 1.3);
  });

  it('men on the hatches are exposed and can be hit; the men still inside cannot', () => {
    let hitOutside = 0, hitInside = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { state, v, team, crew } = tank();
      bailOut(state, v, team, 'abandoned');
      const out = climbing(crew);
      const still = inside(crew, v);
      expect(out.length).toBeGreaterThan(0);
      expect(still.length).toBeGreaterThan(0);
      for (const c of out) { expect(c.stance).toBe('standing'); expect(c.cover).toBe(0); c.hatch!.until = 1e9; } // held on the hatch for the test
      v.hatchBusyUntil = vehicleLayout(VEHICLE_DEFS[v.defId]).hatches.map(() => 1e9);
      // a Soviet MG 40 m off that sees every one of them
      const ids = [8000, 8001, 8002];
      ids.forEach((id, i) => state.soldiers.set(id, soldier(id, 800, 'soviet', { x: 100 + i, y: 80 }, i === 0 ? 'dp28' : 'mosin', { experience: 70, ammo: 47, ammoReserve: 200 })));
      state.teams.set(800, mkTeam(800, 'rifle', ids, 'soviet', { x: 100, y: 80 }));
      for (const c of out) state.spotted.soviet.add(c.id);
      expect(WEAPONS.dp28).toBeTruthy();
      step(state, new Rng(seed), 25, { combat: true, each: () => { for (const c of out) state.spotted.soviet.add(c.id); } });
      hitOutside += out.filter((c) => c.health !== 'healthy').length;
      hitInside += still.filter((c) => c.vehicleId === v.id && c.health !== 'healthy').length;
    }
    expect(hitOutside).toBeGreaterThan(0);
    expect(hitInside).toBe(0);
  });

  it('never more than one man on a hatch at a time, whatever the vehicle', () => {
    for (const defId of Object.keys(VEHICLE_DEFS)) {
      const { state, v, team, crew } = tank(defId);
      const rng = new Rng(3);
      const hatches = vehicleLayout(VEHICLE_DEFS[defId]).hatches;
      expect(hatches.length).toBeGreaterThan(0);
      bailOut(state, v, team, 'abandoned');
      let maxAtOnce = 0;
      const check = (): void => {
        const per = new Map<number, number>();
        for (const c of climbing(crew)) per.set(c.hatch!.hatch, (per.get(c.hatch!.hatch) ?? 0) + 1);
        for (const n of per.values()) expect(n).toBe(1);
        maxAtOnce = Math.max(maxAtOnce, climbing(crew).length);
      };
      check();
      step(state, rng, 12, { each: check });
      expect(maxAtOnce).toBeLessThanOrEqual(hatches.length);
      expect(crew.every((c) => c.vehicleId === null && !c.hatch)).toBe(true);
    }
  });

  it('a burning vehicle forces everyone out at once, as fast as the hatches allow', () => {
    const rng = new Rng(5);
    let fires = 0;
    for (let i = 0; i < 200 && fires < 10; i++) {
      const { state, v, crew } = tank('t34_76');
      const r = resolveVehicleHit(state, rng, v, { weapon: WEAPONS.kwk40_75, shooterPos: { x: 100, y: 200 }, shooterSide: 'german', distM: 200, location: { zone: 'engineDeck', face: 'rear' } });
      if (r.outcome !== 'fire') continue;
      fires++;
      expect(v.state).toBe('burning');
      expect(v.exiting?.fire).toBe(true);
      step(state, rng, 6);
      for (const c of crew) if (!down(c)) { expect(c.vehicleId).toBeNull(); expect(c.hatch).toBeUndefined(); }
    }
    expect(fires).toBeGreaterThan(3);
  });
});

describe('an abandoned vehicle is re-manned by its own crew', () => {
  it('keeps its damage and ammunition, and a panicked crew does not go back until it is calm again', () => {
    const { state, v, team, crew } = tank('pz4gh', 45);
    const rng = new Rng(7);
    ensureDamage(v).radio = 'destroyed';
    v.mainAmmo = 31;
    bailOut(state, v, team, 'abandoned');
    // kept frightened for a minute and a half: nobody goes near the tank
    step(state, rng, 90, { each: () => { for (const c of crew) { c.mind.stress = 95; c.morale = 40; } } });
    expect(v.state).toBe('abandoned');
    expect(v.remount).toBeUndefined();
    expect(crew.every((c) => c.vehicleId === null)).toBe(true);
    expect(crewReturnRefusal(state, v, false)).toBe('notCalm');
    expect(team.outOfAction).toBe(false);
    expect(team.status).toBe('Abandoned');
    // left alone they calm down, walk back and climb in
    let t = 0;
    while (stateOf(v) === 'abandoned' && t < 240) { step(state, rng, 1); t += 1; }
    expect(v.state).toBe('ok');
    expect(said(state, `Crew returns to the ${VEHICLE_DEFS[v.defId].name}.`)).toBe(true);
    expect(crew.every((c) => c.vehicleId === v.id)).toBe(true);
    expect(v.damage?.radio).toBe('destroyed');
    expect(v.mainAmmo).toBe(31);
    expect(crewEffects(state, v).canDrive).toBe(true);
  });

  it('veterans go back sooner than recruits', () => {
    const back = (experience: number): number => {
      const { state, v, team } = tank('pz4gh', experience);
      const rng = new Rng(8);
      bailOut(state, v, team, 'abandoned', null, { cause: 'penetration' });
      let t = 0;
      while (stateOf(v) === 'abandoned' && t < 600) { step(state, rng, 1); t += 1; }
      return t;
    };
    const vet = back(85), green = back(25);
    expect(vet).toBeLessThan(green);
    expect(green).toBeLessThan(600);
  });

  it('a calm veteran crew re-enters a tank with a dead engine and fires the gun from it', () => {
    const { state, v, team, crew } = tank('pz4gh', 85);
    const rng = new Rng(9);
    ensureDamage(v).engine = 'destroyed';
    v.state = 'immobilized';
    crew[3].health = 'dead'; // the driver
    bailOut(state, v, team, 'abandoned', null, { panicked: false, cause: 'shortCrew' });
    expect(isServiceable(v)).toBe(true);
    let t = 0;
    while (stateOf(v) === 'abandoned' && t < 300) { step(state, rng, 1); t += 1; }
    expect(v.state).toBe('immobilized');
    // a pillbox: the gun is manned, nobody wastes himself on the driver's seat
    expect(seatOccupant(state, v, 'gunner')).not.toBeNull();
    expect(seatOccupant(state, v, 'loader')).not.toBeNull();
    step(state, rng, 30);
    expect(seatOccupant(state, v, 'driver')).toBeNull();
    expect(v.seatSwap).toBeUndefined();
    const enemy = addTank(state, 't34_76', { x: 100, y: 20 }, Math.PI, 50);
    state.spottedVehicles.german.add(enemy.v.id);
    const before = v.mainAmmo;
    step(state, rng, 40, { combat: true, each: () => { state.spottedVehicles.german.add(enemy.v.id); } });
    expect(v.mainAmmo).toBeLessThan(before);
  });

  it('with the gun wrecked but the engine running the driver\'s seat is filled first', () => {
    const { state, v, team, crew } = tank('pz4gh', 85);
    const rng = new Rng(10);
    ensureDamage(v).mainGun = 'destroyed';
    crew[0].health = 'dead'; crew[1].health = 'dead'; crew[3].health = 'dead'; // commander, gunner, driver
    bailOut(state, v, team, 'abandoned', null, { panicked: false, cause: 'shortCrew' });
    let t = 0;
    while (stateOf(v) === 'abandoned' && t < 300) { step(state, rng, 1); t += 1; }
    expect(v.state).toBe('ok');
    expect(seatOccupant(state, v, 'driver')).not.toBeNull();
    expect(seatOccupant(state, v, 'gunner')).toBeNull();
    expect(crewEffects(state, v).canDrive).toBe(true);
  });

  it('nobody re-enters a burning or a gutted vehicle, even when ordered to', () => {
    // burning
    const a = tank('pz4gh', 85);
    const rng = new Rng(11);
    bailOut(a.state, a.v, a.team, 'burning', null);
    step(a.state, rng, 100);
    expect(a.crew.every((c) => c.vehicleId === null)).toBe(true);
    applyOrder(a.state, a.team, { type: 'move', target: { ...a.v.pos }, issuedAt: a.state.time }, rng);
    step(a.state, rng, 30);
    expect(a.crew.every((c) => c.vehicleId === null)).toBe(true);
    expect(['burning', 'knockedOut']).toContain(a.v.state);
    // gutted: nothing useful left
    const b = tank('pz4gh', 85);
    const d = ensureDamage(b.v);
    d.engine = 'destroyed'; d.mainGun = 'destroyed'; d.coaxMg = 'destroyed'; d.bowMg = 'destroyed';
    expect(isServiceable(b.v)).toBe(false);
    bailOut(b.state, b.v, b.team, 'abandoned', null, { panicked: false });
    step(b.state, rng, 200);
    expect(b.v.state).toBe('abandoned');
    expect(b.team.outOfAction).toBe(true);
    applyOrder(b.state, b.team, { type: 'move', target: { ...b.v.pos }, issuedAt: b.state.time }, rng);
    step(b.state, rng, 30);
    expect(b.crew.every((c) => c.vehicleId === null)).toBe(true);
    // knocked out by the hit that drove them out
    const c = tank('pz4gh', 85);
    bailOut(c.state, c.v, c.team, 'knockedOut', null);
    step(c.state, rng, 200);
    expect(c.crew.every((m) => m.vehicleId === null)).toBe(true);
    expect(c.v.state).toBe('knockedOut');
  });

  it('a known gun with a line of fire keeps them out; once it is believed gone they go back', () => {
    const { state, v, team, crew } = tank('pz3j', 50);
    const rng = new Rng(12);
    const enemy = addTank(state, 't34_76', { x: 100, y: 40 }, Math.PI, 50);
    enemy.v.mainAmmo = 0; enemy.v.coaxAmmo = 0; // it only has to be there
    state.spottedVehicles.german.add(enemy.v.id);
    bailOut(state, v, team, 'abandoned', null, { panicked: false, cause: 'shortCrew' });
    step(state, rng, 120, { each: () => { state.spottedVehicles.german.add(enemy.v.id); } });
    expect(v.state).toBe('abandoned');
    expect(crewReturnRefusal(state, v, false)).toBe('threat');
    expect(crew.every((c) => c.vehicleId === null)).toBe(true);
    // the T-34 drives off and is lost from sight
    state.spottedVehicles.german.delete(enemy.v.id);
    enemy.v.pos = { x: 300, y: 300 };
    let t = 0;
    while (stateOf(v) === 'abandoned' && t < 300) { step(state, rng, 1); t += 1; }
    expect(v.state).toBe('ok');
  });

  it('recruits who lost a comrade to a penetrating hit may refuse for the rest of the battle', () => {
    const rng = new Rng(13);
    let refused = 0, abandoned = 0;
    for (let i = 0; i < 400; i++) {
      const { state, v } = tank('t34_76', 20);
      const r = resolveVehicleHit(state, rng, v, { weapon: WEAPONS.kwk40_75, shooterPos: { x: 100, y: 0 }, shooterSide: 'german', distM: 200, location: { zone: 'turretFront', face: 'front' } });
      if (!r.penetrated || v.state !== 'abandoned') continue;
      abandoned++;
      if (!v.noReturn) continue;
      refused++;
      if (refused > 3) continue;
      step(state, rng, 400);
      expect(v.state).toBe('abandoned');
      expect(crewReturnRefusal(state, v, true)).toBe('refuses');
    }
    expect(abandoned).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(abandoned);
  });
});

describe('ordering the crew back', () => {
  it('a Move order onto their own vehicle is refused while they are shaken, and obeyed once they are calm', () => {
    const { state, v, team, crew } = tank('pz4gh', 30);
    const rng = new Rng(14);
    bailOut(state, v, team, 'abandoned');
    step(state, rng, 4);
    expect(crew.some((c) => c.mind.state === 'panicked' || c.mind.state === 'cowering' || c.mind.state === 'shaken')).toBe(true);
    applyOrder(state, team, { type: 'move', target: { x: v.pos.x + 0.5, y: v.pos.y }, issuedAt: state.time }, rng);
    expect(said(state, `${team.name}\n${WILL_NOT_GO_BACK}`)).toBe(true);
    expect(v.remount).toBeUndefined();
    // they would not go back on their own for a long time yet; the order is enough once they are calm
    v.crewShockUntil = 1e9;
    let t = 0;
    while (!crew.every((c) => c.mind.state === 'calm' || c.mind.state === 'alert') && t < 200) { step(state, rng, 1); t += 1; }
    expect(v.state).toBe('abandoned');
    state.messages.length = 0;
    applyOrder(state, team, { type: 'move', target: { ...v.pos }, issuedAt: state.time }, rng);
    expect(said(state, WILL_NOT_GO_BACK)).toBe(false);
    expect(v.remount?.ordered).toBe(true);
    t = 0;
    while (stateOf(v) === 'abandoned' && t < 120) { step(state, rng, 1); t += 1; }
    expect(v.state).toBe('ok');
    // a Move order somewhere else is not a re-man order
    const far = tank('pz4gh', 45);
    bailOut(far.state, far.v, far.team, 'abandoned');
    applyOrder(far.state, far.team, { type: 'move', target: { x: 160, y: 160 }, issuedAt: 0 }, rng);
    expect(said(far.state, WILL_NOT_GO_BACK)).toBe(false);
  });
});

describe('determinism', () => {
  it('the same seed gives the same bail-out and return, man for man', () => {
    const run = (): string => {
      const { state, v, team } = tank('pz4gh', 45);
      const b = addTank(state, 't34_76', { x: 110, y: 40 }, Math.PI, 60);
      state.spottedVehicles.german.add(b.v.id);
      state.spottedVehicles.soviet.add(v.id);
      const rng = new Rng(99);
      step(state, rng, 20, { combat: true });
      if (v.state === 'ok' || v.state === 'immobilized') bailOut(state, v, team, 'abandoned');
      step(state, rng, 200, { combat: true });
      return JSON.stringify([Array.from(state.vehicles.values()), Array.from(state.soldiers.values()).map((s) => [s.id, s.health, s.vehicleId, s.pos, s.hatch, s.mind.state]), state.messages]);
    };
    expect(run()).toBe(run());
  });
});

describe('daze and remounting', () => {
  it('a calm crew with a dazed man does not go back, ordered or not; nobody dazed is sent to a hatch', () => {
    const { state, v, team, crew } = tank('pz4gh', 85);
    const rng = new Rng(9);
    bailOut(state, v, team, 'abandoned', null, { panicked: false, cause: 'shortCrew' });
    let t = 0;
    while (crew.some((c) => c.hatch || c.vehicleId != null) && t < 60) { step(state, rng, 0.5); t += 0.5; }
    v.remount = undefined; v.crewShockUntil = undefined;
    for (const c of crew) { c.mind.state = 'calm'; c.mind.stress = 0; }
    crew[1].dazedUntil = state.time + 30;
    expect(crew[1].stunnedUntil == null || crew[1].stunnedUntil <= state.time).toBe(true);
    expect(crewReturnRefusal(state, v, false)).toBe('notCalm');
    expect(crewReturnRefusal(state, v, true)).toBe('notCalm');
    // a return already under way: the dazed man is not sent to a hatch while the others climb in
    v.remount = { ordered: true } as NonNullable<Vehicle['remount']>;
    step(state, rng, 3);
    expect(crew[1].hatch).toBeUndefined();
    expect(crew[1].vehicleId).toBeNull();
    crew[1].dazedUntil = undefined;
    expect(crewReturnRefusal(state, v, true) === null || v.remount != null).toBe(true);
  });
});
