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

const SUPPORTED_TOOLS: CLIToolType[] = ['claude', 'codex', 'gemini'];

function isCliTool(value: string | null): value is CLIToolType {
  return !!value && (SUPPORTED_TOOLS as string[]).includes(value);
}

/**
 * Detect if CLI tool is showing "thinking" indicator (spinner)
 * Note: We no longer try to detect "completion" - just thinking state
 */
function detectThinking(cliToolId: CLIToolType, snippet: string): { thinking: boolean } {
  switch (cliToolId) {
    case 'codex': {
      const isThinking = /•\s*(Planning|Searching|Exploring|Running|Thinking|Working)/m.test(snippet);
      return { thinking: isThinking };
    }
    case 'gemini': {
      // Gemini doesn't have a thinking indicator in one-shot mode
      return { thinking: false };
    }
    case 'claude':
    default: {
      // Claude shows various spinner characters when thinking
      const isThinking = /[✻✽⏺·∴✢✳]\s+\w+…/m.test(snippet);
      return { thinking: isThinking };
    }
  }
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

    // Check for thinking state (spinner showing)
    const lastSection = lines.slice(-20).join('\n');
    const { thinking } = detectThinking(cliToolId, lastSection);

    // Check if it's an interactive prompt (yes/no or multiple choice)
    const promptDetection = detectPrompt(output);

    // isComplete is ONLY used for prompt detection (yes/no questions)
    // We no longer try to detect "normal" response completion
    const isPromptWaiting = promptDetection.isPrompt;

    // Extract realtime snippet (last 100 lines for better context)
    const realtimeSnippet = lines.slice(-100).join('\n');

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
      // Always show as generating while session is running (unless prompt waiting)
      isGenerating: !isPromptWaiting,
      thinking,
      thinkingMessage: thinking ? 'Claude is thinking...' : null,
      // New: indicate if waiting for user prompt
      isPromptWaiting,
    });
  } catch (error: unknown) {
    console.error('Error getting current output:', error);
    return NextResponse.json(
      { error: 'Failed to get current output' },
      { status: 500 }
    );
  }
}
