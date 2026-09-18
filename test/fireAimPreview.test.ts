import { describe, expect, it } from 'vitest';
import { drawLOSLine } from '@/ui/losTool';
import { createCamera } from '@/engine/camera';
import { ensureDamage } from '@/sim/vehicleDamage';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';
import type { BattleState, Team, Vec2 } from '@/shared/types';

const from = { x: 10.5, y: 10.5 }, to = { x: 30.5, y: 10.5 };

function preview(state: BattleState, team: Team, target: Vec2 = to, fireOrder = true) {
  const text: { label: string; color: string }[] = [];
  const ctx = {
    fillStyle: '', strokeStyle: '',
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
    fillText(label: string) { text.push({ label, color: this.fillStyle }); },
  };
  drawLOSLine(ctx as unknown as CanvasRenderingContext2D, createCamera(), state.map, from, target,
    { state, team }, undefined, { fireOrder });
  return text[text.length - 1];
}

function scene(screen: 'woods' | 'smoke' | 'buildingStone' = 'smoke') {
  const state = makeState();
  const gunner = soldier(1, 1, 'german', from, 'mg34');
  const team = mkTeam(1, 'rifle', [1], 'german', from);
  state.soldiers.set(1, gunner); state.teams.set(1, team);
  for (let y = 0; y < state.map.height; y++) {
    if (screen === 'smoke') state.map.smoke[y * state.map.width + 20] = 1;
    else state.map.tiles[y * state.map.width + 20] = screen;
  }
  return { state, gunner, team };
}

describe('estimated-fire aiming preview', () => {
  it.each(['woods', 'smoke'] as const)('shows a dark-green guesstimate for an MG through %s', (screen) => {
    const { state, team } = scene(screen);
    expect(preview(state, team)).toEqual({ label: '40 m guesstimate', color: '#2c7a2c' });
  });

  it('keeps hard cover and hills blocked', () => {
    const { state, team } = scene('buildingStone');
    expect(preview(state, team)).toEqual({ label: '40 m blocked', color: '#d02020' });
    state.map.tiles.fill('open');
    state.map.ground = new Float32Array(state.map.width * state.map.height);
    state.map.ground[10 * state.map.width + 20] = 10;
    expect(preview(state, team)).toEqual({ label: '40 m blocked', color: '#d02020' });
  });

  it('does not promise estimated fire from a rifle or an unavailable MG', () => {
    const { state, team, gunner } = scene();
    gunner.weaponId = 'kar98k';
    expect(preview(state, team).label).toContain('blocked');
    gunner.weaponId = 'mg34'; gunner.health = 'incapacitated';
    expect(preview(state, team).label).toContain('blocked');
    gunner.health = 'healthy'; gunner.ammo = 0; gunner.ammoReserve = 0;
    expect(preview(state, team).label).toContain('blocked');
    gunner.ammo = 20;
    expect(preview(state, team, { x: 399, y: 399 }).label).toContain('blocked');
  });

  it('keeps Smoke previews on the ordinary visibility profile', () => {
    const { state, team } = scene();
    expect(preview(state, team, to, false).label).toContain('blocked');
  });

  it('requires a live, armed vehicle weapon and respects the MG engagement range', () => {
    const { state } = scene();
    state.soldiers.clear(); state.teams.clear();
    const { v, team, crew } = addTank(state, 'pz4gh', from, Math.PI / 2);
    expect(preview(state, team).label).toContain('guesstimate');
    ensureDamage(v).mainGun = 'destroyed';
    v.coaxAmmo = 0; v.bowAmmo = 0;
    expect(preview(state, team).label).toContain('blocked');
    v.coaxAmmo = 250;
    expect(preview(state, team).label).toContain('guesstimate');
    expect(preview(state, team, { x: 250.5, y: 10.5 }).label).toContain('blocked');
    crew.forEach((s) => { s.health = 'dead'; });
    expect(preview(state, team).label).toContain('blocked');
  });
});
