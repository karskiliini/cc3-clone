import { describe, it, expect } from 'vitest';
import { OPERATION } from '../src/data/operation';
import { GRAND_CAMPAIGN, battleOffsets, flattenCampaign, operationForIndex } from '../src/data/campaign';
import { advanceOperation } from '../src/ui/screens/operation';
import { game } from '../src/game';
import { getMap } from '../src/data/maps';
import type { OperationState } from '../src/shared/types';

describe('grand campaign structure (G4)', () => {
  it('16 operations whose battles all come from the authored list', () => {
    expect(GRAND_CAMPAIGN.length).toBe(16);
    const flat = flattenCampaign(GRAND_CAMPAIGN);
    // 16 operations; the Götterdämmerung finale carries two battles (city, then Reichstag)
    expect(flat.length).toBe(18);
    // every flattened battle is one of the authored entries
    flat.forEach((b) => expect(OPERATION).toContain(b));
  });

  it('every battle references a real map and every operation has battles and dates', () => {
    for (const op of GRAND_CAMPAIGN) {
      expect(op.battles.length).toBeGreaterThan(0);
      expect(op.startDate).toBeTruthy();
      expect(op.situation).toBeTruthy();
      for (const b of op.battles) {
        expect(getMap(b.mapId)).toBeDefined();
      }
    }
  });

  it('operationForIndex maps flat indices to the right operation', () => {
    const offsets = battleOffsets(GRAND_CAMPAIGN);
    // first operation
    expect(operationForIndex(GRAND_CAMPAIGN, 0)).toBe(0);
    // last operation: index at the final offset
    const last = offsets.length - 1;
    expect(operationForIndex(GRAND_CAMPAIGN, offsets[last])).toBe(last);
    // mid-boundary: the index before a boundary belongs to the previous op
    if (offsets.length > 1) {
      expect(operationForIndex(GRAND_CAMPAIGN, offsets[1] - 1)).toBe(0);
      expect(operationForIndex(GRAND_CAMPAIGN, offsets[1])).toBe(1);
    }
  });

  it('advanceOperation rolls opIndex across the campaign', () => {
    const op: OperationState = {
      index: 0,
      playerSide: 'german',
      results: [],
      forcePool: [],
      requisition: 200,
    };
    game.operation = op;
    game.battle = null;
    game.campaign = null;
    advanceOperation('totalVictory');
    expect(op.index).toBe(1);
    expect(op.opIndex).toBe(operationForIndex(GRAND_CAMPAIGN, 1));
    // run to the end: opIndex lands on the final operation
    while (op.index < OPERATION.length) advanceOperation('totalVictory');
    expect(op.index).toBe(OPERATION.length);
    expect(op.opIndex).toBe(operationForIndex(GRAND_CAMPAIGN, OPERATION.length - 1));
    game.operation = null;
  });
});
