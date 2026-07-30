/**
 * API Route: POST /api/tasks/:taskId/cancel
 * Abandon a task (Issue #1548, Phase 3-1).
 *
 * Separate from `PATCH /api/tasks/:taskId` because cancelling is the one task
 * transition that is a decision rather than a report. PATCH exists for a client
 * relaying what happened to a send it made; this endpoint exists for someone
 * deciding the task is over, from any status the machine still allows it in.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { applyTaskEvent } from '@/lib/tasks/task-transition-service';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/task-cancel');

/** crypto.randomUUID() output; anything else was never a task id. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;
    if (!TASK_ID_PATTERN.test(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID format' }, { status: 400 });
    }

    const result = applyTaskEvent(getDbInstance(), taskId, 'cancel');
    if (!result) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Already closed. Reporting this as success would tell the caller it
    // cancelled a task that in fact reached its own verdict.
    if (result.toStatus === null) {
      return NextResponse.json(
        { error: `Task is already ${result.fromStatus} and cannot be cancelled` },
        { status: 409 }
      );
    }

    return NextResponse.json({ task: result.task }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-cancelling-task:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to cancel task' }, { status: 500 });
  }
}
