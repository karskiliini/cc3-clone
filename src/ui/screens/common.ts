// ============================================================================
// common.ts — shared helpers for full-screen UI states: background painting,
// a small ListBox widget, word-wrap, camera-control helpers and a BACK button
// factory. Nothing here owns simulation state.
// ============================================================================
import type { Camera, InputState, Rect, Side, TeamDef, TeamType } from '@/shared/types';
import { SCREEN_W, SCREEN_H, VIEW_W, VIEW_H, MENU_X, MENU_Y, MENU_W, MENU_H } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { panCamera, clampCamera } from '@/engine/camera';
import { Button, drawDarkPanel, drawBottomStrip, drawSmallMetalButton, drawVerticalStencil, drawShadowText, drawPoster } from '@/ui/chrome';
import { PALETTE } from '@/render/palette';
import { drawText, textWidth } from '@/render/pixelfont';
import { getTeamIcon } from '@/render/sprites';
import { TEAM_DEFS, VEHICLE_DEFS, teamsForYear } from '@/data/units';
import { WEAPONS } from '@/data/weapons';

// ------------------------------------------------------------------- noise --
/** Deterministic 2D hash in [0,1), used for the painted-texture backdrop dither. */
export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}

// ---------------------------------------------------------------- backdrop --
/**
 * Fills the full 800x600 screen with a dark olive-black painted gradient,
 * a subtle noise dither texture, and a vignette frame. Used by every
 * full-screen overlay before drawing chrome panels on top.
 */
export function drawBackdrop(ctx: CanvasRenderingContext2D): void {
  const w = SCREEN_W;
  const h = SCREEN_H;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#262a20');
  grad.addColorStop(0.55, '#1a1d16');
  grad.addColorStop(1, '#0d0e0b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // painted noise dither
  const step = 4;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const n = hash2(x, y);
      if (n > 0.9) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(x, y, step, step);
      } else if (n < 0.08) {
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        ctx.fillRect(x, y, step, step);
      }
    }
  }

  // vignette
  const grd = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  ctx.strokeStyle = 'rgba(216,180,72,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(9.5, 9.5, w - 19, h - 19);
}

// ------------------------------------------------------------------ button --
/** A BACK button at a conventional spot; screens can reposition freely. */
export function createBackButton(label = 'BACK', x = 20, y = SCREEN_H - 44): Button {
  return new Button({ x, y, w: 100, h: 20 }, label);
}

// ------------------------------------------------------------------ layout --
/** Word-wrap `text` to lines no wider than `maxWidth` px at the given font size. */
export function wordWrap(text: string, maxWidth: number, size: 'small' | 'big' = 'small'): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (cur && textWidth(test, size) > maxWidth) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  color: string,
  lineH = 9,
  size: 'small' | 'big' = 'small',
): number {
  const lines = wordWrap(text, maxWidth, size);
  let cy = y;
  for (const line of lines) {
    drawText(ctx, line, x, cy, color, size);
    cy += lineH;
  }
  return cy;
}

// ------------------------------------------------------------------ ListBox --
/** A simple scrollable single-select list of text rows. */
export class ListBox {
  rect: Rect;
  rowH: number;
  items: string[] = [];
  selected = -1;
  scroll = 0;

  constructor(rect: Rect, rowH: number) {
    this.rect = rect;
    this.rowH = rowH;
  }

  visibleRows(): number {
    return Math.max(1, Math.floor(this.rect.h / this.rowH));
  }

  /** Returns true when the selection changed this frame. */
  update(input: InputState): boolean {
    let changed = false;
    if (pointInRect(input.mouse, this.rect) && input.wheel !== 0) {
      const maxScroll = Math.max(0, this.items.length - this.visibleRows());
      this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + (input.wheel > 0 ? 1 : -1)));
    }
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      if (!pointInRect({ x: c.x, y: c.y }, this.rect)) continue;
      const row = this.scroll + Math.floor((c.y - this.rect.y) / this.rowH);
      if (row >= 0 && row < this.items.length) {
        if (row !== this.selected) changed = true;
        this.selected = row;
      }
    }
    return changed;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    ctx.clip();
    const visible = this.visibleRows();
    for (let i = 0; i < visible; i++) {
      const idx = this.scroll + i;
      if (idx >= this.items.length) break;
      const ry = this.rect.y + i * this.rowH;
      if (idx === this.selected) {
        ctx.fillStyle = 'rgba(216,180,72,0.22)';
        ctx.fillRect(this.rect.x, ry, this.rect.w, this.rowH);
        ctx.strokeStyle = PALETTE.gold;
        ctx.strokeRect(this.rect.x + 0.5, ry + 0.5, this.rect.w - 1, this.rowH - 1);
      }
      drawText(
        ctx,
        this.items[idx],
        this.rect.x + 4,
        ry + Math.round((this.rowH - 7) / 2),
        idx === this.selected ? PALETTE.gold : PALETTE.text,
        'small',
      );
    }
    ctx.restore();
  }
}

// -------------------------------------------------------------- camera ctl --
/** Edge-scroll (cursor near the viewport border) + arrow-key panning, clamped to the map. */
export function updateCameraEdgeScrollAndKeys(
  cam: Camera,
  input: InputState,
  dt: number,
  mapW: number,
  mapH: number,
  edgePx = 8,
  speedPxPerSec = 300,
): void {
  let dx = 0;
  let dy = 0;
  if (input.mouse.y >= 0 && input.mouse.y <= VIEW_H) {
    if (input.mouse.x >= 0 && input.mouse.x < edgePx) dx -= 1;
    if (input.mouse.x <= VIEW_W && input.mouse.x > VIEW_W - edgePx) dx += 1;
    if (input.mouse.y >= 0 && input.mouse.y < edgePx) dy -= 1;
    if (input.mouse.y > VIEW_H - edgePx) dy += 1;
  }
  if (input.keysDown.has('arrowleft')) dx -= 1;
  if (input.keysDown.has('arrowright')) dx += 1;
  if (input.keysDown.has('arrowup')) dy -= 1;
  if (input.keysDown.has('arrowdown')) dy += 1;
  if (dx !== 0 || dy !== 0) panCamera(cam, dx * speedPxPerSec * dt, dy * speedPxPerSec * dt);
  clampCamera(cam, mapW, mapH);
}

export interface DragPanState {
  active: boolean;
  lastX: number;
  lastY: number;
}

export function makeDragPanState(): DragPanState {
  return { active: false, lastX: 0, lastY: 0 };
}

/** Simple right-drag pan (no click/drag distinction) — used by screens without a command menu. */
export function updateRightDragPan(cam: Camera, input: InputState, s: DragPanState, mapW: number, mapH: number): void {
  if (input.buttons.right) {
    if (!s.active) {
      s.active = true;
      s.lastX = input.mouse.x;
      s.lastY = input.mouse.y;
    } else {
      const dx = input.mouse.x - s.lastX;
      const dy = input.mouse.y - s.lastY;
      if (dx !== 0 || dy !== 0) {
        panCamera(cam, -dx, -dy);
        s.lastX = input.mouse.x;
        s.lastY = input.mouse.y;
      }
    }
  } else {
    s.active = false;
  }
  clampCamera(cam, mapW, mapH);
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss < 10 ? '0' : ''}${ss}`;
}

// ============================================================================
// POSTER MENU FRAME — the CC3 letterboxed 800x600 menu area centred inside
// the 1024x768 canvas at (MENU_X, MENU_Y). Every menu screen (mainMenu,
// battleSetup, options, debrief, operation) works in this MENU-local
// 800x600 coordinate space for both drawing and input.
// ============================================================================

/** Returns a copy of `input` with mouse/click/release points translated into
 * MENU-local (0..800,0..600) space, so existing widgets (Button, ListBox,
 * BottomStrip, ForcePicker...) can hit-test against MENU-local rects
 * unmodified. */
export function toMenuInput(input: InputState): InputState {
  return {
    ...input,
    mouse: { x: input.mouse.x - MENU_X, y: input.mouse.y - MENU_Y },
    clicks: input.clicks.map((c) => ({ x: c.x - MENU_X, y: c.y - MENU_Y, button: c.button })),
    releases: input.releases.map((c) => ({ x: c.x - MENU_X, y: c.y - MENU_Y, button: c.button })),
  };
}

/** Fills the whole canvas black, then translates the context to MENU-local
 * origin and paints the poster background. Callers draw their MENU-local
 * content after this and MUST call `ctx.restore()` once done. */
export function beginMenuFrame(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.translate(MENU_X, MENU_Y);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, MENU_W, MENU_H);
  ctx.clip();
  drawPoster(ctx);
  ctx.restore();
}

// -------------------------------------------------------------- BottomStrip --
const STRIP_Y = 560;
const STRIP_H = 20;

export interface BottomStripConfig {
  /** true: leftmost button reads "< Back"; false (main menu only): "Quit". Both
   * navigate to the main menu when clicked. */
  showBack: boolean;
  nextLabel?: string;
  nextEnabled?: boolean;
  helpText?: string;
}

export interface BottomStripResult {
  quitOrBack: boolean;
  main: boolean;
  options: boolean;
  next: boolean;
}

/** The control strip present at the bottom of every menu screen: Quit/Back,
 * Main, a row of disabled placeholder buttons (Revert/Briefing/History/Map/
 * Soldiers), Options, and Next, plus a help line underneath. Draw/update
 * expect MENU-local coordinates (pass the result of `toMenuInput`). */
export class BottomStrip {
  private quitBtn: Rect = { x: 16, y: STRIP_Y, w: 74, h: STRIP_H };
  private mainBtn: Rect = { x: 96, y: STRIP_Y, w: 62, h: STRIP_H };
  private revertBtn: Rect = { x: 164, y: STRIP_Y, w: 62, h: STRIP_H };
  private briefingBtn: Rect = { x: 232, y: STRIP_Y, w: 72, h: STRIP_H };
  private historyBtn: Rect = { x: 310, y: STRIP_Y, w: 64, h: STRIP_H };
  private mapBtn: Rect = { x: 380, y: STRIP_Y, w: 52, h: STRIP_H };
  private soldiersBtn: Rect = { x: 438, y: STRIP_Y, w: 74, h: STRIP_H };
  private optionsBtn: Rect = { x: 604, y: STRIP_Y, w: 72, h: STRIP_H };
  private nextBtn: Rect = { x: 726, y: STRIP_Y, w: 58, h: STRIP_H };

  showBack: boolean;
  nextLabel: string;
  nextEnabled: boolean;
  helpText: string;

  private hotQuit = false;
  private hotMain = false;
  private hotOptions = false;
  private hotNext = false;

  constructor(cfg: BottomStripConfig) {
    this.showBack = cfg.showBack;
    this.nextLabel = cfg.nextLabel ?? 'Next →';
    this.nextEnabled = cfg.nextEnabled ?? true;
    this.helpText = cfg.helpText ?? 'Right-click on screen elements to display more detailed help.';
  }

  /** `input` must already be in MENU-local coordinates (see `toMenuInput`). */
  update(input: InputState): BottomStripResult {
    this.hotQuit = pointInRect(input.mouse, this.quitBtn);
    this.hotMain = pointInRect(input.mouse, this.mainBtn);
    this.hotOptions = pointInRect(input.mouse, this.optionsBtn);
    this.hotNext = this.nextEnabled && pointInRect(input.mouse, this.nextBtn);
    let quitOrBack = false;
    let main = false;
    let options = false;
    let next = false;
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (pointInRect(p, this.quitBtn)) quitOrBack = true;
      else if (pointInRect(p, this.mainBtn)) main = true;
      else if (pointInRect(p, this.optionsBtn)) options = true;
      else if (this.nextEnabled && pointInRect(p, this.nextBtn)) next = true;
    }
    return { quitOrBack, main, options, next };
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawBottomStrip(ctx, [
      { label: this.showBack ? '← Back' : 'Quit', rect: this.quitBtn, hot: this.hotQuit },
      { label: 'Main', rect: this.mainBtn, hot: this.hotMain },
      { label: 'Revert', rect: this.revertBtn, disabled: true },
      { label: 'Briefing', rect: this.briefingBtn, disabled: true },
      { label: 'History', rect: this.historyBtn, disabled: true },
      { label: 'Map', rect: this.mapBtn, disabled: true },
      { label: 'Soldiers', rect: this.soldiersBtn, disabled: true },
      { label: 'Options', rect: this.optionsBtn, hot: this.hotOptions },
      { label: this.nextLabel, rect: this.nextBtn, disabled: !this.nextEnabled, hot: this.hotNext },
    ]);
    ctx.save();
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f0f0ec';
    ctx.fillText(this.helpText, MENU_W / 2, STRIP_Y + STRIP_H + 14);
    ctx.restore();
  }
}

// -------------------------------------------------------------- ForcePicker --
/** Short flavour text per team type, shown in the requisition screen's info
 * panel for the currently-selected pool row. */
export const TEAM_FLAVOR: Record<TeamType, string> = {
  rifle: 'The backbone of any infantry force. Riflemen hold ground stubbornly and provide steady, if unspectacular, fire. Cheap and reliable.',
  smg: 'Short-ranged but devastating up close. Assault squads clear buildings and trenches fast; keep them out of open ground under fire.',
  mg: 'A dug-in machine gun team pins whole squads in place. Slow to move, murderous when set up with a clear field of fire.',
  mortar: 'Indirect high-explosive support that reaches over walls and hills. Needs a spotter\'s eyes and time to range in on a target.',
  atgun: 'A towed anti-tank gun: deadly to armor from ambush, but exposed and slow to reposition once its position is known.',
  sniper: 'A single sharpshooter who picks off leaders and gunners from long range. Fragile — keep them concealed and patient.',
  atteam: 'A close-range anti-tank team armed with man-portable rockets. Effective from ambush; suicidal in the open against supported armor.',
  tank: 'A turreted main battle tank: mobile firepower and armor that can dominate open ground, but vulnerable to close-range ambush.',
  spg: 'A self-propelled gun on a tank chassis, without a rotating turret. Hard-hitting from a good firing line, clumsy when flanked.',
  halftrack: 'A lightly armored transport that moves infantry quickly and mounts a machine gun. Not built to trade fire with real armor.',
  command: 'Commanders provide leadership; command staffs add firepower and make nearby teams more effective. Anchor assaults and defenses.',
  engineer: 'Combat engineers carry satchel charges for clearing bunkers and fortified buildings, alongside their personal weapons.',
};

const ARMOR_TYPES: TeamType[] = ['tank', 'spg', 'halftrack'];

// Deterministic per-weapon "composition" colour, so each team's stripe hints
// at its loadout mix (rifles vs. automatic weapons vs. AT/HE) at a glance.
const COMPOSITION_PALETTE = ['#6b8a4a', '#c8892c', '#5a8fd0', '#c04030'];
function compositionColor(weaponId: string): string {
  let h = 0;
  for (let i = 0; i < weaponId.length; i++) h = (h * 31 + weaponId.charCodeAt(i)) >>> 0;
  return COMPOSITION_PALETTE[h % COMPOSITION_PALETTE.length];
}

/** A small 4-segment colour-coded "barcode" stripe hinting at a team's weapon
 * mix, drawn between the icon and the name/subtype text on force-pool/roster
 * rows (each segment ~3x14px, side by side). */
function drawCompositionStripe(ctx: CanvasRenderingContext2D, x: number, y: number, def: TeamDef): void {
  const ids = def.soldiers.map((s) => s.weaponId).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = ids[i] ? compositionColor(ids[i]) : 'rgba(255,255,255,0.08)';
    ctx.fillRect(x + i * 3, y, 2, 14);
  }
}

/** Scale factor that fits `icon` inside a `boxW`x`boxH` box, preserving
 * aspect ratio, never upscaling beyond native size (icons are drawn at 1x
 * or smaller so they never overlap adjacent rows). */
function iconFitScale(icon: HTMLCanvasElement, boxW: number, boxH: number): number {
  return Math.min(1, boxW / icon.width, boxH / icon.height);
}

const CATEGORY_LABEL: Record<TeamType, string> = {
  rifle: 'Rifle Infantry',
  smg: 'SMG Infantry',
  mg: 'Machine Gun Infantry',
  mortar: 'Medium Mortar',
  atgun: 'Antitank Gun',
  sniper: 'Sniper',
  atteam: 'Antitank Team',
  tank: 'Medium Tank',
  spg: 'Assault Gun',
  halftrack: 'Halftrack',
  command: 'Command Team',
  engineer: 'Engineers',
};

/** Category label for a team row, e.g. 'Rifle Infantry', 'Heavy Tank'. Tanks
 * are upgraded to 'Heavy Tank' when their vehicle's front armour is thick
 * (matches the original's Medium/Heavy naming split). */
function categoryLabel(def: TeamDef): string {
  if (def.type === 'tank') {
    const v = def.vehicleDefId ? VEHICLE_DEFS[def.vehicleDefId] : undefined;
    if (v && v.armor.front >= 90) return 'Heavy Tank';
  }
  return CATEGORY_LABEL[def.type] ?? def.type;
}

/** The requisition row's subtype line: a category label, plus — for
 * infantry-type teams only — the leader's and main support weapon's display
 * names in parentheses (e.g. 'Rifle Infantry (Kar98k, MG34)'). Vehicles show
 * just the category label; the hull variant is already the row's title. */
function subtypeLabel(def: TeamDef): string {
  const label = categoryLabel(def);
  if (def.vehicleDefId) return label;
  const ids = def.soldiers.map((s) => s.weaponId);
  const leaderName = WEAPONS[ids[0]]?.name ?? ids[0];
  const supportId = ids.slice(1).find((id) => id !== ids[0]);
  const supportName = supportId ? WEAPONS[supportId]?.name ?? supportId : undefined;
  const names = supportName ? `${leaderName}, ${supportName}` : leaderName;
  return `${label} (${names})`;
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/** The two-column "force pool / active roster" requisition widget shared by
 * the Battle-mode requisition step and the Operation screen's briefing step.
 * Draws/updates in MENU-local coordinates. */
export class ForcePicker {
  side: Side;
  year: number;
  points: number;
  rosterIds: string[];
  category: 'regular' | 'armor' = 'regular';
  /** When true, shows the "* unit is equipped for winter combat" note (the
   * original marked individual winter-pattern teams with an asterisk; our
   * data doesn't carry a per-team winter flag, so this shows the blanket
   * note on winter maps instead). */
  winterMap: boolean;

  private poolIds: string[] = [];
  private poolSelected = -1;
  private poolScroll = 0;
  private rosterSelected = -1;
  private rosterScroll = 0;

  private regularBtn: Rect = { x: 60, y: 96, w: 110, h: 22 };
  private armorBtn: Rect = { x: 178, y: 96, w: 110, h: 22 };
  private poolListRect: Rect = { x: 60, y: 128, w: 330, h: 220 };
  private infoRect: Rect = { x: 60, y: 368, w: 330, h: 96 };

  // five roster action buttons, matching the original's Refit/Rest/Rename/
  // Retire row (we add Details in place of Rename; only Retire is wired up)
  private refitBtn: Rect = { x: 440, y: 96, w: 62, h: 20 };
  private restBtn: Rect = { x: 506, y: 96, w: 62, h: 20 };
  private detailsBtn: Rect = { x: 572, y: 96, w: 62, h: 20 };
  private retireBtn: Rect = { x: 638, y: 96, w: 62, h: 20 };
  private revertBtn: Rect = { x: 704, y: 96, w: 62, h: 20 };
  private rosterListRect: Rect = { x: 440, y: 128, w: 330, h: 220 };
  private pointsRect: Rect = { x: 440, y: 368, w: 330, h: 34 };

  private readonly poolRowH = 27;
  private readonly rosterRowH = 27;
  private readonly maxRosterSlots = 15;

  constructor(side: Side, year: number, points: number, initialRosterIds: string[], winterMap = false) {
    this.side = side;
    this.year = year;
    this.points = points;
    this.rosterIds = [...initialRosterIds];
    this.winterMap = winterMap;
    this.refreshPool();
  }

  private refreshPool(): void {
    const armor = new Set(ARMOR_TYPES);
    this.poolIds = teamsForYear(this.side, this.year)
      .filter((d) => (this.category === 'armor' ? armor.has(d.type) : !armor.has(d.type)))
      .map((d) => d.id);
    this.poolSelected = -1;
    this.poolScroll = 0;
  }

  spent(): number {
    return this.rosterIds.reduce((sum, id) => sum + (TEAM_DEFS[id]?.cost ?? 0), 0);
  }

  remaining(): number {
    return this.points - this.spent();
  }

  update(input: InputState): void {
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (pointInRect(p, this.regularBtn) && this.category !== 'regular') {
        this.category = 'regular';
        this.refreshPool();
      } else if (pointInRect(p, this.armorBtn) && this.category !== 'armor') {
        this.category = 'armor';
        this.refreshPool();
      } else if (pointInRect(p, this.retireBtn) && this.rosterSelected >= 0) {
        this.rosterIds.splice(this.rosterSelected, 1);
        this.rosterSelected = -1;
      } else if (pointInRect(p, this.poolListRect)) {
        const row = this.poolScroll + Math.floor((p.y - this.poolListRect.y) / this.poolRowH);
        if (row >= 0 && row < this.poolIds.length) {
          this.poolSelected = row;
          const def = TEAM_DEFS[this.poolIds[row]];
          if (def && this.rosterIds.length < this.maxRosterSlots && this.remaining() >= def.cost) {
            this.rosterIds.push(def.id);
          }
        }
      } else if (pointInRect(p, this.rosterListRect)) {
        const row = this.rosterScroll + Math.floor((p.y - this.rosterListRect.y) / this.rosterRowH);
        if (row >= 0 && row < this.rosterIds.length) {
          if (row === this.rosterSelected) {
            this.rosterIds.splice(row, 1);
            this.rosterSelected = -1;
          } else {
            this.rosterSelected = row;
          }
        }
      }
    }
    if (pointInRect(input.mouse, this.poolListRect) && input.wheel !== 0) {
      const maxScroll = Math.max(0, this.poolIds.length - Math.floor(this.poolListRect.h / this.poolRowH));
      this.poolScroll = Math.max(0, Math.min(maxScroll, this.poolScroll + (input.wheel > 0 ? 1 : -1)));
    }
    if (pointInRect(input.mouse, this.rosterListRect) && input.wheel !== 0) {
      const maxScroll = Math.max(0, this.rosterIds.length - Math.floor(this.rosterListRect.h / this.rosterRowH));
      this.rosterScroll = Math.max(0, Math.min(maxScroll, this.rosterScroll + (input.wheel > 0 ? 1 : -1)));
    }
  }

  private drawTab(ctx: CanvasRenderingContext2D, r: Rect, label: string, active: boolean): void {
    ctx.save();
    if (active) {
      ctx.fillStyle = '#e8dcc8';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#170a06';
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.fillStyle = '#161208';
    } else {
      ctx.fillStyle = '#2a2a2a';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#0d0d0d';
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.fillStyle = '#f0f0ec';
    }
    ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + 10, r.y + r.h / 2);
    // small dropdown caret, right-padded
    ctx.textAlign = 'right';
    ctx.fillText('▾', r.x + r.w - 10, r.y + r.h / 2);
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawVerticalStencil(ctx, 'FORCE POOL', 30, 372);
    this.drawTab(ctx, this.regularBtn, 'Regular', this.category === 'regular');
    this.drawTab(ctx, this.armorBtn, 'Armor', this.category === 'armor');

    drawDarkPanel(ctx, this.poolListRect);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.poolListRect.x, this.poolListRect.y, this.poolListRect.w, this.poolListRect.h);
    ctx.clip();
    const visiblePool = Math.floor(this.poolListRect.h / this.poolRowH);
    for (let i = 0; i < visiblePool; i++) {
      const idx = this.poolScroll + i;
      if (idx >= this.poolIds.length) break;
      const def = TEAM_DEFS[this.poolIds[idx]];
      if (!def) continue;
      const ry = this.poolListRect.y + i * this.poolRowH;
      if (idx === this.poolSelected) {
        ctx.fillStyle = 'rgba(200,50,30,0.35)';
        ctx.fillRect(this.poolListRect.x, ry, this.poolListRect.w, this.poolRowH);
      }
      const icon = getTeamIcon(def.iconId);
      const iconScale = iconFitScale(icon, 36, 24);
      const iconW = icon.width * iconScale;
      const iconH = icon.height * iconScale;
      ctx.save();
      ctx.translate(this.poolListRect.x + 4, ry + (this.poolRowH - iconH) / 2);
      ctx.scale(iconScale, iconScale);
      ctx.drawImage(icon, 0, 0);
      ctx.restore();
      drawCompositionStripe(ctx, this.poolListRect.x + 4 + iconW + 3, ry + (this.poolRowH - 14) / 2, def);

      const textX = this.poolListRect.x + 4 + iconW + 3 + 16;
      const lowPoints = def.cost > this.remaining();
      const costText = String(def.cost);
      ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
      const costW = ctx.measureText(costText).width;
      let warnW = 0;
      if (lowPoints) {
        ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
        warnW = ctx.measureText('Low Points').width;
      }
      ctx.textAlign = 'right';
      ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#f0d840';
      ctx.fillText(costText, this.poolListRect.x + this.poolListRect.w - 6, ry + 11);
      if (lowPoints) {
        ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
        ctx.fillStyle = '#ff3b30';
        ctx.fillText('Low Points', this.poolListRect.x + this.poolListRect.w - 10 - costW, ry + 11);
      }
      ctx.textAlign = 'left';
      ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#f0f0ec';
      const name = truncateToWidth(ctx, def.name, this.poolListRect.w - (textX - this.poolListRect.x) - costW - warnW - 20);
      ctx.fillText(name, textX, ry + 11);
      ctx.font = 'bold italic 11px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#e8a33d';
      ctx.fillText(truncateToWidth(ctx, subtypeLabel(def), this.poolListRect.w - (textX - this.poolListRect.x) - 8), textX, ry + 23);
    }
    ctx.restore();

    drawDarkPanel(ctx, this.infoRect);
    const selDef = this.poolSelected >= 0 ? TEAM_DEFS[this.poolIds[this.poolSelected]] : null;
    if (selDef) {
      drawShadowText(ctx, selDef.name, this.infoRect.x + 10, this.infoRect.y + 18, 'bold 13px Arial, Helvetica, sans-serif', '#f0d840');
      const lines = wordWrapCtx(ctx, TEAM_FLAVOR[selDef.type] ?? '', this.infoRect.w - 20, '11px Arial, Helvetica, sans-serif');
      ctx.font = '11px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e8e8e0';
      let ty = this.infoRect.y + 36;
      for (const line of lines.slice(0, 4)) {
        ctx.fillText(line, this.infoRect.x + 10, ty);
        ty += 14;
      }
    } else {
      ctx.font = '11px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#a89890';
      ctx.textAlign = 'left';
      ctx.fillText('Select a unit from the force pool to see its description.', this.infoRect.x + 10, this.infoRect.y + 20);
    }

    if (this.winterMap) {
      ctx.font = 'italic 10px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#e0c04a';
      ctx.textAlign = 'left';
      ctx.fillText('* unit is equipped for winter combat', this.poolListRect.x, this.poolListRect.y + this.poolListRect.h + 12);
    }

    drawVerticalStencil(ctx, 'ACTIVE ROSTER', 792, 372);
    drawSmallMetalButton(ctx, this.refitBtn, 'Refit', { disabled: true });
    drawSmallMetalButton(ctx, this.restBtn, 'Rest', { disabled: true });
    drawSmallMetalButton(ctx, this.detailsBtn, 'Details', { disabled: true });
    drawSmallMetalButton(ctx, this.retireBtn, 'Retire', { disabled: this.rosterSelected < 0 });
    drawSmallMetalButton(ctx, this.revertBtn, 'Revert', { disabled: true });

    drawDarkPanel(ctx, this.rosterListRect);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.rosterListRect.x, this.rosterListRect.y, this.rosterListRect.w, this.rosterListRect.h);
    ctx.clip();
    const visibleRoster = Math.floor(this.rosterListRect.h / this.rosterRowH);
    for (let i = 0; i < visibleRoster; i++) {
      const idx = this.rosterScroll + i;
      const ry = this.rosterListRect.y + i * this.rosterRowH;
      if (idx >= this.rosterIds.length) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(this.rosterListRect.x, ry, this.rosterListRect.w, this.rosterRowH - 1);
        continue;
      }
      const def = TEAM_DEFS[this.rosterIds[idx]];
      if (!def) continue;
      if (idx === this.rosterSelected) {
        ctx.fillStyle = 'rgba(200,50,30,0.35)';
        ctx.fillRect(this.rosterListRect.x, ry, this.rosterListRect.w, this.rosterRowH);
      }
      const icon = getTeamIcon(def.iconId);
      const iconScale = iconFitScale(icon, 36, 24);
      const iconW = icon.width * iconScale;
      const iconH = icon.height * iconScale;
      ctx.save();
      ctx.translate(this.rosterListRect.x + 4, ry + (this.rosterRowH - iconH) / 2);
      ctx.scale(iconScale, iconScale);
      ctx.drawImage(icon, 0, 0);
      ctx.restore();
      drawCompositionStripe(ctx, this.rosterListRect.x + 4 + iconW + 3, ry + (this.rosterRowH - 14) / 2, def);
      const textX = this.rosterListRect.x + 4 + iconW + 3 + 16;
      ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f0f0ec';
      ctx.fillText(truncateToWidth(ctx, def.name, this.rosterListRect.w - (textX - this.rosterListRect.x) - 90), textX, ry + 11);
      // small green soldier squares, one per soldier in the squad
      const sqSize = 6;
      let sx = this.rosterListRect.x + this.rosterListRect.w - 6 - Math.min(def.soldiers.length, 10) * (sqSize + 2);
      ctx.fillStyle = '#3fbf3f';
      for (let s = 0; s < Math.min(def.soldiers.length, 10); s++) {
        ctx.fillRect(sx, ry + 4, sqSize, sqSize);
        sx += sqSize + 2;
      }
      ctx.font = 'bold italic 11px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#e8a33d';
      ctx.fillText(truncateToWidth(ctx, subtypeLabel(def), this.rosterListRect.w - (textX - this.rosterListRect.x) - 8), textX, ry + 23);
    }
    ctx.restore();

    drawDarkPanel(ctx, this.pointsRect);
    ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f0f0ec';
    ctx.fillText('Requisition Points Remaining', this.pointsRect.x + 10, this.pointsRect.y + this.pointsRect.h / 2);
    const boxW = 56;
    const boxRect: Rect = { x: this.pointsRect.x + this.pointsRect.w - boxW - 8, y: this.pointsRect.y + 6, w: boxW, h: this.pointsRect.h - 12 };
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(boxRect.x, boxRect.y, boxRect.w, boxRect.h);
    ctx.strokeStyle = 'rgba(210,210,205,0.35)';
    ctx.strokeRect(boxRect.x + 0.5, boxRect.y + 0.5, boxRect.w - 1, boxRect.h - 1);
    ctx.textAlign = 'center';
    ctx.fillStyle = this.remaining() < 0 ? '#d02020' : '#f0d840';
    ctx.fillText(String(this.remaining()), boxRect.x + boxRect.w / 2, boxRect.y + boxRect.h / 2);
    ctx.textBaseline = 'alphabetic';
  }
}

function wordWrapCtx(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: string): string[] {
  ctx.save();
  ctx.font = font;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (cur && ctx.measureText(test).width > maxWidth) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  ctx.restore();
  return lines;
}
