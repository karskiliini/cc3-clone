import { describe, it, expect } from 'vitest';
import { blastCrew, resolveVehicleHit } from '@/sim/vehicleDamage';
import type { Vehicle, Soldier, Team } from '@/shared/types';
import { Rng } from '@/shared/rng';

const M = (): any => ({ state: 'steady', motivation: 80, stress: 10, fear: 5, beliefs: [], threatDir: null, threatLevel: 0, lastIncomingAt: -999, hesitation: 0, surrounded: false, helpless: false, stateSince: 0, suppression: 0 });

function rig(outcome: string): { state: any; v: Vehicle; soldiers: Soldier[]; team: Team } {
  const soldiers: Soldier[] = [1, 2, 3, 4].map((id) => ({
    id, teamId: 1, side: 'german', name: `Man ${id}`, rank: 'Pvt', health: 'healthy', activity: 'idle',
    stance: 'crouching', pos: { x: 10, y: 10 }, vehicleId: 1, experience: 50, morale: 80,
    mind: M(), facing: 0, path: [],
  })) as unknown as Soldier[];
  const v: Vehicle = {
    id: 1, teamId: 1, side: 'german', defId: 'pz4gh', pos: { x: 10, y: 10 }, hullFacing: 0,
    turretFacing: 0, state: 'knockedOut', deathOutcome: outcome, mainAmmo: 40, coaxAmmo: 100,
    bowAmmo: 100, path: [], speed: 0,
  } as unknown as Vehicle;
  const team = { id: 1, side: 'german', name: 'Zug', soldierIds: [1, 2, 3, 4], leaderId: 1 } as unknown as Team;
  const state: any = {
    time: 10, teams: new Map([[1, team]]), config: { playerSide: 'german' },
    map: { def: { vectors: [], labels: [] }, width: 24, height: 24, tiles: new Array(576).fill('open'), buildingId: new Int16Array(576).fill(-1), windows: new Uint8Array(576), smoke: new Float32Array(576), craters: [], ground: new Float32Array(576) },
    sides: { german: { kills: 0, losses: 0 }, soviet: { kills: 0, losses: 0 } },
    vehicles: new Map([[1, v]]), soldiers: new Map(soldiers.map((s) => [s.id, s])),
    events: [], messages: [], explosions: [], spotted: { german: new Set(), soviet: new Set() }, spottedVehicles: { german: new Set(), soviet: new Set() }, spottedBy: { german: new Map(), soviet: new Map() },
  };
  return { state, v, soldiers, team };
}

const tally = (soldiers: Soldier[]) => ({
  dead: soldiers.filter((s) => s.health === 'dead').length,
  un: soldiers.filter((s) => s.health === 'incapacitated').length,
  wounded: soldiers.filter((s) => s.health === 'wounded').length,
  ok: soldiers.filter((s) => s.health === 'healthy').length,
});

describe('blastCrew (item 015): the killing blast strikes the crew still aboard', () => {
  it('a rack explosion leaves almost nobody standing', () => {
    let maxOk = 0, minDestroyed = 4;
    for (let seed = 1; seed <= 30; seed++) {
      const { state, v, soldiers, team } = rig('explosion');
      blastCrew(state, new Rng(seed), v, team, 'soviet');
      const t = tally(soldiers);
      maxOk = Math.max(maxOk, t.ok);
      minDestroyed = Math.min(minDestroyed, t.dead + t.un);
    }
    expect(maxOk).toBeLessThanOrEqual(1);
    expect(minDestroyed).toBeGreaterThanOrEqual(2);
  });

  it('a turret blow-out maims the turret crew, spares the hull crew mostly', () => {
    let turretMenHurt = 0, hullMenHurt = 0, runs = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { state, v, soldiers, team } = rig('turretBlown');
      blastCrew(state, new Rng(seed), v, team, 'soviet');
      const hurt = soldiers.map((s) => s.health !== 'healthy');
      runs++;
      turretMenHurt += hurt.slice(0, 3).filter(Boolean).length;
      hullMenHurt += hurt.slice(3).filter(Boolean).length;
    }
    expect(turretMenHurt / (runs * 3)).toBeGreaterThan(0.7);
    expect(hullMenHurt / runs).toBeLessThan(0.5);
  });

  it('a hatch/fire death wounds about half, kills almost none outright', () => {
    let dead = 0, wounded = 0, runs = 0;
    for (const outcome of ['fire', 'hatchBlown'] as const) {
      for (let seed = 1; seed <= 30; seed++) {
        const { state, v, soldiers, team } = rig(outcome);
        blastCrew(state, new Rng(seed), v, team, 'soviet');
        runs++;
        dead += tally(soldiers).dead;
        wounded += tally(soldiers).wounded;
      }
    }
    expect(dead / (runs * 4)).toBeLessThan(0.05);
    const w = wounded / (runs * 4);
    expect(w).toBeGreaterThan(0.25);
    expect(w).toBeLessThan(0.75);
  });

  it('a quiet stop hurts nobody', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { state, v, soldiers, team } = rig('stopped');
      blastCrew(state, new Rng(seed), v, team, 'soviet');
      expect(soldiers.every((s) => s.health === 'healthy')).toBe(true);
    }
  });

});
