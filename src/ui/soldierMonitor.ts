// ============================================================================
// soldierMonitor.ts — bottom-centre panel (200,480,400,120): selected team's
// heading line + a 2x5 grid of soldier/vehicle cards.
// ============================================================================
import type { Rect, BattleState, Team, Soldier, Vehicle, Activity, VehicleState, Facing8 } from '@/shared/types';
import { ORDER_LABELS } from '@/shared/types';
import { PALETTE, ORDER_COLOR } from '@/render/palette';
import { drawText, drawTextCentered, textWidth, FONT_SMALL_H } from '@/render/pixelfont';
import { getSoldierSprite } from '@/render/sprites';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';
import { drawPanel, drawBevelBox } from '@/ui/chrome';

export const SOLDIER_MONITOR_RECT: Rect = { x: 200, y: 480, w: 400, h: 120 };

const HEAD_H = 14;
const CARD_W = 78;
const CARD_H = 50;
const CARD_GAP = 2;
const CARDS_X0 = 202;
const CARDS_Y0 = 496;
const COLS = 5;
const ROWS = 2;
const SOUTH: Facing8 = 4;

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** 0..100 -> team morale word thresholds (kept local per spec, independent of sim/morale.ts). */
function moraleWord(m: number): 'Fanatic' | 'Confident' | 'Steady' | 'Shaken' | 'Broken' {
  if (m >= 85) return 'Fanatic';
  if (m >= 65) return 'Confident';
  if (m >= 45) return 'Steady';
  if (m >= 25) return 'Shaken';
  return 'Broken';
}

function moraleColor(word: string): string {
  switch (word) {
    case 'Fanatic':
    case 'Confident':
      return PALETTE.green;
    case 'Steady':
      return PALETTE.white;
    case 'Shaken':
      return PALETTE.yellow;
    default:
      return PALETTE.red;
  }
}

const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: 'Idle',
  moving: 'Moving',
  movingFast: 'Mv Fast',
  sneaking: 'Sneaking',
  firing: 'Firing',
  reloading: 'Reloading',
  defending: 'Defending',
  ambushing: 'Ambushing',
  hiding: 'Hiding',
  cowering: 'Cowering',
  pinned: 'Pinned',
  panicked: 'Panicked',
  routed: 'Routed',
  berserk: 'Berserk',
  surrendered: 'Surrendered',
  dead: 'KIA',
  incapacitated: 'Incap.',
};

function soldierStatusWord(s: Soldier): string {
  if (s.health === 'wounded') return 'Wounded';
  if (s.health === 'incapacitated') return 'Incap.';
  if (s.health === 'dead') return 'KIA';
  return ACTIVITY_LABEL[s.activity];
}

function soldierStatusColor(s: Soldier): string {
  if (s.health === 'wounded') return PALETTE.yellow;
  if (s.health === 'incapacitated' || s.health === 'dead') return PALETTE.red;
  switch (s.activity) {
    case 'idle':
    case 'defending':
    case 'ambushing':
      return PALETTE.green;
    case 'firing':
      return PALETTE.yellow;
    case 'pinned':
    case 'cowering':
      return PALETTE.orange;
    case 'panicked':
    case 'routed':
    case 'berserk':
      return PALETTE.red;
    default:
      return PALETTE.white;
  }
}

const VEHICLE_STATE_LABEL: Record<VehicleState, string> = {
  ok: 'OK',
  immobilized: 'Immobilized',
  knockedOut: 'Knocked Out',
  burning: 'Burning',
  abandoned: 'Abandoned',
};

function truncateToWidth(text: string, maxW: number): string {
  if (textWidth(text) <= maxW) return text;
  let s = text;
  while (s.length > 0 && textWidth(s) > maxW) s = s.slice(0, -1);
  return s;
}

function cardRect(index: number): Rect {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    x: CARDS_X0 + col * (CARD_W + CARD_GAP),
    y: CARDS_Y0 + row * (CARD_H + CARD_GAP),
    w: CARD_W,
    h: CARD_H,
  };
}

function drawSoldierCard(ctx: CanvasRenderingContext2D, r: Rect, s: Soldier): void {
  drawBevelBox(ctx, r, true);
  if (s.isLeader) {
    ctx.fillStyle = PALETTE.gold;
    ctx.fillRect(r.x, r.y, r.w, 1);
    ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
    ctx.fillRect(r.x, r.y, 1, r.h);
    ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
  }
  const px = r.x + 2;
  const nameW = r.w - 16; // leave room for posture glyph
  const rankName = truncateToWidth(`${s.rank} ${s.name}`, nameW);
  drawText(ctx, rankName, px, r.y + 2, PALETTE.gold, 'small');
  const weapon = WEAPONS[s.weaponId]?.name ?? s.weaponId;
  drawText(ctx, truncateToWidth(weapon, nameW), px, r.y + 10, PALETTE.text, 'small');
  drawText(ctx, truncateToWidth(soldierStatusWord(s), nameW), px, r.y + 18, soldierStatusColor(s), 'small');
  drawText(ctx, `Ammo ${s.ammo}`, px, r.y + 26, PALETTE.dim, 'small');

  const sprite = getSoldierSprite(s.side, 'summer', s.health === 'dead' ? 'dead' : s.stance, SOUTH, 0);
  ctx.drawImage(sprite, Math.round(r.x + r.w - sprite.width - 2), Math.round(r.y + r.h - sprite.height - 2));
}

function drawVehicleCard(ctx: CanvasRenderingContext2D, r: Rect, v: Vehicle): void {
  drawBevelBox(ctx, r, true);
  const def = VEHICLE_DEFS[v.defId];
  const px = r.x + 2;
  drawText(ctx, truncateToWidth(def?.name ?? v.defId, r.w - 4), px, r.y + 2, PALETTE.gold, 'small');
  drawText(ctx, VEHICLE_STATE_LABEL[v.state], px, r.y + 10, v.state === 'ok' ? PALETTE.green : PALETTE.red, 'small');
  drawText(ctx, `Main ${v.mainAmmo}`, px, r.y + 18, PALETTE.dim, 'small');
}

function drawHeading(ctx: CanvasRenderingContext2D, team: Team): void {
  const y = SOLDIER_MONITOR_RECT.y + 3;
  let x = SOLDIER_MONITOR_RECT.x + 4;
  // bold-ish effect: draw twice offset 1px
  drawText(ctx, team.name, x + 1, y, PALETTE.gold, 'small');
  drawText(ctx, team.name, x, y, PALETTE.gold, 'small');
  x += textWidth(team.name) + 6;

  const typeLabel = capitalize(team.type);
  drawText(ctx, `— ${typeLabel}`, x, y, PALETTE.text, 'small');
  x += textWidth(`— ${typeLabel}`) + 6;

  const orderLabel = team.order ? ORDER_LABELS[team.order.type] : 'IDLE';
  const orderColor = team.order ? ORDER_COLOR[team.order.type] : PALETTE.dim;
  drawText(ctx, orderLabel, x, y, orderColor, 'small');
  x += textWidth(orderLabel) + 6;

  const mWord = moraleWord(team.morale);
  drawText(ctx, mWord, x, y, moraleColor(mWord), 'small');
}

export function drawSoldierMonitor(ctx: CanvasRenderingContext2D, state: BattleState, team: Team | null): void {
  drawPanel(ctx, SOLDIER_MONITOR_RECT);

  if (!team) {
    drawTextCentered(
      ctx,
      'No team selected',
      SOLDIER_MONITOR_RECT.x + SOLDIER_MONITOR_RECT.w / 2,
      SOLDIER_MONITOR_RECT.y + SOLDIER_MONITOR_RECT.h / 2 - FONT_SMALL_H / 2,
      PALETTE.dim,
      'small',
    );
    return;
  }

  drawHeading(ctx, team);

  const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
  const soldiers: Soldier[] = team.soldierIds
    .map((id) => state.soldiers.get(id))
    .filter((s): s is Soldier => !!s);

  let cardIndex = 0;
  if (vehicle) {
    drawVehicleCard(ctx, cardRect(cardIndex), vehicle);
    cardIndex++;
  }
  const maxCards = COLS * ROWS;
  for (const s of soldiers) {
    if (cardIndex >= maxCards) break;
    drawSoldierCard(ctx, cardRect(cardIndex), s);
    cardIndex++;
  }
}
