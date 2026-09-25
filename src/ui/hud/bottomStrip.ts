// ============================================================================
// bottomStrip.ts — the bottom 29px band (y 739..768). Layout measured from
// refs11/12 (logical 1024x768): Options 2..26 (the original's Chat button above
// it is left out — there is no chat in single player), zoom + circle ~36.5 r8,
// striped Map 46..76, zoom - ~86; then the selected-team block: squad
// graphic 96..130 (team art ~34x22 centred), bevelled empty box 134..148,
// order-arrow cell 150..161, 2x3 soldier matrix 164..186, green name bar
// 150..194 over a plain status line, soldier cells 200..222 (two rows +
// white cursor under the watched soldier), ammo block 215..325 (labels
// Anti-Pers:/Anti-Tank: at 219, marks 250.7..280.5 first two square then dashes,
// amber digits 252/265/277/289/301/313 on the middle row), grenade glyph
// 291..300, Truce/Flee 297.6..323.7 (739..753 / 754..768). No right-hand hotkey
// palette exists in the originals.
// ============================================================================
import type { Rect, InputState, BattleState, Team, Soldier, Vec2 } from '@/shared/types';
import { HUD } from '@/render/palette';
import { getTeamIcon } from '@/render/sprites';
import { WEAPONS } from '@/data/weapons';
import { drawHudBevel, drawHudButton, setHudFont, clipTextToWidth, fitHudText, teamStatusLabel, teamDisplayName, teamStatusTextColor, tintedTeamIcon } from './hudChrome';

export type BottomStripAction = 'options' | 'zoomIn' | 'zoomOut' | 'map' | 'truce' | 'flee' | 'begin' | 'auto';

const OPTIONS_R: Rect = { x: 2, y: 747, w: 24, h: 14 };
const ZOOM_IN_C = { x: 36.5, y: 751, r: 8 };
const MAP_R: Rect = { x: 46, y: 740, w: 30, h: 28 };
const ZOOM_OUT_C = { x: 86, y: 751, r: 8 };

const SQUAD_ICON_R: Rect = { x: 96, y: 740, w: 34, h: 28 };
const NARROW_1_R: Rect = { x: 134, y: 740, w: 14, h: 28 };
const NARROW_2_R: Rect = { x: 150, y: 742, w: 11, h: 24 };
const MATRIX_R: Rect = { x: 164, y: 740, w: 22, h: 28 };
const NAME_BAR_R: Rect = { x: 150, y: 741, w: 44, h: 7 };
const STATUS_Y = 753;
const CELLS_X0 = 200;
const CELLS_Y0 = 741;
const CELL_W = 4.4;
const CELL_H = 7;
const CELL_GAP_X = 0.4;
const CELL_GAP_Y = 7;
const AMMO_R: Rect = { x: 215, y: 739, w: 110, h: 29 };
/** Log-scale marks (2/4/8/16/32/64): first two squares, rest dashes; digits at
 * refs11-measured columns 252/265/277/289/301/313 on the middle row. */
const AMMO_MARKS = [2, 4, 8, 16, 32, 64] as const;
const AMMO_MARK_X = [250.7, 256, 261.3, 266.6, 272, 277.3] as const;
const AMMO_DIGIT_X = [250.5, 261.6, 271.6, 282.5, 294.5, 306.5] as const;
const RIGHT_BTN_1: Rect = { x: 297.6, y: 739, w: 26.1, h: 14 };
const RIGHT_BTN_2: Rect = { x: 297.6, y: 754, w: 26.1, h: 14 };
const GRENADE_R: Rect = { x: 291, y: 755, w: 9, h: 10 };


function circleHit(p: Vec2, c: { x: number; y: number; r: number }): boolean {
  return (p.x - c.x) ** 2 + (p.y - c.y) ** 2 <= c.r * c.r;
}

/** The original's light zoom circles with dark glyphs. */
function drawCircleButton(ctx: CanvasRenderingContext2D, c: { x: number; y: number; r: number }, label: string, hot: boolean): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fillStyle = hot ? '#c8b898' : '#d0c0a8';
  ctx.fill();
  ctx.strokeStyle = HUD.bevelDark;
  ctx.lineWidth = 1;
  ctx.stroke();
  setHudFont(ctx, 'micro');
  ctx.fillStyle = '#3b1410';
  ctx.textAlign = 'center';
  ctx.fillText(label, c.x, c.y - 4);
  ctx.textAlign = 'left';
}

/** The original's Map button face (refs11): a raised bevelled button with the
 * label centred — no stripes. */
function drawMapButton(ctx: CanvasRenderingContext2D, r: Rect, hot: boolean): void {
  drawHudButton(ctx, r, 'Map', { hot, fontKind: 'small' });
}

function aliveSoldiers(state: BattleState, team: Team): Soldier[] {
  return team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
}

const AT_WEAPON_CLASSES = new Set(['atgun', 'atrocket', 'atrifle', 'tankgun']);

/** Total ready rounds of the given class for the team (vehicle main gun / coax
 * for vehicles). */
function ammoCount(state: BattleState, team: Team, kind: 'ap' | 'at'): number {
  const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
  if (vehicle) {
    if (kind === 'at') return vehicle.mainAmmo;
    return vehicle.coaxAmmo;
  }
  let total = 0;
  for (const s of aliveSoldiers(state, team)) {
    const w = WEAPONS[s.weaponId];
    const isAt = w && AT_WEAPON_CLASSES.has(w.cls);
    if (kind === 'at' ? isAt : !isAt) total += s.ammo + s.ammoReserve;
  }
  return total;
}

/** Squad graphic box: team-type icon art when a team is selected. */
function drawSquadBox(ctx: CanvasRenderingContext2D, team: Team | null): void {
  drawHudBevel(ctx, SQUAD_ICON_R, true, HUD.black);
  if (!team) return;
  const icon = tintedTeamIcon(getTeamIcon(team.type), team.type);
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(SQUAD_ICON_R.x + 1, SQUAD_ICON_R.y + 1, SQUAD_ICON_R.w - 2, SQUAD_ICON_R.h - 2);
  ctx.clip();
  const iw = Math.min(SQUAD_ICON_R.w - 2, icon.width);
  const ih = Math.min(SQUAD_ICON_R.h - 2, icon.height);
  ctx.drawImage(icon, Math.round(SQUAD_ICON_R.x + (SQUAD_ICON_R.w - iw) / 2), Math.round(SQUAD_ICON_R.y + (SQUAD_ICON_R.h - ih) / 2), iw, ih);
  ctx.restore();
}

/** The narrow order boxes: box 1 stays empty; box 2 carries the magenta order
 * arrow at its bottom (pointing by the order heading, west when idle). */
function drawOrderBox(ctx: CanvasRenderingContext2D, team: Team | null, heading: number): void {
  drawHudBevel(ctx, NARROW_1_R, true, HUD.black);
  drawHudBevel(ctx, NARROW_2_R, true, HUD.black);
  if (!team) return;
  ctx.fillStyle = '#101030';
  ctx.fillRect(NARROW_2_R.x + 1, NARROW_2_R.y + 1, NARROW_2_R.w - 2, NARROW_2_R.h - 2);
  const cx = NARROW_2_R.x + NARROW_2_R.w / 2, cy = NARROW_2_R.y + 16;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(heading);
  ctx.fillStyle = '#e040c0';
  ctx.beginPath();
  ctx.moveTo(3.5, 0);
  ctx.lineTo(-2.5, -3);
  ctx.lineTo(-1, 0);
  ctx.lineTo(-2.5, 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 2x4 soldier matrix (8 cells, refs11/12/13): dark cells with the watched
 * soldier's cell in magenta. */
function drawMatrix(ctx: CanvasRenderingContext2D, soldierCount: number, watchedIdx: number): void {
  drawHudBevel(ctx, MATRIX_R, true, HUD.black);
  if (soldierCount <= 0) return;
  const cw = (MATRIX_R.w - 2) / 2, ch = (MATRIX_R.h - 2) / 4;
  for (let i = 0; i < 8; i++) {
    if (i >= soldierCount) break;
    const col = i % 2, row = Math.floor(i / 2);
    ctx.fillStyle = i === watchedIdx ? '#c030c0' : '#180a08';
    ctx.fillRect(MATRIX_R.x + 1 + col * cw, MATRIX_R.y + 1 + row * ch, cw - 0.5, ch - 0.5);
  }
  ctx.strokeStyle = 'rgba(180,120,110,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MATRIX_R.x + 1 + cw + 0.5, MATRIX_R.y + 1);
  ctx.lineTo(MATRIX_R.x + 1 + cw + 0.5, MATRIX_R.y + MATRIX_R.h - 1);
  for (let r = 1; r < 4; r++) {
    ctx.moveTo(MATRIX_R.x + 1, MATRIX_R.y + 1 + r * ch + 0.5);
    ctx.lineTo(MATRIX_R.x + MATRIX_R.w - 1, MATRIX_R.y + 1 + r * ch + 0.5);
  }
  ctx.stroke();
}

function drawNameStatusBars(ctx: CanvasRenderingContext2D, team: Team | null): void {
  const r = NAME_BAR_R;
  if (team) {
    ctx.fillStyle = '#38c838';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    setHudFont(ctx, 'mini');
    ctx.fillStyle = '#082808';
    ctx.fillText(clipTextToWidth(ctx, teamDisplayName(team.name), r.w - 2), r.x + 1, r.y + 1);
  } else {
    drawHudBevel(ctx, r, true, HUD.black);
  }
  if (team) {
    setHudFont(ctx, 'tiny');
    const fit = fitHudText(ctx, [teamStatusLabel(team.status)], r.w, 2);
    ctx.font = fit.font;
    ctx.fillStyle = teamStatusTextColor(team.status);
    ctx.fillText(fit.text, r.x, STATUS_Y);
  } else {
    drawHudBevel(ctx, { x: r.x, y: r.y + 12, w: r.w, h: 7 }, true, HUD.black);
  }
}

function healthColor(s: Soldier): string {
  if (s.health === 'dead') return '#3a1a16';
  if (s.health === 'incapacitated') return HUD.red;
  if (s.health === 'wounded') return HUD.yellow;
  return HUD.green;
}

/** Two rows of soldier cells (green with a dark bust when alive, red X when
 * dead). White cursor under the watched soldier's cell. */
function drawSoldierCells(ctx: CanvasRenderingContext2D, soldiers: Soldier[], watchedIdx: number): void {
  for (let i = 0; i < Math.min(10, soldiers.length); i++) {
    const col = i % 5, row = Math.floor(i / 5);
    const x = CELLS_X0 + col * (CELL_W + CELL_GAP_X);
    const y = CELLS_Y0 + row * (CELL_H + CELL_GAP_Y);
    const alive = soldiers[i].health !== 'dead' && soldiers[i].health !== 'incapacitated';
    ctx.fillStyle = alive ? healthColor(soldiers[i]) : '#181008';
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1);
    if (alive) {
      ctx.fillStyle = '#1a0e08';
      ctx.fillRect(x + 1.5, y + 1, 2.5, 2);
      ctx.fillRect(x + 0.8, y + 3, 4, 2);
    } else if (soldiers[i].health === 'dead') {
      ctx.strokeStyle = '#c04040';
      ctx.beginPath();
      ctx.moveTo(x + 1.5, y + 1.5);
      ctx.lineTo(x + CELL_W - 1.5, y + CELL_H - 1.5);
      ctx.moveTo(x + CELL_W - 1.5, y + 1.5);
      ctx.lineTo(x + 1.5, y + CELL_H - 1.5);
      ctx.stroke();
    }
  }
  if (watchedIdx >= 0 && watchedIdx < Math.min(10, soldiers.length)) {
    const col = watchedIdx % 5, row = Math.floor(watchedIdx / 5);
    const x = CELLS_X0 + col * (CELL_W + CELL_GAP_X);
    const y = CELLS_Y0 + row * (CELL_H + CELL_GAP_Y) + CELL_H + 2;
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(x, y, CELL_W, 2);
  }
}

/** One log-scale ammo marker row (AP above the scale digits, AT below). The
 * first two slots square, the rest dashes (refs11); slot i lights up while the
 * team holds at least i+1 rounds and keeps its fixed colour (slots 1-2 the
 * palette's first colour, 3-6 the second). Zero rounds draws nothing. */
function drawAmmoMarkers(ctx: CanvasRenderingContext2D, y: number, count: number, palette: [string, string], squareH: number, dashH: number): void {
  for (let i = 0; i < AMMO_MARKS.length; i++) {
    const x = AMMO_MARK_X[i];
    const square = i < 2;
    if (count < i + 1) continue;
    ctx.fillStyle = square ? palette[0] : palette[1];
    // refs11 column profiles: squares ~3.2 wide, dashes ~2.6; both bottom-aligned
    // to the row base (the AT row's shapes sit ~3 shorter than the AP's).
    const w = square ? 3.2 : 2.6;
    ctx.fillRect(x, square ? y : y + squareH - dashH, w, square ? squareH : dashH);
  }
}

function drawAmmoBlock(ctx: CanvasRenderingContext2D, countAp: number, countAt: number, selected: boolean): void {
  drawHudBevel(ctx, AMMO_R, true, HUD.black);
  ctx.fillStyle = HUD.text;
  setHudFont(ctx, 'mini');
  ctx.fillText('Anti-Pers:', 228, AMMO_R.y + 12);
  ctx.fillText('Anti-Tank:', 228, AMMO_R.y + 24);
  ctx.fillStyle = '#c8a060';
  for (let i = 0; i < AMMO_MARKS.length; i++) {
    ctx.fillText(String(AMMO_MARKS[i]), AMMO_DIGIT_X[i], AMMO_R.y + 17.5);
  }
  if (selected) {
    // refs11/12: AP reads green while held / yellow once short; AT yellow / red.
    drawAmmoMarkers(ctx, AMMO_R.y + 6, countAp, ['#40c040', '#d0c020'], 5.5, 3);
    drawAmmoMarkers(ctx, AMMO_R.y + 18.5, countAt, ['#d0c020', '#c03018'], 3, 2);
  }
}

/** Little grenade glyph beside the ammo block (decorative, selected only). */
function drawGrenade(ctx: CanvasRenderingContext2D, selected: boolean): void {
  if (!selected) return;
  const r = GRENADE_R;
  ctx.fillStyle = '#c8b020';
  ctx.beginPath();
  ctx.ellipse(r.x + 3.5, r.y + 5.5, 3, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#807020';
  ctx.fillRect(r.x + 3, r.y + 1, 1.4, 3);
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
    const inRect = (pt: Vec2, r: Rect) => pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h;
    if (inRect(p, OPTIONS_R)) this.hover.add('options');
    if (inRect(p, MAP_R)) this.hover.add('map');
    if (circleHit(p, ZOOM_IN_C)) this.hover.add('zoomIn');
    if (circleHit(p, ZOOM_OUT_C)) this.hover.add('zoomOut');
    if (inRect(p, RIGHT_BTN_1)) this.hover.add('btn1');
    if (inRect(p, RIGHT_BTN_2)) this.hover.add('btn2');

    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const cp = { x: c.x, y: c.y };
      if (inRect(cp, OPTIONS_R)) return 'options';
      if (inRect(cp, MAP_R)) return 'map';
      if (circleHit(cp, ZOOM_IN_C)) return 'zoomIn';
      if (circleHit(cp, ZOOM_OUT_C)) return 'zoomOut';
      if (inRect(cp, RIGHT_BTN_1)) return this.mode === 'battle' ? 'truce' : 'begin';
      if (inRect(cp, RIGHT_BTN_2)) return this.mode === 'battle' ? 'flee' : 'auto';
    }
    return null;
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState, selectedTeam: Team | null, watchedSoldierId: number | null): void {
    drawHudButton(ctx, OPTIONS_R, 'Options', { hot: this.hover.has('options'), fontKind: 'micro' });
    drawCircleButton(ctx, ZOOM_IN_C, '+', this.hover.has('zoomIn'));
    drawMapButton(ctx, MAP_R, this.hover.has('map'));
    drawCircleButton(ctx, ZOOM_OUT_C, String.fromCharCode(0x2212), this.hover.has('zoomOut'));

    const soldiers = selectedTeam ? aliveSoldiers(state, selectedTeam) : [];
    const teamSoldiersIncDead = selectedTeam
      ? selectedTeam.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s)
      : [];
    const watchedIdx = selectedTeam && watchedSoldierId != null
      ? teamSoldiersIncDead.findIndex((s) => s.id === watchedSoldierId)
      : -1;
    // Order heading: the current move order's target bearing; idle teams point west.
    let heading = Math.PI;
    if (selectedTeam) {
      const order = selectedTeam.order;
      if (order && 'target' in order) heading = Math.atan2(order.target.y - selectedTeam.pos.y, order.target.x - selectedTeam.pos.x);
    }

    drawSquadBox(ctx, selectedTeam);
    drawOrderBox(ctx, selectedTeam, heading);
    drawMatrix(ctx, soldiers.length, watchedIdx);
    drawNameStatusBars(ctx, selectedTeam);
    drawSoldierCells(ctx, teamSoldiersIncDead, watchedIdx);
    drawAmmoBlock(ctx, selectedTeam ? ammoCount(state, selectedTeam, 'ap') : 0, selectedTeam ? ammoCount(state, selectedTeam, 'at') : 0, !!selectedTeam);
    drawGrenade(ctx, !!selectedTeam);

    if (this.mode === 'battle') {
      drawHudButton(ctx, RIGHT_BTN_1, 'Truce', { hot: this.hover.has('btn1'), fontKind: 'micro' });
      if (this.fleeArmed) {
        drawHudBevel(ctx, RIGHT_BTN_2, true, HUD.red);
        setHudFont(ctx, 'micro');
        ctx.fillStyle = HUD.text;
        ctx.textAlign = 'center';
        ctx.fillText('Flee', Math.round(RIGHT_BTN_2.x + RIGHT_BTN_2.w / 2), Math.round(RIGHT_BTN_2.y + (RIGHT_BTN_2.h - 8) / 2));
        ctx.textAlign = 'left';
      } else {
        drawHudButton(ctx, RIGHT_BTN_2, 'Flee', { hot: this.hover.has('btn2'), fontKind: 'micro' });
      }
    } else {
      drawHudButton(ctx, RIGHT_BTN_1, 'Begin', { hot: this.hover.has('btn1'), fontKind: 'micro' });
      drawHudButton(ctx, RIGHT_BTN_2, 'Auto', { hot: this.hover.has('btn2'), fontKind: 'micro' });
    }
    // refs11 draws the scale digits last so they stay readable over the button block
    if (selectedTeam) {
      setHudFont(ctx, 'micro');
      ctx.fillStyle = '#c8a060';
      for (let i = 0; i < AMMO_MARKS.length; i++) {
        ctx.fillText(String(AMMO_MARKS[i]), AMMO_DIGIT_X[i], AMMO_R.y + 17.5);
      }
    }
  }
}
