/**
 * API Route: GET /api/worktrees/:id/current-output
 * Gets the current tmux output for a worktree (even if incomplete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, getSessionState } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { detectSessionStatus, STATUS_REASON, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { getAutoYesState, getLastServerResponseTimestamp, isPollerActive, buildCompositeKey } from '@/lib/polling/auto-yes-manager';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/current-output');

/** Issue #368: Derive from CLI_TOOL_IDS (DRY) */
function isCliTool(value: string | null): value is CLIToolType {
  return !!value && (CLI_TOOL_IDS as readonly string[]).includes(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // [SEC-DS4-F006] Validate worktree ID format (Issue #314)
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

    const url = new URL(request.url);
    const cliToolParam = url.searchParams.get('cliTool');
    const cliToolId: CLIToolType = isCliTool(cliToolParam) ? cliToolParam : (worktree.cliToolId || 'claude');

    // Issue #868: optional instance selector. Validate (embedded in session name)
    // and resolve to the primary instance (instanceId === cliToolId) when omitted.
    const instanceParam = url.searchParams.get('instance');
    if (instanceParam !== null && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instance parameter' },
        { status: 400 }
      );
    }
    const instanceId = instanceParam ?? undefined;
    const resolvedInstanceId = instanceId ?? cliToolId;

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Check if CLI session is running
    const running = await cliTool.isRunning(params.id, instanceId);
    if (!running) {
      return NextResponse.json(
        {
          isRunning: false,
          content: '',
          lineCount: 0,
          cliToolId,
          // Issue #520: Session status for CLI wait command completion detection
          sessionStatus: 'idle' as const,
          sessionStatusReason: 'session_not_running',
        },
        { status: 200 }
      );
    }

    // Get session state (Issue #868: per-instance)
    const sessionState = getSessionState(db, params.id, resolvedInstanceId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output (Issue #868: per-instance session)
    const output = await captureSessionOutput(params.id, cliToolId, STATUS_CAPTURE_LINES, instanceId);
    const lines = output.split('\n');
    const totalLines = lines.length;

    // Extract new content since last capture
    const newLines = lines.slice(Math.max(0, lastCapturedLine));
    const newContent = newLines.join('\n');

    // Issue #501, #525, #896: Get last server response timestamp using the
    // per-instance compositeKey (alias instances build a 3-part key).
    const compositeKey = buildCompositeKey(params.id, cliToolId, instanceId);
    const lastServerResponseTimestamp = getLastServerResponseTimestamp(compositeKey);
    const lastOutputTimestamp = lastServerResponseTimestamp ? new Date(lastServerResponseTimestamp) : undefined;

    // DR-001: Unified priority-based status detection via detectSessionStatus().
    // This replaced the inline thinking/prompt logic that had inconsistent priority
    // ordering (Issue #188 root cause: thinking detected on full output instead of
    // 5-line window, causing perpetual spinner when thinking summary was in scrollback).
    const statusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);
    const thinking = statusResult.status === 'running' && statusResult.reason === STATUS_REASON.THINKING_INDICATOR;

    // Issue #408: promptDetection is obtained from detectSessionStatus() return value.
    // Previously, detectPrompt() was called separately here (SF-001 tradeoff).
    // detectSessionStatus() internal priority order (prompt -> thinking) guarantees
    // that promptDetection.isPrompt === false when thinking is detected.
    // This implicitly maintains Issue #161 Layer 1 defense.

    // SF-004: isPromptWaiting uses statusResult.hasActivePrompt (15-line window) as
    // the single source of truth, ensuring consistency between status and prompt state.
    const isPromptWaiting = statusResult.hasActivePrompt;

    // Issue #473: Selection list active flag for TUI navigation (OpenCode + Claude)
    const isSelectionListActive = statusResult.status === 'waiting'
      && SELECTION_LIST_REASONS.has(statusResult.reason);

    // Extract realtime snippet (last 100 lines for better context)
    const realtimeSnippet = lines.slice(-100).join('\n');

    // Get auto-yes state (Issue #525: per-agent, #896: per-instance)
    const autoYesState = getAutoYesState(params.id, cliToolId, instanceId);

    return NextResponse.json({
      isRunning: true,
      cliToolId,
      // Issue #520: Session status for CLI wait command completion detection
      sessionStatus: statusResult.status,
      sessionStatusReason: statusResult.reason,
      content: newContent,
      fullOutput: output,
      realtimeSnippet,
      lineCount: totalLines,
      lastCapturedLine,
      // isComplete only true for prompts now
      isComplete: isPromptWaiting,
      // Show as generating only when thinking (not when input prompt showing)
      isGenerating: thinking,
      thinking,
      thinkingMessage: thinking ? 'Claude is thinking...' : null,
      // Prompt detection results
      isPromptWaiting,
      promptData: isPromptWaiting ? statusResult.promptDetection.promptData ?? null : null,
      // Auto-yes state (Issue #314: stopReason added for stop condition notification)
      autoYes: {
        enabled: autoYesState?.enabled ?? false,
        expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null,
        stopReason: autoYesState?.stopReason,
      },
      // Issue #473: Selection list active flag for OpenCode TUI navigation
      isSelectionListActive,
      // Issue #138: Server-side response timestamp for duplicate prevention
      lastServerResponseTimestamp,
      // Issue #501, #525: Whether server-side auto-yes poller is active (per-agent)
      serverPollerActive: isPollerActive(compositeKey),
    });
  } catch (error: unknown) {
    logger.error('error-getting-current-output:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to get current output' },
      { status: 500 }
    );
  }
}
