/**
 * Terminal API endpoint
 * Sends commands to tmux sessions
 */

import { NextRequest, NextResponse } from 'next/server';
import * as tmux from '@/lib/tmux';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Helper function to get session name
function getSessionName(worktreeId: string, cliToolId: CLIToolType): string {
  return `mcbd-${cliToolId}-${worktreeId}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { cliToolId, command } = await req.json();

    if (!cliToolId || !command) {
      return NextResponse.json(
        { error: 'Missing cliToolId or command' },
        { status: 400 }
      );
    }

    const sessionName = getSessionName(params.id, cliToolId as CLIToolType);

    // Check if session exists
    const sessionExists = await tmux.hasSession(sessionName);

    if (!sessionExists) {
      // Start new session if it doesn't exist
      await tmux.createSession(sessionName, process.cwd());
    }

    // Send command to tmux session
    await sendToTmux(sessionName, command);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Terminal API error:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}

/**
 * Send command to tmux session
 */
async function sendToTmux(sessionName: string, command: string): Promise<void> {
  // Use the tmux sendKeys function from the tmux module
  await tmux.sendKeys(sessionName, command);
}