import type { BattleState, GameMap, Team, TeamDef, Side, Vec2, Soldier, Vehicle } from '@/shared/types';
import { TILE_M } from '@/shared/types';
import type { Rng } from '@/shared/rng';
import { angleTo, vadd } from '@/shared/math';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { randomName } from '@/data/names';
import { rollExperience } from '@/data/experience';
import { baseMotivation, createMind, rollTrait } from './mind';
import { isPassable } from './path';

const RELOAD_HEAVY = new Set(['mortar', 'atgun', 'atrocket']);

const HEAVY_CLS = new Set(['hmg', 'lmg', 'mortar', 'atgun']);
/** Minimum spacing between two formation slots. Two points >= sqrt(2) apart can never share a
 * tile, whatever the anchor's fractional position, so every slot lands on its own tile. */
const MIN_SLOT_SPACING = 1.5;

/** Rotate a vector clockwise (screen coords, y down) by `rad`; the sim's heading convention
 * (`angleTo`): 0 = north (-y), PI/2 = east. A canonical offset whose front is -y rotated by a
 * heading therefore has its front facing that heading. */
export function rotateOffset(v: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Heading a freshly deployed team faces: from its own deploy zone towards the enemy's. The
 * soldiers' stored `formationOffset` is the canonical shape rotated to this heading, so the deploy
 * screen's drag ghost (which draws the raw offsets) matches the on-map layout. Move orders rotate
 * the offsets by (order heading - this heading). */
export function formationBaseHeading(map: GameMap, side: Side): number {
  const own = map.def.deployZones[side];
  const enemy = map.def.deployZones[side === 'german' ? 'soviet' : 'german'];
  const a = { x: own.x + own.w / 2, y: own.y + own.h / 2 };
  const b = { x: enemy.x + enemy.w / 2, y: enemy.y + enemy.h / 2 };
  if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
    return angleTo(a, { x: map.width / 2, y: map.height / 2 });
  }
  return angleTo(a, b);
}

const j = (rng: Rng, amp: number) => rng.range(-amp, amp);

/** Place `pt` so that it is at least MIN_SLOT_SPACING from every slot already placed: re-jitter a
 * few times, then push it outward from the nearest conflicting slot. */
function spaced(rng: Rng, placed: Vec2[], want: () => Vec2): Vec2 {
  let p = want();
  for (let tries = 0; tries < 12; tries++) {
    if (placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= MIN_SLOT_SPACING)) return p;
    p = want();
  }
  for (let guard = 0; guard < 20; guard++) {
    let nearest: Vec2 | null = null;
    let nd = Infinity;
    for (const q of placed) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < nd) { nd = d; nearest = q; }
    }
    if (!nearest || nd >= MIN_SLOT_SPACING) break;
    const ang = nd > 1e-3 ? Math.atan2(p.y - nearest.y, p.x - nearest.x) : rng.range(0, Math.PI * 2);
    p = { x: nearest.x + Math.cos(ang) * (MIN_SLOT_SPACING + 0.05), y: nearest.y + Math.sin(ang) * (MIN_SLOT_SPACING + 0.05) };
  }
  return p;
}

/** Natural, seeded formation shape for a team, in the canonical frame (front = -y, x = right),
 * with the leader (index 0) at the origin. Round-4 critique: squads deployed and moved in exact
 * parade-ground rows; the original's squads are loose clusters strung along cover.
 * - rifle/SMG/engineer/AT-rocket squads: a loose wedge (point forward) or skirmish line
 *   (perpendicular to the front), 2-3 tile spacing, +/-0.8 tile jitter per man;
 * - MG / mortar / AT-gun crews: tight cluster around the man carrying the weapon;
 * - snipers: solo (a spotter, if any, tucked in behind);
 * - command: small loose group.
 * No two slots are closer than MIN_SLOT_SPACING (so never on one tile). */
export function naturalFormation(def: TeamDef, rng: Rng): Vec2[] {
  const n = def.soldiers.length;
  if (n === 0) return [];
  if (def.vehicleDefId) return def.soldiers.map(() => ({ x: 0, y: 0 }));
  const placed: Vec2[] = [];
  const type = def.type;

  if (type === 'mg' || type === 'mortar' || type === 'atgun') {
    let w = def.soldiers.findIndex((sd) => HEAVY_CLS.has(WEAPONS[sd.weaponId]?.cls ?? ''));
    if (w < 0) w = 0;
    const slots: Vec2[] = new Array(n);
    slots[w] = { x: j(rng, 0.3), y: j(rng, 0.3) };
    placed.push(slots[w]);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (i === w) continue;
      // crew fan out beside and behind the weapon (t: 0 = abreast, PI/2 = directly behind); the
      // first two close in, the rest a little wider and further back
      const side = k % 2 === 0 ? 1 : -1;
      const r = k < 2 ? rng.range(1.5, 2.1) : rng.range(2.0, 2.8);
      const c = slots[w];
      slots[i] = spaced(rng, placed, () => {
        const t = Math.min(1.45, 0.3 + 0.45 * Math.floor(k / 2) + j(rng, 0.3));
        return { x: c.x + side * r * Math.cos(t), y: c.y + r * Math.sin(t) };
      });
      placed.push(slots[i]);
      k++;
    }
    const l = slots[0];
    return slots.map((p) => ({ x: p.x - l.x, y: p.y - l.y }));
  }

  if (type === 'sniper') {
    const slots: Vec2[] = [{ x: 0, y: 0 }];
    placed.push(slots[0]);
    for (let i = 1; i < n; i++) {
      const p = spaced(rng, placed, () => ({ x: (rng.chance(0.5) ? 1 : -1) * rng.range(1.0, 1.8), y: rng.range(1.2, 2.0) }));
      slots.push(p); placed.push(p);
    }
    return slots;
  }

  if (type === 'command') {
    const slots: Vec2[] = [{ x: 0, y: 0 }];
    placed.push(slots[0]);
    for (let i = 1; i < n; i++) {
      const p = spaced(rng, placed, () => {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(1.6, 3.0);
        return { x: Math.cos(a) * r, y: Math.abs(Math.sin(a)) * r * 0.8 + j(rng, 0.8) };
      });
      slots.push(p); placed.push(p);
    }
    return slots;
  }

  // Rifle / SMG / engineers / AT-rocket teams.
  const slots: Vec2[] = [{ x: 0, y: 0 }];
  placed.push(slots[0]);
  const wedge = n <= 3 || rng.chance(0.5);
  if (wedge) {
    // point forward: the leader leads, the others echelon back to both flanks
    const lat: number[] = [0, 0];
    const dep: number[] = [0, 0];
    for (let i = 1; i < n; i++) {
      const sideIdx = i % 2; // 1 = right, 0 = left
      const sign = sideIdx === 1 ? 1 : -1;
      const gap = rng.range(2, 3);
      lat[sideIdx] += gap * 0.72;
      dep[sideIdx] += gap * 0.6;
      const lx = lat[sideIdx], dy = dep[sideIdx];
      const p = spaced(rng, placed, () => ({ x: sign * lx + j(rng, 0.8), y: dy + j(rng, 0.8) }));
      slots.push(p); placed.push(p);
    }
  } else {
    // skirmish line abreast (two loose ranks for big squads), leader just behind the centre
    const ranks = n > 6 ? 2 : 1;
    slots[0] = { x: 0, y: 0 };
    const followers = n - 1;
    const perRank = Math.ceil(followers / ranks);
    for (let i = 0; i < followers; i++) {
      const rank = Math.floor(i / perRank);
      const idx = i % perRank;
      const count = Math.min(perRank, followers - rank * perRank);
      const gap = rng.range(2, 3);
      const stagger = rank % 2 === 1 ? gap / 2 : 0;
      const x = (idx - (count - 1) / 2) * gap + stagger;
      const y = -0.9 + rank * rng.range(2, 2.8);
      const p = spaced(rng, placed, () => ({ x: x + j(rng, 0.8), y: y + j(rng, 0.8) }));
      slots.push(p); placed.push(p);
    }
  }
  return slots;
}

/** Legacy single-soldier helper: anchor + offset clamped inside the map; falls back to the
 * (passable) team anchor when that tile is impassable. Prefer `layoutTeamPositions`. */
export function formationPos(map: GameMap, anchor: Vec2, offset: Vec2): Vec2 {
  const p = vadd(anchor, offset);
  p.x = Math.min(Math.max(p.x, 0.5), map.width - 0.5);
  p.y = Math.min(Math.max(p.y, 0.5), map.height - 0.5);
  if (isPassable(map, Math.floor(p.x), Math.floor(p.y), 'infantry')) return p;
  return {
    x: Math.min(Math.max(anchor.x, 0.5), map.width - 0.5),
    y: Math.min(Math.max(anchor.y, 0.5), map.height - 0.5),
  };
}

/** Infantry positions for a whole team at `anchor` + each offset, clamped inside the map, each on
 * its own passable tile: a slot on an impassable or already-taken tile moves to the nearest free
 * passable tile (keeping its sub-tile jitter), so deploy/spawn never stacks two men on a tile or
 * puts anyone off-map (where findPath returns [] and he would be stuck forever). */
export function layoutTeamPositions(map: GameMap, anchor: Vec2, offsets: Vec2[]): Vec2[] {
  const used = new Set<number>();
  const out: Vec2[] = [];
  const clampX = (x: number) => Math.min(Math.max(x, 0.5), map.width - 0.5);
  const clampY = (y: number) => Math.min(Math.max(y, 0.5), map.height - 0.5);
  for (const off of offsets) {
    const p = { x: clampX(anchor.x + off.x), y: clampY(anchor.y + off.y) };
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    const fx = p.x - tx, fy = p.y - ty;
    let chosen: Vec2 | null = null;
    for (let r = 0; r <= 5 && !chosen; r++) {
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx, y = ty + dy;
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          if (used.has(y * map.width + x) || !isPassable(map, x, y, 'infantry')) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            // keep the slot's own position on its tile; elsewhere keep its sub-tile jitter, softened
            chosen = r === 0 ? p : { x: x + 0.5 + (fx - 0.5) * 0.6, y: y + 0.5 + (fy - 0.5) * 0.6 };
          }
        }
      }
    }
    if (!chosen) chosen = { x: clampX(anchor.x), y: clampY(anchor.y) };
    used.add(Math.floor(chosen.y) * map.width + Math.floor(chosen.x));
    out.push(chosen);
  }
  return out;
}

// ------------------------------------------------------------ vehicle deployment spacing ---
/** Clear ground kept between two deployed hulls, on top of the longer hull's length (metres). */
export const VEHICLE_DEPLOY_GAP_M = 4;

/** Minimum centre-to-centre distance (tiles) between two deployed vehicles: the longer hull's
 * length + VEHICLE_DEPLOY_GAP_M, so the hulls can never overlap whatever their facings. */
export function vehicleDeploySpacing(defA: string, defB: string): number {
  const la = VEHICLE_DEFS[defA]?.lengthM ?? 6, lb = VEHICLE_DEFS[defB]?.lengthM ?? 6;
  return (Math.max(la, lb) + VEHICLE_DEPLOY_GAP_M) / TILE_M;
}

/** Nearest spot to `want` for a `defId` vehicle that is vehicle-passable, inside `side`'s deploy
 * zone and at least `vehicleDeploySpacing` from every vehicle in `others`. Among near-equal
 * candidates it prefers a STAGGERED one (echeloned fore/aft of its neighbours along the heading
 * towards the enemy) over one exactly abreast. Deterministic — no rng — so it never perturbs the
 * battle's random stream. Returns `want` unchanged when it is already fine (or nothing better
 * exists within the search radius). */
export function findVehicleDeploySpot(state: BattleState, side: Side, defId: string, want: Vec2, others: readonly Vehicle[]): Vec2 {
  const map = state.map;
  const zone = map.def.deployZones[side];
  // only hold the search to the deploy zone when the wanted spot is itself inside it
  const zoned = want.x >= zone.x && want.x < zone.x + zone.w && want.y >= zone.y && want.y < zone.y + zone.h;
  const clear = (p: Vec2): boolean => others.every((o) => Math.hypot(o.pos.x - p.x, o.pos.y - p.y) >= vehicleDeploySpacing(defId, o.defId));
  const okTile = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < map.width && y < map.height
    && (!zoned || (x + 0.5 >= zone.x && x + 0.5 < zone.x + zone.w && y + 0.5 >= zone.y && y + 0.5 < zone.y + zone.h))
    && isPassable(map, x, y, 'vehicle');
  if (clear(want)) return want;
  const heading = formationBaseHeading(map, side);
  const fx = Math.sin(heading), fy = -Math.cos(heading);
  const tx = Math.floor(want.x), ty = Math.floor(want.y);
  let best: Vec2 | null = null;
  let bestScore = Infinity;
  for (let r = 1; r <= 24; r++) {
    if (best && r > bestScore + 2) break;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (!okTile(x, y)) continue;
        const p = { x: x + 0.5, y: y + 0.5 };
        if (!clear(p)) continue;
        let score = Math.hypot(p.x - want.x, p.y - want.y);
        // staggered beats abreast / nose-to-tail: penalise lining up with a near neighbour
        for (const o of others) {
          const ox = p.x - o.pos.x, oy = p.y - o.pos.y;
          if (Math.hypot(ox, oy) > vehicleDeploySpacing(defId, o.defId) * 1.8) continue;
          const along = Math.abs(ox * fx + oy * fy), across = Math.abs(-ox * fy + oy * fx);
          if (along < 1.5 || across < 1.5) score += 2;
        }
        if (score < bestScore) { bestScore = score; best = p; }
      }
    }
  }
  return best ?? want;
}

/** Move one deployed vehicle team (hull, team anchor and mounted crew) to `pos`. */
function placeVehicleTeam(state: BattleState, veh: Vehicle, pos: Vec2): void {
  veh.pos = { x: pos.x, y: pos.y };
  const team = state.teams.get(veh.teamId);
  if (!team) return;
  team.pos = { x: pos.x, y: pos.y };
  for (const sid of team.soldierIds) {
    const so = state.soldiers.get(sid);
    if (so && so.vehicleId === veh.id) so.pos = { x: pos.x, y: pos.y };
  }
}

/** Auto-deployment pass for `side`'s vehicles (run after aiDeploy / the deploy screen's Auto):
 * any vehicle closer than hull length + 4 m to one already settled is moved to the nearest free,
 * vehicle-passable, staggered spot in the deploy zone, and every vehicle is turned to face the
 * enemy. Deterministic and rng-free. */
export function spaceOutVehicles(state: BattleState, side: Side): void {
  if (state.phase !== 'deploy') return;
  const heading = formationBaseHeading(state.map, side);
  const settled: Vehicle[] = [];
  for (const v of state.vehicles.values()) if (v.side !== side) settled.push(v);
  for (const v of state.vehicles.values()) {
    if (v.side !== side) continue;
    const spot = findVehicleDeploySpot(state, side, v.defId, v.pos, settled);
    if (spot.x !== v.pos.x || spot.y !== v.pos.y) placeVehicleTeam(state, v, spot);
    v.hullFacing = heading;
    v.turretFacing = heading;
    settled.push(v);
  }
}

/** Create a Team (and its soldiers, and its Vehicle if the def specifies one) at `pos`. */
export function spawnTeam(state: BattleState, def: TeamDef, side: Side, pos: Vec2, rng: Rng): Team {
  const teamId = state.nextId++;
  const soldierIds: number[] = [];

  const team: Team = {
    id: teamId,
    defId: def.id,
    side,
    name: def.name,
    type: def.type,
    soldierIds,
    leaderId: -1,
    vehicleId: null,
    order: null,
    facing: 0,
    experience: 0,
    morale: 80,
    status: 'Idle',
    pos: { x: pos.x, y: pos.y },
    outOfAction: false,
    kills: 0,
    aiObjective: null,
  };

  let vehicle: Vehicle | null = null;
  if (def.vehicleDefId) {
    const vdef = VEHICLE_DEFS[def.vehicleDefId];
    // never on top of a vehicle already on the map, and facing the enemy's side of it
    pos = findVehicleDeploySpot(state, side, def.vehicleDefId, pos, Array.from(state.vehicles.values()));
    team.pos = { x: pos.x, y: pos.y };
    const facing = formationBaseHeading(state.map, side);
    vehicle = {
      id: state.nextId++,
      teamId,
      side,
      defId: def.vehicleDefId,
      pos: { x: pos.x, y: pos.y },
      hullFacing: facing,
      turretFacing: facing,
      state: 'ok',
      mainAmmo: vdef ? vdef.mainAmmo : 0,
      coaxAmmo: 250,
      path: [],
      speed: 0,
      targetVehicleId: null,
      targetSoldierId: null,
      targetPoint: null,
      mainFireTimer: 0,
      coaxFireTimer: 0,
      burnTimer: 0,
      hits: 0,
    };
    state.vehicles.set(vehicle.id, vehicle);
    team.vehicleId = vehicle.id;
  }

  const baseHeading = formationBaseHeading(state.map, side);
  const offsets = naturalFormation(def, rng).map((o) => rotateOffset(o, baseHeading));
  const positions = vehicle ? null : layoutTeamPositions(state.map, pos, offsets);
  let totalExp = 0;
  def.soldiers.forEach((sd, i) => {
    const weapon = WEAPONS[sd.weaponId];
    const ammo = weapon ? weapon.ammo : 0;
    const reserveMul = weapon && RELOAD_HEAVY.has(weapon.cls) ? 12 : 6;
    const isCrew = !!def.vehicleDefId;
    const grenades = sd.grenades ?? (isCrew ? 0 : (weapon && (weapon.cls === 'rifle' || weapon.cls === 'smg') ? 2 : 0));
    // by side, year and kind of unit (data/experience.ts); one draw per man, as ever
    const experience = rollExperience(def, state.config.year, i === 0, rng.next());
    totalExp += experience;
    const offset = offsets[i];
    const soldierPos = vehicle || !positions ? { x: pos.x, y: pos.y } : positions[i];

    const soldier: Soldier = {
      id: state.nextId++,
      teamId,
      side,
      name: randomName(side, rng),
      rank: sd.rank,
      weaponId: sd.weaponId,
      ammo,
      ammoReserve: ammo * reserveMul,
      grenades,
      health: 'healthy',
      morale: rng.range(70, 90),
      fatigue: 0,
      suppression: 0,
      experience,
      stance: 'standing',
      activity: 'idle',
      pos: soldierPos,
      facing: 0,
      targetSoldierId: null,
      targetVehicleId: null,
      targetPoint: null,
      path: [],
      reloadTimer: 0,
      fireTimer: 0,
      animFrame: 0,
      isLeader: i === 0,
      vehicleId: vehicle ? vehicle.id : null,
      formationOffset: offset,
      lastFiredAt: -999,
      cover: 0,
      kills: 0,
      mind: createMind(baseMotivation(experience, i === 0), state.time, rollTrait(rng, i === 0)),
    };
    state.soldiers.set(soldier.id, soldier);
    soldierIds.push(soldier.id);
    if (i === 0) team.leaderId = soldier.id;
  });

  team.experience = def.soldiers.length ? totalExp / def.soldiers.length : 50;
  state.teams.set(teamId, team);
  return team;
}
