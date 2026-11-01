/**
 * Shared user-message send service (Issue #1028).
 *
 * Extracts the "send a validated user message and record it in history" flow
 * that previously lived inline in POST /api/worktrees/[id]/send. Both the send
 * API route and the Timer manager (executeTimer) call this so timer-fired
 * messages take the exact same recording path as manual sends and therefore
 * appear in Message History.
 *
 * Responsibilities (in order):
 *   1. copilot /model command        — Issue #576 (copilot only); then wait for
 *                                      the poller still watching the previous
 *                                      turn to record it (Issue #2630)
 *   2. savePendingAssistantResponse  — persist the previous assistant reply;
 *                                      the user-row stamp is read just before
 *                                      it, after step 1 (Issue #2630)
 *   3. orphan detection              — Issue #379 duplicate-message guard
 *   4. send to CLI tool              — image branch / ICLITool.sendMessage
 *   5. createMessage (role: 'user')  — INSERT INTO chat_messages (History source)
 *   5b. broadcastMessage('message')  — Issue #2195, push the user row to every
 *                                      open pane (the send that produced it is
 *                                      not necessarily on this device)
 *   6. orphan deletion               — remove prior duplicate after persist
 *   6b. broadcastMessage(              — Issue #2219, tell every open pane for
 *         'messages_invalidated')        this instance to re-read its history:
 *                                        a delete has no row to publish
 *   7. updateLastUserMessage
 *   8. clearInProgressMessageId
 *   9. startPolling                  — record the assistant response afterwards
 *
 * Every attempt that reaches the ownership check also records how it ended —
 * not-sent / sent / indeterminate — for `prompt --json`'s `lastSend` (Issue
 * #3759, `./send-attempt-state`). Nothing is resent on any outcome. The
 * caller can also be handed its own attempt (`onAttempt`, Issue #3945), so it
 * describes this send rather than whichever send to the instance recorded last.
 *
 * Issue #3945: for the tools whose composer is read after a failure (claude,
 * codex), step 4 runs under the instance's input lock, the failure read
 * included — a read made after the lock was released could be reading the next
 * send's body. The tool's own sender joins that lock rather than queueing
 * behind it (`instance-input-lock`).
 *
 * Out of scope (kept in the HTTP layer / caller): request/body validation,
 * content trimming/size limits, imagePath validation, CLI-tool availability
 * and session-start (running) checks. The caller passes already-validated input.
 */

import type Database from 'better-sqlite3';
import {
  createMessage,
  updateLastUserMessage,
  clearInProgressMessageId,
  getMessages,
  deleteMessageById,
} from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { isImageCapableCLITool, type CLIToolType, type ICLITool } from '@/lib/cli-tools/types';
import { startPolling, getActivePollers } from '@/lib/polling/response-poller';
import { savePendingAssistantResponse } from '@/lib/assistant-response-saver';
import { broadcastMessage } from '@/lib/ws-server';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';
import { createLogger } from '@/lib/logger';
import { checkWorktreeSessionOwnership } from '@/lib/cli-tools/worktree-session-ownership';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { isPromptWaiting, promptWaitingMessage } from '@/lib/session/prompt-waiting-guard';
import {
  SESSION_STARTING_CODE,
  isSessionStartTimeoutError,
} from '@/lib/session/session-start-error';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import {
  classifySendFailure,
  composerHoldsMessage,
  recordSendAttempt,
} from '@/lib/session/send-attempt-state';
import {
  INPUT_RECHECK_FAILED_CODE,
  INPUT_RECHECK_PROMPT_WAITING_CODE,
  type SendAttemptReason,
  type SendAttemptState,
} from '@/lib/session/send-attempt-types';
import { extractComposerText, SUPPORTED_COMPOSER_TOOLS } from '@/lib/detection/composer-text';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import {
  isInputBoundaryRefusal,
  observeInputStart,
  withInstanceInputLock,
  type InputBoundaryHooks,
} from '@/lib/session/instance-input-lock';
import type { CopilotTool } from '@/lib/cli-tools/copilot';
import { formatImagePathFallbackMessage } from '@/lib/cli-tools/opencode';
import type { ChatMessage, MessageType } from '@/types/models';

const logger = createLogger('session/send-user-message');

/** Parameters for {@link sendUserMessage}. All values must be pre-validated. */
export interface SendUserMessageParams {
  /** Target worktree ID. */
  worktreeId: string;
  /** Validated, trimmed message content (non-empty). */
  content: string;
  /** Resolved CLI tool ID. */
  cliToolId: CLIToolType;
  /** Agent instance ID; defaults to the primary instance (=== cliToolId). */
  instanceId?: string;
  /**
   * The tool the PROMPT_WAITING refusal's `respond` names when no instance was
   * named (Issue #4049). Set by the send route from `respondAgentFor` — only
   * when the request named a tool other than the worktree default; omitted, the
   * sentence is as before.
   */
  respondAgent?: CLIToolType;
  /** chat_messages message_type. Defaults to 'normal'. */
  messageType?: MessageType;
  /**
   * `chat_messages.request_id` for the row this send writes (Issue #2377).
   *
   * Omitted by every human-facing path — a message a person typed has no
   * producer id — and set by the relay delivery, where the row has to point back
   * at the ledger entry that produced it (`relay:<relayId>`). That pointer is
   * read in both directions: the ledger's UNIQUE index on `sent_request_id`
   * makes a second delivery of one relay unrecordable, and the loop guard walks
   * the other way, from the newest user row to the relay whose depth the next
   * one is measured from.
   */
  requestId?: string;
  /** Validated absolute image path (send API only; Timer never sets this). */
  absoluteImagePath?: string;
  /** Validated Copilot model to switch to before sending (send API only). */
  copilotModel?: string;
  /**
   * Send even if only the structured layer reports an open dialog (Issue
   * #1737). The operator's escape hatch for a hook-reported dialog that nothing
   * ever released; a prompt the scraper can see is still refused.
   */
  ignoreStructuredPromptGuard?: boolean;
  /**
   * Told how THIS attempt ended, as it is recorded for `lastSend` (Issue
   * #3945). The shared record holds the instance's last attempt, which with
   * concurrent sends may be another request's — same text included.
   */
  onAttempt?: (attempt: { state: SendAttemptState; reason: SendAttemptReason }) => void;
  /**
   * Called at the moment the body starts going into the composer — inside the
   * sender's `noteInputStart`, synchronously (Issue #3957; the stamp of
   * #3953) — and only when the sender reports one. The send route reads
   * "was the instance mid-turn" here, so neither a turn that ended while this
   * send queued nor a turn that opens after the body went in is mistaken for
   * the state at the input. It runs before the send is known to have
   * succeeded.
   */
  onInputStart?: (inputStartedAt: Date) => void;
  /**
   * Issue #3957: the REQUIRED hook a relay-bound send records its boundary
   * with, right before the body's first key (or right before an HTTP dispatch
   * that types none). Unlike `onInputStart` a throw from it stops the send
   * before anything is typed, and the attempt is `not-sent`.
   */
  inputBoundary?: InputBoundaryHooks;
}

/** Result of {@link sendUserMessage}. */
export type SendUserMessageResult =
  | { ok: true; message: ChatMessage }
  /**
   * `prompt_waiting` (Issue #1708) is a refusal, not a failure: nothing was
   * sent because sending would have typed into an open prompt dialog. Callers
   * that surface errors verbatim already read correctly — the timer manager
   * persists `[prompt_waiting] <message>` as the timer's reason — and the send
   * route maps it to its own status code.
   */
  /**
   * `foreign_session` (Issue #2865) is also a refusal: the tmux session under
   * this worktree's name was created in another directory (another CommandMate
   * server's session), or this worktree has no row to vouch for it. Nothing was
   * sent and no poller was started.
   */
  /**
   * `code` (Issue #3006) carries a failure's stable code when it has one. Today
   * that is only `SESSION_STARTING`: the agent's session was just launched and
   * its input prompt has not appeared yet, which the send route answers with the
   * same 503 a slow claude start gets. Absent for every other failure.
   */
  | {
      ok: false;
      stage: 'model' | 'send' | 'prompt_waiting' | 'foreign_session';
      error: string;
      code?: typeof SESSION_STARTING_CODE;
    };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long a copilot body waits, after its `/model` switch, for the response
 * poller still watching the previous turn to record that turn (Issue #2630).
 *
 * Two of the poller's ticks (`POLLING_INTERVAL`, 2 s) and a second of margin.
 * The switch ends with `invalidateCache`, so the first tick that starts after
 * it reads a fresh, idle frame; the second tick covers one that was already
 * in flight with an older capture. Past this bound the body is sent anyway:
 * a live poller that did not stop has declined to record the frame (an empty
 * or duplicate reply), and waiting longer would not change its answer.
 */
export const PREVIOUS_TURN_RECORD_TIMEOUT_MS = 5_000;

/** How often {@link waitForPreviousTurnRecorded} re-reads the poller registry. */
const PREVIOUS_TURN_RECORD_CHECK_MS = 100;

/**
 * Wait until no response poller is watching this instance (Issue #2630).
 *
 * copilot's replies are recorded by the response poller alone:
 * `savePendingAssistantResponse` returns early for every alternate-screen tool
 * (Issue #1292). The poller records a turn only from a frame in which that turn
 * is the newest one, and a copilot chain stops itself once it has recorded one
 * — so a chain that is still registered once copilot has gone idle is one that
 * has not recorded the turn yet.
 *
 * @param worktreeId - Target worktree
 * @param resolvedInstanceId - The instance, already resolved to its id
 * @returns false when the chain was still registered at the deadline
 */
async function waitForPreviousTurnRecorded(
  worktreeId: string,
  resolvedInstanceId: string
): Promise<boolean> {
  // The key `getPollerKey` (lib/polling/response-poller-core) builds.
  const pollerKey = `${worktreeId}:${resolvedInstanceId}`;
  const deadline = Date.now() + PREVIOUS_TURN_RECORD_TIMEOUT_MS;
  while (getActivePollers().includes(pollerKey)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PREVIOUS_TURN_RECORD_CHECK_MS));
  }
  return true;
}

/**
 * Whether the composer still shows the message after a send whose submit was
 * never confirmed (Issue #3759) — evidence that it is typed but unsent.
 *
 * Only for the composers `extractComposerText` has measured; any other tool,
 * and any read that fails, answers false and the state stays
 * `submit-unconfirmed`. Either way the state is `indeterminate`: a message in
 * the composer is not one to type again.
 */
async function composerStillHolds(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  content: string
): Promise<boolean> {
  if (!SUPPORTED_COMPOSER_TOOLS.has(cliToolId)) return false;
  try {
    const output = await captureSessionOutputFresh(worktreeId, cliToolId, STATUS_CAPTURE_LINES, instanceId);
    const read = extractComposerText(output, cliToolId);
    return read.state === 'content' && composerHoldsMessage(read.text, content);
  } catch (error) {
    logger.warn('send-composer-residue-read-failed', { error: getErrorMessage(error) });
    return false;
  }
}

/**
 * The body the tool will actually type for `content` (Issue #4048): with an
 * image, the image-capable tool's own body (`imageMessageBody`) or the path
 * fallback; otherwise `content` itself. Must match what `sendToTool` sends.
 */
function typedBodyFor(cliTool: ICLITool, content: string, absoluteImagePath: string | undefined): string {
  if (!absoluteImagePath) return content;
  if (isImageCapableCLITool(cliTool)) return cliTool.imageMessageBody?.(content, absoluteImagePath) ?? content;
  return formatImagePathFallbackMessage(content, absoluteImagePath);
}

/**
 * Send a validated user message to the CLI tool and record it in history.
 *
 * On CLI send failure (or copilot /model failure) it returns an `ok: false`
 * result with the failing stage; the caller decides how to surface the error.
 * DB record failures throw (same as before the extraction).
 */
export async function sendUserMessage(
  db: Database.Database,
  params: SendUserMessageParams
): Promise<SendUserMessageResult> {
  const { worktreeId, content, cliToolId, instanceId, absoluteImagePath, copilotModel, respondAgent } = params;
  const messageType: MessageType = params.messageType ?? 'normal';
  /**
   * The instance this send belongs to, resolved the way `createMessage` and
   * `mapChatMessage` resolve it (Issue #868: the primary instance's id *is* the
   * tool's id). Callers omit `instanceId` for the primary instance — the UI and
   * the send API both do — so every scope decision below has to resolve it
   * first or it is not scoped at all.
   */
  const resolvedInstanceId = instanceId ?? cliToolId;

  const cliTool = CLIToolManager.getInstance().getTool(cliToolId);

  // Issue #3759: how this attempt left the message, kept for `lastSend` (and
  // read back by the send route for its error). The result's shape is
  // unchanged; recording never throws.
  //
  // Issue #4048: the record also carries the body actually typed (an image
  // reference appended), which is what the composer and the first-prompt
  // receipt know the attempt by, and the input lock generation the delivery
  // ran under, so the late outcome of a send whose session was replaced does
  // not overwrite the newer generation's record.
  const typedContent = typedBodyFor(cliTool, content, absoluteImagePath);
  let inputGeneration: number | undefined;
  const settle = (state: SendAttemptState, reason: SendAttemptReason): void => {
    recordSendAttempt(
      { worktreeId, cliToolId, instanceId: resolvedInstanceId },
      {
        state,
        reason,
        content,
        ...(typedContent !== content ? { typedContent } : {}),
        ...(inputGeneration !== undefined ? { inputGeneration } : {}),
      }
    );
    params.onAttempt?.({ state, reason });
  };

  // Issue #2865: the send route checks ownership itself, but the timer manager
  // and relay delivery reach tmux only through here. A session under this
  // worktree's name that was created in another directory belongs to another
  // CommandMate server; nothing is typed into it and no poller watches it.
  // Checked before the prompt guard, which would otherwise read that pane.
  const sessionName = resolveSessionName(cliToolId, worktreeId, instanceId);
  const ownership = await checkWorktreeSessionOwnership(worktreeId, sessionName, db);
  if (ownership === null || ownership.verdict === 'foreign') {
    settle('not-sent', 'foreign-session');
    logger.warn('send-refused-foreign-session', {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      sessionName,
      sessionPath: ownership?.sessionPath ?? null,
      reason: ownership ? 'foreign' : 'worktree_not_found',
    });
    return {
      ok: false,
      stage: 'foreign_session',
      error: ownership
        ? `tmux session "${sessionName}" belongs to another CommandMate server`
        : `Worktree '${worktreeId}' not found; cannot confirm tmux session "${sessionName}" is this server's`,
    };
  }

  // Issue #1708: refuse before the first side effect. A prompt dialog does not
  // forward keystrokes to the agent — they accumulate in its own input line — so
  // the message is lost AND the next `respond` has to answer a prompt whose
  // input already holds someone else's text, which is how an answer gets
  // delivered as a message.
  //
  // The guard lives HERE rather than in the send route because this function is
  // the choke point for every path that types a message at an agent: the route
  // and the timer manager (src/lib/timer-manager.ts, which calls it directly and
  // would otherwise fire straight into an open dialog on schedule). The answer
  // paths — `respond`, `special-keys`, `prompt-response` — do not go through
  // here at all, which is what keeps them open; they are the only way out of
  // this state and blocking them would strand the session.
  //
  // Issue #1737: the check consults the structured layer as well, through the
  // same composition the current-output payload publishes. Before that it asked
  // the scraper alone, so a dialog only the agent's hooks could see — the exact
  // gap #1725 closed for the payload — was still sent into.
  const promptGuard = await isPromptWaiting(worktreeId, cliToolId, instanceId, {
    ignoreStructured: params.ignoreStructuredPromptGuard,
  });
  if (promptGuard.waiting) {
    settle('not-sent', 'prompt-waiting');
    logger.info('send-refused-prompt-waiting', {
      worktreeId,
      cliToolId,
      reason: promptGuard.reason,
      blockedBy: promptGuard.blockedBy,
    });
    return {
      ok: false,
      stage: 'prompt_waiting',
      error: promptWaitingMessage(worktreeId, promptGuard.blockedBy, instanceId, respondAgent),
    };
  }

  // 1. Issue #576: Send /model command before message if model is specified (copilot only).
  //
  // Issue #2623: the body below is typed only once this resolves, and it now
  // resolves only on copilot's own answer to `/model` — never merely because
  // the composer is drawn, which it is while copilot is still loading and a
  // body typed then is never run. A refused id (`✗ Model "…" is unsupported.`)
  // or no answer rejects, so the send stops here with `stage: 'model'` and the
  // body is not typed into a model nobody confirmed.
  //
  // Issue #2630: that wait is also why this step now comes FIRST. It waits for
  // copilot to be idle — up to 30 s when the send arrives mid-turn — so the
  // previous turn can end inside it, and everything that used to run before it
  // described the moment the request arrived rather than the moment the body is
  // typed. A failed switch returns before anything below has run, which loses
  // nothing: the only tool that gets here is copilot, whose pending-response
  // save is a no-op (#1292), and the poller watching its previous turn is left
  // running because `startPolling` below is never reached.
  if (copilotModel && cliToolId === 'copilot') {
    try {
      const copilotTool = cliTool as CopilotTool;
      await copilotTool.sendModelCommand(worktreeId, copilotModel, instanceId);
      logger.info('copilot-model-command-sent', { model: copilotModel });
    } catch (error) {
      logger.error('failed-to-send-model-command:', { error: getErrorMessage(error) });
      // Issue #3952: the re-check right before `/model` refused it. Read by
      // code, not wording: the switch's other errors quote the pane's bottom row.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === INPUT_RECHECK_PROMPT_WAITING_CODE) {
        settle('not-sent', 'prompt-waiting');
        return { ok: false, stage: 'prompt_waiting', error: promptWaitingMessage(worktreeId, undefined, instanceId, respondAgent) };
      }
      settle('not-sent', code === INPUT_RECHECK_FAILED_CODE ? 'recheck-failed' : 'model-switch-failed');
      return { ok: false, stage: 'model', error: getErrorMessage(error) };
    }

    // Issue #2630: copilot is idle now, and if the previous turn ended during the
    // switch its reply is still unrecorded: the poller watching it ticks every
    // 2 s, and the body typed next makes the NEXT prompt the newest turn on the
    // pane, after which that poller — and the fresh one `startPolling` starts
    // below — extract only what follows it. Measured on copilot 1.0.85 (UAT
    // TC-2623-06): the turn stopped 5.6 s before `/model` answered, the body
    // followed 0.3 s after the answer, and the reply never reached History.
    // Typing only once that poller has recorded the turn and stopped closes the
    // window; a send to an already idle copilot finds no poller and waits for
    // nothing.
    const recorded = await waitForPreviousTurnRecorded(worktreeId, resolvedInstanceId);
    if (!recorded) {
      logger.warn('previous-turn-poller-still-running', {
        worktreeId,
        instanceId: resolvedInstanceId,
        waitedMs: PREVIOUS_TURN_RECORD_TIMEOUT_MS,
      });
    }
  }

  // Generate the user-message timestamp BEFORE saving the pending response so
  // ordering holds: assistantResponse < userMessage.
  //
  // Issue #2630: and only AFTER step 1. This is the row `wait`'s #1975 gate
  // (src/cli/commands/wait.ts `outstandingPrompt`) compares with the agent's
  // last `stop`: a stamp taken when the request arrived was older than a
  // previous turn that ended during the `/model` wait, so that turn's `stop`
  // read as the end of this one and `wait` completed before the body reached
  // copilot. Read here, it is later than any turn that ended before the body is
  // typed and earlier than the `stop` of the turn the body starts. copilot's
  // body send cannot move a previous turn's end past it either: its composer
  // wait holds only while copilot is still loading (no turn is running) or
  // behind a dialog (refused by the prompt guard above), and returns at once
  // while a turn is running. A send without `--model` skips step 1, so its stamp
  // is read at the same point as before.
  //
  // Issue #3953: this is now the pending row's stamp, and the user row's only
  // when the sender did not report when input started (see step 4). The waits
  // between here and the first key — the input lock, a carried paste mark, the
  // re-read and the clear — can last a minute, and a previous turn that ended
  // inside them is not this send's.
  const pendingResponseTimestamp = new Date();

  // 2. Save any pending assistant response before sending the new user message.
  try {
    await savePendingAssistantResponse(db, worktreeId, cliToolId, pendingResponseTimestamp, instanceId);
  } catch (error) {
    // Log but don't fail - user message should still be saved
    logger.error('failed-to-save-pending-assistant-response:', { error: getErrorMessage(error) });
  }

  // 3. Clean up orphaned user messages (Issue #379: duplicate message prevention).
  // If the most recent message for THIS INSTANCE is a user message with the same
  // content, the assistant never responded and the user is retrying. Remove it
  // (only after the retry message is persisted) to prevent duplicates.
  //
  // Issue #2219: the scope is `resolvedInstanceId`, not the caller's raw
  // `instanceId`. `getMessages` filters on the instance *or* the tool, never
  // both, so passing an omitted `instanceId` through fell back to the tool
  // filter and made this search read the newest row of **every instance of that
  // tool**. A primary-instance re-send whose text matched `claude-2`'s last user
  // row therefore deleted a row belonging to another session — data loss, not a
  // display delay, and invisible because the delete is best-effort and silent.
  //
  // `matchResolvedInstance` is what makes the fix safe rather than merely
  // narrow: a bare `instance_id = ?` would hide every pre-#868 row (they carry
  // NULL and read back as the primary instance), so the orphan they are would
  // survive as a visible duplicate. Same expression as #2196's
  // `findUnkeyedUserMessages`.
  //
  // Issue #2630: read after step 2 as before, and now after step 1 too. A reply
  // the poller recorded during the `/model` wait is the newest row by then, so
  // the user row above it is no longer mistaken for one nobody answered.
  let orphanedMessageIdToDelete: string | null = null;
  try {
    const recentMessages = getMessages(db, worktreeId, {
      limit: 1,
      cliToolId,
      instanceId: resolvedInstanceId,
      matchResolvedInstance: true,
    });
    if (
      recentMessages.length > 0 &&
      recentMessages[0].role === 'user' &&
      recentMessages[0].content === content
    ) {
      orphanedMessageIdToDelete = recentMessages[0].id;
    }
  } catch (error) {
    // Log but don't fail - cleanup candidate discovery is best-effort
    logger.error('failed-to-detect-orphaned-messages:', { error: getErrorMessage(error) });
  }

  // 4. Send message to CLI tool (run below). Returns the failure, or when sent
  // the moment the sender started typing the body (Issue #3953; null for a
  // path that does not report it).
  async function deliver(): Promise<
    | { error: unknown; failure: { state: SendAttemptState; reason: SendAttemptReason } }
    | { sent: true; inputStartedAt: Date | null }
  > {
    try {
      const { inputStartedAt } = await observeInputStart(sendToTool, params.onInputStart, params.inputBoundary);
      return { sent: true, inputStartedAt };
    } catch (error) {
      logger.error('failed-to-send-message-to:', { error: getErrorMessage(error) });
      // Issue #3957: the relay's boundary hook refused before the first key —
      // nothing was typed because the reservation the body was going in under
      // was gone. Issue #3992: its own reason, not `input-lock-lost`.
      if (isInputBoundaryRefusal(error)) {
        return { error, failure: { state: 'not-sent', reason: 'relay-reservation-lost' } };
      }
      // Issue #3759: not-sent only when the error says the body was never typed.
      let failure = classifySendFailure(error);
      if (
        (failure.reason === 'submit-unconfirmed' || failure.reason === 'prompt-unreported') &&
        (await composerStillHolds(worktreeId, cliToolId, instanceId, content))
      ) {
        failure = { state: 'indeterminate', reason: 'composer-residue' };
      }
      return { error, failure };
    }
  }

  async function sendToTool(): Promise<void> {
    // Issue #474: Image-aware sending
    if (absoluteImagePath) {
      if (isImageCapableCLITool(cliTool)) {
        // Image-capable tool: use native image sending
        await cliTool.sendMessageWithImage(worktreeId, content, absoluteImagePath, instanceId);
      } else {
        // Fallback: embed path in message. Issue #2035 moved the wording to
        // `@/lib/cli-tools/opencode` so this branch and opencode's own fallback
        // — reached when a pane has no server to attach through — cannot drift
        // apart; the behaviour of this line is unchanged.
        await cliTool.sendMessage(
          worktreeId,
          formatImagePathFallbackMessage(content, absoluteImagePath),
          instanceId
        );
      }
    } else {
      // Issue #1906: every tool — copilot included — goes through its own
      // `ICLITool.sendMessage`. copilot used to be special-cased here with a raw
      // `sendKeys` + delayed Enter, which skipped `CopilotTool.sendMessage`
      // entirely: no `waitForPrompt` (so a folder-trust dialog was typed into,
      // #1886), no selection-list branch (#1895), and — because nothing read the
      // pane back — no #1471 "the Enter was swallowed" failure, so a typed-but-
      // unsent message was reported as sent. It also flattened `\n+` to spaces,
      // which silently turned a contract preamble or a Markdown body into one
      // line. Measured on copilot 1.0.80 (private tmux socket, `tmux -L`):
      // `send-keys` with literal newlines leaves the body multi-line in the
      // composer (`❯ line one` / `  line two` / `  line three`) and a SEPARATE
      // Enter submits all of it — the transcript echo keeps the line breaks — so
      // the flattening is not needed to make Enter submit and is now gone.
      await cliTool.sendMessage(worktreeId, content, instanceId);
    }
  }

  // Issue #3945: under the input lock for the tools whose composer is read
  // after a failure, so that read is of this send's composer. Not for the
  // others — opencode's HTTP delivery never touches the composer, and holding
  // the lock across it would stall a concurrent tmux send for nothing; their
  // tmux path takes the lock inside the shared sender.
  const delivery = SUPPORTED_COMPOSER_TOOLS.has(cliToolId)
    ? await withInstanceInputLock(sessionName, (ticket) => {
        inputGeneration = ticket.generation;
        return deliver();
      }).catch((error: unknown) => ({
        error,
        failure: classifySendFailure(error),
      }))
    : await deliver();
  if (!('sent' in delivery)) {
    const { error, failure } = delivery;
    settle(failure.state, failure.reason);
    // Issue #3945: a dialog found by the re-check under the lock is the prompt
    // guard's refusal, found late — answered as that refusal (relay holds it).
    if (failure.reason === 'prompt-waiting') {
      return { ok: false, stage: 'prompt_waiting', error: promptWaitingMessage(worktreeId, undefined, instanceId, respondAgent) };
    }
    if (isSessionStartTimeoutError(error)) {
      return { ok: false, stage: 'send', error: error.message, code: SESSION_STARTING_CODE };
    }
    return { ok: false, stage: 'send', error: getErrorMessage(error) };
  }
  settle('sent', 'submitted');

  // Issue #3953: the user row, `updateLastUserMessage` and so `wait`'s #1975
  // gate take the moment the body started going in — later than any turn that
  // ended before it, earlier than the `stop` of the turn it starts (a stamp
  // taken after the send could be later than a turn that ends at once). Never
  // earlier than the pending row's stamp, which stays before it by
  // ASSISTANT_TIMESTAMP_OFFSET_MS. A path that does not report input (opencode's
  // HTTP delivery) keeps the stamp read before step 2, as before.
  const inputStartedAt = delivery.inputStartedAt;
  const userMessageTimestamp =
    inputStartedAt !== null && inputStartedAt.getTime() > pendingResponseTimestamp.getTime()
      ? inputStartedAt
      : pendingResponseTimestamp;

  // 5. Create user message in database (History source: chat_messages).
  const message = createMessage(db, {
    worktreeId,
    role: 'user',
    content,
    messageType,
    timestamp: userMessageTimestamp,
    cliToolId,
    instanceId,
    requestId: params.requestId,
  });

  // 5b. Broadcast the user row (Issue #2195).
  //
  // Every other history writer already does this; this one did not, so a second
  // device (or a second pane on the same device) saw a message it did not send
  // only on its next poll — and #2195 stretches that poll to 15s while a socket
  // is up, which would have made the omission three times as visible.
  //
  // `createMessage` hands back the caller's own object rather than re-reading
  // the row, so `instanceId` here would be `undefined` whenever the caller
  // omitted it. It is resolved to the primary instance (=== cliToolId) exactly
  // as `createMessage` resolves it for the column, so the client's
  // (worktreeId, cliToolId, instanceId) match cannot miss.
  //
  // Wrapped because the message is already sent and already persisted by this
  // point: a socket write that throws must not turn a successful send into a
  // failure the caller reports to the user.
  try {
    broadcastMessage('message', {
      worktreeId,
      message: { ...message, cliToolId, instanceId: resolvedInstanceId },
    });
  } catch (error) {
    logger.warn('user-message-broadcast-failed', { error: getErrorMessage(error) });
  }

  // 6. Remove the prior orphan only after the retry message is persisted.
  // This avoids data loss if send/create fails partway through.
  if (orphanedMessageIdToDelete) {
    try {
      const deleted = deleteMessageById(db, orphanedMessageIdToDelete);
      if (deleted) {
        logger.info('cleaned-up-orphaned-user');
        // 6b. Issue #2219: publish the delete.
        //
        // The `message` frame above told every pane about the row that was
        // added; nothing told them about the row that went away, because the
        // event contract has no shape for a deletion — `message_updated` can
        // only say what a row now looks like. A second device therefore kept
        // showing the old copy next to the new one until its own poll, which
        // #2195 demoted to a 15s fallback while a socket is up.
        //
        // A scope rather than an id: the receiver re-reads its history, so it
        // lands on the settled DB state and a `message` frame that was dropped
        // on the way is repaired by the same round trip. See
        // MESSAGES_INVALIDATED_EVENT_TYPE.
        //
        // Wrapped separately from the delete: the row is already gone by now,
        // and #379's cleanup has always been best-effort — a socket write that
        // throws must not turn a completed send into a reported failure.
        try {
          broadcastMessage(MESSAGES_INVALIDATED_EVENT_TYPE, {
            worktreeId,
            cliToolId,
            instanceId: resolvedInstanceId,
            reason: 'orphan_cleanup',
          });
        } catch (error) {
          logger.warn('orphan-cleanup-broadcast-failed', { error: getErrorMessage(error) });
        }
      }
    } catch (error) {
      // Log but don't fail - cleanup is best-effort
      logger.error('failed-to-clean-up-orphaned-message:', { error: getErrorMessage(error) });
    }
  }

  // 7. Update last user message for worktree.
  updateLastUserMessage(db, worktreeId, content, userMessageTimestamp);

  // 8. Clear in-progress message ID (session state managed by savePendingAssistantResponse).
  clearInProgressMessageId(db, worktreeId, cliToolId, instanceId);
  logger.info('cleared-in-progress-message');

  // 9. Start polling for the CLI tool's response.
  startPolling(worktreeId, cliToolId, instanceId);

  return { ok: true, message };
}
