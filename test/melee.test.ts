import { describe, it, expect } from 'vitest';
import { stepCombat } from '../src/sim/combat';
import { Rng } from '../src/shared/rng';
import { createMind } from '../src/sim/mind';
import type { BattleState, Soldier, Team } from '../src/shared/types';

function soldier(id: number, teamId: number, side: 'german' | 'soviet', pos: { x: number; y: number }, weaponId = 'kar98k'): Soldier {
  return {
    id, teamId, side, name: `S${id}`, rank: 'Gefr', weaponId,
    ammo: 5, ammoReserve: 20, grenades: 0, health: 'healthy', morale: 80, fatigue: 0,
    suppression: 0, experience: 50, stance: 'standing', activity: 'defending',
    pos, facing: 0, targetSoldierId: null, targetVehicleId: null,
    targetPoint: null, path: [], reloadTimer: 0, fireTimer: 0, animFrame: 0,
    isLeader: id === 1, vehicleId: null, formationOffset: { x: 0, y: 0 }, lastFiredAt: -999,
    cover: 0, kills: 0, mind: createMind(50),
  };
}

function makeState(a: Soldier, b: Soldier): BattleState {
  const t: Team = {
    id: 1, defId: 't', side: 'german', name: 'G', type: 'rifle',
    soldierIds: [a.id], leaderId: a.id, vehicleId: null, order: null, facing: 0,
    experience: 50, morale: 80, status: 'Idle', pos: a.pos, outOfAction: false,
    kills: 0, aiObjective: null,
  };
  const t2: Team = { ...t, id: 2, side: 'soviet', soldierIds: [b.id], leaderId: b.id, name: 'S', pos: b.pos };
  return {
    config: { mapId: 'test', playerSide: 'german', year: 1943, seed: 1, durationS: 1200, difficulty: 'normal', forces: { german: [], soviet: [] } },
    map: { width: 50, height: 50, tiles: new Array(50 * 50).fill('open'), windows: new Uint8Array(0), craters: [], smoke: new Float32Array(0), deployZones: { german: { x: 0, y: 0, w: 3, h: 3 }, soviet: { x: 46, y: 46, w: 3, h: 3 } }, victoryLocations: [] },
    phase: 'running', time: 0,
    soldiers: new Map([[a.id, a], [b.id, b]]),
    teams: new Map([[1, t], [2, t2]]),
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

describe('hand-to-hand combat (G19)', () => {
  it('opposing infantry at grappling distance fight hand-to-hand, sometimes to the death', () => {
    const a = soldier(1, 1, 'german', { x: 10.5, y: 10.5 }, 'mp40');
    const b = soldier(2, 2, 'soviet', { x: 11.2, y: 10.3 });
    const s = makeState(a, b);
    // run long enough for a melee roll to land through the cooldowns
    let meleeMessage = false;
    for (let i = 0; i < 400; i++) {
      stepCombat(s, new Rng(i), 0.1);
      s.time += 0.1;
      if (s.messages.some((m) => m.text.includes('Hand-to-hand'))) { meleeMessage = true; break; }
    }
    expect(meleeMessage).toBe(true);
    // the victim took a hit (wounded or worse)
    const hurt = s.soldiers.get(2)!.health !== 'healthy';
    expect(hurt).toBe(true);
  });

  it('soldiers far apart never fight hand-to-hand', () => {
    const a = soldier(1, 1, 'german', { x: 10, y: 10 });
    const b = soldier(2, 2, 'soviet', { x: 40, y: 40 });
    const s = makeState(a, b);
    for (let i = 0; i < 200; i++) {
      stepCombat(s, new Rng(i), 0.1);
      s.time += 0.1;
    }
    expect(s.messages.some((m) => m.text.includes('Hand-to-hand'))).toBe(false);
  });
});
