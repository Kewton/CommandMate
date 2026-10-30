/**
 * Record of `mcbd-*` sessions stopped through CommandMate's kill (Issue #3993).
 *
 * The `env-clean` gate counts every vanished session of a sibling worktree as a
 * violation, because a worker killing its neighbour is the #1624 failure. The
 * orchestrator stops sibling sessions too — `commandmate instances <wt> kill`
 * when it cleans a worktree up (worktree-cleanup Phase 3) — and the two
 * snapshots cannot tell that apart from a worker's kill: on 2026-10-29 four
 * verification runs of #3957 failed on `- mcbd-…-<another worktree> [other]`
 * for a cleanup nobody in the worker's transcript had run.
 *
 * This ledger is the missing fact: one line per kill, naming the API, the
 * worktree it was for and who asked (the caller's working directory and tmux
 * session). The gate then sets a vanished sibling session apart as `external`
 * only when a kill of that worktree was recorded inside the task's window *and*
 * the caller was not this task's worker. A worker's own kill (its cwd or its
 * tmux session is the task's worktree), a kill with no caller recorded, and a
 * kill that bypassed CommandMate (`tmux kill-session`, `kill-server`) stay
 * violations, exactly as before.
 *
 * Machine-wide, like the gate mutex (`machine-lock.ts`): the CLI writes it and
 * the server's gate reads it, so the path is derived from `$HOME` alone —
 * `~/.commandmate/session-kills/<UTC date>.jsonl` — with an override for tests.
 * The `commandmate-entries` probe ignores the directory, like `locks`.
 *
 * Node built-ins only: the CLI imports this module.
 *
 * @module lib/verification/session-kill-ledger
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Directory under `~/.commandmate`; exported for the `commandmate-entries` probe. */
export const SESSION_KILL_LEDGER_DIR_NAME = 'session-kills';

/** Overrides the ledger directory (tests, isolated environments). */
export const SESSION_KILL_LEDGER_ROOT_ENV = 'CM_SESSION_KILL_LEDGER_ROOT';

/** Bumped only when a line stops being readable by this module. */
export const SESSION_KILL_LEDGER_VERSION = 1;

/** Day files older than this are removed when a new line is written (same as env snapshots). */
export const SESSION_KILL_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** The API the kill went through; the only one recorded today. */
export type SessionKillApi = 'kill-session';

export interface SessionKillRecord {
  version: number;
  /** Epoch ms of the successful kill. */
  at: number;
  api: SessionKillApi;
  /** Worktree whose session(s) were stopped. */
  worktreeId: string;
  /** Instance the kill was scoped to; null for a whole-worktree kill. */
  instanceId: string | null;
  /** Working directory of the process that asked; null when unreadable. */
  callerCwd: string | null;
  /** tmux session the caller ran inside; null outside tmux. */
  callerSession: string | null;
}

export function defaultSessionKillLedgerRoot(): string {
  return join(homedir(), '.commandmate', SESSION_KILL_LEDGER_DIR_NAME);
}

export function resolveSessionKillLedgerRoot(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env[SESSION_KILL_LEDGER_ROOT_ENV];
  return override && override.trim() !== '' ? override : defaultSessionKillLedgerRoot();
}

function dayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function pruneOldDays(root: string, now: number): void {
  const oldest = dayOf(now - SESSION_KILL_LEDGER_RETENTION_MS);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const day = DAY_FILE_PATTERN.exec(name)?.[1];
    if (day === undefined || day >= oldest) continue;
    try {
      rmSync(join(root, name), { force: true });
    } catch {
      // A day file that cannot be removed is disk use, not a reason to fail a kill.
    }
  }
}

/**
 * Append one kill. Never throws: the kill already happened, and failing the
 * command over its bookkeeping would only hide that.
 *
 * @returns true when the line was written
 */
export function appendSessionKillRecord(
  record: SessionKillRecord,
  root: string = resolveSessionKillLedgerRoot()
): boolean {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // One short line per append; O_APPEND keeps concurrent writers' lines whole.
    appendFileSync(join(root, `${dayOf(record.at)}.jsonl`), `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    pruneOldDays(root, record.at);
    return true;
  } catch {
    return false;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Whether a parsed line is a record this module can use; anything else is skipped. */
export function isSessionKillRecord(value: unknown): value is SessionKillRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === SESSION_KILL_LEDGER_VERSION &&
    typeof record.at === 'number' &&
    record.api === 'kill-session' &&
    typeof record.worktreeId === 'string' &&
    record.worktreeId !== '' &&
    isNullableString(record.instanceId) &&
    isNullableString(record.callerCwd) &&
    isNullableString(record.callerSession)
  );
}

/**
 * The kills recorded in `[since, until]` (epoch ms, inclusive).
 *
 * A missing directory, an unreadable day file and a malformed line all read as
 * "no record", which only ever excuses less.
 */
export function readSessionKillRecords(
  since: number,
  until: number,
  root: string = resolveSessionKillLedgerRoot()
): SessionKillRecord[] {
  if (!(since <= until)) return [];
  // Nothing older than the retention survives, so a stale baseline costs no extra reads.
  since = Math.max(since, until - SESSION_KILL_LEDGER_RETENTION_MS - DAY_MS);
  const records: SessionKillRecord[] = [];
  for (let day = Date.parse(`${dayOf(since)}T00:00:00.000Z`); day <= until; day += DAY_MS) {
    let text: string;
    try {
      text = readFileSync(join(root, `${dayOf(day)}.jsonl`), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isSessionKillRecord(parsed) && parsed.at >= since && parsed.at <= until) {
        records.push(parsed);
      }
    }
  }
  return records;
}
