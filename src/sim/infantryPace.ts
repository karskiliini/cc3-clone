import type { Soldier } from '@/shared/types';

/** Loaded infantry game tuning, metres/second before ground, fatigue and wounds. */
export const INFANTRY_PACE = {
  walk: 1.1,
  run: 2.4,
  crouch: 0.7,
  crawl: 0.3,
  flee: 2.6,
  dodge: 3.0,
} as const;

/** An urgent order cannot make a prone man run or a crouching man sprint. */
export function infantrySpeedMs(s: Soldier, requestedMs: number): number {
  const stanceLimit = s.stance === 'prone' ? INFANTRY_PACE.crawl
    : s.stance === 'crouching' ? INFANTRY_PACE.crouch : Infinity;
  let speed = Math.min(requestedMs, stanceLimit);
  if (s.fatigue > 70) speed *= 0.5;
  if (s.health === 'wounded') speed *= 0.7;
  if (s.carrying) speed *= 0.5;
  return speed;
}
