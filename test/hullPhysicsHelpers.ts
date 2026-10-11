import { VEHICLE_DEFS } from '@/data/units';
import { createHullBody, stepHullBody } from '@/sim/hullPhysics';
import { hullParams } from '@/data/vehiclePhysics';
import { dot, inverseRotate } from '@/sim/hullMath';
import type { HullBody, HullGroundProbe, HullDrive, VehicleDef } from '@/shared/types';
export const flat: HullGroundProbe = () => ({ heightM: 0, normal: { x: 0, y: 0, z: 1 } });
export const stop: HullDrive = { speedMs: 0, yawRateRadS: 0, brake: true };
export function rig(id = 't34_76', probe: HullGroundProbe = flat) {
  const def = VEHICLE_DEFS[id], body = createHullBody(def, { x: 10, y: 10 }, 0, probe);
  return { def, body, step: (drive = stop) => stepHullBody(body, def, drive, probe, 0.1) };
}
export function kineticEnergy(body: HullBody, def: VehicleDef): number {
  const p = hullParams(def), w = inverseRotate(body.orientation, body.angularVelocity);
  return 0.5 * p.massKg * dot(body.velocity, body.velocity)
    + 0.5 * (p.inertia.x * w.x * w.x + p.inertia.y * w.y * w.y + p.inertia.z * w.z * w.z);
}
