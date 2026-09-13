// ============================================================================
// unitRender.ts — draws soldiers, vehicles, selection rings, VL flags, team
// labels and order lines/arcs for the battle viewport.
// ============================================================================
import type {
  Camera, BattleState, Side, GameSettings, Soldier, Team, Facing8,
} from '@/shared/types';
import { VIEW_W, VIEW_H, ORDER_DOT_COLOR } from '@/shared/types';
import { facingAngle } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import { PALETTE, SIDE_COLOR } from '@/render/palette';
import { getSoldierSprite, getVehicleSprite, getFlagSprite } from '@/render/sprites';
import { drawText, textWidth } from '@/render/pixelfont';
import { VEHICLE_DEFS } from '@/data/units';
import { teamBarColor } from '@/ui/hud/hudChrome';

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

/** `sprite.width/height * zoom`, clamped so the larger dimension never drops below
 * MIN_SPRITE_PX (uniformly, so the sprite doesn't distort). */
function spriteDrawSize(sprite: HTMLCanvasElement, zoom: number): { dw: number; dh: number } {
  let dw = sprite.width * zoom, dh = sprite.height * zoom;
  const largest = Math.max(dw, dh);
  if (largest > 0 && largest < MIN_SPRITE_PX) {
    const s = MIN_SPRITE_PX / largest;
    dw *= s; dh *= s;
  }
  return { dw, dh };
}

function rotateAndDraw(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, cx: number, cy: number, rad: number, zoom: number): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  const { dw, dh } = spriteDrawSize(sprite, zoom);
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
  for (const s of state.soldiers.values()) {
    if (s.health !== 'dead') continue;
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    const p = worldToScreen(cam, s.pos);
    if (!visible(s.pos, cam)) continue;
    const sprite = getSoldierSprite(s.side, season, 'dead', s.facing, 0);
    const { dw, dh } = spriteDrawSize(sprite, cam.zoom);
    ctx.drawImage(sprite, Math.round(p.x - dw / 2), Math.round(p.y - dh / 2), dw, dh);
  }
}

function drawVehicles(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
  for (const veh of state.vehicles.values()) {
    if (!isEnemyVisible(state, playerSide, veh.side, veh.id, true)) continue;
    if (!visible(veh.pos, cam)) continue;
    const koLike = veh.state === 'knockedOut' || veh.state === 'burning' || veh.state === 'abandoned';
    const spriteState = koLike ? 'knockedOut' : 'ok';
    const p = worldToScreen(cam, veh.pos);
    const hull = getVehicleSprite(veh.defId, 'hull', spriteState);
    rotateAndDraw(ctx, hull, p.x, p.y, veh.hullFacing, cam.zoom);
    const def = VEHICLE_DEFS[veh.defId];
    if (def && def.hasTurret) {
      const turret = getVehicleSprite(veh.defId, 'turret', spriteState);
      rotateAndDraw(ctx, turret, p.x, p.y, veh.turretFacing, cam.zoom);
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

function drawSoldiers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, selectedTeamIds: readonly number[]): void {
  if (cam.zoom <= 0.5) {
    drawSoldierDotClusters(ctx, cam, state, playerSide);
    return;
  }
  const season = state.map.def.season;
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead') continue;
    if (s.vehicleId != null) continue;
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    if (!visible(s.pos, cam)) continue;
    const p = worldToScreen(cam, s.pos);
    const selected = selectedTeamIds.includes(s.teamId);
    if (selected) drawSelectionRing(ctx, p);
    const stance = s.health === 'incapacitated' ? 'prone' : s.stance;
    const outline = s.side === playerSide ? 'friendly' : 'enemy';
    const sprite = getSoldierSprite(s.side, season, stance, s.facing, frameOf(s), outline);
    const { dw, dh } = spriteDrawSize(sprite, cam.zoom);
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

/** Order dot colour: Move blue, Move Fast purple, Sneak yellow, Smoke gray,
 * Fire red (direct, has a locked target team) or orange (suppression fire at
 * a bare point); Defend/Ambush use their arc colours (blue/green). */
function orderColor(team: Team): string {
  const order = team.order;
  if (!order) return ORDER_DOT_COLOR.move;
  if (order.type === 'fire' && order.targetTeamId == null) return '#e08a2c';
  return ORDER_DOT_COLOR[order.type];
}

function drawOrderLine(ctx: CanvasRenderingContext2D, cam: Camera, team: Team): void {
  const order = team.order;
  if (!order) return;
  const color = orderColor(team);
  const from = worldToScreen(cam, team.pos);
  if (order.type === 'defend' || order.type === 'ambush') {
    const rad = facingAngle(team.facing) - Math.PI / 2;
    const spread = Math.PI / 6; // 30deg either side = 60deg arc
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(from.x, from.y, 20 * cam.zoom, rad - spread, rad + spread);
    ctx.stroke();
    ctx.restore();
    return;
  }
  // Thin line from the team to each waypoint (if any) and finally the
  // target, with a small filled dot at each stop — matches the original's
  // order-dot presentation rather than a dashed line with an end marker.
  const points = [order.target, ...(order.waypoints ?? [])];
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  let prev = from;
  for (const wp of points) {
    const to = worldToScreen(cam, wp);
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    prev = to;
  }
  for (const wp of points) {
    const p = worldToScreen(cam, wp);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawUnits(
  ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState,
  playerSide: Side, selectedTeamIds: readonly number[], settings: GameSettings,
  showDead = true,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;

  drawCorpses(ctx, cam, state, playerSide, showDead);
  drawVehicles(ctx, cam, state, playerSide);
  drawSoldiers(ctx, cam, state, playerSide, selectedTeamIds);
  drawTeamBars(ctx, cam, state, playerSide);
  drawFlags(ctx, cam, state);
  drawTeamLabels(ctx, cam, state, settings);

  for (const id of selectedTeamIds) {
    const team = state.teams.get(id);
    if (team && team.side === playerSide) drawOrderLine(ctx, cam, team);
  }

  ctx.restore();
}
