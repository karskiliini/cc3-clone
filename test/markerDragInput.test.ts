import { afterEach, describe, expect, it } from 'vitest';
import type { InputState, Order, Vec2 } from '@/shared/types';
import { Battle } from '@/sim/battle';
import { BattleScreen } from '@/ui/screens/battle';
import { game } from '@/game';
import { pickOrderMarker } from '@/render/orderMarkers';
import { isOrderActive } from '@/sim/orders';

const settings = { ...game.settings }, camera = { ...game.cam };
afterEach(() => { game.settings = { ...settings }; game.cam = { ...camera }; });
function input(mouse: Vec2, over: Partial<InputState> = {}): InputState {
  return { mouse, buttons: { left: false, right: false, middle: false }, clicks: [], releases: [],
    keysPressed: new Set(), keysReleased: new Set(), keysDown: new Set(), wheel: 0, wheelDX: 0, wheelDY: 0, pointerInside: true, ...over };
}
function setup(order: Partial<Order> = {}) {
  game.settings.showUnitVision = false; game.settings.showDepthMap = false; game.cam = { x: 0, y: 0, zoom: 1 };
  const battle = new Battle({ mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 1, durationS: 600,
    difficulty: 'normal', forces: { german: ['ger_rifle_41', 'ger_rifle_41'], soviet: ['sov_rifle_41'] } });
  const screen = new BattleScreen(battle), [team, other] = battle.selectableTeams('german');
  battle.issueOrder(team.id, { type: 'move', target: { x: 10, y: 10 }, issuedAt: 0, ...order });
  const original = team.order!;
  const point = (p: Vec2) => ({ x: p.x * 20, y: p.y * 20 });
  const press = (p = original.target) => { const at = point(p); screen.update(0, input(at, { buttons: { left: true, right: false, middle: false }, clicks: [{ ...at, button: 0 }] })); };
  const release = (p: Vec2, extra: Partial<InputState> = {}) => {
    const at = point(p); screen.update(0, input(at, { releases: [{ ...at, button: 0 }], ...extra }));
    battle.step(0); // paused orders are drained without advancing the simulation
  };
  return { battle, screen, team, other, original, point, press, release };
}
const drop = { x: 20, y: 15 };

describe('editing placed order markers through battle input', () => {
  it('a fast endpoint drag preserves earlier waypoints and edits only that team', () => {
    const { team, other, press, release } = setup({ waypoints: [{ x: 5, y: 6 }, { x: 8, y: 8 }] });
    press(); release(drop); // no intermediate held-button frame
    expect(team.order!.target).toEqual(drop);
    expect(team.order!.waypoints).toEqual([{ x: 5, y: 6 }, { x: 8, y: 8 }]);
    expect(other.order!.type).toBe('defend');
  });
  it('supports a full press/release drag batched into one frame', () => {
    const { screen, team } = setup();
    screen.update(0, input({ x: 400, y: 300 }, { clicks: [{ x: 200, y: 200, button: 0 }], releases: [{ x: 400, y: 300, button: 0 }] }));
    expect(team.order!.target).toEqual(drop);
  });
  it('edits an existing marker even while another order is pending', () => {
    const { screen, team, press, release } = setup({ type: 'fire' });
    screen.update(0, input({ x: 400, y: 300 }, { keysPressed: new Set(['z']) })); // pending Move
    press(); release(drop);
    expect(team.order!.type).toBe('fire'); expect(team.order!.target).toEqual(drop);
  });
  it('retargeting an enemy-linked fire marker becomes area fire at the drop point', () => {
    const { team, press, release } = setup({ type: 'fire' });
    Object.assign(team.order!, { targetTeamId: 9999, targetVehicleId: 8888, lastKnownPos: { x: 10, y: 10 }, lastSeenAt: 0 });
    press(); release(drop);
    expect(team.order!.target).toEqual(drop); expect(team.order!.targetTeamId).toBeUndefined();
    expect(team.order!.targetVehicleId).toBeUndefined(); expect(team.order!.lastKnownPos).toBeUndefined();
  });
  it('keeps completed movement endpoints available for a new destination', () => {
    const { battle, team, press, release, point } = setup(); battle.state.time = 10;
    for (const id of team.soldierIds) { const s = battle.state.soldiers.get(id)!; s.path = []; s.mind.pendingOrderAt = undefined; }
    expect(isOrderActive(battle.state, team)).toBe(false);
    expect(pickOrderMarker(battle.state, game.cam, point(team.order!.target), 'german')?.teamId).toBe(team.id);
    press(); release(drop); expect(team.order!.target).toEqual(drop);
  });
  it('supports editing during pause without advancing battle time', () => {
    const { battle, team, press, release } = setup({ type: 'fire' }); battle.state.phase = 'paused';
    press(); release(drop);
    expect(team.order!.target).toEqual(drop); expect(battle.state.time).toBe(0); expect(battle.state.phase).toBe('paused');
  });
  it('tracks the dragged waypoint when earlier points are consumed during the gesture', () => {
    const { original, team, press, release } = setup({ waypoints: [{ x: 5, y: 6 }, { x: 8, y: 8 }] });
    press(original.waypoints![1]); original.waypoints!.shift(); release(drop);
    expect(team.order!.waypoints).toEqual([drop]); expect(team.order!.target).toEqual({ x: 10, y: 10 });
  });
  it('does not edit a different point if the dragged waypoint itself is consumed', () => {
    const { original, team, press, release } = setup({ waypoints: [{ x: 5, y: 6 }, { x: 8, y: 8 }] });
    press(original.waypoints![0]); original.waypoints!.shift(); release(drop);
    expect(team.order).toBe(original); expect(team.order!.waypoints).toEqual([{ x: 8, y: 8 }]);
  });
  it('does not overwrite a replacement order of the same type', () => {
    const { team, press, release } = setup(); press();
    const replacement: Order = { type: 'move', target: { x: 25, y: 20 }, issuedAt: 0 }; team.order = replacement;
    release(drop); expect(team.order).toBe(replacement);
  });
  it('Escape cancels the edit, and a subsequent marker drag still works', () => {
    const { screen, original, team, press, release } = setup(); press();
    screen.update(0, input({ x: 300, y: 250 }, { keysPressed: new Set(['escape']) }));
    release(drop); expect(team.order).toBe(original);
    press(); release(drop); expect(team.order!.target).toEqual(drop);
  });
  it('a click without dragging and a drop onto the HUD leave the order unchanged', () => {
    const { original, team, press, release } = setup(); press(); release({ x: 10, y: 10 }); expect(team.order).toBe(original);
    press(); release({ x: 20, y: 35 }); expect(team.order).toBe(original);
  });
});
