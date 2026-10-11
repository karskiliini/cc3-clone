import type { AimPoint, BattleState, HullQuat, IncomingTrajectory, Soldier, Vec2, Vec3, Vehicle, VehicleDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { VEHICLE_DEFS } from '@/data/units';
import { VEHICLE_ARMOR_GEOMETRY } from '@/data/vehicleArmorGeometry';
import type { ArmorFace } from './vehicleDamage';
import { VEHICLE_GUN_GEOMETRY } from '@/data/vehicleGunGeometry';
import { hullParams } from '@/data/vehiclePhysics';
import { wrapAngle } from '@/shared/math';
import * as dm from '@/shared/dmath';
import { add, dot, inverseRotate, multiply, rotate, yawQuat } from './hullMath';
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

/** Absolute world metres; direction points along the projectile toward its impact. */
export interface HullRay { origin: Vec3; direction: Vec3 }
export interface HullIntersection { face: ArmorFace; point: Vec3; pointLocal: Vec3; normal: Vec3; incidenceCos: number; distance: number; solid: 'hull' | 'turret' }
function intersectBox(ray: HullRay, position: Vec3, q: HullQuat, box: { min: Vec3; max: Vec3 }, solid: HullIntersection['solid']): HullIntersection | null {
  const length = Math.sqrt(dot(ray.direction, ray.direction));
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const origin = inverseRotate(q, { x: ray.origin.x - position.x, y: ray.origin.y - position.y, z: ray.origin.z - position.z });
  const direction = inverseRotate(q, ray.direction);
  let entry = -Infinity, exit = Infinity, entryNormal: Vec3 = { x: 0, y: 0, z: 0 }, exitNormal = entryNormal;
  // Strict updates retain x, then y, then z when boundaries tie exactly.
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!Number.isFinite(origin[axis]) || !Number.isFinite(direction[axis])) return null;
    const d = direction[axis], o = origin[axis];
    if (d === 0) { if (o < box.min[axis] || o > box.max[axis]) return null; continue; }
    const a = (box.min[axis] - o) / d, b = (box.max[axis] - o) / d;
    const near = Math.min(a, b), far = Math.max(a, b);
    const n = { x: 0, y: 0, z: 0 }; n[axis] = d > 0 ? -1 : 1;
    if (near > entry) { entry = near; entryNormal = n; }
    if (far < exit) { exit = far; exitNormal = { x: -n.x, y: -n.y, z: -n.z }; }
    if (entry > exit) return null;
  }
  if (exit < 0) return null;
  const t = entry >= 0 ? entry : exit, n = entry >= 0 ? entryNormal : exitNormal;
  const normal = rotate(q, n);
  const face: ArmorFace = n.x !== 0 ? 'side' : n.y < 0 ? 'front' : n.y > 0 ? 'rear' : n.z < 0 ? 'belly' : 'top';
  return { face, point: add(ray.origin, { x: ray.direction.x * t, y: ray.direction.y * t, z: ray.direction.z * t }),
    pointLocal: add(origin, { x: direction.x * t, y: direction.y * t, z: direction.z * t }),
    normal, incidenceCos: Math.abs(dot(ray.direction, normal)) / length, distance: t * length, solid };
}
/** The hull slab alone, including forward exit when the source is inside. */
export function intersectHull(v: Vehicle, def: VehicleDef, ray: HullRay): HullIntersection | null {
  const f = frame(v, def); return intersectBox(ray, f.position, f.q, hullParams(def).solidBox, 'hull');
}
function turretFrame(v: Vehicle, def: VehicleDef) {
  const f = frame(v, def), ring = VEHICLE_GUN_GEOMETRY[def.id]?.ring;
  if (!def.hasTurret || v.turretBlown || !ring || !VEHICLE_ARMOR_GEOMETRY[def.id]) return null;
  return { q: multiply(f.q, yawQuat(wrapAngle(v.turretFacing - v.hullFacing))),
    position: add(f.position, rotate(f.q, add(f.modelOrigin, ring))), box: VEHICLE_ARMOR_GEOMETRY[def.id] };
}
/** Nearest visible armor solid; hull-down rejects an obstructed hull entry without reassigning it. */
export function intersectVehicle(v: Vehicle, def: VehicleDef, ray: HullRay, hullDown = false, groundZ = 0): HullIntersection | null {
  if (!v.body && groundZ !== 0) {
    const hit = intersectVehicle(v, def, { origin: { ...ray.origin, z: ray.origin.z - groundZ }, direction: ray.direction }, hullDown);
    return hit ? { ...hit, point: { ...hit.point, z: hit.point.z + groundZ } } : null;
  }
  const hull = intersectHull(v, def, ray), f = turretFrame(v, def);
  const turret = f ? intersectBox(ray, f.position, f.q, f.box, 'turret') : null;
  const hit = !hull ? turret : !turret || hull.distance <= turret.distance ? hull : turret;
  return hullDown && hit?.solid === 'hull' ? null : hit;
}
/** Requested point in the relevant solid. Relative proportions describe aiming doctrine,
 * never armor bounds. Source-facing side is selected geometrically in the solid frame. */
export function vehicleAimPoint(v: Vehicle, def: VehicleDef, aim: AimPoint, origin: Vec3): Vec3 {
  const f = frame(v, def), p = hullParams(def), tf = turretFrame(v, def);
  const turretAim = (aim === 'turretRing' || aim === 'gunMantlet') && tf;
  const q = turretAim ? tf.q : f.q, position = turretAim ? tf.position : f.position;
  const box = turretAim ? tf.box : p.solidBox;
  const source = inverseRotate(q, { x: origin.x - position.x, y: origin.y - position.y, z: origin.z - position.z });
  const at = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  if (aim === 'turretRing') {
    // Aim at the exposed ring band above the conservative hull roof envelope.
    const hullRoof = p.solidBox.max.z - p.modelOriginLocal.z;
    at.z = Math.min(box.max.z, Math.max(box.min.z, hullRoof) + 0.08);
  }
  if (aim === 'gunMantlet' || aim === 'driverPlate') at.y = box.min.y;
  if (aim === 'lowerHull' || aim === 'runningGear') at.z = box.min.z + (box.max.z - box.min.z) * 0.2;
  if (aim === 'driverPlate') at.z = box.min.z + (box.max.z - box.min.z) * 0.75;
  if (aim === 'sideHull' || aim === 'runningGear') at.x = source.x >= 0 ? box.max.x : box.min.x;
  if (aim === 'rear' || aim === 'engineDeck') at.y = box.max.y;
  if (aim === 'engineDeck') at.z = box.max.z;
  return add(position, rotate(q, at));
}
/** State-free fallback knows level-source eye height and the target's authoritative pose.
 * Terrain-aware callers supply their actual absolute origin instead. */
export function legacyHullRay(v: Vehicle, def: VehicleDef, shooterPos: Vec2, aim: AimPoint = 'mass', shooterZ = 1.5): HullRay {
  const origin = { x: shooterPos.x * TILE_M, y: shooterPos.y * TILE_M, z: shooterZ };
  const point = vehicleAimPoint(v, def, aim, origin);
  return { origin, direction: { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z } };
}

/** Terrain-aware requested armor point; source remains the actual absolute muzzle. */
export function vehicleAimTarget(state: BattleState, v: Vehicle, def: VehicleDef, aim: AimPoint, origin: Vec3): GunTarget {
  const datum = v.body ? 0 : groundHeight(state, v.pos);
  const point = vehicleAimPoint(v, def, aim, { ...origin, z: origin.z - datum });
  return { posTiles: { x: point.x / TILE_M, y: point.y / TILE_M }, heightM: point.z + datum };
}
export function hullRayTo(origin: Vec3, target: GunTarget): HullRay {
  return { origin, direction: { x: target.posTiles.x * TILE_M - origin.x, y: target.posTiles.y * TILE_M - origin.y, z: target.heightM - origin.z } };
}

/** World corners of the two authoritative armor proxies, for finite arrival-ray bounds. */
export function vehicleArmorCorners(v: Vehicle, def: VehicleDef, groundZ = 0): Vec3[] {
  const f = frame(v, def), tf = turretFrame(v, def), solids = [{ ...f, box: hullParams(def).solidBox }, ...(tf ? [tf] : [])];
  const corners: Vec3[] = [];
  for (const solid of solids) for (const x of [solid.box.min.x, solid.box.max.x])
    for (const y of [solid.box.min.y, solid.box.max.y]) for (const z of [solid.box.min.z, solid.box.max.z]) {
      const point = add(solid.position, rotate(solid.q, { x, y, z }));
      if (!v.body) point.z += groundZ;
      corners.push(point);
    }
  return corners;
}
/** One common finite terminal-tangent ray, bounded by eligible world solids and endpoint.
 * The approximation can differ from the curved path; no tuned ray length or later shooter pose. */
export function incomingVehicleContact(state: BattleState, trajectory: IncomingTrajectory, candidates: Vehicle[]): { vehicle: Vehicle; hit: HullIntersection; ray: HullRay } | null {
  const { endpoint, direction } = trajectory;
  let maxDistance = 0;
  const datums = candidates.map(v => ({ v, def: VEHICLE_DEFS[v.defId], groundZ: groundHeight(state, v.pos) }));
  for (const { v, def, groundZ } of datums) if (def) for (const c of vehicleArmorCorners(v, def, groundZ))
    maxDistance = Math.max(maxDistance, dot({ x: endpoint.x - c.x, y: endpoint.y - c.y, z: endpoint.z - c.z }, direction));
  if (!(maxDistance > 0) || !Number.isFinite(maxDistance)) return null;
  const ray: HullRay = { origin: { x: endpoint.x - direction.x * maxDistance, y: endpoint.y - direction.y * maxDistance, z: endpoint.z - direction.z * maxDistance }, direction };
  let nearest: { vehicle: Vehicle; hit: HullIntersection; ray: HullRay } | null = null;
  for (const { v, def, groundZ } of datums) {
    const hit = def ? intersectVehicle(v, def, ray, false, groundZ) : null;
    if (!hit || hit.distance > maxDistance) continue;
    if (!nearest || hit.distance < nearest.hit.distance || (hit.distance === nearest.hit.distance && v.id < nearest.vehicle.id)) nearest = { vehicle: v, hit, ray };
  }
  return nearest;
}
