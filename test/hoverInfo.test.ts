import { describe, expect, it } from 'vitest';
import { buildingLabel, hoverInfoAt, placeLabelAt, readoutOrigin, terrainLabel, vehicleLabel } from '@/ui/hoverInfo';
import { targetCursorKind, targetStatusText, targetableEnemyAt } from '@/ui/targetHover';
import { enemyVehicleNameTags } from '@/render/unitRender';
import { addTank, makeState, mkTeam, soldier } from './vehicleDamageHelpers';
import type { BattleState } from '@/shared/types';

function wallAcross(state: BattleState, x: number): void {
  for (let y = 0; y < state.map.height; y++) state.map.tiles[y * state.map.width + x] = 'buildingStone';
}

describe('pointer hover label', () => {
  it('names the ground by terrain and season', () => {
    expect(terrainLabel('crops', 'summer')).toBe('Wheat field');
    expect(terrainLabel('woods', 'summer')).toBe('Woods');
    expect(terrainLabel('pavedroad', 'autumn')).toBe('Road');
    expect(terrainLabel('open', 'winter')).toBe('Snow');
    expect(terrainLabel('trench', 'winter')).toBe('Trench');
  });

  it('names buildings by material and size', () => {
    expect(buildingLabel(false, 12)).toBe('Shed');
    expect(buildingLabel(false, 24)).toBe('Wooden house');
    expect(buildingLabel(false, 35)).toBe('Barn');
    expect(buildingLabel(true, 40)).toBe('Stone house');
    const state = makeState();
    const { map } = state;
    for (let y = 10; y < 15; y++) for (let x = 10; x < 17; x++) {
      const i = y * map.width + x;
      map.tiles[i] = x === 10 || x === 16 || y === 10 || y === 14 ? 'buildingWood' : 'floor';
      map.buildingId[i] = 0;
    }
    expect(placeLabelAt(map, { x: 13.5, y: 12.5 })).toBe('Barn');
    map.tiles[50 * map.width + 50] = 'crater';
    expect(placeLabelAt(map, { x: 50.5, y: 50.5 })).toBe('Crater');
    map.victoryLocations.push({ id: 0, name: 'Church', x: 80, y: 80, value: 3, owner: null, captureTimer: 0, capturingSide: null });
    expect(placeLabelAt(map, { x: 81, y: 80 })).toBe('Church');
  });

  it('names own men by their team, and enemy men only while spotted', () => {
    const state = makeState();
    state.soldiers.set(1, soldier(1, 1, 'german', { x: 10, y: 10 }, 'kar98k'));
    const own = mkTeam(1, 'rifle', [1], 'german', { x: 10, y: 10 }); own.name = 'Rifle Squad';
    state.teams.set(1, own);
    state.soldiers.set(2, soldier(2, 2, 'soviet', { x: 30, y: 10 }, 'mosin'));
    const foe = mkTeam(2, 'sniper', [2], 'soviet', { x: 30, y: 10 }); foe.name = 'Sniper';
    state.teams.set(2, foe);
    expect(hoverInfoAt(state, 'german', { x: 10.2, y: 10 })).toMatchObject({ text: 'Rifle Squad', tone: 'own' });
    // hidden: reads as the ground he lies on
    expect(hoverInfoAt(state, 'german', { x: 30, y: 10 })).toMatchObject({ text: 'Open ground', tone: 'place' });
    state.spotted.german.add(2);
    expect(hoverInfoAt(state, 'german', { x: 30, y: 10 })).toMatchObject({ text: 'Sniper', tone: 'enemy' });
    state.soldiers.get(2)!.health = 'dead';
    expect(hoverInfoAt(state, 'german', { x: 30, y: 10 })).toMatchObject({ text: 'Dead', tone: 'dead' });
    expect(hoverInfoAt(state, 'german', { x: 30, y: 10 }, 20, false)?.text).toBe('Open ground');
  });

  it('names vehicles, their state, and never an unspotted enemy one', () => {
    const state = makeState();
    const { v: own } = addTank(state, 'pz4gh', { x: 10, y: 10 });
    const { v: foe } = addTank(state, 't34_76', { x: 40, y: 10 });
    expect(hoverInfoAt(state, 'german', { x: 10, y: 11 })).toMatchObject({ text: 'PzKw IV H', tone: 'own' });
    expect(hoverInfoAt(state, 'german', { x: 40, y: 11 })?.text).toBe('Open ground');
    expect(enemyVehicleNameTags(state, 'german')).toEqual([]);
    state.spottedVehicles.german.add(foe.id);
    expect(hoverInfoAt(state, 'german', { x: 40, y: 11 })).toMatchObject({ text: 'T-34/76', tone: 'enemy' });
    expect(enemyVehicleNameTags(state, 'german').map((t) => t.text)).toEqual(['T-34/76']);
    foe.state = 'burning';
    expect(hoverInfoAt(state, 'german', { x: 40, y: 11 })).toMatchObject({ text: 'T-34/76 (burning)', tone: 'dead' });
    expect(enemyVehicleNameTags(state, 'german')).toEqual([]);
    own.state = 'immobilized';
    expect(vehicleLabel(own, 'german')).toBe('PzKw IV H (immobilized)');
    foe.state = 'immobilized';
    expect(vehicleLabel(foe, 'german')).toBe('T-34/76');
  });

  it('keeps the readout below the hovered unit and inside the view', () => {
    expect(readoutOrigin({ x: 100, y: 100 }, 40)).toEqual({ x: 116, y: 118 });
    expect(readoutOrigin({ x: 100, y: 100 }, 40, { clearBelowY: 140 })).toEqual({ x: 116, y: 144 });
    expect(readoutOrigin({ x: 100, y: 100 }, 40, { bigCursor: true }).y).toBeGreaterThan(100 + 24);
    expect(readoutOrigin({ x: 1010, y: 100 }, 40).x + 40).toBeLessThan(1010);
  });
});

describe('fire-order aiming cross over armour', () => {
  function duel() {
    const state = makeState(1941);
    const me = addTank(state, 'pz3j', { x: 10.5, y: 10.5 }, Math.PI / 2);
    const foe = addTank(state, 't26', { x: 30.5, y: 10.5 }, -Math.PI / 2);
    state.spottedVehicles.german.add(foe.v.id);
    return { state, me, foe };
  }

  it('shows the penetration colour with a line of fire', () => {
    const { state, me } = duel();
    const h = targetableEnemyAt(state, 'german', [me.team], { x: 30.5, y: 10.5 })!;
    expect(h).toMatchObject({ lof: true, pen: 'likely' });
    expect(targetCursorKind(h)).toBe('targetLikely');
    expect(targetStatusText(h)).toBeNull();
  });

  it('keeps the cross, and its colour, with no line of fire', () => {
    const { state, me } = duel();
    wallAcross(state, 20);
    const h = targetableEnemyAt(state, 'german', [me.team], { x: 30.5, y: 10.5 })!;
    expect(h).toMatchObject({ lof: false, pen: 'likely', cls: 'blocked' });
    expect(targetCursorKind(h)).toBe('targetLikelyBlocked');
    expect(targetStatusText(h)).toBe('no line of fire');
  });

  it('a hopeless angle stays black whether or not it can be seen', () => {
    const state = makeState(1941);
    // a halftrack's machine gun against a KV-1: nothing to hope for from any side
    const me = addTank(state, 'sdkfz251', { x: 10.5, y: 10.5 }, Math.PI / 2);
    const kv = addTank(state, 'kv1', { x: 60.5, y: 10.5 }, -Math.PI / 2);
    state.spottedVehicles.german.add(kv.v.id);
    expect(targetCursorKind(targetableEnemyAt(state, 'german', [me.team], kv.v.pos)!)).toBe('targetNone');
    wallAcross(state, 50);
    expect(targetCursorKind(targetableEnemyAt(state, 'german', [me.team], kv.v.pos)!)).toBe('targetNoneBlocked');
  });

  it('marks a spotted wreck as dead, and still offers nothing for hidden ones', () => {
    const { state, me, foe } = duel();
    foe.v.state = 'burning';
    const h = targetableEnemyAt(state, 'german', [me.team], { x: 30.5, y: 10.5 })!;
    expect(h.dead).toBe('burning');
    expect(targetCursorKind(h)).toBe('targetDead');
    expect(targetStatusText(h)).toBe('burning');
    foe.v.state = 'knockedOut';
    expect(targetStatusText(targetableEnemyAt(state, 'german', [me.team], { x: 30.5, y: 10.5 })!)).toBe('KO');
    state.spottedVehicles.german.clear();
    expect(targetableEnemyAt(state, 'german', [me.team], { x: 30.5, y: 10.5 })).toBeNull();
  });

  it('soft targets behind a wall are still not offered', () => {
    const { state, me } = duel();
    state.soldiers.set(1, soldier(1, 1, 'soviet', { x: 30.5, y: 20.5 }, 'mosin'));
    state.teams.set(1, mkTeam(1, 'rifle', [1], 'soviet', { x: 30.5, y: 20.5 }));
    state.spotted.german.add(1);
    expect(targetCursorKind(targetableEnemyAt(state, 'german', [me.team], { x: 30.5, y: 20.5 })!)).toBe('target');
    wallAcross(state, 20);
    expect(targetableEnemyAt(state, 'german', [me.team], { x: 30.5, y: 20.5 })).toBeNull();
  });
});
