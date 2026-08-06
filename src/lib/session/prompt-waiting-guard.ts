/**
 * "Is this session blocked on a prompt right now?" — the guard `send` consults
 * before typing into a session (Issue #1708).
 *
 * A Claude/Codex prompt dialog does not forward keystrokes to the agent: text
 * typed while one is open lands in the composer and sits there. Issue #1708's
 * dispatch runner did exactly that — it read "no progress", sent a nudge, and
 * left the session with a half-typed message queued underneath the dialog. The
 * next `respond` then had to answer a prompt whose input line already contained
 * someone else's text, which is how an "answer" can be delivered as a message.
 *
 * Refusing the send is the only thing that keeps `respond` well defined.
 *
 * Consulted from {@link sendUserMessage}, which is the choke point for every
 * path that types a message at an agent — the send API and the timer manager.
 * Putting it in the route instead would have left scheduled timer sends firing
 * into open dialogs. The answer paths (`respond`, `special-keys`,
 * `prompt-response`) do not go through that function, which is what keeps them
 * open by construction rather than by remembering to exempt them.
 */

import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('prompt-waiting-guard');

/** Stable machine-readable code for the refusal (HTTP body + CLI branching). */
export const PROMPT_WAITING_CODE = 'PROMPT_WAITING';

export interface PromptWaitingVerdict {
  /** True when a prompt is on screen and a send would be swallowed by it. */
  waiting: boolean;
  /** The detector's own reason, for the refusal message. */
  reason?: string;
}

/**
 * Whether a send to this session would land in a prompt dialog's input line.
 *
 * Keyed off `hasActivePrompt` alone — the same signal the UI uses to render
 * PromptPanel and `wait` uses to raise exit 10 — and deliberately NOT off
 * `isSelectionListActive`. Arrow-key menus swallow text too, but they are also
 * what Codex's pager and `/model` overlay look like, and refusing sends for
 * those would block a legitimate message far more often than it would prevent a
 * lost one. The asymmetry is the point: this guard only fires where the system
 * already knows there is something to answer.
 *
 * Fail-open. A capture that throws must not make the session unwritable — the
 * cost of a missed guard is the pre-#1708 behaviour, while the cost of a false
 * refusal is a session nobody can talk to. Note this makes the guard a
 * best-effort narrowing, not a barrier: it is not, and must not be relied on as,
 * a correctness guarantee that no text ever reaches an open dialog.
 *
 * @param worktreeId - Worktree whose session is being written to
 * @param cliToolId - CLI tool driving that session
 * @param instanceId - Agent instance, when not the primary one
 */
export async function isPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<PromptWaitingVerdict> {
  try {
    const cliTool = CLIToolManager.getInstance().getTool(cliToolId);
    if (!(await cliTool.isRunning(worktreeId, instanceId))) {
      return { waiting: false };
    }

    const output = await captureSessionOutput(
      worktreeId,
      cliToolId,
      STATUS_CAPTURE_LINES,
      instanceId,
    );
    const status = detectSessionStatus(output, cliToolId);
    return status.hasActivePrompt
      ? { waiting: true, reason: status.reason }
      : { waiting: false };
  } catch (error: unknown) {
    logger.warn('prompt-waiting-check-failed', {
      worktreeId,
      cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { waiting: false };
  }
}

/**
 * The refusal message. Shared so the HTTP body and the CLI's stderr say the same
 * thing — an operator who hits this in one surface should recognise it in the other.
 */
export function promptWaitingMessage(worktreeId: string): string {
  return (
    `${worktreeId} is waiting on a prompt. Sending now would type into the ` +
    `prompt's input line instead of reaching the agent, and would leave that ` +
    `text in place for the next answer. Answer the prompt first: ` +
    `\`commandmate respond ${worktreeId} <answer>\`.`
  );
}
