import { expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { createHullBody } from '@/sim/hullPhysics';
import { rotate, add } from '@/sim/hullMath';
import { intersectHull } from '@/sim/hullAim';
import { locationArmorMm } from '@/sim/vehicleDamage';
import { addTank, makeState } from './vehicleDamageHelpers';
import { flat } from './hullPhysicsHelpers';

function fixture() {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  const def = VEHICLE_DEFS[v.defId]; v.body = createHullBody(def, v.pos, 0, flat);
  return { state, v, def, p: hullParams(def) };
}
it('finds actual belly ray entry and falls back to top armor', () => {
  const { v, def } = fixture();
  v.body!.orientation = { x: 0.25881904510252074, y: 0, z: 0, w: 0.9659258262890683 };
  const origin = add(v.body!.position, rotate(v.body!.orientation, { x: 0, y: 0, z: -10 }));
  const direction = rotate(v.body!.orientation, { x: 0, y: 0, z: 1 });
  const hit = intersectHull(v, def, { origin, direction });
  expect(hit?.face).toBe('belly');
  expect(hit?.incidenceCos).toBeCloseTo(1, 12);
  expect(locationArmorMm(def, { zone: 'belly', face: 'belly' })).toBe(def.armor.belly ?? def.armor.top);
});
it('uses actual origin to distinguish front and side with identical directions', () => {
  const { v, def, p } = fixture();
  const cast = (x: number, y: number) => intersectHull(v, def, {
    origin: add(v.body!.position, { x, y, z: 0 }), direction: { x: -1, y: 1, z: 0 },
  });
  expect(cast(p.solidBox.max.x + 1, p.solidBox.min.y - 3)?.face).toBe('front');
  expect(cast(p.solidBox.max.x + 3, p.solidBox.min.y - 1)?.face).toBe('side');
  expect(intersectHull(v, { ...def, widthM: def.widthM * 2 }, {
    origin: add(v.body!.position, { x: 0, y: -10, z: 0 }), direction: { x: 0, y: 1, z: 0 },
  })?.face).toBe('front');
});
it('handles parallel slabs, inside forward exits and deterministic x/y/z ties', () => {
  const { v, def, p } = fixture();
  const cast = (local: {x: number;y: number;z: number}, direction: typeof local) => intersectHull(v, def, { origin: add(v.body!.position, local), direction });
  expect(cast({ x: p.solidBox.max.x + 0.01, y: -10, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
  expect(cast({ x: p.solidBox.max.x, y: -10, z: 0 }, { x: 0, y: 1, z: 0 })?.face).toBe('front');
  expect(cast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })?.face).toBe('top');
  const hit = intersectHull(v, { ...def, widthM: 2, lengthM: 4 }, {
    origin: add(v.body!.position, { x: 2, y: -3, z: 0 }), direction: { x: -1, y: 1, z: 0 },
  });
  expect(hit?.face).toBe('side'); expect(hit?.normal.x).toBe(1);
  expect(cast({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull();
});

import { VEHICLE_ARMOR_GEOMETRY } from '@/data/vehicleArmorGeometry';
import { VEHICLE_GUN_GEOMETRY } from '@/data/vehicleGunGeometry';
import { intersectVehicle, hullRayTo, vehicleAimPoint, vehicleAimTarget, vehicleGunRay, gunTarget } from '@/sim/hullAim';
import { multiply, yawQuat } from '@/sim/hullMath';
import { expectedArmorMm, locateHit, resolveVehicleHit, seatOccupant } from '@/sim/vehicleDamage';
import { Rng } from '@/shared/rng';
import { WEAPONS } from '@/data/weapons';
import { TILE_M } from '@/shared/types';

it('uses the independently traversed turret frame and nearest solid, excluding blown turrets', () => {
  const { v, def } = fixture();
  v.body!.orientation = multiply(yawQuat(0.3), { x: -0.25881904510252074, y: 0, z: 0, w: 0.9659258262890683 });
  v.hullFacing = 0.3; v.turretFacing = 0.3 + Math.PI / 2;
  const q = multiply(v.body!.orientation, yawQuat(Math.PI / 2));
  const ring = VEHICLE_GUN_GEOMETRY[def.id].ring;
  const base = add(v.body!.position, rotate(v.body!.orientation, { ...ring, z: -hullParams(def).cgHeightM }));
  const bounds = VEHICLE_ARMOR_GEOMETRY[def.id];
  const z = (bounds.min.z + bounds.max.z) / 2;
  const origin = add(base, rotate(q, { x: 0, y: -10, z }));
  const direction = rotate(q, { x: 0, y: 1, z: 0 });
  const hit = intersectVehicle(v, def, { origin, direction });
  expect(hit?.solid).toBe('turret'); expect(hit?.face).toBe('front');
  const normal = rotate(q, { x: 0, y: -1, z: 0 });
  expect(hit?.normal.x).toBeCloseTo(normal.x, 10); expect(hit?.normal.z).toBeCloseTo(normal.z, 10);
  expect(hit?.incidenceCos).toBeCloseTo(1, 10);
  v.turretBlown = true;
  expect(intersectVehicle(v, def, { origin, direction })).toBeNull();
});
it('hits the turret roof before the hull and preserves armored cupola height', () => {
  const state = makeState(), { v } = addTank(state, 'pantherD', { x: 20, y: 20 });
  const def = VEHICLE_DEFS[v.defId]; v.body = createHullBody(def, v.pos, 0, flat);
  // Panther D cupola at source x=-.45/y=-.55, top=1.85+.78-.02+.36+.04=3.01.
  const ring = VEHICLE_GUN_GEOMETRY[def.id].ring;
  const x = v.body.position.x - 0.45, y = v.body.position.y + ring.y + 0.55;
  const hit = intersectVehicle(v, def, { origin: { x, y, z: 10 }, direction: { x: 0, y: 0, z: -1 } });
  expect(hit?.solid).toBe('turret'); expect(hit?.face).toBe('top');
  expect(hit?.point.z).toBeCloseTo(v.body.position.z - hullParams(def).cgHeightM + 3.01, 10);
  v.turretBlown = true;
  expect(intersectVehicle(v, def, { origin: { x, y, z: 10 }, direction: { x: 0, y: 0, z: -1 } })?.solid).toBe('hull');
});
it('keeps random and requested detailed zones on the actual entered plate', () => {
  const { v, def } = fixture(), rng = new Rng(12);
  const origin = add(v.body!.position, { x: 10, y: 0, z: 0 });
  const ray = { origin, direction: { x: -1, y: 0, z: 0 } };
  for (let i = 0; i < 100; i++) {
    const loc = locateHit(rng, v, def, null, { ray, aimPoint: 'gunMantlet' });
    expect(loc!.face).toBe('side'); expect(loc!.zone.startsWith('turret')).toBe(false); expect(loc!.spot).not.toBe('gunMantlet');
  }
  const belly = locateHit(rng, v, def, null, { ray: { origin: add(v.body!.position, { x: 0, y: 0, z: -10 }), direction: { x: 0, y: 0, z: 1 } }, aimPoint: 'turretRing' });
  expect(belly!.zone).toBe('belly'); expect(belly!.spot).toBeUndefined();
  v.body!.orientation = yawQuat(Math.PI);
  const rotatedGearRay = { origin: add(v.body!.position, rotate(v.body!.orientation, { x: 10, y: 0, z: -0.2 })), direction: rotate(v.body!.orientation, { x: -1, y: 0, z: 0 }) };
  expect(locateHit(rng, v, def, null, { ray: rotatedGearRay, aimPoint: 'runningGear' })?.zone).toBe('runningGearR');
});
it('applies independent ray incidence to weak armor once and uses the same expected geometry', () => {
  const { v, def } = fixture();
  const origin = add(v.body!.position, { x: 10, y: 0, z: 0 });
  const point = vehicleAimPoint(v, def, 'sideHull', origin);
  const ray = { origin, direction: { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z } };
  const loc = locateHit(new Rng(1), v, def, null, { ray, aimPoint: 'sideHull' });
  const incidence = Math.abs(ray.direction.x) / Math.sqrt(ray.direction.x * ray.direction.x + ray.direction.z * ray.direction.z);
  expect(locationArmorMm(def, loc!)).toBeCloseTo(def.armor.side / incidence, 10);
  expect(expectedArmorMm(v, def, { x: 0, y: 0 }, 'sideHull', true, ray)).toBe(locationArmorMm(def, loc!));
  expect(locationArmorMm(def, { zone: 'belly', face: 'belly', incidenceCos: 0.01 })).toBe((def.armor.belly ?? def.armor.top) / 0.1);
});
it('maps belly penetrations to lower hull crew and systems', () => {
  let driver = 0, transmission = 0;
  for (let i = 1; i <= 80; i++) {
    const { state, v, def } = fixture();
    const commander = seatOccupant(state, v, 'commander')!, drv = seatOccupant(state, v, 'driver')!;
    const result = resolveVehicleHit(state, new Rng(i), v, { weapon: WEAPONS.kwk42_75, shooterPos: null, shooterSide: 'german', distM: 0,
      ray: { origin: add(v.body!.position, { x: 0, y: 0, z: -10 }), direction: { x: 0, y: 0, z: 1 } } });
    expect(result.location!.zone).toBe('belly'); expect(result.penetrated).toBe(true);
    if (result.outcome !== 'explosion' && result.outcome !== 'fire') {
      if (drv.health !== 'healthy') driver++;
      if (v.damage?.transmission && v.damage.transmission !== 'ok') transmission++;
      expect(commander.health).toBe('healthy');
    }
    void def;
  }
  expect(driver).toBeGreaterThan(0); expect(transmission).toBeGreaterThan(0);
});
it('covers every procedural turret with explicit source geometry and no barrel envelope', () => {
  for (const def of Object.values(VEHICLE_DEFS).filter(d => d.hasTurret)) {
    const box = VEHICLE_ARMOR_GEOMETRY[def.id];
    expect(box, def.id).toBeDefined(); expect(VEHICLE_GUN_GEOMETRY[def.id], def.id).toBeDefined();
    expect(box.source).toContain('tools/blender/vehicles.py:');
    for (const axis of ['x', 'y', 'z'] as const) expect(box.max[axis]).toBeGreaterThan(box.min[axis]);
  }
  // Original T-34 shell width1.95 and armored gun collar front1.8, not barrel tip3.55.
  expect(VEHICLE_ARMOR_GEOMETRY.t34_76.min).toEqual({ x: -0.975, y: -1.8, z: 1.44 });
  expect(VEHICLE_ARMOR_GEOMETRY.t34_76.max).toEqual({ x: 0.975, y: 1.15, z: 2.08 });
});

import { ballisticArrival } from '@/sim/ballistics';
import { incomingVehicleContact } from '@/sim/hullAim';
import { applyHESplash, stepPendingBursts } from '@/sim/combat';
import { hashState } from '@/sim/stateHash';

it('returns an explicit miss without RNG, damage or armor effects and rejects hull-down entry', () => {
  const { state, v, def } = fixture(), rng = new Rng(10), before = rng.state();
  const ray = { origin: add(v.body!.position, { x: 10, y: 0, z: 10 }), direction: { x: -1, y: 0, z: 0 } };
  expect(locateHit(rng, v, def, null, { ray })).toBeNull();
  const result = resolveVehicleHit(state, rng, v, { weapon: WEAPONS.pak40, shooterPos: null, shooterSide: 'german', distM: 10, ray });
  expect(result).toEqual({ outcome: 'miss', location: null, armorMm: null, penetrated: false, ko: false });
  expect(rng.state()).toBe(before); expect(v.hits).toBe(0); expect(v.damage).toBeUndefined();
  expect(state.sparks).toEqual([]); expect(state.events).toEqual([]); expect(state.messages).toEqual([]);
  const hullRay = { origin: add(v.body!.position, { x: 0, y: -10, z: 0 }), direction: { x: 0, y: 1, z: 0 } };
  expect(locateHit(rng, v, def, null, { ray: hullRay, hullDown: true })).toBeNull(); expect(rng.state()).toBe(before);
  expect(expectedArmorMm(v, def, { x: 0, y: 0 }, 'mass', false, ray)).toBe(Infinity);
  v.defId = 'unknown-armor-model';
  expect(resolveVehicleHit(state, rng, v, { weapon: WEAPONS.pak40, shooterPos: null, shooterSide: 'german', distM: 10, ray })).toEqual(result);
  expect(rng.state()).toBe(before); expect(v.hits).toBe(0); expect(v.damage).toBeUndefined();
});
it('uses known legacy source and target terrain datums and preserves unknown fromAbove policy', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20.5, y: 20.5 });
  state.map.ground = new Float32Array(state.map.width * state.map.height).fill(100);
  const result = resolveVehicleHit(state, new Rng(1), v, { weapon: WEAPONS.pak40, shooterPos: { x: 20.5, y: 0.5 }, shooterSide: 'german', distM: 40 });
  expect(result.location?.face).toBe('front');
  expect(locateHit(new Rng(1), v, VEHICLE_DEFS[v.defId], null, { fromAbove: true })?.face).toBe('top');
});
it('snapshots a canonical gravitational terminal tangent, independent of cosmetic arcs', () => {
  const trajectory = ballisticArrival({ x: 4, y: 6, z: 2 }, { x: 14, y: 6, z: 0 }, 2);
  const speed = Math.sqrt(25 + 10.81 * 10.81);
  expect(trajectory.sourcePos).toEqual({ x: 2, y: 3 }); expect(trajectory.endpoint).toEqual({ x: 14, y: 6, z: 0 });
  expect(trajectory.direction).toEqual({ x: 5 / speed, y: 0, z: -10.81 / speed });
});
it('bounds one common arrival ray and resolves only the nearest eligible solid before its endpoint', () => {
  const { state, v, def } = fixture(), { v: high } = addTank(state, def.id, { ...v.pos });
  high.body = createHullBody(def, high.pos, 0, flat); high.body.position.z += 4;
  const trajectory = ballisticArrival({ x: v.body!.position.x, y: v.body!.position.y, z: 20 }, { x: v.body!.position.x, y: v.body!.position.y, z: 0 }, 3);
  const contact = incomingVehicleContact(state, trajectory, [v, high]);
  expect(contact?.vehicle.id).toBe(high.id); expect(contact?.hit.face).toBe('top');
  expect(incomingVehicleContact(state, { ...trajectory, endpoint: { ...trajectory.endpoint, z: 10 } }, [v, high])).toBeNull();
  const weapon = { ...WEAPONS.pak40, rounds: undefined, penetrationMm: 999, heRadiusM: 3 };
  v.mainAmmo = 0; high.mainAmmo = 0;
  applyHESplash(state, new Rng(3), v.pos, weapon, 'german', trajectory.sourcePos, undefined, { trajectory });
  expect(high.hits).toBe(1); expect(v.hits).toBe(0);
});
it('a tangent near miss gets ordinary fragments without a fabricated top hit', () => {
  const { state, v } = fixture();
  const endpoint = { x: v.body!.position.x + 2, y: v.body!.position.y, z: 0 };
  const trajectory = ballisticArrival({ ...endpoint, z: 20 }, endpoint, 3);
  expect(incomingVehicleContact(state, trajectory, [v])).toBeNull();
  applyHESplash(state, new Rng(3), { x: endpoint.x / TILE_M, y: endpoint.y / TILE_M }, { ...WEAPONS.pak40, rounds: undefined, penetrationMm: 999, heRadiusM: 3 }, 'german', trajectory.sourcePos, undefined, { trajectory });
  expect(v.hits).toBe(0); expect(v.damage).toBeUndefined();
});
it('pending arrival ignores later shooter movement and visual projectile removal', () => {
  const run = (moved: boolean) => {
    const { state, v } = fixture(); const source = { x: v.body!.position.x, y: v.body!.position.y, z: 20 };
    const man = { ...state.soldiers.values().next().value! }; man.id = 99; man.vehicleId = null; man.pos = { x: 100, y: 100 }; state.soldiers.set(99, man);
    const trajectory = ballisticArrival(source, { ...source, z: 0 }, 3);
    state.pendingBursts.push({ at: 3, pos: { ...v.pos }, side: 'german', weaponId: 'pak40', shooterId: 99, trajectory });
    if (moved) { man.pos = { x: 300, y: 300 }; state.projectiles.length = 0; }
    state.time = 3; const rng = new Rng(20); stepPendingBursts(state, rng);
    return { state: v.state, hits: v.hits, damage: v.damage, health: [...state.soldiers.values()].filter(s => s.id !== 99).map(s => s.health), rng: rng.state() };
  };
  expect(run(true)).toEqual(run(false));
});
it('hashes every pending field and optional presence by exact bits without mutation', () => {
  const { state } = fixture(), rng = new Rng(40);
  const burst = { at: 3, pos: { x: 20, y: 20 }, side: 'german' as const, weaponId: 'mortar81',
    trajectory: ballisticArrival({ x: 0, y: 0, z: 1 }, { x: 40, y: 40, z: 0 }, 3) };
  state.pendingBursts = [burst]; const base = hashState({ state, rng });
  const mutations = [
    (b: typeof burst) => { b.at += Number.EPSILON * 4; }, (b: typeof burst) => { b.pos.x += Number.EPSILON * 32; },
    (b: typeof burst) => { b.pos.y += 1; }, (b: typeof burst) => { b.weaponId = 'mortar82'; },
    (b: typeof burst) => { b.side = 'soviet' as 'german'; },
    (b: typeof burst) => { (b as typeof burst & { shooterId?: number }).shooterId = 0; },
    (b: typeof burst) => { (b as typeof burst & { smoke?: boolean }).smoke = false; },
  ];
  for (const mutate of mutations) { const copy = structuredClone(burst); mutate(copy); state.pendingBursts = [copy]; expect(hashState({ state, rng })).not.toBe(base); }
  for (const key of ['sourcePos', 'endpoint', 'direction'] as const) for (const axis of (key === 'sourcePos' ? ['x', 'y'] as const : ['x', 'y', 'z'] as const)) {
    const copy = structuredClone(burst); (copy.trajectory[key] as { x: number; y: number; z?: number })[axis]! += Number.EPSILON * 64;
    state.pendingBursts = [copy]; expect(hashState({ state, rng }), `${key}.${axis}`).not.toBe(base);
  }
  state.pendingBursts = [{ ...burst, trajectory: undefined }]; expect(hashState({ state, rng })).not.toBe(base);
  state.pendingBursts = []; expect(hashState({ state, rng })).not.toBe(base);
  const second = { ...structuredClone(burst), at: 4 }; state.pendingBursts = [burst, second]; const ordered = hashState({ state, rng });
  state.pendingBursts = [second, burst]; expect(hashState({ state, rng })).not.toBe(ordered);
  const snapshot = structuredClone(state.pendingBursts), rngBefore = rng.state(); hashState({ state, rng });
  expect(state.pendingBursts).toEqual(snapshot); expect(rng.state()).toBe(rngBefore);
});

import {stepCombatWithSight as stepCombat} from './fixtures/weaponSight';
import { stepCrewWeapons } from '@/sim/crewWeapon';
import { addGun, mkTeam, soldier } from './vehicleDamageHelpers';
it.each(['grenade', 'mortar', 'vehicleRocket'] as const)('%s producer snapshots launch-time absolute trajectory', kind => {
  const state = makeState(); state.map.ground = new Float32Array(state.map.width * state.map.height).fill(3);
  const rng = new Rng(7); let launch: { x: number; y: number; z: number } | undefined;
  if (kind === 'grenade') {
    const from = { x: 20.5, y: 20.5 }, at = { x: 20.5, y: 10.5 };
    const man = soldier(1, 1, 'german', from, 'kar98k', { grenades: 1, ammo: 0, stance: 'prone' });
    const enemy = soldier(2, 2, 'soviet', at, 'mosin', { ammo: 0 });
    state.soldiers.set(1, man); state.soldiers.set(2, enemy);
    state.teams.set(1, mkTeam(1, 'rifle', [1], 'german', from)); state.teams.set(2, mkTeam(2, 'rifle', [2], 'soviet', at));
    state.spotted.german.add(2); launch = { x: from.x * TILE_M, y: from.y * TILE_M, z: 3.4 };
  } else if (kind === 'mortar') {
    const { team } = addGun(state, 'mortar81', { x: 20.5, y: 100.5 });
    team.order = { type: 'fire', target: { x: 20.5, y: 50.5 }, issuedAt: 0 };
  } else {
    const { v, team } = addTank(state, 'bm13', { x: 200.5, y: 300.5 }, 0, 50, 'german');
    v.body = createHullBody(VEHICLE_DEFS.bm13, v.pos, 0, () => ({ heightM: 3, normal: { x: 0, y: 0, z: 1 } }));
    v.body.orientation = { x: -0.25881904510252074, y: 0, z: 0, w: 0.9659258262890683 };
    launch = add(v.body.position, rotate(v.body.orientation, { x: 0, y: 0, z: 1.5 - hullParams(VEHICLE_DEFS.bm13).cgHeightM }));
    team.order = { type: 'fire', target: { x: 200.5, y: 60.5 }, issuedAt: 0 };
  }
  for (let i = 0; i < 400 && state.pendingBursts.length === 0; i++) {
    state.time += 0.1; stepCrewWeapons(state, 0.1); stepCombat(state, rng, 0.1);
  }
  const burst = state.pendingBursts[0]; expect(burst, kind).toBeDefined(); expect(burst.trajectory).toBeDefined();
  const trajectory = burst.trajectory!;
  launch ??= { x: trajectory.sourcePos.x * TILE_M, y: trajectory.sourcePos.y * TILE_M, z: 3.5 };
  expect(trajectory.endpoint).toEqual({ x: burst.pos.x * TILE_M, y: burst.pos.y * TILE_M, z: 3 });
  const expected = ballisticArrival(launch, trajectory.endpoint, burst.at - state.time);
  expect(trajectory.sourcePos).toEqual(expected.sourcePos);
  for (const axis of ['x', 'y', 'z'] as const) expect(trajectory.direction[axis]).toBeCloseTo(expected.direction[axis], 12);
});

import { expectedArmorFrom } from '@/sim/vehicleDamage';
import { chooseAimPointAt } from '@/sim/aimPoint';
it('uses independent source terrain for tactical armor and bounds offset running-gear points in the rotated hull', () => {
  for (const height of [0, 100]) {
    const state = makeState(); state.map.ground = new Float32Array(state.map.width * state.map.height).fill(height);
    const { v } = addTank(state, 't34_76', { x: 20.5, y: 20.5 }); const def = VEHICLE_DEFS[v.defId];
    v.body = createHullBody(def, v.pos, 0, () => ({ heightM: height, normal: { x: 0, y: 0, z: 1 } }));
    const from = { x: 19.5, y: 0.5 }, origin = { x: from.x * TILE_M, y: from.y * TILE_M, z: gunTarget(state, from).heightM + 1 };
    const target = vehicleAimTarget(state, v, def, 'driverPlate', origin), ray = hullRayTo(origin, target);
    const actual = locateHit(new Rng(1), v, def, from, { ray, aimPoint: 'driverPlate' })!;
    expect(actual.face).toBe('front');
    expect(expectedArmorFrom(state, v, def, origin, 'driverPlate', true)).toBe(locationArmorMm(def, actual));
    const gearPoint = vehicleAimPoint(v, def, 'runningGear', origin);
    expect(Math.abs(gearPoint.x - v.body.position.x)).toBeCloseTo(hullParams(def).widthM * 0.42, 10);
    expect(chooseAimPointAt(state, WEAPONS.pak38, { ap: 10, apcr: 0, he: 0, smoke: 0 }, 0.5, from, v, origin).aimPoint).toBeDefined();
    // Source ground differs from target ground: never infer the source datum from the hull.
    state.map.ground[Math.floor(from.y) * state.map.width + Math.floor(from.x)] = height + 4;
    state.map.heightField = undefined; // rebuild this deliberately edited fixture's sampled relief
    const highOrigin = { ...origin, z: gunTarget(state, from).heightM + 1 };
    expect(highOrigin.z).toBeGreaterThan(origin.z);
    const highRay = hullRayTo(highOrigin, vehicleAimTarget(state, v, def, 'driverPlate', highOrigin));
    const highActual = locateHit(new Rng(1), v, def, from, { ray: highRay, aimPoint: 'driverPlate' })!;
    expect(expectedArmorFrom(state, v, def, highOrigin, 'driverPlate', true)).toBe(locationArmorMm(def, highActual));
    v.body.orientation = yawQuat(Math.PI / 2); v.hullFacing = Math.PI / 2; v.turretFacing = v.hullFacing;
    const sideOrigin = add(v.body.position, rotate(v.body.orientation, { x: 10, y: 0, z: 0 }));
    const sideRay = hullRayTo(sideOrigin, vehicleAimTarget(state, v, def, 'runningGear', sideOrigin));
    const side = locateHit(new Rng(1), v, def, null, { ray: sideRay, aimPoint: 'runningGear' })!;
    expect(side.face).toBe('side'); expect(side.zone).toBe('runningGearR');
  }
});
