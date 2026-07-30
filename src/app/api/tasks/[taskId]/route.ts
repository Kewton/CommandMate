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
 *
 * Issue #1548: the reported status is translated into a state-machine event and
 * applied through `applyTaskEvent`, so what a client may report and what may
 * actually happen next are decided in one place. A report the machine refuses
 * comes back 409 and is recorded in `task_events` as a rejected attempt.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getTask, getVerificationRun } from '@/lib/db';
import { applyTaskEvent } from '@/lib/tasks/task-transition-service';
import type { TaskEvent } from '@/lib/tasks/task-state-machine';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/task');

/** crypto.randomUUID() output; anything else was never a task id. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Statuses a client is allowed to report, and the event each one means.
 *
 * `failed` is `send_failed` rather than a verdict: the only client that reports
 * it is `commandmate send --contract` when the message could not be delivered.
 */
const CLIENT_REPORTABLE_EVENTS = {
  running: 'message_sent',
  failed: 'send_failed',
  cancelled: 'cancel',
} as const satisfies Record<string, TaskEvent>;

type ClientReportableStatus = keyof typeof CLIENT_REPORTABLE_EVENTS;

const CLIENT_REPORTABLE_STATUSES = Object.keys(
  CLIENT_REPORTABLE_EVENTS
) as ClientReportableStatus[];

function isClientReportable(value: unknown): value is ClientReportableStatus {
  return typeof value === 'string' && value in CLIENT_REPORTABLE_EVENTS;
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
    const result = applyTaskEvent(db, taskId, CLIENT_REPORTABLE_EVENTS[payload.status]);
    if (!result) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // The machine refused the report — a `succeeded` task cannot be reopened, a
    // `verifying` one cannot be told a send just started. The attempt is already
    // in `task_events`; the client gets told it did not take.
    if (result.toStatus === null) {
      return NextResponse.json(
        { error: `Task is ${result.fromStatus} and cannot move to ${payload.status}` },
        { status: 409 }
      );
    }

    return NextResponse.json({ task: result.task }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-updating-task:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}
