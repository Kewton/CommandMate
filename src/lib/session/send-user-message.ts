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
 *   4. send to CLI tool              — image / copilot / normal branches
 *   5. createMessage (role: 'user')  — INSERT INTO chat_messages (History source)
 *   6. orphan deletion               — remove prior duplicate after persist
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
import { sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import { createLogger } from '@/lib/logger';
import { isPromptWaiting, promptWaitingMessage } from '@/lib/session/prompt-waiting-guard';
import { COPILOT_SEND_ENTER_DELAY_MS } from '@/config/copilot-constants';
import type { CopilotTool } from '@/lib/cli-tools/copilot';
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
  // If the most recent message for this cliToolId is a user message with the same
  // content, the assistant never responded and the user is retrying. Remove it
  // (only after the retry message is persisted) to prevent duplicates.
  let orphanedMessageIdToDelete: string | null = null;
  try {
    const recentMessages = getMessages(db, worktreeId, { limit: 1, cliToolId, instanceId });
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
        // Fallback: embed path in message
        const messageWithPath = content
          ? `${content}\n\n[添付画像: ${absoluteImagePath}]`
          : `[添付画像: ${absoluteImagePath}]`;
        await cliTool.sendMessage(worktreeId, messageWithPath, instanceId);
      }
    } else if (cliToolId === 'copilot') {
      // Copilot: use sendKeys directly to avoid waitForPrompt blocking (#559).
      // Copilot CLI auto-enters multi-line mode when text exceeds pane width.
      // In multi-line mode, C-m (bundled with text) adds a newline instead of
      // submitting. Sending Enter as a separate tmux command after a delay
      // allows the TUI to process the text first, then accept Enter as submit.
      const sessionName = cliTool.getSessionName(worktreeId, instanceId);
      // Replace newlines with spaces to prevent Copilot CLI multi-line mode
      const copilotContent = content.replace(/\n+/g, ' ').trim();
      await sendKeys(sessionName, copilotContent, false);
      await new Promise(resolve => setTimeout(resolve, COPILOT_SEND_ENTER_DELAY_MS));
      await sendSpecialKeys(sessionName, ['Enter']);
      invalidateCache(sessionName);
    } else {
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

  // 6. Remove the prior orphan only after the retry message is persisted.
  // This avoids data loss if send/create fails partway through.
  if (orphanedMessageIdToDelete) {
    try {
      const deleted = deleteMessageById(db, orphanedMessageIdToDelete);
      if (deleted) {
        logger.info('cleaned-up-orphaned-user');
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
