/**
 * Terminal Capture API endpoint
 * Captures current tmux session output
 *
 * Issue #393: Security hardening
 * - isCliToolType() validation (D1-001)
 * - getWorktreeById() DB existence check (D1-002)
 * - CLIToolManager-based session name (D1-003)
 * - Session auto-creation removed; 404 on missing session (D1-004, R4F007)
 * - lines parameter 4-stage validation (D1-005, R1F010)
 * - Fixed-string error responses (D1-007, R4F002/R4F006/R4F007)
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db-instance';
import { hasSession, capturePane } from '@/lib/tmux';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { cliToolId, lines = 1000 } = await req.json();

    // Validate cliToolId against known CLI tool types
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
        { status: 400 }
      );
    }

    // Validate lines parameter: type, integer, range [1, 100000]
    if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 100000) {
      return NextResponse.json(
        { error: 'Invalid lines parameter: must be an integer between 1 and 100000' },
        { status: 400 }
      );
    }
    const safeLines = Math.floor(lines); // redundant after isInteger check; kept as defense-in-depth

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

    // Capture current output
    const output = await capturePane(sessionName, safeLines);

    return NextResponse.json({ output });
  } catch (error) {
    // Fixed-string error response (no internal details exposed to client)
    console.error('Capture API error:', error);
    return NextResponse.json(
      { error: 'Failed to capture terminal output' },
      { status: 500 }
    );
  }
}
