/**
 * Terminal API endpoint
 * Sends commands to tmux sessions
 *
 * Issue #393: Security hardening
 * - isCliToolType() validation (D1-001)
 * - getWorktreeById() DB existence check (D1-002)
 * - CLIToolManager-based session name (D1-003)
 * - Session auto-creation removed (D1-004)
 * - MAX_COMMAND_LENGTH DoS protection (D1-006)
 * - Fixed-string error responses (D1-007, R4F002/R4F006/R4F007)
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db-instance';
import { hasSession, sendKeys } from '@/lib/tmux';

/** Maximum command length to prevent DoS via large send-keys payloads (D1-006) */
const MAX_COMMAND_LENGTH = 10000;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { cliToolId, command } = await req.json();

    // Validate cliToolId against known CLI tool types
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
        { status: 400 }
      );
    }

    // Validate command parameter presence and type
    if (!command || typeof command !== 'string') {
      return NextResponse.json(
        { error: 'Missing command parameter' },
        { status: 400 }
      );
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      return NextResponse.json(
        { error: 'Invalid command parameter' },
        { status: 400 }
      );
    }

    // Verify worktree exists in DB
    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    // Derive session name via CLIToolManager (validates via BaseCLITool.getSessionName)
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(params.id);

    // No auto-creation; return 404 if session does not exist
    const sessionExists = await hasSession(sessionName);
    if (!sessionExists) {
      return NextResponse.json(
        { error: 'Session not found. Use startSession API to create a session first.' },
        { status: 404 }
      );
    }

    // Send command to tmux session via sendKeys (not sendMessage, to avoid prompt detection overhead)
    await sendKeys(sessionName, command);

    return NextResponse.json({ success: true });
  } catch (error) {
    // Fixed-string error response (no internal details exposed to client)
    console.error('Terminal API error:', error);
    return NextResponse.json(
      { error: 'Failed to send command to terminal' },
      { status: 500 }
    );
  }
}
