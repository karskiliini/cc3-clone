// ============================================================================
// soldierMonitor.ts — the "soldier monitor" popup that floats over the
// bottom-right of the MAP VIEWPORT (not the bottom panel) whenever a team is
// selected: one 2-line row per soldier (surname/role/health, activity/weapon/
// rounds), a header tab row for vehicle teams, and a left scroll arrow.
// ============================================================================
import type { Rect, BattleState, Team, Soldier, Vehicle, InputState, WeaponClass, RoundType } from '@/shared/types';
import { PANEL_Y } from '@/shared/types';
import { clamp } from '@/shared/math';
import { HUD } from '@/render/palette';
import { WEAPONS } from '@/data/weapons';
import { crewTaskWord, CREW_TASK_WORDS } from '@/sim/crewWeapon';
import { isDazed } from '@/sim/daze';
import { AIM_WORD, AIM_WORDS, ROUND_LABEL, soldierRounds, vehicleRounds } from '@/sim/aimPoint';
import { DAMAGE_WORDS, ROLE_WORD, crewRoleOf, vehicleDamageView } from '@/sim/vehicleDamage';
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
const WIDTH = 192;
const ROW_H = 30;
const MAX_ROWS = 6;
const CELL_H = 14;
const HEADER_H = 14;
const ARROW_W = 9;
const NAME_W = 59;
const ROLE_W = 41;
const RDS_CELL_W = 24;

/** Inner text widths (cell width minus the 3 px padding each side) of the monitor's columns in
 * the narrowest layout (with the scroll arrow), plus their fonts — used by tests to prove no
 * role/status/activity word overflows. */
export const MONITOR_TEXT_CELLS = {
  role: { maxW: ROLE_W - 6, font: 'micro' as const },
  activity: { maxW: NAME_W - 6, font: 'micro' as const },
  status: { maxW: WIDTH - 2 - (ARROW_W + NAME_W + 1 + ROLE_W + 1) - 6, font: 'micro' as const },
};
/** "Loading AP 60%": the round going into the breech and how far the loader has got (steps of 10%). */
export function loadingWord(round: RoundType, progress: number): string {
  return `Loading ${ROUND_LABEL[round]} ${Math.min(100, Math.max(0, Math.floor(progress * 10 + 1e-6) * 10))}%`;
}
/** "Aiming 60%": the gunner's lay on the centre of the target (an aimed spot reads "Aiming: tracks"). */
export function layingWord(progress: number): string {
  return `Aiming ${Math.min(100, Math.max(0, Math.floor(progress * 10 + 1e-6) * 10))}%`;
}
const PCT_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
/** Every word the main-gun phases can put in the activity column (feeds the width-fit test). */
export const MONITOR_GUN_WORDS: string[] = [
  ...(Object.keys(ROUND_LABEL) as RoundType[]).flatMap((r) => PCT_STEPS.map((p) => loadingWord(r, p))),
  ...PCT_STEPS.map((p) => layingWord(p)),
];

/** Every word the role and status/activity columns can show. */
export const MONITOR_ROLE_WORDS = ['Leader', 'Gunner', 'Assist', 'Assist. Ldr.', 'Loader', 'Driver', 'Commander', 'Soldat', 'Radioman', 'Crew'];
export const MONITOR_STATUS_WORDS = ['Healthy', 'Slightly injured', 'Incap.', 'Dead', 'Pinned', 'Cowering', 'Panicked', 'Broken', 'Berserk', 'Dazed'];
export const MONITOR_ACTIVITY_WORDS = ['Dead', 'Unconscious', 'Wary', 'Shaken', 'Driving', 'Moving', 'Running', 'Crawling', 'Firing', 'Reloading', 'Loading', 'Assisting', 'Defending', 'Ambushing', 'Hiding', 'Fleeing', 'Charging', 'Surrendered', 'Waiting', 'Changing seat', 'Bailing out', 'Mounting', 'Mounted', 'Dismounting', ...CREW_TASK_WORDS, ...AIM_WORDS, ...MONITOR_GUN_WORDS];
/** Damaged-system words of the vehicle header (two per line). */
export const MONITOR_DAMAGE_WORDS = DAMAGE_WORDS;
export const MONITOR_DAMAGE_CELL = { maxW: Math.floor((WIDTH - 12) / 2) - 4, font: 'micro' as const };

const GUNNER_WEAPON_CLASSES = new Set<WeaponClass>(['lmg', 'hmg', 'mortar', 'atgun', 'atrocket']);

function role(vehicle: Vehicle | undefined, soldiers: Soldier[], index: number, s: Soldier, state?: BattleState): string {
  if (vehicle && state) {
    // the seat he holds now (crew swap seats when men fall: sim/vehicleDamage.ts)
    const r = s.vehicleId === vehicle.id ? crewRoleOf(state, vehicle, s.id) : null;
    if (r) return ROLE_WORD[r];
    if (s.health !== 'dead' && s.health !== 'incapacitated') return 'Crew';
  }
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
  // on a hatch, half out of (or into) the vehicle (spec 2026-09-17 §10)
  if (s.hatch) return s.hatch.kind === 'mount' ? 'Mounting' : s.hatch.passenger && !s.hatch.panicked ? 'Dismounting' : 'Bailing out';
  if (s.seat === 'passenger' && s.vehicleId != null) return 'Mounted';
  // spec §7: show the mental-state word for wary/shaken, which have no dedicated Activity of their
  // own (calm/alert are unremarkable and keep the normal activity word).
  // a man working a crew-served weapon shows his task (spec 2026-09-17 §6)
  const task = crewTaskWord(s);
  if (task) {
    // the layer of a gun shows what he is laying on ("Aiming: tracks")
    const aim = s.crewTask?.id === 'lay' ? team?.crewWeapon?.mission?.aimPoint : undefined;
    return aim && aim !== 'mass' ? `Aiming: ${AIM_WORD[aim]}` : task;
  }
  if (vehicle && vehicle.seatSwap?.soldierId === s.id) return 'Changing seat';
  // main gun phases (sim/gunTiming.ts): the loader's row shows "Loading AP 60%", the gunner's what he
  // is laying on ("Aiming: tracks") or how far his lay has got ("Aiming 60%")
  if (vehicle && vehicle.gunState) {
    const seats = vehicle.seats;
    const isGunner = seats?.gunner === s.id;
    const laying = isGunner && !!vehicle.gunLay && (vehicle.layProgress ?? 1) < 1;
    const loads = seats?.loader === s.id || (isGunner && !!seats && seats.loader == null && !laying);
    if (loads && vehicle.gunState === 'loading' && vehicle.loadedRound) return loadingWord(vehicle.loadedRound, vehicle.loadProgress ?? 0);
    if (laying) return vehicle.aimPoint && vehicle.aimPoint !== 'mass' ? `Aiming: ${AIM_WORD[vehicle.aimPoint]}` : layingWord(vehicle.layProgress ?? 0);
  }
  if (s.mind.state === 'wary') return 'Wary';
  if (s.mind.state === 'shaken') return 'Shaken';
  switch (s.activity) {
    case 'moving': return vehicle && roleName === 'Driver' ? 'Driving' : s.mind.downAt != null ? 'Crawling' : 'Moving';
    case 'movingFast': return s.mind.downAt != null ? 'Crawling' : 'Running';
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
function statusCell(s: Soldier, time: number): { word: string; color: string } {
  if (s.health === 'dead' || s.health === 'incapacitated') return { word: healthWord(s), color: HUD.red };
  // knocked down / dazed by a blast (sim/daze.ts): out of it whatever his nerves say
  if (isDazed(s, time) || (s.stunnedUntil != null && time < s.stunnedUntil)) return { word: 'Dazed', color: HUD.yellow };
  switch (s.mind.state) {
    case 'pinned': return { word: 'Pinned', color: HUD.yellow };
    case 'cowering': return { word: 'Cowering', color: HUD.yellow };
    case 'panicked': return { word: 'Panicked', color: HUD.red };
    case 'broken': return { word: 'Broken', color: HUD.red };
    case 'berserk': return { word: 'Berserk', color: HUD.magenta };
    default: return { word: healthWord(s), color: healthColor(s) };
  }
}

export const MONITOR_ABBREV: Record<string, string[]> = {
  Cowering: ['Cower'],
  Panicked: ['Panic'],
  Ambushing: ['Ambush.'],
  Reloading: ['Reload'],
  Defending: ['Defend'],
  Charging: ['Charge'],
  Crawling: ['Crawl'],
  Mounting: ['Mount'],
  Dismounting: ['Dismt.'],
  'Bailing out': ['Bail'],
  'Assisting': ['Assist'],
  'Slightly injured': ['Injured', 'Injur.'],
  Commander: ['Cmdr.'],
  'Assist. Ldr.': ['Asst. Ldr.', 'A. Ldr.'],
  Radioman: ['Radio'],
  Unconscious: ['Uncons.'],
  Unhooking: ['Unhook'],
  'Digging in': ['Dig in'],
  'Closing trail': ['Trail'],
  'Hooking up': ['Hook up'],
  'Lifting spade': ['Spade'],
  Baseplate: ['Base'],
  'Mounting tube': ['Tube'],
  'Setting bipod': ['Bipod'],
  'Packing up': ['Pack'],
  'Mounting gun': ['Gun'],
  'Feeding belt': ['Belt'],
  'Dropping round': ['Drop'],
  Unloading: ['Unload'],
  'Aim: turret ring': ['Aim: ring', 'ring'],
  'Aim: lower hull': ['Aim: hull', 'hull'],
  'Aim: drv. plate': ['Aim: drv.', 'drv.'],
  'Aim: mantlet': ['mantlet'],
  'Aim: tracks': ['tracks'],
  'Aim: engine': ['engine'],
  'Aim: centre': ['centre'],
  'Main gun damaged': ['MGun damaged', 'MGun dmg.'],
  'Main gun destroyed': ['MGun destroyed', 'MGun gone'],
  'Coax MG damaged': ['Coax damaged', 'Coax dmg.'],
  'Coax MG destroyed': ['Coax destroyed', 'Coax gone'],
  'Bow MG damaged': ['Bow damaged', 'Bow dmg.'],
  'Bow MG destroyed': ['Bow destroyed', 'Bow gone'],
  'Sight damaged': ['Sight damaged', 'Sight dmg.'],
  'Sight destroyed': ['Sight destroyed', 'Sight gone'],
  'Traverse jammed': ['Trav. jammed'],
  'Engine damaged': ['Engine damaged', 'Eng. damaged', 'Eng dmgd'],
  'Engine destroyed': ['Engine destroyed', 'Eng. gone'],
  'Gearbox damaged': ['Gearbox damaged', 'Gbox dmg.'],
  'Gearbox destroyed': ['Gearbox destroyed', 'Gbox gone'],
  'Radio damaged': ['Radio damaged', 'Radio dmg.'],
  'Radio destroyed': ['Radio destroyed', 'Radio gone'],
  'Fuel leak': ['Fuel leak', 'Leak'],
  Surrendered: ['Surr.'],
  'Aiming: turret ring': ['Aim: turret ring', 'Aim: ring', 'ring'],
  'Aiming: lower hull': ['Aim: lower hull', 'Aim: hull', 'hull'],
  'Aiming: driver plate': ['Aim: drv. plate', 'Aim: driver', 'drv.'],
  'Aiming: mantlet': ['Aim: mantlet', 'mantlet'],
  'Aiming: tracks': ['Aim: tracks', 'tracks'],
  'Aiming: engine': ['Aim: engine', 'engine'],
  'Aiming: centre': ['Aim: centre', 'centre'],
  'Aiming: side': ['Aim: side', 'side'],
  'Aiming: rear': ['Aim: rear', 'rear'],
  'Changing seat': ['Chg. seat'],
  // "Loading APCR 100%" -> "Load APCR 100%" -> "APCR 100%"
  ...Object.fromEntries(MONITOR_GUN_WORDS.filter((w) => w.startsWith('Loading ')).map((w) => [w, [w.replace('Loading ', 'Load '), w.replace('Loading ', '')]])),
  ...Object.fromEntries(MONITOR_GUN_WORDS.filter((w) => w.startsWith('Aiming ')).map((w) => [w, [w.replace('Aiming ', 'Aim ')]])),
  'Right track damaged': ['R. track damaged', 'R. track dmg.'],
  'Left track damaged': ['L. track damaged', 'L. track dmg.'],
  'Right track broken': ['R. track broken', 'R. track brk.'],
  'Left track broken': ['L. track broken', 'L. track brk.'],
};

/** Short weapon names for the line-2 label (the original prints the bare model, no mount/scope). */
const SHORT_WEAPON_NAME: Record<string, string> = {
  mosin: 'Mosin', mosin_scoped: 'Mosin', kar98k_scoped: 'Kar98k', ppsh41: 'PPSh', svt40: 'SVT-40',
  pistol_p38: 'P38', pistol_tt: 'TT-33', mg34_hmg: 'MG34', mg42_hmg: 'MG42', maxim: 'Maxim',
  coax_mg34: 'MG34', coax_dt: 'DT', bow_mg34: 'MG34', bow_dt: 'DT', panzerschreck: 'Pz.schreck', satchel: 'Satchel',
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

/** Per-soldier weapon/ammo readout, following the original monitor: gun and mortar crews show the
 * round type of *their own* weapon, vehicle gunners the main gun's round, loaders just the rounds,
 * drivers/commanders nothing; everyone else the short name of the weapon he carries. */
export function weaponReadout(s: Soldier, team: Team | null, vehicle: Vehicle | undefined, roleName: string): WeaponReadout {
  if (vehicle) {
    const def = VEHICLE_DEFS[vehicle.defId];
    const mainId = def?.mainWeaponId ?? null;
    // the man who lays the gun (the commander in a two-man turret) shows the round actually in
    // the breech and how many of that type are left; nothing loaded: just the total
    const laysGun = roleName === 'Gunner' || (roleName === 'Commander' && !!vehicle.seats && vehicle.seats.gunner === s.id && vehicle.seats.commander === s.id);
    if (laysGun && roleName !== 'Gunner' && !mainId) return { glyph: null, label: '', rounds: null };
    if (laysGun) {
      if (mainId) {
        const loaded = vehicle.loadedRound;
        if (!loaded) return { glyph: 'tankgun', label: '', rounds: vehicle.mainAmmo };
        return { glyph: 'tankgun', label: ROUND_LABEL[loaded], rounds: vehicleRounds(null, vehicle)[loaded] };
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
  // read live every frame, so a weapon taken from the ground (sim/pickup.ts) and its rounds show at
  // once; a man who dropped his weapon (sim/items.ts UNARMED) has nothing to show
  // No weapon in hand (dropped, UNARMED): the row shows the bare activity word — the
  // original's monitor carries no weapon name for a weaponless man, and a fitted
  // "Unarmed" label could only render at an unreadable 5 px in this narrow slot.
  if (!w) return { glyph: null, label: '', rounds: null };
  switch (w.cls) {
    case 'mortar':
      return { glyph: w.cls, label: team?.order?.type === 'smoke' && w.smoke ? 'Smk' : 'HE', rounds: s.ammo };
    case 'atgun':
    case 'tankgun': {
      // the round actually in the breech and the rounds of that type left (no guessing from the target)
      const cw = team?.crewWeapon;
      const loaded = cw && cw.gunnerId === s.id && cw.chambered ? cw.chamberedType : undefined;
      if (!loaded) return { glyph: w.cls, label: '', rounds: s.ammo + (s.ammoReserve ?? 0) };
      return { glyph: w.cls, label: ROUND_LABEL[loaded], rounds: soldierRounds(null, s)[loaded] };
    }
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

const MAX_DAMAGE_LINES = 3;
/** Header of a vehicle team: the main-gun line plus one line per two damaged systems. */
function headerHeight(vehicle: Vehicle | undefined): number {
  if (!vehicle) return 0;
  const n = vehicleDamageView(vehicle).systems.filter((d) => d.system !== 'mainGun').length;
  return HEADER_H * (1 + Math.min(MAX_DAMAGE_LINES, Math.ceil(n / 2)));
}

export class SoldierMonitorPopup {
  private scroll = 0;
  private hoverUp = false;
  private hoverDown = false;
  private watched: number | null = null;
  private watchedTeam: number | null = null;

  private rect(rows: number, header: boolean | number): Rect {
    const h = rows * ROW_H + (typeof header === 'number' ? header : header ? HEADER_H : 0);
    return { x: RIGHT_X - WIDTH, y: PANEL_Y - h, w: WIDTH, h };
  }

  /** The soldier currently selected inside the monitor (the strip's matrix/cells
   * highlight); null when nothing is watched or it belongs to another team. */
  watchedSoldierForTeam(state: BattleState, team: Team | null): number | null {
    if (this.watched == null || this.watchedTeam == null || !team || team.id !== this.watchedTeam) return null;
    return state.soldiers.has(this.watched) ? this.watched : null;
  }
  /** Screen rect the popup occupies for `team` (null when it isn't drawn) — callers use it to keep
   * clicks on the popup from reaching the map underneath. */
  bounds(state: BattleState, team: Team | null): Rect | null {
    if (!team) return null;
    const count = team.soldierIds.filter((id) => state.soldiers.has(id)).length;
    if (count === 0) return null;
    return this.rect(Math.min(MAX_ROWS, count), headerHeight(team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined));
  }

  update(input: InputState, state: BattleState, team: Team | null): void {
    this.hoverUp = false;
    this.hoverDown = false;
    if (!team) { this.watched = null; this.watchedTeam = null; return; }
    const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
    const rows = Math.min(MAX_ROWS, soldiers.length);
    if (rows === 0) return;
    // the watched soldier belongs to the shown team; switching teams drops the watch
    if (this.watchedTeam != null && this.watchedTeam !== team.id) { this.watched = null; }
    this.watchedTeam = team.id;
    const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
    const r = this.rect(rows, headerHeight(vehicle));
    const bodyY = r.y + headerHeight(vehicle);
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
      else if (hitRect(p, r)) {
        // clicking a row watches that soldier: the yellow bracket on the map + the row border
        for (let i = 0; i < rows; i++) {
          const rowR: Rect = { x: r.x, y: bodyY + i * ROW_H, w: r.w, h: ROW_H };
          if (hitRect(p, rowR)) { this.watched = soldiers[this.scroll + i].id; break; }
        }
      }
    }
    this.scroll = clamp(this.scroll, 0, maxScroll);
  }

  /** The soldier whose monitor row was clicked last; the map draws the original's yellow
   * square bracket around him. Null when nothing is watched. */
  watchedSoldierId(): number | null {
    return this.watched;
  }

  draw(ctx: CanvasRenderingContext2D, state: BattleState, team: Team | null): void {
    if (!team) return;
    const soldiers = team.soldierIds.map((id) => state.soldiers.get(id)).filter((s): s is Soldier => !!s);
    if (soldiers.length === 0) return;
    const rows = Math.min(MAX_ROWS, soldiers.length);
    const vehicle = team.vehicleId != null ? state.vehicles.get(team.vehicleId) : undefined;
    const r = this.rect(rows, headerHeight(vehicle));

    drawHudBevel(ctx, r, false);

    let bodyY = r.y;
    if (vehicle) {
      const hh = headerHeight(vehicle);
      const headerR: Rect = { x: r.x, y: r.y, w: r.w, h: hh };
      drawHudBevel(ctx, headerR, true);
      setHudFont(ctx, 'micro');
      const view = vehicleDamageView(vehicle);
      const gun = vehicle.damage?.mainGun ?? 'ok';
      ctx.fillStyle = gun === 'ok' ? HUD.green : HUD.red;
      ctx.fillText('Main Gun', r.x + 6, r.y + 2);
      ctx.fillText(gun === 'ok' ? 'Operational' : gun === 'damaged' ? 'Damaged' : 'Destroyed', r.x + r.w - 80, r.y + 2);
      // damaged systems in red, two to a line
      const words = view.systems.filter((d) => d.system !== 'mainGun').slice(0, MAX_DAMAGE_LINES * 2);
      words.forEach((d, i) => {
        const x = r.x + 6 + (i % 2) * Math.floor((r.w - 12) / 2);
        const y = r.y + 2 + HEADER_H * (1 + Math.floor(i / 2));
        setHudFont(ctx, 'micro');
        const fit = fitHudText(ctx, [d.word, ...(MONITOR_ABBREV[d.word] ?? [])], MONITOR_DAMAGE_CELL.maxW);
        ctx.font = fit.font;
        ctx.fillStyle = HUD.red;
        ctx.fillText(fit.text, x, y);
      });
      setHudFont(ctx, 'micro');
      bodyY = r.y + hh;
    }

    const hasScroll = soldiers.length > MAX_ROWS;
    const contentX = r.x + (hasScroll ? ARROW_W : 2);
    const rightX = r.x + r.w - 2;

    for (let i = 0; i < rows; i++) {
      const s = soldiers[this.scroll + i];
      const rowY = bodyY + i * ROW_H;
      const y1 = rowY + 1;
      const y2 = rowY + 1 + CELL_H + 1;
      const roleName = role(vehicle, soldiers, this.scroll + i, s, state);

      // line 1: [name] (role) [status]
      const nameR: Rect = { x: contentX, y: y1, w: NAME_W, h: CELL_H };
      const roleR: Rect = { x: contentX + NAME_W + 1, y: y1, w: ROLE_W, h: CELL_H };
      const statusR: Rect = { x: roleR.x + ROLE_W + 1, y: y1, w: rightX - (roleR.x + ROLE_W + 1), h: CELL_H };
      drawHudBevel(ctx, nameR, true, HUD.black);
      drawHudBevel(ctx, roleR, false, HUD.face);
      drawHudBevel(ctx, statusR, true, HUD.black);
      setHudFont(ctx, 'micro');
      cellText(ctx, nameR, s.name, HUD.text);
      const st = statusCell(s, state.time);
      cellText(ctx, statusR, st.word, st.color, 'right');
      setHudFont(ctx, 'micro');
      cellText(ctx, roleR, roleName, HUD.text, 'center');

      // line 2: [activity]  glyph AP/HE   [N] rds.
      const actR: Rect = { x: contentX, y: y2, w: NAME_W, h: CELL_H };
      drawHudBevel(ctx, actR, true, HUD.black);
      setHudFont(ctx, 'micro');
      cellText(ctx, actR, activityWord(s, team, vehicle, roleName), activityColor(s));
      const ro = weaponReadout(s, team, vehicle, roleName);
      const glyphX = roleR.x + 6;
      if (ro.glyph) drawWeaponGlyph(ctx, glyphX, y2 + 3, ro.glyph);
      setHudFont(ctx, 'micro');
      const rdsLabelW = ctx.measureText(' rds.').width;
      const nR: Rect = { x: Math.round(rightX - 2 - rdsLabelW - RDS_CELL_W), y: y2, w: RDS_CELL_W, h: CELL_H };
      if (ro.label) {
        // Long labels ("Unarmed" when a live man is between weapons) must shrink to fit
        // the narrow space between the weapon glyph and the rounds cell — the default
        // 2 px shrink leaves 7+ letter words overflowing under the rounds box, and the
        // clipped region guarantees nothing bleeds into it even if a fit still fails.
        setHudFont(ctx, 'label');
        ctx.fillStyle = HUD.text;
        // no pictogram drawn: the label may start where the glyph would, buying 8 px
        const labelX = ro.glyph ? glyphX + GLYPH_SIZE + 5 : glyphX + 5;
        ctx.save();
        ctx.beginPath();
        ctx.rect(labelX - 2, y2 - 1, nR.x - 2 - labelX, CELL_H + 2);
        ctx.clip();
        const fit = fitHudText(ctx, [ro.label, ...(MONITOR_ABBREV[ro.label] ?? [])], nR.x - 3 - labelX, 6);
        ctx.font = fit.font;
        ctx.fillText(fit.text, labelX, y2 + 2);
        ctx.restore();
        setHudFont(ctx, 'micro');
      }
      drawHudBevel(ctx, nR, true, HUD.black);
      if (ro.rounds != null) {
        ctx.fillStyle = HUD.text;
        ctx.textAlign = 'right';
        ctx.fillText('rds.', rightX - 2, y2 + 2);
        ctx.textAlign = 'left';
        cellText(ctx, nR, String(ro.rounds), HUD.text, 'right');
      }
      if (s.id === this.watched) {
        ctx.strokeStyle = HUD.gold;
        ctx.lineWidth = 2;
        ctx.strokeRect(Math.round(r.x) + 1, Math.round(rowY) + 1, Math.round(r.w) - 2, ROW_H - 2);
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
