import { describe, expect, it } from 'vitest';
import type { Soldier } from '@/shared/types';
import { createMind } from '@/sim/mind';
import { smgBodyHeading, smgPose, smgTwistLimit } from '@/render/smgAnim';
import { actionFor, headingFor, isMoving, pickAnimation, postureFor } from '@/render/soldierAnim';

const radians = (degrees: number): number => degrees * Math.PI / 180;
function soldier(overrides: Partial<Soldier> = {}): Soldier {
  return {
    id: 7, teamId: 1, side: 'german', name: 'T', rank: 'Gefr', weaponId: 'mp40', ammo: 20, ammoReserve: 64, grenades: 0,
    health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'firing',
    pos: { x: 10, y: 10 }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null,
    path: [{ x: 10, y: 20 }], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: false, vehicleId: null,
    formationOffset: { x: 0, y: 0 }, lastFiredAt: 10, cover: 0, kills: 0, mind: createMind(50),
    smgBurst: {
      mode: 'aimed', uncontrolled: false, start: 10, until: 10.85, interval: 0.12, rounds: 6, fired: 1, nextAt: 10.12,
      from: { x: 10, y: 10 }, stance: 'standing', aim: { x: 10, y: 0 }, bodyFacing: 0, heading: 0,
      sweep: radians(30), sweepSign: 1, recoil: 1, lastRoundAt: 10, weaponId: 'mp40',
    }, ...overrides,
  };
}

describe('SMG shoulders and planted feet', () => {
  it('changes torso poses across the burst without turning the feet or choosing a gait', () => {
    const s = soldier();
    const turns: number[] = [];
    for (const angle of [-40, -20, 0, 20, 40]) {
      s.smgBurst!.heading = radians(angle);
      const pose = smgPose(s, 10.04)!;
      expect(pose.bodyHeading).toBe(0);
      expect(pose.heading).toBeCloseTo(radians(angle));
      turns.push(pose.twistIndex);
      expect(pickAnimation(s, 10.04, null, 'standing', 2.4).action).toBe('fire');
      expect(headingFor(s, { x: 100, y: 10 }, 2.4, 10.04)).toBeCloseTo(radians(angle));
    }
    expect(turns).toEqual([0, 1, 2, 3, 4]);
    expect(isMoving(s, 2.4, 10.2)).toBe(false);
    expect(isMoving(s, 2.4, 11)).toBe(true);
    expect(postureFor({ ...s, stance: 'crouching' }, 10.2, 2.4)).toBe('kneeling');
  });

  it('follows smooth acquisition with feet moving only beyond the torso limit', () => {
    const s = soldier({ smgBurst: undefined, aiming: { startedAt: 10, readyAt: 11.2, fromFacing: 0,
      from: { x: 10, y: 10 }, at: { x: 20, y: 10 }, targetKind: 'point', weaponId: 'mp40', stance: 'standing' } });
    const early = smgPose(s, 10.3)!;
    expect(early.heading).toBeGreaterThan(0);
    expect(early.bodyHeading).toBe(0);
    const aimed = smgPose(s, 11.2)!;
    expect(aimed.heading).toBeCloseTo(Math.PI / 2);
    expect(aimed.bodyHeading).toBeCloseTo(radians(50));
    expect(aimed.twistIndex).toBe(4);
    // North is a wrap boundary, not a reason to turn the feet almost a full circle.
    expect(smgBodyHeading(radians(350), radians(10), 'standing')).toBeCloseTo(radians(350));
  });

  it('keeps prone fire shouldered with a narrower upper-body sweep', () => {
    const s = soldier({ stance: 'prone' });
    s.smgBurst!.mode = 'hip'; // invalid/stale mode still must not produce prone hip fire
    s.smgBurst!.heading = radians(10);
    const prone = smgPose(s, 10.03)!;
    expect(prone.key).toBe('prone.aimed.twist3');
    expect(prone.bodyHeading).toBe(0);
    expect(smgTwistLimit('prone')).toBeCloseTo(radians(20));
    expect(smgBodyHeading(0, radians(30), 'prone')).toBeCloseTo(radians(10));
    s.smgBurst!.heading = radians(-90);
    expect(smgPose(s, 10.03)!.twistIndex).toBe(0);
  });

  it('selects the low hip pose during acquisition and a burst', () => {
    const s = soldier();
    s.smgBurst!.mode = 'hip';
    expect(smgPose(s, 10.03)!.key).toBe('standing.hip.twist2');
    s.aiming = { startedAt: 10, readyAt: 10.3, fromFacing: 0, from: s.pos, at: { x: 10, y: 0 },
      targetKind: 'point', weaponId: 'mp40', stance: 'standing', fireMode: 'hip' };
    s.smgBurst = undefined;
    expect(smgPose(s, 10.2)!.mode).toBe('hip');
  });

  it('starts lowered, raises through a turning low-ready pose, then shoulders the weapon', () => {
    const s = soldier({ smgBurst: undefined, lastFiredAt: -10, aiming: { startedAt: 10, readyAt: 11.2, fromFacing: 0,
      from: { x: 10, y: 10 }, at: { x: 20, y: 10 }, targetKind: 'point', weaponId: 'mp40', stance: 'standing' } });
    const lowered = smgPose(s, 10.1)!;
    expect(lowered.source).toBe('soldier');
    expect(lowered.key).toBe('standing.idle@smg');
    expect(lowered.bodyHeading).toBe(0);
    const raised = smgPose(s, 10.5)!;
    expect(raised.source).toBe('smg');
    expect(raised.key).toMatch(/^standing\.hip\.twist[34]$/);
    expect(raised.heading).toBeGreaterThan(lowered.heading);
    const shouldered = smgPose(s, 10.8)!;
    expect(shouldered.source).toBe('smg');
    expect(shouldered.key).toMatch(/^standing\.aimed\.twist/);
    expect(smgPose(s, 11.2)!.key).toBe(shouldered.key);
    // Follow-up fire stays raised through the brief settle.
    s.lastFiredAt = 9.5;
    expect(smgPose(s, 10.1)!.source).toBe('smg');
    expect(smgPose(s, 10.1)!.key).toMatch(/^standing\.aimed\.twist/);
    s.lastFiredAt = -10; s.stance = 'prone';
    expect(smgPose(s, 10.5)!.key).toBe('prone.idle.alert@smg');
    expect(smgPose(s, 10.5)!.bodyHeading).toBe(0);
  });
});

describe('per-round SMG recoil and override priorities', () => {
  it('kicks and recovers afresh on each scheduled round, then holds through follow-through', () => {
    const s = soldier();
    expect(smgPose(s, 10.02)!.frame).toBe(1);
    const recovering = smgPose(s, 10.08)!;
    expect(recovering.frame).toBe(2);
    expect(recovering.recoil).toBeCloseTo(1 / 3);
    s.smgBurst!.lastRoundAt = 10.12;
    s.smgBurst!.fired = 2;
    expect(smgPose(s, 10.14)!.frame).toBe(1);
    s.smgBurst!.fired = 6;
    s.smgBurst!.lastRoundAt = 10.6;
    expect(smgPose(s, 10.8)!.frame).toBe(0);
    expect(actionFor(s, 10.8, 'standing', 2.4)).toBe('fire');
    expect(smgPose(s, 10.85)).toBeNull();
    expect(actionFor(s, 10.85, 'standing', 2.4)).toBe('walk');
  });

  it('does not let stale burst state replace casualty, stun, daze or hatch poses', () => {
    expect(smgPose(soldier({ health: 'dead' }), 10.1)).toBeNull();
    expect(smgPose(soldier({ health: 'incapacitated' }), 10.1)).toBeNull();
    expect(smgPose(soldier({ stunnedUntil: 11 }), 10.1)).toBeNull();
    expect(smgPose(soldier({ dazedUntil: 11 }), 10.1)).toBeNull();
    expect(actionFor(soldier({ stunnedUntil: 11 }), 10.1)).toBe('hide');
    expect(smgPose(soldier({ hatch: { vehicleId: 1, hatch: 0, kind: 'bailout', from: { x: 10, y: 10 },
      to: { x: 12, y: 10 }, start: 10, until: 11, panicked: false } }), 10.1)).toBeNull();
    expect(smgPose(soldier({ weaponId: 'kar98k' }), 10.1)).toBeNull();
    expect(smgPose(soldier({ smgBurst: undefined }), 10.1)).toBeNull();
  });

  it('drops the firing pose immediately when fleeing or cowering before sim cleanup', () => {
    for (const activity of ['panicked', 'routed'] as const) {
      const s = soldier({ activity });
      expect(smgPose(s, 10.01)).toBeNull();
      expect(actionFor(s, 10.01, 'standing', 2.4)).toBe('run');
      expect(headingFor(s, null, 2.4, 10.01)).toBeCloseTo(Math.PI);
    }
    for (const mood of ['panicked', 'broken', 'cowering'] as const) {
      const s = soldier(); s.mind.state = mood;
      expect(smgPose(s, 10.01)).toBeNull();
      expect(actionFor(s, 10.01, 'standing', 2.4)).toBe(mood === 'cowering' ? 'hide' : 'run');
    }
  });
});
