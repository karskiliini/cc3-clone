// ============================================================================
// netHealth.ts — what the player is told about the network. The lockstep session and the
// checksum layer report trouble here; the battle HUD shows a red "disconnected" symbol while
// trouble lasts and briefly after each new incident, so how often it lights up tells the player
// how bad the connection is. Ordinary lockstep waits (shorter than STALL_SHOW_MS) are not trouble:
// a laggy link waits a little every few turns and the symbol must not flicker for that.
//
// Every incident is also logged (`log`, `logText()`, and `onLog` for the console), with its time
// and details, so a bad game can be looked into afterwards.
// ============================================================================

/** A wait for the peer longer than this is shown as network trouble (ms). */
export const STALL_SHOW_MS = 150;
/** How long the symbol stays lit after a short incident (ms). */
export const INCIDENT_SHOW_MS = 1500;
/** Log entries kept (oldest dropped first). */
const LOG_CAP = 1000;

export type NetIncident = 'stall' | 'corrupt' | 'resync' | 'failed';

export interface NetLogEntry {
  /** When (ms on the owner's clock). */
  atMs: number;
  kind: NetIncident | 'stallEnd' | 'resyncEnd';
  /** Human-readable details: how long a wait lasted, which resync, why the session failed. */
  detail: string;
}

export class NetHealth {
  /** Incidents so far, by kind. */
  readonly counts: Record<NetIncident, number> = { stall: 0, corrupt: 0, resync: 0, failed: 0 };
  /** The incident log, oldest first. */
  readonly log: NetLogEntry[] = [];
  /** Told of every new log entry (e.g. to print it to the console). */
  onLog?: (entry: NetLogEntry) => void;
  /** When the last incident was noted (ms on the owner's clock), or -Infinity. */
  lastIncidentAt = -Infinity;
  /** Ongoing trouble: a long wait for the peer, a resync in progress, or a failed session. */
  private stallSince: number | null = null;
  private stallCounted = false;
  private resyncing = false;
  private resyncSince = 0;
  private failed = false;
  /** Incidents noted before the next clock reading (from layers that have no clock). */
  private pending: { kind: NetIncident; detail: string }[] = [];

  /** A one-off incident (a damaged packet). Without `nowMs` it is stamped at the next update. */
  note(kind: NetIncident, nowMs?: number, detail = ''): void {
    this.counts[kind]++;
    if (nowMs === undefined) {
      this.pending.push({ kind, detail });
      return;
    }
    this.lastIncidentAt = Math.max(this.lastIncidentAt, nowMs);
    this.write(nowMs, kind, detail);
  }

  /** The session's state at `nowMs`: whether it waits for the peer, resyncs, or gave up (and why). */
  update(nowMs: number, waiting: boolean, resyncing: boolean, failed: boolean, why = ''): void {
    if (this.pending.length > 0) {
      for (const p of this.pending) this.write(nowMs, p.kind, p.detail);
      this.pending = [];
      this.lastIncidentAt = nowMs;
    }
    if (waiting) {
      if (this.stallSince === null) { this.stallSince = nowMs; this.stallCounted = false; }
      if (!this.stallCounted && nowMs - this.stallSince >= STALL_SHOW_MS) {
        this.stallCounted = true;
        this.note('stall', nowMs, `waiting for the opponent's commands for over ${STALL_SHOW_MS} ms`);
      }
      if (this.stallCounted) this.lastIncidentAt = nowMs;
    } else if (this.stallSince !== null) {
      if (this.stallCounted) {
        // the symbol stays a moment after a long wait ends
        this.lastIncidentAt = nowMs;
        this.write(nowMs, 'stallEnd', `the wait lasted ${Math.round(nowMs - this.stallSince)} ms`);
      }
      this.stallSince = null;
    }
    if (resyncing && !this.resyncing) {
      this.resyncSince = nowMs;
      this.note('resync', nowMs, 'the game states differed; rebuilding from the shared history');
    }
    if (!resyncing && this.resyncing && !failed) {
      this.lastIncidentAt = nowMs;
      this.write(nowMs, 'resyncEnd', `back in sync after ${Math.round(nowMs - this.resyncSince)} ms`);
    }
    if (resyncing) this.lastIncidentAt = nowMs;
    this.resyncing = resyncing;
    if (failed && !this.failed) this.note('failed', nowMs, why || 'the session stopped');
    this.failed = failed;
  }

  /** Whether the HUD shows the symbol at `nowMs`. */
  troubled(nowMs: number): boolean {
    const waitingLong = this.stallSince !== null && this.stallCounted;
    return this.failed || this.resyncing || waitingLong || nowMs - this.lastIncidentAt < INCIDENT_SHOW_MS;
  }

  /** A short word for the symbol's line. */
  label(): string {
    if (this.failed) return 'Connection lost';
    if (this.resyncing) return 'Resynchronising';
    if (this.stallSince !== null && this.stallCounted) return 'Waiting for opponent';
    return 'Network trouble';
  }

  /** The log as text, one incident per line ("mm:ss.s kind: detail"). */
  logText(): string {
    return this.log.map((e) => {
      const s = Math.max(0, e.atMs) / 1000;
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = (s % 60).toFixed(1).padStart(4, '0');
      return `${mm}:${ss} ${e.kind}${e.detail ? `: ${e.detail}` : ''}`;
    }).join('\n');
  }

  private write(atMs: number, kind: NetLogEntry['kind'], detail: string): void {
    const entry = { atMs, kind, detail };
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    this.onLog?.(entry);
  }
}
