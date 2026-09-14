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
import { VEHICLE_DEFS } from '@/data/units';
import { drawHudBevel, hitRect, setHudFont, fitHudText } from './hudChrome';

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
const ROW_H = 32;
const MAX_ROWS = 4;
const CELL_H = 15;
const HEADER_H = 14;
const ARROW_W = 12;
const NAME_W = 70;
const ROLE_W = 66;
const RDS_CELL_W = 28;

/** Inner text widths (cell width minus the 3 px padding each side) of the monitor's columns in
 * the narrowest layout (with the scroll arrow), plus their fonts — used by tests to prove no
 * role/status/activity word overflows. */
export const MONITOR_TEXT_CELLS = {
  role: { maxW: ROLE_W - 6, font: 'map' as const },
  activity: { maxW: NAME_W - 6, font: 'small' as const },
  status: { maxW: WIDTH - 2 - (ARROW_W + NAME_W + 1 + ROLE_W + 1) - 6, font: 'small' as const },
};
/** Every word the role and status/activity columns can show. */
export const MONITOR_ROLE_WORDS = ['Leader', 'Gunner', 'Assist', 'Assist. Ldr.', 'Loader', 'Driver', 'Commander', 'Soldat', 'Radioman', 'Crew'];
export const MONITOR_STATUS_WORDS = ['Healthy', 'Slightly injured', 'Incap.', 'Dead', 'Pinned', 'Cowering', 'Panicked', 'Broken', 'Berserk'];
export const MONITOR_ACTIVITY_WORDS = ['Dead', 'Unconscious', 'Wary', 'Shaken', 'Driving', 'Moving', 'Running', 'Crawling', 'Firing', 'Reloading', 'Loading', 'Assisting', 'Defending', 'Ambushing', 'Hiding', 'Fleeing', 'Charging', 'Surrendered', 'Waiting'];

const GUNNER_WEAPON_CLASSES = new Set<WeaponClass>(['lmg', 'hmg', 'mortar', 'atgun', 'atrocket']);

function role(vehicle: Vehicle | undefined, soldiers: Soldier[], index: number, s: Soldier): string {
  if (vehicle) {
    const roles = ['Commander', 'Gunner', 'Loader', 'Driver', 'Radioman'];
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
  // spec §7: show the mental-state word for wary/shaken, which have no dedicated Activity of their
  // own (calm/alert are unremarkable and keep the normal activity word).
  if (s.mind.state === 'wary') return 'Wary';
  if (s.mind.state === 'shaken') return 'Shaken';
  switch (s.activity) {
    case 'moving': return vehicle && roleName === 'Driver' ? 'Driving' : 'Moving';
    case 'movingFast': return 'Running';
    case 'sneaking': return 'Crawling';
    case 'firing': return 'Firing';
    case 'reloading': return 'Reloading';
    case 'defending': return vehicle ? crewFallbackWord(roleName) : 'Defending';
    case 'ambushing': return vehicle ? crewFallbackWord(roleName) : 'Ambushing';
    // The mind state itself (Pinned/Cowering/Panicked/Broken/Berserk) is shown in the right-hand
    // status column; line 2 keeps describing what the man is physically doing.
    case 'hiding':
    case 'cowering':
    case 'pinned':
      return 'Hiding';
    case 'panicked': return 'Running';
    case 'routed': return 'Fleeing';
    case 'berserk': return 'Charging';
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
  // spec §7 colours for the mind states still shown on line 2: wary white, shaken yellow.
  if (s.mind.state === 'wary') return HUD.text;
  if (s.mind.state === 'shaken') return HUD.yellow;
  switch (s.activity) {
    case 'panicked':
    case 'routed':
      return HUD.red;
    default: return HUD.green;
  }
}

/** Right-hand status column: Dead/Incap. always win, then a severe mind state, else health. */
function statusCell(s: Soldier): { word: string; color: string } {
  if (s.health === 'dead' || s.health === 'incapacitated') return { word: healthWord(s), color: HUD.red };
  switch (s.mind.state) {
    case 'pinned': return { word: 'Pinned', color: HUD.yellow };
    case 'cowering': return { word: 'Cowering', color: HUD.yellow };
    case 'panicked': return { word: 'Panicked', color: HUD.red };
    case 'broken': return { word: 'Broken', color: HUD.red };
    case 'berserk': return { word: 'Berserk', color: HUD.magenta };
    default: return { word: healthWord(s), color: healthColor(s) };
  }
}

/** Original-style abbreviations tried (after shrinking the font) when a word still overflows. */
export const MONITOR_ABBREV: Record<string, string[]> = {
  Commander: ['Cmdr.'],
  'Assist. Ldr.': ['Asst. Ldr.', 'A. Ldr.'],
  Radioman: ['Radio'],
  'Slightly injured': ['Injured'],
  Unconscious: ['Uncons.'],
  Surrendered: ['Surr.'],
};

/** Short weapon names for the line-2 label (the original prints the bare model, no mount/scope). */
const SHORT_WEAPON_NAME: Record<string, string> = {
  mosin: 'Mosin', mosin_scoped: 'Mosin', kar98k_scoped: 'Kar98k', ppsh41: 'PPSh', svt40: 'SVT-40',
  pistol_p38: 'P38', pistol_tt: 'TT-33', mg34_hmg: 'MG34', mg42_hmg: 'MG42', maxim: 'Maxim',
  coax_mg34: 'MG34', coax_dt: 'DT', panzerschreck: 'Pz.schreck', satchel: 'Satchel',
};
export function shortWeaponName(weaponId: string): string {
  const w = WEAPONS[weaponId];
  if (!w) return '';
  return SHORT_WEAPON_NAME[weaponId] ?? w.name.replace(/\s*\(.*\)\s*$/, '');
}

/** What line 2 shows to the right of the activity cell for one soldier. */
export interface WeaponReadout {
  /** pictogram class, or null for no glyph */
  glyph: WeaponClass | null;
  /** ammo type ("AP"/"HE"/"Smk"), short weapon name, or '' */
  label: string;
  /** rounds figure for the rds. cell, or null to leave the cell empty */
  rounds: number | null;
}

/** Round a gun currently has loaded: AP when laid on (or waiting for) armour, HE against men/points. */
function gunRound(targetVehicleId: number | null, targetSoldierId: number | null, targetPoint: unknown): 'AP' | 'HE' {
  if (targetVehicleId != null) return 'AP';
  if (targetSoldierId != null || targetPoint != null) return 'HE';
  return 'AP';
}

/** Per-soldier weapon/ammo readout, following the original monitor: gun and mortar crews show the
 * round type of *their own* weapon, vehicle gunners the main gun's round, loaders just the rounds,
 * drivers/commanders nothing; everyone else the short name of the weapon he carries. */
export function weaponReadout(s: Soldier, team: Team | null, vehicle: Vehicle | undefined, roleName: string): WeaponReadout {
  if (vehicle) {
    const def = VEHICLE_DEFS[vehicle.defId];
    const mainId = def?.mainWeaponId ?? null;
    if (roleName === 'Gunner') {
      if (mainId) {
        return { glyph: 'tankgun', label: gunRound(vehicle.targetVehicleId, vehicle.targetSoldierId, vehicle.targetPoint), rounds: vehicle.mainAmmo };
      }
      const coax = def?.coaxWeaponId ?? null;
      return coax
        ? { glyph: 'coaxmg', label: shortWeaponName(coax), rounds: vehicle.coaxAmmo }
        : { glyph: null, label: '', rounds: null };
    }
    if (roleName === 'Loader') return { glyph: null, label: '', rounds: mainId ? vehicle.mainAmmo : null };
    if (roleName === 'Radioman' && def?.coaxWeaponId) {
      return { glyph: 'coaxmg', label: shortWeaponName(def.coaxWeaponId), rounds: vehicle.coaxAmmo };
    }
    return { glyph: null, label: '', rounds: null };
  }
  const w = WEAPONS[s.weaponId];
  if (!w) return { glyph: null, label: '', rounds: s.ammo };
  switch (w.cls) {
    case 'mortar':
      return { glyph: w.cls, label: team?.order?.type === 'smoke' && w.smoke ? 'Smk' : 'HE', rounds: s.ammo };
    case 'atgun':
    case 'tankgun':
      return { glyph: w.cls, label: gunRound(s.targetVehicleId, s.targetSoldierId, s.targetPoint), rounds: s.ammo };
    default:
      return { glyph: w.cls, label: shortWeaponName(s.weaponId), rounds: s.ammo };
  }
}

/** Text in a bevelled cell; `align` centre is used for the raised role cell. The text is fitted
 * (font shrunk up to 2 px, then an abbreviation) rather than cut mid-word. */
function cellText(ctx: CanvasRenderingContext2D, r: Rect, text: string, color: string, align: 'left' | 'center' | 'right' = 'left'): void {
  ctx.fillStyle = color;
  const maxW = r.w - 6;
  const base = ctx.font;
  const fit = fitHudText(ctx, [text, ...(MONITOR_ABBREV[text] ?? [])], maxW);
  ctx.font = fit.font;
  const t = fit.text;
  const ty = Math.round(r.y + (r.h - 12) / 2) + 1;
  if (align === 'center') {
    ctx.textAlign = 'center';
    ctx.fillText(t, Math.round(r.x + r.w / 2), ty);
  } else if (align === 'right') {
    ctx.textAlign = 'right';
    ctx.fillText(t, Math.round(r.x + r.w - 3), ty);
  } else {
    ctx.fillText(t, Math.round(r.x + 3), ty);
  }
  ctx.textAlign = 'left';
  ctx.font = base;
}

export class SoldierMonitorPopup {
  private scroll = 0;
  private hoverUp = false;
  private hoverDown = false;

  private rect(rows: number, header: boolean): Rect {
    const h = rows * ROW_H + (header ? HEADER_H : 0);
    return { x: RIGHT_X - WIDTH, y: PANEL_Y - h, w: WIDTH, h };
  }

  /** Screen rect the popup occupies for `team` (null when it isn't drawn) — callers use it to keep
   * clicks on the popup from reaching the map underneath. */
  bounds(state: BattleState, team: Team | null): Rect | null {
    if (!team) return null;
    const count = team.soldierIds.filter((id) => state.soldiers.has(id)).length;
    if (count === 0) return null;
    return this.rect(Math.min(MAX_ROWS, count), team.vehicleId != null && state.vehicles.has(team.vehicleId));
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
      ctx.fillStyle = HUD.green;
      ctx.fillText('Main Gun', r.x + 6, r.y + 2);
      ctx.fillText('Operational', r.x + r.w - 80, r.y + 2);
      bodyY = r.y + HEADER_H;
    }

    const hasScroll = soldiers.length > MAX_ROWS;
    const contentX = r.x + (hasScroll ? ARROW_W : 2);
    const rightX = r.x + r.w - 2;

    for (let i = 0; i < rows; i++) {
      const s = soldiers[this.scroll + i];
      const rowY = bodyY + i * ROW_H;
      const y1 = rowY + 1;
      const y2 = rowY + 1 + CELL_H + 1;
      const roleName = role(vehicle, soldiers, this.scroll + i, s);

      // line 1: [name] (role) [status]
      const nameR: Rect = { x: contentX, y: y1, w: NAME_W, h: CELL_H };
      const roleR: Rect = { x: contentX + NAME_W + 1, y: y1, w: ROLE_W, h: CELL_H };
      const statusR: Rect = { x: roleR.x + ROLE_W + 1, y: y1, w: rightX - (roleR.x + ROLE_W + 1), h: CELL_H };
      drawHudBevel(ctx, nameR, true, HUD.black);
      drawHudBevel(ctx, roleR, false, HUD.face);
      drawHudBevel(ctx, statusR, true, HUD.black);
      setHudFont(ctx, 'small');
      cellText(ctx, nameR, s.name, HUD.text);
      const st = statusCell(s);
      cellText(ctx, statusR, st.word, st.color, 'right');
      setHudFont(ctx, 'map');
      cellText(ctx, roleR, roleName, HUD.text, 'center');

      // line 2: [activity]  glyph AP/HE   [N] rds.
      const actR: Rect = { x: contentX, y: y2, w: NAME_W, h: CELL_H };
      drawHudBevel(ctx, actR, true, HUD.black);
      setHudFont(ctx, 'small');
      cellText(ctx, actR, activityWord(s, team, vehicle, roleName), activityColor(s));
      const ro = weaponReadout(s, team, vehicle, roleName);
      const glyphX = roleR.x + 6;
      if (ro.glyph) drawWeaponGlyph(ctx, glyphX, y2 + 3, ro.glyph);
      setHudFont(ctx, 'small');
      const rdsLabelW = ctx.measureText(' rds.').width;
      const nR: Rect = { x: Math.round(rightX - 2 - rdsLabelW - RDS_CELL_W), y: y2, w: RDS_CELL_W, h: CELL_H };
      if (ro.label) {
        setHudFont(ctx, 'label');
        ctx.fillStyle = HUD.text;
        const labelX = glyphX + GLYPH_SIZE + 5;
        const fit = fitHudText(ctx, [ro.label], nR.x - 3 - labelX);
        ctx.font = fit.font;
        ctx.fillText(fit.text, labelX, y2 + 2);
        setHudFont(ctx, 'small');
      }
      drawHudBevel(ctx, nR, true, HUD.black);
      if (ro.rounds != null) {
        ctx.fillStyle = HUD.text;
        ctx.textAlign = 'right';
        ctx.fillText('rds.', rightX - 2, y2 + 2);
        ctx.textAlign = 'left';
        cellText(ctx, nR, String(ro.rounds), HUD.text, 'right');
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
