import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { stepAttackOrders, attackPhase, ATTACK_LOST_SUPPRESS_S } from '@/sim/orders';
import { pickSoldierTargetForTest } from '@/sim/combat';
import { hasLOS } from '@/sim/los';
import { isPassable } from '@/sim/path';
import type { BattleConfig, Soldier, Team, Vec2 } from '@/shared/types';

const config: BattleConfig = {
  mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 3, durationS: 600,
  difficulty: 'normal', forces: { german: ['ger_rifle_41'], soviet: ['sov_rifle_41'] },
};

const GAP = 14;

/** A patch of open, passable ground where the whole squad block on the left sees the block on the right. */
function findArena(b: Battle): Vec2 {
  const map = b.state.map;
  for (let y = 5; y < map.height - 10; y++) {
    for (let x = 5; x < map.width - GAP - 12; x++) {
      let ok = true;
      for (let dy = 0; dy < 6 && ok; dy++) {
        for (let dx = 0; dx < GAP + 10 && ok; dx++) {
          if (!isPassable(map, x + dx, y + dy, 'infantry')) ok = false;
        }
      }
      if (!ok) continue;
      for (let dy = 0; dy < 6 && ok; dy += 2) {
        for (let dy2 = 0; dy2 < 6 && ok; dy2 += 2) {
          if (!hasLOS(map, { x: x + 0.5, y: y + dy + 0.5 }, { x: x + GAP + 8.5, y: y + dy2 + 0.5 })) ok = false;
        }
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('no arena');
}

function place(b: Battle, team: Team, origin: Vec2): void {
  team.soldierIds.forEach((id, i) => {
    const s = b.state.soldiers.get(id)!;
    s.pos = { x: origin.x + 0.5 + (i % 2), y: origin.y + 0.5 + Math.floor(i / 2) * 0.6 };
    s.path = [];
    s.activity = 'defending';
  });
  refreshPos(b, team);
}

function refreshPos(b: Battle, team: Team): void {
  const ms = team.soldierIds.map((id) => b.state.soldiers.get(id)!).filter((s) => s.health !== 'dead');
  team.pos = { x: ms.reduce((a, s) => a + s.pos.x, 0) / ms.length, y: ms.reduce((a, s) => a + s.pos.y, 0) / ms.length };
}

function setup() {
  const b = new Battle(config);
  b.start();
  const ger = b.selectableTeams('german')[0];
  const sov = b.selectableTeams('soviet')[0];
  const a = findArena(b);
  place(b, ger, a);
  place(b, sov, { x: a.x + GAP, y: a.y });
  b.state.spotted.german.clear();
  b.state.spotted.soviet.clear();
  return { b, ger, sov, members: (t: Team) => t.soldierIds.map((id) => b.state.soldiers.get(id)!) };
}

const spotAll = (b: Battle, t: Team) => t.soldierIds.forEach((id) => b.state.spotted.german.add(id));

describe('attack-unit fire orders', () => {
  it('clicking where an unspotted enemy stands gives area fire (no targetTeamId)', () => {
    const { b, ger, sov, members } = setup();
    const p = { ...members(sov)[0].pos };
    expect(b.teamAt(p, 'soviet')).toBeNull();
    b.issueOrder(ger.id, { type: 'fire', target: p, targetTeamId: sov.id, issuedAt: 0 });
    expect(ger.order!.targetTeamId).toBeUndefined();
    expect(ger.order!.target).toEqual(p);
  });

  it('a forgiving click near a spotted enemy becomes an attack-unit order whose target follows the team', () => {
    const { b, ger, sov, members } = setup();
    spotAll(b, sov);
    const near = { x: members(sov)[0].pos.x + 1.0, y: members(sov)[0].pos.y };
    const picked = b.teamAt(near, 'soviet');
    expect(picked?.id).toBe(sov.id);
    b.issueOrder(ger.id, { type: 'fire', target: near, targetTeamId: picked!.id, issuedAt: 0 });
    const order = ger.order!;
    expect(order.targetTeamId).toBe(sov.id);
    refreshPos(b, sov);
    expect(order.target.x).toBeCloseTo(sov.pos.x, 5);

    for (const s of members(sov)) s.pos = { x: s.pos.x + 3, y: s.pos.y + 2 };
    refreshPos(b, sov);
    stepAttackOrders(b.state, b.rng);
    expect(order.target.x).toBeCloseTo(sov.pos.x, 5);
    expect(order.target.y).toBeCloseTo(sov.pos.y, 5);
    expect(attackPhase(b.state, order)).toBe('tracking');
  });

  it('soldiers engage members of the target team, not the ground point', () => {
    const { b, ger, sov, members } = setup();
    spotAll(b, sov);
    b.issueOrder(ger.id, { type: 'fire', target: { ...sov.pos }, targetTeamId: sov.id, issuedAt: 0 });
    const ids = new Set(sov.soldierIds);
    let engaged = 0;
    for (const s of members(ger)) {
      s.activity = 'firing';
      const t = pickSoldierTargetForTest(b.state, s);
      if (!t) continue;
      expect(t.kind).toBe('soldier');
      if (t.kind === 'soldier') expect(ids.has(t.soldier.id)).toBe(true);
      engaged++;
    }
    expect(engaged).toBeGreaterThan(0);
  });

  it('losing sight suppresses the last known position, then holds, then resumes tracking', () => {
    const { b, ger, sov, members } = setup();
    spotAll(b, sov);
    b.issueOrder(ger.id, { type: 'fire', target: { ...sov.pos }, targetTeamId: sov.id, issuedAt: 0 });
    const order = ger.order!;
    const last = { ...order.target };
    const rifleman = members(ger).find((s) => s.weaponId && !s.isLeader) ?? members(ger)[0];
    rifleman.activity = 'firing';

    b.state.spotted.german.clear();
    for (const s of members(sov)) s.pos = { x: s.pos.x, y: s.pos.y + 3 }; // moved while hidden
    b.state.time += 3;
    stepAttackOrders(b.state, b.rng);
    expect(attackPhase(b.state, order)).toBe('suppress');
    expect(order.target).toEqual(last);
    const t = pickSoldierTargetForTest(b.state, rifleman);
    expect(t?.kind).toBe('point');
    if (t?.kind === 'point') expect(t.pos).toEqual(last);

    b.state.time += ATTACK_LOST_SUPPRESS_S + 1;
    stepAttackOrders(b.state, b.rng);
    expect(attackPhase(b.state, order)).toBe('hold');
    expect(pickSoldierTargetForTest(b.state, rifleman)).toBeNull();
    expect(ger.order?.type).toBe('fire');

    spotAll(b, sov);
    stepAttackOrders(b.state, b.rng);
    expect(attackPhase(b.state, order)).toBe('tracking');
    refreshPos(b, sov);
    expect(order.target.y).toBeCloseTo(sov.pos.y, 5);
  });

  it('destroying the target completes the order with Defend and a message', () => {
    const { b, ger, sov, members } = setup();
    spotAll(b, sov);
    b.issueOrder(ger.id, { type: 'fire', target: { ...sov.pos }, targetTeamId: sov.id, issuedAt: 0 });
    const last = { ...ger.order!.target };
    members(sov).forEach((s, i) => {
      if (i % 2 === 0) { s.health = 'dead'; s.activity = 'dead'; } else s.activity = 'surrendered';
    });
    stepAttackOrders(b.state, b.rng);
    expect(ger.order?.type).toBe('defend');
    expect(ger.order?.target).toEqual(last);
    expect(b.state.messages.some((m) => m.text === `${ger.name}\nTarget destroyed.`)).toBe(true);
  });

  it('a spotted vehicle is picked by its hull (+0.5 tile) and tracked via targetVehicleId', () => {
    const b = new Battle({ ...config, forces: { german: ['ger_rifle_41'], soviet: ['sov_t34_76'] } });
    b.start();
    const ger = b.selectableTeams('german')[0];
    const tank = b.selectableTeams('soviet')[0];
    const v = b.state.vehicles.get(tank.vehicleId!)!;
    const click = { x: v.pos.x + 2.0, y: v.pos.y }; // T-34 half length 1.675 tiles + 0.5 pad
    b.state.spottedVehicles.german.clear();
    expect(b.teamAt(click, 'soviet')).toBeNull();
    b.state.spottedVehicles.german.add(v.id);
    expect(b.teamAt(click, 'soviet')?.id).toBe(tank.id);
    b.issueOrder(ger.id, { type: 'fire', target: click, targetTeamId: tank.id, issuedAt: 0 });
    const order = ger.order!;
    expect(order.targetVehicleId).toBe(v.id);
    v.pos = { x: v.pos.x + 4, y: v.pos.y };
    stepAttackOrders(b.state, b.rng);
    expect(order.target).toEqual(v.pos);
    v.state = 'knockedOut';
    stepAttackOrders(b.state, b.rng);
    expect(ger.order?.type).toBe('defend');
  });
});
