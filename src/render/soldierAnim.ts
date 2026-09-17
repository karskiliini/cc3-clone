// ============================================================================
// soldierAnim.ts — PURE animation selection for soldiers (no canvas, no DOM).
// Spec: docs/superpowers/specs/2026-09-17-soldier-animation-design.md §1, §4, §5.
//
// A soldier's picture = posture x action x mood, picked from the sim's existing fields (stance,
// activity, health, mind.state, path, timestamps) plus the battle clock. The pictures themselves
// come from the pre-rendered Blender atlases (spriteAtlas.ts); this module only decides WHICH
// atlas entry, direction and frame to show:
//   entry key  = `<posture>.<action>[.<mood>][@weapon]`, with a fallback chain
//                (mood variant -> base action -> idle) for entries an atlas does not carry;
//   direction  = heading quantised to the atlas's direction count (16 for soldiers);
//   frame      = a pure function of the clock: per-soldier phase offset, gait cadence from ground
//                speed (no foot sliding), fire kick from lastFiredAt, reload progress, flinch from
//                mind.lastIncomingAt.
// Also the pure half of the blast ragdoll (§4): flight timing / arc / variant choice.
// ============================================================================
import type { Soldier, Vec2 } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import { WEAPONS } from '@/data/weapons';

export type Posture = 'standing' | 'crouched' | 'kneeling' | 'prone';
export type AnimAction =
  | 'idle' | 'aim' | 'fire' | 'reload' | 'hide' | 'walk' | 'run' | 'sneak' | 'crawl' | 'throw' | 'hit' | 'woundedCrawl';
export type Mood = 'calm' | 'alert' | 'shaken' | 'pinned' | 'cowering' | 'panicked' | 'berserk' | 'surrendered';
export type WeaponSuffix = 'rifle' | 'smg' | 'lmg';

/** What an atlas says about one entry (subset of spriteAtlas.AtlasEntry this module needs). */
export interface AnimEntryInfo { frames: number; fps: number; loop: boolean }

export const FIRE_KICK_S = 0.25;
export const FLINCH_S = 0.35;
/** Ground covered by one full gait cycle (two steps / one elbow-knee cycle), metres. */
export const STRIDE_M: Record<'walk' | 'run' | 'sneak' | 'crawl' | 'woundedCrawl', number> = {
  walk: 1.5, run: 2.4, sneak: 1.0, crawl: 0.8, woundedCrawl: 0.5,
};
/** Speed assumed when the caller cannot measure one (m/s). */
const DEFAULT_SPEED: Record<keyof typeof STRIDE_M, number> = { walk: 1.4, run: 3.6, sneak: 0.8, crawl: 0.5, woundedCrawl: 0.25 };
const GAITS = new Set<AnimAction>(['walk', 'run', 'sneak', 'crawl', 'woundedCrawl']);

const STEADY_ACTIVITIES = new Set(['firing', 'reloading', 'defending', 'ambushing']);

/** Per-soldier phase offset in [0,1): men in a squad never breathe or step in unison. */
export function phaseOffset(id: number): number {
  let h = Math.imul(id | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export function isMoving(s: Soldier): boolean {
  return s.path.length > 0 && s.health !== 'dead' && s.health !== 'incapacitated';
}

export function moodFor(s: Soldier): Mood {
  switch (s.activity) {
    case 'surrendered': return 'surrendered';
    case 'berserk': return 'berserk';
    case 'panicked':
    case 'routed': return 'panicked';
    case 'cowering': return 'cowering';
    case 'pinned': return 'pinned';
    default: break;
  }
  switch (s.mind.state) {
    case 'berserk': return 'berserk';
    case 'panicked':
    case 'broken': return 'panicked';
    case 'cowering': return 'cowering';
    case 'pinned': return 'pinned';
    case 'shaken': return 'shaken';
    case 'alert':
    case 'wary': return 'alert';
    default: return 'calm';
  }
}

/** §1 posture. `kneeling` is derived, the sim has no such stance: crouching + stationary + aiming /
 * firing / reloading / defending = one knee down; crouching while moving or merely alert = crouched.
 * Pinned men flatten: a pinned kneeler goes prone. Incapacitated / stunned men lie down. */
export function postureFor(s: Soldier, time = 0): Posture {
  if (s.health === 'incapacitated' || s.health === 'dead') return 'prone';
  if (s.stunnedUntil != null && time < s.stunnedUntil) return 'prone';
  if (s.stance === 'prone') return 'prone';
  if (s.stance === 'standing') return 'standing';
  if (isMoving(s)) return 'crouched';
  if (moodFor(s) === 'pinned') return 'prone';
  const aiming = s.targetSoldierId != null || s.targetVehicleId != null || s.targetPoint != null;
  if (STEADY_ACTIVITIES.has(s.activity) || aiming) return 'kneeling';
  return 'crouched';
}

/** Standing <-> prone passes through kneeling for a moment so a man does not pop between them.
 * `since` = seconds since the posture changed (tracked render-side). */
export const POSTURE_TRANSITION_S = 0.22;
export function transitionPosture(prev: Posture, next: Posture, since: number): Posture {
  if (since >= POSTURE_TRANSITION_S || prev === next) return next;
  const tall = (p: Posture) => (p === 'standing' ? 2 : p === 'prone' ? 0 : 1);
  return Math.abs(tall(prev) - tall(next)) === 2 ? 'kneeling' : next;
}

export function actionFor(s: Soldier, time: number, posture: Posture = postureFor(s, time)): AnimAction {
  if (s.health === 'dead') return 'hit';
  if (s.health === 'incapacitated') return 'woundedCrawl';
  if (s.stunnedUntil != null && time < s.stunnedUntil) return 'hide';
  const mood = moodFor(s);
  if (isMoving(s) && mood !== 'cowering' && mood !== 'surrendered') {
    if (posture === 'prone') return 'crawl';
    if (posture === 'crouched' || posture === 'kneeling' || s.activity === 'sneaking') return 'sneak';
    return s.activity === 'movingFast' || mood === 'panicked' || mood === 'berserk' ? 'run' : 'walk';
  }
  if (mood === 'cowering') return 'hide';
  if (mood === 'surrendered') return 'idle';
  const sinceFire = time - s.lastFiredAt;
  if (sinceFire >= 0 && sinceFire < FIRE_KICK_S) return 'fire';
  if (s.activity === 'reloading' && s.reloadTimer > 0) return 'reload';
  if (s.activity === 'hiding' || s.activity === 'ambushing') return 'hide';
  if (s.activity === 'firing' || s.targetSoldierId != null || s.targetVehicleId != null || s.targetPoint != null) return 'aim';
  return 'idle';
}

export function weaponSuffix(weaponId: string): WeaponSuffix {
  const cls = WEAPONS[weaponId]?.cls;
  if (cls === 'smg') return 'smg';
  if (cls === 'lmg' || cls === 'hmg') return 'lmg';
  return 'rifle';
}

/** Entry keys to try, most specific first: mood variant (with then without the weapon suffix) ->
 * base action -> the posture's idle -> standing idle. */
const chainMemo = new Map<string, string[]>();
/** Memoised: the same (frozen) array comes back for the same arguments, so per-frame selection
 * allocates nothing and resolveEntryKey can cache by array identity. */
export function entryKeyChain(posture: Posture, action: AnimAction, mood: Mood, weapon?: WeaponSuffix | null): string[] {
  const id = `${posture}|${action}|${mood}|${weapon ?? ''}`;
  let hit = chainMemo.get(id);
  if (!hit) { hit = buildKeyChain(posture, action, mood, weapon); chainMemo.set(id, hit); }
  return hit;
}
function buildKeyChain(posture: Posture, action: AnimAction, mood: Mood, weapon?: WeaponSuffix | null): string[] {
  const out: string[] = [];
  const push = (k: string) => { if (weapon) out.push(`${k}@${weapon}`); out.push(k); };
  if (mood !== 'calm') push(`${posture}.${action}.${mood}`);
  push(`${posture}.${action}`);
  if (action !== 'idle') {
    if (mood !== 'calm') push(`${posture}.idle.${mood}`);
    push(`${posture}.idle`);
  }
  if (posture !== 'standing') push('standing.idle');
  return out;
}

/** First key of `chain` the atlas has; null when it has none (caller falls back to code sprites). */
const resolveMemo = new WeakMap<object, Map<readonly string[], string | null>>();
export function resolveEntryKey(entries: Record<string, unknown>, chain: readonly string[]): string | null {
  let m = resolveMemo.get(entries);
  if (!m) { m = new Map(); resolveMemo.set(entries, m); }
  const hit = m.get(chain);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  for (const k of chain) if (Object.prototype.hasOwnProperty.call(entries, k)) { found = k; break; }
  if (m.size < 2000) m.set(chain, found);
  return found;
}

/** Heading (radians, 0 = north, clockwise) -> direction index of an atlas with `dirs` directions. */
export function quantiseDir(rad: number, dirs = 16): number {
  const turn = rad / (Math.PI * 2);
  return ((Math.round(turn * dirs) % dirs) + dirs) % dirs;
}

/** The heading to draw: along the path when moving, at the target when aiming, else the sim's
 * 8-way facing. Gives moving / aiming figures real 16-way turns. */
export function headingFor(s: Soldier, targetPos?: Vec2 | null): number {
  const to = (p: Vec2) => Math.atan2(p.x - s.pos.x, -(p.y - s.pos.y));
  if (isMoving(s)) {
    const next = s.path[0];
    if (Math.hypot(next.x - s.pos.x, next.y - s.pos.y) > 0.05) return to(next);
  } else if (targetPos) return to(targetPos);
  else if (s.targetPoint) return to(s.targetPoint);
  return (s.facing * Math.PI) / 4;
}

/** Gait cycles per second so the feet keep pace with the ground: speed / stride length. Shaken
 * men step slower and hesitantly. */
export function gaitCadence(action: AnimAction, speedMps: number, mood: Mood = 'calm'): number {
  if (!GAITS.has(action)) return 0;
  const a = action as keyof typeof STRIDE_M;
  const v = speedMps > 0.05 ? speedMps : DEFAULT_SPEED[a];
  return (v / STRIDE_M[a]) * (mood === 'shaken' ? 0.8 : 1);
}

/** Frame index within an entry — a pure function of the battle clock and the soldier. */
export function frameFor(s: Soldier, time: number, action: AnimAction, entry: AnimEntryInfo, speedMps = 0, mood: Mood = moodFor(s)): number {
  const n = Math.max(1, entry.frames | 0);
  if (n === 1) return 0;
  const off = phaseOffset(s.id);
  if (GAITS.has(action)) {
    const cycles = time * gaitCadence(action, speedMps, mood) + off;
    return Math.floor((cycles - Math.floor(cycles)) * n) % n;
  }
  if (action === 'fire') {
    const t = Math.max(0, time - s.lastFiredAt);
    return Math.min(n - 1, Math.floor((t / FIRE_KICK_S) * n));
  }
  if (action === 'reload') {
    const total = WEAPONS[s.weaponId]?.reloadS ?? 3;
    const prog = total > 0 ? 1 - Math.max(0, Math.min(total, s.reloadTimer)) / total : 1;
    return Math.min(n - 1, Math.floor(prog * n));
  }
  if (action === 'hit') return n - 1;
  const fps = entry.fps > 0 ? entry.fps : n / 1.2;
  const f = Math.floor(time * fps + off * n);
  return entry.loop === false ? Math.min(n - 1, f) : ((f % n) + n) % n;
}

/** A round has just landed near him: flinch (the renderer shows the posture's `hide` frame). */
export function isFlinching(s: Soldier, time: number): boolean {
  const dt = time - s.mind.lastIncomingAt;
  return dt >= 0 && dt < FLINCH_S;
}

/** Shaken / cowering / stationary-panicked men tremble: a 1 px jitter at irregular intervals. */
export function trembleOffset(s: Soldier, time: number, mood: Mood = moodFor(s)): { x: number; y: number } {
  if (mood !== 'shaken' && mood !== 'cowering' && !(mood === 'panicked' && !isMoving(s))) return { x: 0, y: 0 };
  const tick = Math.floor(time * (mood === 'shaken' ? 7 : 11));
  const h = phaseOffset(s.id * 31 + tick);
  if (mood === 'shaken' && h > 0.4) return { x: 0, y: 0 };
  return { x: h < 0.2 ? -1 : h < 0.4 ? 1 : 0, y: h > 0.7 ? 1 : 0 };
}

export interface AnimPick {
  posture: Posture; action: AnimAction; mood: Mood; weapon: WeaponSuffix;
  heading: number; keys: string[]; flinch: boolean;
}

/** Everything but the atlas lookup, in one call. */
export function pickAnimation(s: Soldier, time: number, targetPos?: Vec2 | null, posture: Posture = postureFor(s, time)): AnimPick {
  const mood = moodFor(s);
  let action = actionFor(s, time, posture);
  const flinch = isFlinching(s, time) && !GAITS.has(action) && action !== 'fire';
  if (flinch && action !== 'hit') action = 'hide';
  const weapon = weaponSuffix(s.weaponId);
  return { posture, action, mood, weapon, heading: headingFor(s, targetPos), keys: entryKeyChain(posture, action, mood, weapon), flinch };
}

// ------------------------------------------------------------------ blast ragdoll (pure half) ---
export const RAGDOLL_FLIGHT_VARIANTS = 6;
export const RAGDOLL_LANDED_VARIANTS = 8;
export const RAGDOLL_MAX_ACTIVE = 12;

/** Flight time: 0.5 s for a nudge up to 1.9 s for a heavy shell at arm's length (15 m throw). */
export function ragdollDuration(force: number): number {
  return Math.max(0.5, Math.min(1.9, 0.5 + 0.62 * force * force));
}

export interface RagdollSample {
  /** 0..1 through the flight; >= 1 = landed. */
  t: number;
  /** Ground position (tiles): pre-blast origin -> the sim's post-knockback position. */
  x: number; y: number;
  /** Height above the ground in metres (one main arc and a small bounce). */
  heightM: number;
  /** Shadow size / darkness multiplier: shrinks and fades as he rises. */
  shadow: number;
  landed: boolean;
}

/** Where the thrown body is at battle time `time`. Lands EXACTLY on `pos` (the sim's position). */
export function ragdollSample(blast: NonNullable<Soldier['blast']>, pos: Vec2, time: number): RagdollSample {
  const dur = ragdollDuration(blast.force);
  const t = (time - blast.time) / dur;
  if (t >= 1 || t < 0) return { t: Math.max(0, Math.min(1, t)), x: pos.x, y: pos.y, heightM: 0, shadow: 1, landed: t >= 1 };
  // ground track: fast off the blast, sliding to rest (ease-out)
  const e = 1 - (1 - t) * (1 - t);
  const peak = 0.6 + 1.5 * Math.min(1.5, blast.force);
  const split = 0.78; // main arc, then one low bounce
  const heightM = t < split
    ? 4 * peak * (t / split) * (1 - t / split)
    : 4 * peak * 0.18 * ((t - split) / (1 - split)) * (1 - (t - split) / (1 - split));
  return {
    t, x: blast.origin.x + (pos.x - blast.origin.x) * e, y: blast.origin.y + (pos.y - blast.origin.y) * e,
    heightM, shadow: 1 / (1 + heightM * 0.9), landed: false,
  };
}

export function ragdollVariants(id: number, blastTime: number): { flight: number; landed: number } {
  const h = phaseOffset(id * 131 + Math.round(blastTime * 10));
  const g = phaseOffset(id * 17 + 5 + Math.round(blastTime * 10));
  return { flight: Math.floor(h * RAGDOLL_FLIGHT_VARIANTS), landed: Math.floor(g * RAGDOLL_LANDED_VARIANTS) };
}

/** Direction the body is thrown (radians, 0 = north, clockwise): straight away from the burst. */
export function ragdollHeading(blast: NonNullable<Soldier['blast']>, pos: Vec2): number {
  const dx = pos.x - blast.from.x, dy = pos.y - blast.from.y;
  if (Math.hypot(dx, dy) < 1e-4) return 0;
  return Math.atan2(dx, -dy);
}

/** Metres -> screen px at `zoom` (10 px per metre at zoom 1). */
export function metresToPx(m: number, zoom: number): number { return (m / TILE_M) * 20 * zoom; }
