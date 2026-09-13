// ============================================================================
// soldierMonitor.ts — the "soldier monitor" popup that floats over the
// bottom-right of the MAP VIEWPORT (not the bottom panel) whenever a team is
// selected: one 2-line row per soldier (surname/role/health, activity/weapon/
// rounds), a header tab row for vehicle teams, and a left scroll arrow.
// ============================================================================
import type { Rect, BattleState, Team, Soldier, Vehicle, InputState, WeaponClass } from '@/shared/types';
import { PANEL_Y } from '@/shared/types';
import { clamp } from '@/shared/math';
import { HUD } from '@/render/palette';
import { WEAPONS } from '@/data/weapons';
import { drawHudBevel, hitRect, setHudFont, clipTextToWidth } from './hudChrome';

const GLYPH_SIZE = 8;

/** Small line-art weapon pictogram (rifle/mg/pistol/mortar/AT/flame silhouette)
 * drawn to the left of the ammo readout, matching the original's icon-first
 * weapon/ammo line instead of plain text alone. */
function drawWeaponGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, cls: WeaponClass): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = HUD.dim;
  ctx.fillStyle = HUD.dim;
  ctx.lineWidth = 1;
  switch (cls) {
    case 'rifle':
    case 'atrifle':
      ctx.beginPath(); ctx.moveTo(0, 7); ctx.lineTo(7, 0); ctx.stroke();
      ctx.fillRect(0, 6, 2, 2);
      break;
    case 'smg':
    case 'pistol':
      ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(6, 1); ctx.stroke();
      ctx.fillRect(2, 4, 2, 3);
      break;
    case 'lmg':
    case 'hmg':
    case 'coaxmg':
      ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(7, 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(1, 7); ctx.lineTo(3, 5); ctx.moveTo(5, 7); ctx.lineTo(3, 5); ctx.stroke();
      break;
    case 'mortar':
      ctx.beginPath(); ctx.moveTo(1, 7); ctx.lineTo(6, 0); ctx.stroke();
      ctx.fillRect(0, 6, 7, 1);
      break;
    case 'atgun':
    case 'tankgun':
      ctx.fillRect(0, 5, 3, 2);
      ctx.beginPath(); ctx.moveTo(3, 6); ctx.lineTo(8, 2); ctx.stroke();
      break;
    case 'atrocket':
      ctx.beginPath(); ctx.moveTo(0, 4); ctx.lineTo(6, 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(6, 2); ctx.lineTo(8, 4); ctx.lineTo(6, 6); ctx.closePath(); ctx.fill();
      break;
    case 'flamethrower':
      ctx.beginPath(); ctx.arc(3, 4, 3, 0, Math.PI * 2); ctx.stroke();
      break;
    case 'grenade':
      ctx.beginPath(); ctx.arc(3, 5, 2.5, 0, Math.PI * 2); ctx.fill();
      break;
    default:
      ctx.strokeRect(0.5, 0.5, 6, 6);
  }
  ctx.restore();
}

const RIGHT_X = 1024;
const WIDTH = 242;
const ROW_H = 26;
const MAX_ROWS = 6;
const HEADER_H = 14;
const ARROW_W = 12;

const GUNNER_WEAPON_CLASSES = new Set<WeaponClass>(['lmg', 'hmg', 'mortar', 'atgun', 'atrocket']);

function role(vehicle: Vehicle | undefined, soldiers: Soldier[], index: number, s: Soldier): string {
  if (vehicle) {
    const roles = ['Commander', 'Gunner', 'Loader', 'Driver'];
    return roles[index] ?? 'Crew';
  }
  if (index === 0) return 'Leader';
  const w = WEAPONS[s.weaponId];
  if (w && GUNNER_WEAPON_CLASSES.has(w.cls)) return 'Gunner';
  const prev = soldiers[index - 1];
  const prevW = prev && WEAPONS[prev.weaponId];
  if (prevW && GUNNER_WEAPON_CLASSES.has(prevW.cls)) return 'Assist';
  return 'Soldat';
}

function healthWord(s: Soldier): string {
  switch (s.health) {
    case 'healthy': return 'Healthy';
    case 'wounded': return 'Slightly injured';
    case 'incapacitated': return 'Incap.';
    case 'dead': return 'Dead';
  }
}
function healthColor(s: Soldier): string {
  switch (s.health) {
    case 'healthy': return HUD.green;
    case 'wounded': return HUD.yellow;
    default: return HUD.red;
  }
}

/** Vehicle crew, when not actively firing/reloading/moving, read by role
 * rather than by generic activity (matches the original's Driving/Loading/
 * Assisting vocabulary for tank/gun crews). */
function crewFallbackWord(roleName: string): string {
  if (roleName === 'Driver') return 'Driving';
  if (roleName === 'Loader') return 'Loading';
  return 'Assisting';
}

function activityWord(s: Soldier, team: Team | null, vehicle: Vehicle | undefined, roleName: string): string {
  if (s.health === 'dead' || s.activity === 'dead') return 'Dead';
  if (s.health === 'incapacitated' || s.activity === 'incapacitated') return 'Unconscious';
  switch (s.activity) {
    case 'moving': return vehicle && roleName === 'Driver' ? 'Driving' : 'Moving';
    case 'movingFast': return 'Running';
    case 'sneaking': return 'Crawling';
    case 'firing': return 'Firing';
    case 'reloading': return 'Reloading';
    case 'defending': return vehicle ? crewFallbackWord(roleName) : 'Defending';
    case 'ambushing': return vehicle ? crewFallbackWord(roleName) : 'Ambushing';
    case 'hiding': return 'Hiding';
    case 'cowering': return 'Cowering';
    case 'pinned': return 'Pinned';
    case 'panicked': return 'Panicking';
    case 'routed': return 'Fleeing';
    case 'berserk': return 'Berserk';
    case 'surrendered': return 'Surrendered';
    case 'idle':
    default: {
      if (vehicle) return crewFallbackWord(roleName);
      const ord = team?.order?.type;
      if (ord === 'ambush') return 'Ambushing';
      if (ord === 'defend') return 'Defending';
      return 'Waiting';
    }
  }
}
function activityColor(s: Soldier): string {
  if (s.health === 'dead' || s.activity === 'dead') return HUD.red;
  if (s.health === 'incapacitated' || s.activity === 'incapacitated') return HUD.red;
  switch (s.activity) {
    case 'pinned': return HUD.yellow;
    case 'panicked':
    case 'routed':
      return HUD.red;
    default: return HUD.green;
  }
}

export class SoldierMonitorPopup {
  private scroll = 0;
  private hoverUp = false;
  private hoverDown = false;

  private rect(rows: number, header: boolean): Rect {
    const h = rows * ROW_H + (header ? HEADER_H : 0);
    return { x: RIGHT_X - WIDTH, y: PANEL_Y - h, w: WIDTH, h };
  }

  update(input: InputState, state: BattleState, team: Team | null): void {
    this.hoverUp = false;
    this.hoverDown = false;
    if (!team) return;
    const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
    const rows = Math.min(MAX_ROWS, soldiers.length);
    if (rows === 0) return;
    const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
    const r = this.rect(rows, !!vehicle);
    const bodyY = r.y + (vehicle ? HEADER_H : 0);
    const upR: Rect = { x: r.x, y: bodyY, w: ARROW_W, h: rows * ROW_H / 2 };
    const downR: Rect = { x: r.x, y: bodyY + rows * ROW_H / 2, w: ARROW_W, h: rows * ROW_H / 2 };
    this.hoverUp = hitRect(input.mouse, upR);
    this.hoverDown = hitRect(input.mouse, downR);
    const maxScroll = Math.max(0, soldiers.length - MAX_ROWS);
    if (hitRect(input.mouse, r) && input.wheel !== 0) {
      this.scroll = clamp(this.scroll + Math.sign(input.wheel), 0, maxScroll);
    }
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (hitRect(p, upR)) this.scroll = clamp(this.scroll - 1, 0, maxScroll);
      else if (hitRect(p, downR)) this.scroll = clamp(this.scroll + 1, 0, maxScroll);
    }
    this.scroll = clamp(this.scroll, 0, maxScroll);
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState, team: Team | null): void {
    if (!team) return;
    const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
    if (soldiers.length === 0) return;
    const rows = Math.min(MAX_ROWS, soldiers.length);
    const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
    const r = this.rect(rows, !!vehicle);

    drawHudBevel(ctx, r, false);

    let bodyY = r.y;
    if (vehicle) {
      const headerR: Rect = { x: r.x, y: r.y, w: r.w, h: HEADER_H };
      drawHudBevel(ctx, headerR, true);
      setHudFont(ctx, 'small');
      ctx.fillStyle = HUD.text;
      ctx.fillText('Main Gun', r.x + 6, r.y + 2);
      ctx.fillText('Operational', r.x + r.w - 80, r.y + 2);
      bodyY = r.y + HEADER_H;
    }

    const hasScroll = soldiers.length > MAX_ROWS;
    const contentX = r.x + (hasScroll ? ARROW_W : 2);

    for (let i = 0; i < rows; i++) {
      const s = soldiers[this.scroll + i];
      const rowY = bodyY + i * ROW_H;
      // line 1: surname | role | health
      setHudFont(ctx, 'small');
      ctx.fillStyle = HUD.text;
      ctx.fillText(clipTextToWidth(ctx, s.name, 70), contentX, rowY + 1);
      ctx.fillStyle = HUD.text;
      const roleName = role(vehicle, soldiers, this.scroll + i, s);
      ctx.fillText(roleName, contentX + 76, rowY + 1);
      ctx.fillStyle = healthColor(s);
      ctx.textAlign = 'right';
      ctx.fillText(healthWord(s), r.x + r.w - 6, rowY + 1);
      ctx.textAlign = 'left';

      // line 2: activity | weapon | rounds
      ctx.fillStyle = activityColor(s);
      ctx.fillText(activityWord(s, team, vehicle, roleName), contentX, rowY + 13);
      const w = WEAPONS[s.weaponId];
      if (w) drawWeaponGlyph(ctx, contentX + 76, rowY + 11, w.cls);
      ctx.fillStyle = HUD.dim;
      ctx.fillText(clipTextToWidth(ctx, w?.name ?? s.weaponId, 50), contentX + 76 + GLYPH_SIZE + 3, rowY + 13);
      ctx.textAlign = 'right';
      ctx.fillText(`${s.ammo} rds.`, r.x + r.w - 6, rowY + 13);
      ctx.textAlign = 'left';

      if (i < rows - 1) {
        ctx.strokeStyle = HUD.bevelDark;
        ctx.beginPath();
        ctx.moveTo(r.x + 2, rowY + ROW_H - 0.5);
        ctx.lineTo(r.x + r.w - 2, rowY + ROW_H - 0.5);
        ctx.stroke();
      }
    }

    if (hasScroll) {
      ctx.fillStyle = this.hoverUp ? HUD.bevelLight : HUD.dim;
      ctx.beginPath();
      ctx.moveTo(r.x + 2, bodyY + rows * ROW_H / 4 + 3);
      ctx.lineTo(r.x + 10, bodyY + rows * ROW_H / 4 + 3);
      ctx.lineTo(r.x + 6, bodyY + rows * ROW_H / 4 - 3);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = this.hoverDown ? HUD.bevelLight : HUD.dim;
      ctx.beginPath();
      ctx.moveTo(r.x + 2, bodyY + rows * ROW_H * 3 / 4 - 3);
      ctx.lineTo(r.x + 10, bodyY + rows * ROW_H * 3 / 4 - 3);
      ctx.lineTo(r.x + 6, bodyY + rows * ROW_H * 3 / 4 + 3);
      ctx.closePath();
      ctx.fill();
    }
  }
}
