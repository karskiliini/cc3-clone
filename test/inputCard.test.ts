import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worldToScreen } from '@/engine/camera';
import { BattleScreen } from '@/ui/screens/battle';
import { Battle } from '@/sim/battle';
import { createInput } from '@/engine/input';
import { game } from '@/game';
import { loadHistory } from '@/data/history';
import type { Sfx } from '@/audio/sfx';

const settings = { ...game.settings };
const camera = { ...game.cam };
let events: EventTarget;

beforeEach(() => {
  events = new EventTarget();
  (globalThis as { window?: EventTarget }).window = events; // bun:test's vi shim lacks stubGlobal
  game.settings.showUnitVision = false;
  game.settings.showDepthMap = false;
  game.cam = { x: 0, y: 0, zoom: 1 };
});
afterEach(() => {
  game.settings = { ...settings };
  game.cam = { ...camera };
  game.operation = null;
  game.audio = undefined;
  delete (globalThis as { window?: unknown }).window;
});

function event(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, Object.fromEntries(Object.entries(props).map(([name, value]) => [name, { value }])));
  events.dispatchEvent(e);
}
/** Fake Sfx stub matching the surface the battle screen touches. */
function fakeAudio() {
  const stub = {
    muted: false,
    setMuted(v: boolean) { this.muted = v; },
    isMuted() { return this.muted; },
    setPaused() {}, handleEvents() {}, ambient() {}, updateVehicles() {},
    stopAll() {}, play() {},
  };
  return stub as unknown as Sfx & { muted: boolean };
}

function setup() {
  const battle = new Battle({
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 1, durationS: 600,
    difficulty: 'normal', forces: { german: ['ger_rifle_41'], soviet: ['sov_rifle_41'] },
  });
  const screen = new BattleScreen(battle);
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 1024, height: 768 }),
  });
  const input = createInput(canvas as unknown as HTMLCanvasElement);
  const frame = () => { screen.update(0, input.state); input.endFrame(); };
  const key = (type: 'keydown' | 'keyup', keyName: string, props: Record<string, unknown> = {}) =>
    event(type, { key: keyName, repeat: false, ctrlKey: false, metaKey: false, ...props });
  const press = (name: string, props: Record<string, unknown> = {}) => {
    key('keydown', name, props); key('keyup', name, props); frame();
  };
  const click = (x: number, y: number, button = 0, advance = true) => {
    const props = { clientX: x, clientY: y, button, shiftKey: input.state.keysDown.has('shift') };
    event('mousemove', props); event('mousedown', props); event('mouseup', props);
    if (advance) frame();
  };
  press('a', { ctrlKey: true }); // Select through the actual battle UI.
  return { battle, team: battle.selectableTeams('german')[0], screen, input, key, press, frame, click };
}
describe('manual input card (item 037)', () => {
  it('SPACEBAR shows and hides each command radius instead of pausing', () => {
    const { screen, press } = setup();
    expect((screen as unknown as { showCommandRadii: boolean }).showCommandRadii).toBe(false);
    press(' ');
    expect((screen as unknown as { showCommandRadii: boolean }).showCommandRadii).toBe(true);
    press(' ');
    expect((screen as unknown as { showCommandRadii: boolean }).showCommandRadii).toBe(false);
  });

  it('right-click cancels the aiming line without issuing an order (manual: cancel the order line)', () => {
    const { team, screen, press, click } = setup();
    expect(team.order?.type ?? null).not.toBe('move'); // deploy default (defend) stays put
    press('z'); // pending move aim
    expect((screen as unknown as { pendingOrder: string | null }).pendingOrder).toBe('move');
    click(500, 400, 2); // right press cancels; no left click ever placed the dot
    expect((screen as unknown as { pendingOrder: string | null }).pendingOrder).toBeNull();
    expect(team.order?.type ?? null).not.toBe('move'); // no move was ever issued
  });

  it('right-click still opens the command menu once the aim is cancelled', () => {
    const { team, screen, press, click } = setup();
    // put the team on-screen: the border map deploys around (27,53) — pan the camera there
    game.cam = { x: team.pos.x - 20, y: team.pos.y - 15, zoom: 1 };
    press('z');
    click(500, 400, 2); // cancels the aim
    const sp = worldToScreen(game.cam, team.pos);
    click(Math.round(sp.x) + 2, Math.round(sp.y) + 2, 2);
    expect((screen as unknown as { commandMenu: { isOpen: boolean } }).commandMenu.isOpen).toBe(true);
  });

  it('ESC with a pending aim cancels it, ESC alone opens the quit confirm, No resumes the battle', () => {
    const { screen, press, frame, battle } = setup();
    press('z');
    press('escape');
    expect((screen as unknown as { pendingOrder: string | null }).pendingOrder).toBeNull();
    expect((screen as unknown as { quitConfirm: string | null }).quitConfirm).toBeNull();
    press('escape');
    expect((screen as unknown as { quitConfirm: string | null }).quitConfirm).not.toBeNull();
    // battle stays frozen under the modal
    const t0 = battle.state.time;
    frame();
    expect(battle.state.time).toBe(t0);
    press('n');
    expect((screen as unknown as { quitConfirm: string | null }).quitConfirm).toBeNull();
  });

  it('ESC quit confirm YES abandons the battle without a debrief and without a chronicle entry', () => {
    const { screen, press, battle } = setup();
    game.operation = { index: 0, playerSide: 'german', results: [], forcePool: [], requisition: 0, opIndex: 0 };
    const historyBefore = loadHistory().length;
    press('escape');
    press('y');
    expect(game.screen.constructor.name).toBe('MainMenuScreen');
    // the operation is untouched: the battle can be re-fought from Continue Operation
    expect(game.operation.index).toBe(0);
    expect(loadHistory().length).toBe(historyBefore);
  });

  it('CTRL+S mutes and unmutes the sound bus', () => {
    const { press } = setup();
    game.audio = fakeAudio();
    press('s', { ctrlKey: true });
    expect((game.audio as unknown as { muted: boolean }).muted).toBe(true);
    press('s', { ctrlKey: true });
    expect((game.audio as unknown as { muted: boolean }).muted).toBe(false);
  });

  it('CTRL+T hides and restores tree canopies on the battle renderer', () => {
    const { screen, press } = setup();
    const terrain = (screen as unknown as { terrain: { showTrees: boolean } }).terrain;
    expect(terrain.showTrees).toBe(true);
    press('t', { ctrlKey: true });
    expect(terrain.showTrees).toBe(false);
    press('t', { ctrlKey: true });
    expect(terrain.showTrees).toBe(true);
  });
});
