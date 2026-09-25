import type { BattleConfig, BattleResult, CampaignState, CursorKind, InputState, OperationState, Rect, Screen, Side } from '@/shared/types';
import { otherSide } from '@/shared/types';
import { pointInRect } from '@/shared/math';
import { game } from '@/game';
import { Battle } from '@/sim/battle';
import { OPERATION, initialForcePool } from '@/data/operation';
import { TEAM_DEFS } from '@/data/units';
import { addTeam, applyReport, availableSoldiers, ensureNames, maxSlots, newCampaign, selectForces } from '@/campaign/roster';
import { Rng } from '@/shared/rng';
import { GRAND_CAMPAIGN, operationForIndex } from '@/data/campaign';
import { getMap } from '@/data/maps';
import { drawDarkPanel, drawHeading, drawLabel, drawShadowText, drawSmallMetalButton, UI } from '@/ui/chrome';
import { drawMenuFrame, toMenuInput, BottomStrip, truncateText } from './common';
import { ForcePicker } from './forcePicker';
import { CoaScreen } from './coa';
import { MainMenuScreen } from './mainMenu';
import { DeployScreen } from './deploy';
import { RosterScreen } from './roster';

const OPERATION_KEY = 'cc3.operation';
const CAMPAIGN_KEY = 'cc3.campaign';

/** Short result word for the briefing header's "past results" line — the manual specifies
 * results carry forward from battle to battle, so the player should be able to see them. */
const RESULT_SHORT: Record<BattleResult, string> = {
  totalVictory: 'Total Vict.',
  decisiveVictory: 'Decisive Vict.',
  majorVictory: 'Major Vict.',
  minorVictory: 'Minor Vict.',
  draw: 'Draw',
  minorDefeat: 'Minor Def.',
  majorDefeat: 'Major Def.',
  decisiveDefeat: 'Decisive Def.',
  totalDefeat: 'Total Def.',
};

function saveOperation(op: OperationState): void {
  try {
    localStorage.setItem(OPERATION_KEY, JSON.stringify(op));
  } catch {
    // ignore storage errors
  }
}

function loadOperation(): OperationState | null {
  try {
    const raw = localStorage.getItem(OPERATION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as OperationState;
    // G4 migration: v1 saves carry no opIndex — derive it from the flat index
    if (saved.opIndex === undefined) {
      saved.opIndex = operationForIndex(GRAND_CAMPAIGN, Math.min(saved.index, OPERATION.length - 1));
    }
    return saved;
  } catch {
    return null;
  }
}

function saveCampaign(campaign: CampaignState | null): void {
  try {
    if (campaign) localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(campaign));
  } catch {
    // ignore storage errors
  }
}

function loadCampaign(): CampaignState | null {
  try {
    const raw = localStorage.getItem(CAMPAIGN_KEY);
    return raw ? (JSON.parse(raw) as CampaignState) : null;
  } catch {
    return null;
  }
}

/** Advances the campaign after a battle: records the result, folds the battle report
 * into the persistent roster (G1), and persists the operation and campaign state. */
export function advanceOperation(result: BattleResult): void {
  const op = game.operation;
  if (!op) return;
  op.results.push(result);

  // G3: the campaign roster is the single source of truth — fold the battle report
  // (kills, wounds, experience, vehicle damage) into it, then persist.
  const battle = game.battle;
  if (battle && game.campaign) {
    applyReport(game.campaign, battle.battleReport());
    game.campaign.selectedUids = [];
  }

  op.index += 1;
  // G4: track which Grand Campaign operation the flat index falls in
  op.opIndex = operationForIndex(GRAND_CAMPAIGN, Math.min(op.index, OPERATION.length - 1));
  if (op.index < OPERATION.length) {
    op.requisition = OPERATION[op.index].requisition[op.playerSide];
    // The spend balance refreshes from the NEW operation's allowance (item 041:
    // reading it here under the old index handed briefing N op N-1's budget).
    if (game.campaign) game.campaign.requisition = op.requisition;
  }

  saveOperation(op);
  saveCampaign(game.campaign);
}

const NEW_PANEL: Rect = { x: 200, y: 170, w: 400, h: 200 };

export class OperationScreen implements Screen {
  private mode: 'new' | 'briefing' | 'complete' = 'new';
  private newSide: Side = 'german';
  private hasSaved: boolean;
  private mouse = { x: -1, y: -1 };

  // new-operation widgets
  private sideGerR: Rect = { x: 300, y: 234, w: 132, h: 26 };
  private sideSovR: Rect = { x: 444, y: 234, w: 132, h: 26 };
  private startR: Rect = { x: 224, y: 284, w: 352, h: 26 };
  private continueR: Rect = { x: 224, y: 324, w: 352, h: 26 };

  private picker: ForcePicker | null = null;
  private strip = new BottomStrip({});

  constructor() {
    this.hasSaved = loadOperation() != null;
    if (game.operation && game.operation.index >= OPERATION.length) this.mode = 'complete';
    else if (game.operation) this.enterBriefing();
  }

  private enterBriefing(): void {
    const op = game.operation;
    if (!op) return;
    this.mode = 'briefing';
    this.strip = new BottomStrip({ next: 'Next →', soldiers: true });
    const battleDef = OPERATION[op.index];
    // G3: the campaign roster is the single source of truth. Seed it once per operation
    // from the starting force pool (first battle) — later battles field the survivors.
    if (!game.campaign) {
      const campaign = newCampaign((Date.now() & 0xffff) | 1, op.playerSide, op.requisition, 'normal');
      for (const f of op.forcePool) {
        const def = TEAM_DEFS[f.defId];
        if (!def) continue;
        addTeam(campaign, f.defId, def.name, def.soldiers, def.vehicleDefId,
          new Rng(campaign.seed + campaign.teams.length * 31));
      }
      game.campaign = campaign;
    }
    const campaign = game.campaign;
    // older saves may carry nameless soldiers; repair deterministically
    ensureNames(campaign);
    const uids = campaign.teams.map((t) => t.uid);
    this.picker = new ForcePicker(op.playerSide, battleDef.year, op.requisition, uids);
    this.picker.campaignState = campaign;
    this.picker.campaignUids = [...uids];
    this.picker.maxSlotsOverride = maxSlots(campaign.difficulty);
  }

  update(_dt: number, input: InputState): void {
    const m = toMenuInput(input);
    this.mouse = m.mouse;

    if (this.mode === 'new') {
      for (const c of m.clicks) {
        if (c.button !== 0) continue;
        if (pointInRect(c, this.sideGerR)) this.newSide = 'german';
        else if (pointInRect(c, this.sideSovR)) this.newSide = 'soviet';
        else if (pointInRect(c, this.startR)) {
          const op: OperationState = {
            index: 0,
            playerSide: this.newSide,
            results: [],
            forcePool: initialForcePool(this.newSide),
            requisition: OPERATION[0].requisition[this.newSide],
          };
          game.operation = op;
          // a new operation starts a new kampfgruppe (seeded in enterBriefing)
          game.campaign = null;
          saveOperation(op);
          // G21: the COA planning screen comes first (as in the original), then the
          // briefing, then this screen's force selection
          game.setScreen(new CoaScreen());
          return;
        } else if (this.hasSaved && pointInRect(c, this.continueR)) {
          const saved = loadOperation();
          if (saved) {
            game.operation = saved;
            game.campaign = loadCampaign();
            if (saved.index >= OPERATION.length) this.mode = 'complete';
            else this.enterBriefing();
            return;
          }
        }
      }
      if (this.strip.update(m).back) game.setScreen(new MainMenuScreen());
      return;
    }

    if (this.mode === 'complete') {
      if (this.strip.update(m).back) {
        game.operation = null;
        try {
          localStorage.removeItem(OPERATION_KEY);
        } catch {
          // ignore
        }
        game.setScreen(new MainMenuScreen());
      }
      return;
    }

    // briefing
    const op = game.operation;
    if (!op || !this.picker) return;
    this.picker.update(m);
    this.strip.nextEnabled = this.picker.rosterIds.length > 0;
    const result = this.strip.update(m);
    if (result.soldiers) {
      game.setScreen(new RosterScreen(this));
    } else if (result.back) {
      game.setScreen(new MainMenuScreen());
    } else if (result.next && game.campaign) {
      const campaign = game.campaign;
      const battleDef = OPERATION[op.index];
      // the fielded teams must fit the slot count, the year and this battle's allowance
      if (!selectForces(campaign, this.picker.campaignUids ?? this.picker.rosterIds, battleDef.year, op.requisition)) return;
      if (campaign.selectedUids.length === 0) return;
      const enemy = otherSide(op.playerSide);
      const selectedTeams = campaign.selectedUids
        .map((uid) => campaign.teams.find((t) => t.uid === uid))
        .filter((t) => !!t);
      const roster = availableSoldiers(campaign);
      const forces = selectedTeams.map((t) => t.defId);
      const rosterUids = selectedTeams.map((t) => t.soldierUids.filter((uid) => roster.some((s) => s.uid === uid)));
      const cfg: BattleConfig = {
        mapId: battleDef.mapId,
        playerSide: op.playerSide,
        year: battleDef.year,
        seed: Date.now() & 0xffff,
        durationS: 20 * 60,
        difficulty: 'normal',
        forces: { [op.playerSide]: forces, [enemy]: battleDef.aiForces[enemy] } as Record<Side, string[]>,
        rosterUids: { [op.playerSide]: rosterUids } as Record<Side, string[][]>,
        // item 024: realism toggles ride into the battle config
        alwaysSeeEnemy: game.settings.alwaysSeeEnemy,
        neverActOnInitiative: game.settings.neverActOnInitiative,
        alwaysFullEnemyInfo: game.settings.alwaysFullEnemyInfo,
        alwaysObeyOrders: game.settings.alwaysObeyOrders,
      };
      game.battleConfig = cfg;
      game.battle = new Battle(cfg);
      game.setScreen(new DeployScreen(game.battle));
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawMenuFrame(ctx, 'OPERATION', () => {
      if (this.mode === 'new') this.drawNew(ctx);
      else if (this.mode === 'complete') drawShadowText(ctx, 'OPERATION COMPLETE', 400, 270, UI.title, UI.gold, 'rgba(0,0,0,0.8)', 'center');
      else this.drawBriefing(ctx);
      this.strip.draw(ctx);
    });
  }

  private drawNew(ctx: CanvasRenderingContext2D): void {
    const hot = (r: Rect) => pointInRect(this.mouse, r);
    drawHeading(ctx, 'NEW OPERATION', NEW_PANEL.x + 4, NEW_PANEL.y - 12);
    drawDarkPanel(ctx, { ...NEW_PANEL, h: this.hasSaved ? NEW_PANEL.h : NEW_PANEL.h - 40 });
    drawLabel(ctx, `${OPERATION.length} linked battles; your survivors carry over to the next.`, NEW_PANEL.x + 24, NEW_PANEL.y + 34, UI.body, UI.text);
    drawLabel(ctx, 'Fight as', NEW_PANEL.x + 24, this.sideGerR.y + 17, UI.label, UI.text);
    drawSmallMetalButton(ctx, this.sideGerR, 'German', { active: this.newSide === 'german', hot: hot(this.sideGerR) });
    drawSmallMetalButton(ctx, this.sideSovR, 'Soviet', { active: this.newSide === 'soviet', hot: hot(this.sideSovR) });
    drawSmallMetalButton(ctx, this.startR, 'Start New Operation', { hot: hot(this.startR) });
    if (this.hasSaved) drawSmallMetalButton(ctx, this.continueR, 'Continue Saved Operation', { hot: hot(this.continueR) });
  }

  private drawBriefing(ctx: CanvasRenderingContext2D): void {
    const op = game.operation;
    if (!op || !this.picker) return;
    const battleDef = OPERATION[op.index];
    const mapDef = getMap(battleDef.mapId);
    drawDarkPanel(ctx, { x: 16, y: 44, w: 768, h: 42 });
    drawLabel(ctx, `BATTLE ${op.index + 1} OF ${OPERATION.length}: ${battleDef.title}`, 26, 61, UI.label, UI.gold);
    if (op.results.length > 0) {
      drawLabel(ctx, `Past results: ${op.results.map((r) => RESULT_SHORT[r]).join(', ')}`, 774, 61, UI.note, UI.dim, 'right');
    }
    ctx.font = UI.body;
    ctx.fillStyle = UI.text;
    ctx.fillText(truncateText(ctx, `${mapDef.name} — ${mapDef.description}`, 748), 26, 78);
    this.picker.draw(ctx);
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
