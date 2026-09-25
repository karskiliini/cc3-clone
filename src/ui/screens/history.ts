import type { CursorKind, InputState, Rect, Screen } from '@/shared/types';
import { game } from '@/game';
import { drawDarkPanel, drawListRow, drawScreenTitle, drawShadowText } from '@/ui/chrome';
import { pointInRect } from '@/shared/math';
import { buildMap } from '@/sim/map';
import { TerrainRenderer } from '@/render/terrainRender';
import { MAPS } from '@/data/maps';
import { loadHistory, type BattleRecord } from '@/data/history';
import { RESULT_WORDS } from './debrief';
import { beginMenuFrame, toMenuInput, BottomStrip } from './common';
import { MainMenuScreen } from './mainMenu';
import { OptionsScreen } from './options';

// ============================================================================
// HistoryScreen — the campaign chronicle viewer (roadmap G15).
//
// Left: dated list of fought battles. Right: detail panel with the battle-map
// thumbnail (G22), the result, casualty counts and the elapsed engagement time.
// ============================================================================

const LIST_RECT: Rect = { x: 24, y: 96, w: 348, h: 400 };
const ROW_H = 26;

function mapName(id: string): string {
  return MAPS.find((m) => m.id === id)?.name ?? id;
}

function dateLabel(rec: BattleRecord): string {
  const d = new Date(rec.foughtAt);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export class HistoryScreen implements Screen {
  private records = loadHistory();
  private selected = this.records.length - 1;
  private thumbCache = new Map<string, HTMLCanvasElement>();
  private strip = new BottomStrip({ showBack: true, nextEnabled: false });

  private getThumb(id: string): HTMLCanvasElement | null {
    let c = this.thumbCache.get(id);
    if (!c) {
      const def = MAPS.find((m) => m.id === id);
      if (!def) return null;
      c = new TerrainRenderer(buildMap(def)).thumbnail(300, 176);
      this.thumbCache.set(id, c);
    }
    return c;
  }

  update(_dt: number, input: InputState): void {
    // ESC = Back in every menu screen, like the original (round7 UI pass).
    if (input.keysPressed.has('escape')) { game.setScreen(new MainMenuScreen()); return; }
    const m = toMenuInput(input);
    const result = this.strip.update(m);
    if (result.quitOrBack || result.main) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.options) { game.setScreen(new OptionsScreen(this)); return; }
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      const p = { x: c.x, y: c.y };
      if (pointInRect(p, LIST_RECT)) {
        const idx = Math.floor((p.y - LIST_RECT.y) / ROW_H);
        if (idx >= 0 && idx < this.records.length) this.selected = idx;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    beginMenuFrame(ctx);
    drawScreenTitle(ctx, 'HISTORY');

    // chronicle list
    drawDarkPanel(ctx, LIST_RECT);
    ctx.font = '12px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    if (this.records.length === 0) {
      ctx.fillStyle = '#a8a89c';
      ctx.fillText('No battles fought yet.', LIST_RECT.x + 14, LIST_RECT.y + 26);
    }
    for (let i = 0; i < this.records.length; i++) {
      const row: Rect = { x: LIST_RECT.x + 8, y: LIST_RECT.y + 8 + i * ROW_H, w: LIST_RECT.w - 16, h: ROW_H - 2 };
      if (row.y + row.h > LIST_RECT.y + LIST_RECT.h - 4) break;
      drawListRow(ctx, row, { hot: i === this.selected });
      const rec = this.records[i];
      ctx.fillStyle = i === this.selected ? '#f0f0ec' : '#c8c8c0';
      ctx.fillText(`${dateLabel(rec)} — ${mapName(rec.mapId)}`, row.x + 8, row.y + 17);
      ctx.textAlign = 'right';
      ctx.fillStyle = rec.result.startsWith('') ? '#f0d840' : '#f0d840';
      ctx.fillText(RESULT_WORDS[rec.result], row.x + row.w - 8, row.y + 17);
      ctx.textAlign = 'left';
    }

    // detail panel
    const det: Rect = { x: 396, y: 96, w: 380, h: 400 };
    drawDarkPanel(ctx, det);
    const rec = this.records[this.selected];
    if (rec) {
      const thumb = this.getThumb(rec.mapId);
      if (thumb) {
        ctx.drawImage(thumb, det.x + 16, det.y + 16, 348, 204);
        ctx.strokeStyle = '#000';
        ctx.strokeRect(det.x + 16.5, det.y + 16.5, 348, 204);
      }
      drawShadowText(ctx, mapName(rec.mapId), det.x + 16, det.y + 244, 'bold 15px Arial, Helvetica, sans-serif', '#f0d840');
      ctx.font = '12px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#f0f0ec';
      let y = det.y + 272;
      ctx.fillText(`Result: ${RESULT_WORDS[rec.result]}`, det.x + 16, y); y += 20;
      ctx.fillText(`Date: ${dateLabel(rec)}`, det.x + 16, y); y += 20;
      ctx.fillText(`Your side: ${rec.playerSide === 'german' ? 'German' : 'Soviet'}`, det.x + 16, y); y += 20;
      ctx.fillText(`Your casualties: ${rec.losses}   Enemy casualties: ${rec.enemyLosses}`, det.x + 16, y); y += 20;
      ctx.fillText(`Confirmed kills: ${rec.kills}`, det.x + 16, y); y += 20;
      const mins = Math.floor(rec.durationS / 60);
      const secs = rec.durationS % 60;
      ctx.fillText(`Engagement length: ${mins}:${String(secs).padStart(2, '0')}`, det.x + 16, y);
    } else {
      ctx.fillStyle = '#a8a89c';
      ctx.fillText('Select a battle from the chronicle.', det.x + 16, det.y + 32);
    }

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
