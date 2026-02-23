/**
 * API Route: /api/worktrees/:id/schedules/:scheduleId
 * GET: Get a specific schedule
 * PUT: Update a schedule
 * DELETE: Delete a schedule
 *
 * Issue #294: Schedule execution feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';

/** UUID v4 validation pattern [S4-014] */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum name length */
const MAX_NAME_LENGTH = 100;

/** Maximum message length */
const MAX_MESSAGE_LENGTH = 10000;

/** Maximum cron expression length */
const MAX_CRON_LENGTH = 100;

function isValidUuidV4(id: string): boolean {
  return UUID_V4_PATTERN.test(id);
}

/**
 * GET /api/worktrees/:id/schedules/:scheduleId
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; scheduleId: string } }
) {
  try {
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }
    if (!isValidUuidV4(params.scheduleId)) {
      return NextResponse.json({ error: 'Invalid schedule ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${params.id}' not found` }, { status: 404 });
    }

    const schedule = db.prepare(
      'SELECT * FROM scheduled_executions WHERE id = ? AND worktree_id = ?'
    ).get(params.scheduleId, params.id);

    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    return NextResponse.json({ schedule }, { status: 200 });
  } catch (error) {
    console.error('Error fetching schedule:', error);
    return NextResponse.json({ error: 'Failed to fetch schedule' }, { status: 500 });
  }
}

/**
 * PUT /api/worktrees/:id/schedules/:scheduleId
 * Updates a schedule
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string; scheduleId: string } }
) {
  try {
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }
    if (!isValidUuidV4(params.scheduleId)) {
      return NextResponse.json({ error: 'Invalid schedule ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${params.id}' not found` }, { status: 404 });
    }

    const existing = db.prepare(
      'SELECT * FROM scheduled_executions WHERE id = ? AND worktree_id = ?'
    ).get(params.scheduleId, params.id);

    if (!existing) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const { name, message, cronExpression, cliToolId, enabled } = body;

    // Validate optional fields
    if (name !== undefined && (typeof name !== 'string' || name.length > MAX_NAME_LENGTH)) {
      return NextResponse.json({ error: `name must be a string of ${MAX_NAME_LENGTH} characters or less` }, { status: 400 });
    }
    if (message !== undefined && (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH)) {
      return NextResponse.json({ error: `message must be a string of ${MAX_MESSAGE_LENGTH} characters or less` }, { status: 400 });
    }
    if (cronExpression !== undefined && (typeof cronExpression !== 'string' || cronExpression.length > MAX_CRON_LENGTH)) {
      return NextResponse.json({ error: `cronExpression must be a string of ${MAX_CRON_LENGTH} characters or less` }, { status: 400 });
    }

    const now = Date.now();

    // Build update fields
    const updates: string[] = [];
    const values: unknown[] = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (message !== undefined) { updates.push('message = ?'); values.push(message); }
    if (cronExpression !== undefined) { updates.push('cron_expression = ?'); values.push(cronExpression); }
    if (cliToolId !== undefined) { updates.push('cli_tool_id = ?'); values.push(cliToolId); }
    if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled ? 1 : 0); }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(params.scheduleId);
    values.push(params.id);

    db.prepare(
      `UPDATE scheduled_executions SET ${updates.join(', ')} WHERE id = ? AND worktree_id = ?`
    ).run(...values);

    const updated = db.prepare(
      'SELECT * FROM scheduled_executions WHERE id = ? AND worktree_id = ?'
    ).get(params.scheduleId, params.id);

    return NextResponse.json({ schedule: updated }, { status: 200 });
  } catch (error) {
    console.error('Error updating schedule:', error);
    return NextResponse.json({ error: 'Failed to update schedule' }, { status: 500 });
  }
}

/**
 * DELETE /api/worktrees/:id/schedules/:scheduleId
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; scheduleId: string } }
) {
  try {
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }
    if (!isValidUuidV4(params.scheduleId)) {
      return NextResponse.json({ error: 'Invalid schedule ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${params.id}' not found` }, { status: 404 });
    }

    const result = db.prepare(
      'DELETE FROM scheduled_executions WHERE id = ? AND worktree_id = ?'
    ).run(params.scheduleId, params.id);

    if (result.changes === 0) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    return NextResponse.json({ error: 'Failed to delete schedule' }, { status: 500 });
  }
}
