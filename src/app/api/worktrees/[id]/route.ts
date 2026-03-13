/**
 * API Route: /api/worktrees/:id
 * GET: Returns a specific worktree by ID
 * PATCH: Updates worktree properties (e.g., description, link, favorite, status)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, updateWorktreeDescription, updateWorktreeLink, updateFavorite, updateStatus, updateCliToolId, updateSelectedAgents, updateVibeLocalModel, updateVibeLocalContextWindow, getMessages, markPendingPromptsAsAnswered, getInitialBranch } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, OLLAMA_MODEL_PATTERN, isValidVibeLocalContextWindow, VIBE_LOCAL_CONTEXT_WINDOW_MIN, VIBE_LOCAL_CONTEXT_WINDOW_MAX, type CLIToolType } from '@/lib/cli-tools/types';
import { getGitStatus } from '@/lib/git/git-utils';
import type { GitStatus } from '@/types/models';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { validateSelectedAgentsInput } from '@/lib/selected-agents-validator';
import { listSessions } from '@/lib/tmux/tmux';
import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/worktrees');

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

    // Issue #405: Batch query all tmux sessions once (N+1 elimination)
    const tmuxSessions = await listSessions();
    const sessionNameSet = new Set(tmuxSessions.map(s => s.name));

    // Parallel: session status detection + git status (independent operations)
    const initialBranch = getInitialBranch(db, params.id);
    const [sessionStatus, gitStatus] = await Promise.all([
      detectWorktreeSessionStatus(
        params.id,
        sessionNameSet,
        db,
        getMessages,
        markPendingPromptsAsAnswered,
      ),
      getGitStatus(worktree.path, initialBranch).catch((gitError) => {
        // Log but don't fail - git status is non-critical
        logger.error('get-apiworktrees:id-failed-to-get-git-status', { error: gitError instanceof Error ? gitError.message : String(gitError) });
        return undefined as GitStatus | undefined;
      }),
    ]);

    // Issue #368: selectedAgents is already included in worktree from getWorktreeById
    return NextResponse.json(
      {
        ...worktree,
        gitStatus,
        ...sessionStatus,
      },
      { status: 200 }
    );
  } catch (error) {
    logger.error('error-fetching-worktree:', { error: error instanceof Error ? error.message : String(error) });
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

      const validatedAgents = validation.value as CLIToolType[];
      updateSelectedAgents(db, params.id, validatedAgents);

      // R1-007: cli_tool_id consistency check
      // If current cli_tool_id is not in new selectedAgents, auto-update to selectedAgents[0]
      if (!validatedAgents.includes(nextCliToolId)) {
        const newCliToolId = validatedAgents[0];
        logger.info('worktree:auto-update-cli-tool', { from: nextCliToolId, to: newCliToolId, selectedAgents: validatedAgents });
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
          { error: `vibeLocalContextWindow must be null or an integer (${VIBE_LOCAL_CONTEXT_WINDOW_MIN}-${VIBE_LOCAL_CONTEXT_WINDOW_MAX})` },
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
    logger.error('error-updating-worktree:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to update worktree' },
      { status: 500 }
    );
  }
}
