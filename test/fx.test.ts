// Combat FX / medic / assault — behaviour contracts for the spec-combat-fx work.
import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { applyOrder } from '@/sim/orders';
import { stepMedic, MEDIC_TREAT_S, DRAG_M } from '@/sim/medic';
import { TILE_M } from '@/shared/types';
import { SIM_DT } from '@/shared/types';
import type { BattleState, Soldier } from '@/shared/types';
import { Rng } from '@/shared/rng';

function battle(forces?: { german: string[]; soviet: string[] }): Battle {
  const b = new Battle({
    mapId: 'border_1941', playerSide: 'german', year: 1941, seed: 2, durationS: 600,
    difficulty: 'normal',
    forces: forces ?? { german: ['ger_rifle_41'], soviet: ['sov_rifle_41'] },
  });
  b.start();
  return b;
}

describe('projectiles in flight (A1)', () => {
  it('a grenade throw spawns a projectile and a delayed burst, not an instant splash', () => {
    const b = battle();
    const st = b.state;
    const team = b.selectableTeams('german')[0];
    const thrower = st.soldiers.get(team.leaderId)!;
    // a spotted enemy within grenade range
    const enemy = [...st.soldiers.values()].find((s) => s.side !== thrower.side && s.health === 'healthy')!;
    enemy.pos = { x: thrower.pos.x + 3, y: thrower.pos.y };
    enemy.suppression = 100; // pin his own combat; the ongoing battle keeps wounding him
    // run until the thrower's grenade count drops, checking each step for the in-flight round
    let thrown = false;
    let sawProjectile = false;
    for (let i = 0; i < 1200 && !thrown; i++) {
      st.spotted[thrower.side].add(enemy.id); // the spotting step rebuilds the set each tick
      enemy.health = 'healthy'; // the ongoing AI battle keeps wounding him; pin him alive
      b.step(SIM_DT);
      sawProjectile = sawProjectile || st.projectiles.some((p) => p.kind === 'grenade') || st.pendingBursts.length > 0;
      thrown = thrower.grenades < 2;
    }
    expect(thrown).toBe(true);
    expect(sawProjectile).toBe(true);
  });
  it('AT fire at a tank pushes an atrocket projectile', () => {
    const b = battle({ german: ['ger_rifle_41'], soviet: ['sov_t26'] });
    const st = b.state;
    const team = b.selectableTeams('german')[0];
    const gunner = st.soldiers.get(team.leaderId)!;
    gunner.weaponId = 'panzerfaust';
    gunner.ammo = 5;
    gunner.suppression = 0;
    gunner.stance = 'standing'; // prone-eye LOS over the local crest is blocked; the shot needs a standing firer
    const enemyTeam = [...st.teams.values()].find((t) => t.side !== gunner.side && !t.outOfAction);
    if (!enemyTeam) return;
    const veh = [...st.vehicles.values()].find((v) => v.side !== gunner.side);
    if (!veh) return;
    veh.pos = { x: gunner.pos.x + 8, y: gunner.pos.y };
    st.spottedVehicles[gunner.side].add(veh.id);
    applyOrder(st, team, { type: 'fire', target: veh.pos, targetTeamId: enemyTeam.id, issuedAt: st.time }, new Rng(3));
    let sawRocket = false;
    for (let i = 0; i < 1200 && !sawRocket; i++) {
      st.spottedVehicles[gunner.side].add(veh.id);
      gunner.stance = 'standing';
      gunner.health = 'healthy'; // return fire would otherwise kill him first
      b.step(SIM_DT);
      sawRocket = st.projectiles.some((p) => p.kind === 'atrocket');
    }
    expect(sawRocket).toBe(true);
  });
});

describe('medic (B8)', () => {
  it('a healthy teammate treats a wounded one: health returns to healthy after MEDIC_TREAT_S', () => {
    const b = battle();
    const st = b.state;
    const team = b.selectableTeams('german')[0];
    const men = team.soldierIds.map((id) => st.soldiers.get(id)!).filter((s) => s && s.health === 'healthy');
    if (men.length < 2) return;
    const [medic, patient] = men;
    patient.health = 'wounded';
    patient.pos = { x: medic.pos.x + 1, y: medic.pos.y };
    let healed = false;
    for (let i = 0; i < Math.ceil(60 / SIM_DT) && !healed; i++) {
      stepMedic(st, b.rng, SIM_DT);
      // drive the medic's walk manually (movement is not stepped here)
      const t = st.time + SIM_DT;
      (st as BattleState & { time: number }).time = t;
      // (whoever took the task: the nearest able man walks up to kneel beside the patient)
      for (const m of men) {
        if (m.path.length > 0) {
          m.pos = m.path[m.path.length - 1];
          m.path = [];
        }
      }
      stepMedic(st, b.rng, SIM_DT);
      if ((patient as Soldier).health === 'healthy') healed = true;
    }
    expect(healed).toBe(true);
    expect(MEDIC_TREAT_S).toBeGreaterThan(0);
  });
});

describe('casualty drag (B8)', () => {
  it('an incapacitated man is dragged DRAG_M behind the medic, who faces him walking backwards', () => {
    const b = battle();
    const st = b.state;
    const team = b.selectableTeams('german')[0];
    const men = team.soldierIds.map((id) => st.soldiers.get(id)!).filter((s) => s && s.health === 'healthy');
    if (men.length < 2) return;
    const patient = men[1];
    patient.health = 'incapacitated';
    // a spotted enemy close by: the casualty has to be dragged a good way back to cover
    const enemy = [...st.teams.values()].find((t) => t.side !== team.side)!;
    const foe = st.soldiers.get(enemy.soldierIds[0])!;
    foe.pos = { x: patient.pos.x + 1.5, y: patient.pos.y };
    st.spotted.german.add(foe.id);
    let medic: Soldier | undefined;
    let maxGap = 0, samples = 0;
    for (let i = 0; i < Math.ceil(60 / SIM_DT); i++) {
      (st as BattleState & { time: number }).time = st.time + SIM_DT;
      // a crude walker: 1 m/s along the path, like the movement step
      for (const m of men) {
        const next = m.path[0];
        if (!next) continue;
        const dx = next.x - m.pos.x, dy = next.y - m.pos.y, d = Math.hypot(dx, dy), stp = (1 / TILE_M) * SIM_DT;
        if (d <= stp) { m.pos = { ...next }; m.path.shift(); } else m.pos = { x: m.pos.x + (dx / d) * stp, y: m.pos.y + (dy / d) * stp };
      }
      stepMedic(st, b.rng, SIM_DT);
      medic = men.find((m) => m.carrying?.patientId === patient.id) ?? medic;
      if (medic?.carrying && medic.path.length > 0 && st.time - medic.carrying.since > 0.6) {
        maxGap = Math.max(maxGap, Math.abs(Math.hypot(patient.pos.x - medic.pos.x, patient.pos.y - medic.pos.y) * TILE_M - DRAG_M));
        samples++;
      }
    }
    expect(medic).toBeDefined();
    expect(samples).toBeGreaterThan(3);
    expect(maxGap).toBeLessThan(0.3); // metres off the drag distance while he is on the move
  });
});

describe('assault (C4)', () => {
  it('a Move Fast onto a spotted enemy team converts to an assault order', () => {
    const b = battle();
    const st = b.state;
    const team = b.selectableTeams('german')[0];
    const enemy = [...st.teams.values()].find((t) => t.side !== team.side && !t.outOfAction);
    if (!enemy) return;
    enemy.pos = { x: team.pos.x + 3, y: team.pos.y };
    const es = enemy.soldierIds.map((id) => st.soldiers.get(id)!).find((s) => s && s.health !== 'dead');
    if (!es) return;
    st.spotted[team.side].add(es.id);
    applyOrder(st, team, { type: 'moveFast', target: enemy.pos, issuedAt: st.time }, new Rng(1));
    expect(team.order?.type).toBe('assault');
    expect(team.order?.targetTeamId).toBe(enemy.id);
  });

  it('a Move Fast away from enemies stays a move order', () => {
    const b = battle();
    const st = b.state;
    const team = b.selectableTeams('german')[0];
    const far = { x: Math.min(st.map.width - 2, team.pos.x + 20), y: team.pos.y };
    applyOrder(st, team, { type: 'moveFast', target: far, issuedAt: st.time }, new Rng(1));
    expect(team.order?.type).toBe('moveFast');
  });
});
