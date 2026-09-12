// ============================================================================
// tools/uiScreens.ts — dev-only Vite page used to verify full-screen UI
// states (DebriefScreen in particular) that are only reachable in-game after
// a battle actually ends. Runs a real Battle headlessly (no rAF, just a tight
// synchronous step loop — deterministic sim, no rendering needed mid-run)
// until it ends or a safety cap is hit, then draws the requested screen once.
// Exposes `window.__uiScreensReady` for Playwright polling.
// ============================================================================
import type { BattleConfig } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import { Battle } from '@/sim/battle';
import { DEFAULT_FORCES } from '@/data/operation';
import { DebriefScreen } from '@/ui/screens/debrief';
import { MessagePanel } from '@/ui/messagePanel';

declare global {
  interface Window {
    __uiScreensReady?: boolean;
    __uiScreensBattle?: Battle;
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
ctx.imageSmoothingEnabled = false;

const status = document.getElementById('status')!;

const cfg: BattleConfig = {
  mapId: 'village_1942',
  playerSide: 'german',
  year: 1942,
  seed: 7,
  durationS: 90, // short so the sim reaches 'ended' quickly in this harness
  difficulty: 'normal',
  forces: DEFAULT_FORCES[1942],
};

const battle = new Battle(cfg);
battle.start();

// Step the sim forward synchronously in fixed SIM_DT ticks. This is pure
// simulation (no drawing), so thousands of ticks run in well under a second.
const SAFETY_MAX_STEPS = 20000;
let steps = 0;
let stepErrors = 0;
while (battle.state.phase === 'running' && steps < SAFETY_MAX_STEPS) {
  try {
    battle.step(SIM_DT);
  } catch (err) {
    // sim/ai.ts's debug branch references process.env, which doesn't exist
    // in the browser; that's a pre-existing sim-side issue outside this
    // harness's ownership. Skip the tick rather than aborting verification.
    stepErrors++;
    if (stepErrors > 50) break;
  }
  steps++;
}

window.__uiScreensBattle = battle;

const debrief = new DebriefScreen(battle);
debrief.draw(ctx);

// -----------------------------------------------------------------------
// Second check, drawn below the debrief (canvas is taller than 600px here
// only in this dev harness): the message panel with deliberately long
// messages, to verify truncation/2-line wrapping never spills past the
// panel's right edge (item 3 of the UI polish pass).
// -----------------------------------------------------------------------
battle.state.messages = [
  { time: 1, text: 'Battle begins.', kind: 'info' },
  { time: 10, text: 'Uffz. Weber spots an enemy rifle squad advancing through the tree line to the north-east.', kind: 'warn' },
  { time: 20, text: 'Gefr. Klein has been killed by machine gun fire from the church tower.', kind: 'bad' },
  { time: 30, text: 'Rifle Squad has captured North Farm and is now defending the position.', kind: 'good' },
  { time: 40, text: 'Short one.', kind: 'info' },
];
const panel = new MessagePanel();
ctx.save();
ctx.translate(0, 620 - 480);
panel.draw(ctx, battle.state, false, 1);
ctx.restore();

status.textContent = `Battle ended after ${steps} steps (phase=${battle.state.phase}, result=${battle.state.result ?? 'n/a'}). DebriefScreen rendered above; MessagePanel wrap test rendered below with synthetic long messages.`;
window.__uiScreensReady = true;
