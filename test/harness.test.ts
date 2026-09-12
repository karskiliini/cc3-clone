import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { aiDeploy } from '@/sim/ai';
import { getSmallArmsStats } from '@/sim/combat';
import { MAPS } from '@/data/maps';
import { DEFAULT_FORCES } from '@/data/operation';
import { SIM_DT } from '@/shared/types';
import type { BattleConfig, Side } from '@/shared/types';

/**
 * Headless AI-vs-AI balance harness (see docs/superpowers/specs/2026-09-12-cc3-clone-design.md §6
 * and the balance targets in the task brief). Runs every map at seeds 1..3 with DEFAULT_FORCES for
 * that map's year, both sides played by the AI, for a full 20-minute battle, and prints a summary
 * table plus a `ms/sim-second` perf number. Kept as a vitest test so `npx vitest run` covers it in
 * CI; assertions are intentionally loose sanity checks (NaN/crash guards) rather than hard balance
 * gates, since balance is tuned by reading the printed numbers, not by failing the build.
 */

const YEAR_BY_MAP: Record<string, number> = {
  border_1941: 1941,
  village_1942: 1942,
  steppe_1943: 1943,
  forest_1944: 1944,
  berlin_1945: 1945,
};

const SIDES: Side[] = ['german', 'soviet'];
const BATTLE_SECONDS = 20 * 60;
const SEEDS = [1, 2, 3];

interface SideReport {
  side: Side;
  kills: number;
  losses: number; // dead + incapacitated + wounded
  dead: number;
  aliveFraction: number;
  morale: number;
  vlsHeld: number;
  teamsBroken: number;
  teamsRouted: number;
  teamsDestroyed: number;
  vehiclesKO: number;
}

interface RunReport {
  mapId: string;
  seed: number;
  durationS: number;
  result: string;
  attacker: Side;
  firstCasualtyAtS: number | null;
  msPerSimSecond: number;
  smallArmsFired: number;
  smallArmsHit: number;
  smallArmsHitRate: number;
  sides: Record<Side, SideReport>;
}

function runOne(mapId: string, seed: number): RunReport {
  const year = YEAR_BY_MAP[mapId] ?? 1943;
  const config: BattleConfig = {
    mapId,
    playerSide: 'german',
    year,
    seed,
    durationS: BATTLE_SECONDS,
    difficulty: 'normal',
    forces: DEFAULT_FORCES[year],
    aiBothSides: true,
  };

  const battle = new Battle(config);
  // Re-deploy both sides with the AI's cover-seeking placement (spec §6.9 aiDeploy), rather than
  // the constructor's naive grid layout, so both sides start from a realistic deployment.
  for (const side of SIDES) aiDeploy(battle.state, side, battle.rng, battle);
  battle.start();

  const startingAliveBySide: Record<Side, number> = { german: 0, soviet: 0 };
  for (const s of battle.state.soldiers.values()) startingAliveBySide[s.side]++;

  let firstCasualtyAtS: number | null = null;
  const initialLosses: Record<Side, number> = {
    german: battle.state.sides.german.losses,
    soviet: battle.state.sides.soviet.losses,
  };

  const t0 = performance.now();
  let stepsTaken = 0;
  while (battle.state.phase === 'running' && battle.state.time < BATTLE_SECONDS) {
    battle.step(1.0);
    stepsTaken++;
    battle.drainEvents(); // mirrors real usage (renderer drains each frame); avoids unbounded growth
    if (firstCasualtyAtS === null) {
      const total = battle.state.sides.german.losses + battle.state.sides.soviet.losses
        - initialLosses.german - initialLosses.soviet;
      if (total > 0) firstCasualtyAtS = battle.state.time;
    }
  }
  const wallMs = performance.now() - t0;
  const simSeconds = battle.state.time;
  const msPerSimSecond = simSeconds > 0 ? wallMs / simSeconds : 0;

  const smallArms = getSmallArmsStats(battle.state);

  const mapDef = MAPS.find((m) => m.id === mapId)!;

  const sides: Record<Side, SideReport> = {} as Record<Side, SideReport>;
  for (const side of SIDES) {
    const teams = Array.from(battle.state.teams.values()).filter((t) => t.side === side);
    let dead = 0, incap = 0, wounded = 0, aliveCount = 0;
    for (const s of battle.state.soldiers.values()) {
      if (s.side !== side) continue;
      if (s.health === 'dead') dead++;
      else if (s.health === 'incapacitated') incap++;
      else {
        aliveCount++;
        if (s.health === 'wounded') wounded++;
      }
    }
    const vlsHeld = battle.state.map.victoryLocations.filter((vl) => vl.owner === side).length;
    const vehiclesKO = Array.from(battle.state.vehicles.values())
      .filter((v) => v.side === side && (v.state === 'knockedOut' || v.state === 'burning')).length;
    sides[side] = {
      side,
      kills: battle.state.sides[side].kills,
      losses: dead + incap + wounded,
      dead,
      aliveFraction: startingAliveBySide[side] > 0 ? aliveCount / startingAliveBySide[side] : 0,
      morale: battle.state.sides[side].morale,
      vlsHeld,
      teamsBroken: teams.filter((t) => t.status === 'Broken').length,
      teamsRouted: teams.filter((t) => t.status === 'Routed' || t.status === 'Surrendered').length,
      teamsDestroyed: teams.filter((t) => t.status === 'Destroyed' || t.status === 'Knocked Out').length,
      vehiclesKO,
    };
  }

  return {
    mapId,
    seed,
    durationS: battle.state.time,
    result: battle.state.result ?? 'unfinished',
    attacker: mapDef.attacker,
    firstCasualtyAtS,
    msPerSimSecond,
    smallArmsFired: smallArms.fired,
    smallArmsHit: smallArms.hit,
    smallArmsHitRate: smallArms.fired > 0 ? smallArms.hit / smallArms.fired : 0,
    sides,
  };
}

function fmt(n: number, d = 1): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'NaN';
}

function printReport(reports: RunReport[]): void {
  const lines: string[] = [];
  lines.push('');
  lines.push('=== AI-vs-AI Balance Harness ===');
  for (const r of reports) {
    lines.push(
      `${r.mapId} seed=${r.seed} dur=${fmt(r.durationS)}s result=${r.result} attacker=${r.attacker} ` +
      `firstCasualty=${r.firstCasualtyAtS === null ? 'none' : fmt(r.firstCasualtyAtS) + 's'} ` +
      `ms/simS=${fmt(r.msPerSimSecond, 3)} smallArmsHitRate=${fmt(r.smallArmsHitRate * 100, 2)}% ` +
      `(${r.smallArmsHit}/${r.smallArmsFired})`,
    );
    for (const side of SIDES) {
      const s = r.sides[side];
      lines.push(
        `    ${side.padEnd(7)} kills=${s.kills} losses=${s.losses} dead=${s.dead} ` +
        `aliveFrac=${fmt(s.aliveFraction * 100, 0)}% morale=${fmt(s.morale, 0)} vls=${s.vlsHeld} ` +
        `broken=${s.teamsBroken} routed=${s.teamsRouted} destroyed=${s.teamsDestroyed} vehKO=${s.vehiclesKO}`,
      );
    }
  }
  const attackerWins = reports.filter((r) => r.result === 'decisive' || r.result === 'victory').length;
  const perspectiveIsAttacker = reports.filter((r) => r.attacker === 'german'); // playerSide='german' always
  lines.push('');
  lines.push(`Attacker(=playerSide) win rate across ${reports.length} runs: ${attackerWins}/${reports.length}`);
  lines.push(`(runs where attacker===playerSide('german')): ${perspectiveIsAttacker.length}/${reports.length}`);
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

describe('AI-vs-AI balance harness', () => {
  it('runs every map at seeds 1..3 and prints a balance report', () => {
    const reports: RunReport[] = [];
    for (const mapDef of MAPS) {
      for (const seed of SEEDS) {
        const r = runOne(mapDef.id, seed);
        reports.push(r);
        // Loose sanity checks — real bugs (NaN positions, negative counts, runaway loops) should
        // fail here; balance targets are read from the printed report, not enforced as hard gates.
        expect(Number.isFinite(r.durationS)).toBe(true);
        expect(r.sides.german.losses).toBeGreaterThanOrEqual(0);
        expect(r.sides.soviet.losses).toBeGreaterThanOrEqual(0);
        expect(r.msPerSimSecond).toBeLessThan(200); // generous CI-machine ceiling; target is <15ms
      }
    }
    printReport(reports);
    expect(reports.length).toBe(MAPS.length * SEEDS.length);
  }, 120_000);
});
