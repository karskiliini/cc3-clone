import { describe, it, expect } from 'vitest';
import {
  addTeam, newCampaign, refitTeam, repairCost, refitTeam as refit, resetUidCounter,
  requisitionPoints, maxSlots, selectForces, retireVehicle, applyReport, fillReplacements,
} from '../src/campaign/roster';
import { TEAM_DEFS } from '../src/data/units';

const rifle = 'ger_rifle_41';

describe('requisition 2.0 (G3)', () => {
  it('scales points and slots by difficulty, hard < normal < easy', () => {
    expect(requisitionPoints(200, 'easy')).toBe(250);
    expect(requisitionPoints(200, 'normal')).toBe(200);
    expect(requisitionPoints(200, 'hard')).toBe(160);
    expect(maxSlots('hard')).toBeLessThan(maxSlots('normal'));
    expect(maxSlots('normal')).toBeLessThan(maxSlots('easy'));
  });
  it('repair costs 0.3x for damaged, full cost when immobilised', () => {
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers, 'ger_pz3j');
    expect(repairCost(c.teams[0])).toBe(0);
    c.teams[0].vehicleDamage = 'damaged';
    expect(repairCost(c.teams[0])).toBe(Math.round(def.cost * 0.3));
    c.teams[0].vehicleDamage = 'immobilised';
    expect(repairCost(c.teams[0])).toBe(Math.round(def.cost * 1));
  });


  it('refit repair clears vehicle damage and deducts points atomically', () => {
    const c = newCampaign(1, 'german', 20);
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers, 'ger_pz3j');
    c.teams[0].vehicleDamage = 'damaged';
    const cost = repairCost(c.teams[0]);
    const r = refit(c, c.teams[0].uid, { repair: true });
    expect(r.spent).toBe(cost);
    expect(c.teams[0].vehicleDamage).toBeUndefined();
    expect(c.requisition).toBe(20 - cost);
  });

  it('refit with insufficient points leaves state untouched', () => {
    const c = newCampaign(1, 'german', 1);
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers, 'ger_pz3j');
    c.teams[0].vehicleDamage = 'immobilised';
    const before = { req: c.requisition, dmg: c.teams[0].vehicleDamage };
    const r = refitTeam(c, c.teams[0].uid, { repair: true });
    expect(r.spent).toBe(0);
    expect(c.requisition).toBe(before.req);
    expect(c.teams[0].vehicleDamage).toBe(before.dmg);
  });

  it('refit replace tops the team up with fresh men and charges per man', () => {
    resetUidCounter(0);
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers);
    const team = c.teams[0];
    // kill one man
    const kia = team.soldierUids[0];
    c.soldiers[kia].health = 'kia';
    const short = def.soldiers.length - team.soldierUids.length + 1;
    const reqBefore = c.requisition;
    const r = refitTeam(c, team.uid, { replace: true, required: def.soldiers.length });
    expect(r.replaced).toBe(short);
    expect(c.requisition).toBe(reqBefore - short * 5);
    expect(team.soldierUids.filter((uid) => c.soldiers[uid].health !== 'kia').length).toBe(def.soldiers.length);
  });

  it('retireVehicle releases the hull, keeps the crew, is idempotent', () => {
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers, 'ger_pz3j');
    const team = c.teams[0];
    expect(retireVehicle(c, team.uid)).toBe(true);
    expect(team.vehicleDefId).toBeUndefined();
    expect(team.vehicleRetired).toBe(true);
    expect(team.soldierUids.length).toBe(def.soldiers.length);
    expect(retireVehicle(c, team.uid)).toBe(false);
  });

  it('selectForces validates slots, year and cost atomically', () => {
    const c = newCampaign(1, 'german', 200, 'normal');
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers);
    addTeam(c, 'ger_rifle_43', TEAM_DEFS['ger_rifle_43'].name, TEAM_DEFS['ger_rifle_43'].soldiers);
    // year 1941 excludes ger_rifle_43
    expect(selectForces(c, [c.teams[0].uid, c.teams[1].uid], 1941)).toBe(false);
    expect(c.selectedUids).toEqual([]);
    // valid 1943 selection within points
    expect(selectForces(c, [c.teams[1].uid], 1943)).toBe(true);
    expect(c.selectedUids).toEqual([c.teams[1].uid]);
    // over budget rejects and keeps prior selection
    c.requisition = 10;
    expect(selectForces(c, [c.teams[0].uid], 1943)).toBe(false);
    expect(c.selectedUids.length).toBe(1);
  });

  it('applyReport records vehicle damage carry-over', () => {
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers, 'ger_pz3j');
    applyReport(c, {
      result: 'totalVictory',
      fledSide: null,
      teams: [{
        defId: rifle,
        kills: 2,
        soldiers: def.soldiers.map((s) => ({
          uid: '', name: 'x', rank: s.rank, weaponId: s.weaponId,
          health: 'ok' as const, kills: 0, experience: 50, isLeader: false,
        })),
        vehicleDamage: 'immobilised',
      }],
    });
    expect(c.teams[0].vehicleDamage).toBe('immobilised');
  });

  it('fillReplacements returns idempotent count when team is full', () => {
    const c = newCampaign(1, 'german', 100);
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers);
    expect(fillReplacements(c, c.teams[0].uid, def.soldiers.length)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Item 041: campaign force-pool purchases. The picker's pool row click must
// mint a persistent campaign team (addTeam, year-legal by the pool filter),
// deduct the live requisition balance, and field it through BOTH parallel
// lists so the operation's Next selects it. Un-fielding removes from both
// lists but never refunds or destroys the bought team.
// ---------------------------------------------------------------------------
import { ForcePicker } from '../src/ui/screens/common';
import type { InputState } from '../src/shared/types';

function clickInput(x: number, y: number): InputState {
  return {
    mouse: { x: 0, y: 0 },
    buttons: { left: false, right: false, middle: false },
    clicks: [{ x, y, button: 0 }],
    releases: [],
    keysDown: new Set(),
    keysPressed: new Set(),
    keysReleased: new Set(),
    wheel: 0,
    wheelDX: 0,
    wheelDY: 0,
    pointerInside: true,
  };
}

describe('campaign force pool purchases (item 041)', () => {
  // ForcePicker menu-local layout: poolListRect {x:60,y:128}, rosterListRect {x:440,y:128},
  // row height 27, first row centre at +13.
  const POOL_ROW_0 = { x: 70, y: 141 };
  const ROSTER_ROW_1 = { x: 450, y: 168 };

  function campaignPicker(requisition = 220) {
    const c = newCampaign(1, 'german', requisition, 'normal');
    const def = TEAM_DEFS[rifle];
    addTeam(c, rifle, def.name, def.soldiers);
    const picker = new ForcePicker('german', 1941, requisition, c.teams.map((t) => t.uid), false);
    picker.campaignState = c;
    picker.campaignUids = c.teams.map((t) => t.uid);
    picker.maxSlotsOverride = maxSlots('normal');
    return { c, picker };
  }

  function poolDefOf(picker: ForcePicker, row: number) {
    const poolIds = (picker as unknown as { poolIds: string[] }).poolIds;
    return TEAM_DEFS[poolIds[row]];
  }

  it('purchase mints a campaign team, deducts requisition and fields it', () => {
    const { c, picker } = campaignPicker();
    const def = poolDefOf(picker, 0);
    const before = c.requisition;
    picker.update(clickInput(POOL_ROW_0.x, POOL_ROW_0.y));
    expect(c.teams.length).toBe(2);
    const bought = c.teams[1];
    expect(bought.defId).toBe(def.id);
    expect(bought.soldierUids.length).toBe(def.soldiers.length);
    expect(c.requisition).toBe(before - def.cost);
    // the new team rides both parallel lists as its own uid — never the raw defId
    expect(picker.rosterIds).toEqual([c.teams[0].uid, bought.uid]);
    expect(picker.campaignUids).toEqual([c.teams[0].uid, bought.uid]);
    expect(picker.rosterIds.includes(def.id)).toBe(false);
    // the points display is the campaign's live balance
    expect(picker.remaining()).toBe(c.requisition);
  });

  it('no purchase when the points are exhausted', () => {
    const { c, picker } = campaignPicker(5);
    picker.update(clickInput(POOL_ROW_0.x, POOL_ROW_0.y));
    expect(c.teams.length).toBe(1);
    expect(c.requisition).toBe(5);
    expect(picker.rosterIds.length).toBe(1);
    expect(picker.remaining()).toBe(5);
  });

  it('no purchase when the team slots are exhausted', () => {
    const { c, picker } = campaignPicker();
    picker.maxSlotsOverride = 1;
    picker.update(clickInput(POOL_ROW_0.x, POOL_ROW_0.y));
    expect(c.teams.length).toBe(1);
    expect(c.requisition).toBe(220);
    expect(picker.rosterIds.length).toBe(1);
  });

  it('removing a roster row un-fields the team but keeps it in the kampfgruppe', () => {
    const { c, picker } = campaignPicker();
    picker.update(clickInput(POOL_ROW_0.x, POOL_ROW_0.y));
    const reqAfterBuy = c.requisition;
    // first roster click selects the row, second removes it
    picker.update(clickInput(ROSTER_ROW_1.x, ROSTER_ROW_1.y));
    picker.update(clickInput(ROSTER_ROW_1.x, ROSTER_ROW_1.y));
    expect(picker.rosterIds).toEqual([c.teams[0].uid]);
    expect(picker.campaignUids).toEqual([c.teams[0].uid]);
    // the bought team persists (paid, available next op), no refund on un-field
    expect(c.teams.length).toBe(2);
    expect(c.requisition).toBe(reqAfterBuy);
  });

  it('the purchased team passes selectForces under the operation allowance', () => {
    const { c, picker } = campaignPicker();
    picker.update(clickInput(POOL_ROW_0.x, POOL_ROW_0.y));
    expect(selectForces(c, picker.campaignUids!, 1941, 220)).toBe(true);
    expect(c.selectedUids).toContain(c.teams[1].uid);
  });

  it('battle mode keeps raw defId purchases and points-minus-spent display', () => {
    const picker = new ForcePicker('german', 1941, 220, [], false);
    const def = poolDefOf(picker, 0);
    picker.update(clickInput(POOL_ROW_0.x, POOL_ROW_0.y));
    expect(picker.rosterIds).toEqual([def.id]);
    expect(picker.spent()).toBe(def.cost);
    expect(picker.remaining()).toBe(220 - def.cost);
  });
});
