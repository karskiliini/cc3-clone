// ============================================================================
// bottomStrip.ts — the bottom 40px band of the panel (y 728..768, x 0..~615):
// Options, zoom +/-, Map button, the selected-team box (icon, name bar,
// status, soldier health squares), Anti-Pers/Anti-Tank ammo bars, and the
// right-hand action buttons (Truce/Flee in battle, Begin/Auto in deploy).
// ============================================================================
import type { Rect, InputState, BattleState, Team, Soldier, Vec2 } from '@/shared/types';
import { HUD } from '@/render/palette';
import { clamp } from '@/shared/math';
import { getTeamIcon } from '@/render/sprites';
import { WEAPONS } from '@/data/weapons';
import { drawHudBevel, drawHudButton, setHudFont, clipTextToWidth, teamBarColor, teamStatusLabel, teamStatusTextColor, tintedTeamIcon } from './hudChrome';

export type BottomStripAction = 'options' | 'zoomIn' | 'zoomOut' | 'map' | 'truce' | 'flee' | 'begin' | 'auto';

const OPTIONS_R: Rect = { x: 2, y: 738, w: 48, h: 20 };
const ZOOM_IN_C = { x: 68, y: 748, r: 9 };
const MAP_R: Rect = { x: 82, y: 733, w: 50, h: 30 };
const ZOOM_OUT_C = { x: 148, y: 748, r: 9 };

const TEAM_ICON_R: Rect = { x: 164, y: 730, w: 32, h: 34 };
const NAME_BAR_R: Rect = { x: 200, y: 731, w: 96, h: 12 };
const STATUS_R: Rect = { x: 200, y: 744, w: 96, h: 12 };
const HEALTH_X0 = 302;
const HEALTH_Y = 736;
const HEALTH_SIZE = 7;
const HEALTH_GAP = 1;

const AP_LABEL: Vec2 = { x: 392, y: 731 };
const AP_BAR: Rect = { x: 455, y: 732, w: 120, h: 8 };
const AT_LABEL: Vec2 = { x: 392, y: 748 };
const AT_BAR: Rect = { x: 455, y: 749, w: 120, h: 8 };
const AMMO_TICKS = ['2', '4', '8', '16', '32', '64'];

const RIGHT_BTN_1: Rect = { x: 585, y: 730, w: 30, h: 17 };
const RIGHT_BTN_2: Rect = { x: 585, y: 749, w: 30, h: 17 };

function circleHit(p: Vec2, c: { x: number; y: number; r: number }): boolean {
  return (p.x - c.x) ** 2 + (p.y - c.y) ** 2 <= c.r * c.r;
}

function drawCircleButton(ctx: CanvasRenderingContext2D, c: { x: number; y: number; r: number }, label: string, hot: boolean): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fillStyle = hot ? HUD.bevelLight : HUD.face;
  ctx.fill();
  ctx.strokeStyle = HUD.bevelDark;
  ctx.lineWidth = 1;
  ctx.stroke();
  setHudFont(ctx, 'small');
  ctx.fillStyle = HUD.text;
  ctx.textAlign = 'center';
  ctx.fillText(label, c.x, c.y - 6);
  ctx.textAlign = 'left';
}

function aliveSoldiers(state: BattleState, team: Team): Soldier[] {
  return team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
}

const AT_WEAPON_CLASSES = new Set(['atgun', 'atrocket', 'atrifle', 'tankgun']);

function ammoFraction(state: BattleState, team: Team, kind: 'ap' | 'at'): number {
  const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
  if (vehicle) {
    if (kind === 'at') return clamp(vehicle.mainAmmo / 40, 0, 1);
    return clamp(vehicle.coaxAmmo / 1000, 0, 1);
  }
  const soldiers = aliveSoldiers(state, team);
  if (soldiers.length === 0) return 0;
  let total = 0, max = 0;
  for (const s of soldiers) {
    const w = WEAPONS[s.weaponId];
    const isAt = w && AT_WEAPON_CLASSES.has(w.cls);
    if (kind === 'at') {
      if (isAt) { total += s.ammo + s.ammoReserve; max += 40; }
    } else {
      if (!isAt) { total += s.ammo + s.ammoReserve; max += 65; }
    }
  }
  if (max <= 0) return 0;
  return clamp(total / max, 0, 1);
}

function drawAmmoBar(ctx: CanvasRenderingContext2D, label: string, labelPos: Vec2, bar: Rect, fraction: number): void {
  setHudFont(ctx, 'small');
  ctx.fillStyle = HUD.text;
  ctx.fillText(label, labelPos.x, labelPos.y);
  drawHudBevel(ctx, bar, true, HUD.black);
  const fillW = Math.round((bar.w - 2) * fraction);
  ctx.fillStyle = HUD.green;
  ctx.fillRect(Math.round(bar.x) + 1, Math.round(bar.y) + 1, fillW, Math.round(bar.h) - 2);
  setHudFont(ctx, 'tiny');
  ctx.fillStyle = HUD.dim;
  const step = bar.w / AMMO_TICKS.length;
  for (let i = 0; i < AMMO_TICKS.length; i++) {
    ctx.fillText(AMMO_TICKS[i], Math.round(bar.x + i * step), Math.round(bar.y + bar.h + 1));
  }
}

export class BottomStrip {
  private mode: 'battle' | 'deploy';
  private hover: Set<string> = new Set();
  private fleeArmed = false;

  /** Battle screen tells the strip that Flee is armed (waiting for the confirming second click). */
  setFleeArmed(armed: boolean): void {
    this.fleeArmed = armed;
  }

  constructor(mode: 'battle' | 'deploy' = 'battle') {
    this.mode = mode;
  }

  update(input: InputState): BottomStripAction | null {
    this.hover.clear();
    const p = input.mouse;
    const inRect = (r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
    if (inRect(OPTIONS_R)) this.hover.add('options');
    if (inRect(MAP_R)) this.hover.add('map');
    if (circleHit(p, ZOOM_IN_C)) this.hover.add('zoomIn');
    if (circleHit(p, ZOOM_OUT_C)) this.hover.add('zoomOut');
    if (inRect(RIGHT_BTN_1)) this.hover.add('btn1');
    if (inRect(RIGHT_BTN_2)) this.hover.add('btn2');

    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const cp = { x: c.x, y: c.y };
      if (inRect(OPTIONS_R)) return 'options';
      if (inRect(MAP_R)) return 'map';
      if (circleHit(cp, ZOOM_IN_C)) return 'zoomIn';
      if (circleHit(cp, ZOOM_OUT_C)) return 'zoomOut';
      if (inRect(RIGHT_BTN_1)) return this.mode === 'battle' ? 'truce' : 'begin';
      if (inRect(RIGHT_BTN_2)) return this.mode === 'battle' ? 'flee' : 'auto';
    }
    return null;
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState, selectedTeam: Team | null): void {
    drawHudButton(ctx, OPTIONS_R, 'Options', { hot: this.hover.has('options') });
    drawCircleButton(ctx, ZOOM_IN_C, '+', this.hover.has('zoomIn'));
    drawHudButton(ctx, MAP_R, 'Map', { hot: this.hover.has('map'), fontKind: 'map' });
    drawCircleButton(ctx, ZOOM_OUT_C, String.fromCharCode(0x2212), this.hover.has('zoomOut'));

    drawHudBevel(ctx, TEAM_ICON_R, true, HUD.base);
    if (selectedTeam) {
      const icon = tintedTeamIcon(getTeamIcon(selectedTeam.type), selectedTeam.type);
      ctx.imageSmoothingEnabled = false;
      const iw = icon.width, ih = icon.height;
      // Clip to the icon slot so oversized icon art can't bleed into the
      // name bar / status text that starts just to its right.
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.round(TEAM_ICON_R.x), Math.round(TEAM_ICON_R.y), Math.round(TEAM_ICON_R.w), Math.round(TEAM_ICON_R.h));
      ctx.clip();
      ctx.drawImage(icon, Math.round(TEAM_ICON_R.x + (TEAM_ICON_R.w - iw) / 2), Math.round(TEAM_ICON_R.y + (TEAM_ICON_R.h - ih) / 2), iw, ih);
      ctx.restore();

      const barColor = teamBarColor(selectedTeam);
      ctx.fillStyle = barColor;
      ctx.fillRect(Math.round(NAME_BAR_R.x), Math.round(NAME_BAR_R.y), Math.round(NAME_BAR_R.w), Math.round(NAME_BAR_R.h));
      const nameOnDark = barColor === HUD.darkRed || barColor === HUD.red;
      setHudFont(ctx, 'tiny');
      ctx.fillStyle = nameOnDark ? HUD.text : HUD.black;
      ctx.fillText(clipTextToWidth(ctx, selectedTeam.name, NAME_BAR_R.w - 4), Math.round(NAME_BAR_R.x + 2), Math.round(NAME_BAR_R.y + 1));

      setHudFont(ctx, 'label');
      ctx.fillStyle = teamStatusTextColor(selectedTeam.status);
      ctx.fillText(clipTextToWidth(ctx, teamStatusLabel(selectedTeam.status), STATUS_R.w), Math.round(STATUS_R.x), Math.round(STATUS_R.y));

      const soldiers = aliveSoldiersIncDead(state, selectedTeam).slice(0, 10);
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        const x = HEALTH_X0 + i * (HEALTH_SIZE + HEALTH_GAP);
        ctx.fillStyle = healthColor(s);
        ctx.fillRect(x, HEALTH_Y, HEALTH_SIZE, HEALTH_SIZE);
        ctx.strokeStyle = HUD.bevelDark;
        ctx.strokeRect(x + 0.5, HEALTH_Y + 0.5, HEALTH_SIZE - 1, HEALTH_SIZE - 1);
      }

      drawAmmoBar(ctx, 'Anti-Pers:', AP_LABEL, AP_BAR, ammoFraction(state, selectedTeam, 'ap'));
      drawAmmoBar(ctx, 'Anti-Tank:', AT_LABEL, AT_BAR, ammoFraction(state, selectedTeam, 'at'));
    } else {
      // Nothing selected: leave the name/status/icon area blank, matching
      // the original (it is icon-only once a team is picked, empty otherwise).
      drawAmmoBar(ctx, 'Anti-Pers:', AP_LABEL, AP_BAR, 0);
      drawAmmoBar(ctx, 'Anti-Tank:', AT_LABEL, AT_BAR, 0);
    }

    if (this.mode === 'battle') {
      drawHudButton(ctx, RIGHT_BTN_1, 'Truce', { hot: this.hover.has('btn1') });
      if (this.fleeArmed) {
        drawHudBevel(ctx, RIGHT_BTN_2, true, HUD.red);
        setHudFont(ctx, 'small');
        ctx.fillStyle = HUD.text;
        ctx.textAlign = 'center';
        ctx.fillText('Flee', Math.round(RIGHT_BTN_2.x + RIGHT_BTN_2.w / 2), Math.round(RIGHT_BTN_2.y + (RIGHT_BTN_2.h - 11) / 2));
        ctx.textAlign = 'left';
      } else {
        drawHudButton(ctx, RIGHT_BTN_2, 'Flee', { hot: this.hover.has('btn2') });
      }
    } else {
      drawHudButton(ctx, RIGHT_BTN_1, 'Begin', { hot: this.hover.has('btn1') });
      drawHudButton(ctx, RIGHT_BTN_2, 'Auto', { hot: this.hover.has('btn2') });
    }
  }
}

function aliveSoldiersIncDead(state: BattleState, team: Team): Soldier[] {
  return team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
}

function healthColor(s: Soldier): string {
  if (s.health === 'dead') return '#3a1a16';
  if (s.health === 'incapacitated') return HUD.red;
  if (s.health === 'wounded') return HUD.yellow;
  return HUD.green;
}
