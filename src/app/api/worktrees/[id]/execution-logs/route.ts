/**
 * API Route: /api/worktrees/:id/execution-logs
 * GET: List execution logs for a worktree (result column EXCLUDED)
 *
 * Issue #294: Schedule execution feature
 * [S1-014/S2-002] result column excluded from list endpoint for performance
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';

/**
 * GET /api/worktrees/:id/execution-logs
 * Returns execution logs WITHOUT result column (for list view performance)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // [S4-010] 2-stage worktree ID validation
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${params.id}' not found` }, { status: 404 });
    }

    // [S1-014] Exclude result column from list API for performance
    // Return all execution logs with schedule name via LEFT JOIN
    // (includes logs from renamed/disabled schedules)
    const logs = db.prepare(`
      SELECT el.id, el.schedule_id, el.worktree_id, el.message, el.exit_code, el.status, el.started_at, el.completed_at, el.created_at,
             se.name AS schedule_name
      FROM execution_logs el
      LEFT JOIN scheduled_executions se ON el.schedule_id = se.id
      WHERE el.worktree_id = ?
      ORDER BY el.created_at DESC
      LIMIT 100
    `).all(params.id);

    return NextResponse.json({ logs }, { status: 200 });
  } catch (error) {
    console.error('Error fetching execution logs:', error);
    return NextResponse.json({ error: 'Failed to fetch execution logs' }, { status: 500 });
  }
}
