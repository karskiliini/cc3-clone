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
import { PALETTE } from '@/render/palette';
import { getSoldierSprite, getVehicleSprite, getFlagSprite } from '@/render/sprites';
import { drawText, textWidth } from '@/render/pixelfont';
import { VEHICLE_DEFS } from '@/data/units';

function soldierBarColor(s: Soldier): string {
  if (s.health === 'incapacitated') return PALETTE.red;
  if (s.health === 'wounded') return PALETTE.yellow;
  if (s.activity === 'pinned' || s.activity === 'cowering') return PALETTE.yellow;
  if (s.activity === 'panicked' || s.activity === 'routed' || s.activity === 'berserk') return PALETTE.red;
  return PALETTE.green;
}

/** Draws a small 12x3 colour bar 8px above each living soldier of every
 * selected team — green healthy, yellow pinned/wounded, red broken/incap,
 * matching CC3's selected-team status ticks. */
function drawSelectedTeamBars(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, selectedTeamIds: readonly number[]): void {
  if (selectedTeamIds.length === 0) return;
  for (const s of state.soldiers.values()) {
    if (!selectedTeamIds.includes(s.teamId)) continue;
    if (s.health === 'dead' || s.vehicleId != null) continue;
    if (!visible(s.pos, cam)) continue;
    const p = worldToScreen(cam, s.pos);
    ctx.fillStyle = soldierBarColor(s);
    ctx.fillRect(Math.round(p.x - 6), Math.round(p.y - 12), 12, 3);
  }
}

function rotateAndDraw(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, cx: number, cy: number, rad: number): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
  ctx.restore();
}

function frameOf(soldier: Soldier): 0 | 1 {
  return (Math.floor(soldier.animFrame) % 2 === 0 ? 0 : 1);
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
    ctx.drawImage(sprite, Math.round(p.x - sprite.width / 2), Math.round(p.y - sprite.height / 2));
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
    rotateAndDraw(ctx, hull, p.x, p.y, veh.hullFacing);
    const def = VEHICLE_DEFS[veh.defId];
    if (def && def.hasTurret) {
      const turret = getVehicleSprite(veh.defId, 'turret', spriteState);
      rotateAndDraw(ctx, turret, p.x, p.y, veh.turretFacing);
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

function drawSoldiers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, selectedTeamIds: readonly number[]): void {
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
    const sprite = getSoldierSprite(s.side, season, stance, s.facing, frameOf(s));
    ctx.drawImage(sprite, Math.round(p.x - sprite.width / 2), Math.round(p.y - sprite.height / 2));
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

function drawFlags(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState): void {
  for (const vl of state.map.victoryLocations) {
    const pos = { x: vl.x, y: vl.y };
    if (!visible(pos, cam)) continue;
    const p = worldToScreen(cam, pos);
    const sprite = getFlagSprite(vl.owner);
    ctx.drawImage(sprite, Math.round(p.x - sprite.width / 2), Math.round(p.y - sprite.height));
    drawOutlinedLabel(ctx, vl.name, Math.round(p.x), Math.round(p.y + 2));
  }
}

function drawTeamLabels(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, settings: GameSettings): void {
  if (!settings.unitLabels) return;
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
  drawSelectedTeamBars(ctx, cam, state, selectedTeamIds);
  drawFlags(ctx, cam, state);
  drawTeamLabels(ctx, cam, state, settings);

  for (const id of selectedTeamIds) {
    const team = state.teams.get(id);
    if (team && team.side === playerSide) drawOrderLine(ctx, cam, team);
  }

  ctx.restore();
}
