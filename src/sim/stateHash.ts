import { computePhysicalBuildings } from './heightField';
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
  /** Stable plain-data fields, including optional presence and exact numbers.
   * Used for small canonical driver records, never render caches or whole maps. */
  data(value: unknown): void {
    if (value === undefined) { this.int(0); return; }
    if (value === null) { this.int(1); return; }
    if (typeof value === 'number') { this.int(2); this.num(value); return; }
    if (typeof value === 'boolean') { this.int(3); this.bool(value); return; }
    if (typeof value === 'string') { this.int(4); this.str(value); return; }
    if (Array.isArray(value)) {
      this.int(5); this.int(value.length); for (const item of value) this.data(item); return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>, keys = Object.keys(record).sort();
      this.int(6); this.int(keys.length); for (const key of keys) { this.str(key); this.data(record[key]); }
      return;
    }
    throw new Error('Non-data value in canonical driver state');
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
    h.int(s.path.length); for (const point of s.path) h.vec(point);
    h.data(s.vehicleWaitSince); h.data(s.vehicleDodgeRollAt);
    h.int(s.targetSoldierId ?? -1);
    h.int(s.targetVehicleId ?? -1);
    h.str(s.mind.state);
    h.num(s.mind.stress);
    h.int(s.vehicleId ?? -1);
    h.data(s.seat); h.data(s.hatch); h.data(s.crewTask);
    if(s.lastToolWorkAt!=null){h.str('toolWork');h.num(s.lastToolWorkAt);}
    if (s.digging) { h.str('digging'); h.data(s.digging); }
    if (s.rider) { h.str('rider'); h.data(s.rider); }
  }
  for (const v of state.vehicles.values()) {
    h.int(v.id);
    if (v.trackChains) { h.str('trackChains'); h.data(v.trackChains); }
    h.vec(v.pos);
    h.num(v.hullFacing);
    h.num(v.turretFacing);
    h.str(v.state);
    h.int(v.mainAmmo);
    h.int(v.coaxAmmo);
    h.int(v.hits);
    h.num(v.speed);
    const b = v.body; h.bool(!!b);
    if (b) {
      for (const p of [b.position, b.velocity, b.angularVelocity]) { h.num(p.x); h.num(p.y); h.num(p.z); }
      const q = b.orientation; h.num(q.x); h.num(q.y); h.num(q.z); h.num(q.w);
      h.int(b.suspensionTravel.length); for (const x of b.suspensionTravel) h.num(x);
      h.bool(b.asleep); h.bool(b.hungUp); h.bool(b.overturned);
      h.num(b.quietS); h.num(b.tippedS); h.num(b.hungS); h.num(b.rockPhaseS);
      h.num(b.rockTries); h.num(b.groundVersion);
    }
    const local = v.localDriver; h.bool(Object.hasOwn(v, 'localDriver')); h.bool(!!local);
    if (local) {
      const field = (o: any, k: string, integer = false) => { h.bool(o != null && Object.hasOwn(o, k)); integer ? h.int(o?.[k]) : h.num(o?.[k]); };
      // Work budgets are safe integers, not restricted to32bits: serialize both words.
      const count = (o: any, k: string) => { field(o,k,true); h.int(Math.floor(o?.[k] / 4294967296)); };
      field(local,'owner',true);
      const e = local.episode; h.bool(Object.hasOwn(local,'episode')); h.bool(!!e);
      if (e) { h.num(e.anchorM.x); h.num(e.anchorM.y); h.int(e.attempts); h.int(e.limit); h.bool(e.exhausted); }
      const p = local.recovery; h.bool(Object.hasOwn(local,'recovery')); h.bool(!!p);
      if (p) {
        field(p,'gear',true); field(p,'capMs'); field(p.anchorM,'x'); field(p.anchorM,'y'); field(p.axis,'x'); field(p.axis,'y'); field(p,'entryMaxProjection');
        h.bool(Object.hasOwn(p,'phase')); h.int(p.phase==='pending'?1:p.phase==='braking'?2:p.phase==='retreat'?3:0);
        h.bool(p.turning);
        count(p,'budgetTicks'); count(p,'elapsedTicks');
      }
      const w = local.window; h.bool(Object.hasOwn(local,'window')); h.bool(!!w);
      if (w) {
        field(w.goal,'x'); field(w.goal,'y'); field(w,'gear',true); field(w,'onlyDir',true); field(w,'direction',true); field(w,'ticks',true);
        field(w,'startDistanceM'); field(w,'startAbsError'); field(w,'startRate'); field(w.axis,'x'); field(w.axis,'y'); field(w,'startFlow'); field(w,'minimumYaw'); field(w,'minimumSpeed');
      }
    }
    h.num(v.gunElevationRad ?? 0);
    h.data(v.navigation);
    h.data(v.passengerIds); h.data(v.unloading); h.data(v.doorBusyUntil); h.data(v.boardingProgress); h.data(v.towedTeamId); h.data(v.mobilityTeamId); h.data(v.seats);
    h.int(v.path.length); for (const point of v.path) h.vec(point);
    // Physical driver and gun ownership gates affect the next accepted pose.
    for (const key of ['targetVehicleId', 'targetSoldierId', 'targetPoint', 'holdUntil', 'blockedSince',
      'giveWayUntil', 'creepForGun', 'creepAim', 'creepUntil', 'fireHaltUntil', 'fireHaltSince',
      'noFireHaltUntil', 'mineTileSeen', 'gunLay', 'loadedRound', 'mainFireTimer', 'loadTotalS'] as const) h.data(v[key]);
    if (v.damage) for (const k of Object.keys(v.damage).sort()) { h.str(k); h.str(v.damage[k as keyof typeof v.damage]); }
    else h.int(-1);
  }
  for (const t of state.teams.values()) {
    h.int(t.id);
    h.vec(t.pos);
    if (t.deploymentFacing != null) { h.str('deploymentFacing'); h.num(t.deploymentFacing); }
    h.str(t.status);
    h.data(t.transportId); h.data(t.assignedVehicleIds); h.data(t.supportForTeamId); h.data(t.mobility); h.data(t.crewWeapon);
    h.bool(!!t.order);
    if (t.order) for (const key of ['type', 'target', 'targetTeamId', 'targetVehicleId', 'lastSeenAt',
      'lastKnownPos', 'issuedAt', 'mountVehicleId', 'onFoot', 'dismount', 'waypoints'] as const) h.data(t.order[key]);
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
  // Pending explosions are canonical future damage, including launch-time incoming geometry.
  h.int(state.pendingBursts.length);
  for (const b of state.pendingBursts) {
    h.num(b.at); h.vec(b.pos); h.str(b.weaponId); h.str(b.side);
    h.bool(b.shooterId !== undefined); if (b.shooterId !== undefined) h.int(b.shooterId);
    h.bool(b.smoke !== undefined); if (b.smoke !== undefined) h.bool(b.smoke);
    h.bool(!!b.trajectory);
    if (b.trajectory) {
      h.vec(b.trajectory.sourcePos);
      for (const p of [b.trajectory.endpoint, b.trajectory.direction]) { h.num(p.x); h.num(p.y); h.num(p.z); }
    }
  }
  if(state.map.foxholes?.size) h.data([...state.map.foxholes].sort((a,b)=>a[0]-b[0]));
  // terrain the sim changed: crater marks and how many the height field has stamped (D1)
  h.int(state.map.craterMarks?.length ?? 0);
  h.data(state.map.craterMarks?.filter(mark => mark.kind !== 'track'));
  // (a field not built yet stamps every mark when it is, so it counts as in step)
  const field = state.map.heightField;
  h.int(field ? field.marksApplied : state.map.craterMarks?.length ?? 0);
  h.num(field?.version ?? 1); h.data(field?.directCraterEdits);
  if(field?.earthworkEdits?.size) h.data([...field.earthworkEdits].sort((a,b)=>a[0]-b[0]));
  const buildings = state.map.physicalBuildings ?? computePhysicalBuildings(state.map);
  h.int(buildings.size);
  for (const [id, info] of [...buildings].sort((a, b) => a[0] - b[0])) { h.int(id); h.data(info); }
  const overrides = state.map.heightOverrides;
  h.int(overrides?.size ?? 0);
  if (overrides) for (const [tile, height] of [...overrides].sort((a, b) => a[0] - b[0])) { h.int(tile); h.data(height); }
  const profiles = state.map.heightProfiles;
  h.int(profiles?.size ?? 0);
  if (profiles) for (const [tile, samples] of [...profiles].sort((a, b) => a[0] - b[0])) { h.int(tile); h.data([...samples]); }
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
