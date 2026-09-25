import type { Side } from '@/shared/types';

// ============================================================================
// medals.ts — awards for the campaign layer (roadmap G2).
//
// Kill-threshold ladders per side, modelled on the original's cumulative award
// logic: a soldier earns each medal once his total confirmed kills reach the
// threshold; one medal per id (no repeats). The ladder order is implicit in
// ascending thresholds.
// ============================================================================

export interface MedalDef {
  id: string;
  name: string;
  /** short form for the roster column */
  abbr: string;
  /** total confirmed kills required */
  kills: number;
}

export const MEDAL_DEFS: Record<Side, MedalDef[]> = {
  german: [
    { id: 'ironCross2', name: 'Iron Cross 2nd Class', abbr: 'IC2', kills: 2 },
    { id: 'ironCross1', name: 'Iron Cross 1st Class', abbr: 'IC1', kills: 5 },
    { id: 'germanCross', name: 'German Cross in Gold', abbr: 'GC', kills: 10 },
    { id: 'knightsCross', name: "Knight's Cross", abbr: 'KC', kills: 15 },
  ],
  soviet: [
    { id: 'medalCourage', name: 'Medal for Courage', abbr: 'MC', kills: 2 },
    { id: 'redStar', name: 'Order of the Red Star', abbr: 'RS', kills: 4 },
    { id: 'redBanner', name: 'Order of the Red Banner', abbr: 'RB', kills: 7 },
    { id: 'lenin', name: 'Order of Lenin', abbr: 'OL', kills: 11 },
  ],
};

const MEDALS_BY_ID = new Map<string, MedalDef>(
  Object.values(MEDAL_DEFS).flat().map((m) => [m.id, m]),
);

export function medalById(id: string): MedalDef | undefined {
  return MEDALS_BY_ID.get(id);
}

/** Medals a soldier's new total kill count earns that he does not already hold. */
export function earnedMedals(side: Side, totalKills: number, held: string[]): string[] {
  return MEDAL_DEFS[side]
    .filter((m) => totalKills >= m.kills && !held.includes(m.id))
    .map((m) => m.id);
}
