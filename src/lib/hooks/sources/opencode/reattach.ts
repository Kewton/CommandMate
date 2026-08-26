/**
 * Re-open the event streams of opencode panes that outlived this process
 * (Issue #2108).
 *
 * ## The gap this closes
 *
 * `./ports` writes every assignment to `~/.commandmate/opencode-ports.json`
 * precisely so a CommandMate restart can find a server that is still listening,
 * and `recoverOpencodePort` already does the whole of the recovery: read the
 * file, refuse an entry recorded for a different worktree, and refuse a port
 * that does not answer `/global/health` as opencode. What was missing was a
 * *caller*. The only chain that reached it was
 * `OpenCodeTool.launchSession()` -> `resumeOpencodeEventStream()`, which runs
 * on the "the pane already exists" branch of a **launch** — and a launch is
 * exactly what does not happen after a restart, because `POST /send` skips
 * `startSession` when `isRunning` is already true.
 *
 * So the in-memory map stayed empty for the life of the process while the file
 * on disk held the right number. Measured on 2026-08-26 (opencode 1.18.23,
 * design doc §28): with the pane alive and `GET /global/health` answering
 * `{"healthy":true}` on the recorded port, a restarted CommandMate returned
 * `409 NO_OPENCODE_PORT` from `POST /api/worktrees/<id>/opencode/session`,
 * `connected: false` from `GET .../instances/opencode` and `live: false` from
 * `GET .../opencode/session` — while `current-output` still reported
 * `isRunning: true`, because the screen scraper never needed the port. That
 * asymmetry is what made the defect hard to see: the terminal looked fine and
 * only the HTTP surfaces were dead.
 *
 * ## Why this reuses `resumeOpencodeEventStream` rather than deferring
 *
 * The obvious alternative is to recover lazily, inside
 * `getAssignedOpencodePort()` on a miss. It cannot be done safely there: that
 * function is synchronous and takes no `worktreePath`, so neither of
 * `recoverOpencodePort`'s two guards — the recorded-path comparison and the
 * health check — can be applied. A lazy recovery would hand back a number from
 * a file with nothing verifying that the thing on it is this worktree's
 * opencode, which is the "two owners of one port" failure `./ports` was written
 * to avoid.
 *
 * ## What it will not do
 *
 * - **It does not resurrect dead entries.** The port file accumulates
 *   assignments for panes that are long gone (7 of the 8 entries on the
 *   author's machine were `/tmp/wt-alpha`-style leftovers from tests). An entry
 *   is only a candidate when its pane answers `isRunning` right now, so a stale
 *   row costs a `has-session` rather than a health-check timeout.
 * - **It does not adopt a stolen port.** `recoverOpencodePort` health-checks
 *   before it writes anything and logs `opencode-port-recovery-unhealthy` when
 *   nothing answers; a *different* opencode that took the number is caught by
 *   the subscription watchdog's existing `port_identity_changed` path, which
 *   compares server versions. Neither is re-implemented here.
 * - **It does not let the file vouch for itself.** `recoverOpencodePort`'s
 *   second guard compares the caller's `worktreePath` against the recorded one,
 *   and handing the recorded value straight back would make that comparison
 *   trivially true — the guard would be present and inert. The path passed in
 *   is therefore the *database's*, freshly re-synced by `initializeWorktrees()`
 *   a moment earlier, so the two sides of the comparison have independent
 *   origins exactly as they do on the launch path. A worktree id the database
 *   does not know is skipped without a probe.
 * - **It does not delay startup.** Every entry is swept concurrently and the
 *   whole sweep is fail-open, so `server.ts` hands it off without awaiting it.
 *   The worst case for one entry is a health probe that times out.
 * - **It touches no other tool.** claude, codex, copilot, gemini, antigravity
 *   and vibe-local have no port to recover and no branch here; keys for any
 *   other `cliToolId` are skipped before anything is derived from them.
 *
 * ## Why the pane check goes through `ICLITool.isRunning`
 *
 * A single `tmux list-sessions` would answer for the whole sweep in one call,
 * and it is not allowed: Issue #1922 §4 D4 keeps `src/lib/tmux/**` behind the
 * CLITool gateway, for the static *and* the dynamic import (`.eslintrc.json`
 * has a `no-restricted-syntax` selector for the second, with no allowlist).
 * `OpenCodeTool.isRunning` is one of the five sanctioned entry points and it
 * derives the session name the same way the launcher does, which is the
 * comparison that actually matters here. The cost is one `has-session` per
 * persisted row instead of one `list-sessions` per sweep; they run concurrently
 * and each is a few milliseconds.
 *
 * @module lib/hooks/sources/opencode/reattach
 */

import { extractCliToolId, extractInstanceId, extractWorktreeId } from '@/lib/auto-yes-state';
import { isHookInjectionEnabled } from '@/lib/hooks/hook-settings-generator';
import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '../types';
import { readPersistedOpencodePorts, type OpencodePortAssignment } from './ports';
import { resumeOpencodeEventStream } from './runtime';
import { OPENCODE_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/opencode/reattach');

/** What one sweep did. Counts only — the per-entry detail is in the log. */
export interface OpencodeReattachReport {
  /** Usable opencode entries in the persisted port file. */
  persisted: number;
  /** Of those, the ones whose pane is still running. */
  candidates: number;
  /** Candidates whose stream came back. */
  reattached: number;
  /** Candidates whose server did not answer, or whose entry was refused. */
  skipped: number;
}

/** One persisted entry, before anything has been checked about it. */
interface OpencodePortEntry {
  target: AgentInstanceRef;
  /** The path the entry was written with. Compared against, never trusted. */
  recordedPath: string;
  port: number;
}

/** What the sweep decided about one entry. */
type EntryOutcome = 'no-pane' | 'reattached' | 'skipped';

const EMPTY_REPORT: OpencodeReattachReport = {
  persisted: 0,
  candidates: 0,
  reattached: 0,
  skipped: 0,
};

/**
 * Turn a persisted key back into the instance it names.
 *
 * The key is `buildCompositeKey`'s output, so the split is that function's
 * inverse and the three `extract*` helpers are the one implementation of it.
 * Anything that is not an opencode key — a hand-edited file, a key written by
 * a future tool — answers null rather than being coerced into one.
 */
function targetOfKey(key: string): AgentInstanceRef | null {
  const cliToolId = extractCliToolId(key);
  if (cliToolId !== OPENCODE_CLI_TOOL_ID) return null;
  const worktreeId = extractWorktreeId(key);
  if (worktreeId.length === 0) return null;
  const instanceId = extractInstanceId(key);
  if (instanceId === null || instanceId.length === 0) return null;
  return { worktreeId, cliToolId, instanceId };
}

/** The opencode rows of the persisted file, in file order. */
function readOpencodeEntries(
  persisted: Record<string, OpencodePortAssignment>
): OpencodePortEntry[] {
  const entries: OpencodePortEntry[] = [];
  for (const [key, assignment] of Object.entries(persisted)) {
    const target = targetOfKey(key);
    if (target === null) continue;
    entries.push({ target, recordedPath: assignment.worktreePath, port: assignment.port });
  }
  return entries;
}

/**
 * A `worktreeId -> path` lookup backed by the database.
 *
 * Answers null for every id when the database cannot be opened, which makes the
 * sweep a no-op rather than a crash — the same fail-open the rest of this
 * pipeline has. Loaded through `await import` for the reason `./ingest` does:
 * keeping `better-sqlite3` out of the static graph of `@/lib/hooks/sources` is
 * what lets the launcher import this directory at all.
 */
async function loadWorktreePathResolver(): Promise<(worktreeId: string) => string | null> {
  try {
    const [{ getDbInstance }, { getWorktreeById }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
    ]);
    const db = getDbInstance();
    return (worktreeId: string) => getWorktreeById(db, worktreeId)?.path ?? null;
  } catch (error) {
    logger.warn('opencode-reattach-worktree-lookup-unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return () => null;
  }
}

/**
 * "Is this instance's pane still running?", through the sanctioned gateway.
 *
 * Answers false when the gateway itself refuses — `getSessionName` throws on a
 * worktree id that could not have produced a tmux session, which for a file the
 * user can edit is a reason to skip the row rather than to abandon the sweep.
 */
async function loadPaneCheck(): Promise<(target: AgentInstanceRef) => Promise<boolean>> {
  const { CLIToolManager } = await import('@/lib/cli-tools/manager');
  const tool = CLIToolManager.getInstance().getTool(OPENCODE_CLI_TOOL_ID);
  return async (target: AgentInstanceRef) => {
    try {
      return await tool.isRunning(target.worktreeId, target.instanceId);
    } catch (error) {
      logger.info('opencode-reattach-pane-check-failed', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
}

/**
 * Re-subscribe to every opencode pane that survived the last process.
 *
 * Called once from `server.ts`, after the migrations that `./ingest` needs and
 * without being awaited. Never throws and never rejects.
 *
 * @returns What the sweep found and did
 */
export async function reattachOpencodeEventStreams(): Promise<OpencodeReattachReport> {
  // No injection means no `--port` was ever passed, so there is no server on
  // any recorded number. Checked before anything is loaded so the sweep costs
  // nothing at all when the feature is off.
  if (!isHookInjectionEnabled()) return { ...EMPTY_REPORT };

  try {
    // Read once: the sweep must not see two different versions of the file, and
    // a launch racing it would otherwise be counted in one half and not the
    // other.
    const entries = readOpencodeEntries(readPersistedOpencodePorts());
    if (entries.length === 0) return { ...EMPTY_REPORT };

    const [isPaneRunning, resolveWorktreePath] = await Promise.all([
      loadPaneCheck(),
      loadWorktreePathResolver(),
    ]);

    // Concurrent on purpose: the cost of an entry is a `has-session` plus, for
    // a live pane, a health probe against a server that is either there
    // (sub-millisecond) or not (one timeout). Serialising them would make the
    // sweep as slow as the sum of the dead ones.
    const outcomes = await Promise.all(
      entries.map(async (entry): Promise<EntryOutcome> => {
        if (!(await isPaneRunning(entry.target))) return 'no-pane';

        const instanceId = entry.target.instanceId ?? entry.target.cliToolId;
        const worktreePath = resolveWorktreePath(entry.target.worktreeId);
        if (worktreePath === null) {
          // The pane outlived the worktree row (deleted, or renumbered without
          // its alias). Nothing here can say where it is, and guessing is what
          // the guard exists to prevent.
          logger.info('opencode-reattach-unknown-worktree', {
            worktreeId: entry.target.worktreeId,
            instanceId,
            recorded: entry.recordedPath,
          });
          return 'skipped';
        }

        if (await resumeOpencodeEventStream(entry.target, worktreePath)) return 'reattached';

        // `recoverOpencodePort` has already said *why* at info level
        // (`opencode-port-recovery-unhealthy` / `-path-mismatch`); this names
        // the pane that is consequently scraper-only for the rest of its life.
        logger.info('opencode-reattach-skipped', {
          worktreeId: entry.target.worktreeId,
          instanceId,
          port: entry.port,
        });
        return 'skipped';
      })
    );

    const report: OpencodeReattachReport = {
      persisted: entries.length,
      candidates: outcomes.filter((outcome) => outcome !== 'no-pane').length,
      reattached: outcomes.filter((outcome) => outcome === 'reattached').length,
      skipped: outcomes.filter((outcome) => outcome === 'skipped').length,
    };
    logger.info(
      report.candidates === 0 ? 'opencode-reattach-no-live-panes' : 'opencode-reattach-complete',
      { ...report }
    );
    return report;
  } catch (error) {
    // Fail-open like everything else in this pipeline: a sweep that cannot run
    // leaves exactly the pre-#2108 behaviour, which is the screen scraper.
    logger.warn('opencode-reattach-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...EMPTY_REPORT };
  }
}
