// ============================================================================
// unitRender.ts — draws soldiers, vehicles, selection rings, VL flags, team
// labels and order lines/arcs for the battle viewport.
// ============================================================================
import type {
  Camera, BattleState, Side, GameSettings, Soldier, Team,
} from '@/shared/types';
import { VIEW_W, VIEW_H } from '@/shared/types';
import { facingAngle } from '@/shared/math';
import { worldToScreen } from '@/engine/camera';
import { PALETTE, ORDER_COLOR } from '@/render/palette';
import { getSoldierSprite, getVehicleSprite, getFlagSprite } from '@/render/sprites';
import { drawText, textWidth } from '@/render/pixelfont';
import { VEHICLE_DEFS } from '@/data/units';

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

function drawCorpses(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side): void {
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

function drawSoldiers(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, playerSide: Side, selectedTeamId: number | null): void {
  const season = state.map.def.season;
  for (const s of state.soldiers.values()) {
    if (s.health === 'dead') continue;
    if (s.vehicleId != null) continue;
    if (!isEnemyVisible(state, playerSide, s.side, s.id, false)) continue;
    if (!visible(s.pos, cam)) continue;
    const p = worldToScreen(cam, s.pos);
    if (s.teamId === selectedTeamId) drawSelectionRing(ctx, p);
    const stance = s.health === 'incapacitated' ? 'prone' : s.stance;
    const sprite = getSoldierSprite(s.side, season, stance, s.facing, frameOf(s));
    ctx.drawImage(sprite, Math.round(p.x - sprite.width / 2), Math.round(p.y - sprite.height / 2));
  }
}

function drawFlags(ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState, settings: GameSettings): void {
  for (const vl of state.map.victoryLocations) {
    const pos = { x: vl.x, y: vl.y };
    if (!visible(pos, cam)) continue;
    const p = worldToScreen(cam, pos);
    const sprite = getFlagSprite(vl.owner);
    ctx.drawImage(sprite, Math.round(p.x - sprite.width / 2), Math.round(p.y - sprite.height));
    if (settings.unitLabels) {
      const w = textWidth(vl.name, 'small');
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(Math.round(p.x - w / 2 - 1), Math.round(p.y + 2), w + 2, 8);
      drawText(ctx, vl.name, Math.round(p.x - w / 2), Math.round(p.y + 3), PALETTE.white, 'small');
    }
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

function drawOrderLine(ctx: CanvasRenderingContext2D, cam: Camera, team: Team): void {
  const order = team.order;
  if (!order) return;
  const color = ORDER_COLOR[order.type];
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
  const to = worldToScreen(cam, order.target);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(to.x - 1), Math.round(to.y - 1), 3, 3);
  ctx.restore();
}

export function drawUnits(
  ctx: CanvasRenderingContext2D, cam: Camera, state: BattleState,
  playerSide: Side, selectedTeamId: number | null, settings: GameSettings,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VIEW_W, VIEW_H);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;

  drawCorpses(ctx, cam, state, playerSide);
  drawVehicles(ctx, cam, state, playerSide);
  drawSoldiers(ctx, cam, state, playerSide, selectedTeamId);
  drawFlags(ctx, cam, state, settings);
  drawTeamLabels(ctx, cam, state, settings);

  if (selectedTeamId != null) {
    const team = state.teams.get(selectedTeamId);
    if (team && team.side === playerSide) drawOrderLine(ctx, cam, team);
  }

  ctx.restore();
}
