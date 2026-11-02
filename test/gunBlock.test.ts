import {refreshWeaponSight,withWeaponSight,stepCombatWithSight} from './fixtures/weaponSight';
const stepCombat=stepCombatWithSight;
const pickVehicleTarget=withWeaponSight(rawPickVehicleTarget);
const orderedVehicleGunTarget=withWeaponSight(rawOrderedVehicleGunTarget);
const orderedGunBlock=withWeaponSight(rawOrderedGunBlock);
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { stepVehicles } from '@/sim/vehicle';
import { stepCombat as rawStepCombat, pickVehicleTarget as rawPickVehicleTarget } from '@/sim/combat';
import { stepMorale } from '@/sim/morale';
import { SIGHT_DESTROYED_MAX_M, ensureDamage } from '@/sim/vehicleDamage';
import { orderedVehicleGunTarget as rawOrderedVehicleGunTarget } from '@/sim/vehicleGunTarget';
import { gunBlockText, mainGunBlock, orderedGunBlock as rawOrderedGunBlock } from '@/sim/gunBlock';
import { targetableEnemyAt, targetStatusText } from '@/ui/targetHover';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';

/** A StuG at (200, 360) facing north, a T-34 `rangeT` tiles north of it facing it. */
function setup(rangeT = 200) {
  const state = makeState(1943);
  const stug = addTank(state, 'stug3g', { x: 200.5, y: 360.5 }, 0, 60, 'german');
  const t34 = addTank(state, 't34_76', { x: 200.5, y: 360.5 - rangeT }, Math.PI, 60, 'soviet');
  t34.team.order = { type: 'defend', target: t34.v.pos, issuedAt: 0 };
  state.spottedVehicles.german.add(t34.v.id);
  return { state, stug, t34 };
}

describe('why a vehicle main gun cannot fire', () => {
  it('a sound StuG can fire at a T-34 400 m ahead', () => {
    const { state, stug, t34 } = setup();
    expect(mainGunBlock(state, stug.v, t34.v.pos)).toBeNull();
  });

  it('a destroyed sight leaves only point-blank fire over the barrel', () => {
    const { state, stug, t34 } = setup();
    ensureDamage(stug.v).sight = 'destroyed';
    expect(mainGunBlock(state, stug.v, t34.v.pos)).toBe('sightOut');
    expect(mainGunBlock(state, stug.v, { x: 200.5, y: 330.5 })).toBeNull();   // 60 m
    expect(gunBlockText('sightOut')).toMatch(/sight/i);
  });

  it('a destroyed gun, no rounds left, or a target beyond the gun\'s range', () => {
    const a = setup();
    ensureDamage(a.stug.v).mainGun = 'destroyed';
    expect(mainGunBlock(a.state, a.stug.v, a.t34.v.pos)).toBe('gunDestroyed');
    const b = setup();
    b.stug.v.mainAmmo = 0; b.stug.v.loadedRound = undefined;
    expect(mainGunBlock(b.state, b.stug.v, b.t34.v.pos)).toBe('noAmmo');
    const c = setup();
    expect(mainGunBlock(c.state, c.stug.v, { x: 200.5, y: -400 })).toBe('outOfRange');   // 1520 m, past the L/48's 1400
  });

  it('an immobilised StuG cannot swing its gun onto a target off to its side; a mobile one can', () => {
    const { state, stug } = setup();
    const east = { x: 300.5, y: 360.5 };
    expect(mainGunBlock(state, stug.v, east)).toBeNull();
    ensureDamage(stug.v).trackL = 'destroyed';
    expect(mainGunBlock(state, stug.v, east)).toBe('cantBear');
  });

  it('ordered to fire and unable to: one message saying why, "Can\'t Fire" status, no shot', () => {
    const { state, stug, t34 } = setup();
    ensureDamage(stug.v).sight = 'destroyed';
    stug.team.order = { type: 'fire', target: { ...t34.v.pos }, targetTeamId: t34.team.id, targetVehicleId: t34.v.id, issuedAt: 0 };
    const rng = new Rng(3);
    let shots = 0;
    for (let i = 0; i < 150; i++) {
      state.time += SIM_DT; state.events.length = 0;
      state.spottedVehicles.german.add(t34.v.id);
      stepVehicles(state, rng, SIM_DT); stepCombat(state, rng, SIM_DT); stepMorale(state, rng, SIM_DT);
      shots += state.events.filter((e) => e.kind === 'shot' && e.side === 'german' && e.weaponId === 'stuk40').length;
    }
    expect(shots).toBe(0);
    const msgs = state.messages.filter((m) => m.side === 'german' && /can't fire/i.test(m.text));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/sight/i);
    expect(stug.team.status).toBe("Can't Fire");
  });

  it('hovering the target with the StuG selected says why it cannot fire', () => {
    const { state, stug, t34 } = setup();
    ensureDamage(stug.v).sight = 'destroyed';
    const h = targetableEnemyAt(state, 'german', [stug.team], t34.v.pos)!;
    expect(targetStatusText(h)).toBe(gunBlockText('sightOut'));
  });
});


describe('ordered infantry target agreement', () => {
  function infantry() {
    const state = makeState(1943), tank = addTank(state, 't34_76', { x: 100, y: 100 }, 0, 60, 'german');
    tank.v.coaxAmmo = 0; tank.v.bowAmmo = 0;
    const prone = soldier(900, 900, 'soviet', { x: 100, y: 95 }, 'mosin', { stance: 'prone' });
    const standing = soldier(901, 900, 'soviet', { x: 100, y: 95 }, 'mosin', { stance: 'standing' });
    state.soldiers.set(900, prone); state.soldiers.set(901, standing);
    const team = mkTeam(900, 'rifle', [900, 901], 'soviet', standing.pos);
    state.teams.set(900, team); state.spotted.german.add(900); state.spotted.german.add(901);
    tank.team.order = { type: 'fire', target: { x: 100, y: 80 }, targetTeamId: 900, issuedAt: 0, lastSeenAt: 0 };
    return { state, tank, prone, standing, team };
  }
  it('uses the combat exposure winner and its stance height for order and cursor', () => {
    const { state, tank, prone, standing } = infantry();
    expect(mainGunBlock(state, tank.v, prone.pos, 0.45)).toBe('elevation');
    expect(pickVehicleTarget(state, tank.v)).toMatchObject({kind:'soldier',soldier:{id:standing.id,pos:standing.pos,stance:standing.stance}});
    expect(orderedGunBlock(state, tank.v, tank.team.order!)).toBeNull();
    const hover = targetableEnemyAt(state, 'german', [tank.team], standing.pos)!;
    expect(hover.lof).toBe(true); expect(hover.block).toBeUndefined();
  });
  it('never uses the live position of an unspotted first member', () => {
    const { state, tank, prone, standing } = infantry();
    state.spotted.german.delete(prone.id); prone.pos = { x: 100, y: 99 };
    expect(pickVehicleTarget(state, tank.v)).toMatchObject({kind:'soldier',soldier:{id:standing.id,pos:standing.pos,stance:standing.stance}});
    expect(orderedGunBlock(state, tank.v, tank.team.order!)).toBeNull();
  });
  it('keeps tie order and chooses exposure independently for each firing vehicle', () => {
    const { state, tank, prone, standing } = infantry();
    prone.stance = 'standing';
    expect(orderedVehicleGunTarget(state, tank.v, tank.team.order!)).toMatchObject({kind:'soldier',soldier:{id:prone.id,pos:prone.pos,stance:prone.stance}});
    prone.pos = { x: 100, y: 80 }; standing.pos = { x: 120, y: 80 };
    const other = addTank(state, 't34_76', { x: 120, y: 100 }, 0, 60, 'german');
    other.v.coaxAmmo = 0; other.v.bowAmmo = 0;
    other.team.order = tank.team.order;
    expect(orderedVehicleGunTarget(state, tank.v, tank.team.order!)).toMatchObject({kind:'soldier',soldier:{id:prone.id,pos:prone.pos,stance:prone.stance}});
    expect(orderedVehicleGunTarget(state, other.v, other.team.order!)).toMatchObject({kind:'soldier',soldier:{id:standing.id,pos:standing.pos,stance:standing.stance}});
    expect(pickVehicleTarget(state, tank.v)).toMatchObject({kind:'soldier',soldier:{id:prone.id,pos:prone.pos,stance:prone.stance}});
    expect(pickVehicleTarget(state, other.v)).toMatchObject({kind:'soldier',soldier:{id:standing.id,pos:standing.pos,stance:standing.stance}});
    const hover = targetableEnemyAt(state, 'german', [tank.team, other.team], standing.pos)!;
    expect(hover.lof).toBe(true); expect(hover.block).toBeUndefined();
    const lastObservedCentre={x:(prone.pos.x+standing.pos.x)/2,y:(prone.pos.y+standing.pos.y)/2};
    state.spotted.german.clear();
    expect(orderedVehicleGunTarget(state, tank.v, tank.team.order!)).toEqual({ kind: 'point', pos: lastObservedCentre });
    expect(orderedGunBlock(state, tank.v, tank.team.order!)).toBeNull();
  });
  it('keeps an unseen hull at the last-known order point, including legacy vehicle-id previews', () => {
    const { state, tank } = infantry();
    const hidden = addTank(state, 'pz4gh', { x: 100, y: 99 }, 0, 60, 'soviet');
    const order = { type: 'fire' as const, target: { x: 100, y: 80 }, targetTeamId: hidden.team.id, targetVehicleId: hidden.v.id, issuedAt: 0 };
    expect(orderedVehicleGunTarget(state, tank.v, order)).toEqual({ kind: 'point', pos: order.target });
    expect(orderedGunBlock(state, tank.v, order)).toBeNull();
    expect(orderedVehicleGunTarget(state, tank.v, { ...order, targetTeamId: undefined })).toEqual({ kind: 'point', pos: order.target });
  });
  it('uses only the last-known point during suppression and gives no warning during hold or MG-only engagement', () => {
    const { state, tank, prone, standing } = infantry();
    prone.pos={x:100,y:80};standing.pos={...prone.pos};refreshWeaponSight(state);state.spotted.german.clear();
    state.time = 2; prone.pos = { x: 100, y: 99 }; standing.pos = prone.pos;
    expect(pickVehicleTarget(state, tank.v)).toMatchObject({ kind: 'point', pos: tank.team.order!.target });
    expect(orderedGunBlock(state, tank.v, tank.team.order!)).toBeNull();
    state.time = 100;
    expect(orderedVehicleGunTarget(state, tank.v, tank.team.order!)).toBeNull();
    expect(orderedGunBlock(state, tank.v, tank.team.order!)).toBeNull();
    state.spotted.german.add(prone.id);state.spotted.german.add(standing.id);
    state.time = 0; tank.v.coaxAmmo = 100; tank.v.bowAmmo = 100;
    expect(pickVehicleTarget(state, tank.v)).toBeNull();
    expect(orderedVehicleGunTarget(state, tank.v, tank.team.order!)).toBeNull();
    expect(orderedGunBlock(state, tank.v, tank.team.order!)).toBeNull();
    expect(targetableEnemyAt(state, 'german', [tank.team], standing.pos)?.block).toBeUndefined();
  });
});


describe('impossible ordered fire diagnostics', () => {
  function ranged() {
    const state = makeState(1943);
    const shooter = addTank(state, 't26', { x: 10, y: 390 }, Math.PI / 4, 60, 'german');
    const enemy = addTank(state, 'pz4gh', { x: 390, y: 10 }, 0, 60, 'soviet');
    state.spottedVehicles.german.add(enemy.v.id);
    shooter.team.order = { type: 'fire', target: { ...enemy.v.pos }, targetTeamId: enemy.team.id, targetVehicleId: enemy.v.id, issuedAt: 0 };
    return { state, shooter, enemy, order: shooter.team.order };
  }
  it('reports out of range for a spotted attack-unit order, status and each selected vehicle cursor', () => {
    const { state, shooter, enemy, order } = ranged();
    expect(orderedVehicleGunTarget(state, shooter.v, order)).toBeNull();
    expect(pickVehicleTarget(state, shooter.v)).toBeNull();
    expect(orderedGunBlock(state, shooter.v, order)).toBe('outOfRange');
    expect(targetStatusText(targetableEnemyAt(state, 'german', [shooter.team], enemy.v.pos)!)).toBe('out of range');
    const rng = new Rng(7);
    state.time += SIM_DT;
    stepCombat(state, rng, SIM_DT); stepMorale(state, rng, SIM_DT);
    expect(shooter.team.status).toBe("Can't Fire");
    expect(state.messages.some(m => m.side === 'german' && m.text.includes("Can't fire: out of range"))).toBe(true);
    const nearer = addTank(state, 't26', { x: 360, y: 40 }, Math.PI / 4, 60, 'german');
    expect(targetableEnemyAt(state, 'german', [shooter.team, nearer.team], enemy.v.pos)!.block).toBeUndefined();
    expect(targetStatusText(targetableEnemyAt(state, 'german', [shooter.team], enemy.v.pos)!)).toBe('out of range');
  });
  it('reports infantry range failure and preserves free-selection absence of a warning', () => {
    const { state, shooter, enemy } = ranged();
    state.spottedVehicles.german.delete(enemy.v.id);
    const man = soldier(900, 900, 'soviet', { x: 390, y: 10 }, 'mosin');
    state.soldiers.set(man.id, man); state.spotted.german.add(man.id);
    const team = mkTeam(900, 'rifle', [man.id], 'soviet', man.pos);
    state.teams.set(team.id, team);
    const order = { type: 'fire' as const, target: { ...man.pos }, targetTeamId: team.id, issuedAt: 0 };
    expect(orderedVehicleGunTarget(state, shooter.v, order)).toBeNull();
    expect(orderedGunBlock(state, shooter.v, order)).toBe('outOfRange');
    const hover = targetableEnemyAt(state, 'german', [shooter.team], man.pos)!;
    expect(hover.team).toBe(team);
    expect(targetStatusText(hover)).toBe('out of range');
    expect(orderedGunBlock(state, shooter.v, { ...order, targetTeamId: 99999 })).toBeNull();
  });
  it.each(['noAmmo', 'gunDestroyed'] as const)('retains %s priority when the attack target is also out of range', reason => {
    const { state, shooter, enemy, order } = ranged();
    if (reason === 'noAmmo') { shooter.v.mainAmmo = 0; shooter.v.loadedRound = undefined; }
    else ensureDamage(shooter.v).mainGun = 'destroyed';
    expect(orderedGunBlock(state, shooter.v, order)).toBe(reason);
    expect(targetStatusText(targetableEnemyAt(state, 'german', [shooter.team], enemy.v.pos)!)).toBe(gunBlockText(reason));
  });
  it('diagnoses an unseen target against only the known order point without making it eligible', () => {
    const { state, shooter, enemy, order } = ranged();
    state.spottedVehicles.german.delete(enemy.v.id);
    enemy.v.pos = { x: 10, y: 389 }; // Its hidden live position would give a different range/height reason.
    expect(orderedVehicleGunTarget(state, shooter.v, order)).toBeNull();
    expect(pickVehicleTarget(state, shooter.v)).toBeNull();
    expect(orderedGunBlock(state, shooter.v, order)).toBe('outOfRange');
  });
});

it('deferred sight status keeps the exact existing range label', () => {
  expect(gunBlockText('sightOut')).toBe(`sight destroyed: ${SIGHT_DESTROYED_MAX_M} m max`);
});
