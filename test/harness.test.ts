import { describe, it, expect } from 'vitest';
import { Battle } from '@/sim/battle';
import { aiDeploy, getAttackPlan } from '@/sim/ai';
import { getSmallArmsStats, getCombatInstrumentation } from '@/sim/combat';
import { prisonerCount } from '@/sim/victory';
import { otherSide } from '@/shared/types';
import { MAPS } from '@/data/maps';
import { DEFAULT_FORCES } from '@/data/operation';
import { SIM_DT } from '@/shared/types';
import type { BattleConfig, Side } from '@/shared/types';
import { coverAt } from '@/sim/map';
import { WEAPONS } from '@/data/weapons';
import { VEHICLE_DEFS } from '@/data/units';

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
  /** AI diagnosis lines (where/when men fall, support use, tank lead, commitment, VLs over time). */
  diag: string[];
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

  // ---- AI diagnosis instrumentation (attack-AI work): cheap once-per-second sampling.
  const st = battle.state;
  const zc = (side: Side) => { const z = st.map.def.deployZones[side]; return { x: z.x + z.w / 2, y: z.y + z.h / 2 }; };
  const aZone = zc(attackerSide), dZone = zc(defenderSide);
  const axisLen = Math.hypot(dZone.x - aZone.x, dZone.y - aZone.y) || 1;
  const ax = { x: (dZone.x - aZone.x) / axisLen, y: (dZone.y - aZone.y) / axisLen };
  const downed = new Set<number>();
  const bucket = (arr: number[], i: number) => { arr[Math.min(arr.length - 1, Math.max(0, i))]++; };
  const dg = {
    fallTime: { [attackerSide]: [0, 0, 0, 0, 0, 0], [defenderSide]: [0, 0, 0, 0, 0, 0] } as Record<Side, number[]>, // 200 s buckets
    fallFromZone: { [attackerSide]: [0, 0, 0, 0, 0], [defenderSide]: [0, 0, 0, 0, 0] } as Record<Side, number[]>,   // 0-50,50-100,100-150,150-200,200+ m from OWN zone centre
    fallFromVL: { [attackerSide]: [0, 0, 0, 0], [defenderSide]: [0, 0, 0, 0] } as Record<Side, number[]>,           // 0-30,30-80,80-150,150+ m from nearest VL
    fallOpen: { [attackerSide]: 0, [defenderSide]: 0 } as Record<Side, number>,
    fallMoving: { [attackerSide]: 0, [defenderSide]: 0 } as Record<Side, number>,
    fallTotal: { [attackerSide]: 0, [defenderSide]: 0 } as Record<Side, number>,
    openUnderFireS: { [attackerSide]: 0, [defenderSide]: 0 } as Record<Side, number>, // soldier-seconds, suppression>15 on cover<0.25
    /** battle time the attack plan left its preparation (the squads start across) */
    assaultAtS: null as number | null,
    mortarShots: { [attackerSide]: 0, [defenderSide]: 0 } as Record<Side, number>,
    mortarShotsBeforeContact: 0, tankShotsBeforeContact: 0,
    smokeRounds: 0,
    tankMainShots: { [attackerSide]: 0, [defenderSide]: 0 } as Record<Side, number>,
    tankLeadSum: 0, tankLeadN: 0, tankLeadMax: 0, tankAloneS: 0, // lead = tank progress along the axis minus median infantry progress (m)
    committedSum: 0, committedN: 0, committed12: 0,                // attacker inf teams within 120 m of a defender team
    vlAt: [] as string[],
    vehKO: [] as string[],
    shotsByClass: { [attackerSide]: {}, [defenderSide]: {} } as Record<Side, Record<string, number>>,
    killsByType: { [attackerSide]: {}, [defenderSide]: {} } as Record<Side, Record<string, number>>, // what the side's men fell to
  };
  const koSeen = new Set<number>();
  const mainGunIds = new Set(Object.values(VEHICLE_DEFS).map((d) => d.mainWeaponId).filter(Boolean) as string[]);
  let diagMs = 0;
  const t0 = performance.now();
  let stepsTaken = 0;
  while (battle.state.phase === 'running' && battle.state.time < battleSeconds) {
    battle.step(1.0);
    stepsTaken++;
    const evs = battle.drainEvents(); // mirrors real usage (renderer drains each frame); avoids unbounded growth
    const diagT0 = performance.now(); // the diagnosis bookkeeping below is not part of the sim's cost
    const blasts = evs.filter((e) => e.kind === 'explosion' && e.pos && e.weaponId);
    for (const e of evs) {
      if (e.kind !== 'shot' || !e.side || !e.weaponId) continue;
      const cls = WEAPONS[e.weaponId]?.cls;
      if (cls) dg.shotsByClass[e.side][cls] = (dg.shotsByClass[e.side][cls] ?? 0) + 1;
      if (cls === 'mortar') { dg.mortarShots[e.side]++; if (e.side === attackerSide && dg.assaultAtS === null) dg.mortarShotsBeforeContact++; }
      else if (mainGunIds.has(e.weaponId) && cls !== 'atgun') { dg.tankMainShots[e.side]++; if (e.side === attackerSide && dg.assaultAtS === null) dg.tankShotsBeforeContact++; }
    }
    {
      const now = st.time;
      if (dg.assaultAtS === null) { const ph = getAttackPlan(st, attackerSide)?.phase; if (ph && ph !== 'prep') dg.assaultAtS = now; }
      for (const s of st.soldiers.values()) {
        const down = s.health === 'dead' || s.health === 'incapacitated';
        if (down) {
          if (downed.has(s.id)) continue;
          downed.add(s.id);
          const own = s.side === attackerSide ? aZone : dZone;
          dg.fallTotal[s.side]++;
          bucket(dg.fallTime[s.side], Math.floor(now / 200));
          bucket(dg.fallFromZone[s.side], Math.floor((Math.hypot(s.pos.x - own.x, s.pos.y - own.y) * 2) / 50));
          let vm = Infinity;
          for (const vl of st.map.victoryLocations) vm = Math.min(vm, Math.hypot(s.pos.x - vl.x, s.pos.y - vl.y) * 2);
          bucket(dg.fallFromVL[s.side], vm < 30 ? 0 : vm < 80 ? 1 : vm < 150 ? 2 : 3);
          if (coverAt(st.map, s.pos) < 0.25) dg.fallOpen[s.side]++;
          {
            // cause: a shell/bomb/grenade that burst within 8 m this second, else bullets
            let cause = 'bullets';
            for (const b of blasts) if (b.side !== s.side && Math.hypot(b.pos!.x - s.pos.x, b.pos!.y - s.pos.y) <= 4) { cause = WEAPONS[b.weaponId!]?.cls ?? 'he'; break; }
            dg.killsByType[s.side][cause] = (dg.killsByType[s.side][cause] ?? 0) + 1;
          }
          const tm = st.teams.get(s.teamId);
          if (tm?.order && (tm.order.type === 'move' || tm.order.type === 'moveFast' || tm.order.type === 'sneak')) dg.fallMoving[s.side]++;
        } else if (s.suppression > 15 && coverAt(st.map, s.pos) < 0.25) dg.openUnderFireS[s.side]++;
      }
      const prog = (p: { x: number; y: number }) => ((p.x - aZone.x) * ax.x + (p.y - aZone.y) * ax.y) * 2;
      const inf: number[] = []; let committed = 0;
      const defTeams = [...st.teams.values()].filter((t) => t.side === defenderSide && !t.outOfAction);
      for (const t of st.teams.values()) {
        if (t.side !== attackerSide || t.outOfAction || t.vehicleId != null) continue;
        if (t.type === 'mortar' || t.type === 'atgun' || t.type === 'sniper') continue;
        inf.push(prog(t.pos));
        let md = Infinity;
        for (const d of defTeams) md = Math.min(md, Math.hypot(t.pos.x - d.pos.x, t.pos.y - d.pos.y) * 2);
        if (md <= 120) committed++;
      }
      if (committed > 0) { dg.committedSum += committed; dg.committedN++; if (committed <= 2) dg.committed12++; }
      inf.sort((a, b) => a - b);
      const med = inf.length ? inf[Math.floor(inf.length / 2)] : null;
      for (const v of st.vehicles.values()) {
        if ((v.state === 'knockedOut' || v.state === 'burning') && !koSeen.has(v.id)) {
          koSeen.add(v.id);
          const own = v.side === attackerSide ? aZone : dZone;
          dg.vehKO.push(`${v.side === attackerSide ? 'A' : 'D'}:${v.defId}@${Math.round(now)}s/${Math.round(Math.hypot(v.pos.x - own.x, v.pos.y - own.y) * 2)}m`);
        }
        if (v.side !== attackerSide || v.state !== 'ok' || med === null || !VEHICLE_DEFS[v.defId]?.mainWeaponId) continue;
        const lead = prog(v.pos) - med;
        dg.tankLeadSum += lead; dg.tankLeadN++; dg.tankLeadMax = Math.max(dg.tankLeadMax, lead);
        let nearInf = Infinity;
        for (const t of st.teams.values()) if (t.side === attackerSide && t.vehicleId == null && !t.outOfAction) nearInf = Math.min(nearInf, Math.hypot(t.pos.x - v.pos.x, t.pos.y - v.pos.y) * 2);
        if (nearInf > 80 && lead > 40) dg.tankAloneS++;
      }
      // smoke rounds (either side; mortar and tank): explosions born during this 1 s step
      for (const x of st.explosions) if (x.kind === 'smoke' && x.t <= 1.0001) dg.smokeRounds++;
      if (Math.abs(now % 300) < 0.5 && now > 1) dg.vlAt.push(`${Math.round(now)}s:${st.map.victoryLocations.filter((v) => v.owner === attackerSide).length}`);
      diagMs += performance.now() - diagT0;
    }
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
  const wallMs = performance.now() - t0 - diagMs;
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
    diag: (() => {
      const A = attackerSide, D = defenderSide;
      const f = (a: number[]) => a.join('/');
      return [
        `diag falls A=${dg.fallTotal[A]} D=${dg.fallTotal[D]} | A by200s=${f(dg.fallTime[A])} D by200s=${f(dg.fallTime[D])} | A fromOwnZone(50m)=${f(dg.fallFromZone[A])} D=${f(dg.fallFromZone[D])} | A fromVL(<30/<80/<150/+)=${f(dg.fallFromVL[A])} D=${f(dg.fallFromVL[D])}`,
        `diag A open=${dg.fallOpen[A]} moving=${dg.fallMoving[A]} | D open=${dg.fallOpen[D]} moving=${dg.fallMoving[D]} | openUnderFire s: A=${dg.openUnderFireS[A]} D=${dg.openUnderFireS[D]} | prep ends=${dg.assaultAtS === null ? 'never' : Math.round(dg.assaultAtS) + 's'} | mortarShots A=${dg.mortarShots[A]} (in prep ${dg.mortarShotsBeforeContact}) D=${dg.mortarShots[D]} | tankMain A=${dg.tankMainShots[A]} (in prep ${dg.tankShotsBeforeContact}) D=${dg.tankMainShots[D]} | smokeRounds(both)=${dg.smokeRounds}`,
        `diag tankLead mean=${dg.tankLeadN ? Math.round(dg.tankLeadSum / dg.tankLeadN) : 0}m max=${Math.round(dg.tankLeadMax)}m aloneS=${dg.tankAloneS} | committed mean=${dg.committedN ? (dg.committedSum / dg.committedN).toFixed(1) : 'n/a'} teams, <=2 teams ${dg.committedN ? Math.round((100 * dg.committed12) / dg.committedN) : 0}% of ${dg.committedN}s | A VLs ${dg.vlAt.join(' ')} | KO ${dg.vehKO.join(' ') || '-'}`,
        `diag shots by class A: ${Object.entries(dg.shotsByClass[A]).map(([k, v]) => `${k}=${v}`).join(' ')} | D: ${Object.entries(dg.shotsByClass[D]).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        `diag fell to (weapon class) A: ${Object.entries(dg.killsByType[A]).map(([k, v]) => `${k}=${v}`).join(' ')} | D: ${Object.entries(dg.killsByType[D]).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      ];
    })(),
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
    for (const d of r.diag) lines.push('    ' + d);
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
  });
});
