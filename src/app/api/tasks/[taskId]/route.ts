/**
 * API Route: GET / PATCH /api/tasks/:taskId
 * Execution contracts (Issue #1545, Phase 2-1).
 *
 * GET returns the task with the verification run that last judged it, so one
 * request answers both "what was this task supposed to do" and "what did the
 * gates say about it".
 *
 * PATCH is deliberately narrow. A client may report that a send started
 * (`running`), that it could not be delivered (`failed`), or that the task was
 * abandoned (`cancelled`). It may NOT report `succeeded`: success is a verdict
 * that only a verification run produces, and accepting a client's claim of it
 * would reintroduce the exact "the agent said it was done" problem the tasks
 * table exists to remove.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getTask,
  getVerificationRun,
  isTerminalTaskStatus,
  updateTaskStatus,
  type TaskStatus,
} from '@/lib/db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/task');

/** crypto.randomUUID() output; anything else was never a task id. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses a client is allowed to report. See the module comment. */
const CLIENT_REPORTABLE_STATUSES = ['running', 'failed', 'cancelled'] as const;

function isClientReportable(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' && (CLIENT_REPORTABLE_STATUSES as readonly string[]).includes(value)
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;
    if (!TASK_ID_PATTERN.test(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const task = getTask(db, taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const lastVerificationRun =
      task.lastVerificationRunId === null
        ? null
        : getVerificationRun(db, task.lastVerificationRunId);

    return NextResponse.json({ task, lastVerificationRun }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-fetching-task:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;
    if (!TASK_ID_PATTERN.test(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID format' }, { status: 400 });
    }

    const body: unknown = await request.json().catch(() => ({}));
    const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;

    if (!isClientReportable(payload.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${CLIENT_REPORTABLE_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    const task = getTask(db, taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // A terminal task is history. Reopening it would let a late retry overwrite
    // a recorded verdict.
    if (isTerminalTaskStatus(task.status)) {
      return NextResponse.json(
        { error: `Task is already ${task.status} and cannot be reopened` },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { task: updateTaskStatus(db, taskId, payload.status) },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('error-updating-task:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}
