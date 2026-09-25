// ============================================================================
// roster.ts — campaign roster screen (roadmap G1 / G22).
//
// The CC3 "ROSTER" screen: a red/black full-screen table of the persistent
// kampfgruppe — one row per soldier, columns for rank, name, weapon, status
// (healthy / wounded-light / wounded-serious / KIA), kills, battles and
// experience level. Reached from the operation screen between battles.
// ============================================================================
import type { CampaignSoldier, CampaignTeam, CursorKind, InputState, Screen } from '@/shared/types';
import { MENU_H, MENU_W } from '@/shared/types';
import { experienceLevel } from '@/data/experience';
import { medalById } from '@/data/medals';
import { game } from '@/game';
import { drawDarkPanel, drawShadowText } from '@/ui/chrome';
import { drawMenuFrame, toMenuInput, BottomStrip } from './common';
import { OperationScreen } from './operation';

const STATUS_WORDS: Record<string, string> = {
  healthy: 'Fit',
  woundedLight: 'Wounded (lt)',
  woundedSerious: 'Wounded (sv)',
  kia: 'KIA',
};

const ROW_Y0 = 150;
const ROW_H = 22;
const COLUMN_X = [60, 230, 310, 430, 560, 610, 650, 690] as const;
/** Rows stop above the bottom strip so the table never overflows the panel. */
const ROW_Y_MAX = MENU_H - 80;

export class RosterScreen implements Screen {
  private strip = new BottomStrip({});
  private scroll = 0;
  /** Screen to return to; defaults to the operation screen (G22 entry path). */
  private back: Screen | null;

  constructor(back: Screen | null = null) {
    this.back = back;
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    // Back (or ESC) returns to the screen that opened the roster
    if (this.strip.update(m).back) {
      game.setScreen(this.back ?? new OperationScreen());
      return;
    }
    const rows = this.rows();
    const maxVisible = Math.floor((ROW_Y_MAX - ROW_Y0) / ROW_H);
    if (m.wheelDY !== 0) {
      const maxScroll = Math.max(0, rows.length - maxVisible);
      this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + Math.sign(m.wheelDY)));
    }
  }

  cursor(): CursorKind {
    return 'arrow';
  }
  /** Flattened scrollable list: one entry per row, with team-name header rows
   * marked by a null soldier so update() and draw() share one maxVisible. */
  private rows(): Array<{ team: CampaignTeam; soldier: CampaignSoldier | null }> {
    const campaign = game.campaign;
    if (!campaign) return [];
    const out: Array<{ team: CampaignTeam; soldier: CampaignSoldier | null }> = [];
    for (const team of campaign.teams) {
      const soldiers = team.soldierUids
        .map((uid) => campaign.soldiers[uid])
        .filter((s) => !!s);
      if (soldiers.length === 0) continue;
      out.push({ team, soldier: null });
      for (const s of soldiers) out.push({ team, soldier: s });
    }
    return out;
  }
  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'ROSTER', () => this.drawBody(ctx));
  }

  private drawBody(ctx: CanvasRenderingContext2D): void {
    drawDarkPanel(ctx, { x: 40, y: 90, w: MENU_W - 80, h: MENU_H - 150 });

    const campaign = game.campaign;
    if (!campaign) {
      drawShadowText(ctx, 'No campaign in progress.', 60, 140, '12px Arial, Helvetica, sans-serif', '#e8e8e0');
      this.strip.draw(ctx);
      return;
    }

    const headers = ['TEAM', 'RANK', 'NAME', 'WEAPON', 'STATUS', 'KILLS', 'EXP', 'MEDALS'];
    headers.forEach((htext, i) => {
      ctx.fillStyle = '#c8a028';
      ctx.fillText(htext, COLUMN_X[i], 115);
    });

    const rows = this.rows();
    const maxVisible = Math.floor((ROW_Y_MAX - ROW_Y0) / ROW_H);
    let y = ROW_Y0;
    for (const { team, soldier } of rows.slice(this.scroll, this.scroll + maxVisible)) {
      if (soldier === null) {
        ctx.fillStyle = '#d04020';
        ctx.font = 'bold 12px Arial, Helvetica, sans-serif';
        ctx.fillText(team.name.toUpperCase(), COLUMN_X[0], y);
        y += ROW_H;
        continue;
      }
      ctx.font = '12px Arial, Helvetica, sans-serif';
      ctx.fillStyle = soldier.health === 'kia' ? '#804040' : '#e8e8e0';
      ctx.fillText(soldier.rank, COLUMN_X[1], y);
      ctx.fillStyle = soldier.health === 'kia' ? '#804040' : '#f0f0ec';
      ctx.fillText(soldier.name, COLUMN_X[2], y);
      ctx.fillStyle = '#c8c8c0';
      ctx.fillText(soldier.weaponId, COLUMN_X[3], y);
      ctx.fillStyle = soldier.health === 'kia' ? '#d02020' : soldier.health === 'healthy' ? '#3fbf3f' : '#c8a028';
      ctx.fillText(STATUS_WORDS[soldier.health] ?? soldier.health, COLUMN_X[4], y);
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(String(soldier.kills), COLUMN_X[5], y);
      ctx.fillStyle = '#e8e8e0';
      ctx.fillText(experienceLevel(soldier.experience), COLUMN_X[6], y);
      ctx.fillStyle = '#c8a028';
      ctx.fillText(soldier.medals.map((id) => medalById(id)?.abbr ?? id).join(' '), COLUMN_X[7], y);
      y += ROW_H;
    }
    this.strip.draw(ctx);
  }
}
