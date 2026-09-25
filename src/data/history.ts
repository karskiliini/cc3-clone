import type { BattleResult, Side } from '@/shared/types';

// ============================================================================
// history.ts — the campaign chronicle (roadmap G15).
//
// One BattleRecord per fought battle, appended when the debrief folds the
// result in. The original's History screen showed a dated list of past
// engagements with a map picture and casualty counts; we persist enough to
// rebuild that from localStorage ('cc3.history').
// ============================================================================

export interface BattleRecord {
  /** grand-campaign operation index (when fought inside the campaign), else -1 */
  opIndex: number;
  /** flat battle index inside the operation, else -1 */
  battleIndex: number;
  mapId: string;
  year: number;
  /** the side the human player commanded */
  playerSide: Side;
  result: BattleResult;
  /** player-side confirmed kills and casualties */
  kills: number;
  losses: number;
  /** enemy casualties */
  enemyLosses: number;
  /** elapsed in-battle seconds at ceasefire */
  durationS: number;
  /** unix ms when the battle was fought */
  foughtAt: number;
}

const HISTORY_KEY = 'cc3.history';

export function loadHistory(): BattleRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BattleRecord[]) : [];
  } catch {
    return [];
  }
}

export function appendHistory(rec: BattleRecord): void {
  const all = loadHistory();
  all.push(rec);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {
    // storage full/quota: history is a nicety, drop the record silently
  }
}
