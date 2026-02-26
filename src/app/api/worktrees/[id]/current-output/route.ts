/**
 * API Route: GET /api/worktrees/:id/current-output
 * Gets the current tmux output for a worktree (even if incomplete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, getSessionState } from '@/lib/db';
import { detectPrompt } from '@/lib/prompt-detector';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/cli-session';
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/cli-patterns';
import { detectSessionStatus } from '@/lib/status-detector';
import { getAutoYesState, getLastServerResponseTimestamp, isValidWorktreeId } from '@/lib/auto-yes-manager';

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

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Check if CLI session is running
    const running = await cliTool.isRunning(params.id);
    if (!running) {
      return NextResponse.json(
        {
          isRunning: false,
          content: '',
          lineCount: 0,
          cliToolId,
        },
        { status: 200 }
      );
    }

    // Get session state
    const sessionState = getSessionState(db, params.id, cliToolId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureSessionOutput(params.id, cliToolId, 10000);
    const lines = output.split('\n');
    const totalLines = lines.length;

    // Extract new content since last capture
    const newLines = lines.slice(Math.max(0, lastCapturedLine));
    const newContent = newLines.join('\n');

    // Strip ANSI codes before state detection for reliable pattern matching
    const cleanOutput = stripAnsi(output);

    // DR-001: Unified priority-based status detection via detectSessionStatus().
    // This replaced the inline thinking/prompt logic that had inconsistent priority
    // ordering (Issue #188 root cause: thinking detected on full output instead of
    // 5-line window, causing perpetual spinner when thinking summary was in scrollback).
    const statusResult = detectSessionStatus(output, cliToolId);
    const thinking = statusResult.status === 'running' && statusResult.reason === 'thinking_indicator';

    // SF-001: detectPrompt() is called separately to obtain promptData for the API response.
    // detectSessionStatus() already calls detectPrompt() internally for status determination,
    // but does not expose promptData in StatusDetectionResult (SRP: status module should not
    // be coupled to prompt data shape). This second call is intentional and lightweight
    // (regex-based, no I/O). See status-detector.ts module JSDoc for full rationale.
    //
    // Issue #161 Layer 1: Skip prompt detection during active thinking to prevent
    // numbered lists in in-progress output from triggering false multiple_choice detection.
    let promptDetection: { isPrompt: boolean; cleanContent: string; promptData?: unknown } = { isPrompt: false, cleanContent: cleanOutput };
    if (!thinking) {
      const promptOptions = buildDetectPromptOptions(cliToolId);
      promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
    }

    // SF-004: isPromptWaiting uses statusResult.hasActivePrompt (15-line window) as
    // the single source of truth, ensuring consistency between status and prompt state.
    const isPromptWaiting = statusResult.hasActivePrompt;

    // Extract realtime snippet (last 100 lines for better context)
    const realtimeSnippet = lines.slice(-100).join('\n');

    // Get auto-yes state
    const autoYesState = getAutoYesState(params.id);

    // Issue #138: Get last server response timestamp for duplicate prevention
    const lastServerResponseTimestamp = getLastServerResponseTimestamp(params.id);

    return NextResponse.json({
      isRunning: true,
      cliToolId,
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
      promptData: isPromptWaiting ? promptDetection.promptData : null,
      // Auto-yes state (Issue #314: stopReason added for stop condition notification)
      autoYes: {
        enabled: autoYesState?.enabled ?? false,
        expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null,
        stopReason: autoYesState?.stopReason,
      },
      // Issue #138: Server-side response timestamp for duplicate prevention
      lastServerResponseTimestamp,
    });
  } catch (error: unknown) {
    console.error('Error getting current output:', error);
    return NextResponse.json(
      { error: 'Failed to get current output' },
      { status: 500 }
    );
  }
}
