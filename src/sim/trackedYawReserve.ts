import type { HullBody, HullGroundProbe } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import type { HullParams } from '@/data/vehiclePhysics';
import { clamp } from '@/shared/math';
import * as dm from '@/shared/dmath';
import { rotate } from './hullMath';
import { CONE_RAD, STANDSTILL_MS, type TwistInput } from './localDriver';

/** The stopping-tail model assumes one horizontal support plane at regular contacts.
 * Uneven ground retains the existing terrain-aware movement and one-tick admission. */
export function hasFlatTrackedSupport(body: HullBody, params: HullParams, probe: HullGroundProbe): boolean {
  let height: number | undefined;
  for (const contact of params.contacts) {
    if (contact.horn) continue;
    const r = rotate(body.orientation, contact.local), sample = probe(body.position.x + r.x, body.position.y + r.y);
    if (sample.normal.x !== 0 || sample.normal.y !== 0 || sample.normal.z !== 1
      || (height !== undefined && sample.heightM !== height)) return false;
    height = sample.heightM;
  }
  return height !== undefined;
}

/** Reserve the entire passive yaw tail, not only the next integration tick.
 * With T=C/(1-A), heading this tick plus every later zero-command tick is T*r+dt*F.
 * Only this movement owner's contribution changes; ordinary cone admission follows. */
export function reserveStoppingYaw(x: TwistInput): number {
  const { speed, forward, lateral, rate, model } = x;
  let yaw = x.yaw;
  if (x.priorYaw !== 0 || x.priorPull !== 0 || x.pull !== 0
    || (speed === 0 && dm.hypot(forward, lateral) < STANDSTILL_MS)
    || (speed !== 0 && Math.sign(speed) * forward < 0)) return yaw;
  const gear = speed !== 0 ? Math.sign(speed) : forward < 0 ? -1 : 1;
  const beta = forward === 0 && lateral === 0 ? 0 : dm.atan2(gear * lateral, gear * forward);
  if (Math.abs(beta) < CONE_RAD) {
    const tail = model.carriedAngleSeconds / (1 - model.memory);
    if (rate * yaw >= 0) {
      // Heading is monotone. Both the initial velocity and newly driven flow
      // must stay in the final cone; the latter can start at hull angle zero.
      const low = (Math.max(-CONE_RAD, beta - CONE_RAD) - tail * rate) / SIM_DT;
      const high = (Math.min(CONE_RAD, beta + CONE_RAD) - tail * rate) / SIM_DT;
      const lo = Math.max(Math.min(0, yaw), low), hi = Math.min(Math.max(0, yaw), high);
      yaw = lo <= hi ? clamp(yaw, lo, hi) : 0;
    } else {
      const budget = Math.max(0, (CONE_RAD - Math.abs(beta) - tail * Math.abs(rate)) / SIM_DT);
      yaw = clamp(yaw, -budget, budget);
    }
  }
  return yaw;
}
