/**
 * The dispatch record: which agent-health / metrics Issues were handed to
 * `/orchestrate` on a given JST day (Issue #3046; written by #3045).
 *
 * Path: `~/.commandmate/agent-health/dispatch/<JST date>.json`.
 * #3045 writes it (and imports these types); the release-readiness report
 * (#3046) only reads it, and a missing or malformed file means "nothing was
 * dispatched" rather than an error.
 */

import path from 'path';

export const DISPATCH_STATUSES = ['sent', 'skipped-busy', 'no-target'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export const DISPATCH_ISSUE_KINDS = ['bug', 'metrics'] as const;
export type DispatchIssueKind = (typeof DISPATCH_ISSUE_KINDS)[number];

export interface DispatchIssue {
  number: number;
  kind: DispatchIssueKind;
  title: string;
}

export interface DispatchRecord {
  schemaVersion: 1;
  /** JST `YYYY-MM-DD`. */
  date: string;
  /** `sent` handed to orchestrate; `skipped-busy` orchestrate was running; `no-target` nothing to hand. */
  status: DispatchStatus;
  /** ISO time of the hand-off (only when `status` is `sent`). */
  sentAt?: string;
  issues: DispatchIssue[];
  /** Issue numbers that were candidates but carried over to a later day. */
  deferred: number[];
  /**
   * The Issue numbers handed to orchestrate joined by `-` (e.g. `3050-3051`), so
   * the run files are `summary-<runSuffix>.md` / `tasks-<runSuffix>.tsv` (#3045).
   * Absent in older records: the report then reads every run file of the day.
   */
  runSuffix?: string;
  /** Why the dispatch did not go as planned (a missing label, a failed send …), when it did not. */
  reason?: string;
}

/** `<baseDir>/dispatch/<date>.json` (`baseDir` is `~/.commandmate/agent-health` in production). */
export function dispatchRecordPath(baseDir: string, date: string): string {
  return path.join(baseDir, 'dispatch', `${date}.json`);
}

/** `3050` or `3050-3051-…`: only digits and dashes, so it is safe inside a file name. */
export const RUN_SUFFIX_RE = /^\d+(?:-\d+)*$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseIssue(value: unknown): DispatchIssue | null {
  if (typeof value !== 'object' || value === null) return null;
  const { number, kind, title } = value as Record<string, unknown>;
  if (!isPositiveInteger(number)) return null;
  if (!(DISPATCH_ISSUE_KINDS as readonly unknown[]).includes(kind)) return null;
  return { number, kind: kind as DispatchIssueKind, title: typeof title === 'string' ? title : '' };
}

/**
 * Read a dispatch record's text. Null for a missing file, broken JSON, another
 * schema version or an unknown status; malformed entries inside `issues` /
 * `deferred` are dropped rather than failing the whole record.
 */
export function parseDispatchRecord(text: string | null): DispatchRecord | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  if (typeof raw.date !== 'string') return null;
  if (!(DISPATCH_STATUSES as readonly unknown[]).includes(raw.status)) return null;
  const issues = Array.isArray(raw.issues)
    ? raw.issues.map(parseIssue).filter((issue): issue is DispatchIssue => issue !== null)
    : [];
  const deferred = Array.isArray(raw.deferred) ? raw.deferred.filter(isPositiveInteger) : [];
  return {
    schemaVersion: 1,
    date: raw.date,
    status: raw.status as DispatchStatus,
    ...(typeof raw.sentAt === 'string' ? { sentAt: raw.sentAt } : {}),
    issues,
    deferred,
    ...(typeof raw.runSuffix === 'string' && RUN_SUFFIX_RE.test(raw.runSuffix) ? { runSuffix: raw.runSuffix } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}
