import { describe, it, expect } from 'vitest';
import { Battle } from '../src/sim/battle';
import { applyOrder } from '../src/sim/orders';
import { inCommand, teamInCommand, COMMAND_RADIUS_TILES } from '../src/sim/command';
import { getMap } from '../src/data/maps';
import type { BattleConfig } from '../src/shared/types';

function battleWith(forces: { german: string[]; soviet: string[] }): Battle {
  return new Battle({
    mapId: 'border_1941',
    playerSide: 'german',
    year: 1941,
    seed: 7,
    durationS: 600,
    difficulty: 'normal',
    forces,
  } as BattleConfig);
}

describe('command radius (G11)', () => {
  it('soldier within radius of an operational HQ is in command', () => {
    const b = battleWith({ german: ['ger_command', 'ger_rifle_41'], soviet: ['sov_rifle_41'] });
    b.start();
    const hq = [...b.state.teams.values()].find((t) => t.type === 'command')!;
    const rifle = [...b.state.teams.values()].find((t) => t.type === 'rifle')!;
    const leader = b.state.soldiers.get(rifle.leaderId)!;
    const hqLeader = b.state.soldiers.get(hq.leaderId)!;
    // spawn positions may already be far apart; force known geometry
    hqLeader.pos = { x: 50, y: 50 };
    leader.pos = { x: 100, y: 50 }; // 50 tiles < 60
    expect(inCommand(b.state, leader)).toBe(true);
    expect(teamInCommand(b.state, rifle)).toBe(true);
  });

  it('soldier beyond the radius (or at the boundary inclusive edge) is judged correctly', () => {
    const b = battleWith({ german: ['ger_command', 'ger_rifle_41'], soviet: ['sov_rifle_41'] });
    b.start();
    const hq = [...b.state.teams.values()].find((t) => t.type === 'command')!;
    const rifle = [...b.state.teams.values()].find((t) => t.type === 'rifle')!;
    const leader = b.state.soldiers.get(rifle.leaderId)!;
    const hqLeader = b.state.soldiers.get(hq.leaderId)!;
    hqLeader.pos = { x: 50, y: 50 };
    leader.pos = { x: 50 + COMMAND_RADIUS_TILES + 5, y: 50 };
    expect(inCommand(b.state, leader)).toBe(false);
    expect(teamInCommand(b.state, rifle)).toBe(false);
    // exactly at the radius: in command (inclusive)
    leader.pos = { x: 50 + COMMAND_RADIUS_TILES, y: 50 };
    expect(inCommand(b.state, leader)).toBe(true);
  });

  it('a knocked-out HQ removes the radius (outOfAction / dead leader)', () => {
    const b = battleWith({ german: ['ger_command', 'ger_rifle_41'], soviet: ['sov_rifle_41'] });
    b.start();
    const hq = [...b.state.teams.values()].find((t) => t.type === 'command')!;
    const rifle = [...b.state.teams.values()].find((t) => t.type === 'rifle')!;
    const leader = b.state.soldiers.get(rifle.leaderId)!;
    const hqLeader = b.state.soldiers.get(hq.leaderId)!;
    hqLeader.pos = { x: 50, y: 50 };
    leader.pos = { x: 60, y: 50 };
    expect(inCommand(b.state, leader)).toBe(true);
    // a *reachable* HQ lost: link broken, soldier out of command
    hqLeader.health = 'dead';
    hq.pos = { x: 200, y: 200 }; // leader succession promotes nobody within reach
    const others = [...b.state.teams.values()].filter((t) => t.side === 'german' && t.id !== hq.id);
    for (const t of others) for (const sid of t.soldierIds) { b.state.soldiers.get(sid)!.pos = { x: 200, y: 200 }; }
    expect(inCommand(b.state, leader)).toBe(false);
    hqLeader.health = 'healthy';
    hq.outOfAction = true;
    expect(inCommand(b.state, leader)).toBe(false);
  });

  it('orders to an out-of-command team are refused; inside the radius they are obeyed', () => {
    const b = battleWith({ german: ['ger_command', 'ger_rifle_41'], soviet: ['sov_rifle_41'] });
    b.start();
    const hq = [...b.state.teams.values()].find((t) => t.type === 'command')!;
    const rifle = [...b.state.teams.values()].find((t) => t.type === 'rifle')!;
    const leader = b.state.soldiers.get(rifle.leaderId)!;
    const hqLeader = b.state.soldiers.get(hq.leaderId)!;
    // quiet corner away from both spawns so nobody dies mid-test
    leader.pos = { x: 20, y: 130 };
    rifle.pos = { x: 20, y: 130 };
    hqLeader.pos = { x: 190, y: 5 };
    applyOrder(b.state, rifle, { type: 'move', target: { x: 30, y: 130 }, issuedAt: 0 }, b.rng);
    expect(rifle.order).not.toBeNull();
    // leader refuses: still at the old position after 2 s
    b.step(2);
    expect(leader.pos.x).toBeLessThan(25);
    expect(b.state.messages.some((m) => m.text.includes('no contact with HQ'))).toBe(true);
    // bring the HQ to the squad: the pending order now goes through
    hqLeader.pos = { x: 25, y: 130 };
    b.step(10);
    expect(leader.pos.x).toBeGreaterThan(20.5);
  });
});
