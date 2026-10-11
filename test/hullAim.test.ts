import { describe, expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { createHullBody } from '@/sim/hullPhysics';
import { gunSolution, gunTarget, hullSettled, vehicleGunOrigin } from '@/sim/hullAim';
import { mainGunBlock, orderedGunBlock, gunBlockText } from '@/sim/gunBlock';
import { targetableEnemyAt, targetStatusText } from '@/ui/targetHover';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';
import { flat } from './hullPhysicsHelpers';
import { SIM_DT } from '@/shared/types';
import { Rng } from '@/shared/rng';
import { stepCombat } from '@/sim/combat';
import { FIRE_HALT_MAX_S } from '@/sim/gunTiming';
import { gunAimPose, vehicleGunRay } from '@/sim/hullAim';
import { VEHICLE_GUN_GEOMETRY } from '@/data/vehicleGunGeometry';
import { hullParams } from '@/data/vehiclePhysics';
import { inverseRotate, yawQuat, rotate } from '@/sim/hullMath';
import { getHeightField, heightAt, setTileProfile } from '@/sim/heightField';
import { eyeHeightM, hasLineOfFire, hasLOS } from '@/sim/los';
import { traceRound } from '@/sim/shotTrace';
import { WEAPONS } from '@/data/weapons';
import { teamPenetrationChance } from '@/sim/penChance';
import { aimLineProfile, aimPointClass } from '@/sim/losProfile';
import { readFileSync } from 'node:fs';

const noseUp = { x: -0.13052619222005157, y: 0, z: 0, w: 0.9914448613738104 };
describe('hull frame gun aim', () => {
  it('rejects depression north of a nose-up hull and permits the same target level', () => {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    const def = { ...VEHICLE_DEFS[v.defId], gunDepressionDeg: 5, gunElevationDeg: 20 };
    v.body = createHullBody(def, v.pos, 0, flat);
    v.body.orientation = noseUp;
    const target = { x: 40, y: 20, z: 0.5 }; // north, 20 metres forward
    expect(gunSolution(v, def, target).canBear).toBe(false);
    expect(mainGunBlock(state, v, { x: 20, y: 10 }, 0.5)).toBe('elevation');
    v.body.orientation = { x: 0, y: 0, z: 0, w: 1 };
    expect(gunSolution(v, def, target).canBear).toBe(true);
  });
  it('uses the sideways turret hull frame rather than subtracting pitch', () => {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    const def = VEHICLE_DEFS[v.defId];
    v.body = createHullBody(def, v.pos, 0, flat); v.body.orientation = noseUp;
    v.turretFacing = Math.PI / 2;
    const origin = vehicleGunOrigin(v, def);
    const s = gunSolution(v, def, { x: origin.x + 20, y: origin.y, z: origin.z });
    expect(s.elevationRad).toBeCloseTo(0, 8); expect(s.canBear).toBe(true);
    expect(Number.isFinite(gunSolution(v, def, origin).elevationRad)).toBe(true);
  });
  it('settles at the squared angular speed threshold in all axes', () => {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    expect(hullSettled(v)).toBe(true);
    v.body = createHullBody(VEHICLE_DEFS[v.defId], v.pos, 0, flat);
    v.body.angularVelocity = { x: 0.035, y: 0, z: 0 }; expect(hullSettled(v)).toBe(true);
    v.body.angularVelocity.y = 0.001; expect(hullSettled(v)).toBe(false);
  });
  it('gives the order and cursor the same absolute vehicle target height', () => {
    const state = makeState(), a = addTank(state, 't34_76', { x: 100, y: 100 }, 0, 60, 'german');
    const b = addTank(state, 'pz4gh', { x: 100, y: 90 }, 0, 60, 'soviet');
    a.v.body = createHullBody(VEHICLE_DEFS[a.v.defId], a.v.pos, 0, flat); a.v.body.orientation = noseUp;
    state.spottedVehicles.german.add(b.v.id);
    const target = gunTarget(state, b.v.pos, b.v);
    expect(mainGunBlock(state, a.v, target.posTiles, target.heightM)).toBe('elevation');
    expect(orderedGunBlock(state, a.v, { type: 'fire', target: b.v.pos, targetVehicleId: b.v.id, issuedAt: 0 })).toBe('elevation');
    expect(targetStatusText(targetableEnemyAt(state, 'german', [a.team], b.v.pos)!)).toBe(gunBlockText('elevation'));
  });
});


function rockingScene() {
  const state = makeState(), a = addTank(state, 'pz4gh', { x: 100, y: 200 }, 0, 90, 'german');
  const b = addTank(state, 't34_76', { x: 100, y: 100 }, 0, 50, 'soviet');
  b.v.mainAmmo = 0; b.v.coaxAmmo = 0;
  a.v.coaxAmmo = 0; a.v.loadedRound = 'ap';
  a.v.gunLay = { key: `v${b.v.id}`, aim: { ...b.v.pos }, designateLeftS: 0, fineLeftS: 0, totalS: 1 };
  a.v.body = createHullBody(VEHICLE_DEFS[a.v.defId], a.v.pos, 0, flat);
  a.v.body.angularVelocity.x = 0.1;
  state.spottedVehicles.german.add(b.v.id);
  a.team.order = { type: 'fire', target: b.v.pos, targetVehicleId: b.v.id, targetTeamId: b.team.id, issuedAt: 0 };
  return { state, a, b, rng: new Rng(45) };
}
function combatTicks(sc: ReturnType<typeof rockingScene>, n: number) {
  for (let i = 0; i < n; i++) { sc.state.time += SIM_DT; stepCombat(sc.state, sc.rng, SIM_DT); }
}
describe('rocking interrupts the authoritative lay', () => {
  it('keeps reserve plus chamber unchanged, suspends fine lay and resumes a correction after settling', () => {
    const sc = rockingScene(), { v } = sc.a;
    const ammo = v.mainAmmo + (v.loadedRound ? 1 : 0);
    combatTicks(sc, 1); const left = v.gunLay!.fineLeftS;
    expect(left).toBeGreaterThan(0);
    combatTicks(sc, 29);
    expect(v.gunLay!.fineLeftS).toBe(left);
    expect(v.mainAmmo + (v.loadedRound ? 1 : 0)).toBe(ammo);
    expect(sc.state.events.filter(e => e.kind === 'shot' && e.side === v.side)).toHaveLength(0);
    v.body!.angularVelocity.x = 0;
    combatTicks(sc, 1); expect(v.gunLay!.fineLeftS).toBeLessThan(left);
    expect(v.loadedRound).toBe('ap');
    combatTicks(sc, 15); expect(v.lastMainShotAt).toBeGreaterThan(3);
  });
  it('prevents a veteran snap shot on an immediate threat while rocking', () => {
    const sc = rockingScene();
    sc.a.v.gunLay!.fineLeftS = 5; sc.a.v.gunLay!.totalS = 5;
    sc.b.v.loadedRound = 'ap'; sc.b.v.mainFireTimer = 1;
    sc.b.v.gunLay = { key: `v${sc.a.v.id}`, aim: sc.a.v.pos, designateLeftS: 0, fineLeftS: 0.1, totalS: 1 };
    combatTicks(sc, 1);
    expect(sc.a.v.gunLay!.fineLeftS).toBe(5); expect(sc.a.v.lastMainShotAt).toBeUndefined();
  });
  it('ends a short halt at its existing maximum without forcing a shot', () => {
    const sc = rockingScene(); sc.a.v.path = [{ x: 100, y: 80 }]; sc.a.v.fireHaltSince = 0;
    sc.state.time = FIRE_HALT_MAX_S;
    combatTicks(sc, 1);
    expect(sc.a.v.lastMainShotAt).toBeUndefined(); expect(sc.a.v.fireHaltUntil).toBeUndefined();
    expect(sc.a.v.noFireHaltUntil).toBeGreaterThan(sc.state.time);
  });
  it('also gates smoke rounds fired by the main gun', () => {
    const sc = rockingScene(); sc.a.team.order = { type: 'smoke', target: { x: 100, y: 180 }, issuedAt: 0 };
    const ammo = sc.a.v.mainAmmo + 1;
    combatTicks(sc, 50);
    expect(sc.a.v.mainAmmo + (sc.a.v.loadedRound ? 1 : 0)).toBe(ammo);
    expect(sc.state.explosions).toHaveLength(0);
  });
});


describe('model muzzle and absolute endpoints', () => {
  it('translates the model ring once and rotates a casemate traverse around its pivot', () => {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    v.turretFacing = Math.PI / 2;
    const m = vehicleGunOrigin(v, VEHICLE_DEFS[v.defId]);
    expect(m.x).toBeCloseTo(40 + 1.35 + 2.2, 8); expect(m.y).toBeCloseTo(40 - 0.62, 8); expect(m.z).toBeCloseTo(1.76, 8);
    v.defId = 'stug3g'; v.turretFacing = 0.1;
    const origin = vehicleGunOrigin(v, VEHICLE_DEFS[v.defId]);
    const g = VEHICLE_GUN_GEOMETRY.stug3g, p = hullParams(VEHICLE_DEFS[v.defId]);
    const barrel = rotate(yawQuat(0.1), { x: 0, y: -g.barrelM, z: 0 });
    const expected = { x: g.pivot.x + barrel.x, y: g.pivot.y + barrel.y, z: g.pivot.z };
    expect(origin.x).toBeCloseTo(40 + expected.x, 8); expect(origin.y).toBeCloseTo(40 + expected.y, 8);
    expect(origin.z).toBeCloseTo(p.cgHeightM + p.modelOriginLocal.z + expected.z, 8);
  });
  it('matches the returned angle to the actual muzzle ray over yaw, tilt and range, including limit edges', () => {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    const def = VEHICLE_DEFS[v.defId]; v.body = createHullBody(def, v.pos, 0, flat); v.body.orientation = noseUp;
    for (const yaw of [0, 0.6, Math.PI / 2, Math.PI]) {
      v.turretFacing = yaw;
      for (const meters of [5, 20, 400]) {
        const target = { x: 40 + meters, y: 40 - meters, z: 3 };
        const pose = gunAimPose(v, def, target);
        const local = inverseRotate(v.body.orientation, { x: target.x - pose.origin.x, y: target.y - pose.origin.y, z: target.z - pose.origin.z });
        const angle = Math.atan2(local.z, Math.hypot(local.x, local.y));
        expect(Math.abs(angle - pose.elevationRad)).toBeLessThan(1e-8);
        v.gunElevationRad = pose.elevationRad; expect(vehicleGunOrigin(v, def)).toEqual(pose.origin);
      }
    }
    v.body = undefined; v.turretFacing = 0;
    const g = VEHICLE_GUN_GEOMETRY[def.id];
    for (const [limit, sign] of [[-5 * Math.PI / 180, -1], [20 * Math.PI / 180, 1]]) {
      const targetAt = (e: number) => ({ x: 40, y: 40 + g.ring.y + g.pivot.y - 20, z: g.pivot.z + 20 * Math.tan(e) });
      const custom = { ...def, gunDepressionDeg: 5, gunElevationDeg: 20 };
      expect(gunSolution(v, custom, targetAt(limit - sign * 1e-7)).canBear).toBe(true);
      expect(gunSolution(v, custom, targetAt(limit + sign * 1e-7)).canBear).toBe(false);
    }
  });
  it('rejects targets within the barrel length conservatively and preserves the documented unknown-model fallback', () => {
    const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
    const def = VEHICLE_DEFS[v.defId], g = VEHICLE_GUN_GEOMETRY[def.id];
    const close = { x: 40, y: 40 + g.ring.y + g.pivot.y - 0.1, z: g.pivot.z };
    const s = gunAimPose(v, def, close); expect(s.canBear).toBe(false); expect(Number.isFinite(s.elevationRad)).toBe(true);
    const legacy = { ...def, id: 'unknown_model' };
    expect(vehicleGunOrigin(v, legacy)).toEqual({ x: 40, y: 40, z: 1.5 });
  });
  it('resolves stance/point heights and state-aware body-absent hill and crater datums without mutation', () => {
    const state = makeState(), a = addTank(state, 't34_76', { x: 20.5, y: 20.5 });
    const field = getHeightField(state.map), to = { x: 20.5, y: 10.5 };
    for (const ground of [6, -0.8]) {
      setTileProfile(field, 20, 20, ground); setTileProfile(field, 20, 10, ground);
      const target = gunTarget(state, to), ray = vehicleGunRay(state, a.v, VEHICLE_DEFS[a.v.defId], target);
      const level = gunAimPose(a.v, VEHICLE_DEFS[a.v.defId], { x: 41, y: 21, z: 0.5 });
      expect(target.heightM).toBeCloseTo(ground + 0.5, 6);
      expect(ray.elevationRad).toBeCloseTo(level.elevationRad, 6); expect(ray.origin.z).toBeCloseTo(level.origin.z + ground, 6);
      expect(ray.heights.eyeM).toBeCloseTo(ray.origin.z - heightAt(field, ray.from.x, ray.from.y), 8);
      expect(ray.heights.targetM).toBeCloseTo(0.5, 8); expect(a.v.body).toBeUndefined(); expect(a.v.gunElevationRad).toBeUndefined();
      const man = a.crew[0]; man.stance = 'prone';
      expect(gunTarget(state, to, undefined, man).heightM).toBeCloseTo(ground + eyeHeightM('prone'), 6);
    }
  });
  it('uses absolute endpoints over a feature while retaining tile-ground masking and independent commander LOS', () => {
    const state = makeState(), a = addTank(state, 't34_76', { x: 20.5, y: 30.5 });
    const field = getHeightField(state.map); setTileProfile(field, 20, 30, 6); setTileProfile(field, 20, 10, 6);
    state.map.ground = new Float32Array(state.map.width * state.map.height);
    for (let y = 18; y <= 20; y++) state.map.ground[y * state.map.width + 20] = 5;
    const target = gunTarget(state, { x: 20.5, y: 10.5 }), ray = vehicleGunRay(state, a.v, VEHICLE_DEFS[a.v.defId], target);
    expect(hasLineOfFire(state.map, ray.from, target.posTiles, ray.heights)).toBe(true);
    expect(traceRound(state, new Rng(1), ray.from, target.posTiles, WEAPONS.f34_76, ray.heights).blocked).toBe(false);
    expect(hasLOS(state.map, a.v.pos, target.posTiles, { eyeM: 2.2 })).toBe(false);
    expect(aimPointClass(aimLineProfile(state.map, ray.from, target.posTiles, ray.heights))).toBe('clear');
  });
  it('keeps conditional penetration chance behind an obstacle while the cursor line is blocked', () => {
    const state = makeState(), a = addTank(state, 'pz4gh', { x: 100, y: 200 }, 0, 60, 'german');
    const b = addTank(state, 't34_76', { x: 100, y: 100 }, 0, 60, 'soviet'); state.spottedVehicles.german.add(b.v.id);
    const chance = teamPenetrationChance(state, a.team, a.v.pos, b.v);
    state.map.tiles[150 * state.map.width + 100] = 'buildingStone';
    expect(teamPenetrationChance(state, a.team, a.v.pos, b.v)).toBe(chance);
    const hover = targetableEnemyAt(state, 'german', [a.team], b.v.pos)!;
    expect(hover.lof).toBe(false); expect(hover.penChance).toBe(chance);
  });
});

it('keeps shared ring coordinates aligned with the existing export manifest', () => {
  const manifest = JSON.parse(readFileSync('public/models/vehicles.json', 'utf8')).vehicles;
  for (const [id, g] of Object.entries(VEHICLE_GUN_GEOMETRY)) {
    const ring = manifest[id].turretPivotM;
    expect(g.ring.x, id).toBe(ring?.x ?? 0); expect(g.ring.y, id).toBe(-(ring?.y ?? 0));
    expect(g.barrelM, id).toBeGreaterThan(0);
  }
});
it('uses absolute height over growth with no map ground array', () => {
  const state = makeState(), from = { x: 10.5, y: 10.5 }, to = { x: 30.5, y: 10.5 };
  for (let x = 11; x < 30; x++) state.map.tiles[10 * state.map.width + x] = 'tallgrass';
  const heights = { eyeM: 0.1, targetM: 0.1, eyeZ: 3, targetZ: 3 };
  expect(hasLOS(state.map, from, to, { eyeM: 0.1, targetM: 0.1 })).toBe(false);
  expect(hasLOS(state.map, from, to, heights)).toBe(true);
  expect(aimPointClass(aimLineProfile(state.map, from, to, heights))).toBe('clear');
});
it('retains the absolute target height when vegetation deflects a round', () => {
  const state = makeState(), from = { x: 10.5, y: 10.5 }, to = { x: 30.5, y: 10.5 };
  state.map.tiles[10 * state.map.width + 20] = 'woods';
  const rng = new Rng(1); rng.chance = () => true;
  const shot = traceRound(state, rng, from, to, { ...WEAPONS.f34_76, heRadiusM: 0 },
    { eyeM: -10, targetM: -10, eyeZ: 5, targetZ: 5 });
  expect(shot.deflected).toBe(true); expect(shot.blocked).toBe(false);
  expect(shot.impact.y).not.toBe(to.y); expect(shot.points.length).toBeGreaterThan(2);
});
it('bounds the muzzle solve immediately outside its conservative close-target region', () => {
  const state = makeState(), { v } = addTank(state, 't34_76', { x: 20, y: 20 });
  const def = VEHICLE_DEFS[v.defId], g = VEHICLE_GUN_GEOMETRY[def.id];
  for (const elevation of [-0.08, 0, 0.2]) {
    for (const distance of [g.barrelM + 1e-3, g.barrelM + 0.1, 20]) {
      const target = { x: 40, y: 40 + g.ring.y + g.pivot.y - distance * Math.cos(elevation), z: g.pivot.z + distance * Math.sin(elevation) };
      const pose = gunAimPose(v, def, target);
      expect(pose.elevationRad).toBeCloseTo(elevation, 8); expect(pose.canBear).toBe(true);
    }
  }
});
it('shows the same stance-aware elevation reason for a spotted infantry target and its Fire order', () => {
  const state = makeState(), a = addTank(state, 't34_76', { x: 100, y: 100 }, 0, 60, 'german');
  a.v.body = createHullBody(VEHICLE_DEFS[a.v.defId], a.v.pos, 0, flat); a.v.body.orientation = noseUp;
  const man = soldier(7, 8, 'soviet', { x: 100, y: 90 }, 'mosin', { stance: 'prone' });
  const enemy = mkTeam(8, 'rifle', [7], 'soviet', man.pos);
  state.soldiers.set(man.id, man); state.teams.set(enemy.id, enemy); state.spotted.german.add(man.id);
  const target = gunTarget(state, man.pos, undefined, man);
  expect(mainGunBlock(state, a.v, target.posTiles, target.heightM)).toBe('elevation');
  expect(orderedGunBlock(state, a.v, { type: 'fire', target: man.pos, targetTeamId: enemy.id, issuedAt: 0 })).toBe('elevation');
  expect(targetStatusText(targetableEnemyAt(state, 'german', [a.team], man.pos)!)).toBe('gun elevation limit');
});
