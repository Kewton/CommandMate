/**
 * API Route: /api/worktrees/:id/execution-logs
 * GET: List execution logs for a worktree (result column EXCLUDED)
 *
 * Issue #294: Schedule execution feature
 * [S1-014/S2-002] result column excluded from list endpoint for performance
 * Issue #2577: each row carries `warning` — the blocked-tool-call line read off
 *   the head of `result`, so a run the CLI called a success but whose tool
 *   calls were refused does not list as a plain success
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import {
  COMMAND_CODE_BLOCKED_WARNING_PREFIX,
  EXECUTION_LOG_WARNING_HEAD_LENGTH,
  readExecutionLogWarning,
} from '@/lib/session/claude-executor';

const logger = createLogger('api/execution-logs');

/**
 * GET /api/worktrees/:id/execution-logs
 * Returns execution logs WITHOUT result column (for list view performance)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // [S4-010] 2-stage worktree ID validation
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    // [S1-014] Exclude result column from list API for performance
    // Return all execution logs with schedule name via LEFT JOIN
    // (includes logs from renamed/disabled schedules)
    //
    // Issue #2577: the one exception is the warning line claude-executor writes
    // first when command-code reported blocked tool calls. Only rows whose
    // result starts with the prefix hand back a bounded head, so the list still
    // never reads the transcript itself.
    const rows = db.prepare(`
      SELECT el.id, el.schedule_id, el.worktree_id, el.message, el.exit_code, el.status, el.started_at, el.completed_at, el.created_at,
             se.name AS schedule_name,
             CASE WHEN substr(el.result, 1, ?) = ? THEN substr(el.result, 1, ?) END AS result_head
      FROM execution_logs el
      LEFT JOIN scheduled_executions se ON el.schedule_id = se.id
      WHERE el.worktree_id = ?
      ORDER BY el.created_at DESC
      LIMIT 100
    `).all(
      COMMAND_CODE_BLOCKED_WARNING_PREFIX.length,
      COMMAND_CODE_BLOCKED_WARNING_PREFIX,
      EXECUTION_LOG_WARNING_HEAD_LENGTH,
      id
    ) as Array<Record<string, unknown> & { result_head: string | null }>;

    const logs = rows.map(({ result_head: resultHead, ...log }) => ({
      ...log,
      warning: readExecutionLogWarning(resultHead),
    }));

    return NextResponse.json({ logs }, { status: 200 });
  } catch (error) {
    logger.error('error-fetching-execution-logs:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Failed to fetch execution logs' }, { status: 500 });
  }
}
