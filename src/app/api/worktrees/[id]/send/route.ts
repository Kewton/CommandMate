/**
 * API Route: POST /api/worktrees/:id/send
 * Sends a user message to a CLI tool (Claude/Codex/Gemini) for a specific worktree
 *
 * Flow:
 * 1. Validate worktree exists
 * 2. Validate request body (content required)
 * 3. Validate CLI tool (defaults to claude)
 * 4. Ensure CLI tool session is running
 * 5. Save pending assistant response (Issue #53)
 * 6. Send message to CLI tool
 * 7. Create user message in database
 * 8. Start polling for response
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, createMessage, updateLastUserMessage, clearInProgressMessageId, saveInitialBranch, getInitialBranch, getMessages, deleteMessageById } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, isImageCapableCLITool, type CLIToolType } from '@/lib/cli-tools/types';
import { startPolling } from '@/lib/polling/response-poller';
import { savePendingAssistantResponse } from '@/lib/assistant-response-saver';
import { getGitStatus } from '@/lib/git/git-utils';
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/security/path-validator';
import path from 'path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/send');

/** Supported CLI tool IDs - derived from CLI_TOOL_IDS (Issue #368: DRY) */
const VALID_CLI_TOOL_IDS: readonly CLIToolType[] = CLI_TOOL_IDS;

/** Default CLI tool when not specified */
const DEFAULT_CLI_TOOL: CLIToolType = 'claude';

interface SendMessageRequest {
  content: string;
  cliToolId?: CLIToolType;  // Optional: override the worktree's default CLI tool
  imagePath?: string;  // Issue #474: relative path within .commandmate/attachments/
}

/** [S4-M2] URL schemes that are not allowed in imagePath (SSRF prevention) */
const DANGEROUS_SCHEMES = ['file://', 'http://', 'https://', 'ftp://', 'data:'];

/** [S4-M1] Control character regex for CLI injection prevention */
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

/**
 * Helper function to create a JSON error response
 * Issue #474: Centralized error response for imagePath validation
 */
function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: message, code }, { status });
}

/**
 * Extract error message from unknown error type
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Validate and resolve imagePath to an absolute path
 * Issue #474: Extracted from POST handler for SRP and readability
 *
 * Security validations:
 * - [S4-M2] URL scheme rejection (SSRF prevention)
 * - [S2-M2] Path traversal defense
 * - [S2-M1] Symlink traversal defense
 * - [S4-S4] Whitelist: must be within .commandmate/attachments/
 * - [S4-M1] Control character check for CLI injection prevention
 *
 * @param imagePath - Relative image path from request body
 * @param worktreePath - Absolute path of the worktree
 * @returns Resolved absolute path on success, or NextResponse error
 */
function validateImagePath(
  imagePath: string,
  worktreePath: string
): string | NextResponse {
  // [S4-M2] URL scheme rejection (SSRF prevention)
  if (DANGEROUS_SCHEMES.some(scheme => imagePath.startsWith(scheme))) {
    return errorResponse('INVALID_PATH', 'URL schemes are not allowed in imagePath', 400);
  }

  // [S2-M2] Path traversal defense
  if (!isPathSafe(imagePath, worktreePath)) {
    return errorResponse('INVALID_PATH', 'Invalid image path', 400);
  }

  // [S2-M1] Symlink traversal defense
  if (!resolveAndValidateRealPath(imagePath, worktreePath)) {
    return errorResponse('INVALID_PATH', 'Invalid image path (symlink)', 400);
  }

  // [S4-S4] Whitelist: must be within .commandmate/attachments/
  const ALLOWED_IMAGE_DIR = path.join(worktreePath, '.commandmate', 'attachments');
  const resolvedPath = path.resolve(worktreePath, imagePath);
  if (!resolvedPath.startsWith(ALLOWED_IMAGE_DIR + path.sep) && resolvedPath !== ALLOWED_IMAGE_DIR) {
    return errorResponse('INVALID_PATH', 'imagePath must be within .commandmate/attachments/', 400);
  }

  // [S4-M1] Control character check for CLI injection prevention
  if (CONTROL_CHAR_REGEX.test(resolvedPath)) {
    return errorResponse('INVALID_PATH', 'Path contains control characters', 400);
  }

  return resolvedPath;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Parse request body
    const body: SendMessageRequest = await request.json();
    const trimmedContent = typeof body.content === 'string' ? body.content.trim() : '';

    // Validate content
    if (trimmedContent === '') {
      return NextResponse.json(
        { error: 'Message content is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    // Determine which CLI tool to use (priority: request > worktree setting > default)
    const cliToolId = body.cliToolId || worktree.cliToolId || DEFAULT_CLI_TOOL;

    // Validate CLI tool ID
    if (!VALID_CLI_TOOL_IDS.includes(cliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID: ${cliToolId}. Must be one of: ${VALID_CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Check if CLI tool is installed
    const toolAvailable = await cliTool.isInstalled();
    if (!toolAvailable) {
      return NextResponse.json(
        { error: `${cliTool.name} is not installed. Please install it first.` },
        { status: 503 }
      );
    }

    // Check if CLI tool session is running
    const running = await cliTool.isRunning(params.id);

    // Start CLI tool session if not running
    if (!running) {
      try {
        await cliTool.startSession(params.id, worktree.path);

        // Issue #111: Save initial branch at session start
        // Get current branch and save it if not already recorded
        const existingInitialBranch = getInitialBranch(db, params.id);
        if (existingInitialBranch === null) {
          try {
            const gitStatus = await getGitStatus(worktree.path, null);
            if (gitStatus.currentBranch !== '(unknown)' && gitStatus.currentBranch !== '(detached HEAD)') {
              saveInitialBranch(db, params.id, gitStatus.currentBranch);
              logger.info('saved-initial-branch-for:');
            }
          } catch (gitError) {
            // Log but don't fail - git status is non-critical
            logger.error('failed-to-getsave-initial-branch:', { error: gitError instanceof Error ? gitError.message : String(gitError) });
          }
        }
      } catch (error: unknown) {
        logger.error('failed-to-start-session:', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          { error: `Failed to start ${cliTool.name} session: ${getErrorMessage(error)}` },
          { status: 500 }
        );
      }
    }

    // Generate timestamp for user message BEFORE saving pending response
    // This ensures timestamp ordering: assistantResponse < userMessage
    const userMessageTimestamp = new Date();

    // Save any pending assistant response before sending the new user message
    // This captures the CLI tool's response to the previous user message
    try {
      await savePendingAssistantResponse(db, params.id, cliToolId, userMessageTimestamp);
    } catch (error) {
      // Log but don't fail - user message should still be saved
      logger.error('failed-to-save-pending-assistant-response:', { error: error instanceof Error ? error.message : String(error) });
    }

    // Clean up orphaned user messages (Issue #379: duplicate message prevention)
    // If the most recent message for this cliToolId is a user message with the
    // same content, it means the assistant never responded and the user is retrying.
    // Remove it to prevent duplicates.
    let orphanedMessageIdToDelete: string | null = null;
    try {
      const recentMessages = getMessages(db, params.id, undefined, 1, cliToolId);
      if (
        recentMessages.length > 0 &&
        recentMessages[0].role === 'user' &&
        recentMessages[0].content === trimmedContent
      ) {
        orphanedMessageIdToDelete = recentMessages[0].id;
      }
    } catch (error) {
      // Log but don't fail - cleanup candidate discovery is best-effort
      logger.error('failed-to-detect-orphaned-messages:', { error: error instanceof Error ? error.message : String(error) });
    }

    // Issue #474: Validate imagePath if provided
    let absoluteImagePath: string | undefined;
    if (body.imagePath) {
      const validationResult = validateImagePath(body.imagePath, worktree.path);
      if (validationResult instanceof NextResponse) {
        return validationResult;
      }
      absoluteImagePath = validationResult;
    }

    // Send message to CLI tool
    try {
      // Issue #474: Image-aware sending
      if (absoluteImagePath) {
        if (isImageCapableCLITool(cliTool)) {
          // Image-capable tool: use native image sending
          await cliTool.sendMessageWithImage(params.id, trimmedContent, absoluteImagePath);
        } else {
          // Fallback: embed path in message
          const messageWithPath = trimmedContent
            ? `${trimmedContent}\n\n[添付画像: ${absoluteImagePath}]`
            : `[添付画像: ${absoluteImagePath}]`;
          await cliTool.sendMessage(params.id, messageWithPath);
        }
      } else {
        await cliTool.sendMessage(params.id, trimmedContent);
      }
    } catch (error: unknown) {
      logger.error('failed-to-send-message-to:', { error: error instanceof Error ? error.message : String(error) });
      return NextResponse.json(
        { error: `Failed to send message to ${cliTool.name}: ${getErrorMessage(error)}` },
        { status: 500 }
      );
    }

    // Create user message in database with CLI tool ID
    // Use the pre-generated timestamp for consistency
    // [DRY] Use trimmedContent consistently (same value sent to CLI and used for orphan detection)
    const message = createMessage(db, {
      worktreeId: params.id,
      role: 'user',
      content: trimmedContent,
      messageType: 'normal',
      timestamp: userMessageTimestamp,
      cliToolId,
    });

    // Remove the prior orphan only after the retry message is persisted.
    // This avoids data loss if send/create fails partway through the request.
    if (orphanedMessageIdToDelete) {
      try {
        const deleted = deleteMessageById(db, orphanedMessageIdToDelete);
        if (deleted) {
          logger.info('cleaned-up-orphaned-user');
        }
      } catch (error) {
        // Log but don't fail - cleanup is best-effort
        logger.error('failed-to-clean-up-orphaned-message:', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Update last user message for worktree
    updateLastUserMessage(db, params.id, trimmedContent, userMessageTimestamp);

    // Clear in-progress message ID (session state is managed by savePendingAssistantResponse)
    clearInProgressMessageId(db, params.id, cliToolId);
    logger.info('cleared-in-progress-message-for');

    // Start polling for CLI tool's response
    startPolling(params.id, cliToolId);

    return NextResponse.json(message, { status: 201 });
  } catch (error: unknown) {
    logger.error('error-sending-message:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
