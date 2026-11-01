import type { HullBody, HullDrive, HullGroundProbe, Vec2, Vec3, VehicleDef } from '@/shared/types';
import { SIM_DT, TILE_M } from '@/shared/types';
import * as dm from '@/shared/dmath';
import { clamp } from '@/shared/math';
import { hullParams, type HullParams } from '@/data/vehiclePhysics';
import { add, cross, dot, inverseRotate, multiply, normalize, rotate, yawQuat, hullAngles } from './hullMath';

import { HULL_SUBSTEPS as SUBSTEPS, HULL_CONTACT_RESPONSE_S } from './hullActuationConstants';
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
  const body: HullBody = { position: { x, y, z: height + p.cgHeightM }, orientation: normalize(multiply(yaw, multiply(pitch, roll))),
    velocity: zero(), angularVelocity: zero(), suspensionTravel: p.contacts.map(() => 0),
    asleep: false, hungUp: false, overturned: false, quietS: 0, tippedS: 0, hungS: 0,
    rockPhaseS: 0, rockTries: 0, groundVersion: 0 };
  // A fitted plane can cut through a nonplanar roof/ground boundary. Placement
  // must resolve that overlap before springs turn it into stored launch energy.
  // Keep the fitted rotation and lift only enough to clear the solid hull and
  // keep every suspension point within its travel. Ordinary plane poses stay exact.
  let lift = 0;
  for (const local of solidPoints(p)) {
    const point = add(body.position, rotate(body.orientation, local));
    lift = Math.max(lift, probe(point.x, point.y).heightM + SOLID_SKIN_M - point.z);
  }
  for (const contact of p.contacts) {
    const point = add(body.position, rotate(body.orientation, contact.local));
    const ground = probe(point.x, point.y);
    if (ground.normal.z > 0) lift = Math.max(lift,
      ground.heightM - point.z - p.suspension.travelM / ground.normal.z);
  }
  body.position.z += lift;
  return body;
}

/** Reset canonical sleep state after input, collision displacement or terrain changes. */
export function wakeHull(body: HullBody): void { body.asleep = false; body.quietS = 0; }

/** Call with the current synchronized ground revision before stepping/sleep return. */
export function syncHullGroundVersion(body: HullBody, version: number): void {
  if (body.groundVersion !== version) { body.groundVersion = version; wakeHull(body); }
}

/** World impulse at a world point; diagonal inertia belongs to the body frame. */
export function applyHullImpulse(body: HullBody, impulse: Vec3, point: Vec3, def: VehicleDef): void {
  if (impulse.x === 0 && impulse.y === 0 && impulse.z === 0) return;
  const p = hullParams(def);
  body.velocity = add(body.velocity, scale(impulse, 1 / p.massKg));
  const r = { x: point.x - body.position.x, y: point.y - body.position.y, z: point.z - body.position.z };
  const torque = inverseRotate(body.orientation, cross(r, impulse));
  body.angularVelocity = add(body.angularVelocity, rotate(body.orientation,
    { x: torque.x / p.inertia.x, y: torque.y / p.inertia.y, z: torque.z / p.inertia.z }));
  wakeHull(body);
}

/** Ephemeral observation of contact at an accepted pose. Never mutates the solver. */
export interface HullContactObservation { point: Vec3; kind: 'suspension' | 'solid' }

/** One production tick, always ten 10 ms semi-implicit steps.
 * drive.yawRateRadS is the raw differential tread target here, not desired hull output. */
export function stepHullBody(body: HullBody, def: VehicleDef, drive: HullDrive, probe: HullGroundProbe, dt: number, going = 1,
  acceptTranslation?: (from: Vec3, to: Vec3) => boolean,
  observeContact?: (contact: HullContactObservation) => void,
  observeInterest?: (acceptedPoint: Vec3) => boolean,
  normalized?: HullParams): void {
  if (dt !== SIM_DT) throw new Error('Hull physics dt must equal SIM_DT');
  const hasInput = drive.speedMs !== 0 || drive.yawRateRadS !== 0;
  if (hasInput) wakeHull(body);
  if (body.asleep) return;
  const p = normalized ?? hullParams(def), { massKg, inertia, suspension } = p;
  const loadedContactCount = p.contacts.filter(c => !c.horn).length, solidLocals = solidPoints(p);
  const drivenContactCount = p.contacts.filter(c => !c.horn && c.driven).length;
  let bottomSupported = false;
  const speed = drive.brake ? 0 : drive.speedMs, yawRate = drive.brake ? 0 : drive.yawRateRadS;
  const mu = 0.8 * Math.max(0, going), controllerMass = massKg / loadedContactCount;
  const frontY = Math.min(...p.contacts.filter(contact => !contact.horn).map(contact => contact.local.y));
  const rearY = Math.max(...p.contacts.filter(contact => !contact.horn).map(contact => contact.local.y));
  const wheelbase = rearY - frontY;
  const maxSteer = dm.atan2(wheelbase, p.turnRadiusM ?? wheelbase);
  const steer = speed === 0 ? 0 : clamp(dm.atan2(wheelbase * yawRate, Math.abs(speed)), -maxSteer, maxSteer) * (speed < 0 ? -1 : 1);
  const k = suspension.springKNm * 1000;
  const c = 2 * suspension.damping * Math.sqrt(k * massKg / loadedContactCount);
  for (let substep = 0; substep < SUBSTEPS; substep++) {
    let stableSuspension = true, loaded = false;
    let straightHeading: Vec3 | undefined, steeredHeading: Vec3 | undefined;
    let straightBasis: { nx: number; ny: number; nz: number; longitudinal: Vec3; lateral: Vec3 } | undefined;
    let steeredBasis: typeof straightBasis;
    let force: Vec3 = { x: 0, y: 0, z: -massKg * GRAVITY }, torque = zero();
    for (let i = 0; i < p.contacts.length; i++) {
      const contact = p.contacts[i], offset = rotate(body.orientation, contact.local);
      const px = body.position.x + offset.x, py = body.position.y + offset.y, pz = body.position.z + offset.z;
      const sample = probe(px, py), separation = (sample.heightM - pz) * sample.normal.z;
      const compression = clamp(separation, 0, suspension.travelM);
      if (Math.abs(compression - body.suspensionTravel[i]) > 1e-5) stableSuspension = false;
      body.suspensionTravel[i] = compression;
      // An unloaded point has neither spring nor damping force. Above-ground damper
      // forces would create an invisible contact and remove genuine free fall.
      if (separation <= 0) continue;
      // Keep the original cross/add/dot and normal-then-traction accumulation
      // order, without allocating intermediate velocity, force and torque vectors.
      const w = body.angularVelocity, v = body.velocity, normal = sample.normal;
      const vx = v.x + (w.y * offset.z - w.z * offset.y);
      const vy = v.y + (w.z * offset.x - w.x * offset.z);
      const vz = v.z + (w.x * offset.y - w.y * offset.x);
      const vn = vx * normal.x + vy * normal.y + vz * normal.z;
      const bump = Math.max(0, separation - suspension.travelM);
      const magnitude = Math.max(0, k * compression + 10 * k * bump - c * vn);
      if (magnitude > 0) loaded = true;
      const fx = normal.x * magnitude, fy = normal.y * magnitude, fz = normal.z * magnitude;
      force.x = force.x + fx; force.y = force.y + fy; force.z = force.z + fz;
      torque.x = torque.x + (offset.y * fz - offset.z * fy);
      torque.y = torque.y + (offset.z * fx - offset.x * fz);
      torque.z = torque.z + (offset.x * fy - offset.y * fx);
      if (magnitude === 0 || mu === 0) continue;
      // Only loaded suspension points have tyre/track friction; solid box support
      // remains frictionless. Project the running gear direction into this plane.
      let basis = contact.steer ? steeredBasis : straightBasis;
      if (!basis || !Object.is(basis.nx, normal.x) || !Object.is(basis.ny, normal.y) || !Object.is(basis.nz, normal.z)) {
        const heading = contact.steer
          ? steeredHeading ??= rotate(body.orientation, { x: dm.sin(steer), y: -dm.cos(steer), z: 0 })
          : straightHeading ??= rotate(body.orientation, { x: 0, y: -1, z: 0 });
        const tangent = add(heading, scale(normal, -dot(heading, normal)));
        const tangentLength = Math.sqrt(dot(tangent, tangent));
        if (tangentLength === 0) continue;
        const longitudinal = scale(tangent, 1 / tangentLength), lateral = cross(longitudinal, normal);
        basis = { nx: normal.x, ny: normal.y, nz: normal.z, longitudinal, lateral };
        if (contact.steer) steeredBasis = basis; else straightBasis = basis;
      }
      const { longitudinal, lateral } = basis;
      const target = p.driveKind === 'tracked' ? speed - contact.side * yawRate * 0.42 * p.widthM : speed;
      const along = contact.driven || (drive.brake && contact.brake !== false) ? (target - (vx * longitudinal.x + vy * longitudinal.y + vz * longitudinal.z)) * controllerMass / HULL_CONTACT_RESPONSE_S : 0;
      const across = -(vx * lateral.x + vy * lateral.y + vz * lateral.z) * controllerMass / HULL_CONTACT_RESPONSE_S;
      let tx = longitudinal.x * along + lateral.x * across;
      let ty = longitudinal.y * along + lateral.y * across;
      let tz = longitudinal.z * along + lateral.z * across;
      // Loaded tracks support the tangential gravity load while driving as well
      // as at rest; otherwise the velocity controller has a permanent downhill
      // error. Support and slip correction share the same Coulomb friction circle.
      if (contact.brake !== false && ((p.driveKind === 'tracked' && contact.driven) || (speed === 0 && yawRate === 0))) {
        const gz = -GRAVITY * controllerMass;
        // Retain zero products and both additions: signed zeros are observable
        // in exact state comparisons, even when a term is mathematically zero.
        const projected = 0 * normal.x + 0 * normal.y + gz * normal.z;
        tx = tx + (0 * -1 + normal.x * projected);
        ty = ty + (0 * -1 + normal.y * projected);
        tz = tz + (gz * -1 + normal.z * projected);
      }
      const wanted = Math.sqrt(tx * tx + ty * ty + tz * tz), limit = mu * magnitude;
      if (wanted > limit) { const ratio = limit / wanted; tx = tx * ratio; ty = ty * ratio; tz = tz * ratio; }
      force.x = force.x + tx; force.y = force.y + ty; force.z = force.z + tz;
      torque.x = torque.x + (offset.y * tz - offset.z * ty);
      torque.y = torque.y + (offset.z * tx - offset.x * tz);
      torque.z = torque.z + (offset.x * ty - offset.y * tx);
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
      return { local, supported: false, penetration: 0, r, n, u, inverseMass: 1 / massKg + dot(a, u), target: -Math.max(gap - SOLID_SKIN_M * n.z, 0) / H };
    });
    // Frictionless, zero-restitution support. Allow only the closing speed that
    // reaches contact this substep; never add separating bias or stored impulses.
    for (let pass = 0; pass < 4; pass++) for (const contact of solids) {
      // Same cross/add/dot arithmetic and contact order, without six temporary vectors.
      const w = body.angularVelocity, r = contact.r, n = contact.n, velocity = body.velocity;
      const px = velocity.x + (w.y * r.z - w.z * r.y);
      const py = velocity.y + (w.z * r.x - w.x * r.z);
      const pz = velocity.z + (w.x * r.y - w.y * r.x);
      const vn = px * n.x + py * n.y + pz * n.z;
      const impulse = Math.max(0, (contact.target - vn) / contact.inverseMass);
      if (impulse > 0) contact.supported = true;
      const dv = impulse / massKg;
      velocity.x = velocity.x + n.x * dv;
      velocity.y = velocity.y + n.y * dv;
      velocity.z = velocity.z + n.z * dv;
      w.x = w.x + contact.u.x * impulse;
      w.y = w.y + contact.u.y * impulse;
      w.z = w.z + contact.u.z * impulse;
    }
    const candidate = add(body.position, scale(body.velocity, H));
    if (acceptTranslation && !acceptTranslation(body.position, candidate)) {
      // Boolean blockers provide no normal: conservatively stop XY without wall sliding.
      body.velocity.x = 0; body.velocity.y = 0;
      candidate.x = body.position.x; candidate.y = body.position.y;
    }
    body.position = candidate;
    const w = body.angularVelocity;
    const qdot = multiply({ ...w, w: 0 }, body.orientation), q = body.orientation;
    body.orientation = normalize({ x: q.x + 0.5 * H * qdot.x, y: q.y + 0.5 * H * qdot.y,
      z: q.z + 0.5 * H * qdot.z, w: q.w + 0.5 * H * qdot.w });
    // Height-field nonpenetration at final XY. Translation only: a lift must not
    // bypass later movement blockers, impart a bounce, or alter kinetic energy.
    let lift = 0, bottomLift = 0;
    for (const contact of solids) {
      const local = contact.local;
      const point = add(body.position, rotate(body.orientation, local));
      const penetration = probe(point.x, point.y).heightM + SOLID_SKIN_M - point.z;
      contact.penetration = penetration;
      lift = Math.max(lift, penetration);
      if (local.z === p.solidBox.min.z) bottomLift = Math.max(bottomLift, penetration);
    }
    body.position.z += lift;
    // Only support still touching at the accepted final XY/rotation counts. Roof
    // impulses cannot masquerade as belly support, including after blocker rejection.
    bottomSupported = false;
    for (const contact of solids) {
      const bottomCandidate = contact.local.z === p.solidBox.min.z && (contact.supported || bottomLift > 0);
      let observedCandidate = observeContact && (contact.supported || contact.penetration > 0);
      if (!bottomCandidate && !observedCandidate) continue;
      const offset = rotate(body.orientation, contact.local), point = add(body.position, offset);
      if (observedCandidate && observeInterest && !observeInterest(point)) observedCandidate = false;
      if (!bottomCandidate && !observedCandidate) continue;
      // Use the same accepted-pose support classification for gameplay and observations.
      const sample = probe(point.x, point.y);
      if (sample.normal.z <= 0) continue;
      const rotationStep = scale(cross(body.angularVelocity, contact.r), H);
      const delta = add(offset, scale(add(contact.r, rotationStep), -1));
      const rotationResidual = contact.supported ? Math.max(0, dot(delta, sample.normal) / sample.normal.z) : 0;
      if (point.z > sample.heightM + 2 * SOLID_SKIN_M + rotationResidual) continue;
      if (bottomCandidate) bottomSupported = true;
      if (observedCandidate) observeContact!({ point, kind: 'solid' });
    }
    // A pre-integration spring load cannot justify effects at a rejected candidate.
    // Re-evaluate actual positive load after blocking, rotation and projection.
    if (observeContact) for (const contact of p.contacts) {
      const offset = rotate(body.orientation, contact.local), point = add(body.position, offset);
      if (observeInterest && !observeInterest(point)) continue;
      const sample = probe(point.x, point.y), separation = (sample.heightM - point.z) * sample.normal.z;
      if (separation <= 0) continue;
      const vn = dot(add(body.velocity, cross(body.angularVelocity, offset)), sample.normal);
      const magnitude = Math.max(0, k * clamp(separation, 0, suspension.travelM)
        + 10 * k * Math.max(0, separation - suspension.travelM) - c * vn);
      if (magnitude > 0) observeContact({ point, kind: 'suspension' });
    }
    const quietCandidate = !hasInput && loaded && stableSuspension
      && dot(body.velocity, body.velocity) < 0.005 * 0.005
      && dot(body.angularVelocity, body.angularVelocity) < 0.005 * 0.005;
    const angles = quietCandidate ? hullAngles(body.orientation) : null, levelLimit = 2 * Math.PI / 180;
    const quiet = angles != null && Math.abs(angles.pitch) < levelLimit && Math.abs(angles.roll) < levelLimit;
    body.quietS = quiet ? body.quietS + H : 0;
  }
  // Recompute current driven loads at the final accepted pose, rather than using
  // compression alone or a force from an earlier speculative/substep position.
  let drivenLoaded = 0;
  if (bottomSupported) for (const contact of p.contacts) {
    if (contact.horn || !contact.driven) continue;
    const offset = rotate(body.orientation, contact.local), point = add(body.position, offset);
    const sample = probe(point.x, point.y), separation = (sample.heightM - point.z) * sample.normal.z;
    if (separation <= 0) continue;
    const vn = dot(add(body.velocity, cross(body.angularVelocity, offset)), sample.normal);
    const magnitude = Math.max(0, k * clamp(separation, 0, suspension.travelM)
      + 10 * k * Math.max(0, separation - suspension.travelM) - c * vn);
    if (magnitude > 0) drivenLoaded++;
  }
  const hung = bottomSupported && drivenContactCount > 0 && drivenLoaded / drivenContactCount < 0.25;
  body.hungS = hung ? body.hungS + dt : 0;
  body.hungUp = body.hungS >= 0.5 - 1e-9;
  if (body.quietS >= 0.5) {
    body.asleep = true;
    body.velocity = zero(); body.angularVelocity = zero();
  }
}
