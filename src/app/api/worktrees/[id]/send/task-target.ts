/**
 * The target of a send made for a task (Issue #4449): `send --contract` creates the
 * task first (`POST /tasks`, which judges the tool policy for the target it resolves and
 * records that target), then the message and its Auto-Yes grant name the task by
 * `taskId`. They go to the task's recorded target — the one that was judged — and never
 * to a worktree default resolved again (a default changed in between would otherwise get
 * a message, or a refusal with the task row already written).
 *
 * The CLI keeps naming nobody (#4116: no `/resolve-target`, no `cliToolId` /
 * `instanceId` on the body): the task binds them. A body that names a target and a task
 * that recorded another is refused (400 `task_target_mismatch`), never resolved by
 * picking one of them silently.
 *
 * @module app/api/worktrees/[id]/send/task-target
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { getTask } from '@/lib/db/tasks-db';
import { isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';

/** Code of the 400 for a body whose target contradicts its task's. */
export const TASK_TARGET_MISMATCH = 'task_target_mismatch';

/** Code of the 400 for a `taskId` that names no task of this worktree. */
export const TASK_NOT_FOUND = 'task_not_found';

/** The longest `taskId` accepted (ids are UUIDs). */
const TASK_ID_MAX_CHARS = 128;

/** What a request names: its own target, and the task it is for. */
export interface TaskTargetInput {
  taskId?: unknown;
  cliToolId?: CLIToolType;
  instanceId?: string;
}

/** The target to resolve: the task's when the request names one, else the request's own. */
export interface TaskTargetValue {
  requestedCliTool: CLIToolType | undefined;
  instanceId: string | undefined;
}

function refusal(error: string, code: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error, code, sendOutcome: 'not_sent' }, { status: 400 }) };
}

/**
 * The target a request for a task goes to. Synchronous: the caller resolves and judges
 * it in the same stretch. `cliToolId` / `instanceId` must already be validated.
 */
export function readTaskTarget(
  db: Database.Database,
  worktreeId: string,
  input: TaskTargetInput,
): { ok: true; value: TaskTargetValue } | { ok: false; response: NextResponse } {
  if (input.taskId === undefined) {
    return { ok: true, value: { requestedCliTool: input.cliToolId, instanceId: input.instanceId } };
  }
  if (typeof input.taskId !== 'string' || input.taskId === '' || input.taskId.length > TASK_ID_MAX_CHARS) {
    return refusal('taskId must be a task id', TASK_NOT_FOUND);
  }
  const task = getTask(db, input.taskId);
  if (!task || task.worktreeId !== worktreeId || !isCliToolType(task.cliToolId)) {
    return refusal(`No task ${input.taskId} in this worktree`, TASK_NOT_FOUND);
  }
  const taskInstance = task.instanceId ?? task.cliToolId;
  if (input.cliToolId !== undefined && input.cliToolId !== task.cliToolId) {
    return refusal(
      `This request names ${input.cliToolId}, but task ${task.id} was created for ${task.cliToolId}. Nothing was sent.`,
      TASK_TARGET_MISMATCH,
    );
  }
  if (input.instanceId !== undefined && input.instanceId !== taskInstance) {
    return refusal(
      `This request names instance ${input.instanceId}, but task ${task.id} was created for ${taskInstance}. Nothing was sent.`,
      TASK_TARGET_MISMATCH,
    );
  }
  return {
    ok: true,
    value: { requestedCliTool: task.cliToolId, instanceId: task.instanceId ?? input.instanceId },
  };
}
