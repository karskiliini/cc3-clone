// Item 040: the Roster screen must be reachable (menu strip Soldiers button),
// and must return to the calling screen on ESC/Back/Continue instead of always
// falling back to the operation screen. Also pins the scroll clamp bug class:
// the clamp counts rows() entries — team headers included — so the last
// soldiers can always be scrolled into view (49 entries, 16 visible → 33).
import { describe, it, expect } from 'vitest';
import { RosterScreen } from '@/ui/screens/roster';
import { BottomStrip } from '@/ui/screens/common';
import { game } from '@/game';
import { newCampaign, resetUidCounter, addTeam } from '@/campaign/roster';
import { MENU_X, MENU_Y } from '@/shared/types';
import type { InputState, Screen } from '@/shared/types';
import { TEAM_DEFS } from '@/data/units';

function inputState(over: Partial<InputState> = {}): InputState {
  return {
    mouse: { x: 0, y: 0 },
    buttons: { left: false, right: false, middle: false },
    clicks: [],
    releases: [],
    keysDown: new Set(),
    keysPressed: new Set(),
    keysReleased: new Set(),
    wheel: 0,
    wheelDX: 0,
    wheelDY: 0,
    pointerInside: true,
    ...over,
  };
}

/** Canvas-space input shifted into menu-local space, like toMenuInput does. */
function menuInput(over: Partial<InputState> = {}): InputState {
  const base = inputState(over);
  return {
    ...base,
    mouse: { x: base.mouse.x - MENU_X, y: base.mouse.y - MENU_Y },
    clicks: base.clicks.map((c) => ({ x: c.x - MENU_X, y: c.y - MENU_Y, button: c.button })),
    releases: base.releases.map((c) => ({ x: c.x - MENU_X, y: c.y - MENU_Y, button: c.button })),
  };
}


function campaignWithTeams() {
  resetUidCounter();
  const c = newCampaign(4242, 'german', 200);
  addTeam(c, 'ger_rifle_41', TEAM_DEFS['ger_rifle_41'].name, TEAM_DEFS['ger_rifle_41'].soldiers);
  addTeam(c, 'ger_mg34_hmg', TEAM_DEFS['ger_mg34_hmg'].name, TEAM_DEFS['ger_mg34_hmg'].soldiers);
  return c;
}

/** Centre of the CANVAS-space Soldiers button (menu-local {438,560,74,20}). */
const SOLDIERS_CLICK = { x: MENU_X + 438 + 37, y: MENU_Y + 560 + 10, button: 0 as const };

describe('menu BottomStrip Soldiers routing (item 040)', () => {
  it('reports soldiers: false while disabled and true once soldiersEnabled is set', () => {
    const off = new BottomStrip({ showBack: true });
    const on = new BottomStrip({ showBack: true, soldiersEnabled: true });
    const clickInput = menuInput({ clicks: [SOLDIERS_CLICK], mouse: { x: 0, y: 0 } });
    expect(off.update(clickInput).soldiers).toBe(false);
    expect(on.update(menuInput({ clicks: [SOLDIERS_CLICK], mouse: { x: 0, y: 0 } })).soldiers).toBe(true);
  });

  it('keeps the Soldiers button inert when the click lands without the flag even if the pointer hovers it', () => {
    const off = new BottomStrip({ showBack: true, soldiersEnabled: false });
    const clickInput = menuInput({ clicks: [SOLDIERS_CLICK], mouse: { x: 438 + 37, y: 560 + 10 } });
    expect(off.update(clickInput).soldiers).toBe(false);
  });
});

describe('RosterScreen (item 040)', () => {
  it('null-campaign guard: update does not throw and draw rows are empty', () => {
    const saved = game.campaign;
    game.campaign = null;
    const screen = new RosterScreen();
    expect(() => screen.update(1 / 60, inputState())).not.toThrow();
    const rows = screen['rows']();
    expect(rows).toEqual([]);
    game.campaign = saved;
  });

  it('rows() materializes one header entry per non-empty team before its soldiers, skipping empty teams', () => {
    resetUidCounter();
    const c = newCampaign(4242, 'german', 200);
    addTeam(c, 'ger_rifle_41', TEAM_DEFS['ger_rifle_41'].name, TEAM_DEFS['ger_rifle_41'].soldiers);
    const emptyTeam = addTeam(c, 'ger_mg34_hmg', TEAM_DEFS['ger_mg34_hmg'].name, []);
    const rifle = addTeam(c, 'ger_mortar81', TEAM_DEFS['ger_mortar81'].name, TEAM_DEFS['ger_mortar81'].soldiers);
    game.campaign = c;
    const screen = new RosterScreen();
    const rows = screen['rows']();
    // headers interleaved: rifle header, rifle soldiers, mortar header, mortar soldiers
    const headerTeams = rows.filter((r) => r.soldier === null).map((r) => r.team.uid);
    expect(headerTeams).toEqual([c.teams[0].uid, rifle.uid]);
    expect(headerTeams).not.toContain(emptyTeam.uid);
    expect(rows.filter((r) => r.soldier !== null).length).toBe(
      c.teams[0].soldierUids.length + rifle.soldierUids.length,
    );
    game.campaign = null;
  });

  it('scroll clamp counts header rows so the final soldiers always reach the viewport (49-16=33 class)', () => {
    resetUidCounter();
    const c = newCampaign(4242, 'german', 200);
    for (const defId of ['ger_rifle_41', 'ger_mg34_hmg', 'ger_mortar81', 'ger_pak40']) {
      const t = addTeam(c, defId, TEAM_DEFS[defId].name, TEAM_DEFS[defId].soldiers);
      void t;
    }
    game.campaign = c;
    const screen = new RosterScreen();
    const rows = screen['rows']();
    const maxVisible = Math.floor((600 - 80 - 150) / 22); // ROW_Y_MAX - ROW_Y0 over ROW_H
    const maxScroll = Math.max(0, rows.length - maxVisible);
    expect(rows.length).toBeGreaterThan(maxVisible);
    // many down-notches must clamp at maxScroll, never beyond
    for (let i = 0; i < 200; i++) {
      screen.update(1 / 60, inputState({ wheelDY: 120 }));
    }
    expect(screen['scroll']).toBe(maxScroll);
    expect(screen['scroll']).toBeLessThanOrEqual(rows.length - maxVisible);
    // one more down-notch cannot push past the clamp
    screen.update(1 / 60, inputState({ wheelDY: 120 }));
    expect(screen['scroll']).toBe(maxScroll);
    // and up-notches walk back to zero and stop there
    for (let i = 0; i < 200; i++) {
      screen.update(1 / 60, inputState({ wheelDY: -120 }));
    }
    expect(screen['scroll']).toBe(0);
    game.campaign = null;
  });

  it('ESC returns to the calling screen when one is provided, otherwise the operation screen', () => {
    game.campaign = campaignWithTeams();
    const saved = game.screen;
    const fakeBack: Screen = { update() {}, draw() {}, cursor() { return 'arrow'; } };
    game.setScreen(new RosterScreen(fakeBack));
    game.screen.update(1 / 60, inputState({ keysPressed: new Set(['escape']) }));
    expect(game.screen).toBe(fakeBack);

    const noBack = new RosterScreen();
    game.setScreen(noBack);
    game.screen.update(1 / 60, inputState({ keysPressed: new Set(['escape']) }));
    expect(game.screen).not.toBe(noBack);
    expect(game.screen.constructor.name).toBe('OperationScreen');
    game.screen = saved;
    game.campaign = null;
  });

  it('strip Continue routes back exactly like ESC', () => {
    game.campaign = campaignWithTeams();
    const saved = game.screen;
    const fakeBack: Screen = { update() {}, draw() {}, cursor() { return 'arrow'; } };
    game.setScreen(new RosterScreen(fakeBack));
    // click the Next button (canvas coords over the menu-local rect {726, 560, 58, 20})
    game.screen.update(1 / 60, inputState({ clicks: [{ x: MENU_X + 726 + 29, y: MENU_Y + 560 + 10, button: 0 }], mouse: { x: 0, y: 0 } }));
    expect(game.screen).toBe(fakeBack);
    game.screen = saved;
    game.campaign = null;
  });

describe('roster entry-point wiring (item 040)', () => {
  it('operation briefing-mode strip enables Soldiers and COA/debrief strips enable it with a campaign', async () => {
    game.campaign = campaignWithTeams();
    const { OperationScreen } = await import('@/ui/screens/operation');
    const { CoaScreen } = await import('@/ui/screens/coa');
    const { DebriefScreen } = await import('@/ui/screens/debrief');
    const { initialForcePool, OPERATION } = await import('@/data/operation');
    const op = {
      index: 0,
      playerSide: 'german' as const,
      results: [],
      forcePool: initialForcePool('german'),
      requisition: OPERATION[0].requisition.german,
    };
    game.operation = op;
    const opScreen = new OperationScreen();
    expect(opScreen['mode']).toBe('briefing');
    expect(opScreen['strip'].soldiersEnabled).toBe(true);

    const coa = new CoaScreen();
    expect(coa['strip'].soldiersEnabled).toBe(true);

    const debrief = new DebriefScreen({} as never);
    expect(debrief['strip'].soldiersEnabled).toBe(true);

    game.operation = null;
    game.campaign = null;
  });
});
});
