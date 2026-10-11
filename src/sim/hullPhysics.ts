import type { HullBody, HullDrive, HullGroundProbe, Vec2, Vec3, VehicleDef } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import * as dm from '@/shared/dmath';
import { clamp } from '@/shared/math';
import { hullParams, type HullParams } from '@/data/vehiclePhysics';
import { add, cross, dot, inverseRotate, multiply, normalize, rotate, yawQuat } from './hullMath';

const SUBSTEPS = 10;
const H = SIM_DT / SUBSTEPS;
const GRAVITY = 9.81;
const SOLID_SKIN_M = 1e-9;
/** Independent support-only box points: eight corners in X/Y/Z order, then belly centre. */
function solidPoints(p: HullParams): Vec3[] {
  const points: Vec3[] = [], box = p.solidBox;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y])
    for (const z of [box.min.z, box.max.z]) points.push({ x, y, z });
  points.push({ x: 0, y: 0, z: box.min.z });
  return points;
}

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const scale = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });

/** Four outer samples fit the support plane in the requested heading's frame.
 * Position is CG metres; the separately defined model origin never enters dynamics. */
export function createHullBody(def: VehicleDef, posTiles: Vec2, heading: number, probe: HullGroundProbe): HullBody {
  const p = hullParams(def), yaw = yawQuat(heading), x = posTiles.x * TILE_M, y = posTiles.y * TILE_M;
  const supports = p.contacts.filter(c => !c.horn);
  const minX = Math.min(...supports.map(c => c.local.x)), maxX = Math.max(...supports.map(c => c.local.x));
  const minY = Math.min(...supports.map(c => c.local.y)), maxY = Math.max(...supports.map(c => c.local.y));
  const heights: number[] = [];
  for (const sx of [minX, maxX]) for (const sy of [minY, maxY]) {
    const r = rotate(yaw, { x: sx, y: sy, z: 0 });
    heights.push(probe(x + r.x, y + r.y).heightM);
  }
  const sx = (heights[2] + heights[3] - heights[0] - heights[1]) / (2 * (maxX - minX));
  const sy = (heights[1] + heights[3] - heights[0] - heights[2]) / (2 * (maxY - minY));
  const height = (heights[0] + heights[1] + heights[2] + heights[3]) / 4
    - sx * (minX + maxX) / 2 - sy * (minY + maxY) / 2;
  // Yaw * rear-slope X rotation * right-slope Y rotation aligns local up
  // with the plane while retaining the forward vector's requested XY heading.
  const rearAngle = dm.atan2(sy, 1), rightAngle = dm.atan2(-sx, Math.sqrt(1 + sy * sy));
  const pitch = { x: dm.sin(rearAngle / 2), y: 0, z: 0, w: dm.cos(rearAngle / 2) };
  const roll = { x: 0, y: dm.sin(rightAngle / 2), z: 0, w: dm.cos(rightAngle / 2) };
  return { position: { x, y, z: height + p.cgHeightM }, orientation: normalize(multiply(yaw, multiply(pitch, roll))),
    velocity: zero(), angularVelocity: zero(), suspensionTravel: p.contacts.map(() => 0),
    asleep: false, hungUp: false, overturned: false, quietS: 0, tippedS: 0, hungS: 0,
    rockPhaseS: 0, rockTries: 0, groundVersion: 0 };
}

/** World impulse at a world point; diagonal inertia belongs to the body frame. */
export function applyHullImpulse(body: HullBody, impulse: Vec3, point: Vec3, def: VehicleDef): void {
  const p = hullParams(def);
  body.velocity = add(body.velocity, scale(impulse, 1 / p.massKg));
  const r = { x: point.x - body.position.x, y: point.y - body.position.y, z: point.z - body.position.z };
  const torque = inverseRotate(body.orientation, cross(r, impulse));
  body.angularVelocity = add(body.angularVelocity, rotate(body.orientation,
    { x: torque.x / p.inertia.x, y: torque.y / p.inertia.y, z: torque.z / p.inertia.z }));
  body.asleep = false; body.quietS = 0;
}

/** One production tick, always ten 10 ms semi-implicit steps. Drive/sleep are added by Task 4. */
export function stepHullBody(body: HullBody, def: VehicleDef, _drive: HullDrive, probe: HullGroundProbe, dt: number): void {
  if (dt !== SIM_DT) throw new Error('Hull physics dt must equal SIM_DT');
  const p = hullParams(def), { massKg, inertia, suspension } = p;
  const loadedContactCount = p.contacts.filter(c => !c.horn).length, solidLocals = solidPoints(p);
  const k = suspension.springKNm * 1000;
  const c = 2 * suspension.damping * Math.sqrt(k * massKg / loadedContactCount);
  for (let substep = 0; substep < SUBSTEPS; substep++) {
    let force: Vec3 = { x: 0, y: 0, z: -massKg * GRAVITY }, torque = zero();
    for (let i = 0; i < p.contacts.length; i++) {
      const offset = rotate(body.orientation, p.contacts[i].local), point = add(body.position, offset);
      const sample = probe(point.x, point.y), separation = (sample.heightM - point.z) * sample.normal.z;
      const compression = clamp(separation, 0, suspension.travelM);
      body.suspensionTravel[i] = compression;
      // An unloaded point has neither spring nor damping force. Above-ground damper
      // forces would create an invisible contact and remove genuine free fall.
      if (separation <= 0) continue;
      const vn = dot(add(body.velocity, cross(body.angularVelocity, offset)), sample.normal);
      const bump = Math.max(0, separation - suspension.travelM);
      const magnitude = Math.max(0, k * compression + 10 * k * bump - c * vn);
      const f = scale(sample.normal, magnitude);
      force = add(force, f); torque = add(torque, cross(offset, f));
    }
    body.velocity = add(body.velocity, scale(force, H / massKg));
    const omega = inverseRotate(body.orientation, body.angularVelocity), t = inverseRotate(body.orientation, torque);
    const iw = { x: inertia.x * omega.x, y: inertia.y * omega.y, z: inertia.z * omega.z };
    const gyro = cross(omega, iw);
    const alpha = rotate(body.orientation, { x: (t.x - gyro.x) / inertia.x,
      y: (t.y - gyro.y) / inertia.y, z: (t.z - gyro.z) / inertia.z });
    body.angularVelocity = add(body.angularVelocity, scale(alpha, H));
    const solids = solidLocals.map(local => {
      const r = rotate(body.orientation, local), point = add(body.position, r), sample = probe(point.x, point.y);
      const n = sample.normal, a = cross(r, n), localA = inverseRotate(body.orientation, a);
      const u = rotate(body.orientation, { x: localA.x / inertia.x, y: localA.y / inertia.y, z: localA.z / inertia.z });
      const gap = (point.z - sample.heightM) * n.z;
      return { r, n, u, inverseMass: 1 / massKg + dot(a, u), target: -Math.max(gap - SOLID_SKIN_M * n.z, 0) / H };
    });
    // Frictionless, zero-restitution support. Allow only the closing speed that
    // reaches contact this substep; never add separating bias or stored impulses.
    for (let pass = 0; pass < 4; pass++) for (const contact of solids) {
      const vn = dot(add(body.velocity, cross(body.angularVelocity, contact.r)), contact.n);
      const impulse = Math.max(0, (contact.target - vn) / contact.inverseMass);
      body.velocity = add(body.velocity, scale(contact.n, impulse / massKg));
      body.angularVelocity = add(body.angularVelocity, scale(contact.u, impulse));
    }
    body.position = add(body.position, scale(body.velocity, H));
    const w = body.angularVelocity;
    const qdot = multiply({ ...w, w: 0 }, body.orientation), q = body.orientation;
    body.orientation = normalize({ x: q.x + 0.5 * H * qdot.x, y: q.y + 0.5 * H * qdot.y,
      z: q.z + 0.5 * H * qdot.z, w: q.w + 0.5 * H * qdot.w });
    // Height-field nonpenetration at final XY. Translation only: a lift must not
    // bypass later movement blockers, impart a bounce, or alter kinetic energy.
    let lift = 0;
    for (const local of solidLocals) {
      const point = add(body.position, rotate(body.orientation, local));
      lift = Math.max(lift, probe(point.x, point.y).heightM + SOLID_SKIN_M - point.z);
    }
    body.position.z += lift;
  }
}
