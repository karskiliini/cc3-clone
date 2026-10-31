import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BattleScreen } from '@/ui/screens/battle';
import { Battle } from '@/sim/battle';
import { createInput } from '@/engine/input';
import { game } from '@/game';

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
  delete (globalThis as { window?: unknown }).window;
});

function event(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, Object.fromEntries(Object.entries(props).map(([name, value]) => [name, { value }])));
  events.dispatchEvent(e);
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
  const key = (type: 'keydown' | 'keyup', key: string, props: Record<string, unknown> = {}) =>
    event(type, { key, repeat: false, ctrlKey: false, metaKey: false, ...props });
  const press = (name: string, props: Record<string, unknown> = {}) => {
    key('keydown', name, props); key('keyup', name, props); frame();
  };
  const click = (x: number, y: number, advance = true) => {
    const props = { clientX: x, clientY: y, button: 0, shiftKey: input.state.keysDown.has('shift') };
    event('mousemove', props); event('mousedown', props); event('mouseup', props);
    if (advance) frame();
  };
  press('a', { ctrlKey: true }); // Select through the actual battle UI.
  return { battle, team: battle.selectableTeams('german')[0], screen, input, key, press, frame, click };
}

describe('finishing movement waypoints by releasing Shift', () => {
  it.each([['z', 'move'], ['x', 'moveFast'], ['c', 'sneak']])('%s keeps the placed route and finishes without another click', (hotkey, type) => {
    const { team, screen, key, press, frame, click } = setup();
    press(hotkey);
    key('keydown', 'Shift');
    click(300, 220);
    click(420, 260);
    expect(team.order?.type).toBe('defend');
    event('mousemove', { clientX: 700, clientY: 500 });
    key('keyup', 'Shift'); frame();
    expect(team.order).toMatchObject({ type, target: { x: 21, y: 13 }, waypoints: [{ x: 15, y: 11 }] });
    expect(screen.cursor()).not.toBe('crosshair');
    const issued = team.order;
    click(500, 400);
    expect(team.order).toBe(issued); // Later clicks cannot append to the finished command.
  });

  it('uses a single placed waypoint as the destination with no duplicate intermediate point', () => {
    const { team, key, press, frame, click } = setup();
    press('z'); key('keydown', 'Shift'); click(300, 220);
    key('keyup', 'Shift'); frame();
    expect(team.order).toMatchObject({ type: 'move', target: { x: 15, y: 11 } });
    expect(team.order?.waypoints ?? []).toEqual([]);
  });

  it('retains the last Shift-click when its mouse release and Shift release arrive in one frame', () => {
    const { team, key, press, frame, click } = setup();
    press('z'); key('keydown', 'Shift'); click(300, 220);
    click(420, 260, false);
    key('keyup', 'Shift'); frame();
    expect(team.order).toMatchObject({ type: 'move', target: { x: 21, y: 13 }, waypoints: [{ x: 15, y: 11 }] });
  });

  it('finishes even if Shift is pressed again before the next frame', () => {
    const { team, screen, key, press, frame, click } = setup();
    press('z'); key('keydown', 'Shift'); click(300, 220);
    key('keyup', 'Shift'); key('keydown', 'Shift'); frame();
    expect(team.order).toMatchObject({ type: 'move', target: { x: 15, y: 11 } });
    expect(screen.cursor()).not.toBe('crosshair');
  });

  it('keeps targeting when Shift is released before any waypoint has been placed', () => {
    const { team, screen, key, press, frame, click } = setup();
    press('z'); key('keydown', 'Shift'); key('keyup', 'Shift'); frame();
    expect(team.order?.type).toBe('defend');
    expect(screen.cursor()).toBe('crosshair');
    click(300, 220);
    expect(team.order).toMatchObject({ type: 'move', target: { x: 15, y: 11 } });
  });

  it('lets Escape cancel before Shift release instead of issuing the staged route', () => {
    const { team, screen, key, press, frame, click } = setup();
    press('z'); key('keydown', 'Shift'); click(300, 220);
    key('keydown', 'Escape'); key('keyup', 'Shift'); frame();
    expect(team.order?.type).toBe('defend');
    expect(screen.cursor()).not.toBe('crosshair');
  });

  it('does not mistake window blur for a deliberate Shift release', () => {
    const { team, screen, key, press, frame, click } = setup();
    press('z'); key('keydown', 'Shift'); click(300, 220);
    event('blur'); frame();
    expect(team.order?.type).toBe('defend');
    expect(screen.cursor()).toBe('crosshair');
  });
});
