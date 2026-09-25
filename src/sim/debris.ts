// ============================================================================
// debris.ts — bodies stay physical (spec 2026-09-17 §8).
//
// * `blastThrowEnd`: where something thrown by a burst comes to rest — the one ground trace shared
//   by living men, corpses (combat.ts applyBlastKnockback), kit (items.ts) and body parts: straight
//   away from the burst, never through a wall, a vehicle, water or off the map.
// * Severe blasts (`isSevereBlast`) break a body up: the soldier is marked `dismembered` and his
//   parts are recorded in `state.debris` (capped, oldest removed) with positions and spins from the
//   seeded Rng, so replays are identical. Each part lands with a small stain; men within 20 m who
//   see it take a stress spike (green troops more).
// * Parts are loose objects afterwards: later bursts move them again (`throwDebris`).
// Deterministic: seeded Rng only, array / Map iteration order only.
// ============================================================================
import type { BattleState, Debris, DebrisKind, Soldier, Terrain, Vec2, WeaponDef } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { clamp, dist } from '@/shared/math';
import { inBounds, tileAt } from './map';
import { isPassable } from './path';
import { hasLOS } from './los';
import { addStress } from './mind';

export const DEBRIS_CAP = 300;
export const DEBRIS_VARIANTS = 3;
const WITNESS_RADIUS_TILES = 20 / TILE_M;
const BLAST_WALLS = new Set<Terrain>(['stonewall', 'buildingWood', 'buildingStone']);

/** Lazily created (test literals build a BattleState without it). */
export function debrisOf(state: BattleState): Debris[] {
  return state.debris ?? (state.debris = []);
}

/** Metres a body / object is thrown by a blast of `force` (combat.ts blastForce): quadratic, so a
 * grenade at arm's length gives about 5 m, a mortar bomb about 10 m, a heavy shell the full 15 m. */
export function blastThrowM(force: number): number {
  return clamp(1 + force * force * 9.5, 1, 15);
}

/** End point of a throw of `throwM` metres from `origin` along `ang` (atan2 radians): stops at the
 * last passable point before a wall, a vehicle, water or the map edge. */
export function blastThrowEnd(state: BattleState, origin: Vec2, ang: number, throwM: number): Vec2 {
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const lenTiles = throwM / TILE_M;
  const steps = Math.ceil(lenTiles / 0.2);
  const otx = Math.floor(origin.x), oty = Math.floor(origin.y);
  let p = origin;
  for (let i = 1; i <= steps; i++) {
    const t = Math.min(lenTiles, i * 0.2);
    const q = { x: origin.x + ux * t, y: origin.y + uy * t };
    const tx = Math.floor(q.x), ty = Math.floor(q.y);
    if (!inBounds(state.map, tx, ty) || !isPassable(state.map, tx, ty, 'infantry')) break;
    // walls stop a thrown body even though a man can climb them on his own feet
    if ((tx !== otx || ty !== oty) && BLAST_WALLS.has(tileAt(state.map, tx, ty))) break;
    let hitVehicle = false;
    for (const v of state.vehicles.values()) if (dist(v.pos, q) < 1.2) { hitVehicle = true; break; }
    if (hitVehicle) break;
    p = q;
  }
  return { x: p.x, y: p.y };
}

/** How close (m) a burst of this weapon must land to tear a body apart; 0 = never. A mortar bomb
 * or a light gun's HE within about 1 m, a 75 mm+ shell within about 2 m (heavy 122 mm+ 3 m), a
 * satchel charge 2.5 m. Any weapon that actually kills by fragmentation (lethality > 0) also
 * shreds within 1.5 m — a near-direct hit blows the man to pieces (user rule): this is what makes
 * hand grenades lethal up close where their wide-but-weak fragment ring is not. AT rockets are
 * shaped charges (no fragments) and never shred. */
export function severeRadiusM(weapon: WeaponDef): number {
  if (weapon.heRadiusM <= 0 || weapon.cls === 'flamethrower' || weapon.cls === 'atrocket') return 0;
  const nearDirect = weapon.lethality > 0 ? 1.5 : 0;
  if (weapon.cls === 'grenade') return weapon.id === 'satchel' ? 2.5 : nearDirect;
  if (weapon.cls === 'mortar') return Math.max(1, nearDirect);
  const byCalibre = weapon.heRadiusM >= 8 ? 3 : weapon.heRadiusM >= 4 ? 2 : weapon.heRadiusM >= 3 ? 1 : 0;
  return Math.max(byCalibre, nearDirect);
}

export function isSevereBlast(weapon: WeaponDef, dTiles: number): boolean {
  return dTiles * TILE_M <= severeRadiusM(weapon) + 1e-9;
}

const PARTS: DebrisKind[] = ['torso', 'head', 'arm', 'arm', 'leg', 'leg'];

/** Break the body of `s` up (he is dead from here on): parts scattered 1-8 m along the blast
 * direction in a fan, each with a small stain. Idempotent. */
export function dismember(state: BattleState, rng: Rng, s: Soldier, burst: Vec2, force: number): void {
  if (s.dismembered) return;
  s.dismembered = true;
  if (s.health !== 'dead') { s.health = 'dead'; s.activity = 'dead'; }
  s.path = [];
  s.stunnedUntil = undefined;
  const debris = debrisOf(state);
  const origin = s.blast?.origin ?? s.pos;
  const d = dist(origin, burst);
  const base = d > 1e-3 ? Math.atan2(origin.y - burst.y, origin.x - burst.x) : rng.range(0, Math.PI * 2);
  const season = state.map.def.season;
  const kinds = rng.chance(0.5) ? [...PARTS, 'boot' as DebrisKind] : PARTS;
  for (const kind of kinds) {
    const ang = base + rng.range(-0.7, 0.7);
    const throwM = rng.range(1, 8) * (kind === 'torso' ? 0.6 : 1);
    const pos = blastThrowEnd(state, origin, ang, Math.max(1, throwM));
    debris.push({
      kind, side: s.side, season, pos, dir: rng.range(0, Math.PI * 2), variant: rng.int(0, DEBRIS_VARIANTS - 1),
      from: { x: origin.x, y: origin.y }, thrownAt: state.time, force: Math.max(0.6, force),
    });
    state.bloodDecals.push({ x: pos.x, y: pos.y });
  }
  if (debris.length > DEBRIS_CAP) debris.splice(0, debris.length - DEBRIS_CAP);

  // witnesses within 20 m who can see it (either side); green troops take it harder
  for (const w of state.soldiers.values()) {
    if (w.id === s.id || w.vehicleId != null) continue;
    if (w.health === 'dead' || w.health === 'incapacitated') continue;
    if (dist(w.pos, origin) > WITNESS_RADIUS_TILES) continue;
    if (!hasLOS(state.map, w.pos, origin)) continue;
    addStress(w.mind, w.experience < 35 ? 18 : w.experience < 65 ? 11 : 6);
  }
}

/** A later burst moves the parts lying inside its radius, like everything else loose. */
export function throwDebris(state: BattleState, rng: Rng, burst: Vec2, radiusTiles: number, forceAt: (dTiles: number) => number): void {
  const debris = state.debris;
  if (!debris || debris.length === 0 || radiusTiles <= 0) return;
  for (const part of debris) {
    if (Math.abs(part.pos.x - burst.x) > radiusTiles || Math.abs(part.pos.y - burst.y) > radiusTiles) continue;
    const d = dist(part.pos, burst);
    if (d > radiusTiles) continue;
    const force = forceAt(d);
    if (force <= 0.05) continue;
    const ang = d > 1e-3 ? Math.atan2(part.pos.y - burst.y, part.pos.x - burst.x) : rng.range(0, Math.PI * 2);
    const from = { x: part.pos.x, y: part.pos.y };
    part.pos = blastThrowEnd(state, from, ang + rng.range(-0.3, 0.3), blastThrowM(force) * rng.range(0.6, 1.1));
    part.dir = rng.range(0, Math.PI * 2);
    part.from = from; part.thrownAt = state.time; part.force = force;
  }
}
