/**
 * API Route: /api/worktrees/:id/schedules
 * GET: List all schedules for a worktree
 * POST: Create a new schedule for a worktree
 *
 * Issue #294: Schedule execution feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';

/** Maximum name length */
const MAX_NAME_LENGTH = 100;

/** Maximum message length */
const MAX_MESSAGE_LENGTH = 10000;

/** Maximum cron expression length */
const MAX_CRON_LENGTH = 100;

/**
 * GET /api/worktrees/:id/schedules
 * Returns all schedules for a worktree
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

    const schedules = db.prepare(
      'SELECT * FROM scheduled_executions WHERE worktree_id = ? ORDER BY created_at DESC'
    ).all(params.id);

    return NextResponse.json({ schedules }, { status: 200 });
  } catch (error) {
    console.error('Error fetching schedules:', error);
    return NextResponse.json({ error: 'Failed to fetch schedules' }, { status: 500 });
  }
}

/**
 * POST /api/worktrees/:id/schedules
 * Creates a new schedule
 *
 * Request body:
 * - name: string (required, max 100 chars)
 * - message: string (required, max 10000 chars)
 * - cronExpression: string (required, max 100 chars)
 * - cliToolId?: string (default: 'claude')
 * - enabled?: boolean (default: true)
 */
export async function POST(
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

    const body = await request.json().catch(() => ({}));
    const { name, message, cronExpression, cliToolId, enabled } = body;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `name must be ${MAX_NAME_LENGTH} characters or less` }, { status: 400 });
    }
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'message is required' }, { status: 400 });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: `message must be ${MAX_MESSAGE_LENGTH} characters or less` }, { status: 400 });
    }
    if (!cronExpression || typeof cronExpression !== 'string') {
      return NextResponse.json({ error: 'cronExpression is required' }, { status: 400 });
    }
    if (cronExpression.length > MAX_CRON_LENGTH) {
      return NextResponse.json({ error: `cronExpression must be ${MAX_CRON_LENGTH} characters or less` }, { status: 400 });
    }

    const now = Date.now();
    const id = randomUUID();
    const enabledValue = enabled !== false ? 1 : 0;
    const toolId = cliToolId || 'claude';

    db.prepare(`
      INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, params.id, name, message, cronExpression, toolId, enabledValue, now, now);

    const schedule = db.prepare('SELECT * FROM scheduled_executions WHERE id = ?').get(id);

    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    console.error('Error creating schedule:', error);
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 });
  }
}
