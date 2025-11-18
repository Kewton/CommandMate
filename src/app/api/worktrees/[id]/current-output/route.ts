/**
 * API Route: GET /api/worktrees/:id/current-output
 * Gets the current tmux output for a worktree (even if incomplete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, getSessionState } from '@/lib/db';
import { captureClaudeOutput, isClaudeRunning } from '@/lib/claude-session';

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

    // Check if Claude session is running
    const running = await isClaudeRunning(params.id);
    if (!running) {
      return NextResponse.json(
        {
          isRunning: false,
          content: '',
          lineCount: 0,
        },
        { status: 200 }
      );
    }

    // Get session state
    const sessionState = getSessionState(db, params.id);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureClaudeOutput(params.id, 10000);
    const lines = output.split('\n');
    const totalLines = lines.length;

    // Extract new content since last capture
    const newLines = lines.slice(Math.max(0, lastCapturedLine));
    const newContent = newLines.join('\n');

    // Check for completion indicators
    const lastSection = lines.slice(-20).join('\n');
    const hasPrompt = /^>\s*$/m.test(lastSection);
    const hasSeparator = /^─{50,}$/m.test(lastSection);
    const isThinking = /^[✻✽⏺·∴]\s+\w+…/m.test(lastSection);

    const isComplete = hasPrompt && hasSeparator && !isThinking;

    return NextResponse.json({
      isRunning: true,
      content: newContent,
      fullOutput: output,
      lineCount: totalLines,
      lastCapturedLine,
      isComplete,
      isGenerating: !isComplete && lines.length > 0,
    });
  } catch (error: any) {
    console.error('Error getting current output:', error);
    return NextResponse.json(
      { error: 'Failed to get current output' },
      { status: 500 }
    );
  }
}
