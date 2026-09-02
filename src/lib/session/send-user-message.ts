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
 *   1. savePendingAssistantResponse  — persist the previous assistant reply
 *   2. orphan detection              — Issue #379 duplicate-message guard
 *   3. copilot /model command        — Issue #576 (copilot only)
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
import { isImageCapableCLITool, type CLIToolType } from '@/lib/cli-tools/types';
import { startPolling } from '@/lib/polling/response-poller';
import { savePendingAssistantResponse } from '@/lib/assistant-response-saver';
import { broadcastMessage } from '@/lib/ws-server';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';
import { createLogger } from '@/lib/logger';
import { isPromptWaiting, promptWaitingMessage } from '@/lib/session/prompt-waiting-guard';
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
  /** chat_messages message_type. Defaults to 'normal'. */
  messageType?: MessageType;
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
  | { ok: false; stage: 'model' | 'send' | 'prompt_waiting'; error: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const { worktreeId, content, cliToolId, instanceId, absoluteImagePath, copilotModel } = params;
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
    logger.info('send-refused-prompt-waiting', {
      worktreeId,
      cliToolId,
      reason: promptGuard.reason,
      blockedBy: promptGuard.blockedBy,
    });
    return {
      ok: false,
      stage: 'prompt_waiting',
      error: promptWaitingMessage(worktreeId, promptGuard.blockedBy),
    };
  }

  // Generate the user-message timestamp BEFORE saving the pending response so
  // ordering holds: assistantResponse < userMessage.
  const userMessageTimestamp = new Date();

  // 1. Save any pending assistant response before sending the new user message.
  try {
    await savePendingAssistantResponse(db, worktreeId, cliToolId, userMessageTimestamp, instanceId);
  } catch (error) {
    // Log but don't fail - user message should still be saved
    logger.error('failed-to-save-pending-assistant-response:', { error: getErrorMessage(error) });
  }

  // 2. Clean up orphaned user messages (Issue #379: duplicate message prevention).
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

  // 3. Issue #576: Send /model command before message if model is specified (copilot only).
  if (copilotModel && cliToolId === 'copilot') {
    try {
      const copilotTool = cliTool as CopilotTool;
      await copilotTool.sendModelCommand(worktreeId, copilotModel, instanceId);
      logger.info('copilot-model-command-sent', { model: copilotModel });
    } catch (error) {
      logger.error('failed-to-send-model-command:', { error: getErrorMessage(error) });
      return { ok: false, stage: 'model', error: getErrorMessage(error) };
    }
  }

  // 4. Send message to CLI tool.
  try {
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
  } catch (error) {
    logger.error('failed-to-send-message-to:', { error: getErrorMessage(error) });
    return { ok: false, stage: 'send', error: getErrorMessage(error) };
  }

  // 5. Create user message in database (History source: chat_messages).
  const message = createMessage(db, {
    worktreeId,
    role: 'user',
    content,
    messageType,
    timestamp: userMessageTimestamp,
    cliToolId,
    instanceId,
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
  logger.info('cleared-in-progress-message-for');

  // 9. Start polling for the CLI tool's response.
  startPolling(worktreeId, cliToolId, instanceId);

  return { ok: true, message };
}
