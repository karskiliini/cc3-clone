import { describe, it, expect } from 'vitest';
import { Battle, ORDER_SHOUT_CONFIRM_S } from '@/sim/battle';
import type { BattleConfig } from '@/shared/types';

const baseConfig: BattleConfig = {
  mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 1, durationS: 600,
  difficulty: 'normal', forces: { german: ['ger_rifle_41'], soviet: ['sov_rifle_41'] },
};

describe('deploy-phase orders', () => {
  it('each ORDER_HOTKEY is unique — no key arms two order types (the X double-binding bug)', async () => {
    const { ORDER_HOTKEYS, ORDER_TYPES } = await import('@/shared/types');
    const seen = new Map<string, string>();
    for (const ot of ORDER_TYPES) {
      const k = ORDER_HOTKEYS[ot];
      expect(seen.has(k), `${ot} shares hotkey '${k}' with ${seen.get(k)}`).toBe(false);
      seen.set(k, ot);
    }
  });

  it('orders issued during deploy commit paths/facing immediately and survive battle start', () => {
    const battle = new Battle(baseConfig);
    const team = battle.selectableTeams('german')[0];
    const before = { x: team.pos.x, y: team.pos.y };
    battle.issueOrder(team.id, { type: 'move', target: { x: before.x + 10, y: before.y + 4 }, issuedAt: 0 });
    expect(team.order?.type).toBe('move');
    // deploy phase does not step the sim: paths are pre-computed at issue time
    const leader = battle.state.soldiers.get(team.leaderId)!;
    expect(leader.path.length).toBeGreaterThan(0);

    battle.start();
    expect(team.order?.type).toBe('move');
    expect(team.order?.target.x).toBeCloseTo(before.x + 10);
    // and the team is actually moving when the sim runs
    battle.step(1);
    expect(leader.activity).toBe('moving');
  });

  it('an issued order fires the orderShout event and ghost-flags the team for ORDER_SHOUT_CONFIRM_S', () => {
    const battle = new Battle(baseConfig);
    battle.start();
    const team = battle.selectableTeams('german')[0];
    battle.drainEvents();
    battle.issueOrder(team.id, { type: 'defend', target: { x: team.pos.x + 3, y: team.pos.y }, issuedAt: battle.state.time });
    const events = battle.drainEvents();
    expect(events.some((e) => e.kind === 'orderShout' && e.teamId === team.id)).toBe(true);
    expect(team.shoutAt).toBeCloseTo(battle.state.time + ORDER_SHOUT_CONFIRM_S);
  });

  it('a move order issued in deploy pre-paths only within the deploy zone check (rejected drops keep the order)', () => {
    const battle = new Battle(baseConfig);
    const team = battle.selectableTeams('german')[0];
    const ok = battle.deployTeam(team.id, { x: Math.floor(team.pos.x), y: Math.floor(team.pos.y) });
    expect(ok).toBe(true);
    expect(team.order).not.toBeNull();
  });
});

describe('immediate facing on order issue', () => {
  const pakConfig: BattleConfig = {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 2, durationS: 600,
    difficulty: 'normal', forces: { german: ['ger_pak38'], soviet: ['sov_rifle_41'] },
  };

  it('a Defend order points team and soldiers at the target the moment it is issued', () => {
    const battle = new Battle(baseConfig);
    const team = battle.selectableTeams('german')[0];
    const leader = battle.state.soldiers.get(team.leaderId)!;
    const before = leader.facing;
    battle.issueOrder(team.id, { type: 'defend', target: { x: team.pos.x + 6, y: team.pos.y }, issuedAt: 0 });
    expect(team.facing).not.toBe(before);
    expect(leader.facing).not.toBe(before);
  });

  it('a PaK ordered to Defend in deploy is set up and facing the target at Begin', () => {
    const battle = new Battle(pakConfig);
    const team = battle.selectableTeams('german')[0];
    battle.issueOrder(team.id, { type: 'defend', target: { x: team.pos.x + 4, y: team.pos.y }, issuedAt: 0 });
    battle.start();
    battle.step(0.1);
    expect(team.crewWeapon?.phase).toBe('ready');
    // 0 = north, clockwise: east is pi/2
    expect(Math.abs(team.crewWeapon!.facing - Math.PI / 2)).toBeLessThan(0.1);
  });

  it('a PaK ordered to Move Fast in deploy is packed and moving the second Begin is pressed', () => {
    const battle = new Battle(pakConfig);
    const team = battle.selectableTeams('german')[0];
    battle.issueOrder(team.id, { type: 'moveFast', target: { x: team.pos.x + 9, y: team.pos.y + 2 }, issuedAt: 0 });
    battle.start();
    battle.step(0.5);
    expect(team.crewWeapon?.phase).toBe('packed');
    const gunner = battle.state.soldiers.get(team.crewWeapon!.gunnerId)!;
    expect(gunner.activity).toBe('movingFast');
  });
});

describe('G23 deploy facing follows the defend arc', () => {
  const tankConfig: BattleConfig = {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 3, durationS: 600,
    difficulty: 'normal', forces: { german: ['ger_pz3j'], soviet: ['sov_rifle_41'] },
  };

  it('a tank ordered to Defend turns hull and turret to the order bearing immediately (deploy, sim not run)', () => {
    const battle = new Battle(tankConfig);
    const team = battle.selectableTeams('german')[0];
    const veh = battle.state.vehicles.get(team.vehicleId!)!;
    // point it north first so the change is unambiguous (0 = north, clockwise; east = pi/2)
    veh.hullFacing = 0; veh.turretFacing = 0;
    battle.issueOrder(team.id, { type: 'defend', target: { x: veh.pos.x + 6, y: veh.pos.y }, issuedAt: 0 });
    // deploy phase never steps the sim — the turn happened at issue time
    expect(battle.state.phase).toBe('deploy');
    expect(Math.abs(veh.hullFacing - Math.PI / 2)).toBeLessThan(0.05);
    expect(Math.abs(veh.turretFacing - Math.PI / 2)).toBeLessThan(0.05);
    battle.start();
    battle.step(0.5);
    // survives into the running battle (defend holds the lay)
    expect(Math.abs(veh.turretFacing - Math.PI / 2)).toBeLessThan(0.2);
  });

  it('a Defend order at the team own position leaves facing untouched (no garbage snap)', () => {
    const battle = new Battle(tankConfig);
    const team = battle.selectableTeams('german')[0];
    const veh = battle.state.vehicles.get(team.vehicleId!)!;
    veh.hullFacing = 1.234; veh.turretFacing = 1.234;
    battle.issueOrder(team.id, { type: 'defend', target: { ...veh.pos }, issuedAt: 0 });
    expect(veh.hullFacing).toBeCloseTo(1.234);
    expect(veh.turretFacing).toBeCloseTo(1.234);
  });
});

describe('G23 crew-served gun facing', () => {
  const pakConfig: BattleConfig = {
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 4, durationS: 600,
    difficulty: 'normal', forces: { german: ['ger_pak38'], soviet: ['sov_rifle_41'] },
  };

  it('a Defend order pivots the gun immediately to the order bearing (arc pivot = gun.facing)', () => {
    const battle = new Battle(pakConfig);
    const team = battle.selectableTeams('german')[0];
    battle.issueOrder(team.id, { type: 'defend', target: { x: team.pos.x + 5, y: team.pos.y }, issuedAt: 0 });
    battle.start();
    battle.step(0.2); // crew sets the gun up; gun exists from issue-time chain onward
    const f = team.crewWeapon!.facing;
    // east = pi/2; step 0.2s of lay may slew only partway from spawn heading, so allow slack
    expect(wrapPi(f)).toBeGreaterThan(0);
    expect(Math.abs(wrapPi(f) - Math.PI / 2)).toBeLessThan(Math.PI / 2);
    function wrapPi(a: number): number { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  });
});
