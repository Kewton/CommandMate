/**
 * API Route: /api/worktrees/:id/execution-logs/:logId
 * GET: Get a specific execution log (INCLUDING result column)
 *
 * Issue #294: Schedule execution feature
 * [S2-002] Individual log endpoint includes full result for detail view
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';

/** UUID v4 validation pattern [S4-014] */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuidV4(id: string): boolean {
  return UUID_V4_PATTERN.test(id);
}

/**
 * GET /api/worktrees/:id/execution-logs/:logId
 * Returns a single execution log WITH result column
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; logId: string } }
) {
  try {
    // [S4-010] 2-stage worktree ID validation
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    // [S4-014] UUID v4 format validation
    if (!isValidUuidV4(params.logId)) {
      return NextResponse.json({ error: 'Invalid log ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${params.id}' not found` }, { status: 404 });
    }

    // Include result column for individual log detail
    const log = db.prepare(
      'SELECT * FROM execution_logs WHERE id = ? AND worktree_id = ?'
    ).get(params.logId, params.id);

    if (!log) {
      return NextResponse.json({ error: 'Execution log not found' }, { status: 404 });
    }

    return NextResponse.json({ log }, { status: 200 });
  } catch (error) {
    console.error('Error fetching execution log:', error);
    return NextResponse.json({ error: 'Failed to fetch execution log' }, { status: 500 });
  }
}
