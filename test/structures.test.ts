import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Team } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';
import { buildMap, idx } from '@/sim/map';
import { WEAPONS } from '@/data/weapons';
import { createMind } from '@/sim/mind';
import { applyBlastDamage, buildingStatus, roofHp, ROOF_HP } from '@/sim/structures';

function mapWith(paint: (p: MapPainter) => void): GameMap {
  const def: MapDef = {
    id: 'struct_test', name: 'S', description: '', width: 40, height: 40, season: 'summer',
    paint(tiles, W, H) { const p = new MapPainter(tiles, W, H, 1); p.fill('grass'); paint(p); def.decor = p.decor; def.vectors = p.vectors; },
    victoryLocations: [],
    deployZones: { german: { x: 0, y: 0, w: 5, h: 5 }, soviet: { x: 35, y: 35, w: 5, h: 5 } },
    attacker: 'soviet',
  };
  return buildMap(def);
}

function stateWith(map: GameMap, time = 20): BattleState {
  const config: BattleConfig = { mapId: 'struct_test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } };
  return {
    config, map, phase: 'running', time,
    soldiers: new Map(), teams: new Map(), vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], result: null, events: [], nextId: 100,
  } as BattleState;
}

const SURNAMES = ['Adler', 'Bauer', 'Claus', 'Dorn', 'Eber', 'Fuchs', 'Graf', 'Hahn', 'Igel', 'Jung', 'Kurz', 'Lang'];

function addSquad(st: BattleState, positions: { x: number; y: number }[]): Soldier[] {
  const team = { id: 1, defId: 'x', side: 'german', name: 'Rifle Squad', type: 'rifle', soldierIds: [], leaderId: 1, vehicleId: null, order: null, facing: 0, experience: 50, morale: 80, status: 'Idle', pos: positions[0], outOfAction: false, kills: 0, aiObjective: null } as unknown as Team;
  st.teams.set(1, team);
  return positions.map((pos, k) => {
    const s = {
      id: k + 1, teamId: 1, side: 'german', name: SURNAMES[k % SURNAMES.length], rank: 'Gefr', weaponId: 'kar98k', ammo: 5, ammoReserve: 20, grenades: 0,
      health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
      pos: { ...pos }, facing: 0, targetSoldierId: null, targetVehicleId: null, targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0,
      animFrame: 0, isLeader: k === 0, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -Infinity, cover: 0, kills: 0, mind: createMind(50),
    } as Soldier;
    st.soldiers.set(s.id, s);
    team.soldierIds.push(s.id);
    return s;
  });
}

const hurt = (ss: Soldier[]) => ss.filter((s) => s.health !== 'healthy');

function expectOneMessagePerCasualty(st: BattleState, ss: Soldier[]): void {
  for (const s of ss) {
    const n = st.messages.filter((m) => m.text.includes(`${s.rank}. ${s.name} `)).length;
    // applyHit reports incapacitation/death (once); a wound is silent
    expect(n).toBe(s.health === 'dead' || s.health === 'incapacitated' ? 1 : 0);
  }
}

describe('plunging fire and debris casualties', () => {
  it('a mortar round on a wooden roof caves it in and injures men below', () => {
    const map = mapWith((p) => p.building(10, 10, 8, 6, 'wood'));
    const st = stateWith(map);
    const under = { x: 13.5, y: 12.5 };
    expect(map.tiles[idx(map, 13, 12)]).toBe('floor');
    expect(roofHp(map, 13, 12)).toBe(ROOF_HP.wood);
    const men = addSquad(st, new Array(10).fill(under));
    applyBlastDamage(st, under, WEAPONS.mortar81);
    expect(map.tiles[idx(map, 13, 12)]).toBe('rubble');
    expect(Number.isNaN(roofHp(map, 13, 12))).toBe(true);
    // neighbours only took half the blast
    expect(map.tiles[idx(map, 14, 12)]).toBe('floor');
    expect(roofHp(map, 14, 12)).toBeLessThan(ROOF_HP.wood);
    expect(hurt(men).length).toBeGreaterThan(0);
    expect(st.messages.filter((m) => m.text === "Rifle Squad\nWe're being buried in here!").length).toBe(1);
    expectOneMessagePerCasualty(st, men);
    // stress spike for the men under it
    expect(men.filter((s) => s.health === 'healthy').every((s) => s.mind.stress > 0)).toBe(true);
  });

  it('a stone roof resists a single mortar round', () => {
    const map = mapWith((p) => p.building(10, 10, 8, 6, 'stone'));
    const st = stateWith(map);
    applyBlastDamage(st, { x: 13.5, y: 12.5 }, WEAPONS.mortar81);
    expect(map.tiles[idx(map, 13, 12)]).toBe('floor');
    expect(roofHp(map, 13, 12)).toBeLessThan(ROOF_HP.stone);
  });

  it('a wall breach injures men on the breached tile', () => {
    const map = mapWith((p) => p.building(10, 10, 8, 6, 'stone'));
    const st = stateWith(map);
    const wall = { x: 13.5, y: 10.5 };
    const men = addSquad(st, new Array(10).fill(wall));
    let n = 0;
    while (map.tiles[idx(map, 13, 10)] === 'buildingStone' && n++ < 5) applyBlastDamage(st, { x: 13.5, y: 10.1 }, WEAPONS.panzerfaust);
    expect(map.tiles[idx(map, 13, 10)]).toBe('rubble');
    expect(hurt(men).length).toBeGreaterThan(0);
    expectOneMessagePerCasualty(st, men);
  });

  it('a full collapse causes casualties and the survivors panic', () => {
    const map = mapWith((p) => p.building(10, 10, 5, 4, 'wood'));
    const st = stateWith(map);
    const bid = map.buildingId[idx(map, 11, 11)];
    const men = addSquad(st, [
      { x: 11.5, y: 11.5 }, { x: 12.5, y: 11.5 }, { x: 13.5, y: 11.5 }, { x: 11.5, y: 12.5 }, { x: 12.5, y: 12.5 }, { x: 13.5, y: 12.5 },
      { x: 11.2, y: 11.6 }, { x: 12.3, y: 12.2 },
    ]);
    applyBlastDamage(st, { x: 12.5, y: 12 }, WEAPONS.satchel);
    for (const p of [{ x: 10.5, y: 10.5 }, { x: 14.5, y: 13.5 }, { x: 10.5, y: 13.5 }]) {
      if (buildingStatus(map, bid) !== 'ruined') applyBlastDamage(st, p, WEAPONS.satchel);
    }
    expect(buildingStatus(map, bid)).toBe('ruined');
    expect(st.messages.some((m) => m.text === 'Wooden house has collapsed.')).toBe(true);
    expect(hurt(men).length).toBeGreaterThan(0);
    const standing = men.filter((s) => s.health === 'healthy' || s.health === 'wounded');
    expect(standing.length).toBeGreaterThan(0);
    for (const s of standing) expect(s.mind.state).toBe('panicked');
    expectOneMessagePerCasualty(st, men);
    // a death under the rubble is reported as crushed (once, never twice)
    const dead = men.filter((s) => s.health === 'dead');
    if (dead.length) expect(st.messages.some((m) => /was crushed by debris\.$/.test(m.text))).toBe(true);
  });
});
