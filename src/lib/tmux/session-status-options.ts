/**
 * Phase B of Issue #2317: publish the session's state ONTO the tmux session.
 *
 * Before this module, `running` / `waiting` / `ready` / `idle` existed only
 * inside CommandMate. `tmux ls` showed a name and a window count, an attached
 * status line showed tmux's stock clock, and an operator who wanted to know what
 * an agent was doing had to open the web UI or run `commandmate ls`. Two writes
 * per transition fix that:
 *
 *  - **user options** (`@cm_status` and friends) — readable without attaching:
 *    `tmux ls -F '#{session_name} #{@cm_status}'`;
 *  - **a session-scoped `status-right`** — readable while attached, rendered
 *    from those same options so the line updates without being rewritten.
 *
 * ## Everything here is session-scoped, and that is the point
 *
 * `set-option -t <session>` writes the SESSION's option table. The tmux server's
 * global table — which every session on the machine inherits, including ones
 * CommandMate knows nothing about — is never touched, and
 * `tests/unit/tmux/session-status-options-2317.test.ts` asserts that by
 * inspecting the argv of every call this module makes. #1623's `bind-key` is the
 * one global mutation CommandMate makes and it is not made here.
 *
 * ## Writes happen on TRANSITION, not on every poll
 *
 * `GET /api/worktrees` probes every tool of every worktree every couple of
 * seconds. Setting five options on each of those polls would be a few hundred
 * `execFile` round-trips a minute for a value that changes a few times an hour,
 * so {@link publishSessionStatus} keeps the last published tuple per session and
 * returns without touching tmux when nothing moved. The memo is keyed by session
 * name and dropped by {@link forgetSessionStatus} when the session goes away.
 *
 * ## The opt-out converges, without a startup hook
 *
 * `CM_TMUX_STATUS=off` does not merely stop writing: the first status poll after
 * the restart REMOVES the `@cm_*` options and the CommandMate `status-right`
 * from each session it visits, once per session. That is the same "an opt-out
 * that uninstalls" contract #1623 gave `CM_READ_MODE`, and it is done from the
 * poll rather than from a startup sweep for two reasons — the poll already knows
 * which sessions exist (a sweep would have to ask tmux again), and it keeps this
 * feature from needing a wire into `server.ts`, whose startup path is
 * deliberately a single dynamic import per module graph.
 *
 * ## Nothing here may ever throw
 *
 * This is a convenience surface hanging off the status poll. A tmux hiccup must
 * not be able to fail the poll that the sidebar, `commandmate ls` and the header
 * chip all read, so every entry point swallows its errors and logs at debug.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  CM_INSTANCE_OPTION,
  CM_SESSION_OPTIONS,
  CM_STATUS_OPTION,
  CM_STATUS_RIGHT_FORMAT,
  CM_TOOL_OPTION,
  CM_UPDATED_OPTION,
  CM_WORKTREE_OPTION,
  buildSetSessionOptionArgs,
  buildSetStatusRightArgs,
  buildShowSessionOptionArgs,
  buildUnsetSessionOptionArgs,
  buildUnsetStatusRightArgs,
  isTmuxStatusEnabled,
} from '../session/tmux-session-surface';
import { createLogger } from '../logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('tmux-session-status');

/** tmux calls here are interactive-latency, not long-running. */
const TMUX_TIMEOUT = 5000;

/** One session's published state, as last written to tmux. */
interface PublishedStatus {
  status: string;
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
}

/**
 * globalThis-backed memo, for the reason `status-evidence.ts` uses one: under
 * `npm run dev` this module is re-evaluated on every edit, and a plain
 * module-scope Map would forget what it had already written and re-issue five
 * `set-option` calls for every session on the next poll.
 */
declare global {
  // eslint-disable-next-line no-var
  var __cmPublishedTmuxStatus: Map<string, PublishedStatus> | undefined;
}

declare global {
  // eslint-disable-next-line no-var
  var __cmClearedTmuxStatus: Set<string> | undefined;
}

const published =
  globalThis.__cmPublishedTmuxStatus ??
  (globalThis.__cmPublishedTmuxStatus = new Map<string, PublishedStatus>());

/** Sessions this process has already uninstalled the surface from. */
const cleared =
  globalThis.__cmClearedTmuxStatus ?? (globalThis.__cmClearedTmuxStatus = new Set<string>());

/** What one session's status write is about. */
export interface SessionStatusPublication {
  /** tmux session name (`mcbd-<tool>-<worktree>[-<suffix>]`). */
  sessionName: string;
  worktreeId: string;
  cliToolId: string;
  /** Agent instance id; equal to `cliToolId` for a primary instance. */
  instanceId: string;
  /**
   * The status word.
   *
   * The `commandmate ls` STATUS vocabulary — `idle` / `ready` / `running` /
   * `waiting` — and nothing else. Callers get it from `deriveCliStatus()` in
   * `lib/session/status-mapping.ts` rather than composing one here, so the
   * status line and the CLI table cannot name the same session two ways.
   */
  status: string;
  /** Injectable clock, for tests. */
  now?: Date;
}

/** Why {@link publishSessionStatus} did what it did. */
export type PublishOutcome = 'written' | 'unchanged' | 'disabled' | 'error';

/**
 * Write one session's state onto its tmux session, if it changed.
 *
 * @param publication - Session identity plus the status word to publish
 * @returns What was done, for tests and for the caller's logging
 */
export async function publishSessionStatus(
  publication: SessionStatusPublication,
): Promise<PublishOutcome> {
  const { sessionName, worktreeId, cliToolId, instanceId, status } = publication;

  if (!isTmuxStatusEnabled()) {
    // The uninstall path. Once per session per process: `clearSessionStatus`
    // issues six `execFile` calls, and repeating them on every poll of a server
    // that has the surface turned off would be the cost the feature was turned
    // off to avoid.
    if (!cleared.has(sessionName)) {
      cleared.add(sessionName);
      await clearSessionStatus(sessionName);
    }
    return 'disabled';
  }

  const previous = published.get(sessionName);
  if (
    previous &&
    previous.status === status &&
    previous.worktreeId === worktreeId &&
    previous.cliToolId === cliToolId &&
    previous.instanceId === instanceId
  ) {
    return 'unchanged';
  }

  const updated = (publication.now ?? new Date()).toISOString();
  const writes: Array<[string, string]> = [
    [CM_STATUS_OPTION, status],
    [CM_WORKTREE_OPTION, worktreeId],
    [CM_TOOL_OPTION, cliToolId],
    [CM_INSTANCE_OPTION, instanceId],
    [CM_UPDATED_OPTION, updated],
  ];

  try {
    for (const [option, value] of writes) {
      await execFileAsync('tmux', buildSetSessionOptionArgs(sessionName, option, value), {
        timeout: TMUX_TIMEOUT,
      });
    }
    published.set(sessionName, { status, worktreeId, cliToolId, instanceId });
    // The line renders FROM the options above, so it is installed after them —
    // a status-right referencing `#{@cm_status}` on a session that has none
    // paints an empty pair of brackets until the first write lands.
    await ensureSessionStatusLine(sessionName);
    return 'written';
  } catch (error: unknown) {
    // A session that was killed between the poll and this write is the ordinary
    // case, not an incident. Drop the memo so the next live session under the
    // same name republishes rather than being deduped against a dead one.
    published.delete(sessionName);
    logger.debug('session-status:write-failed', {
      sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
}

/**
 * Install the session-scoped `status-right`, unless the session already has one.
 *
 * "Already has one" means a SESSION-scoped value, which is exactly what
 * `show-options -t <session> status-right` reports: measured on tmux 3.5a, a
 * session that never set it answers with empty stdout (the global value is not
 * echoed), and one that did answers `status-right "…"`. So a user who
 * customised this session in `.tmux.conf` — or who set it by hand — keeps their
 * line, and everyone else gets CommandMate's.
 *
 * Idempotent: once installed, the value contains {@link CM_STATUS_RIGHT_FORMAT}
 * and is recognised as ours, so a restart re-installs nothing.
 *
 * @param sessionName - Target session
 * @returns true when the line is CommandMate's after this call
 */
export async function ensureSessionStatusLine(sessionName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      buildShowSessionOptionArgs(sessionName, 'status-right'),
      { timeout: TMUX_TIMEOUT },
    );
    const existing = stdout.trim();
    if (existing !== '' && !existing.includes(CM_STATUS_RIGHT_FORMAT)) {
      logger.debug('session-status:status-right-user-owned', { sessionName, existing });
      return false;
    }
    if (existing === '') {
      await execFileAsync(
        'tmux',
        buildSetStatusRightArgs(sessionName, CM_STATUS_RIGHT_FORMAT),
        { timeout: TMUX_TIMEOUT },
      );
    }
    return true;
  } catch (error: unknown) {
    logger.debug('session-status:status-right-failed', {
      sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Remove every `@cm_*` option and the session-scoped `status-right` we own.
 *
 * The `status-right` is only removed when it is still ours — a user who rebound
 * it after us owns it now, and clobbering that would be the same rudeness
 * {@link ensureSessionStatusLine} exists to avoid.
 *
 * @param sessionName - Target session
 */
export async function clearSessionStatus(sessionName: string): Promise<void> {
  published.delete(sessionName);
  for (const option of CM_SESSION_OPTIONS) {
    try {
      await execFileAsync('tmux', buildUnsetSessionOptionArgs(sessionName, option), {
        timeout: TMUX_TIMEOUT,
      });
    } catch {
      // Unsetting an option that was never set exits non-zero on some builds.
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      buildShowSessionOptionArgs(sessionName, 'status-right'),
      { timeout: TMUX_TIMEOUT },
    );
    if (stdout.includes(CM_STATUS_RIGHT_FORMAT)) {
      await execFileAsync('tmux', buildUnsetStatusRightArgs(sessionName), {
        timeout: TMUX_TIMEOUT,
      });
    }
  } catch {
    // Same reasoning as above: nothing here may fail a caller.
  }
}

/**
 * Forget a session's published state without touching tmux.
 *
 * Called when a session is known to be gone. The next session created under the
 * same name then publishes from scratch instead of being deduped against the
 * dead one's last status.
 */
export function forgetSessionStatus(sessionName: string): void {
  published.delete(sessionName);
  cleared.delete(sessionName);
}

/** Test seam: how many sessions currently have a memoised publication. */
export function publishedSessionCount(): number {
  return published.size;
}
