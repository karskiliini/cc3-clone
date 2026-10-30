import type { HullBody, HullDrive } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import type { HullParams } from '@/data/vehiclePhysics';
import { clamp, wrapAngle } from '@/shared/math';
import { cross, rotate } from './hullMath';
import { HULL_CONTACT_RESPONSE_S, HULL_SUBSTEPS } from './hullActuationConstants';

export interface TrackedYawModel { gain: number; memory: number; carriedAngleSeconds: number }
export interface YawEnvelope { turnCapRadS: number; onlyDir: -1 | 0 | 1; appliedPullRadS: number }
export interface HullActuation { speedMs: number; differentialYawRadS: number; brake: boolean }

/** Frozen symmetric flat regular support, unclipped friction and small yaw increments only.
 * Null means the existing raw-input contract; no invented geometry or fallback gain. */
export function deriveTrackedYawModel(p: HullParams): TrackedYawModel | null {
  if (p.driveKind !== 'tracked' || p.turnRadiusM != null) return null;
  let count = 0, rr = 0, xd = 0;
  for (const c of p.contacts) {
    if (c.horn) continue;
    if (!c.driven || c.steer) return null;
    count++; rr += c.local.x * c.local.x + c.local.y * c.local.y;
    xd += c.local.x * c.side * .42 * p.widthM;
  }
  const gain = xd / rr, coefficient = p.massKg / (count * HULL_CONTACT_RESPONSE_S);
  const tau = p.inertia.z / (coefficient * rr), h = SIM_DT / HULL_SUBSTEPS, b = 1 - h / tau;
  if (!(gain > 0 && Number.isFinite(gain) && b >= 0 && b < 1)) return null;
  let memory = 1, carriedAngleSeconds = 0;
  for (let i = 0; i < HULL_SUBSTEPS; i++) { memory *= b; carriedAngleSeconds += h * memory; }
  return { gain, memory, carriedAngleSeconds };
}

/** Accepted heading derivative under full world omega; never assume it equals omega.z. */
export function projectedRate(body: HullBody): number | null {
  const forward = rotate(body.orientation, { x: 0, y: -1, z: 0 }), derivative = cross(body.angularVelocity, forward);
  const den = forward.x * forward.x + forward.y * forward.y;
  if (!(den > 0) || !Number.isFinite(den)) return null;
  const rate = (-forward.y * derivative.x + forward.x * derivative.y) / den;
  return Number.isFinite(rate) ? rate : null;
}

/** Shared legacy damaged-track long-way rule and policy step, before any actuator conversion. */
export function turnIntent(desired: number, heading: number, rate: number, onlyDir: -1 | 0 | 1, dt: number): { error: number; step: number } {
  let error = wrapAngle(desired - heading);
  if (onlyDir !== 0 && Math.abs(error) > .02 && Math.sign(error) !== onlyDir) error -= Math.sign(error) * Math.PI * 2;
  return { error, step: Math.max(-rate * dt, Math.min(rate * dt, error)) };
}

function steeringRange(cap: YawEnvelope): [number, number] {
  return [cap.onlyDir === 1 ? 0 : -cap.turnCapRadS, cap.onlyDir === -1 ? 0 : cap.turnCapRadS];
}

/** Repeated nominal plant pole A; error is unclipped and relative to accepted heading. */
export function trackedMovementYaw(error: number, rate: number, model: TrackedYawModel, cap: YawEnvelope): number {
  const [lo, hi] = steeringRange(cap);
  return clamp(((1 - model.memory) * error - model.carriedAngleSeconds * rate) / SIM_DT, lo, hi);
}

/** Private raw differential target. Public desired request remains untouched; convert only once. */
export function trackedActuation(requested: HullDrive, envelope: YawEnvelope, model: TrackedYawModel): HullActuation {
  if (requested.brake) return { speedMs: 0, differentialYawRadS: 0, brake: true };
  const [lo, hi] = steeringRange(envelope), pull = envelope.appliedPullRadS;
  const steering = clamp(requested.yawRateRadS - pull, lo, hi);
  return { speedMs: requested.speedMs, differentialYawRadS: (steering + pull) / model.gain, brake: false };
}
