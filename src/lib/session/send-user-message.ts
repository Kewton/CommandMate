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
}

/** Result of {@link sendUserMessage}. */
export type SendUserMessageResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; stage: 'model' | 'send'; error: string };

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
