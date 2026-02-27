/**
 * API Route: /api/worktrees/:id
 * GET: Returns a specific worktree by ID
 * PATCH: Updates worktree properties (e.g., description, link, favorite, status)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, updateWorktreeDescription, updateWorktreeLink, updateFavorite, updateStatus, updateCliToolId, updateSelectedAgents, updateVibeLocalModel, updateVibeLocalContextWindow, getMessages, markPendingPromptsAsAnswered, getInitialBranch } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, OLLAMA_MODEL_PATTERN, isValidVibeLocalContextWindow, type CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/cli-session';
import { detectSessionStatus } from '@/lib/status-detector';
import { getGitStatus } from '@/lib/git-utils';
import type { GitStatus } from '@/types/models';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';
import { validateSelectedAgentsInput } from '@/lib/selected-agents-validator';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // R4-002: Validate worktree ID format
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Check session status for all CLI tools (consistent with /api/worktrees)
    // R1-003: Use CLI_TOOL_IDS instead of hardcoded array
    const manager = CLIToolManager.getInstance();
    const allCliTools: readonly CLIToolType[] = CLI_TOOL_IDS;

    const sessionStatusByCli: Partial<Record<CLIToolType, { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean }>> = {};

    let anyRunning = false;
    let anyWaiting = false;
    let anyProcessing = false;

    for (const cliToolId of allCliTools) {
      const cliTool = manager.getTool(cliToolId);
      const isRunning = await cliTool.isRunning(params.id);

      // Check status based on terminal state
      // - isWaitingForResponse: Interactive prompt (yes/no, multiple choice)
      // - isProcessing: Thinking indicator visible
      let isWaitingForResponse = false;
      let isProcessing = false;
      if (isRunning) {
        try {
          const output = await captureSessionOutput(params.id, cliToolId, 100);
          const statusResult = detectSessionStatus(output, cliToolId);
          isWaitingForResponse = statusResult.status === 'waiting';
          isProcessing = statusResult.status === 'running';

          // Clean up stale pending prompts if no prompt is showing
          // NOTE: !statusResult.hasActivePrompt is logically equivalent to
          //       !promptDetection.isPrompt in the previous implementation (C-004)
          if (!statusResult.hasActivePrompt) {
            const messages = getMessages(db, params.id, undefined, 10, cliToolId);
            const hasPendingPrompt = messages.some(
              msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
            );
            if (hasPendingPrompt) {
              markPendingPromptsAsAnswered(db, params.id, cliToolId);
            }
          }
        } catch {
          // If capture fails, assume processing
          isProcessing = true;
        }
      }

      sessionStatusByCli[cliToolId] = {
        isRunning,
        isWaitingForResponse,
        isProcessing,
      };

      if (isRunning) anyRunning = true;
      if (isWaitingForResponse) anyWaiting = true;
      if (isProcessing) anyProcessing = true;
    }

    // Issue #111: Get git status for branch visualization
    let gitStatus: GitStatus | undefined;
    try {
      const initialBranch = getInitialBranch(db, params.id);
      gitStatus = await getGitStatus(worktree.path, initialBranch);
    } catch (gitError) {
      // Log but don't fail - git status is non-critical
      console.error(`[GET /api/worktrees/:id] Failed to get git status:`, gitError);
    }

    // Issue #368: selectedAgents is already included in worktree from getWorktreeById
    return NextResponse.json(
      {
        ...worktree,
        gitStatus,
        isSessionRunning: anyRunning,
        isWaitingForResponse: anyWaiting,
        isProcessing: anyProcessing,
        sessionStatusByCli,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error fetching worktree:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worktree' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // R4-002: Validate worktree ID format
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

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
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    // Track if cli_tool_id was auto-updated due to selectedAgents change
    let cliToolIdAutoUpdated = false;
    let nextCliToolId: CLIToolType = worktree.cliToolId || 'claude';

    // Update description if provided
    if ('description' in body) {
      updateWorktreeDescription(db, params.id, body.description);
    }

    // Update link if provided
    if ('link' in body) {
      updateWorktreeLink(db, params.id, body.link);
    }

    // Update favorite if provided
    if ('favorite' in body && typeof body.favorite === 'boolean') {
      updateFavorite(db, params.id, body.favorite);
    }

    // Update status if provided
    if ('status' in body) {
      const validStatuses = ['todo', 'doing', 'done', null];
      if (validStatuses.includes(body.status)) {
        updateStatus(db, params.id, body.status);
      }
    }

    // Update CLI tool ID if provided
    // R2-001: Use CLI_TOOL_IDS for validation (includes vibe-local)
    // Note: This is a UI cliToolId validation, distinct from ALLOWED_CLI_TOOLS
    // which is the security whitelist for schedule/auto-yes execution.
    if ('cliToolId' in body) {
      const validCliTools: readonly CLIToolType[] = CLI_TOOL_IDS;
      if (!validCliTools.includes(body.cliToolId)) {
        return NextResponse.json(
          { error: `Invalid cliToolId. Valid values are: ${validCliTools.join(', ')}` },
          { status: 400 }
        );
      }
      updateCliToolId(db, params.id, body.cliToolId);
      nextCliToolId = body.cliToolId;
    }

    // Update selected agents if provided (Issue #368)
    if ('selectedAgents' in body) {
      const validation = validateSelectedAgentsInput(body.selectedAgents);
      if (!validation.valid) {
        return NextResponse.json(
          { error: validation.error, code: 'INVALID_SELECTED_AGENTS' },
          { status: 400 }
        );
      }

      const validatedAgents = validation.value as [CLIToolType, CLIToolType];
      updateSelectedAgents(db, params.id, validatedAgents);

      // R1-007: cli_tool_id consistency check
      // If current cli_tool_id is not in new selectedAgents, auto-update to selectedAgents[0]
      if (!validatedAgents.includes(nextCliToolId)) {
        const newCliToolId = validatedAgents[0];
        console.info(
          `[PATCH /api/worktrees/:id] Auto-updating cli_tool_id from '${nextCliToolId}' to '${newCliToolId}' ` +
          `because '${nextCliToolId}' is not in new selectedAgents [${validatedAgents.join(', ')}]`
        );
        updateCliToolId(db, params.id, newCliToolId);
        nextCliToolId = newCliToolId;
        cliToolIdAutoUpdated = true;
      }
    }

    // Update vibe-local model if provided (Issue #368)
    if ('vibeLocalModel' in body) {
      const model = body.vibeLocalModel;
      // Allow null (reset to default) or valid model name string
      if (model !== null) {
        if (typeof model !== 'string' || model.length === 0 || model.length > 100) {
          return NextResponse.json(
            { error: 'vibeLocalModel must be null or a string (1-100 characters)' },
            { status: 400 }
          );
        }
        if (!OLLAMA_MODEL_PATTERN.test(model)) {
          return NextResponse.json(
            { error: 'vibeLocalModel contains invalid characters' },
            { status: 400 }
          );
        }
      }
      updateVibeLocalModel(db, params.id, model);
    }

    // Update vibe-local context window if provided (Issue #374)
    // [S4-002] isValidVibeLocalContextWindow() includes typeof === 'number' check,
    // which protects against prototype pollution payloads (Object/Function types).
    if ('vibeLocalContextWindow' in body) {
      const ctxWindow = body.vibeLocalContextWindow;
      if (ctxWindow !== null && !isValidVibeLocalContextWindow(ctxWindow)) {
        return NextResponse.json(
          { error: 'vibeLocalContextWindow must be null or an integer (128-2097152)' },
          { status: 400 }
        );
      }
      updateVibeLocalContextWindow(db, params.id, ctxWindow);
    }

    // Return updated worktree with session status
    const updatedWorktree = getWorktreeById(db, params.id);
    const manager = CLIToolManager.getInstance();
    const cliToolId = updatedWorktree?.cliToolId || 'claude';
    const cliTool = manager.getTool(cliToolId);
    const isRunning = await cliTool.isRunning(params.id);
    return NextResponse.json(
      {
        ...updatedWorktree,
        isSessionRunning: isRunning,
        ...(cliToolIdAutoUpdated ? { cliToolIdAutoUpdated: true } : {}),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error updating worktree:', error);
    return NextResponse.json(
      { error: 'Failed to update worktree' },
      { status: 500 }
    );
  }
}
