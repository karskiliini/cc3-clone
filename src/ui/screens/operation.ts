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
import { drawDarkPanel, drawLogo, drawScreenTitle, drawShadowText, drawSmallMetalButton } from '@/ui/chrome';
import { beginMenuFrame, toMenuInput, BottomStrip, ForcePicker, wordWrap } from './common';
import { CoaScreen } from './coa';
import { MainMenuScreen } from './mainMenu';
import { OptionsScreen } from './options';
import { DeployScreen } from './deploy';
import { RosterScreen } from './roster';

const OPERATION_KEY = 'cc3.operation';

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
const CAMPAIGN_KEY = 'cc3.campaign';

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

/** Advances the campaign after a battle: records the result, folds the battle report
 * into the persistent roster (G1), and persists the operation state. */
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
    if (game.campaign) {
      // The spend balance refreshes from the NEW operation's allowance (item 041:
      // reading it here under the old index handed briefing N op N-1's budget).
      game.campaign.requisition = op.requisition;
    }
  }

  saveOperation(op);
  saveCampaign(game.campaign);
}

export class OperationScreen implements Screen {
  private mode: 'new' | 'briefing' | 'complete';
  private newSide: Side = 'german';
  private hasSaved: boolean;

  // new-operation widgets
  private sideGerR: Rect = { x: 220, y: 220, w: 176, h: 26 };
  private sideSovR: Rect = { x: 404, y: 220, w: 176, h: 26 };
  private startR: Rect = { x: 320, y: 272, w: 160, h: 26 };
  private continueR: Rect = { x: 300, y: 312, w: 200, h: 26 };

  private picker: ForcePicker | null = null;
  private strip: BottomStrip;

  constructor() {
    this.hasSaved = loadOperation() != null;
    if (!game.operation) {
      this.mode = 'new';
      this.strip = new BottomStrip({ showBack: true, nextEnabled: false });
    } else if (game.operation.index >= OPERATION.length) {
      this.mode = 'complete';
      this.strip = new BottomStrip({ showBack: true, nextEnabled: false });
    } else {
      this.mode = 'briefing';
      this.strip = new BottomStrip({ showBack: true, nextLabel: 'Next →', soldiersEnabled: true });
      this.initPicker();
    }
  }

  private initPicker(): void {
    const op = game.operation;
    if (!op) return;
    const battleDef = OPERATION[op.index];
    const mapDef = getMap(battleDef.mapId);
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
    this.picker = new ForcePicker(op.playerSide, battleDef.year, op.requisition, campaign.teams.map((t) => t.uid), mapDef.season === 'winter');
    this.picker.campaignState = campaign;
    this.picker.campaignUids = campaign.teams.map((t) => t.uid);
    this.picker.maxSlotsOverride = maxSlots(campaign.difficulty);
  }

  update(_dt: number, input: InputState): void {
    // ESC = Back in every menu screen, like the original (round7 UI pass).
    if (input.keysPressed.has('escape')) { game.setScreen(new MainMenuScreen()); return; }
    const m = toMenuInput(input);

    if (this.mode === 'new') {
      for (const c of m.clicks) {
        if (c.button !== 0) continue;
        const p = { x: c.x, y: c.y };
        if (pointInRect(p, this.sideGerR)) this.newSide = 'german';
        else if (pointInRect(p, this.sideSovR)) this.newSide = 'soviet';
        else if (pointInRect(p, this.startR)) {
          const op: OperationState = {
            index: 0,
            playerSide: this.newSide,
            results: [],
            forcePool: initialForcePool(this.newSide),
            requisition: OPERATION[0].requisition[this.newSide],
          };
          game.operation = op;
          saveOperation(op);
          // G21: the COA planning screen comes first (as in the original), then briefing
          game.setScreen(new CoaScreen());
        } else if (this.hasSaved && pointInRect(p, this.continueR)) {
          const saved = loadOperation();
          if (saved) {
            game.operation = saved;
            game.campaign = loadCampaign();
            this.mode = saved.index >= OPERATION.length ? 'complete' : 'briefing';
            // the strip was built for the 'new' panel: rebuild it with the briefing
            // mode's config (Next + the Soldiers entry the campaign enables)
            this.strip = new BottomStrip({ showBack: true, nextLabel: 'Next →', soldiersEnabled: true });
            if (this.mode === 'briefing') this.initPicker();
          }
        }
      }
      const result = this.strip.update(m);
      if (result.quitOrBack || result.main) game.setScreen(new MainMenuScreen());
      if (result.options) { game.setScreen(new OptionsScreen(this)); return; }
      return;
    }

    if (this.mode === 'complete') {
      const result = this.strip.update(m);
      if (result.quitOrBack || result.main) {
        game.operation = null;
        try {
          localStorage.removeItem(OPERATION_KEY);
        } catch {
          // ignore
        }
        game.setScreen(new MainMenuScreen());
      }
      if (result.options) { game.setScreen(new OptionsScreen(this)); return; }
      return;
    }

    // briefing
    const op = game.operation;
    if (!op || !this.picker) return;
    this.picker.update(m);

    const result = this.strip.update(m);
    if (result.soldiers) { game.setScreen(new RosterScreen(this)); return; }
    if (result.quitOrBack || result.main) {
      game.setScreen(new MainMenuScreen());
      return;
    }
    if (result.options) { game.setScreen(new OptionsScreen(this)); return; }
    if (result.next && game.campaign && this.picker) {
      const campaign = game.campaign;
      const battleDef = OPERATION[op.index];
      if (!selectForces(campaign, this.picker.campaignUids ?? this.picker.rosterIds, battleDef.year, op.requisition)) return;
    }
    if (result.next && game.campaign && game.campaign.selectedUids.length > 0) {
      const battleDef = OPERATION[op.index];
      const enemy = otherSide(op.playerSide);
      const campaign = game.campaign;
      const selectedTeams = campaign.selectedUids
        .map((uid) => campaign.teams.find((t) => t.uid === uid))
        .filter((t) => !!t);
      const roster = availableSoldiers(campaign);
      const forces = selectedTeams.map((t) => t.defId);
      const rosterUids = selectedTeams.map((t) =>
        t.soldierUids.filter((uid) => roster.some((s) => s.uid === uid)),
      );
      const cfg: BattleConfig = {
        mapId: battleDef.mapId,
        playerSide: op.playerSide,
        year: battleDef.year,
        seed: Date.now() & 0xffff,
        durationS: 20 * 60,
        difficulty: 'normal',
        forces: { [op.playerSide]: forces, [enemy]: battleDef.aiForces[enemy] } as Record<Side, string[]>,
        rosterUids: { [op.playerSide]: rosterUids } as Record<Side, string[][]>,
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
    beginMenuFrame(ctx);
    drawLogo(ctx);
    drawScreenTitle(ctx, 'OPERATION');

    if (this.mode === 'new') {
      drawDarkPanel(ctx, { x: 200, y: 160, w: 400, h: 200 });
      drawShadowText(ctx, 'NEW OPERATION — CHOOSE YOUR SIDE', 220, 194, 'bold 15px Arial, Helvetica, sans-serif', '#f0d840');
      drawSmallMetalButton(ctx, this.sideGerR, 'German', { hot: this.newSide === 'german' });
      drawSmallMetalButton(ctx, this.sideSovR, 'Soviet', { hot: this.newSide === 'soviet' });
      drawSmallMetalButton(ctx, this.startR, 'Start');
      if (this.hasSaved) drawSmallMetalButton(ctx, this.continueR, 'Continue Operation');
      this.strip.draw(ctx);
      ctx.restore();
      return;
    }

    if (this.mode === 'complete') {
      ctx.font = 'bold 28px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f0d840';
      ctx.fillText('OPERATION COMPLETE', 400, 260);
      this.strip.draw(ctx);
      ctx.restore();
      return;
    }

    const op = game.operation;
    if (!op || !this.picker) {
      ctx.restore();
      return;
    }
    const battleDef = OPERATION[op.index];
    const mapDef = getMap(battleDef.mapId);
    drawDarkPanel(ctx, { x: 16, y: 46, w: 768, h: 42 });
    ctx.font = 'bold 13px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0d840';
    ctx.fillText(`BATTLE ${op.index + 1} OF ${OPERATION.length}: ${battleDef.title}`, 24, 62);
    if (op.results.length > 0) {
      ctx.font = '11px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#e8e8e0';
      ctx.textAlign = 'right';
      ctx.fillText(`Past results: ${op.results.map((r) => RESULT_SHORT[r]).join(', ')}`, 776, 62);
      ctx.textAlign = 'left';
    }
    ctx.font = '11px Arial, Helvetica, sans-serif';
    ctx.fillStyle = '#e8e8e0';
    const desc = wordWrap(`${mapDef.name} — ${mapDef.description}`, 740, 'small').slice(0, 1).join(' ');
    ctx.fillText(desc, 24, 78);
    // G4: the operational situation now lives on its own briefing screen; the
    // header here keeps only the battle count + map name above the picker tabs.
    this.picker.draw(ctx);

    this.strip.draw(ctx);
    ctx.restore();
  }

  cursor(): CursorKind {
    return 'arrow';
  }
}
