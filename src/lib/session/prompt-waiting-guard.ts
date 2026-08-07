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
import {
  resolvePromptWaiting,
  STRUCTURED_SEND_BLOCK_MAX_AGE_MS,
  STRUCTURED_SEND_GUARD_ENV,
  type PromptWaitingLayer,
} from '@/lib/session/prompt-waiting-composition';

const logger = createLogger('prompt-waiting-guard');

/** Stable machine-readable code for the refusal (HTTP body + CLI branching). */
export const PROMPT_WAITING_CODE = 'PROMPT_WAITING';

export interface PromptWaitingVerdict {
  /** True when a prompt is on screen and a send would be swallowed by it. */
  waiting: boolean;
  /** The refusing layer's own reason, for the refusal message. */
  reason?: string;
  /**
   * Which layer refused (Issue #1737). Present only when `waiting` — it selects
   * the refusal message, which has to name a different way out depending on
   * whether the dialog is one the operator can see on screen.
   */
  blockedBy?: PromptWaitingLayer;
}

/** Per-call knobs for {@link isPromptWaiting}. */
export interface PromptWaitingOptions {
  /**
   * Send anyway if only the structured layer objects (Issue #1737).
   *
   * The escape hatch for a record that has stuck: the agent reported a dialog,
   * every release event was lost, and the scraper never saw the dialog so it
   * cannot report it gone. Narrow on purpose — a prompt the scraper can see is
   * still refused, because that one is real and answerable.
   */
  ignoreStructured?: boolean;
}

/**
 * Whether a send to this session would land in a prompt dialog's input line.
 *
 * Both layers are consulted, through the shared composition (Issue #1737). This
 * function used to call `detectSessionStatus` and answer from it alone, which
 * meant the OR rule #1725 established in `buildCurrentOutput` did not apply
 * here: a dialog only the agent's own events could see — the #1708 shape
 * exactly — was published as `isPromptWaiting: true` and still accepted sends.
 * The composition now lives in one module and both callers read it, so there is
 * no second answer to drift.
 *
 * The scraper's half is keyed off `hasActivePrompt` alone — the same signal the
 * UI uses to render PromptPanel and `wait` uses to raise exit 10 — and
 * deliberately NOT off `isSelectionListActive`. Arrow-key menus swallow text
 * too, but they are also what Codex's pager and `/model` overlay look like, and
 * refusing sends for those would block a legitimate message far more often than
 * it would prevent a lost one. The asymmetry is the point: this guard only
 * fires where the system already knows there is something to answer.
 *
 * Fail-open, in three places now rather than one. A capture that throws must
 * not make the session unwritable — the cost of a missed guard is the pre-#1708
 * behaviour, while the cost of a false refusal is a session nobody can talk to
 * — and the structured layer is held to the same standard: its veto expires
 * ({@link STRUCTURED_SEND_BLOCK_MAX_AGE_MS}), can be switched off for the server
 * ({@link STRUCTURED_SEND_GUARD_ENV}), and can be waived for one send
 * ({@link PromptWaitingOptions.ignoreStructured}). Note this makes the guard a
 * best-effort narrowing, not a barrier: it is not, and must not be relied on as,
 * a correctness guarantee that no text ever reaches an open dialog.
 *
 * @param worktreeId - Worktree whose session is being written to
 * @param cliToolId - CLI tool driving that session
 * @param instanceId - Agent instance, when not the primary one
 * @param options - Per-call overrides; see {@link PromptWaitingOptions}
 */
export async function isPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  options?: PromptWaitingOptions,
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
    const resolution = resolvePromptWaiting({
      worktreeId,
      cliToolId,
      instanceId,
      scraper: {
        status: status.status,
        reason: status.reason,
        hasActivePrompt: status.hasActivePrompt,
      },
      ignoreStructured: options?.ignoreStructured,
    });

    if (!resolution.blocksSend) {
      // A record that saw a dialog and was not allowed to act on it is the
      // fail-open path this Issue added, so it says so out loud. Silence here
      // would make "the guard did not fire" indistinguishable from "there was
      // nothing to fire on", which is the pair an operator needs to tell apart.
      if (resolution.structuredSendBlockSuppressed !== null) {
        logger.info('structured-send-guard-not-applied', {
          worktreeId,
          cliToolId,
          instanceId,
          suppressed: resolution.structuredSendBlockSuppressed,
          promptWaitingSince: resolution.structured?.at ?? null,
        });
      }
      return { waiting: false };
    }

    return {
      waiting: true,
      reason: resolution.blockReason ?? undefined,
      blockedBy: resolution.blockedBy ?? undefined,
    };
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
 *
 * A structured-only refusal gets an extra sentence (Issue #1737), because the
 * two refusals put the operator in different places. When the scraper saw the
 * dialog, it is on screen and `respond` answers it. When only the agent's
 * events saw it, the pane may look perfectly ordinary — and the instruction
 * "answer the prompt" is then advice about a prompt the operator cannot find.
 * That is precisely the state where a guard turns into an outage, so the message
 * has to name the way past it and how long it lasts if they do nothing.
 *
 * @param blockedBy - Which layer refused; omitted callers get the plain message
 */
export function promptWaitingMessage(
  worktreeId: string,
  blockedBy?: PromptWaitingLayer,
): string {
  const base =
    `${worktreeId} is waiting on a prompt. Sending now would type into the ` +
    `prompt's input line instead of reaching the agent, and would leave that ` +
    `text in place for the next answer. Answer the prompt first: ` +
    `\`commandmate respond ${worktreeId} <answer>\`.`;

  if (blockedBy !== 'structured') return base;

  const ttlMinutes = Math.round(STRUCTURED_SEND_BLOCK_MAX_AGE_MS / 60_000);
  return (
    `${base} This dialog was reported by the agent's own hooks and is not ` +
    `visible to the terminal scraper, so if the pane looks idle the record has ` +
    `outlived its dialog: it stops blocking sends ${ttlMinutes} minutes after ` +
    `it was reported, or immediately with ` +
    `\`commandmate send ${worktreeId} <message> --ignore-structured-prompt\` ` +
    `(server-wide: ${STRUCTURED_SEND_GUARD_ENV}=off).`
  );
}
