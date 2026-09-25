import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { aiDeploy } from '@/sim/ai';
import { getSmallArmsStats, getCombatInstrumentation } from '@/sim/combat';
import { prisonerCount } from '@/sim/victory';
import { otherSide } from '@/shared/types';
import { MAPS } from '@/data/maps';
import { DEFAULT_FORCES } from '@/data/operation';
import { SIM_DT } from '@/shared/types';
import type { BattleConfig, Side } from '@/shared/types';

/**
 * Headless AI-vs-AI balance harness (see docs/superpowers/specs/2026-09-12-cc3-clone-design.md §6
 * and the balance targets in the task brief). Runs every map at seeds 1..3 with DEFAULT_FORCES for
 * that map's year, both sides played by the AI, for a full 20-minute battle, and prints a summary
 * table plus a `ms/sim-second` perf number. The full harness (~5 min) is OPT-IN: run it with
 * `HARNESS=1 npx vitest run test/harness.test.ts`. The default suite only runs a short smoke battle
 * and the determinism check. Assertions are intentionally loose sanity checks (NaN/crash guards)
 * rather than hard balance gates, since balance is tuned by reading the printed numbers.
 */

const YEAR_BY_MAP: Record<string, number> = {
  border_1941: 1941,
  village_1942: 1942,
  steppe_1943: 1943,
  forest_1944: 1944,
  berlin_1945: 1945,
};

/** Map ids are expected to end in a year (e.g. a new 'moscow_1941'); fall back to that instead of
 * a hardcoded table so a newly added map (src/data/maps/* is owned by other agents) still gets a
 * sensible force year without this file needing an update. */
function yearForMap(mapId: string): number {
  if (YEAR_BY_MAP[mapId]) return YEAR_BY_MAP[mapId];
  const m = /(\d{4})$/.exec(mapId);
  const year = m ? Number(m[1]) : NaN;
  return DEFAULT_FORCES[year] ? year : 1943;
}

const SIDES: Side[] = ['german', 'soviet'];
const BATTLE_SECONDS = 20 * 60;
/** Seeds per map: 3 by default; `HARNESS_SEEDS=9` runs seeds 1..9 (the 3-seed attacker win rate is
 * noisy) and the report prints the win rate over all seeds and over the seeds 1..3 subset. */
const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED_COUNT = Math.max(1, Math.floor(Number(ENV.HARNESS_SEEDS ?? 3)) || 3);
/** `HARNESS_SEED_FROM=4 HARNESS_SEEDS=9` runs seeds 4..9 only (to split a long run in two). */
/** `HARNESS_MAPS=village_1942,steppe_1943` restricts the run to those maps (quick AI iterations). */
const MAP_FILTER = (ENV.HARNESS_MAPS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const HARNESS_MAP_DEFS = MAPS.filter((m) => MAP_FILTER.length === 0 || MAP_FILTER.includes(m.id));
const SEED_FROM = Math.max(1, Math.floor(Number(ENV.HARNESS_SEED_FROM ?? 1)) || 1);
const SEEDS = Array.from({ length: Math.max(0, SEED_COUNT - SEED_FROM + 1) }, (_, i) => i + SEED_FROM);

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
  prisonersTaken: number; // enemy soldiers surrendered to this side
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
  // Balance round 4 instrumentation (per coordinator's follow-up ask on the defender advantage).
  shotsByAttacker: number; // shots fired BY the attacking side (i.e. at defenders)
  shotsByDefender: number; // shots fired BY the defending side (i.e. at attackers)
  suppressionByAttacker: number; // suppression applied by the attacker onto the defender
  suppressionByDefender: number; // suppression applied by the defender onto the attacker
  mortarRoundsByAttacker: number;
  mortarRoundsByDefender: number;
  /** Average suppression among alive defender-side soldiers, sampled only at seconds where some
   * attacking team is within 150m of some defending team (i.e. "when the fight is actually on"). */
  avgDefenderSuppressionWhenClose: number | null;
  /** Fraction of alive attacker-side soldiers with activity pinned/cowering, sampled at t=5/10/15min. */
  attackerPinnedFractionAt: { m5: number | null; m10: number | null; m15: number | null };
  /** Soldiers whose position is outside the map at the end of the run (should always be 0). */
  outOfBounds: number;
}

function runOne(mapId: string, seed: number, battleSeconds = BATTLE_SECONDS): RunReport {
  const year = yearForMap(mapId);
  const config: BattleConfig = {
    mapId,
    playerSide: 'german',
    year,
    seed,
    durationS: battleSeconds,
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

  // team.status is a point-in-time snapshot, and Broken/Routed/Surrendered are often transient —
  // a team passes through Broken on its way to Routed or Destroyed, so counting only the FINAL
  // snapshot at battle end undercounts them (a team that broke at minute 8 and was wiped out by
  // minute 15 shows only as "Destroyed"). Track every distinct team id ever seen in each state
  // across the battle instead, so the report reflects what actually happened.
  const everBroken = new Set<number>();
  const everRouted = new Set<number>();
  const everSurrendered = new Set<number>();

  const mapDef = MAPS.find((m) => m.id === mapId)!;
  const attackerSide = mapDef.attacker;
  const defenderSide = otherSide(attackerSide);

  // Balance round 4 instrumentation.
  let defenderSuppressionSampleSum = 0;
  let defenderSuppressionSampleCount = 0;
  const pinnedFractionAt: { m5: number | null; m10: number | null; m15: number | null } = { m5: null, m10: null, m15: null };
  const sampleAttackerPinnedFraction = (): number | null => {
    let alive = 0, pinnedOrCowering = 0;
    for (const s of battle.state.soldiers.values()) {
      if (s.side !== attackerSide || s.health === 'dead' || s.health === 'incapacitated') continue;
      alive++;
      if (s.activity === 'pinned' || s.activity === 'cowering') pinnedOrCowering++;
    }
    return alive > 0 ? pinnedOrCowering / alive : null;
  };

  const t0 = performance.now();
  let stepsTaken = 0;
  while (battle.state.phase === 'running' && battle.state.time < battleSeconds) {
    battle.step(1.0);
    stepsTaken++;
    battle.drainEvents(); // mirrors real usage (renderer drains each frame); avoids unbounded growth
    if (firstCasualtyAtS === null) {
      const total = battle.state.sides.german.losses + battle.state.sides.soviet.losses
        - initialLosses.german - initialLosses.soviet;
      if (total > 0) firstCasualtyAtS = battle.state.time;
    }
    for (const t of battle.state.teams.values()) {
      if (t.status === 'Broken') everBroken.add(t.id);
      else if (t.status === 'Routed') everRouted.add(t.id);
      else if (t.status === 'Surrendered') everSurrendered.add(t.id);
    }

    // Sample once per sim-second (this loop already steps 1s at a time).
    const attackerTeamPositions: { x: number; y: number }[] = [];
    const defenderTeamPositions: { x: number; y: number }[] = [];
    for (const t of battle.state.teams.values()) {
      if (t.side === attackerSide) attackerTeamPositions.push(t.pos);
      else defenderTeamPositions.push(t.pos);
    }
    let minAttackerDefenderDistM = Infinity;
    for (const a of attackerTeamPositions) {
      for (const d of defenderTeamPositions) {
        const dm = Math.hypot(a.x - d.x, a.y - d.y) * 2; // TILE_M
        if (dm < minAttackerDefenderDistM) minAttackerDefenderDistM = dm;
      }
    }
    if (minAttackerDefenderDistM <= 150) {
      let sum = 0, n = 0;
      for (const s of battle.state.soldiers.values()) {
        if (s.side !== defenderSide || s.health === 'dead' || s.health === 'incapacitated') continue;
        sum += s.suppression;
        n++;
      }
      if (n > 0) { defenderSuppressionSampleSum += sum / n; defenderSuppressionSampleCount++; }
    }

    const t = battle.state.time;
    if (pinnedFractionAt.m5 === null && t >= 5 * 60) pinnedFractionAt.m5 = sampleAttackerPinnedFraction();
    if (pinnedFractionAt.m10 === null && t >= 10 * 60) pinnedFractionAt.m10 = sampleAttackerPinnedFraction();
    if (pinnedFractionAt.m15 === null && t >= 15 * 60) pinnedFractionAt.m15 = sampleAttackerPinnedFraction();
  }
  const wallMs = performance.now() - t0;
  const simSeconds = battle.state.time;
  const msPerSimSecond = simSeconds > 0 ? wallMs / simSeconds : 0;

  const smallArms = getSmallArmsStats(battle.state);
  const combatInstr = getCombatInstrumentation(battle.state);

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
      teamsBroken: teams.filter((t) => everBroken.has(t.id)).length,
      teamsRouted: teams.filter((t) => everRouted.has(t.id) || everSurrendered.has(t.id)).length,
      teamsDestroyed: teams.filter((t) => t.status === 'Destroyed' || t.status === 'Knocked Out').length,
      vehiclesKO,
      prisonersTaken: prisonerCount(battle.state, side),
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
    shotsByAttacker: combatInstr.shotsFiredBySide[attackerSide],
    shotsByDefender: combatInstr.shotsFiredBySide[defenderSide],
    suppressionByAttacker: combatInstr.suppressionAppliedBySide[attackerSide],
    suppressionByDefender: combatInstr.suppressionAppliedBySide[defenderSide],
    mortarRoundsByAttacker: combatInstr.mortarRoundsFiredBySide[attackerSide],
    mortarRoundsByDefender: combatInstr.mortarRoundsFiredBySide[defenderSide],
    avgDefenderSuppressionWhenClose: defenderSuppressionSampleCount > 0
      ? defenderSuppressionSampleSum / defenderSuppressionSampleCount : null,
    attackerPinnedFractionAt: pinnedFractionAt,
    outOfBounds: [...battle.state.soldiers.values()].filter((s) =>
      !(s.pos.x >= 0 && s.pos.y >= 0 && s.pos.x < battle.state.map.width && s.pos.y < battle.state.map.height)).length,
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
    lines.push(
      `    shots: attacker=${r.shotsByAttacker} defender=${r.shotsByDefender} | ` +
      `suppression: attacker=${fmt(r.suppressionByAttacker, 0)} defender=${fmt(r.suppressionByDefender, 0)} | ` +
      `mortarHE: attacker=${r.mortarRoundsByAttacker} defender=${r.mortarRoundsByDefender} | ` +
      `avgDefSuppr(<=150m)=${r.avgDefenderSuppressionWhenClose === null ? 'n/a' : fmt(r.avgDefenderSuppressionWhenClose, 0)} | ` +
      `attackerPinned% @5/10/15m=${['m5', 'm10', 'm15'].map((k) => {
        const v = r.attackerPinnedFractionAt[k as 'm5' | 'm10' | 'm15'];
        return v === null ? 'n/a' : fmt(v * 100, 0) + '%';
      }).join('/')}`,
    );
    for (const side of SIDES) {
      const s = r.sides[side];
      lines.push(
        `    ${side.padEnd(7)} kills=${s.kills} losses=${s.losses} dead=${s.dead} ` +
        `aliveFrac=${fmt(s.aliveFraction * 100, 0)}% morale=${fmt(s.morale, 0)} vls=${s.vlsHeld} ` +
        `broken=${s.teamsBroken} routed=${s.teamsRouted} destroyed=${s.teamsDestroyed} vehKO=${s.vehiclesKO} prisoners=${s.prisonersTaken}`,
      );
    }
  }
  // True attacker-win-rate, from the ATTACKER's perspective (not just playerSide='german'): result
  // is always computed from german's perspective (computeResult in victory.ts), so when the
  // attacker is soviet, a german defeat-grade result is an attacker win and a german victory-grade
  // result is an attacker loss. Draws are excluded from the win-rate denominator (neither side
  // "won"). BattleResult has nine graded levels (round5 critique #10:
  // totalVictory/decisiveVictory/majorVictory/minorVictory/draw/minorDefeat/majorDefeat/
  // decisiveDefeat/totalDefeat) rather than the old four, so "germanWon" is any victory grade.
  const GERMAN_WIN_RESULTS = new Set(['totalVictory', 'decisiveVictory', 'majorVictory', 'minorVictory']);
  const winRate = (rs: RunReport[], label: string): void => {
    const decided = rs.filter((r) => r.result !== 'draw');
    const attackerWins = decided.filter((r) => {
      const germanWon = GERMAN_WIN_RESULTS.has(r.result);
      return r.attacker === 'german' ? germanWon : !germanWon;
    }).length;
    const pct = decided.length > 0 ? fmt((attackerWins / decided.length) * 100, 0) : 'n/a';
    lines.push(`Attacker win rate ${label} across ${decided.length} decided runs (${rs.length} total, ${rs.length - decided.length} draws): ${attackerWins}/${decided.length} = ${pct}%`);
  };
  lines.push('');
  winRate(reports, `seeds 1..${SEED_COUNT}`);
  if (SEED_COUNT > 3) winRate(reports.filter((r) => r.seed <= 3), 'seeds 1..3');
  for (const mapId of new Set(reports.map((r) => r.mapId))) winRate(reports.filter((r) => r.mapId === mapId), `on ${mapId}`);
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  // Persist the report so a later session can compare balance without re-running (560s+).
  void import('node:fs').then((fs) => fs.writeFileSync('/tmp/cc3-balance-report.txt', lines.join('\n') + '\n')).catch(() => {
    /* read-only fs: report stays console-only */
  });
}

describe('harness smoke', () => {
  it('runs a short AI-vs-AI battle on the first map with finite values and all soldiers on the map', () => {
    const r = runOne(MAPS[0].id, 1, 180);
    expect(Number.isFinite(r.durationS)).toBe(true);
    expect(r.sides.german.losses).toBeGreaterThanOrEqual(0);
    expect(r.sides.soviet.losses).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.smallArmsHitRate)).toBe(true);
    expect(r.outOfBounds).toBe(0);
  }, 60_000);
});

describe.skipIf(!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.HARNESS)('AI-vs-AI balance harness', () => {
  it(`runs every map at seeds 1..${SEED_COUNT} and prints a balance report`, () => {
    const reports: RunReport[] = [];
    for (const mapDef of HARNESS_MAP_DEFS) {
      for (const seed of SEEDS) {
        const r = runOne(mapDef.id, seed);
        reports.push(r);
        // Loose sanity checks — real bugs (NaN positions, negative counts, runaway loops) should
        // fail here; balance targets are read from the printed report, not enforced as hard gates.
        expect(Number.isFinite(r.durationS)).toBe(true);
        expect(r.sides.german.losses).toBeGreaterThanOrEqual(0);
        expect(r.sides.soviet.losses).toBeGreaterThanOrEqual(0);
        expect(r.msPerSimSecond).toBeLessThan(2000); // generous CI-machine ceiling; target is <15ms
        expect(r.outOfBounds).toBe(0);
      }
    }
    printReport(reports);
    expect(reports.length).toBe(HARNESS_MAP_DEFS.length * SEEDS.length);
  }, 600_000 * Math.max(1, SEED_COUNT / 3) * 2);
});

describe('determinism', () => {
  it('two runs with the same seed produce identical results (score, kills, losses)', () => {
    // Balance round 3 ask: verify seed-identical runs are bit-identical. The sim itself has no
    // Math.random/Date.now (all randomness goes through the seeded Rng), so this should already
    // hold; this test pins it down as a permanent regression guard. Uses a short duration so the
    // full suite stays fast.
    const mapId = MAPS[0].id;
    const year = yearForMap(mapId);
    const config: BattleConfig = {
      mapId, playerSide: 'german', year, seed: 7, durationS: 60,
      difficulty: 'normal', forces: DEFAULT_FORCES[year], aiBothSides: true,
    };

    function runShort() {
      const battle = new Battle(config);
      for (const side of SIDES) aiDeploy(battle.state, side, battle.rng, battle);
      battle.start();
      for (let i = 0; i < config.durationS / SIM_DT; i++) {
        battle.step(SIM_DT);
        battle.drainEvents();
      }
      return {
        time: battle.state.time,
        result: battle.state.result,
        german: { ...battle.state.sides.german },
        soviet: { ...battle.state.sides.soviet },
        soldierPositions: Array.from(battle.state.soldiers.values()).map((s) => `${s.id}:${s.pos.x.toFixed(4)},${s.pos.y.toFixed(4)}:${s.health}:${s.activity}`),
      };
    }

    const a = runShort();
    const b = runShort();
    expect(b.time).toBe(a.time);
    expect(b.result).toBe(a.result);
    expect(b.german).toEqual(a.german);
    expect(b.soviet).toEqual(a.soviet);
    expect(b.soldierPositions).toEqual(a.soldierPositions);
  }, 120_000); // bun's runner defaults to 5 s; two 60 s sims need far more
});
