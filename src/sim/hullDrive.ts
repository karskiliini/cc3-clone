import type { HullDrive, Vehicle } from '@/shared/types';

/** Current-tick driver decisions only; no pose, timers or next-tick inputs live here. */
const requests = new WeakMap<Vehicle, HullDrive>();
const stoppedDrive = (): HullDrive => ({ speedMs: 0, yawRateRadS: 0, brake: true });

export function beginHullDrive(v: Vehicle): void {
  requests.set(v, stoppedDrive());
}

export function requestHullDrive(v: Vehicle, patch: Partial<HullDrive>): void {
  requests.set(v, { ...(requests.get(v) ?? stoppedDrive()), ...patch });
}

export function takeHullDrive(v: Vehicle): HullDrive {
  return requests.get(v) ?? stoppedDrive();
}
