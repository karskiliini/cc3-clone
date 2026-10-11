import type { BattleState, HullQuat, Soldier, Vec2, Vec3, Vehicle, VehicleDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { VEHICLE_GUN_GEOMETRY } from '@/data/vehicleGunGeometry';
import { hullParams } from '@/data/vehiclePhysics';
import { wrapAngle } from '@/shared/math';
import * as dm from '@/shared/dmath';
import { add, inverseRotate, rotate, yawQuat } from './hullMath';
import { getHeightField, heightAt, syncCraterMarks } from './heightField';
import { eyeHeightM, type LosHeights } from './los';

/** Absolute world height, never height above the target's local ground. */
export interface GunTarget { posTiles: Vec2; heightM: number }
function groundHeight(state: BattleState, pos: Vec2): number {
  const field = getHeightField(state.map); syncCraterMarks(state.map, field);
  return heightAt(field, pos.x, pos.y);
}
function frame(v: Vehicle, def: VehicleDef): { q: HullQuat; position: Vec3; modelOrigin: Vec3 } {
  const p = hullParams(def);
  return { q: v.body?.orientation ?? yawQuat(v.hullFacing),
    position: v.body?.position ?? { x: v.pos.x * TILE_M, y: v.pos.y * TILE_M, z: p.cgHeightM },
    modelOrigin: p.modelOriginLocal };
}
export function gunTarget(state: BattleState, posTiles: Vec2, vehicle?: Vehicle, soldier?: Soldier): GunTarget {
  if (vehicle) {
    const def = VEHICLE_DEFS[vehicle.defId];
    if (def) {
      const p = hullParams(def), f = frame(vehicle, def);
      const centre = { x: 0, y: 0, z: (p.solidBox.min.z + p.solidBox.max.z) / 2 };
      const z = add(f.position, rotate(f.q, centre)).z;
      return { posTiles, heightM: z + (vehicle.body ? 0 : groundHeight(state, posTiles)) };
    }
  }
  return { posTiles, heightM: groundHeight(state, posTiles) + (soldier ? eyeHeightM(soldier.stance) : 0.5) };
}
function gunFrame(v: Vehicle, def: VehicleDef) {
  const f = frame(v, def), geometry = VEHICLE_GUN_GEOMETRY[def.id];
  const yaw = yawQuat(wrapAngle(v.turretFacing - v.hullFacing));
  // Turret mount orbits its ring; a casemate mount stays fixed and only its tube traverses.
  const pivot = geometry ? add(f.modelOrigin, def.hasTurret ? add(geometry.ring, rotate(yaw, geometry.pivot)) : geometry.pivot)
    : add(f.modelOrigin, { x: 0, y: 0, z: 1.5 });
  return { ...f, pivot, barrelM: geometry?.barrelM ?? 0, horizontal: rotate(yaw, { x: 0, y: -1, z: 0 }) };
}
function muzzle(f: ReturnType<typeof gunFrame>, elevationRad: number): Vec3 {
  const along = f.barrelM * dm.cos(elevationRad);
  return add(f.position, rotate(f.q, add(f.pivot,
    { x: f.horizontal.x * along, y: f.horizontal.y * along, z: f.barrelM * dm.sin(elevationRad) })));
}
/** Actual muzzle at the sim-owned elevation; state-free legacy callers assume ground at z=0. */
export function vehicleGunOrigin(v: Vehicle, def: VehicleDef): Vec3 { return muzzle(gunFrame(v, def), v.gunElevationRad ?? 0); }

/** Pure preview and actual fire use this same bounded solve. Close targets within one barrel
 * length of the pivot are conservatively rejected: a forward muzzle-to-target ray is undefined.
 * 32 bisections bound angular bracket width by pi/2^32; limit residuals avoid widening limits. */
export function gunAimPose(v: Vehicle, def: VehicleDef, targetWorld: Vec3): { elevationRad: number; canBear: boolean; origin: Vec3 } {
  const f = gunFrame(v, def);
  const target = inverseRotate(f.q, { x: targetWorld.x - f.position.x, y: targetWorld.y - f.position.y, z: targetWorld.z - f.position.z });
  const d = { x: target.x - f.pivot.x, y: target.y - f.pivot.y, z: target.z - f.pivot.z };
  const distance = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (distance <= f.barrelM) {
    const elevationRad = dm.atan2(d.z, Math.sqrt(d.x * d.x + d.y * d.y));
    return { elevationRad, canBear: false, origin: muzzle(f, elevationRad) };
  }
  const residual = (e: number): number => {
    const s = dm.sin(e), c = dm.cos(e), along = f.barrelM * c;
    const dx = d.x - along * f.horizontal.x, dy = d.y - along * f.horizontal.y;
    return (d.z - f.barrelM * s) * c - Math.sqrt(dx * dx + dy * dy) * s;
  };
  let lo = -Math.PI / 2, hi = Math.PI / 2;
  for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (residual(mid) > 0) lo = mid; else hi = mid; }
  const elevationRad = (lo + hi) / 2, p = hullParams(def);
  const canBear = residual(-p.gunDepressionDeg * Math.PI / 180) >= 0 && residual(p.gunElevationDeg * Math.PI / 180) <= 0;
  return { elevationRad, canBear, origin: muzzle(f, elevationRad) };
}
export function gunSolution(v: Vehicle, def: VehicleDef, targetWorld: Vec3): { elevationRad: number; canBear: boolean } {
  const { elevationRad, canBear } = gunAimPose(v, def, targetWorld); return { elevationRad, canBear };
}
export function hullSettled(v: Vehicle): boolean {
  const w = v.body?.angularVelocity;
  return !w || w.x * w.x + w.y * w.y + w.z * w.z <= 0.035 * 0.035;
}
export interface GunRay { origin: Vec3; from: Vec2; target: GunTarget; heights: LosHeights; elevationRad: number; canBear: boolean }
/** The only conversion between absolute simulation endpoints and legacy above-ground rays. */
export function vehicleGunRay(state: BattleState, v: Vehicle, def: VehicleDef, target: GunTarget): GunRay {
  const legacyGround = v.body ? 0 : groundHeight(state, v.pos);
  const pose = gunAimPose(v, def, { x: target.posTiles.x * TILE_M, y: target.posTiles.y * TILE_M, z: target.heightM - legacyGround });
  const origin = { ...pose.origin, z: pose.origin.z + legacyGround }, from = { x: origin.x / TILE_M, y: origin.y / TILE_M };
  return { ...pose, origin, from, target, heights: {
    eyeM: origin.z - groundHeight(state, from), targetM: target.heightM - groundHeight(state, target.posTiles),
    eyeZ: origin.z, targetZ: target.heightM,
  } };
}
