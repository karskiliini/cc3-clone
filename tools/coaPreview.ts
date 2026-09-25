// ============================================================================
// tools/coaPreview.ts — dev-only Vite page that renders the G21 COA planning
// screen for every operation that has one, so a human can eyeball the
// objective map, the COA arrows, the legend, the hover readout and the plan
// stages without launching the campaign in the browser.
// Exposes window.__coaReady for Playwright polling.
// ============================================================================
import type { OperationState } from '@/shared/types';
import { game } from '@/game';
import { OPERATION } from '@/data/operation';
import { CoaScreen } from '@/ui/screens/coa';

declare global {
  interface Window {
    __coaReady?: boolean;
    __coaCount?: number;
    __coaHover?: unknown;
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;
const status = document.getElementById('status')!;

let y = 0;
let count = 0;
const errors: string[] = [];
declare global { interface Window { __coaErrors?: string[]; } }
window.__coaErrors = errors;
const onlyParam = new URLSearchParams(location.search).get('only');
const only = onlyParam === null ? null : Number(onlyParam);
for (let i = 0; i < OPERATION.length; i++) {
  if (only !== null && i !== only) continue;
  const op: OperationState = {
    index: i,
    playerSide: 'german',
    results: [],
    forcePool: [],
    requisition: { german: [], soviet: [] },
  };
  game.operation = op;
  let screen: CoaScreen;
  try {
    screen = new CoaScreen();
  } catch (e) {
    errors.push(`op ${i}: ctor failed: ${String(e)}`);
    status.textContent = errors[errors.length - 1] ?? '';
    continue;
  }
  ctx.save();
  ctx.translate(0, y);
  try {
    screen.draw(ctx);
  } catch (e) {
    errors.push(`op ${i}: draw failed: ${String(e)}`);
    ctx.fillStyle = '#f04040';
    ctx.font = '12px monospace';
    ctx.fillText(`draw failed: ${String(e)}`, 10, 20);
  }
  ctx.restore();
  y += 768;
  count++;
}

status.textContent = `ready: ${count} screens, ${y}px tall`;
window.__coaCount = count;
window.__coaReady = true;
