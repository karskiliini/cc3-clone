// ============================================================================
// stateHash.ts — a 32-bit fingerprint of the battle (multiplayer plan §3 "Desync detection",
// §7 P4). Two machines running the same config and command log must produce the same hash after
// every tick; the first tick where they differ is where a desync (or a cross-engine float
// difference) entered. FNV-1a over integers: the RNG position, the clock, the id counter, every
// soldier, vehicle and victory location, and the side scores.
//
// Numbers are hashed by their exact float64 bits, not rounded: lockstep needs bit-identical
// state, and the hash should see a last-bit difference on the tick it appears rather than ticks
// later once it has grown past a rounding step. Read-only: hashing never changes the battle
// (it never builds the height field or touches the RNG).
// ============================================================================
import type { BattleState, Vec2 } from '@/shared/types';
import type { Rng } from '@/shared/rng';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class Fnv {
  h = FNV_OFFSET;
  /** One 32-bit word, byte by byte. */
  int(v: number): void {
    let h = this.h;
    v |= 0;
    h = Math.imul(h ^ (v & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), FNV_PRIME);
    h = Math.imul(h ^ (v >>> 24), FNV_PRIME);
    this.h = h;
  }
  /** A number by its exact bits (both words of the float64). */
  num(v: number): void {
    f64[0] = v;
    this.int(u32[0]);
    this.int(u32[1]);
  }
  bool(v: boolean | undefined): void { this.int(v ? 1 : 0); }
  str(s: string | null | undefined): void {
    if (s == null) { this.int(-1); return; }
    this.int(s.length);
    for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i));
  }
  vec(p: Vec2 | null | undefined): void {
    if (!p) { this.int(-1); return; }
    this.num(p.x);
    this.num(p.y);
  }
}

/** The battle's state fingerprint (unsigned 32-bit). `rng` is the battle's generator. */
export function hashState(battle: { state: BattleState; rng: Rng }): number {
  const { state, rng } = battle;
  const h = new Fnv();
  h.int(rng.state());
  h.int(state.tick ?? 0);
  h.num(state.time);
  h.int(state.nextId);
  h.str(state.phase);
  for (const s of state.soldiers.values()) {
    h.int(s.id);
    h.vec(s.pos);
    h.str(s.health);
    h.str(s.activity);
    h.str(s.stance);
    h.int(s.ammo);
    h.int(s.ammoReserve);
    h.int(s.grenades);
    h.num(s.morale);
    h.num(s.suppression);
    h.int(s.facing);
    h.int(s.path.length);
    h.int(s.targetSoldierId ?? -1);
    h.int(s.targetVehicleId ?? -1);
    h.str(s.mind.state);
    h.num(s.mind.stress);
    h.int(s.vehicleId ?? -1);
  }
  for (const v of state.vehicles.values()) {
    h.int(v.id);
    h.vec(v.pos);
    h.num(v.hullFacing);
    h.num(v.turretFacing);
    h.str(v.state);
    h.int(v.mainAmmo);
    h.int(v.coaxAmmo);
    h.int(v.hits);
    h.num(v.speed);
    h.int(v.path.length);
    if (v.damage) for (const k of Object.keys(v.damage).sort()) { h.str(k); h.str(v.damage[k as keyof typeof v.damage]); }
    else h.int(-1);
  }
  for (const t of state.teams.values()) {
    h.int(t.id);
    h.vec(t.pos);
    h.str(t.status);
  }
  for (const vl of state.map.victoryLocations) {
    h.int(vl.id);
    h.str(vl.owner);
    h.str(vl.capturingSide);
    h.num(vl.captureTimer);
  }
  for (const side of ['german', 'soviet'] as const) {
    const s = state.sides[side];
    h.num(s.morale);
    h.int(s.kills);
    h.int(s.losses);
    h.num(s.score);
    h.bool(s.truceOffered);
    h.bool(s.truceAccepted);
  }
  // terrain the sim changed: crater marks and how many the height field has stamped (D1)
  h.int(state.map.craterMarks?.length ?? 0);
  // (a field not built yet stamps every mark when it is, so it counts as in step)
  const field = state.map.heightField;
  h.int(field ? field.marksApplied : state.map.craterMarks?.length ?? 0);
  h.int(state.map.craters.length);
  // both sides' results, not state.result (that one is the viewer's and differs per client)
  h.str(state.results?.german);
  h.str(state.results?.soviet);
  return h.h >>> 0;
}

/** A hash as eight hex digits, for logs and chains printed side by side. */
export function hashHex(h: number): string {
  return (h >>> 0).toString(16).padStart(8, '0');
}
