import { describe, it, expect } from 'vitest';
import type { BattleConfig, BattleState, GameMap, MapDef, Soldier, Team, Vec2 } from '@/shared/types';
import { MapPainter } from '@/sim/mapdsl';
import { buildMap, idx } from '@/sim/map';
import { WEAPONS } from '@/data/weapons';
import { createMind } from '@/sim/mind';
import { applyBlastDamage, buildingStatus, roofHp, ROOF_HP, structureHp, STRUCTURE_HP } from '@/sim/structures';
import { Battle } from '@/sim/battle';
import { applyOrder } from '@/sim/orders';
import { stepCombat } from '@/sim/combat';
import { Rng } from '@/shared/rng';
import { SIM_DT } from '@/shared/types';

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

// ---------------------------------------------------------------------------------------------
// The subsystem has to be reachable from an ORDER, not just from a direct applyBlastDamage call:
// round 5's live battle put 12+ mortar rounds onto a wooden farm building and produced zero wall
// conversions and zero messages.
// ---------------------------------------------------------------------------------------------

function countTiles(map: GameMap, t: string): number {
  let n = 0;
  for (const x of map.tiles) if (x === t) n++;
  return n;
}

/** Steps the battle a second at a time until `rounds` mortar rounds have burst (or time runs out). */
function fireMission(b: Battle, rounds: number): number {
  const st = b.state;
  let fired = 0;
  for (let s = 0; s < 900 && fired < rounds; s++) {
    const n0 = st.events.length;
    b.step(1);
    for (let i = n0; i < st.events.length; i++) {
      const e = st.events[i];
      if (e.kind === 'explosion' && e.weaponId === 'mortar81') fired++;
    }
  }
  return fired;
}

/** The biggest wooden building on the map, with its centre and its wall/floor tile counts.
 * Found by scanning, so this test follows src/data/maps/* as the map authors move the farm. */
function biggestWoodBuilding(map: GameMap): { bid: number; centre: Vec2; walls: number; floors: number } {
  const recs = new Map<number, { walls: number[]; floors: number[] }>();
  for (let i = 0; i < map.tiles.length; i++) {
    const bid = map.buildingId[i];
    if (bid < 0) continue;
    let r = recs.get(bid);
    if (!r) { r = { walls: [], floors: [] }; recs.set(bid, r); }
    if (map.tiles[i] === 'buildingWood') r.walls.push(i);
    else if (map.tiles[i] === 'floor') r.floors.push(i);
    else if (map.tiles[i] === 'buildingStone') r.walls.length = -1 >>> 31; // never: stone disqualifies
  }
  let best = -1, bestR = { walls: [] as number[], floors: [] as number[] };
  for (const [bid, r] of recs) {
    if (r.floors.length === 0) continue;
    if (r.walls.length + r.floors.length > bestR.walls.length + bestR.floors.length) { best = bid; bestR = r; }
  }
  expect(best).toBeGreaterThanOrEqual(0);
  let sx = 0, sy = 0;
  const all = [...bestR.walls, ...bestR.floors];
  for (const i of all) { sx += (i % map.width) + 0.5; sy += ((i / map.width) | 0) + 0.5; }
  return { bid: best, centre: { x: sx / all.length, y: sy / all.length }, walls: bestR.walls.length, floors: bestR.floors.length };
}

describe('a mortar fire mission on a wooden building is felt in play', () => {
  it('breaches walls, caves the roof in and reports it', () => {
    const config: BattleConfig = {
      mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 5, durationS: 3600,
      difficulty: 'normal', forces: { german: ['ger_mortar81'], soviet: [] },
    };
    const b = new Battle(config);
    b.start();
    const st = b.state, map = st.map;

    const farm = biggestWoodBuilding(map);
    expect(farm.walls).toBeGreaterThan(8);
    expect(buildingStatus(map, farm.bid)).toBe('intact');
    const walls0 = countTiles(map, 'buildingWood');
    const floors0 = countTiles(map, 'floor');

    // the crew is dug in ~70 m short of the farm, as a player's mortar would be
    const team = [...st.teams.values()].find((t) => t.type === 'mortar')!;
    const gunLine = { x: farm.centre.x, y: Math.min(map.height - 2, farm.centre.y + 35) };
    for (const id of team.soldierIds) st.soldiers.get(id)!.pos = { ...gunLine };
    team.pos = { ...gunLine };
    applyOrder(st, team, { type: 'fire', target: { ...farm.centre }, issuedAt: st.time }, b.rng);

    // the crew shoots off its whole load (its ammo, not the clock, ends the mission)
    expect(fireMission(b, 40)).toBeGreaterThanOrEqual(24);

    // walls converted to rubble, roof holes punched, and the building came down
    expect(countTiles(map, 'buildingWood')).toBeLessThan(walls0);
    expect(countTiles(map, 'floor')).toBeLessThan(floors0);
    expect(countTiles(map, 'rubble')).toBeGreaterThan(0);
    expect(buildingStatus(map, farm.bid)).toBe('ruined');

    // and the player, whose order it was, is told — even though his nearest man is 35 tiles away
    expect(st.messages.some((m) => m.text === 'Wall breached.')).toBe(true);
    expect(st.messages.some((m) => m.text === 'Wooden house has collapsed.')).toBe(true);
  });
});

describe('direct-fire HE from a gun crew', () => {
  function gunState(): { st: BattleState; map: GameMap; team: Team } {
    const map = mapWith((p) => p.building(20, 10, 8, 6, 'wood'));
    const st = stateWith(map, 0);
    const team = {
      id: 2, defId: 'atgun', side: 'german', name: 'PaK 38', type: 'atgun', soldierIds: [], leaderId: 21,
      vehicleId: null, order: null, facing: 0, experience: 70, morale: 80, status: 'Idle',
      pos: { x: 23.5, y: 24.5 }, outOfAction: false, kills: 0, aiObjective: null,
    } as unknown as Team;
    st.teams.set(2, team);
    const gunner = {
      id: 21, teamId: 2, side: 'german', name: 'Krause', rank: 'Gefr', weaponId: 'pak38', ammo: 20, ammoReserve: 20,
      grenades: 0, health: 'healthy', morale: 80, fatigue: 0, suppression: 0, experience: 70, stance: 'standing',
      activity: 'defending', pos: { x: 23.5, y: 24.5 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
      targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0, isLeader: true, vehicleId: null,
      formationOffset: { x: 0, y: 0 }, lastFiredAt: -Infinity, cover: 0, kills: 0, mind: createMind(70),
    } as unknown as Soldier;
    st.soldiers.set(21, gunner);
    team.soldierIds.push(21);
    return { st, map, team };
  }

  it("breaches the wall facing the gun, not the far wall", () => {
    const { st, map, team } = gunState();
    // the building's south wall is at y = 15, the gun is south of it at y = 24.5
    const south = { x: 23, y: 15 }, north = { x: 23, y: 10 };
    expect(map.tiles[idx(map, south.x, south.y)]).toBe('buildingWood');
    expect(map.tiles[idx(map, north.x, north.y)]).toBe('buildingWood');
    applyOrder(st, team, { type: 'fire', target: { x: 23.5, y: 15.5 }, issuedAt: 0 }, new Rng(1));

    const rng = new Rng(4);
    for (let i = 0; i < 40 * 20 && map.tiles[idx(map, south.x, south.y)] === 'buildingWood'; i++) {
      st.time = Math.round((st.time + SIM_DT) * 1000) / 1000;
      stepCombat(st, rng, SIM_DT);
    }
    // the near wall is down...
    expect(map.tiles[idx(map, south.x, south.y)]).toBe('rubble');
    // ...and the far wall, shielded from the blast by the burst, is not
    expect(map.tiles[idx(map, north.x, north.y)]).toBe('buildingWood');
    expect(structureHp(map, north.x, north.y)).toBe(STRUCTURE_HP.buildingWood);
  });

  it('flattens a hedge it bursts on', () => {
    const map = mapWith((p) => p.rect(18, 15, 8, 1, 'hedge'));
    const st = stateWith(map, 10);
    expect(map.tiles[idx(map, 22, 15)]).toBe('hedge');
    applyBlastDamage(st, { x: 22.5, y: 15.5 }, WEAPONS.pak38, { side: 'german' });
    expect(map.tiles[idx(map, 22, 15)]).toBe('open');
  });
});
