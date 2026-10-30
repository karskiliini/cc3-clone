import { describe, expect, it } from 'vitest';
import { VEHICLE_DEFS } from '@/data/units';
import { hullParams } from '@/data/vehiclePhysics';
import { SIM_DT } from '@/shared/types';
import { deriveTrackedYawModel } from '@/sim/hullActuation';
import { HULL_CONTACT_RESPONSE_S, HULL_SUBSTEPS } from '@/sim/hullActuationConstants';
import { createHullBody } from '@/sim/hullPhysics';
import { finishLocalDriver, type LocalDriverSample, type LocalDriverAccepted } from '@/sim/localDriver';
import { addTank, makeState } from './vehicleDamageHelpers';

const def = VEHICLE_DEFS.pz4gh, model = deriveTrackedYawModel(hullParams(def))!;
const windowTicks = Math.ceil((model.carriedAngleSeconds / (1 - model.memory) + SIM_DT / HULL_SUBSTEPS) / SIM_DT);
const response = (1 - SIM_DT / HULL_SUBSTEPS / HULL_CONTACT_RESPONSE_S) ** HULL_SUBSTEPS;

describe('braking before a tracked pivot', () => {
  for (const initial of [-2.5, -0.01, 0.01, 2.5]) {
    it(`distinguishes braking from an unresponsive stopped pivot at ${initial} m/s`, () => {
      const { v } = addTank(makeState(), 'pz4gh', { x: 0, y: 0 });
      v.body = createHullBody(def, v.pos, 0, () => ({ heightM: 0, normal: { x: 0, y: 0, z: 1 } }));
      v.localDriver = { owner: 1, episode: { anchorM: { x: 0, y: 0 }, attempts: 1, limit: 3, exhausted: false }, recovery: null, window: null };
      let flow = initial;
      const observe = (nextFlow: number) => {
        const sample: LocalDriverSample = { owner: 1, goal: { x: 10, y: -10 }, gear: 1, fullSpeed: 3,
          position: { x: 0, y: 0 }, velocity: { x: 0, y: -flow }, heading: 0, initialRate: 0,
          error: Math.PI / 4, ownYaw: 0, legacyYaw: 0.3, signedDemand: 0, onlyDir: 0,
          frontAvailable: true, priorYaw: 0, priorPull: 0, recovery: false, eligible: true,
          translationIntent: false, model };
        const actual: LocalDriverAccepted = { position: { x: 0, y: 0 }, velocity: { x: 0, y: -nextFlow },
          heading: 0, finalRate: 0, length: def.lengthM, experience: 50, terrainRejects: 0,
          effectiveYaw: 0, straightRad: 4 * Math.PI / 180 };
        finishLocalDriver(v, sample, actual);
        flow = nextFlow;
      };
      for (let i = 0; i < windowTicks; i++) observe(flow * response);
      if (Math.abs(initial) === 0.01) {
        // Residual creep below standstill cannot conceal an unresponsive pivot.
        expect(v.localDriver.episode!.attempts).toBe(2);
        expect(v.localDriver.recovery).not.toBeNull();
        return;
      }
      expect(v.localDriver.episode!.attempts).toBe(1);
      expect(v.localDriver.recovery).toBeNull();
      expect(v.localDriver.window).toBeNull();
      // Holding the same momentum is no longer successful braking: the existing
      // observation budget still starts the next recovery attempt.
      for (let i = 0; i < windowTicks; i++) observe(flow);
      expect(v.localDriver.episode!.attempts).toBe(2);
      expect(v.localDriver.recovery).not.toBeNull();
    });
  }
});
