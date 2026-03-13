/**
 * API Route: PATCH /api/worktrees/:id/viewed
 * Marks a worktree as viewed (updates last_viewed_at timestamp)
 * Used for unread tracking (Issue #31 - G4)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, updateLastViewedAt } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/viewed');

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDbInstance();

    // MF1: Check if worktree exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Update last_viewed_at to current timestamp
    const viewedAt = new Date();
    updateLastViewedAt(db, params.id, viewedAt);

    // SF2: Log the viewed update
    logger.info('marked-worktree-as-viewed');

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-updating-viewed-status:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to update viewed status' },
      { status: 500 }
    );
  }
}
