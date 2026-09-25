// ============================================================================
// roster.ts — the campaign's persistent fighting force (roadmap G1 + G3).
//
// The campaign layer is a pure reducer over battle reports: `src/sim/battle.ts`
// exports an end-of-battle BattleReport (per-team, per-soldier outcomes), and
// `applyReport` folds it into the CampaignState. The sim stays deterministic
// and battle-local; all cross-battle state (wounds, kill totals, experience,
// replacements, vehicle damage, battle selection) lives here. Determinism:
// recovery rolls and replacement draws come from a campaign-seeded Rng, not
// the battle's.
// ============================================================================
import type {
  BattleReport, CampaignSoldier, CampaignState, CampaignTeam, Side, SoldierAward, TeamOutcome,
} from '@/shared/types';
import { Rng } from '@/shared/rng';
import { randomName, RANKS } from '@/data/names';
import { EXP_MAX, EXP_MIN } from '@/data/experience';
import { TEAM_DEFS } from '@/data/units';
import { earnedMedals } from '@/data/medals';

/** Wounded men miss this many battles (light) before returning. */
const WOUND_LIGHT_ABSENT = 1;
/** Serious wounds: 2..3 battles (one seeded die roll). */
const WOUND_SERIOUS_ABSENT_MIN = 2;
const WOUND_SERIOUS_ABSENT_SPREAD = 2;

let uidCounter = 0;
export function nextTeamUid(): string {
  return `t${uidCounter++}`;
}
/** Test/roster hook: reset the uid allocator for reproducible campaigns. */
export function resetUidCounter(v = 0): void {
  uidCounter = v;
}

export function newCampaign(
  seed: number, playerSide: Side, requisition: number, difficulty: 'easy' | 'normal' | 'hard' = 'normal',
): CampaignState {
  return {
    seed,
    playerSide,
    battleIndex: 0,
    difficulty,
    soldiers: {},
    teams: [],
    selectedUids: [],
    results: [],
    requisition,
    lastAwards: [],
  };
}


/** Deterministic per-soldier name seed: stable across runs so a repaired
 * roster keeps the same names once assigned. */
function soldierNameSeed(uid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fill in missing soldier names (older saves predating seeded name draws, or
 * teams added without an rng). Deterministic: the same uid always gets the
 * same name. */
export function ensureNames(campaign: CampaignState): void {
  for (const s of Object.values(campaign.soldiers)) {
    if (s.name) continue;
    s.name = randomName(campaign.playerSide, new Rng(campaign.seed ^ soldierNameSeed(s.uid)));
  }
}
/** Add a team of fresh soldiers to the roster (used by the requisition screen at
 * battle start and by replacements). Soldier uids are `<teamUid>/<index>`. */
export function addTeam(
  campaign: CampaignState, defId: string, name: string, soldierDefs: { rank: string; weaponId: string }[],
  vehicleDefId?: string, rng?: Rng,
): CampaignTeam {
  const team: CampaignTeam = {
    uid: nextTeamUid(),
    defId,
    name,
    soldierUids: [],
    vehicleDefId,
    kills: 0,
  };
  soldierDefs.forEach((sd, i) => {
    const uid = `${team.uid}/${i}`;
    const soldier: CampaignSoldier = {
      uid,
      name: rng ? randomName(campaign.playerSide, rng) : '',
      rank: sd.rank,
      weaponId: sd.weaponId,
      side: campaign.playerSide,
      health: 'healthy',
      kills: 0,
      battles: 0,
      experience: Math.round((EXP_MIN + EXP_MAX) / 4),
      teamUid: team.uid,
      medals: [],
    };
    campaign.soldiers[uid] = soldier;
    team.soldierUids.push(uid);
  });
  campaign.teams.push(team);
  return team;
}

/** Fold one battle report into the campaign: kills credited, wounds scheduled,
 * battles counted, KIA removed. Pure over `campaign` (mutates it in place — the
 * campaign is the mutable store by design). */
export function applyReport(campaign: CampaignState, report: BattleReport): void {
  const rng = new Rng(campaign.seed + campaign.battleIndex * 7919);

  const byUid = campaign.soldiers;
  const awards: SoldierAward[] = [];
  report.teams.forEach((team: TeamOutcome, teamIdx: number) => {
    // match report team to roster team by defId (same order as forces list)
    const rosterTeam = campaign.teams[teamIdx];
    if (!rosterTeam || rosterTeam.defId !== team.defId) return;
    rosterTeam.kills += team.kills;
    if (team.vehicleDamage) rosterTeam.vehicleDamage = team.vehicleDamage;

    team.soldiers.forEach((out, soldierIdx) => {
      const uid = rosterTeam.soldierUids[soldierIdx];
      const rec = byUid[uid];
      rec.kills += out.kills;
      // G2: medals on cumulative kills, promotion on a strong battle. Deterministic:
      // the campaign-seeded rng already drives wound severity above.
      const newMedals = earnedMedals(rec.side, rec.kills, rec.medals);
      let promotedTo: string | undefined;
      if (out.kills >= 3 && out.health !== 'dead') {
        const idx = RANKS[rec.side].indexOf(rec.rank);
        // NCO ladder only: never promote into or past the Lt / senior-leader slot
        if (idx > 1) promotedTo = RANKS[rec.side][idx - 1];
      }
      if (newMedals.length > 0 || promotedTo) {
        rec.medals.push(...newMedals);
        if (promotedTo) rec.rank = promotedTo;
        awards.push({
          uid: rec.uid, name: rec.name, rank: rec.rank,
          medalIds: newMedals, promotedTo,
        });
      }
      rec.experience = Math.min(EXP_MAX, Math.max(EXP_MIN, rec.experience + Math.max(0, out.experience - rec.experience)));
      if (out.health === 'dead') {
        rec.health = 'kia';
      } else if (out.health === 'wounded') {
        // severity + recovery from the campaign seed, not the battle's Rng
        const serious = rng.chance(0.35);
        const absent = serious
          ? WOUND_SERIOUS_ABSENT_MIN + rng.int(0, WOUND_SERIOUS_ABSENT_SPREAD - 1)
          : WOUND_LIGHT_ABSENT;
        rec.health = serious ? 'woundedSerious' : 'woundedLight';
        rec.availableFrom = campaign.battleIndex + 1 + absent;
      } else {
        rec.health = 'healthy';
        rec.battles += 1;
      }
    });
  });
  campaign.lastAwards = awards;
  campaign.results.push(report.result);
  campaign.battleIndex += 1;
}

/** Soldiers available for the next battle: fit men + wounds whose time is up. */
export function availableSoldiers(campaign: CampaignState): CampaignSoldier[] {
  return Object.values(campaign.soldiers).filter(
    (s) => s.health === 'healthy'
      || (s.health !== 'kia' && (s.availableFrom ?? 0) <= campaign.battleIndex),
  );
}

/** Fill a team short of men with fresh replacements at reduced experience
 * (G1: replacements come from the side's name pool, seeded). */
export function fillReplacements(campaign: CampaignState, teamUid: string, required: number): number {
  const team = campaign.teams.find((t) => t.uid === teamUid);
  if (!team) return 0;
  const rng = new Rng(campaign.seed + campaign.battleIndex * 104729 + team.soldierUids.length);
  let added = 0;
  const fitCount = team.soldierUids.filter((uid) => campaign.soldiers[uid]?.health !== 'kia').length;
  while (fitCount + added < required) {

    const uid = `${team.uid}/r${campaign.battleIndex}/${added}`;
    const soldier: CampaignSoldier = {
      uid,
      name: randomName(campaign.playerSide, rng),
      rank: rng.pick(RANKS[campaign.playerSide].slice(2)),
      weaponId: '',
      side: campaign.playerSide,
      health: 'healthy',
      kills: 0,
      battles: 0,
      experience: Math.round(EXP_MIN + rng.range(0, 15)),
      teamUid: team.uid,
      medals: [],
    };
    campaign.soldiers[uid] = soldier;
    team.soldierUids.push(uid);
    added++;
  }
  return added;
}


// ============================================================ requisition 2.0 (G3)

/** Requisition multiplier and team slots by difficulty (original: resources scarcer at Hero). */
const REQUISITION_SCALE: Record<CampaignState['difficulty'], number> = { easy: 1.25, normal: 1.0, hard: 0.8 };
const TEAM_SLOTS: Record<CampaignState['difficulty'], number> = { easy: 18, normal: 15, hard: 12 };

export function requisitionPoints(base: number, difficulty: CampaignState['difficulty']): number {
  return Math.round(base * REQUISITION_SCALE[difficulty]);
}

export function maxSlots(difficulty: CampaignState['difficulty']): number {
  return TEAM_SLOTS[difficulty];
}

/** Cost to repair a damaged vehicle: 0.3× team cost, or the full cost when immobilised. */
export function repairCost(team: CampaignTeam): number {
  const def = TEAM_DEFS[team.defId];
  if (!def || !team.vehicleDefId || !team.vehicleDamage) return 0;
  return Math.round(def.cost * (team.vehicleDamage === 'immobilised' ? 1 : 0.3));
}

/** Cost per replacement man brought in via refit. */
export const REPLACEMENT_COST = 5;

export interface RefitResult { spent: number; replaced: number; }

/** Refit a team before a battle: repair its vehicle and/or replace dead men.
 * All-or-nothing per action: if the requisition cannot cover it, nothing changes. */
export function refitTeam(
  campaign: CampaignState, teamUid: string, opts: { repair?: boolean; replace?: boolean; required?: number },
): RefitResult {
  const team = campaign.teams.find((t) => t.uid === teamUid);
  if (!team) return { spent: 0, replaced: 0 };
  let spent = 0;
  let replaced = 0;
  if (opts.repair) {
    const cost = repairCost(team);
    if (cost > 0) {
      if (cost > campaign.requisition) return { spent: 0, replaced: 0 };
      campaign.requisition -= cost;
      spent += cost;
      team.vehicleDamage = undefined;
    }
  }
  if (opts.replace) {
    const required = opts.required ?? 0;
    const short = required - team.soldierUids.filter((uid) => campaign.soldiers[uid]?.health !== 'kia').length;
    const cost = Math.max(0, short) * REPLACEMENT_COST;
    if (cost > 0) {
      if (cost > campaign.requisition) return { spent, replaced: 0 };
      campaign.requisition -= cost;
      spent += cost;
      replaced = fillReplacements(campaign, teamUid, required);
    }
  }
  return { spent, replaced };
}

/** Retire a team's vehicle: the hull is released, the crew continues as a foot team. No refund. */
export function retireVehicle(campaign: CampaignState, teamUid: string): boolean {
  const team = campaign.teams.find((t) => t.uid === teamUid);
  if (!team || !team.vehicleDefId || team.vehicleRetired) return false;
  team.vehicleRetired = true;
  team.vehicleDefId = undefined;
  team.vehicleDamage = undefined;
  return true;
}

/** Select the teams to field in the upcoming battle: validates slot count, year availability
 * and total cost against the fielding allowance. Rejects atomically.
 *
 * The allowance defaults to the campaign's spend balance, which is correct while the balance
 * is untouched (tests, op start). The operation screen passes the operation's requisition
 * allocation instead: acquisitions (force-pool purchases) and refits deduct the SPEND balance
 * (campaign.requisition), but a purchased team must not have to pay for its own fielding
 * again — the fielding fit is a scenario cap, not a second charge on the same requisition. */
export function selectForces(
  campaign: CampaignState, uids: string[], year: number,
  allowance: number = campaign.requisition,
): boolean {
  if (uids.length > maxSlots(campaign.difficulty)) return false;
  let cost = 0;
  for (const uid of uids) {
    const team = campaign.teams.find((t) => t.uid === uid);
    if (!team) return false;
    const def = TEAM_DEFS[team.defId];
    if (!def || !def.years.includes(year)) return false;
    cost += def.cost;
  }
  if (cost > allowance) return false;
  campaign.selectedUids = [...uids];
  return true;
}
/** Upgrade a campaign team to its year-variant successor (G3b): the new hull/gun/squad
 * becomes available, the veteran soldiers (uid, name, kills, experience, health) carry
 * over with rank/weaponId refreshed from the new def, the vehicle swaps, and the cost
 * difference is paid from requisition. Atomic: any failed guard mutates nothing. */
export function upgradeTeam(campaign: CampaignState, teamUid: string, year: number): boolean {
  const team = campaign.teams.find((t) => t.uid === teamUid);
  if (!team) return false;
  const def = TEAM_DEFS[team.defId];
  const next = def?.upgradesTo ? TEAM_DEFS[def.upgradesTo] : undefined;
  if (!def || !next || next.side !== def.side) return false;
  if (!next.years.includes(year)) return false;
  const diff = Math.max(0, next.cost - def.cost);
  if (diff > campaign.requisition) return false;

  campaign.requisition -= diff;
  team.defId = next.id;
  // vehicle: swap to the successor's hull; a retired foot crew may still upgrade
  team.vehicleDefId = next.vehicleDefId;
  team.vehicleDamage = undefined;
  team.vehicleRetired = undefined;
  // soldier carry-over: survivors keep their records; rank/weaponId follow the new def.
  // Slots beyond the new def's size are truncated (KIA at the tail die first); a bigger
  // new def is topped up later by the refit path, not here.
  const survivors = team.soldierUids.filter((uid) => campaign.soldiers[uid]?.health !== 'kia');
  const kept = survivors.slice(0, next.soldiers.length);
  team.soldierUids = kept;
  kept.forEach((uid, i) => {
    const rec = campaign.soldiers[uid];
    rec.rank = next.soldiers[i].rank;
    rec.weaponId = next.soldiers[i].weaponId;
  });
  return true;
}