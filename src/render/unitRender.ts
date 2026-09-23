// ============================================================================
// unitRender.ts — draws soldiers, vehicles, selection rings, VL flags, team
// labels and order lines/arcs for the battle viewport.
// ============================================================================
import type {
  Camera, BattleState, Side, GameSettings, Soldier, Team, Facing8,
} from '@/shared/types';
import { VIEW_W, VIEW_H } from '@/shared/types';
import { facingAngle } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import { PALETTE, SIDE_COLOR } from '@/render/palette';
import { getFlagSprite, unitSpriteScale } from '@/render/sprites';
import { drawText, textWidth } from '@/render/pixelfont';
import { VEHICLE_DEFS } from '@/data/units';
import { teamBarColor } from '@/ui/hud/hudChrome';
import { drawOrderMarkers } from '@/render/orderMarkers';
import { CREW_LAYOUT, gunHaulers, crewServedClass, crewWeaponView, crewWeaponVisual, weaponFramePoint } from '@/sim/crewWeapon';
import { FLASH_LIFE, TILE_M } from '@/shared/types';
import type { Vec2, Vehicle } from '@/shared/types';
import { vehicleDamageView, vehicleLayout } from '@/sim/vehicleDamage';
import { hatchWorld, isServiceable } from '@/sim/vehicleCrew';
import { dist, facingFromAngle } from '@/shared/math';
import {
  drawSoldier as drawAtlasSoldier, drawVehiclePart, drawWeapon as drawAtlasWeapon, drawWeaponState, requestBattleAtlases,
  soldierAtlas, itemAtlas, partsAtlas, drawAtlasFrame, weaponMuzzleM, type Atlas,
} from '@/render/spriteAtlas';
import {
  frameFor, moodFor, pickAnimation, postureFor, transitionPosture, trembleOffset, entryKeyChain,
  crewTaskAnim, progressFrame, weaponStateChain, hatchClimbAnim, hatchClimbFrame, isMoving, headingTo, turnToward, TURN_RATE, postureDropProgress,
  DRAG_KEYS, DRAGGED_KEYS, WOUNDED_KEYS, type AnimAction, type Posture,
} from '@/render/soldierAnim';
import { ragdollSample, metresToPx } from '@/render/soldierAnim';
import type { Debris, GroundItem, Season } from '@/shared/types';
import { drawRagdollFlight, drawRagdollLanded, ragdollBeginFrame, ragdollPhase } from '@/render/ragdoll';

// ------------------------------------------------------------ pre-rendered atlases (spec §5) ---
/** Battles whose atlases have been requested (loading is async; until an atlas is ready — or when
 * it does not exist — every unit falls back to its code-drawn sprite). */
const atlasRequested = new WeakSet<object>();
function ensureAtlases(state: BattleState): void {
  if (atlasRequested.has(state) || typeof fetch === 'undefined' || typeof Image === 'undefined') return;
  atlasRequested.add(state);
  const sides = new Set<Side>();
  for (const t of state.teams.values()) sides.add(t.side);
  const defs = new Set<string>();
  for (const v of state.vehicles.values()) defs.add(v.defId);
  void requestBattleAtlases(Array.from(sides), state.map.def.season, undefined, Array.from(defs));
}

/** Render-side memory per soldier: measured ground speed (for gait cadence) and the last posture
 * with its change time (for stand <-> prone transitions). Never read by the sim. */
interface AnimTrack {
  x: number; y: number; t: number; speed: number; measured: boolean; posture: Posture; since: number;
  /** drawn heading (radians), turned smoothly toward the wanted one; hdT = battle time it was set */
  hd?: number; hdT?: number;
}
/** Measured ground speed, or undefined until the first measurement (the path decides then). */
const trackSpeed = (tr: AnimTrack): number | undefined => (tr.measured ? tr.speed : undefined);
const animTracks = new Map<number, AnimTrack>();
/** Which way a man who is down lies (radians): set while he is dragged, kept when he is set down. */
const downHeading = new Map<number, number>();
let animTrackTime = -1;
function animTrackFor(s: Soldier, time: number): AnimTrack {
  if (time < animTrackTime - 0.5) { animTracks.clear(); downHeading.clear(); } // a new battle
  animTrackTime = time;
  let tr = animTracks.get(s.id);
  if (!tr) { const posture = postureFor(s, time); tr = { x: s.pos.x, y: s.pos.y, t: time, speed: 0, measured: false, posture, since: time - 10 }; animTracks.set(s.id, tr); return tr; }
  const dt = time - tr.t;
  if (dt >= 0.1) {
    const v = (Math.hypot(s.pos.x - tr.x, s.pos.y - tr.y) * TILE_M) / dt;
    tr.speed = v > 12 ? tr.speed : tr.speed * 0.5 + v * 0.5; // ignore teleports (knockback, deploy)
    tr.x = s.pos.x; tr.y = s.pos.y; tr.t = time; tr.measured = true;
  }
  const posture = postureFor(s, time, trackSpeed(tr));
  if (posture !== tr.posture) {
    // keep the old posture visible in `transitionPosture` by remembering it in `prev`
    (tr as AnimTrack & { prev?: Posture }).prev = tr.posture;
    tr.posture = posture; tr.since = time;
  }
  return tr;
}

/** The heading to draw this frame: `target`, reached by turning at TURN_RATE (never in a pause). */
function smoothHeading(tr: AnimTrack, target: number, time: number): number {
  const dt = tr.hdT == null ? 1e9 : Math.max(0, time - tr.hdT);
  tr.hd = tr.hd == null ? target : turnToward(tr.hd, target, TURN_RATE * Math.min(dt, 1));
  tr.hdT = time;
  return tr.hd;
}

/** Crew role poses -> atlas entry keys (serving loops), most specific first. */
type CrewPose = 'gunnerKneel' | 'loaderRound' | 'loaderShell' | 'mgProne' | 'carryTube' | 'carryPlate' | 'carryMg' | 'carryTripod' | 'haul';
const CREW_KEYS: Record<CrewPose, string[]> = {
  gunnerKneel: ['crew.gunner', 'kneeling.aim', 'kneeling.idle'],
  loaderRound: ['crew.loader.mortar', 'crew.loader', 'kneeling.reload', 'kneeling.idle'],
  loaderShell: ['crew.loader.gun', 'crew.loader', 'kneeling.reload', 'kneeling.idle'],
  mgProne: ['crew.mg', 'prone.aim@lmg', 'prone.aim', 'prone.idle'],
  carryTube: ['crew.carry.tube', 'crew.carry', 'standing.walk'],
  carryPlate: ['crew.carry.plate', 'crew.carry', 'standing.walk'],
  carryMg: ['crew.carry.mg', 'crew.carry', 'standing.walk@lmg', 'standing.walk'],
  carryTripod: ['crew.carry.tripod', 'crew.carry', 'standing.walk'],
  haul: ['crew.haul', 'standing.walk'],
};

/** Draw one living soldier from his side's atlas. False => no atlas / no usable entry. */
function drawSoldierFromAtlas(
  ctx: CanvasRenderingContext2D, atlas: Atlas, state: BattleState, s: Soldier, p: { x: number; y: number }, zoom: number,
  crew: CrewSoldierDraw | undefined, draggedBy?: Soldier,
): boolean {
  const time = state.time;
  const tr = animTrackFor(s, time);
  if (draggedBy) {
    // a casualty being dragged to cover: on his back, head toward the man pulling him
    const hd = headingTo(s.pos, draggedBy.pos);
    downHeading.set(s.id, hd);
    return drawAtlasSoldier(ctx, atlas, DRAGGED_KEYS, hd, (e) => e.frames - 1, p.x, p.y, zoom) != null;
  }
  if (s.health === 'incapacitated' && !isMoving(s, trackSpeed(tr))) {
    return drawAtlasSoldier(ctx, atlas, WOUNDED_KEYS, downHeading.get(s.id) ?? (s.facing * Math.PI) / 4, (e) => e.frames - 1, p.x, p.y, zoom) != null;
  }
  const patient = s.carrying ? state.soldiers.get(s.carrying.patientId) : undefined;
  if (patient) {
    // dragging him: facing the casualty, stepping backwards (still frame when halted)
    const moving = isMoving(s, trackSpeed(tr));
    return drawAtlasSoldier(ctx, atlas, DRAG_KEYS, smoothHeading(tr, headingTo(s.pos, patient.pos, (s.facing * Math.PI) / 4), time),
      (entry) => (moving ? frameFor(s, time, 'walk', entry, tr.speed, 'calm') : 0), p.x, p.y, zoom) != null;
  }
  const prev = (tr as AnimTrack & { prev?: Posture }).prev ?? tr.posture;
  const posture = transitionPosture(prev, tr.posture, time - tr.since);
  const target = s.targetSoldierId != null ? state.soldiers.get(s.targetSoldierId)?.pos : s.targetVehicleId != null ? state.vehicles.get(s.targetVehicleId)?.pos : null;
  const pick = pickAnimation(s, time, target, posture, trackSpeed(tr));
  let keys = pick.keys;
  let heading = pick.heading;
  let action: AnimAction = pick.action;
  const climb = hatchClimbAnim(s, time);
  if (climb) {
    // through a hatch (spec §10): the climb's own pose by progress, or stooped then kneeling
    return drawAtlasSoldier(ctx, atlas, climb.keys, climb.heading, (entry, key) => hatchClimbFrame(key, entry.frames, climb.progress, time), p.x, p.y, zoom) != null;
  }
  if (crew?.keys) {
    // working a crew task (spec §6): the task's pose, its frame driven by the task's progress
    const j0 = trembleOffset(s, time, pick.mood);
    const prog = crew.progress;
    const hd = smoothHeading(tr, crew.heading ?? (crew.facing * Math.PI) / 4, time);
    return drawAtlasSoldier(ctx, atlas, crew.keys, hd,
      (entry) => (prog == null ? frameFor(s, time, 'idle', entry, 0, pick.mood) : progressFrame(prog, entry.frames)),
      p.x + j0.x, p.y + j0.y, zoom) != null;
  }
  if (crew?.pose) {
    const mood = moodFor(s);
    keys = mood === 'calm' ? CREW_KEYS[crew.pose] : [...CREW_KEYS[crew.pose].map((k) => `${k}.${mood}`), ...CREW_KEYS[crew.pose]];
    heading = (crew.facing * Math.PI) / 4;
    action = crew.pose.startsWith('carry') || crew.pose === 'haul' ? 'walk' : 'idle';
  } else if (crew) {
    heading = (crew.facing * Math.PI) / 4;
    keys = entryKeyChain('crouched', 'idle', pick.mood, pick.weapon);
  }
  const j = trembleOffset(s, time, pick.mood);
  if (!crew && action !== 'hit' && action !== 'throw') {
    // getting down / getting up (`standing.drop`, by progress)
    const drop = postureDropProgress(prev, tr.posture, time - tr.since, trackSpeed(tr));
    if (drop != null && drawAtlasSoldier(ctx, atlas, [`standing.drop@${pick.weapon}`, 'standing.drop'], smoothHeading(tr, heading, time),
      (entry) => progressFrame(drop, entry.frames), p.x + j.x, p.y + j.y, zoom) != null) return true;
  }
  return drawAtlasSoldier(ctx, atlas, keys, smoothHeading(tr, heading, time), (entry) => frameFor(s, time, action, entry, tr.speed, pick.mood), p.x + j.x, p.y + j.y, zoom) != null;
}


/** wf19 team status bar: a slim 2 px morale-colour line with a dark hairline border, as wide as
 * the unit it belongs to, floating just above it. Only the SELECTED teams carry one (full
 * strength) plus the team under the pointer (dimmer) — the old always-on 30x4 saturated slabs
 * over every team were far heavier than the original's small, unobtrusive bars. Normal zoom only
 * (manual: "Team information bars only visible at normal zoom level"). */
function drawTeamBars(
  ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side,
  selectedTeamIds: readonly number[], hoverTeamId: number | null,
): void {
  if (cam.zoom !== 1) return;
  const ids = hoverTeamId != null && !selectedTeamIds.includes(hoverTeamId) ? [...selectedTeamIds, hoverTeamId] : selectedTeamIds;
  for (const id of ids) {
    const team = state.teams.get(id);
    if (!team || team.side !== playerSide) continue;
    if (team.status === 'Destroyed' || team.status === 'Knocked Out') continue;
    let x0 = Infinity, x1 = -Infinity, top = Infinity;
    const veh = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
    if (veh) {
      const def = VEHICLE_DEFS[veh.defId];
      const p = worldToScreen(cam, veh.pos);
      const halfW = (def ? def.widthM : 3) * 5, halfL = (def ? def.lengthM : 6) * 5;
      // screen half-extents of the rotated hull box
      const c = Math.abs(Math.cos(veh.hullFacing)), sn = Math.abs(Math.sin(veh.hullFacing));
      const ex = halfW * c + halfL * sn, ey = halfW * sn + halfL * c;
      x0 = p.x - ex * 0.8; x1 = p.x + ex * 0.8; top = p.y - ey;
    } else {
      for (const sid of team.soldierIds) {
        const so = state.soldiers.get(sid);
        if (!so || so.health === 'dead') continue;
        const p = worldToScreen(cam, so.pos);
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < top) top = p.y;
      }
      if (top === Infinity) continue;
      x0 -= 5; x1 += 5; top -= 9;
    }
    const cx = (x0 + x1) / 2;
    const w = Math.round(Math.max(14, Math.min(44, x1 - x0)));
    const bx = Math.round(cx - w / 2), by = Math.round(top - 6);
    if (bx > VIEW_W + 8 || bx + w < -8 || by > VIEW_H + 8 || by < -8) continue;
    const hover = !selectedTeamIds.includes(id);
    ctx.globalAlpha = hover ? 0.5 : 0.95;
    ctx.fillStyle = 'rgba(10,10,8,0.9)';
    ctx.fillRect(bx - 1, by - 1, w + 2, 4);
    ctx.fillStyle = teamBarColor(team);
    ctx.fillRect(bx, by, w, 2);
    // a lighter top pixel row: reads as a fine enamel line rather than a flat slab
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(bx, by, w, 1);
    ctx.globalAlpha = 1;
  }
}

/** Minimum on-screen sprite size, in px, below which we scale back up rather than let a unit
 * shrink to an unreadable speck (sprites otherwise scale 1:1 with cam.zoom). */
const MIN_SPRITE_PX = 6;

/** On-screen size of a unit sprite authored at `scale` sprite px per 1x px:
 * `sprite.width/height * zoom / scale` (so a 2x sprite at zoom 2 blits 1:1,
 * no nearest-neighbour upscaling), clamped so the larger dimension never
 * drops below MIN_SPRITE_PX (uniformly, so the sprite doesn't distort). */
function spriteDrawSize(sprite: HTMLCanvasElement, zoom: number, scale = 1): { dw: number; dh: number } {
  let dw = (sprite.width * zoom) / scale, dh = (sprite.height * zoom) / scale;
  const largest = Math.max(dw, dh);
  if (largest > 0 && largest < MIN_SPRITE_PX) {
    const s = MIN_SPRITE_PX / largest;
    dw *= s; dh *= s;
  }
  return { dw, dh };
}

function visible(s: { x: number; y: number }, cam: Camera): boolean {
  const p = worldToScreen(cam, s);
  return p.x > -32 && p.x < VIEW_W + 32 && p.y > -32 && p.y < VIEW_H + 32;
}

function isEnemyVisible(state: BattleState, playerSide: Side, side: Side, id: number, vehicle: boolean): boolean {
  if (side === playerSide) return true;
  const set = vehicle ? state.spottedVehicles[playerSide] : state.spotted[playerSide];
  return set.has(id);
}

/** Ground under a man run down by a vehicle: a larger dark stain pressed out along the direction
 * of travel and a short smear where the track carried on. Muted, small, no gore beyond that. */
function drawCrushedGround(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, dir: number, zoom: number, id: number, hasAtlas: boolean): void {
  const px = (m: number) => m * 10 * zoom;
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y));
  ctx.rotate(dir); // local -y = direction of travel
  // stain
  ctx.fillStyle = 'rgba(58,16,12,0.5)';
  ctx.beginPath();
  ctx.ellipse(0, 0, px(0.55 + (id % 3) * 0.05), px(hasAtlas ? 0.85 : 1.0), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(40,10,8,0.35)';
  ctx.beginPath();
  ctx.ellipse(px(0.08), px(0.1), px(0.3), px(0.5), 0, 0, Math.PI * 2);
  ctx.fill();
  // smear carried on by the track: a tapering streak ahead of the body
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    ctx.fillStyle = `rgba(58,16,12,${(0.3 * (1 - t)).toFixed(3)})`;
    const w = px(0.42 * (1 - t * 0.55));
    ctx.fillRect(-w / 2, -px(0.9 + t * 1.5) - px(0.3), w, px(0.3));
  }
  ctx.restore();
}

/** The track's tread pattern running through the body and on along the smear: short dark bars
 * across the direction of travel. */
function drawCrushedTreads(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, dir: number, zoom: number): void {
  const px = (m: number) => m * 10 * zoom;
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y));
  ctx.rotate(dir);
  const pitch = px(0.22), w = px(0.42), h = Math.max(1, px(0.07));
  for (let y = px(1.0); y >= -px(2.4); y -= pitch) {
    const fade = y < -px(0.9) ? Math.max(0, 1 - (-y - px(0.9)) / px(1.5)) : 1;
    ctx.fillStyle = `rgba(24,18,12,${(0.34 * fade).toFixed(3)})`;
    ctx.fillRect(-w / 2, y, w, h);
  }
  ctx.restore();
}

// ------------------------------------------------ kit and body parts on the ground (spec §8 / §9) ---
/** Flight of a loose object thrown by a blast, reusing the ragdoll arc: from where it lay to where
 * the sim put it. Null = lying still. */
function looseFlight(o: { pos: Vec2; from?: Vec2; thrownAt?: number; force?: number }, time: number): { x: number; y: number; heightM: number; shadow: number; t: number } | null {
  if (o.from == null || o.thrownAt == null) return null;
  const sample = ragdollSample({ from: o.from, time: o.thrownAt, force: (o.force ?? 0.5) * 0.85, origin: o.from }, o.pos, time);
  return sample.landed || time < o.thrownAt ? null : sample;
}

function drawLooseShadow(ctx: CanvasRenderingContext2D, x: number, y: number, zoom: number, k: number, winter: boolean, r: number): void {
  ctx.save();
  ctx.globalAlpha = 0.38 * k;
  ctx.fillStyle = winter ? 'rgb(40,50,80)' : 'rgb(8,10,6)';
  ctx.beginPath();
  ctx.ellipse(x + 0.8 * zoom, y + 0.8 * zoom, r * zoom * (0.5 + 0.5 * k), r * 0.6 * zoom * (0.5 + 0.5 * k), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Items (`item.<id>`) and body parts (`part.<kind><n>`). `airborne` false: the ones lying still,
 * drawn on the ground under the vehicles and the men; true: the ones a blast has in the air, drawn
 * above everything with the same detaching, shrinking shadow as a ragdoll. */
function drawLooseObjects(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, airborne: boolean, showDead: boolean): void {
  if (cam.zoom <= 0.5) return;
  const season: Season = state.map.def.season;
  const winter = season === 'winter';
  const zoom = cam.zoom;
  const one = (o: GroundItem | Debris, r: number, draw: (x: number, y: number, dirRad: number) => void): void => {
    const f = looseFlight(o, state.time);
    if ((f != null) !== airborne) return;
    const at = f ? { x: f.x, y: f.y } : o.pos;
    if (!visible(at, cam)) return;
    const g = worldToScreen(cam, at);
    if (!f) { draw(g.x, g.y, o.dir); return; }
    drawLooseShadow(ctx, g.x, g.y, zoom, f.shadow, winter, r);
    // tumbles in the air: a couple of turns, ending on the direction the sim gave it
    const spin = (1 - f.t) * Math.PI * 2 * 1.5 * (Math.round(o.pos.x * 7 + o.pos.y * 13) % 2 === 0 ? 1 : -1);
    draw(g.x, g.y - metresToPx(f.heightM, zoom) * 0.9, o.dir + spin);
  };
  {
    for (const part of state.debris ?? []) {
      const wreck = part.kind === 'plate' || part.kind === 'wheel' || part.kind === 'hatch';
      if (!showDead && !wreck) continue; // body parts follow the "show dead" setting; wreckage always shows
      one(part, wreck ? 4 : part.kind === 'torso' ? 3 : 1.6, (x, y, dirRad) => {
        const atlas = partsAtlas(part.side, season, zoom);
        const key = atlas?.meta.entries[`part.${part.kind}${part.variant}`] ? `part.${part.kind}${part.variant}` : `part.${part.kind}`;
        const dirs = atlas?.meta.dirs ?? 16;
        const dir = ((Math.round((dirRad / (Math.PI * 2)) * dirs) % dirs) + dirs) % dirs;
        drawAtlasFrame(ctx, atlas, key, dir, 0, x, y, zoom, true);
      });
    }
  }
  for (const it of state.items ?? []) {
    one(it, it.kind === 'weapon' ? 2.6 : 1.4, (x, y, dirRad) => {
      const atlas = itemAtlas(zoom);
      const dirs = atlas?.meta.dirs ?? 16;
      const dir = ((Math.round((dirRad / (Math.PI * 2)) * dirs) % dirs) + dirs) % dirs;
      drawAtlasFrame(ctx, atlas, `item.${it.sprite}`, dir, 0, x, y, zoom);
    });
  }
}

function drawCorpses(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, showDead: boolean): void {
  if (!showDead) return;
  const season = state.map.def.season;
  for (const s of state.soldiers.values()) {
    if (s.health !== 'dead' || s.dismembered) continue; // torn apart: his parts are state.debris
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    if (!visible(s.pos, cam)) continue;
    const p = worldToScreen(cam, s.pos);
    const atlas = soldierAtlas(s.side, season, cam.zoom);
    if (s.crushed) {
      // run down by a vehicle (spec §7): pressed flat along its direction of travel
      drawCrushedGround(ctx, p, s.crushed.dir, cam.zoom, s.id, !!atlas);
      if (atlas && !drawAtlasSoldier(ctx, atlas, [`corpse.crushed${s.id % 4}`, 'corpse.crushed0'], s.crushed.dir, (e) => e.frames - 1, p.x, p.y, cam.zoom)) {
        drawAtlasSoldier(ctx, atlas, [`corpse${s.id % 8}`, 'corpse0', 'prone.hit'], s.crushed.dir, (e) => e.frames - 1, p.x, p.y, cam.zoom);
        drawCrushedTreads(ctx, p, s.crushed.dir, cam.zoom);
      }
      continue;
    }
    // thrown by a blast: the flight is drawn with the living (drawSoldiers, above the vehicles);
    // afterwards the corpse keeps the pose it landed in
    if (s.blast && (ragdollPhase(s, state.time).phase === 'flight' || drawRagdollLanded(ctx, cam, s, season))) continue;
    if (atlas) drawAtlasSoldier(ctx, atlas, [`corpse${s.id % 8}`, `corpse${s.id % 4}`, 'corpse0', 'prone.hit'], (s.facing * Math.PI) / 4, (e) => e.frames - 1, p.x, p.y, cam.zoom);
  }
}

/** How far (m) the shot throws a gun back, and for how long (s) the kick eases out. */
const RECOIL_M = 0.26;
const RECOIL_S = 0.4;
function recoilOf(veh: Vehicle, time: number): number {
  if (veh.lastMainShotAt == null) return 0;
  const t = (time - veh.lastMainShotAt) / RECOIL_S;
  return t >= 0 && t < 1 ? (1 - t) * (1 - t) : 0;
}

/** One whole vehicle at screen (cx,cy) from its Blender atlas (64 directions; light, the soft
 * ground shadow and the turret's shadow on the deck are baked per direction): hull, then the turret
 * on its ring. Nothing is drawn until the vehicle's atlas has loaded (battles preload them).
 * Exported for the sprite preview so it cannot drift from the battle view. */
export function drawVehicleSprite(
  ctx: CanvasRenderingContext2D, defId: string, state: 'ok' | 'knockedOut', cx: number, cy: number,
  hullRad: number, turretRad: number, zoom: number, turretBlown = false,
  brokenTrack: 'L' | 'R' | 'both' | null = null,
  /** where the sim threw the blown-off turret (screen px) and how it lies; absent = beside the hull */
  turretLanding?: { x: number; y: number; dirRad: number },
  season: Season = 'summer',
  /** 0..1 main-gun recoil (1 = the instant of the shot): the vehicle rocks back and the turret
   * (the whole vehicle for a casemate gun) kicks back along the gun line */
  recoil = 0,
): void {
  const vdef = VEHICLE_DEFS[defId];
  if (recoil > 0) {
    const gunRad = vdef?.hasTurret ? turretRad : hullRad, m = RECOIL_M * recoil * 10 * zoom;
    cx -= Math.sin(hullRad) * m * 0.5; cy += Math.cos(hullRad) * m * 0.5;
    if (!vdef?.hasTurret) { cx -= Math.sin(gunRad) * m * 0.5; cy += Math.cos(gunRad) * m * 0.5; }
  }
  let tcx = cx, tcy = cy;
  if (recoil > 0 && vdef?.hasTurret) {
    const m = RECOIL_M * recoil * 10 * zoom * 0.5;
    tcx -= Math.sin(turretRad) * m; tcy += Math.cos(turretRad) * m;
  }
  if (turretBlown && turretLanding) {
    tcx = turretLanding.x; tcy = turretLanding.y; turretRad = turretLanding.dirRad;
  } else if (turretBlown) {
    const pxPerM = 10 * zoom, c = Math.cos(hullRad), s = Math.sin(hullRad);
    tcx += (2.2 * c - 1.0 * -s) * pxPerM * 0.9;
    tcy += (2.2 * s + 1.0 * -c) * pxPerM * 0.9;
    turretRad += 2.3;
  }
  // damage looks: `hull.blown` (open turret ring) with `turret.blown` lying beside it,
  // `hull.trackL|R` for a thrown track (a live hull only; wrecks keep their burnt look)
  const hullVariant = turretBlown ? 'blown' : state === 'ok' && brokenTrack ? (brokenTrack === 'R' ? 'trackR' : 'trackL') : undefined;
  drawVehiclePart(ctx, defId, 'hull', state, hullRad, hullRad, cx, cy, zoom, hullVariant, season);
  if (vdef?.hasTurret) drawVehiclePart(ctx, defId, 'turret', state, turretRad, hullRad, tcx, tcy, zoom, turretBlown ? 'blown' : undefined, season);
}

/** Thin grey smoke trailing from the engine deck of a vehicle with a damaged engine. */
function drawEngineSmoke(ctx: CanvasRenderingContext2D, veh: Vehicle, p: { x: number; y: number }, time: number, zoom: number, lengthM: number): void {
  const back = lengthM * 0.32 * 10 * zoom;
  const ex = p.x - Math.sin(veh.hullFacing) * back, ey = p.y + Math.cos(veh.hullFacing) * back;
  ctx.save();
  for (let i = 0; i < 4; i++) {
    const phase = (time * 0.35 + i / 4 + (veh.id % 7) / 7) % 1;
    ctx.globalAlpha = (1 - phase) * 0.3;
    ctx.fillStyle = '#3a3a38';
    ctx.beginPath();
    ctx.arc(ex + phase * 9 * zoom, ey - phase * 22 * zoom, (3 + phase * 6) * zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Open hatches of a vehicle its crew has left (or is leaving): a dark opening with the lid swung
 * back, where the men come out. Closed-topped vehicles only; drawn until the atlas carries a
 * hatch overlay. */
function drawOpenHatches(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, veh: Vehicle): void {
  const def = VEHICLE_DEFS[veh.defId];
  if (!def) return;
  const lay = vehicleLayout(def);
  if (lay.openTop) return;
  const team = state.teams.get(veh.teamId);
  const pxPerM = (10 * cam.zoom);
  lay.hatches.forEach((h, i) => {
    // a hatch nobody has gone through yet is still shut
    if (veh.exiting && (veh.hatchBusyUntil?.[i] ?? 0) <= 0) return;
    const w = worldToScreen(cam, hatchWorld(veh, def, h));
    const facing = h.group === 'turret' && def.hasTurret ? veh.turretFacing : veh.hullFacing;
    const r = Math.max(1.5, 0.21 * pxPerM);
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.rotate(facing);
    ctx.fillStyle = 'rgba(10,10,8,0.72)';
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.85, 0, 0, Math.PI * 2); ctx.fill();
    // the lid, swung back
    ctx.fillStyle = team?.side === 'german' ? 'rgba(112,110,92,0.95)' : 'rgba(84,98,66,0.95)';
    ctx.beginPath(); ctx.ellipse(0, r * 1.3, r, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(10,10,8,0.7)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  });
}

function drawVehicles(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
  for (const veh of state.vehicles.values()) {
    if (!isEnemyVisible(state, playerSide, veh.side, veh.id, true)) continue;
    if (!visible(veh.pos, cam)) continue;
    // a serviceable hull whose crew is outside keeps its live look, hatches open (spec §10)
    const left = veh.state === 'abandoned' && isServiceable(veh);
    const koLike = veh.state === 'knockedOut' || veh.state === 'burning' || (veh.state === 'abandoned' && !left);
    const p = worldToScreen(cam, veh.pos);
    const dmg = vehicleDamageView(veh);
    const tl = veh.turretLanding ? worldToScreen(cam, veh.turretLanding) : null;
    drawVehicleSprite(ctx, veh.defId, koLike ? 'knockedOut' : 'ok', p.x, p.y, veh.hullFacing, veh.turretFacing, cam.zoom, dmg.turretBlown, dmg.brokenTrack,
      tl ? { x: tl.x, y: tl.y, dirRad: veh.turretLandingDir ?? veh.turretFacing + 2.3 } : undefined, state.map.def.season,
      koLike ? 0 : recoilOf(veh, state.time));
    if ((left || veh.exiting) && cam.zoom > 0.5) drawOpenHatches(ctx, cam, state, veh);
    if (dmg.engineSmoke) drawEngineSmoke(ctx, veh, p, state.time, cam.zoom, VEHICLE_DEFS[veh.defId]?.lengthM ?? 6);
  }
}

function drawSelectionRing(ctx: CanvasRenderingContext2D, p: { x: number; y: number }): void {
  ctx.save();
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawFacingTick(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, facing: Facing8): void {
  const rad = facingAngle(facing);
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const r0 = 6;
  const r1 = 8;
  ctx.save();
  ctx.strokeStyle = PALETTE.white;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(p.x + dx * r0, p.y + dy * r0);
  ctx.lineTo(p.x + dx * r1, p.y + dy * r1);
  ctx.stroke();
  ctx.restore();
}

/** Manual: "soldier outlines visible only in normal and zoomed-in views" — at the zoomed-OUT
 * (0.5) level individual soldier sprites are replaced by one small 2x2 cluster of dots per
 * team, in the side's colour, instead of drawing (and shrinking) each soldier's sprite. */
const DOT_SIZE = 2;
const DOT_GAP = 1;

function drawSoldierDotClusters(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
  const teamPos = new Map<number, { sumX: number; sumY: number; n: number; side: Side }>();
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead' || s.vehicleId != null) continue;
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    if (!visible(s.pos, cam)) continue;
    let g = teamPos.get(s.teamId);
    if (!g) { g = { sumX: 0, sumY: 0, n: 0, side: s.side }; teamPos.set(s.teamId, g); }
    g.sumX += s.pos.x; g.sumY += s.pos.y; g.n++;
  }
  for (const g of teamPos.values()) {
    if (g.n === 0) continue;
    const p = worldToScreen(cam, { x: g.sumX / g.n, y: g.sumY / g.n });
    ctx.fillStyle = SIDE_COLOR[g.side];
    const x0 = Math.round(p.x - DOT_GAP - DOT_SIZE), x1 = Math.round(p.x + DOT_GAP);
    const y0 = Math.round(p.y - DOT_GAP - DOT_SIZE), y1 = Math.round(p.y + DOT_GAP);
    ctx.fillRect(x0, y0, DOT_SIZE, DOT_SIZE);
    ctx.fillRect(x1, y0, DOT_SIZE, DOT_SIZE);
    ctx.fillRect(x0, y1, DOT_SIZE, DOT_SIZE);
    ctx.fillRect(x1, y1, DOT_SIZE, DOT_SIZE);
  }
}

// ------------------------------------------------------------ crew-served weapons (wf9) ---
// Mortars, HMGs and AT guns are drawn as weapons on the ground (weapons atlas, tools/blender/
// weapons.py) with their crew posed around them (soldier atlas crew.* entries). Purely visual: the
// sim keeps the weapon pivot,
// facing and set-up phase in Team.crewWeapon (sim/crewWeapon.ts); crewmen standing still near
// their role slot are drawn at the slot.

/** Visual override for one crew soldier this frame. `pose` null = his normal (crouched) pose.
 * `keys` (+ `progress`, `heading`) = a task pose from the soldier atlas (spec §6). */
interface CrewSoldierDraw {
  pose: CrewPose | null; pos: Vec2; facing: Facing8;
  keys?: string[]; progress?: number | null; heading?: number;
}

/** A crewman further than this (tiles) from his slot is drawn where he really is. */
const CREW_PULL_TILES = 4;
const PTRD_GUNNER_M: Vec2 = { x: 0.35, y: 1.4 };

function crewFleeing(s: Soldier): boolean {
  return s.activity === 'panicked' || s.activity === 'routed' || s.activity === 'surrendered' || s.activity === 'cowering';
}

/** Per-frame crew pose / position overrides, keyed by soldier id. */
function crewSoldierDraws(state: BattleState): Map<number, CrewSoldierDraw> {
  const out = new Map<number, CrewSoldierDraw>();
  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    const cw = crewWeaponView(state, team);
    if (!cw) continue;
    const cls = crewServedClass(cw.weaponId);
    if (!cls) continue;
    const gunner = state.soldiers.get(cw.gunnerId);
    const crew: Soldier[] = [];
    for (const id of team.soldierIds) {
      const s = state.soldiers.get(id);
      if (!s || s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null || crewFleeing(s)) continue;
      if (gunner && s.id === gunner.id) continue;
      crew.push(s);
    }
    crew.sort((a, b) => Number(a.isLeader) - Number(b.isLeader)); // the leader spots, others serve
    const gunnerOk = !!gunner && gunner.health !== 'dead' && gunner.health !== 'incapacitated' && !crewFleeing(gunner);
    const fired = gunnerOk && state.time - gunner!.lastFiredAt < 0.6;
    const f8 = facingFromAngle(cw.facing);
    if (cw.abandoned) continue;
    if (cw.phase === 'packed') {
      // on the move: carry the parts / push the gun along by its trails
      const carry: [CrewPose, CrewPose] = cls === 'mortar' ? ['carryTube', 'carryPlate'] : cls === 'hmg' ? ['carryMg', 'carryTripod'] : ['haul', 'haul'];
      const movers = cls === 'atgun' && team.crewWeapon ? gunHaulers(state, team, cw) : gunnerOk ? [gunner!, ...crew] : crew;
      movers.slice(0, 2).forEach((s, i) => {
        if (s.path.length === 0 && i > 0) return;
        // (hauled guns: the sim keeps the two haulers at the trail ends from the gun's axle pose)
        out.set(s.id, { pose: carry[i], pos: s.pos, facing: cls === 'atgun' ? f8 : s.facing });
      });
      continue;
    }
    if (team.crewWeapon) {
      // the sim puts every man at his station (crewWeapon.ts): draw him where he is, in the pose
      // of the task he is working, its frame from the task's progress
      for (const s of gunnerOk ? [gunner!, ...crew] : crew) {
        const anim = crewTaskAnim(s, state.time);
        const isGunner = gunnerOk && s.id === gunner!.id;
        const seat = weaponFramePoint(cw.pos, cw.facing, CREW_LAYOUT[cls].gunner);
        const atSeat = isGunner && dist(s.pos, seat) < 0.4;
        if (!anim) {
          if (s.crewTask?.walking || s.path.length > 0) continue; // walking: his normal gait
          if (atSeat && cw.phase === 'ready') {
            // behind the sight / the MG, waiting for a target
            const keys = cls === 'hmg' ? (fired ? ['crew.mg.fire', 'crew.mg', 'prone.aim@lmg', 'prone.aim'] : ['crew.mg', 'prone.aim@lmg', 'prone.aim']) : ['crew.lay', 'crew.gunner', 'kneeling.aim', 'kneeling.idle'];
            out.set(s.id, { pose: cls === 'hmg' ? 'mgProne' : 'gunnerKneel', pos: s.pos, facing: f8, keys, progress: null, heading: cw.facing });
          }
          continue;
        }
        const toGun = Math.atan2(cw.pos.x - s.pos.x, -(cw.pos.y - s.pos.y));
        const alongGun = s.crewTask?.id === 'lay' || s.crewTask?.id === 'fire' || s.crewTask == null || cls === 'hmg';
        const heading = alongGun ? cw.facing : toGun;
        const keys = cls === 'hmg' && alongGun && isGunner ? ['crew.mg', ...anim.keys] : anim.keys;
        const p = anim.progress;
        out.set(s.id, {
          pose: cls === 'hmg' && isGunner && alongGun ? 'mgProne' : anim.fallbackPose, pos: s.pos,
          facing: facingFromAngle(heading), keys, progress: p, heading,
        });
      }
      continue;
    }
    // deploy screen (no sim state yet): the crew posed at their role slots
    const L = CREW_LAYOUT[cls];
    const roles: [Soldier | undefined, Vec2, CrewPose | null][] = [
      [gunnerOk ? gunner : undefined, L.gunner, cls === 'hmg' ? 'mgProne' : 'gunnerKneel'],
      [crew[0], L.loader, cls === 'mortar' ? 'loaderRound' : cls === 'atgun' ? 'loaderShell' : 'gunnerKneel'],
      [crew[1], L.assistant, null],
      // the team leader (or a fourth man) spots from the other side, a little back
      [crew[2], { x: -L.assistant.x, y: L.assistant.y + 0.4 }, null],
    ];
    roles.forEach(([s, off, pose]) => {
      if (!s) return;
      const slot = weaponFramePoint(cw.pos, cw.facing, off);
      if (s.path.length > 0 || dist(s.pos, slot) > CREW_PULL_TILES) return;
      out.set(s.id, { pose, pos: slot, facing: f8 });
    });
  }
  // lone AT riflemen: PTRD on its bipod, gunner prone behind it
  for (const s of state.soldiers.values()) {
    if (s.weaponId !== 'ptrd' || s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
    if (s.path.length > 0 || crewFleeing(s)) continue;
    out.set(s.id, { pose: 'mgProne', pos: s.pos, facing: s.facing });
  }
  return out;
}

function crewTeamVisible(state: BattleState, team: Team, playerSide: Side): boolean {
  if (team.side === playerSide) return true;
  return team.soldierIds.some((id) => state.spotted[playerSide].has(id));
}

/** Weapons on the ground (under the crew), their firing cues, and the zoom-0.5 weapon symbol.
 * Also moves this frame's muzzle flashes / tracer origins from the gunner to the weapon muzzle. */
function drawCrewWeapons(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
  const px = (m: number) => (m / TILE_M) * 20 * cam.zoom; // metres -> screen px
  for (const team of state.teams.values()) {
    if (team.vehicleId != null) continue;
    const cw = crewWeaponView(state, team);
    if (!cw) continue;
    const cls = crewServedClass(cw.weaponId);
    if (!cls) continue;
    const gunner = state.soldiers.get(cw.gunnerId);
    const gunnerOk = !!gunner && gunner.health !== 'dead' && gunner.health !== 'incapacitated';
    const muzzle = weaponFramePoint(cw.pos, cw.facing, weaponMuzzleM(cw.weaponId));
    if (gunnerOk && !cw.abandoned) {
      for (const f of state.flashes) {
        if (f.t < FLASH_LIFE && dist(f.pos, gunner!.pos) < 0.02) { f.pos = { ...muzzle }; f.facing = cw.facing; }
      }
      for (const t of state.tracers) {
        if (t.t < 0.1 && dist(t.from, gunner!.pos) < 0.02) t.from = { ...muzzle };
      }
    }
    if (!crewTeamVisible(state, team, playerSide) || !visible(cw.pos, cam)) continue;
    const dir = { x: Math.sin(cw.facing), y: -Math.cos(cw.facing) };
    if (cam.zoom <= 0.5) {
      // small distinct symbol beside the team's dot cluster: a short dark barrel with a dot
      const c = worldToScreen(cam, team.pos);
      const bx = Math.round(c.x + 6), by = Math.round(c.y + 1);
      ctx.fillStyle = '#141410';
      ctx.fillRect(bx - 1, by - 1, 2, 2);
      ctx.strokeStyle = '#141410';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + 0.5, by + 0.5);
      ctx.lineTo(bx + 0.5 + dir.x * 5, by + 0.5 + dir.y * 5);
      ctx.stroke();
      continue;
    }
    if (cw.phase === 'packed' && !cw.abandoned && cls !== 'atgun') continue; // carried on the crew's backs
    // (a hauled gun is pushed muzzle-first by the men at its trails: the sim keeps its pivot ahead
    // of them, so it simply stands where it stopped when the drill begins)
    const pos = cw.pos;
    const rot = cw.facing;
    const p = worldToScreen(cam, pos);
    const since = gunnerOk ? state.time - gunner!.lastFiredAt : 99;
    drawWeaponState(ctx, cw.weaponId, weaponStateChain(crewWeaponVisual(state, cw)), rot, p.x, p.y, cam.zoom);
    if (cls === 'mortar' && since >= 0 && since < 0.8) {
      // muzzle puff drifting off the tube
      const m = worldToScreen(cam, muzzle);
      const t = since / 0.8;
      ctx.save();
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = `rgba(214,210,196,${(0.55 * (1 - t) * (1 - i * 0.25)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(m.x + dir.x * px(0.3 + i * 0.25) * t + i * px(0.1), m.y + dir.y * px(0.3 + i * 0.25) * t - i * px(0.1), px(0.25 + 0.35 * t) * (1 - i * 0.2), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
  // PTRD rifles on their bipods in front of their prone gunners
  if (cam.zoom > 0.5) {
    for (const s of state.soldiers.values()) {
      if (s.weaponId !== 'ptrd' || s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
      if (s.path.length > 0 || crewFleeing(s) || !isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
      const rad = facingAngle(s.facing);
      const r = { x: PTRD_GUNNER_M.x, y: PTRD_GUNNER_M.y };
      const pivot = weaponFramePoint(s.pos, rad, { x: -r.x, y: -r.y });
      if (!visible(pivot, cam)) continue;
      const p = worldToScreen(cam, pivot);
      drawAtlasWeapon(ctx, 'ptrd', 'ready', rad, p.x, p.y, cam.zoom);
    }
  }
}

/** round5-battle.md fix #4 §2: a soldier under heavy suppression gets a faint dust stipple
 * around him — a handful of small pale specks, low alpha, positioned with a cheap deterministic
 * hash (soldier id + frame) so they don't scream "particle system" but do shimmer slightly frame
 * to frame. Only ever computed for soldiers actually over the threshold, so it costs nothing for
 * the common case of an unsuppressed battlefield. Stays legible with many units on screen because
 * it's a handful of 1px dots, not a filled shape. */
const SUPPRESSION_STIPPLE_THRESHOLD = 55;
function hash01(n: number): number {
  let h = n * 2654435761;
  h = (h ^ (h >>> 13)) * 2246822519;
  h = h ^ (h >>> 15);
  return ((h >>> 0) % 1000) / 1000;
}
export function drawSuppressionStipple(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, s: Soldier, radiusPx: number): void {
  if (s.suppression < SUPPRESSION_STIPPLE_THRESHOLD) return;
  const strength = Math.min(1, (s.suppression - SUPPRESSION_STIPPLE_THRESHOLD) / (100 - SUPPRESSION_STIPPLE_THRESHOLD));
  const flicker = Math.floor(Date.now() / 90); // slow shimmer, independent of animFrame
  const n = 3 + Math.round(strength * 2);
  ctx.save();
  ctx.fillStyle = `rgba(198,190,170,${(0.22 + strength * 0.16).toFixed(2)})`;
  for (let i = 0; i < n; i++) {
    const a = hash01(s.id * 97 + i * 13 + flicker);
    const b = hash01(s.id * 251 + i * 29 + flicker);
    const ang = a * Math.PI * 2;
    const r = radiusPx * (0.5 + b * 0.9);
    ctx.fillRect(Math.round(p.x + Math.cos(ang) * r) - 1, Math.round(p.y + Math.sin(ang) * r) - 1, 1, 1);
  }
  ctx.restore();
}

function drawSoldiers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, selectedTeamIds: readonly number[]): void {
  if (cam.zoom <= 0.5) {
    drawSoldierDotClusters(ctx, cam, state, playerSide);
    return;
  }
  const season = state.map.def.season;
  const crewDraws = crewSoldierDraws(state);
  const draggedBy = new Map<number, Soldier>();
  for (const s of state.soldiers.values()) if (s.carrying && s.health !== 'dead') draggedBy.set(s.carrying.patientId, s);
  for (const s of state.soldiers.values()) {
    if (s.vehicleId != null || s.dismembered) continue;
    // blast ragdolls (spec §4): the flight — of the dead too — is drawn here, above the vehicles
    const rag = s.blast ? ragdollPhase(s, state.time) : null;
    if (s.health === 'dead' && rag?.phase !== 'flight') continue;
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    if (!visible(s.pos, cam)) continue;
    if (rag?.phase === 'flight' && rag.sample) { drawRagdollFlight(ctx, cam, s, rag.sample, season); continue; }
    // a stunned survivor lies in the pose he landed in until he can push himself up
    if (rag?.phase === 'landed' && drawRagdollLanded(ctx, cam, s, season)) continue;
    const crewDraw = s.health === 'incapacitated' ? undefined : crewDraws.get(s.id);
    const p = worldToScreen(cam, crewDraw ? crewDraw.pos : s.pos);
    const selected = selectedTeamIds.includes(s.teamId);
    if (selected) drawSelectionRing(ctx, p);
    const atlas = soldierAtlas(s.side, season, cam.zoom);
    if (!(atlas && drawSoldierFromAtlas(ctx, atlas, state, s, p, cam.zoom, crewDraw, draggedBy.get(s.id)))) {
      // the soldier atlas is still loading (first moments of a battle): a small side-coloured
      // marker, like the zoomed-out view
      ctx.fillStyle = SIDE_COLOR[s.side];
      ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, DOT_SIZE, DOT_SIZE);
    }
    drawSuppressionStipple(ctx, p, s, 9 * cam.zoom);
    // 2px facing tick in front of the soldier, only for the selected team.
    if (selected) drawFacingTick(ctx, p, s.facing);
  }
}

/** VL name label: bold white text with a 1px black outline (drawn 4x offset
 * in black then once in white), the way the original labels its objectives. */
function drawOutlinedLabel(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number): void {
  ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0c0c0a';
  ctx.fillText(text, cx - 1, y);
  ctx.fillText(text, cx + 1, y);
  ctx.fillText(text, cx, y - 1);
  ctx.fillText(text, cx, y + 1);
  ctx.fillStyle = '#f0f0ec';
  ctx.fillText(text, cx, y);
  ctx.textAlign = 'left';
}

const FLAG_SCALE = 1.6; // native flag sprite art is small; scale up so it reads as a flag, not a dot
/** Flag size steps with zoom in whole multiples of the zoom-1 size (1x at zoom 1, 2x at zoom
 * 2), never below 1x — `FLAG_SCALE * cam.zoom` used to make the flag scale linearly with zoom,
 * which made it huge (1.6*2=3.2x) at zoom 2 and shrink at zoom 0.5 instead of staying legible. */
function flagZoomFactor(zoom: number): number { return zoom >= 2 ? 2 : 1; }

function drawFlags(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const vl of state.map.victoryLocations) {
    const pos = { x: vl.x, y: vl.y };
    if (!visible(pos, cam)) continue;
    const p = worldToScreen(cam, pos);
    const scale = FLAG_SCALE * flagZoomFactor(cam.zoom);
    const contested = vl.capturingSide != null && vl.capturingSide !== vl.owner;
    if (contested) {
      // Split flag: owner's colours on the left half, the capturing side's on the right.
      const a = getFlagSprite(vl.owner);
      const b = getFlagSprite(vl.capturingSide);
      const w = a.width * scale, h = a.height * scale;
      const x0 = Math.round(p.x - w / 2), y0 = Math.round(p.y - h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, w / 2, h);
      ctx.clip();
      ctx.drawImage(a, x0, y0, w, h);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + w / 2, y0, w / 2, h);
      ctx.clip();
      ctx.drawImage(b, x0, y0, w, h);
      ctx.restore();
    } else {
      const sprite = getFlagSprite(vl.owner);
      const w = sprite.width * scale, h = sprite.height * scale;
      ctx.drawImage(sprite, Math.round(p.x - w / 2), Math.round(p.y - h), w, h);
    }
    drawOutlinedLabel(ctx, vl.name, Math.round(p.x), Math.round(p.y + 3));
  }
}

function drawTeamLabels(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, settings: GameSettings): void {
  // Manual: "Team information bars appear... hidden when zoomed in/out" —
  // and even at normal zoom the original shows none by default (this is an
  // opt-in debug overlay here, off by default per game.ts).
  if (!settings.unitLabels) return;
  if (cam.zoom !== 1) return;
  for (const team of state.teams.values()) {
    const leader = state.soldiers.get(team.leaderId);
    const pos = leader && leader.health !== 'dead' ? leader.pos : team.pos;
    if (!visible(pos, cam)) continue;
    const p = worldToScreen(cam, pos);
    const w = textWidth(team.name, 'small');
    const y = Math.round(p.y + 7);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(Math.round(p.x - w / 2 - 1), y, w + 2, 8);
    drawText(ctx, team.name, Math.round(p.x - w / 2), y + 1, PALETTE.white, 'small');
  }
}

export function drawUnits(
  ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState,
  playerSide: Side, selectedTeamIds: readonly number[], settings: GameSettings,
  showDead = true,
  orderHover: { teamId: number } | null = null,
  hoverTeamId: number | null = null,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;

  ensureAtlases(state);
  ragdollBeginFrame(state.time);
  drawCorpses(ctx, cam, state, playerSide, showDead);
  drawLooseObjects(ctx, cam, state, false, showDead);
  drawVehicles(ctx, cam, state, playerSide);
  drawCrewWeapons(ctx, cam, state, playerSide);
  drawSoldiers(ctx, cam, state, playerSide, selectedTeamIds);
  drawLooseObjects(ctx, cam, state, true, showDead);
  drawTeamBars(ctx, cam, state, playerSide, selectedTeamIds, hoverTeamId);
  drawFlags(ctx, cam, state);
  drawTeamLabels(ctx, cam, state, settings);

  // order endpoints for every friendly team; lines for the selected / hovered ones (orderMarkers.ts)
  drawOrderMarkers(ctx, cam, state, playerSide, selectedTeamIds, orderHover);

  ctx.restore();
}
