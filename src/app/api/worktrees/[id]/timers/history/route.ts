/**
 * Timer History API endpoint
 * Issue #540: Manual timer history cleanup
 *
 * DELETE - Clear all non-pending timer history for a worktree
 *
 * Security:
 * - [SEC-SF-002] worktreeId typeof/non-empty check + DB existence
 * - [SEC-MF-001] Fixed-string error responses in catch blocks
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db-instance';
import { clearTimerHistory } from '@/lib/db/timer-db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/timers/history');

/**
 * DELETE /api/worktrees/[id]/timers/history
 * Clear all non-pending timer history for a worktree
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // [SEC-SF-002] Validate worktreeId
    if (typeof id !== 'string' || id.length === 0) {
      return NextResponse.json({ error: 'Invalid worktree ID' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    const deletedCount = clearTimerHistory(db, id);

    return NextResponse.json({ deletedCount });
  } catch (error) {
    // [SEC-MF-001] Fixed-string error response
    logger.error('timer:history-delete-error', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
