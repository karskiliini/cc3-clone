import { describe, it, expect } from 'vitest';
import { stepSubordinateInitiative } from '../src/sim/initiative';
import { Rng } from '../src/shared/rng';
import type { BattleState, Soldier, Team } from '../src/shared/types';
import { createMind } from '../src/sim/mind';

function soldier(id: number, teamId: number, side: 'german' | 'soviet', overrides: Partial<Soldier> = {}): Soldier {
  return {
    id, teamId, side, name: `S${id}`, rank: 'Gefr', weaponId: 'kar98k',
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos: { x: 10, y: 10 }, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: id === 1, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(50),
    ...overrides,
  };
}

function state(): BattleState {
  const leader = soldier(1, 1, 'german');
  const men = [soldier(2, 1, 'german'), soldier(3, 1, 'german')];
  const enemy = soldier(9, 2, 'soviet');
  const team: Team = {
    id: 1, defId: 't', side: 'german', name: 'Rifle Squad', type: 'rifle',
    soldierIds: [1, 2, 3], leaderId: 1, vehicleId: null, order: null, facing: 0,
    experience: 50, morale: 80, status: 'Idle', pos: { x: 10, y: 10 }, outOfAction: false,
    kills: 0, aiObjective: null,
  };
  const eteam: Team = { ...team, id: 2, side: 'soviet', soldierIds: [9], leaderId: 9, name: 'Enemy' };
  return {
    config: { mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map: {
      width: 200, height: 150, tiles: [], windows: new Uint8Array(0), craters: [],
      smoke: new Float32Array(0), deployZones: { german: { x: 0, y: 0, w: 3, h: 3 }, soviet: { x: 196, y: 146, w: 3, h: 3 } },
      victoryLocations: [
        { id: 0, name: 'Crossroads', x: 100, y: 75, value: 3, owner: 'soviet', captureTimer: 0, capturingSide: null },
        { id: 1, name: 'Farm', x: 120, y: 60, value: 1, owner: 'german', captureTimer: 0, capturingSide: null },
      ],
    },
    phase: 'running', time: 0,
    soldiers: new Map([[1, leader], [2, men[0]], [3, men[1]], [9, enemy]]),
    teams: new Map([[1, team], [2, eteam]]),
    vehicles: new Map(),
    sides: {
      german: { side: 'german', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
      soviet: { side: 'soviet', morale: 80, truceOffered: false, truceAccepted: false, kills: 0, losses: 0, score: 0 },
    },
    spotted: { german: new Set(), soviet: new Set() },
    spottedVehicles: { german: new Set(), soviet: new Set() },
    messages: [], explosions: [], tracers: [], flashes: [], bloodDecals: [], projectiles: [], sparks: [], pendingBursts: [], structureFx: [],
    result: null, events: [], nextId: 10,
  } as unknown as BattleState;
}

describe('subordinate initiative (G18)', () => {
  it('an idle confident player team eventually acts on its own toward the enemy VL', () => {
    const s = state();
    const issued: number[] = [];
    // run enough ticks for the 0.002/tick roll to fire
    for (let i = 0; i < 3000; i++) {
      const r = stepSubordinateInitiative(s, new Rng(i), (teamId, target) => {
        issued.push(teamId);
        s.teams.get(teamId)!.order = { type: 'moveFast', target, issuedAt: s.time };
      });
      if (r) {
        expect(r.teamId).toBe(1);
        expect(r.vlId).toBe(0); // the only enemy-owned VL
        break;
      }
    }
    expect(issued).toContain(1);
  });

  it('a broken team never takes initiative', () => {
    const s = state();
    for (const id of [1, 2, 3]) s.soldiers.get(id)!.mind.state = 'broken';
    let fired = false;
    for (let i = 0; i < 3000; i++) {
      const r = stepSubordinateInitiative(s, new Rng(i), () => { fired = true; });
      if (r) break;
    }
    expect(fired).toBe(false);
  });

  it('a team under a player order (not defend) does not self-assign', () => {
    const s = state();
    s.teams.get(1)!.order = { type: 'move', target: { x: 20, y: 20 }, issuedAt: 0 };
    let fired = false;
    for (let i = 0; i < 3000; i++) {
      const r = stepSubordinateInitiative(s, new Rng(i), () => { fired = true; });
      if (r) break;
    }
    expect(fired).toBe(false);
  });
});
