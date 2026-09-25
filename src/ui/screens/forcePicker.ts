// ============================================================================
// forcePicker.ts — the two-column "force pool / active roster" requisition
// widget shared by Battle mode's requisition step and the Operation briefing.
// Click a pool row to add that team, click a roster row to select it, click
// it again (or Retire) to send it back. In campaign mode (Operation) the roster
// rows are persistent campaign teams: purchases mint new ones from the live
// requisition balance, and Refit / Upgrade / Retire (vehicle) act on the
// selected team. Draws/updates in MENU-local space.
// ============================================================================
import type { CampaignState, InputState, Rect, Side, TeamDef, TeamType, Vec2 } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { drawDarkPanel, drawSmallMetalButton, drawVerticalStencil, UI } from '@/ui/chrome';
import { getTeamIcon } from '@/render/sprites';
import { TEAM_DEFS, VEHICLE_DEFS, teamsForYear } from '@/data/units';
import { WEAPONS } from '@/data/weapons';
import { experienceLevel, typicalExperience } from '@/data/experience';
import { addTeam, refitTeam, retireVehicle, upgradeTeam } from '@/campaign/roster';
import { Rng } from '@/shared/rng';
import { wrapText, truncateText } from './common';

/** Short flavour text per team type, shown in the info panel for the selected pool row. */
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
  rocket: 'Rocket artillery: salvo indirect fire with devastating first impact, then a long reload and a vulnerable gun line. Shoot and scoot.',
  transport: 'An unarmed utility vehicle: ferries ammunition and supplies to guns and tanks. Not a fighting unit.',
};

const ARMOR_TYPES = new Set<TeamType>(['tank', 'spg', 'halftrack']);

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
  rocket: 'Rocket Artillery',
  transport: 'Utility Vehicle',
};

/** 'Rifle Infantry (Kar98k, MG34)' for infantry; the category alone for vehicles
 * (tanks with thick front armour read 'Heavy Tank', as in the original). */
function subtypeLabel(def: TeamDef): string {
  if (def.vehicleDefId) {
    const v = VEHICLE_DEFS[def.vehicleDefId];
    return def.type === 'tank' && v && v.armor.front >= 90 ? 'Heavy Tank' : CATEGORY_LABEL[def.type];
  }
  const ids = def.soldiers.map((s) => s.weaponId);
  const leader = WEAPONS[ids[0]]?.name ?? ids[0];
  const supportId = ids.slice(1).find((id) => id !== ids[0]);
  const support = supportId ? WEAPONS[supportId]?.name ?? supportId : undefined;
  return `${CATEGORY_LABEL[def.type]} (${support ? `${leader}, ${support}` : leader})`;
}

const ROW_H = 27;
const MAX_ROSTER = 15;

/** One list row: team icon, name (+ optional right-hand text), italic subtype line. */
function drawTeamRow(ctx: CanvasRenderingContext2D, list: Rect, y: number, def: TeamDef, opts: { selected: boolean; hot: boolean; dim: boolean; right?: string; men?: number }): void {
  if (opts.selected || opts.hot) {
    ctx.fillStyle = opts.selected ? 'rgba(200,50,30,0.38)' : 'rgba(255,255,255,0.06)';
    ctx.fillRect(list.x + 1, y, list.w - 2, ROW_H);
  }
  const icon = getTeamIcon(def.iconId);
  const k = Math.min(1, 36 / icon.width, 24 / icon.height);
  ctx.drawImage(icon, list.x + 6, y + (ROW_H - icon.height * k) / 2, icon.width * k, icon.height * k);
  const tx = list.x + 48;
  const rightEdge = list.x + list.w - 8;
  ctx.textBaseline = 'alphabetic';
  let reserved = 0;
  if (opts.right) {
    ctx.font = UI.label;
    ctx.textAlign = 'right';
    ctx.fillStyle = opts.dim ? UI.dim : UI.gold;
    ctx.fillText(opts.right, rightEdge, y + 12);
    reserved = ctx.measureText(opts.right).width + 8;
  }
  if (opts.men) {
    const n = Math.min(opts.men, 10);
    ctx.fillStyle = UI.good;
    for (let i = 0; i < n; i++) ctx.fillRect(rightEdge - (n - i) * 7 + 1, y + 5, 5, 5);
    reserved = n * 7 + 6;
  }
  ctx.textAlign = 'left';
  ctx.font = UI.label;
  ctx.fillStyle = opts.dim ? UI.dim : UI.text;
  ctx.fillText(truncateText(ctx, def.name, rightEdge - reserved - tx), tx, y + 12);
  ctx.font = 'italic 11px Arial, Helvetica, sans-serif';
  ctx.fillStyle = opts.dim ? UI.dim : UI.accent;
  ctx.fillText(truncateText(ctx, subtypeLabel(def), rightEdge - tx), tx, y + 24);
}

export class ForcePicker {
  side: Side;
  year: number;
  points: number;
  rosterIds: string[];
  /** campaign team uids parallel to rosterIds in campaign mode (G3) */
  campaignUids: string[] | null = null;
  /** campaign state for purchase/refit/upgrade/retire mutations (G3) */
  campaignState: CampaignState | null = null;
  /** slot count by difficulty (G3); falls back to the battle-mode default */
  maxSlotsOverride: number | null = null;
  category: 'regular' | 'armor' = 'regular';

  private poolIds: string[] = [];
  private poolSelected = -1;
  private poolScroll = 0;
  private rosterSelected = -1;
  private rosterScroll = 0;
  private mouse: Vec2 = { x: -1, y: -1 };

  // pool on the left under FORCE POOL (reading up the left edge), roster on the right with
  // ACTIVE ROSTER reading down the right edge: each title has its own clear column
  private regularBtn: Rect = { x: 60, y: 96, w: 104, h: 22 };
  private armorBtn: Rect = { x: 170, y: 96, w: 104, h: 22 };
  private poolRect: Rect = { x: 60, y: 128, w: 324, h: 7 * ROW_H + 2 };
  private infoRect: Rect = { x: 60, y: 346, w: 324, h: 146 };
  private upgradeBtn: Rect = { x: 506, y: 96, w: 80, h: 22 };
  private refitBtn: Rect = { x: 592, y: 96, w: 72, h: 22 };
  private retireBtn: Rect = { x: 670, y: 96, w: 70, h: 22 };
  private rosterRect: Rect = { x: 416, y: 128, w: 324, h: 7 * ROW_H + 2 };
  private pointsRect: Rect = { x: 416, y: 346, w: 324, h: 34 };

  constructor(side: Side, year: number, points: number, initialRosterIds: string[]) {
    this.side = side;
    this.year = year;
    this.points = points;
    this.rosterIds = [...initialRosterIds];
    this.refreshPool();
  }

  private refreshPool(): void {
    this.poolIds = teamsForYear(this.side, this.year)
      .filter((d) => ARMOR_TYPES.has(d.type) === (this.category === 'armor'))
      .map((d) => d.id);
    this.poolSelected = this.poolIds.length ? 0 : -1;
    this.poolScroll = 0;
  }

  spent(): number {
    return this.rosterIds.reduce((sum, id) => sum + (TEAM_DEFS[id]?.cost ?? 0), 0);
  }

  private get maxRoster(): number {
    return this.maxSlotsOverride ?? MAX_ROSTER;
  }

  private get campaignMode(): boolean {
    return !!this.campaignState && !!this.campaignUids;
  }

  remaining(): number {
    // Campaign mode: the display shows the campaign's live requisition balance —
    // acquisitions and refits deduct it, seeded/owned roster rows are pre-paid and cost
    // nothing here (G3 force pool, item 041). Battle mode keeps points minus spent.
    if (this.campaignState && this.campaignUids) return this.campaignState.requisition;
    return this.points - this.spent();
  }

  /** The campaign team behind the selected roster row (campaign mode only). */
  private selectedCampaignTeam() {
    if (!this.campaignState || !this.campaignUids || this.rosterSelected < 0) return undefined;
    const uid = this.campaignUids[this.rosterSelected];
    return this.campaignState.teams.find((t) => t.uid === uid);
  }

  /** Whether the selected roster row's team has an upgrade path available this year (G3b). */
  private selectedCanUpgrade(): boolean {
    const team = this.selectedCampaignTeam();
    const def = team ? TEAM_DEFS[team.defId] : null;
    const next = def?.upgradesTo ? TEAM_DEFS[def.upgradesTo] : null;
    return !!next && next.years.includes(this.year);
  }

  /** Retire: in battle mode it drops the row; in campaign mode it retires the selected
   * team's vehicle (the crew fights on foot), so it only applies to vehicle teams. */
  private canRetire(): boolean {
    if (this.rosterSelected < 0) return false;
    if (!this.campaignMode) return true;
    const team = this.selectedCampaignTeam();
    return !!team?.vehicleDefId && !team.vehicleRetired;
  }

  /** Resolves a roster row's team def. Battle-mode rows carry raw defIds; campaign-mode
   * rows carry campaign team uids (G3), which resolve through the campaign roster so
   * purchased teams (item 041) render with their own identity. */
  private rosterDefAt(idx: number): TeamDef | null {
    const direct = TEAM_DEFS[this.rosterIds[idx]];
    if (direct) return direct;
    if (!this.campaignState) return null;
    const team = this.campaignState.teams.find((t) => t.uid === this.rosterIds[idx]);
    return team ? TEAM_DEFS[team.defId] ?? null : null;
  }

  private rowAt(list: Rect, scroll: number, p: Vec2): number {
    return pointInRect(p, list) ? scroll + Math.floor((p.y - list.y - 1) / ROW_H) : -1;
  }

  update(input: InputState): void {
    this.mouse = input.mouse;
    for (const c of input.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      const poolRow = this.rowAt(this.poolRect, this.poolScroll, p);
      const rosterRow = this.rowAt(this.rosterRect, this.rosterScroll, p);
      if (pointInRect(p, this.regularBtn) && this.category !== 'regular') {
        this.category = 'regular';
        this.refreshPool();
      } else if (pointInRect(p, this.armorBtn) && this.category !== 'armor') {
        this.category = 'armor';
        this.refreshPool();
      } else if (pointInRect(p, this.retireBtn) && this.canRetire()) {
        if (this.campaignState && this.campaignUids) retireVehicle(this.campaignState, this.campaignUids[this.rosterSelected]);
        else this.rosterIds.splice(this.rosterSelected, 1);
        this.rosterSelected = -1;
      } else if (pointInRect(p, this.upgradeBtn) && this.campaignState && this.campaignUids && this.selectedCanUpgrade()) {
        upgradeTeam(this.campaignState, this.campaignUids[this.rosterSelected], this.year);
        this.rosterSelected = -1;
      } else if (pointInRect(p, this.refitBtn) && this.campaignState && this.selectedCampaignTeam()) {
        const team = this.selectedCampaignTeam()!;
        refitTeam(this.campaignState, team.uid, {
          repair: !!team.vehicleDamage,
          replace: true,
          required: TEAM_DEFS[team.defId]?.soldiers.length ?? 0,
        });
        this.rosterSelected = -1;
      } else if (poolRow >= 0 && poolRow < this.poolIds.length) {
        this.poolSelected = poolRow;
        const def = TEAM_DEFS[this.poolIds[poolRow]];
        if (def && this.rosterIds.length < this.maxRoster && this.remaining() >= def.cost) {
          if (this.campaignState && this.campaignUids) {
            // G3 force pool (item 041): a purchase mints a persistent campaign team,
            // pays its acquisition from the live requisition balance, and fields it
            // immediately — both parallel lists carry the new uid so the operation's
            // Next selects it into the battle.
            const campaign = this.campaignState;
            const team = addTeam(campaign, def.id, def.name, def.soldiers, def.vehicleDefId,
              new Rng(campaign.seed + campaign.teams.length * 31));
            campaign.requisition -= def.cost;
            this.campaignUids.push(team.uid);
            this.rosterIds.push(team.uid);
          } else {
            this.rosterIds.push(def.id);
          }
        }
      } else if (rosterRow >= 0 && rosterRow < this.rosterIds.length) {
        if (rosterRow === this.rosterSelected) {
          // Campaign mode: the two lists are parallel — removing a roster row un-fields
          // the team for this battle but it stays in the kampfgruppe for later ops.
          this.campaignUids?.splice(rosterRow, 1);
          this.rosterIds.splice(rosterRow, 1);
          this.rosterSelected = -1;
        } else {
          this.rosterSelected = rosterRow;
        }
      }
    }
    if (input.wheel !== 0) {
      const step = input.wheel > 0 ? 1 : -1;
      const visible = Math.floor(this.poolRect.h / ROW_H);
      if (pointInRect(input.mouse, this.poolRect)) {
        this.poolScroll = Math.max(0, Math.min(Math.max(0, this.poolIds.length - visible), this.poolScroll + step));
      } else if (pointInRect(input.mouse, this.rosterRect)) {
        this.rosterScroll = Math.max(0, Math.min(Math.max(0, this.rosterIds.length - visible), this.rosterScroll + step));
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    // ---- force pool ----
    drawVerticalStencil(ctx, 'FORCE POOL', 52, 492, 44, 364);
    drawSmallMetalButton(ctx, this.regularBtn, 'Regular', { active: this.category === 'regular', hot: pointInRect(this.mouse, this.regularBtn) });
    drawSmallMetalButton(ctx, this.armorBtn, 'Armor', { active: this.category === 'armor', hot: pointInRect(this.mouse, this.armorBtn) });
    drawDarkPanel(ctx, this.poolRect);
    const visible = Math.floor(this.poolRect.h / ROW_H);
    const hotPool = this.rowAt(this.poolRect, this.poolScroll, this.mouse);
    for (let i = 0; i < visible && this.poolScroll + i < this.poolIds.length; i++) {
      const idx = this.poolScroll + i;
      const def = TEAM_DEFS[this.poolIds[idx]];
      if (!def) continue;
      const affordable = def.cost <= this.remaining() && this.rosterIds.length < this.maxRoster;
      drawTeamRow(ctx, this.poolRect, this.poolRect.y + 1 + i * ROW_H, def, {
        selected: idx === this.poolSelected, hot: idx === hotPool, dim: !affordable, right: String(def.cost),
      });
    }

    drawDarkPanel(ctx, this.infoRect);
    const sel = this.poolSelected >= 0 ? TEAM_DEFS[this.poolIds[this.poolSelected]] : null;
    if (sel) {
      const ir = this.infoRect;
      drawTeamRow(ctx, ir, ir.y + 6, sel, { selected: false, hot: false, dim: false, right: `${sel.cost} pts` });
      ctx.font = 'italic 11px Arial, Helvetica, sans-serif';
      ctx.fillStyle = UI.dim;
      ctx.textAlign = 'left';
      ctx.fillText(`Typical experience: ${experienceLevel(typicalExperience(sel, this.year))}`, ir.x + 10, ir.y + 52);
      ctx.font = UI.body;
      ctx.fillStyle = UI.text;
      let ty = ir.y + 72;
      for (const line of wrapText(ctx, TEAM_FLAVOR[sel.type] ?? '', ir.w - 20).slice(0, 5)) {
        ctx.fillText(line, ir.x + 10, ty);
        ty += 15;
      }
    }

    // ---- active roster ----
    drawVerticalStencil(ctx, 'ACTIVE ROSTER', 748, 128, 44, 364, true);
    ctx.font = UI.label;
    ctx.textAlign = 'left';
    ctx.fillStyle = UI.text;
    ctx.fillText(`${this.rosterIds.length} / ${this.maxRoster} teams`, this.rosterRect.x + 2, this.rosterRect.y - 12);
    // only the actions that apply to the selected row are shown
    if (this.canRetire()) {
      drawSmallMetalButton(ctx, this.retireBtn, 'Retire', { hot: pointInRect(this.mouse, this.retireBtn) });
    }
    if (this.selectedCampaignTeam()) {
      drawSmallMetalButton(ctx, this.refitBtn, 'Refit', { hot: pointInRect(this.mouse, this.refitBtn) });
      if (this.selectedCanUpgrade()) drawSmallMetalButton(ctx, this.upgradeBtn, 'Upgrade', { hot: pointInRect(this.mouse, this.upgradeBtn) });
    }
    drawDarkPanel(ctx, this.rosterRect);
    const hotRoster = this.rowAt(this.rosterRect, this.rosterScroll, this.mouse);
    for (let i = 0; i < visible && this.rosterScroll + i < this.rosterIds.length; i++) {
      const idx = this.rosterScroll + i;
      const def = this.rosterDefAt(idx);
      if (!def) continue;
      drawTeamRow(ctx, this.rosterRect, this.rosterRect.y + 1 + i * ROW_H, def, {
        selected: idx === this.rosterSelected, hot: idx === hotRoster, dim: false, men: def.soldiers.length,
      });
    }
    if (this.rosterIds.length > visible) {
      ctx.font = UI.note;
      ctx.fillStyle = UI.dim;
      ctx.textAlign = 'right';
      ctx.fillText('scroll for more', this.rosterRect.x + this.rosterRect.w - 4, this.rosterRect.y + this.rosterRect.h + 12);
    }

    const pr = this.pointsRect;
    drawDarkPanel(ctx, pr);
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = UI.text;
    ctx.fillText('Requisition Points Remaining', pr.x + 10, pr.y + pr.h / 2);
    ctx.textAlign = 'right';
    ctx.font = 'bold 16px Arial, Helvetica, sans-serif';
    ctx.fillStyle = this.remaining() < 0 ? UI.bad : UI.gold;
    ctx.fillText(String(this.remaining()), pr.x + pr.w - 12, pr.y + pr.h / 2 + 1);
    ctx.restore();
  }
}
