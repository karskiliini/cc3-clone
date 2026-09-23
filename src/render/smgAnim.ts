// SMG poses are a planted lower body with independently aimed shoulders and weapon.
// The supplementary atlas bakes five torso angles and three per-round recoil poses;
// directions rotate the whole figure only when the lower body actually turns.
import type { Soldier } from '@/shared/types';
import { WEAPONS } from '@/data/weapons';
import { headingFor, postureFor, smgCombatInterrupted, type Posture } from '@/render/soldierAnim';

export interface SmgPose {
  posture: Posture;
  mode: 'aimed' | 'hip';
  /** Radians, north = 0, clockwise. Heading is the actual muzzle bearing. */
  bodyHeading: number;
  heading: number;
  twistIndex: number;
  /** 0 = settled, 1 = recoil kick, 2 = recovering. */
  frame: 0 | 1 | 2;
  recoil: number;
  /** Initial lowering / prone low-ready live on the original soldier sheet. */
  source: 'soldier' | 'smg';
  key: string;
}

export function smgTwistLimit(posture: Posture): number {
  return (posture === 'prone' ? 20 : 40) * Math.PI / 180;
}

/** Turn the feet only after the target passes the torso's reach. */
export function smgBodyHeading(from: number, heading: number, posture: Posture): number {
  const delta = Math.atan2(Math.sin(heading - from), Math.cos(heading - from));
  return from + Math.sign(delta) * Math.max(0, Math.abs(delta) - smgTwistLimit(posture));
}

/** Pure sample of an acquisition or a timed burst. Stale combat state cannot overrule a
 * casualty, blast recovery, hatch climb or a soldier working with his hands. */
export function smgPose(s: Soldier, time: number, posture = postureFor(s, time)): SmgPose | null {
  if (WEAPONS[s.weaponId]?.cls !== 'smg' || s.health === 'dead' || s.health === 'incapacitated'
    || s.vehicleId != null || s.hatch || s.crewTask || s.pickup?.until != null
    || (s.stunnedUntil != null && time < s.stunnedUntil)
    || (s.dazedUntil != null && time < s.dazedUntil)
    || (s.bandageUntil != null && time < s.bandageUntil)
    || smgCombatInterrupted(s)) return null;
  const burst = s.smgBurst && time >= s.smgBurst.start && time < s.smgBurst.until
    && s.smgBurst.weaponId === s.weaponId ? s.smgBurst : undefined;
  const aim = s.aiming?.weaponId === s.weaponId ? s.aiming : undefined;
  if (!burst && !aim) return null;

  const heading = burst?.heading ?? headingFor(s, null, 0, time);
  let bodyHeading = burst?.bodyFacing ?? smgBodyHeading(aim!.fromFacing, heading, posture);
  const limit = smgTwistLimit(posture);
  const twist = Math.atan2(Math.sin(heading - bodyHeading), Math.cos(heading - bodyHeading));
  const twistIndex = Math.round((Math.max(-limit, Math.min(limit, twist)) + limit) / (limit / 2));
  // There is no hip-fire prone pose: elbows brace a shouldered weapon on the ground.
  const mode = posture === 'prone' ? 'aimed' : burst?.mode ?? aim?.fireMode ?? 'aimed';
  let source: SmgPose['source'] = 'smg';
  let key = `${posture}.${mode}.twist${twistIndex}`;
  if (!burst && aim && aim.startedAt - s.lastFiredAt > 2) {
    const progress = Math.max(0, (time - aim.startedAt) / Math.max(0.01, aim.readyAt - aim.startedAt));
    if (progress < 0.2) {
      source = 'soldier';
      key = `${posture}.idle@smg`;
      bodyHeading = aim.fromFacing;
    } else if (progress < 0.55) {
      if (posture === 'prone') {
        source = 'soldier';
        key = 'prone.idle.alert@smg';
        bodyHeading = aim.fromFacing;
      } else key = `${posture}.hip.twist${twistIndex}`;
    }
  }
  let frame: 0 | 1 | 2 = 0;
  let recoil = 0;
  if (burst && burst.fired > 0) {
    const age = time - burst.lastRoundAt;
    const recovery = Math.min(0.2, Math.max(0.08, burst.interval));
    if (age >= 0 && age < recovery) {
      frame = age < 0.045 ? 1 : 2;
      recoil = Math.max(0, Math.min(1, burst.recoil)) * (1 - age / recovery);
    }
  }
  return { posture, mode, bodyHeading, heading, twistIndex, frame, recoil, source, key };
}
