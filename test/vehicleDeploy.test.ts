// wf19: auto-deployed vehicles must never overlap — at least hull length + 4 m apart, on
// vehicle-passable ground inside their deploy zone, facing the enemy.
import { describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { aiDeploy } from '@/sim/ai';
import { isPassable } from '@/sim/path';
import { formationBaseHeading, spaceOutVehicles, vehicleDeploySpacing, VEHICLE_DEPLOY_GAP_M } from '@/sim/spawn';
import { VEHICLE_DEFS } from '@/data/units';
import { TILE_M } from '@/shared/types';
import type { BattleConfig, BattleState, Side } from '@/shared/types';

const MAPS = ['border_1941', 'village_1942', 'steppe_1943', 'moscow_1941'];

function cfg(mapId: string, seed: number): BattleConfig {
  return {
    mapId, playerSide: 'german', year: 1942, seed, durationS: 120, difficulty: 'normal',
    forces: {
      german: ['ger_rifle_41', 'ger_pz3j', 'ger_pz3j', 'ger_pz4f1', 'ger_sdkfz251'],
      soviet: ['sov_rifle_41', 'sov_t34_76', 'sov_t34_76', 'sov_kv1', 'sov_t70'],
    },
  };
}

function expectSpaced(state: BattleState, side: Side): void {
  const vs = Array.from(state.vehicles.values()).filter((v) => v.side === side);
  expect(vs.length).toBe(4);
  const zone = state.map.def.deployZones[side];
  const heading = formationBaseHeading(state.map, side);
  for (const v of vs) {
    expect(isPassable(state.map, Math.floor(v.pos.x), Math.floor(v.pos.y), 'vehicle')).toBe(true);
    expect(v.pos.x >= zone.x && v.pos.x < zone.x + zone.w && v.pos.y >= zone.y && v.pos.y < zone.y + zone.h).toBe(true);
    expect(v.hullFacing).toBeCloseTo(heading, 6);
    expect(v.turretFacing).toBeCloseTo(heading, 6);
    const team = state.teams.get(v.teamId)!;
    expect(team.pos).toEqual(v.pos);
    for (const sid of team.soldierIds) expect(state.soldiers.get(sid)!.pos).toEqual(v.pos);
  }
  for (let i = 0; i < vs.length; i++) {
    for (let k = i + 1; k < vs.length; k++) {
      const a = vs[i], b = vs[k];
      const dM = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) * TILE_M;
      const need = Math.max(VEHICLE_DEFS[a.defId].lengthM, VEHICLE_DEFS[b.defId].lengthM) + VEHICLE_DEPLOY_GAP_M;
      expect(dM).toBeGreaterThanOrEqual(need - 1e-6);
    }
  }
}

describe('vehicle auto-deployment spacing', () => {
  it('spacing rule is the longer hull + 4 m, in tiles', () => {
    expect(vehicleDeploySpacing('pz3j', 'kv1') * TILE_M).toBeCloseTo(VEHICLE_DEFS.kv1.lengthM + 4, 6);
  });

  for (const mapId of MAPS) {
    it(`${mapId}: initial deployment, AI deployment and the player's Auto never overlap vehicles`, () => {
      for (const seed of [1, 2, 3, 7, 11]) {
        const battle = new Battle(cfg(mapId, seed));
        expectSpaced(battle.state, 'german');
        expectSpaced(battle.state, 'soviet');
        // the deploy screen's Auto button, pressed repeatedly
        for (let n = 0; n < 3; n++) {
          aiDeploy(battle.state, 'german', battle.rng, battle);
          expectSpaced(battle.state, 'german');
        }
      }
    });
  }

  it('pulls apart vehicles stacked on one tile, staggered rather than in one line', () => {
    const battle = new Battle(cfg('border_1941', 5));
    const state = battle.state;
    const vs = Array.from(state.vehicles.values()).filter((v) => v.side === 'german');
    const at = { x: vs[0].pos.x, y: vs[0].pos.y };
    for (const v of vs) v.pos = { x: at.x, y: at.y };
    spaceOutVehicles(state, 'german');
    expectSpaced(state, 'german');
    expect(vs[0].pos).toEqual(at); // the first keeps its place
    const h = formationBaseHeading(state.map, 'german');
    const fx = Math.sin(h), fy = -Math.cos(h);
    const along = vs.map((v) => Math.round((v.pos.x * fx + v.pos.y * fy) * 10) / 10);
    const across = vs.map((v) => Math.round((-v.pos.x * fy + v.pos.y * fx) * 10) / 10);
    expect(new Set(along).size).toBeGreaterThan(1);
    expect(new Set(across).size).toBeGreaterThan(1);
  });

  it('is deterministic and leaves the random stream alone', () => {
    const a = new Battle(cfg('border_1941', 9)), b = new Battle(cfg('border_1941', 9));
    spaceOutVehicles(a.state, 'german');
    const pa = Array.from(a.state.vehicles.values()).map((v) => [v.pos.x, v.pos.y]);
    const pb = Array.from(b.state.vehicles.values()).map((v) => [v.pos.x, v.pos.y]);
    expect(pa).toEqual(pb);
    expect(a.rng.next()).toBe(b.rng.next());
  });
});
