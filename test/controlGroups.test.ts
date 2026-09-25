import { afterEach, describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { BattleScreen } from '@/ui/screens/battle';
import { game } from '@/game';
import type { InputState } from '@/shared/types';
import { ControlGroups, controlGroupKeyAction } from '@/ui/controlGroups';

const originalSettings = { ...game.settings };
afterEach(() => { game.settings = { ...originalSettings }; });

function input(keys: string[] = [], held: string[] = []): InputState {
  return {
    mouse: { x: 400, y: 300 }, buttons: { left: false, right: false, middle: false },
    clicks: [], releases: [], keysPressed: new Set(keys), keysReleased: new Set(), keysDown: new Set(held),
    wheel: 0, wheelDX: 0, wheelDY: 0, pointerInside: true,
  };
}

function setup() {
  game.settings.showUnitVision = false;
  game.settings.showDepthMap = false;
  const battle = new Battle({
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 1, durationS: 600,
    difficulty: 'normal', forces: { german: ['ger_rifle_41', 'ger_rifle_41', 'ger_rifle_41'], soviet: ['sov_rifle_41'] },
  });
  const screen = new BattleScreen(battle);
  const teams = battle.selectableTeams('german');
  const frame = (keys: string[] = [], held: string[] = []) => screen.update(0, input(keys, held));
  const click = (x: number, y: number, held: string[] = []) => {
    const event = input([], held);
    event.mouse = { x, y };
    event.clicks = [{ x, y, button: 0 }];
    event.releases = [{ x, y, button: 0 }];
    screen.update(0, event);
  };
  const fire = () => { frame(['v']); click(400, 300); };
  return { battle, teams, screen, frame, click, fire };
}

describe('battle control groups', () => {
  it('assigns Ctrl+A selection without arming the plain-A assault order', () => {
    const { teams, frame, click } = setup();
    frame(['a', 'mod+a'], ['control']);
    frame(['1', 'mod+1']);
    click(400, 300);
    expect(teams.map((t) => t.order?.type)).toEqual(['defend', 'defend', 'defend']);
  });

  it('recalls a multi-team group through the existing group-order flow', () => {
    const { teams, frame, click, fire } = setup();
    frame(['a'], ['control']);
    frame(['1', 'mod+1']); // the modifier may already be released before this frame
    click(10, 640); // select just the first team
    frame(['1']);
    fire();
    expect(teams.map((t) => t.order?.type)).toEqual(['fire', 'fire', 'fire']);
  });

  it('overwrites a group, supports group 0, and clears it with an empty selection', () => {
    const { teams, frame, click, fire } = setup();
    frame(['a'], ['control']);
    frame(['0', 'mod+0']);
    click(100, 675); // second team replaces the original three-team group
    frame(['0', 'mod+0']);
    click(165, 675);
    frame(['0']);
    fire();
    expect(teams.map((t) => t.order?.type)).toEqual(['defend', 'fire', 'defend']);
    click(500, 400); // clear the selection away from the fire-order marker
    frame(['0', 'mod+0']);
    click(165, 675);
    frame(['0']); // empty group leaves this current selection intact
    frame(['m']);
    click(400, 300);
    expect(teams.map((t) => t.order?.type)).toEqual(['defend', 'fire', 'ambush']);
  });

  it('recalls groups from the HUD and cancels an old pending order when switching groups', () => {
    const { teams, frame, click, fire } = setup();
    frame(['a'], ['control']);
    click(136, 745, ['control']);
    click(10, 675);
    frame(['v']);
    click(136, 745);
    click(400, 300);
    expect(teams.map((t) => t.order?.type)).toEqual(['defend', 'defend', 'defend']);
    click(136, 745);
    fire();
    expect(teams.map((t) => t.order?.type)).toEqual(['fire', 'fire', 'fire']);
  });

  it('removes destroyed and missing members and leaves selection alone for an empty group', () => {
    const { battle, teams, frame, click, fire } = setup();
    frame(['a'], ['control']);
    frame(['2', 'mod+2']);
    click(10, 675);
    teams[0].outOfAction = true;
    battle.state.teams.delete(teams[1].id);
    frame(['2']);
    fire();
    expect(teams.map((t) => t.order?.type)).toEqual(['defend', 'defend', 'fire']);
    teams[0].outOfAction = false;
    teams[2].outOfAction = true;
    click(10, 675);
    frame(['2']);
    fire();
    expect(teams[0].order?.type).toBe('fire');
  });
});

describe('control group HUD state', () => {
  it('shows current member counts and highlights only an exact selection match', () => {
    const groups = new ControlGroups();
    const selection = [12, 24, 12];
    groups.assign('1', selection);
    selection.push(36); // later selection changes cannot alter a saved group
    expect(groups.slots([24, 12]).find((slot) => slot.key === '1')).toEqual({ key: '1', count: 2, active: true });
    expect(groups.slots([12]).some((slot) => slot.active)).toBe(false);
    groups.prune(new Set([24]));
    expect(groups.slots([24]).find((slot) => slot.key === '1')).toEqual({ key: '1', count: 1, active: true });
    groups.prune(new Set());
    expect(groups.slots([]).find((slot) => slot.key === '1')).toEqual({ key: '1', count: 0, active: false });
  });

  it('highlights the most recently recalled group when two groups share a selection', () => {
    const groups = new ControlGroups();
    groups.assign('1', [12, 24]);
    groups.assign('0', [12, 24]);
    expect(groups.slots([12, 24]).filter((slot) => slot.active).map((slot) => slot.key)).toEqual(['0']);
    const recalled = groups.recall('1')!;
    recalled.push(36);
    expect(groups.slots([12, 24]).filter((slot) => slot.active).map((slot) => slot.key)).toEqual(['1']);
    expect(groups.recall('1')).toEqual([12, 24]);
  });

  it('does not turn order hotkeys or modified number shortcuts into group actions', () => {
    expect(controlGroupKeyAction(input(['z', 'x', 'c', 'v', 'b', 'n', 'm', 'escape']))).toBeNull();
    expect(controlGroupKeyAction(input(['1'], ['alt']))).toBeNull();
    expect(controlGroupKeyAction(input(['1'], ['shift']))).toBeNull();
    expect(controlGroupKeyAction(input(['0'], ['meta']))).toEqual({ key: '0', assign: true });
  });
});
