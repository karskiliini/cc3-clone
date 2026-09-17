// ============================================================================
// experience.ts — how good the men of a team are when a battle starts, by side, year and kind
// of unit, and the one set of words for it (Recruit / Regular / Veteran / Hero).
//
// Each (side, year) has a LINE band centre: the Wehrmacht of 1941-42 is a veteran army and
// declines into the replacements of 1944-45; the Red Army of 1941 is mostly recruits and
// learns its trade into the Guards formations of 1944-45. A team def shifts that centre with a
// quality tag (`TeamDef.quality`, optionally per year), or pins its own band outright
// (`TeamDef.experience: [min, max]`). A man's experience is one uniform draw over the band —
// the leader from its upper part — and about one man in 25 is a standout well above it, so a
// few aces turn up anywhere.
// ============================================================================
import type { Side, TeamDef, TeamQuality } from '@/shared/types';

// ------------------------------------------------------------------ words
export type ExperienceLevel = 'Recruit' | 'Regular' | 'Veteran' | 'Hero';
/** Thresholds of the words, on the sim's own behaviour bands: below 40 the green-troop rules
 * apply (overrun dodge, panic, remount shock: `RECRUIT_EXP`), from 70 the veteran ones
 * (`VETERAN_EXP`, `DAZE_VETERAN_EXP`, crews that never panic from non-penetrating hits), above
 * 85 the ace ones. sim/gunTiming.ts's anchors (25 / 50 / 75 / 95) are the middles of these bands. */
export const EXP_LEVEL_REGULAR = 40;
export const EXP_LEVEL_VETERAN = 70;
export const EXP_LEVEL_HERO = 85;

export function experienceLevel(experience: number): ExperienceLevel {
  if (experience > EXP_LEVEL_HERO) return 'Hero';
  if (experience >= EXP_LEVEL_VETERAN) return 'Veteran';
  if (experience >= EXP_LEVEL_REGULAR) return 'Regular';
  return 'Recruit';
}

// ------------------------------------------------------------------ bands
/** Centre of the line-troop band by side and year. */
export const LINE_EXPERIENCE: Record<Side, Record<number, number>> = {
  german: { 1941: 58, 1942: 56, 1943: 52, 1944: 45, 1945: 38 },
  soviet: { 1941: 30, 1942: 36, 1943: 44, 1944: 50, 1945: 54 },
};
/** Shift of the band centre by quality tag. */
export const QUALITY_SHIFT: Record<TeamQuality, number> = { militia: -12, line: 0, seasoned: 8, elite: 18 };
/** Half-width of a band. */
export const BAND_HALF = 18;
export const EXP_MIN = 5, EXP_MAX = 98;
/** Share of men who stand out above their band, and how far above it they may be. */
export const STANDOUT_SHARE = 0.04;
export const STANDOUT_ABOVE = 20;
/** The leader is drawn from the upper part of the band (from this fraction of it upward). */
export const LEADER_BAND_FROM = 0.4;

function lineCentre(side: Side, year: number): number {
  const t = LINE_EXPERIENCE[side];
  const y = Math.max(1941, Math.min(1945, Math.round(year)));
  return t[y] ?? 45;
}

export function teamQuality(def: TeamDef, year: number): TeamQuality {
  const q = def.quality;
  if (!q) return 'line';
  return typeof q === 'string' ? q : q[year] ?? q.default ?? 'line';
}

/** [min, max] of the experience of a team's men in a battle of `year`. */
export function experienceBand(def: TeamDef, year: number): [number, number] {
  if (def.experience) return [Math.min(def.experience[0], def.experience[1]), Math.max(def.experience[0], def.experience[1])];
  const c = lineCentre(def.side, year) + QUALITY_SHIFT[teamQuality(def, year)];
  return [Math.max(EXP_MIN, c - BAND_HALF), Math.min(EXP_MAX, c + BAND_HALF)];
}

/** One man's experience from ONE uniform draw `u` in [0, 1) (so spawning consumes the seeded
 * Rng exactly as before). */
export function rollExperience(def: TeamDef, year: number, isLeader: boolean, u: number): number {
  const [lo, hi] = experienceBand(def, year);
  if (u >= 1 - STANDOUT_SHARE) {
    const k = (u - (1 - STANDOUT_SHARE)) / STANDOUT_SHARE;
    return Math.min(EXP_MAX + 1, hi + k * STANDOUT_ABOVE);
  }
  const k = u / (1 - STANDOUT_SHARE);
  return lo + (hi - lo) * (isLeader ? LEADER_BAND_FROM + (1 - LEADER_BAND_FROM) * k : k);
}

/** The typical man of the team (middle of its band): for the purchase screen. */
export function typicalExperience(def: TeamDef, year: number): number {
  const [lo, hi] = experienceBand(def, year);
  return (lo + hi) / 2;
}
