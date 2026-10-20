/**
 * What a graceful shutdown released, for the next process to explain
 * (Issue #3730).
 *
 * Auto-Yes grants live in memory (`auto-yes-state`), and the lifecycle table
 * keeps `server-shutdown` at `state: 'none'` on purpose: a restarted server
 * starts with every grant OFF. What was missing is the reason. Without it an
 * instance whose grant the restart took reads exactly like one that was never
 * armed, and a worker sits at its next permission dialog with nothing anywhere
 * saying why.
 *
 * So the shutdown writes down which grants were live, and the next start seeds
 * each still in-period one as a DISABLED state with
 * `stopReason: 'server-restart'` (`seedServerRestartNotice`). This is the
 * explanation of a release, never a restore: nothing here enables a grant or
 * starts a poller.
 *
 * ## Scope
 *
 * - Graceful stops only (SIGINT / SIGTERM through `server.ts`). A SIGKILL, a
 *   crash or a power loss records nothing; every grant then comes back off with
 *   no reason, which is the behaviour before this module.
 * - One record per database: `<CM_DB_PATH>.auto-yes-shutdown.json`. The normal
 *   server's `cm.db` and an Issue server's `cm-N.db` share a directory, so a
 *   fixed name would let one server read the other's grants. Two processes on
 *   ONE database (#1360 calls that a misconfiguration) share the file, and the
 *   last writer wins.
 * - `CM_AUTO_YES_SHUTDOWN_RECORD_PATH` overrides the location; `tests/setup.ts`
 *   points it at a per-worker temp file so no test touches a real one.
 *
 * ## Failure
 *
 * Every failure is logged and swallowed. A record that cannot be written costs
 * the next start its explanation and nothing else; one that cannot be read,
 * parsed or removed leaves every grant off with no reason — the old behaviour —
 * and the server starts. Shutdown is never held up by this module.
 *
 * Writes go to a temp file in the same directory and are renamed over the
 * record (mode 0600), so a reader sees the old record or the new one, never
 * half of one.
 *
 * ## After the record
 *
 * The HTTP drain after the record still answers requests. An enable is refused
 * from the moment the shutdown begins; an OFF (or a session kill, an instance
 * removal, a worktree delete) is accepted — refusing an OFF would leave a
 * worker that was asked to stop answering still armed for the drain — and the
 * record is rewritten from memory after it, so the next start does not bring
 * back a notice the user cleared. Withdrawing rather than refusing: the change
 * only ever narrows the record.
 *
 * @module lib/auto-yes-shutdown-record
 */

import fs from 'fs';
import path from 'path';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { isCliToolType, isValidInstanceId } from './cli-tools/types';
import { isValidWorktreeId } from './security/path-validator';
import {
  beginAutoYesShutdown,
  collectReleasedAutoYesGrants,
  seedServerRestartNotice,
  setAutoYesChangeAfterShutdownListener,
  type ReleasedAutoYesGrant,
} from './auto-yes-state';

const logger = createLogger('auto-yes-shutdown-record');

/** Environment variable that overrides where the record lives. */
export const AUTO_YES_SHUTDOWN_RECORD_PATH_ENV = 'CM_AUTO_YES_SHUTDOWN_RECORD_PATH';

/** Appended to the database path to name its record. */
export const AUTO_YES_SHUTDOWN_RECORD_SUFFIX = '.auto-yes-shutdown.json';

/** Version of the on-disk shape. A record of any other version is ignored. */
const RECORD_VERSION = 1;

/** Upper bound on entries read back: far above any real server, well below abuse. */
const MAX_RECORD_ENTRIES = 1000;

/** The on-disk shape. */
interface AutoYesShutdownRecordFile {
  version: typeof RECORD_VERSION;
  writtenAt: number;
  grants: ReleasedAutoYesGrant[];
}

/**
 * Where this process's record lives: the override, else next to the database.
 *
 * @returns The path, or null when neither can be resolved (the record is then skipped)
 */
export function resolveAutoYesShutdownRecordPath(): string | null {
  const override = (process.env[AUTO_YES_SHUTDOWN_RECORD_PATH_ENV] ?? '').trim();
  if (override !== '') return override;
  try {
    return `${getEnv().CM_DB_PATH}${AUTO_YES_SHUTDOWN_RECORD_SUFFIX}`;
  } catch (error) {
    logger.warn('record-path-unresolved', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Result of {@link recordAutoYesShutdown}. */
export interface RecordAutoYesShutdownResult {
  /** Grants written to the record. */
  recorded: number;
  /** Set when the record could not be written or cleared. */
  error?: string;
}

/**
 * Begin the Auto-Yes side of a graceful shutdown and write down what it
 * releases. Call it before the pollers are stopped.
 *
 * Marks the shutdown first (`beginAutoYesShutdown`), so an enable that returns
 * from an await after this point is refused rather than added behind the
 * record's back. With nothing to record, a leftover record is removed, so a
 * file the previous start failed to delete cannot outlive the grants it named.
 *
 * Never throws.
 *
 * @param options.path - Record path (default: {@link resolveAutoYesShutdownRecordPath})
 * @param options.now - Clock reading (default: Date.now())
 */
export function recordAutoYesShutdown(
  options: { path?: string | null; now?: number } = {},
): RecordAutoYesShutdownResult {
  beginAutoYesShutdown();
  const recordPath = options.path === undefined ? resolveAutoYesShutdownRecordPath() : options.path;
  if (recordPath === null) return { recorded: 0, error: 'record path unresolved' };

  // Every later change rewrites the record from memory (see "After the record").
  setAutoYesChangeAfterShutdownListener(() => {
    const rewritten = writeRecord(recordPath, Date.now());
    if (rewritten.error === undefined) logger.info('record-rewritten', { grants: rewritten.recorded });
  });
  const result = writeRecord(recordPath, options.now ?? Date.now());
  if (result.error === undefined) logger.info('recorded', { grants: result.recorded });
  return result;
}

/**
 * Write the grants memory holds at `now` to `recordPath`, or remove the record
 * when there are none. Never throws.
 */
function writeRecord(recordPath: string, now: number): RecordAutoYesShutdownResult {
  try {
    const grants = collectReleasedAutoYesGrants(now);
    if (grants.length === 0) {
      fs.rmSync(recordPath, { force: true });
      return { recorded: 0 };
    }

    const body: AutoYesShutdownRecordFile = { version: RECORD_VERSION, writtenAt: now, grants };
    const dir = path.dirname(recordPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(dir, `.${path.basename(recordPath)}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tempPath, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tempPath, recordPath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
    return { recorded: grants.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('record-failed', { error: message });
    return { recorded: 0, error: message };
  }
}

/** One grant read back, or null when the entry is not one this module wrote. */
function parseGrant(raw: unknown): ReleasedAutoYesGrant | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const { worktreeId, cliToolId, instanceId, enabledAt, expiresAt } = entry;
  if (typeof worktreeId !== 'string' || !isValidWorktreeId(worktreeId)) return null;
  if (typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) return null;
  if (typeof instanceId !== 'string' || !isValidInstanceId(instanceId)) return null;
  if (typeof enabledAt !== 'number' || !Number.isFinite(enabledAt)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { worktreeId, cliToolId, instanceId, enabledAt, expiresAt };
}

/** The grants in a record, or null when the record is not one this module wrote. */
function parseRecord(text: string): ReleasedAutoYesGrant[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Partial<AutoYesShutdownRecordFile>;
  if (record.version !== RECORD_VERSION || !Array.isArray(record.grants)) return null;
  if (record.grants.length > MAX_RECORD_ENTRIES) return null;
  const grants: ReleasedAutoYesGrant[] = [];
  for (const raw of record.grants) {
    const grant = parseGrant(raw);
    // All or nothing: a record with an entry this module did not write is not
    // its record, and half-trusting it is how a wrong notice gets shown.
    if (!grant) return null;
    grants.push(grant);
  }
  return grants;
}

/** Result of {@link restoreAutoYesShutdownRecord}. */
export interface RestoreAutoYesShutdownResult {
  /** Restart notices seeded. */
  seeded: number;
  /** Grants in the record that were past their deadline or already had a state. */
  skipped: number;
  /** Set when the record existed but could not be read, parsed or removed. */
  error?: string;
}

/**
 * Read the previous process's record, seed a restart notice for each grant
 * still in period, and remove the record. Call it before the server answers its
 * first request: a notice seeded after a request could overwrite what that
 * request wrote (it does not — {@link seedServerRestartNotice} refuses a key
 * that has a state — but the first answers would still lack it).
 *
 * The record is consumed whether or not it parses: a broken file read twice is
 * broken twice. A record that cannot be removed is harmless — the next
 * shutdown overwrites or removes it, and a second read seeds nothing over the
 * states the first one wrote.
 *
 * Never throws; with no record, does nothing.
 *
 * @param options.path - Record path (default: {@link resolveAutoYesShutdownRecordPath})
 * @param options.now - Clock reading (default: Date.now())
 */
export function restoreAutoYesShutdownRecord(
  options: { path?: string | null; now?: number } = {},
): RestoreAutoYesShutdownResult {
  const recordPath = options.path === undefined ? resolveAutoYesShutdownRecordPath() : options.path;
  if (recordPath === null) return { seeded: 0, skipped: 0 };

  let text: string;
  try {
    text = fs.readFileSync(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { seeded: 0, skipped: 0 };
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('restore-unreadable', { error: message });
    return { seeded: 0, skipped: 0, error: message };
  }

  let removeError: string | undefined;
  try {
    fs.rmSync(recordPath, { force: true });
  } catch (error) {
    removeError = error instanceof Error ? error.message : String(error);
    logger.warn('restore-remove-failed', { error: removeError });
  }

  const grants = parseRecord(text);
  if (grants === null) {
    logger.warn('restore-invalid-record');
    return { seeded: 0, skipped: 0, error: 'invalid record' };
  }

  const now = options.now ?? Date.now();
  let seeded = 0;
  for (const grant of grants) {
    if (seedServerRestartNotice(grant, now)) seeded++;
  }
  const skipped = grants.length - seeded;
  if (seeded > 0 || skipped > 0) logger.info('restored', { seeded, skipped });
  return removeError === undefined ? { seeded, skipped } : { seeded, skipped, error: removeError };
}
