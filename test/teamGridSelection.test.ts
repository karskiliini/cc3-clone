import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputState, Team } from '@/shared/types';
import { TeamGrid, sameTypeTeamIds } from '@/ui/hud/teamGrid';
import { Battle } from '@/sim/battle';
import { BattleScreen } from '@/ui/screens/battle';
import { game } from '@/game';

const settings = { ...game.settings };
afterEach(() => { vi.restoreAllMocks(); game.settings = { ...settings }; });
function team(id: number, defId = 'ger_mortar81', over: Partial<Team> = {}): Team {
  return { id, defId, type: 'mortar', side: 'german', outOfAction: false, ...over } as Team;
}
function input(x = 10, y = 680, shift = false): InputState {
  return { mouse: { x, y }, buttons: { left: false, right: false, middle: false },
    clicks: [{ x, y, button: 0 }], releases: [{ x, y, button: 0 }],
    keysPressed: new Set(), keysReleased: new Set(), keysDown: new Set(shift ? ['shift'] : []),
    wheel: 0, wheelDX: 0, wheelDY: 0, pointerInside: true };
}

describe('roster double-click detection', () => {
  it('pairs two clicks on the same unit within 350 ms and preserves Shift', () => {
    const grid = new TeamGrid(), teams = [team(1)];
    expect(grid.update(input(), teams, 1000)?.doubleClick).toBe(false);
    expect(grid.update(input(10, 680, true), teams, 1200)).toEqual({ id: 1, doubleClick: true, shift: true });
    expect(grid.update(input(), teams, 1250)?.doubleClick).toBe(false); // third click starts a new pair
  });
  it('does not double-click a replacement team appearing in the same row', () => {
    const grid = new TeamGrid(); grid.update(input(), [team(1)], 1000);
    expect(grid.update(input(), [team(2)], 1100)?.doubleClick).toBe(false);
  });
  it('follows the same team if the roster shifts its row', () => {
    const grid = new TeamGrid(), unit = team(1); grid.update(input(), [unit], 1000);
    expect(grid.update(input(80), [team(2), unit], 1100)?.doubleClick).toBe(true);
  });
  it('expires a pair and resets after an intervening map click', () => {
    const grid = new TeamGrid(), teams = [team(1)]; grid.update(input(), teams, 1000);
    expect(grid.update(input(), teams, 1400)?.doubleClick).toBe(false);
    grid.update(input(400, 300), teams, 1450);
    expect(grid.update(input(), teams, 1500)?.doubleClick).toBe(false);
  });
  it('ignores unavailable rows and processes batched clicks in input order', () => {
    const grid = new TeamGrid(), teams = [team(1, undefined, { outOfAction: true }), team(2)];
    expect(grid.update(input(), teams, 1000)).toBeNull();
    const event = input(80); event.clicks.push({ x: 80, y: 680, button: 0 });
    expect(grid.update(event, teams, 1100)).toEqual({ id: 2, doubleClick: true, shift: false });
  });
});

describe('exact catalog type selection', () => {
  it('includes renamed and distant units, excludes other calibres, enemies and unavailable units', () => {
    const source = team(2, 'ger_mortar81', { name: 'Renamed mortar' });
    const units = [team(1), source, team(3, 'sov_mortar82'), team(4, undefined, { side: 'soviet' }), team(5, undefined, { outOfAction: true })];
    expect(sameTypeTeamIds(units, source)).toEqual([2, 1]);
  });
  it('finds matching units beyond the fifteen visible roster slots', () => {
    const units = Array.from({ length: 20 }, (_, i) => team(i + 1));
    expect(sameTypeTeamIds(units, units[0])).toHaveLength(20);
  });
  it('does not mix different vehicle catalog models sharing the tank icon', () => {
    const source = team(1, 'ger_pz4g', { type: 'tank' });
    expect(sameTypeTeamIds([source, team(2, 'ger_tiger', { type: 'tank' }), team(3, 'ger_pz4g', { type: 'tank' })], source)).toEqual([1, 3]);
  });
});

function setup() {
  game.settings.showUnitVision = false; game.settings.showDepthMap = false;
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const battle = new Battle({ mapId: 'border_1941', playerSide: 'german', year: 1943, seed: 1, durationS: 600,
    difficulty: 'normal', forces: { german: ['ger_mortar81', 'ger_pak38', 'ger_mortar81', 'ger_rifle_41', 'ger_pak40'], soviet: ['sov_mortar82'] } });
  const screen = new BattleScreen(battle), teams = battle.selectableTeams('german');
  const click = (slot: number, shift = false) => { now += 100; screen.update(0, input(slot * 67 + 10, 680, shift)); };
  const fire = () => {
    const hotkey = input(); hotkey.clicks = []; hotkey.releases = []; hotkey.keysPressed.add('v'); screen.update(0, hotkey);
    screen.update(0, input(400, 300));
  };
  return { battle, screen, teams, click, fire };
}

describe('battle screen roster selection and orders', () => {
  it('double-clicks one 8cm mortar, then issues the Fire order to both mortars only', () => {
    const { screen, teams, click, fire } = setup(); click(0); expect(screen.selectionCount).toBe(1); click(0);
    expect(screen.selectionCount).toBe(2); fire();
    expect(teams.map(t => t.order?.type)).toEqual(['fire', 'defend', 'fire', 'defend', 'defend']);
  });
  it('Shift-double-click adds that exact type to the existing group', () => {
    const { screen, teams, click, fire } = setup(); click(3); click(0, true); click(0, true);
    expect(screen.selectionCount).toBe(3); fire();
    expect(teams.map(t => t.order?.type)).toEqual(['fire', 'defend', 'fire', 'fire', 'defend']);
  });
  it('PaK 38 selection excludes PaK 40, and a normal click still replaces the group', () => {
    const { screen, click } = setup(); click(1); click(1); expect(screen.selectionCount).toBe(1);
    click(0); click(0); expect(screen.selectionCount).toBe(2);
    click(3); expect(screen.selectionCount).toBe(1);
  });
});
