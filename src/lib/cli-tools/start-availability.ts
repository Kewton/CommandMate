/**
 * The one place a start failure is reported, and the one place a start is
 * refused because the binary is missing (Issue #2009 / #2022).
 *
 * ## Why this module exists at all
 *
 * #2009 established the rule: a CLI that cannot start must be refused by the
 * tool itself, and that refusal must reach a phone through exactly one窓口 —
 * `push/failure-push-notifier`. It wired the call inside
 * `BaseCLITool.startSession`, which is correct for every caller that starts a
 * tmux session.
 *
 * Assistant Chat is not one of them. Measured on this tree (see the docblock on
 * `POST /api/assistant/start`), that route's `cliTool.startSession()` call is
 * unreachable: the route 400s every interactive tool up front, so the
 * non-interactive branch above it always returns first. Assistant Chat runs
 * `claude -p` as a plain child process instead — `lib/assistant/
 * non-interactive-runner` — so #2009's seam is not on its path and never was.
 *
 * Rather than give Assistant Chat a second, private call into the notifier, the
 * reporting half moved here and `BaseCLITool.startSession` now calls it. There
 * is still exactly one line in the repository that calls
 * `notifySessionStartFailurePush`, and it is {@link reportSessionStartFailure};
 * the difference is that a caller which does not create a tmux session can now
 * reach it too.
 *
 * @module lib/cli-tools/start-availability
 */

import type { CLIToolType, ICLITool } from './types';
import { missingToolError } from './install-hints';
import type { SessionStartSubject } from '../session/session-start-error';

/** Who failed to start, for the notification's title and dedup key. */
export interface SessionStartFailureReport {
  /** Identity of the subject; also the dedup and Service-Worker tag key. */
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Agent instance the failure belongs to; defaults to the tool id. */
  instanceId?: string;
  /** Display name of the CLI tool, e.g. `Claude Code`. */
  toolName: string;
  /**
   * Title and tap target, for a subject that is not a worktree row (#2022).
   * Omitted, the notifier resolves both from {@link worktreeId} as before.
   */
  subject?: SessionStartSubject;
}

/**
 * Report a session-start failure. Fire-and-forget; never throws.
 *
 * Not awaited, for the reason `BaseCLITool.startSession` gave when this lived
 * inside it: web push fans out to every registered device, and holding a 503
 * open for that would make a failed start slower to report than a successful
 * one. `notifySessionStartFailurePush` contains its own failures, and the
 * `.catch` here is the belt for the import itself.
 *
 * `await import()` rather than a static import, for the reason Issue #1984
 * gives on `CLIToolManager.stopPollers`: `push/failure-push-notifier` pulls the
 * database and `web-push` behind it, and every one of the seven tool modules
 * loads `./base`, which loads this file. Deferring it to the failure path keeps
 * the cli-tools graph the size #1984 cut it down to.
 *
 * @param report - Who failed, and how the notification should be addressed
 * @param error - Exactly what was thrown; the notifier classifies it
 */
export function reportSessionStartFailure(
  report: SessionStartFailureReport,
  error: unknown
): void {
  void import('../push/failure-push-notifier')
    .then(({ notifySessionStartFailurePush }) =>
      notifySessionStartFailurePush({ ...report, error })
    )
    .catch(() => {});
}

/**
 * A tmux session whose hooks are addressed to another server (Issue #2429).
 *
 * Not a failed start — the session is up and the agent is answering — which is
 * why it carries its own shape rather than being squeezed into a
 * {@link SessionStartFailureReport} with a synthetic error. What it shares with
 * one is the audience: nothing else on any surface reports it, and the operator
 * has to act (restart the session) before the agent's telemetry reaches this
 * server again.
 *
 * The moment it is discovered is no longer only a start. Issue #2433 measured
 * that the start-time probe cannot see the case #2429 was written for — the
 * pane is alive, so nothing restarts it — and added the send path, which is the
 * one that keeps typing into the mispointed session.
 */
export interface StaleHookUrlReport {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Agent instance the pane belongs to; defaults to the tool id. */
  instanceId?: string;
  /** Display name of the CLI tool, e.g. `Command Code CLI`. */
  toolName: string;
  /** The port the adopted pane's launch line still posts hooks to. */
  sessionPort: number;
  /** The port this server is listening on. */
  serverPort: number;
}

/**
 * Which (instance, port pair) has already been reported (Issue #2429).
 *
 * The "once" in the Issue's acceptance, and it is keyed on the *facts* rather
 * than on the session name so the two ways this can recur read correctly:
 *
 *  - the same pane asked about again by the same server — adopted a second
 *    time, or sent to a hundred times more — is the same sentence, and is
 *    dropped;
 *  - a pane that moves to a different mismatch — a third server, or the one it
 *    was pointing at coming back — is a different sentence and is told.
 *
 * Process-lifetime, like every other in-memory notification ledger here: a
 * server that restarts is a server whose port may have changed, and re-asking
 * is cheaper than a stale answer.
 */
const reportedStaleHookUrls = new Set<string>();

/**
 * Report a session whose hook URL names another server, at most once.
 *
 * Fire-and-forget through the same one窓口 as {@link reportSessionStartFailure},
 * and deferred behind `await import()` for the same reason: this file is loaded
 * by `./base`, which every tool module loads, and `push/failure-push-notifier`
 * pulls the database and `web-push` behind it.
 *
 * @param report - The pane, the port it posts to, and the port that is listening
 */
export function reportStaleHookUrl(report: StaleHookUrlReport): void {
  const key = [
    report.worktreeId,
    report.instanceId ?? report.cliToolId,
    report.sessionPort,
    report.serverPort,
  ].join(':');
  if (reportedStaleHookUrls.has(key)) return;
  reportedStaleHookUrls.add(key);

  void import('../push/failure-push-notifier')
    .then(({ notifyStaleHookUrlPush }) => notifyStaleHookUrlPush(report))
    .catch(() => {});
}

/**
 * Forget every stale-hook-URL report made so far (Issue #2429).
 *
 * Test-only, and named so: the ledger above is process-lifetime state, and a
 * suite that asserts "the second call says nothing" needs the first call to be
 * the first one.
 */
export function resetStaleHookUrlReportsForTest(): void {
  reportedStaleHookUrls.clear();
}

/** Where a refusal should be attributed, for {@link assertToolStartable}. */
export interface StartTarget {
  worktreeId: string;
  instanceId?: string;
  subject?: SessionStartSubject;
}

/**
 * Refuse a start this tool cannot perform, reporting it exactly as a failed
 * launch does (Issue #2022).
 *
 * For a caller that goes on to `startSession()` this would be redundant — the
 * tool's own `launchSession` already asks the same question, which is the
 * duplicate #2009 removed from `POST /api/worktrees/:id/send`. It exists for
 * the caller that never reaches `launchSession` at all: Assistant Chat spawns
 * `claude -p` directly, so *something* has to answer "can this even run" before
 * the route reports `status: 'ready'`, and the honest place for that answer is
 * the tool object rather than a hand-rolled check at the HTTP layer.
 *
 * The wording is {@link missingToolError}'s — the same sentence the tool's own
 * launch path throws. It used to be `SessionStartUnavailableError`'s class
 * default instead, on the reasoning that "a tool whose launch path has
 * something more useful to say (copilot ships an install hint) still says it
 * there". That reasoning held only while copilot was the sole tool with a hint:
 * for the other seven the caller that never reaches `launchSession` got a
 * strictly worse sentence than the caller that does, for no reason a reader of
 * the message could see. Issue #2301 gave all eight a hint and pointed both
 * paths at the one builder, so which path found the missing binary no longer
 * changes what the operator is told.
 *
 * @param tool - The tool being asked to start
 * @param target - Who the refusal belongs to, and how to address it
 * @throws SessionStartUnavailableError when the binary is not available
 */
export async function assertToolStartable(
  tool: ICLITool,
  target: StartTarget
): Promise<void> {
  if (await tool.isInstalled()) return;

  const error = missingToolError(tool);
  reportSessionStartFailure(
    {
      worktreeId: target.worktreeId,
      cliToolId: tool.id,
      instanceId: target.instanceId,
      toolName: tool.name,
      subject: target.subject,
    },
    error
  );
  throw error;
}

/**
 * Report a CLI that could not be exec'd, for a caller holding an id and no tool
 * object (Issue #2022).
 *
 * The name has to come from `ICLITool.name` — "Claude Code", not the short UI
 * label `CLI_TOOL_DISPLAY_NAMES` carries ("Claude"). Both are legitimate
 * spellings and the repository uses each in its own place, but ONE missing
 * binary must not read differently depending on which of the two paths found
 * it, and the start gate above reads the tool object. So this one does too —
 * and since Issue #2301 the whole sentence, install hint included, comes from
 * {@link missingToolError} for the same reason.
 *
 * `await import('./manager')` because a static import would be a module-scope
 * cycle: the manager constructs all seven tools, every one of them extends
 * `./base`, and `./base` imports this file. Deferred, there is no cycle and no
 * cost — by the time an assistant execution fails, the route that started it has
 * already loaded the manager.
 *
 * Fire-and-forget and swallowing its own faults, like {@link
 * reportSessionStartFailure}: a phone that cannot be reached must never change
 * what the caller does next.
 *
 * @param cliToolId - The tool whose binary is missing
 * @param target - Who the failure belongs to, and how to address it
 */
export function reportToolUnavailable(cliToolId: CLIToolType, target: StartTarget): void {
  void import('./manager')
    .then(({ CLIToolManager }) => {
      const tool = CLIToolManager.getInstance().getTool(cliToolId);
      reportSessionStartFailure(
        {
          worktreeId: target.worktreeId,
          cliToolId,
          instanceId: target.instanceId,
          toolName: tool.name,
          subject: target.subject,
        },
        missingToolError(tool)
      );
    })
    .catch(() => {});
}
