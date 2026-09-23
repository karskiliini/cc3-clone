import type { CursorKind, GameSettings, InputState, Rect, Screen } from '@/shared/types';
import { clamp, pointInRect } from '@/shared/math';
import { game } from '@/game';
import { drawDarkPanel, drawHeading, drawLabel, drawSmallMetalButton, UI } from '@/ui/chrome';
import { drawMenuFrame, toMenuInput, BottomStrip } from './common';
import { MainMenuScreen } from './mainMenu';

const SPEEDS: GameSettings['speed'][] = [1, 2, 4];

/** One settings row: a label and a button showing the current value; clicking it steps the value. */
interface Row {
  label: string;
  value: () => string;
  click: () => void;
}

const PANEL: Rect = { x: 40, y: 88, w: 720, h: 312 };
const COL_X = [PANEL.x + 20, PANEL.x + 380];
const BTN_W = 76;
const ROW_Y0 = PANEL.y + 46;
const ROW_STEP = 40;

/** Game options and realism switches. Back returns to the screen that opened it (the main
 * menu, or the running battle / deployment, where "Quit Battle" also leaves for the main menu).
 * Settings persist in localStorage when leaving. */
export class OptionsScreen implements Screen {
  private returnTo: Screen;
  private strip: BottomStrip;
  private columns: Row[][];
  private mouse = { x: -1, y: -1 };

  /** `inBattle`: opened from deployment or a running battle — adds "Quit Battle". */
  constructor(returnTo: Screen, inBattle: boolean) {
    this.returnTo = returnTo;
    this.strip = new BottomStrip({ next: inBattle ? 'Quit Battle' : undefined });
    const s = game.settings;
    const onOff = (v: boolean | undefined) => (v ? 'On' : 'Off');
    this.columns = [
      [
        { label: 'Unit Labels', value: () => onOff(s.unitLabels), click: () => (s.unitLabels = !s.unitLabels) },
        { label: 'Line Of Sight Lines', value: () => onOff(s.losLines), click: () => (s.losLines = !s.losLines) },
        { label: 'Unit Vision (L)', value: () => onOff(s.showUnitVision ?? true), click: () => (s.showUnitVision = !(s.showUnitVision ?? true)) },
        { label: 'Depth Map (§)', value: () => onOff(s.showDepthMap), click: () => (s.showDepthMap = !s.showDepthMap) },
        { label: 'Game Speed', value: () => `x${s.speed}`, click: () => (s.speed = SPEEDS[(SPEEDS.indexOf(s.speed) + 1) % SPEEDS.length]) },
      ],
      [
        { label: 'Always See Enemy', value: () => onOff(s.alwaysSeeEnemy), click: () => (s.alwaysSeeEnemy = !s.alwaysSeeEnemy) },
        { label: 'Never Act On Initiative', value: () => onOff(s.neverActOnInitiative), click: () => (s.neverActOnInitiative = !s.neverActOnInitiative) },
        { label: 'Always Have Full Enemy Info', value: () => onOff(s.alwaysFullEnemyInfo), click: () => (s.alwaysFullEnemyInfo = !s.alwaysFullEnemyInfo) },
        { label: 'Always Obey Orders', value: () => onOff(s.alwaysObeyOrders), click: () => (s.alwaysObeyOrders = !s.alwaysObeyOrders) },
      ],
    ];
  }

  private rowRect(col: number, i: number): Rect {
    return { x: COL_X[col] + 340 - 20 - BTN_W, y: ROW_Y0 + ROW_STEP * (i + (col === 0 ? 1 : 0)), w: BTN_W, h: 24 };
  }

  private volMinusR(): Rect {
    return { ...this.rowRect(0, -1), x: COL_X[0] + 150, w: 30 };
  }

  private volPlusR(): Rect {
    const r = this.rowRect(0, -1);
    return { ...r, x: r.x + r.w - 30, w: 30 };
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    this.mouse = m.mouse;
    const s = game.settings;
    for (const c of m.clicks) {
      if (c.button !== 0) continue;
      const step = pointInRect(c, this.volMinusR()) ? -0.1 : pointInRect(c, this.volPlusR()) ? 0.1 : 0;
      if (step !== 0) {
        s.volume = clamp(Math.round((s.volume + step) * 10) / 10, 0, 1);
        game.audio?.setVolume?.(s.volume);
      }
      this.columns.forEach((rows, col) => rows.forEach((row, i) => {
        if (pointInRect(c, this.rowRect(col, i))) row.click();
      }));
    }

    const result = this.strip.update(m);
    if (result.back || result.next) {
      game.saveSettings();
      game.setScreen(result.next ? new MainMenuScreen() : this.returnTo);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'OPTIONS', () => {
      const s = game.settings;
      const hot = (r: Rect) => pointInRect(this.mouse, r);
      drawDarkPanel(ctx, PANEL);
      ctx.fillStyle = 'rgba(160,96,64,0.35)';
      ctx.fillRect(PANEL.x + 360, PANEL.y + 16, 1, PANEL.h - 32);
      drawHeading(ctx, 'GAME', COL_X[0], PANEL.y + 28);
      drawHeading(ctx, 'REALISM', COL_X[1], PANEL.y + 28);

      const baseline = (r: Rect) => r.y + 17;
      const vm = this.volMinusR();
      const vp = this.volPlusR();
      drawLabel(ctx, 'Volume', COL_X[0], baseline(vm), UI.label, UI.text);
      drawSmallMetalButton(ctx, vm, '−', { hot: hot(vm) });
      drawLabel(ctx, `${Math.round(s.volume * 100)}%`, (vm.x + vm.w + vp.x) / 2, baseline(vm), 'bold 13px Arial, Helvetica, sans-serif', UI.gold, 'center');
      drawSmallMetalButton(ctx, vp, '+', { hot: hot(vp) });

      this.columns.forEach((rows, col) => rows.forEach((row, i) => {
        const r = this.rowRect(col, i);
        drawLabel(ctx, row.label, COL_X[col], baseline(r), UI.label, UI.text);
        const v = row.value();
        drawSmallMetalButton(ctx, r, v, { active: v === 'On', hot: hot(r) });
      }));

      this.strip.draw(ctx);
    });
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
