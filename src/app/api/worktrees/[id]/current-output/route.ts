/**
 * API Route: GET /api/worktrees/:id/current-output
 * Gets the current tmux output for a worktree (even if incomplete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, getSessionState } from '@/lib/db';
import { detectPrompt } from '@/lib/prompt-detector';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/cli-session';
import { detectThinking as detectThinkingState, stripAnsi } from '@/lib/cli-patterns';
import { getAutoYesState } from '@/lib/auto-yes-manager';

const SUPPORTED_TOOLS: CLIToolType[] = ['claude', 'codex', 'gemini'];

function isCliTool(value: string | null): value is CLIToolType {
  return !!value && (SUPPORTED_TOOLS as string[]).includes(value);
}

export async function GET(
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

    // Check last 15 non-empty lines for state detection
    const nonEmptyLines = lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '');
    const lastSection = nonEmptyLines.slice(-15).join('\n');

    // Check if it's an interactive prompt (yes/no or multiple choice)
    // Strip ANSI codes before prompt detection for reliable pattern matching
    const cleanOutput = stripAnsi(output);
    const promptDetection = detectPrompt(cleanOutput);

    // isComplete is ONLY used for prompt detection (yes/no questions)
    // We no longer try to detect "normal" response completion
    const isPromptWaiting = promptDetection.isPrompt;

    // Check for thinking indicator FIRST (takes priority)
    // Even if input prompt is visible, thinking indicator means processing
    const thinking = !isPromptWaiting && detectThinkingState(cliToolId, lastSection);

    // Extract realtime snippet (last 100 lines for better context)
    const realtimeSnippet = lines.slice(-100).join('\n');

    // Get auto-yes state
    const autoYesState = getAutoYesState(params.id);

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
      // Auto-yes state
      autoYes: {
        enabled: autoYesState?.enabled ?? false,
        expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null,
      },
    });
  } catch (error: unknown) {
    console.error('Error getting current output:', error);
    return NextResponse.json(
      { error: 'Failed to get current output' },
      { status: 500 }
    );
  }
}
