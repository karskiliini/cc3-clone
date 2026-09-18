import { describe, expect, it } from 'vitest';
import { Battle } from '@/sim/battle';
import { stepVehicles } from '@/sim/vehicle';
import { angleTo, wrapAngle } from '@/shared/math';
import type { BattleConfig } from '@/shared/types';

const config: BattleConfig = {
  mapId: 'border_1941',
  playerSide: 'german',
  year: 1941,
  seed: 1,
  durationS: 120,
  difficulty: 'normal',
  forces: {
    german: ['ger_pz4f1'],
    soviet: ['sov_rifle_41'],
  },
};

describe('vehicle defend facing', () => {
  it('a tank ordered to Defend at a point turns its turret (and hull as needed) toward it', () => {
    const battle = new Battle(config);
    battle.start();
    const team = battle.selectableTeams('german').find(t => t.vehicleId != null)!;
    const v = battle.state.vehicles.get(team.vehicleId!)!;
    // start the hull at the opposite of east: a Defend order there is a half-turn for the hull
    v.hullFacing = Math.PI;
    v.turretFacing = Math.PI;
    const east = { x: v.pos.x + 20, y: v.pos.y };
    battle.issueOrder(team.id, { type: 'defend', target: east, issuedAt: battle.state.time });

    // the ordered point is the turret's lay target
    expect(v.targetPoint).toEqual(east);

    for (let i = 0; i < 600; i++) stepVehicles(battle.state, battle.rng, 1 / 30);
    const bearing = angleTo(v.pos, east);
    expect(Math.abs(wrapAngle(bearing - v.turretFacing))).toBeLessThan(0.3);
    expect(Math.abs(wrapAngle(bearing - v.hullFacing))).toBeLessThan(0.3);
  });
});
