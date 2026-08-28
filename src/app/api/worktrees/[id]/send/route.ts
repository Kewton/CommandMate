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
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, saveInitialBranch, getInitialBranch } from '@/lib/db';
import { resolveInstanceCliTool } from '@/lib/db/agent-instances-db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { sendUserMessage } from '@/lib/session/send-user-message';
import { PROMPT_WAITING_CODE } from '@/lib/session/prompt-waiting-guard';
import {
  isSessionStartTimeoutError,
  isSessionStartUnavailableError,
  SESSION_STARTING_CODE,
  SESSION_START_UNAVAILABLE_CODE,
} from '@/lib/session/session-start-error';
import { getGitStatus } from '@/lib/git/git-utils';
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/security/path-validator';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { validateCopilotModelName, validateAntigravityModelName } from '@/lib/cmate-cli-tool-parser';
import { broadcastSessionStatus } from '@/lib/realtime/terminal-broadcast';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/send');

/** Supported CLI tool IDs - derived from CLI_TOOL_IDS (Issue #368: DRY) */
const VALID_CLI_TOOL_IDS: readonly CLIToolType[] = CLI_TOOL_IDS;

/** Default CLI tool when not specified */
const DEFAULT_CLI_TOOL: CLIToolType = 'claude';

interface SendMessageRequest {
  content: string;
  cliToolId?: CLIToolType;  // Optional: override the worktree's default CLI tool
  instanceId?: string;  // Issue #868: agent instance ID (defaults to primary === cliToolId)
  imagePath?: string;  // Issue #474: relative path within .commandmate/attachments/
  model?: string;  // Issue #576/#989: AI model name for Copilot or Antigravity agent
  /**
   * Issue #1737: send even if only the agent's structured events report an open
   * dialog. The escape hatch for a hook-reported dialog nothing ever released —
   * a prompt the terminal scraper can see is still refused, because that one is
   * on screen and answerable.
   */
  ignoreStructuredPromptGuard?: boolean;
}

// Issue #588: MODEL_NAME_PATTERN and MAX_MODEL_NAME_LENGTH are now centralized
// in copilot-constants.ts and validated via validateCopilotModelName() from
// cmate-cli-tool-parser.ts (DR1-003).

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
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
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

    // Validate the requested CLI tool ID (DR4-002: fixed error text, no raw
    // input reflection) before it is used to resolve the instance.
    const requestedCliToolId = body.cliToolId || undefined;
    if (requestedCliToolId && !VALID_CLI_TOOL_IDS.includes(requestedCliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID. Must be one of: ${VALID_CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Issue #868: Resolve the agent instance. When omitted, the primary instance
    // (instanceId === cliToolId) is used, preserving legacy single-session behavior.
    // The instance ID is embedded in tmux session names, so it must match the safe
    // identifier pattern to prevent command injection.
    if (body.instanceId !== undefined && !isValidInstanceId(body.instanceId)) {
      return NextResponse.json(
        { error: 'Invalid instanceId. Must be an alphanumeric/underscore/hyphen identifier.' },
        { status: 400 }
      );
    }
    const instanceId = body.instanceId;

    // Issue #1629: the roster is what declares which CLI tool backs an instance.
    // Without this the tool came from the worktree default, so `--instance codex`
    // started Claude in a session named `mcbd-claude-<worktree>-codex`.
    const resolution = resolveInstanceCliTool(db, id, instanceId, requestedCliToolId);
    if (!resolution.ok) {
      return NextResponse.json(
        {
          error: `Agent instance '${resolution.instanceId}' is registered as ${resolution.rosterCliTool}, `
            + `but ${resolution.requestedCliTool} was requested. `
            + `Omit the agent, pass ${resolution.rosterCliTool}, or update the instance's roster entry.`,
        },
        { status: 400 }
      );
    }

    // Determine which CLI tool to use
    // (priority: request/roster > worktree setting > default)
    const cliToolId = resolution.cliToolId || worktree.cliToolId || DEFAULT_CLI_TOOL;

    // Validate CLI tool ID (DR4-002: fixed error text, no raw input reflection)
    if (!VALID_CLI_TOOL_IDS.includes(cliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID. Must be one of: ${VALID_CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Issue #576/#588/#989: Validate model parameter via shared validator (DR1-003)
    //
    // Issue #2048 kept opencode OUT of this list on purpose, having measured
    // what including it would have to mean. opencode's model is a *launch* flag
    // (`-m provider/model`) and its variant is not a launch flag at all, so
    // `--model` on a send could only be honoured by restarting the pane or by
    // driving the TUI's own model picker — and that picker rewrites the
    // operator's **global default model**, the same trap `/model` is for Claude
    // (#1495). A per-instance setting is the channel instead
    // (`PUT /api/worktrees/:id/instances/opencode`), which is durable, visible,
    // and applies without touching anybody's defaults. Switching a *running*
    // opencode session is Issue #2046's question.
    if (body.model) {
      // model is only supported for copilot and antigravity
      if (cliToolId !== 'copilot' && cliToolId !== 'antigravity') {
        return NextResponse.json(
          { error: 'The model parameter is only supported for copilot and antigravity agents' },
          { status: 400 }
        );
      }
      const modelValidation = cliToolId === 'antigravity'
        ? validateAntigravityModelName(body.model)
        : validateCopilotModelName(body.model);
      if (!modelValidation.valid) {
        return NextResponse.json(
          { error: `Invalid model name: ${modelValidation.reason}` },
          { status: 400 }
        );
      }
    }

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Issue #2009: the install check that used to sit here was a SECOND gate.
    // Every one of the seven tools already refuses to launch when its binary is
    // missing, and this copy ran first — so the tools' own refusals were
    // unreachable from this route, and with them the one seam that reports a
    // failed start to a phone (`BaseCLITool.startSession`). Removing the copy
    // leaves one gate, and it is the one that notifies.
    //
    // The 503 is preserved below by mapping SESSION_START_UNAVAILABLE, and the
    // body is now the tool's own wording — which for copilot carries its install
    // hint (#1907) that this route's fixed sentence used to discard.
    //
    // One behaviour deliberately changes: a tool whose binary is not on the
    // server's PATH but whose tmux session is already RUNNING is no longer
    // refused. `isRunning` is positive evidence that the agent is alive, and
    // `which` failing (a server started from a shell without the nvm PATH, say)
    // says nothing about whether it can be typed into.

    // Check if CLI tool session is running
    const running = await cliTool.isRunning(id, instanceId);

    // Issue #989: Antigravity has no in-session model-switch command (unlike
    // Copilot's /model), so --model can only be honored when starting a new
    // session. Reject rather than silently ignoring the requested model.
    if (body.model && cliToolId === 'antigravity' && running) {
      return NextResponse.json(
        { error: 'Antigravity model can only be set when starting a new session. Stop the current Antigravity session and resend with --model to switch models.' },
        { status: 400 }
      );
    }

    // Start CLI tool session if not running
    if (!running) {
      try {
        if (cliToolId === 'antigravity' && body.model) {
          const antigravityTool = cliTool as AntigravityTool;
          await antigravityTool.startSession(id, worktree.path, instanceId, body.model);
        } else {
          await cliTool.startSession(id, worktree.path, instanceId);
        }

        // Issue #111: Save initial branch at session start
        // Get current branch and save it if not already recorded
        const existingInitialBranch = getInitialBranch(db, id);
        if (existingInitialBranch === null) {
          try {
            const gitStatus = await getGitStatus(worktree.path, null);
            if (gitStatus.currentBranch !== '(unknown)' && gitStatus.currentBranch !== '(detached HEAD)') {
              saveInitialBranch(db, id, gitStatus.currentBranch);
              logger.info('saved-initial-branch-for:');
            }
          } catch (gitError) {
            // Log but don't fail - git status is non-critical
            logger.error('failed-to-getsave-initial-branch:', { error: gitError instanceof Error ? gitError.message : String(gitError) });
          }
        }
      } catch (error: unknown) {
        logger.error('failed-to-start-session:', { error: error instanceof Error ? error.message : String(error) });
        // Issue #1637: a session that is still initializing is not a server
        // fault. The tmux session and the CLI process exist and are coming up,
        // so the honest answer is "temporarily unavailable, retry" — 503 with a
        // stable code — and the message says exactly that. Returning 500 here
        // is what made four separate orchestration runs misdiagnose a slow cold
        // start as a session-creation race.
        if (isSessionStartTimeoutError(error)) {
          return NextResponse.json(
            { error: error.message, code: SESSION_STARTING_CODE },
            { status: 503 }
          );
        }
        // Issue #2009: the CLI is not installed. Also a 503 — the request was
        // well formed and the server is healthy, the machine is simply missing
        // the binary — and the message is the tool's own, which is authored text
        // (a name plus, for copilot, a fixed install hint), never captured
        // output. `BaseCLITool.startSession` has already reported it.
        if (isSessionStartUnavailableError(error)) {
          return NextResponse.json(
            { error: error.message, code: SESSION_START_UNAVAILABLE_CODE },
            { status: 503 }
          );
        }
        return NextResponse.json(
          { error: `Failed to start ${cliTool.name} session: ${getErrorMessage(error)}` },
          { status: 500 }
        );
      }

      // Issue #1120: push the running transition so sidebar status dots flip
      // immediately instead of waiting for the next /api/worktrees poll.
      broadcastSessionStatus(id, true, { cliTool: cliToolId, instance: instanceId ?? null });
    }

    // Issue #474: Validate imagePath if provided (HTTP-layer validation stays here)
    let absoluteImagePath: string | undefined;
    if (body.imagePath) {
      const validationResult = validateImagePath(body.imagePath, worktree.path);
      if (validationResult instanceof NextResponse) {
        return validationResult;
      }
      absoluteImagePath = validationResult;
    }

    // Issue #1028: Delegate the send + history-recording flow to the shared
    // sendUserMessage service so manual sends and Timer-fired sends (executeTimer)
    // record identically in chat_messages / Message History.
    const result = await sendUserMessage(db, {
      worktreeId: id,
      content: trimmedContent,
      cliToolId,
      instanceId,
      absoluteImagePath,
      // Issue #576: copilot /model switch (antigravity model is applied at
      // session start above, not mid-session).
      copilotModel: cliToolId === 'copilot' ? body.model : undefined,
      // Issue #1737: `commandmate send --ignore-structured-prompt`.
      ignoreStructuredPromptGuard: body.ignoreStructuredPromptGuard === true,
    });

    if (!result.ok) {
      // Issue #1708: the session is sitting on a prompt, so nothing was sent.
      // 409 rather than 500 — the request was well formed and the server is
      // healthy; the session is simply in a state that cannot accept a message.
      // The stable `code` is what the CLI branches on (a bare 409 would be
      // reported as "Unexpected HTTP status: 409", which says nothing).
      if (result.stage === 'prompt_waiting') {
        return NextResponse.json(
          { error: result.error, code: PROMPT_WAITING_CODE },
          { status: 409 }
        );
      }
      if (result.stage === 'model') {
        return NextResponse.json(
          { error: `Failed to switch model to ${body.model}: ${result.error}` },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: `Failed to send message to ${cliTool.name}: ${result.error}` },
        { status: 500 }
      );
    }

    return NextResponse.json(result.message, { status: 201 });
  } catch (error: unknown) {
    logger.error('error-sending-message:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
