/**
 * API Route: /api/worktrees/:id/cmate/schedules
 * Issue #824: Schedules UX Phase 1 — CMATE.md write-only sync (Option C)
 *
 * Methods:
 * - POST:   Insert or update a schedule row in CMATE.md (upsert by Name)
 * - PATCH:  Toggle a schedule's Enabled flag in CMATE.md
 * - DELETE: Remove a schedule row from CMATE.md
 *
 * All mutations write CMATE.md (never the schedule DB directly), then trigger a
 * one-shot sync so the DB-backed list and cron jobs update immediately.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { sanitizeContent } from '@/config/cmate-constants';
import type { ScheduleWriteInput } from '@/types/cmate';
import {
  validateScheduleInput,
  writeScheduleToCmate,
  deleteScheduleFromCmate,
  setScheduleEnabledInCmate,
} from '@/lib/cmate-writer';
import { syncSchedulesNow } from '@/lib/schedule-manager';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/cmate-schedules');

/**
 * Resolve and validate the target worktree, returning its DB row or an error
 * response.
 */
function resolveWorktree(
  id: string,
): { worktree: { path: string } } | { error: NextResponse } {
  if (!isValidWorktreeId(id)) {
    return { error: NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 }) };
  }
  const db = getDbInstance();
  const worktree = getWorktreeById(db, id);
  if (!worktree) {
    return { error: NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 }) };
  }
  return { worktree };
}

/** Normalize an untrusted request body into a ScheduleWriteInput. */
function normalizeInput(body: Record<string, unknown>): ScheduleWriteInput {
  return {
    name: typeof body.name === 'string' ? sanitizeContent(body.name).trim() : '',
    cronExpression: typeof body.cronExpression === 'string' ? body.cronExpression.trim() : '',
    message: typeof body.message === 'string' ? sanitizeContent(body.message).trim() : '',
    cliToolId: typeof body.cliToolId === 'string' ? body.cliToolId.trim() : 'claude',
    enabled: body.enabled !== false,
    permission: typeof body.permission === 'string' ? body.permission.trim() : '',
    model:
      typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
  };
}

/**
 * POST /api/worktrees/:id/cmate/schedules
 * Insert or update a schedule row in CMATE.md.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const resolved = resolveWorktree(id);
    if ('error' in resolved) return resolved.error;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = normalizeInput(body);

    const { valid, errors } = validateScheduleInput(input);
    if (!valid) {
      return NextResponse.json({ error: errors[0], errors }, { status: 400 });
    }

    const originalName =
      typeof body.originalName === 'string' && body.originalName.trim()
        ? sanitizeContent(body.originalName).trim()
        : undefined;

    await writeScheduleToCmate(resolved.worktree.path, input, originalName);
    await syncSchedulesNow();

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-writing-schedule', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to write schedule' }, { status: 500 });
  }
}

/**
 * PATCH /api/worktrees/:id/cmate/schedules
 * Toggle a schedule's Enabled flag. Body: { name, enabled }.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const resolved = resolveWorktree(id);
    if ('error' in resolved) return resolved.error;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? sanitizeContent(body.name).trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 });
    }

    await setScheduleEnabledInCmate(resolved.worktree.path, name, body.enabled);
    await syncSchedulesNow();

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-toggling-schedule', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to toggle schedule' }, { status: 500 });
  }
}

/**
 * DELETE /api/worktrees/:id/cmate/schedules
 * Remove a schedule row. Body: { name }.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const resolved = resolveWorktree(id);
    if ('error' in resolved) return resolved.error;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? sanitizeContent(body.name).trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    await deleteScheduleFromCmate(resolved.worktree.path, name);
    await syncSchedulesNow();

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-deleting-schedule', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to delete schedule' }, { status: 500 });
  }
}
