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
import { getSoldierSprite, getVehicleSprite, getFlagSprite, unitSpriteScale } from '@/render/sprites';
import { drawText, textWidth } from '@/render/pixelfont';
import { VEHICLE_DEFS } from '@/data/units';
import { teamBarColor } from '@/ui/hud/hudChrome';
import { drawOrderMarkers } from '@/render/orderMarkers';
import { getWeaponSprite } from '@/render/sprites';
import { getCrewPoseSprite, type CrewPose } from '@/render/soldierArt';
import { weaponMuzzleM, weaponTowLengthM } from '@/render/weaponArt';
import { CREW_LAYOUT, crewServedClass, crewWeaponView, weaponFramePoint } from '@/sim/crewWeapon';
import { FLASH_LIFE, TILE_M } from '@/shared/types';
import type { CrewWeaponState, Vec2 } from '@/shared/types';
import { dist, facingFromAngle } from '@/shared/math';

/** One morale bar per friendly team (manual: "Team information bars only
 * visible at normal zoom level"): a solid 30x4 bar centred above the team,
 * coloured by teamBarColor so it matches the HUD team-grid bar. */
function drawTeamBars(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
  if (cam.zoom !== 1) return;
  for (const team of state.teams.values()) {
    if (team.side !== playerSide) continue;
    if (team.status === 'Destroyed' || team.status === 'Knocked Out') continue;
    const alive = team.soldierIds.some((id) => {
      const s = state.soldiers.get(id);
      return s != null && s.health !== 'dead';
    });
    if (!alive) continue;
    if (!visible(team.pos, cam)) continue;
    const p = worldToScreen(cam, team.pos);
    ctx.fillStyle = teamBarColor(team);
    ctx.fillRect(Math.round(p.x - 15), Math.round(p.y - 16), 30, 4);
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

function rotateAndDraw(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, cx: number, cy: number, rad: number, zoom: number, scale = 1): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  const { dw, dh } = spriteDrawSize(sprite, zoom, scale);
  ctx.drawImage(sprite, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function frameOf(soldier: Soldier): 0 | 1 {
  return (Math.floor(soldier.animFrame) % 2 === 0 ? 0 : 1);
}

/** Small soft contact shadow peeking out SE from a standing/crouching
 * soldier's feet. Sized from the body (not the padded sprite canvas) so it
 * never surrounds the figure; corpses and prone figures get none. The
 * dw/dh parameters are kept for call-site compatibility. */
function drawSoldierShadow(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, _dw: number, _dh: number, zoom: number): void {
  const rw = 3.5 * zoom;
  const rh = 2 * zoom;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(p.x + 1 * zoom, p.y + 1.5 * zoom, rw, rh, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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

function drawCorpses(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, showDead: boolean): void {
  if (!showDead) return;
  const season = state.map.def.season;
  const scale = unitSpriteScale(cam.zoom);
  for (const s of state.soldiers.values()) {
    if (s.health !== 'dead') continue;
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    const p = worldToScreen(cam, s.pos);
    if (!visible(s.pos, cam)) continue;
    const sprite = getSoldierSprite(s.side, season, 'dead', s.facing, 0, 'enemy', scale);
    const { dw, dh } = spriteDrawSize(sprite, cam.zoom, scale);
    ctx.drawImage(sprite, Math.round(p.x - dw / 2), Math.round(p.y - dh / 2), dw, dh);
  }
}

function drawVehicles(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
  const scale = unitSpriteScale(cam.zoom);
  for (const veh of state.vehicles.values()) {
    if (!isEnemyVisible(state, playerSide, veh.side, veh.id, true)) continue;
    if (!visible(veh.pos, cam)) continue;
    const koLike = veh.state === 'knockedOut' || veh.state === 'burning' || veh.state === 'abandoned';
    const spriteState = koLike ? 'knockedOut' : 'ok';
    const p = worldToScreen(cam, veh.pos);
    const hull = getVehicleSprite(veh.defId, 'hull', spriteState, scale);
    rotateAndDraw(ctx, hull, p.x, p.y, veh.hullFacing, cam.zoom, scale);
    const def = VEHICLE_DEFS[veh.defId];
    if (def && def.hasTurret) {
      const turret = getVehicleSprite(veh.defId, 'turret', spriteState, scale);
      rotateAndDraw(ctx, turret, p.x, p.y, veh.turretFacing, cam.zoom, scale);
    }
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
// Mortars, HMGs and AT guns are drawn as weapons on the ground (weaponArt.ts) with their crew
// posed around them (soldierArt.ts crew poses). Purely visual: the sim keeps the weapon pivot,
// facing and set-up phase in Team.crewWeapon (sim/crewWeapon.ts); crewmen standing still near
// their role slot are drawn at the slot.

/** Visual override for one crew soldier this frame. `pose` null = the normal stance sprite. */
interface CrewSoldierDraw { pose: CrewPose | null; stance?: 'crouching' | 'prone'; pos: Vec2; facing: Facing8; frame: 0 | 1 }

/** A crewman further than this (tiles) from his slot is drawn where he really is. */
const CREW_PULL_TILES = 4;
const PTRD_GUNNER_M: Vec2 = { x: 0.35, y: 1.4 };

function crewFleeing(s: Soldier): boolean {
  return s.activity === 'panicked' || s.activity === 'routed' || s.activity === 'surrendered' || s.activity === 'cowering';
}

function crewVariant(cw: CrewWeaponState): 'ready' | 'half' | 'packed' {
  const frac = cw.phaseTotal > 0 ? 1 - cw.timer / cw.phaseTotal : 1;
  if (cw.phase === 'ready') return 'ready';
  if (cw.phase === 'settingUp') return cw.abandoned ? 'half' : frac < 0.35 ? 'packed' : frac < 0.75 ? 'half' : 'ready';
  if (cw.phase === 'packing') return frac < 0.3 ? 'ready' : frac < 0.7 ? 'half' : 'packed';
  return 'packed';
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
      // on the move: carry the parts / haul the gun
      const carry: [CrewPose, CrewPose] = cls === 'mortar' ? ['carryTube', 'carryPlate'] : cls === 'hmg' ? ['carryMg', 'carryTripod'] : ['haul', 'haul'];
      const movers = gunnerOk ? [gunner!, ...crew] : crew;
      movers.slice(0, 2).forEach((s, i) => {
        if (s.path.length === 0 && i > 0) return;
        out.set(s.id, { pose: carry[i], pos: s.pos, facing: s.facing, frame: (Math.floor(s.animFrame) % 2 === 0 ? 0 : 1) });
      });
      continue;
    }
    const L = CREW_LAYOUT[cls];
    const busy = cw.phase !== 'ready';
    const roles: [Soldier | undefined, Vec2, CrewPose | null][] = [
      [gunnerOk ? gunner : undefined, L.gunner, busy ? 'gunnerKneel' : cls === 'hmg' ? 'mgProne' : 'gunnerKneel'],
      [crew[0], L.loader, busy ? 'gunnerKneel' : cls === 'mortar' ? 'loaderRound' : cls === 'atgun' ? 'loaderShell' : 'gunnerKneel'],
      [crew[1], L.assistant, busy ? 'gunnerKneel' : null],
      // the team leader (or a fourth man) spots from the other side, a little back
      [crew[2], { x: -L.assistant.x, y: L.assistant.y + 0.4 }, null],
    ];
    roles.forEach(([s, off, pose], i) => {
      if (!s) return;
      const slot = weaponFramePoint(cw.pos, cw.facing, off);
      if (s.path.length > 0 || dist(s.pos, slot) > CREW_PULL_TILES) return;
      // firing cues: the loader drops the bomb / rams the shell, the gunner lays the gun
      const frame: 0 | 1 = i === 1 ? (fired ? 1 : 0) : i === 0 && fired && cls !== 'hmg' ? 1 : 0;
      out.set(s.id, { pose, stance: 'crouching', pos: slot, facing: f8, frame });
    });
  }
  // lone AT riflemen: PTRD on its bipod, gunner prone behind it
  for (const s of state.soldiers.values()) {
    if (s.weaponId !== 'ptrd' || s.health === 'dead' || s.health === 'incapacitated' || s.vehicleId != null) continue;
    if (s.path.length > 0 || crewFleeing(s)) continue;
    out.set(s.id, { pose: 'mgProne', pos: s.pos, facing: s.facing, frame: 0 });
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
  const season = state.map.def.season;
  const scale = unitSpriteScale(cam.zoom);
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
    let pos = cw.pos;
    let rot = cw.facing;
    if (cw.phase === 'packed' && !cw.abandoned) {
      // AT gun towed trail-first behind the hauling crew
      const back = (weaponTowLengthM(cw.weaponId) + 0.5) / TILE_M;
      pos = { x: cw.pos.x - dir.x * back, y: cw.pos.y - dir.y * back };
      rot = cw.facing + Math.PI;
    }
    const sprite = getWeaponSprite(cw.weaponId, crewVariant(cw), rot, team.side, season, scale);
    let p = worldToScreen(cam, pos);
    const since = gunnerOk ? state.time - gunner!.lastFiredAt : 99;
    if (cls === 'atgun' && cw.phase === 'ready' && since >= 0 && since < 0.45) {
      // recoil: kick back ~2 px and run out again
      const k = since < 0.06 ? since / 0.06 : 1 - (since - 0.06) / 0.39;
      p = { x: p.x - dir.x * 2 * cam.zoom * k, y: p.y - dir.y * 2 * cam.zoom * k };
    }
    const { dw, dh } = spriteDrawSize(sprite, cam.zoom, scale);
    ctx.drawImage(sprite, Math.round(p.x - dw / 2), Math.round(p.y - dh / 2), dw, dh);
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
      const sprite = getWeaponSprite('ptrd', 'ready', rad, s.side, season, scale);
      const p = worldToScreen(cam, pivot);
      const { dw, dh } = spriteDrawSize(sprite, cam.zoom, scale);
      ctx.drawImage(sprite, Math.round(p.x - dw / 2), Math.round(p.y - dh / 2), dw, dh);
    }
  }
}

function drawSoldiers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, selectedTeamIds: readonly number[]): void {
  if (cam.zoom <= 0.5) {
    drawSoldierDotClusters(ctx, cam, state, playerSide);
    return;
  }
  const season = state.map.def.season;
  const scale = unitSpriteScale(cam.zoom);
  const crewDraws = crewSoldierDraws(state);
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead') continue;
    if (s.vehicleId != null) continue;
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    if (!visible(s.pos, cam)) continue;
    const crewDraw = s.health === 'incapacitated' ? undefined : crewDraws.get(s.id);
    const p = worldToScreen(cam, crewDraw ? crewDraw.pos : s.pos);
    const selected = selectedTeamIds.includes(s.teamId);
    if (selected) drawSelectionRing(ctx, p);
    const stance = s.health === 'incapacitated' ? 'prone' : crewDraw?.pose === 'mgProne' ? 'prone' : crewDraw?.stance ?? s.stance;
    const outline = s.side === playerSide ? 'friendly' : 'enemy';
    const sprite = crewDraw?.pose
      ? getCrewPoseSprite(s.side, season, crewDraw.pose, crewDraw.facing, crewDraw.frame, outline, scale)
      : getSoldierSprite(s.side, season, stance, crewDraw ? crewDraw.facing : s.facing, frameOf(s), outline, scale);
    const { dw, dh } = spriteDrawSize(sprite, cam.zoom, scale);
    if (stance !== 'prone') drawSoldierShadow(ctx, p, dw, dh, cam.zoom);
    ctx.drawImage(sprite, Math.round(p.x - dw / 2), Math.round(p.y - dh / 2), dw, dh);
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
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;

  drawCorpses(ctx, cam, state, playerSide, showDead);
  drawVehicles(ctx, cam, state, playerSide);
  drawCrewWeapons(ctx, cam, state, playerSide);
  drawSoldiers(ctx, cam, state, playerSide, selectedTeamIds);
  drawTeamBars(ctx, cam, state, playerSide);
  drawFlags(ctx, cam, state);
  drawTeamLabels(ctx, cam, state, settings);

  // order endpoints for every friendly team; lines for the selected / hovered ones (orderMarkers.ts)
  drawOrderMarkers(ctx, cam, state, playerSide, selectedTeamIds, orderHover);

  ctx.restore();
}
