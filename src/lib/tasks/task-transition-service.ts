/**
 * The only writer of `tasks.status` (Issue #1548, Phase 3-1).
 *
 * `applyTaskEvent` reads the current status, asks the state machine what the
 * event means, and — in one transaction — writes the new status and appends the
 * event. Phase 2-1 had each firing point call `updateTaskStatus` with a status
 * it chose itself; `updateTaskStatus` is no longer reachable from the
 * `@/lib/db` barrel so that this is the only door.
 *
 * A rejected transition still writes a `task_events` row (`to_status = NULL`).
 * The event happened; the machine declined to act on it. That distinction is
 * what tells a wiring bug apart from a race, and it is invisible if rejected
 * events are dropped.
 *
 * The UPDATE and the INSERT are one transaction because a status with no event
 * behind it, or an event whose status never landed, would each make the log
 * lie about the table it exists to explain. better-sqlite3 is synchronous, so a
 * transaction here also serialises concurrent callers with no further work.
 *
 * @module lib/tasks/task-transition-service
 */

import type Database from 'better-sqlite3';
import {
  getActiveTaskForInstance,
  getTask,
  updateTaskStatus,
  type Task,
  type TaskStatus,
} from '@/lib/db/tasks-db';
import { insertTaskEvent, type TaskEventPayload } from '@/lib/db/task-events-db';
import { createLogger } from '@/lib/logger';
import { transitionTask, type TaskEvent } from './task-state-machine';

const logger = createLogger('lib/tasks/task-transition-service');

export interface ApplyTaskEventResult {
  /** The task after the event; the unchanged row when the transition was rejected. */
  task: Task;
  fromStatus: TaskStatus;
  /** null when the state machine rejected the event; only the attempt was recorded. */
  toStatus: TaskStatus | null;
  /** id of the appended `task_events` row. */
  eventId: number;
}

/**
 * Apply `event` to a task.
 *
 * @param payload - Structured detail for the log. `runId` is also written to
 *   `tasks.last_verification_run_id` on an accepted transition, so the task's
 *   pointer to the run that last judged it and the event naming that run cannot
 *   disagree.
 * @returns null when the task does not exist — a deleted worktree takes its
 *   tasks with it, and a poller still holding the id must not crash for it
 */
export function applyTaskEvent(
  db: Database.Database,
  taskId: string,
  event: TaskEvent,
  payload?: TaskEventPayload
): ApplyTaskEventResult | null {
  const apply = db.transaction((): ApplyTaskEventResult | null => {
    const task = getTask(db, taskId);
    if (!task) {
      return null;
    }

    const fromStatus = task.status;
    const toStatus = transitionTask(fromStatus, event);
    const now = Date.now();

    const eventId = insertTaskEvent(db, {
      taskId,
      event,
      fromStatus,
      toStatus,
      payload,
      createdAt: now,
    });

    if (toStatus === null) {
      return { task, fromStatus, toStatus: null, eventId };
    }

    const updated = updateTaskStatus(
      db,
      taskId,
      toStatus,
      payload?.runId === undefined ? {} : { lastVerificationRunId: payload.runId }
    );

    return { task: updated, fromStatus, toStatus, eventId };
  });

  const result = apply();

  if (result === null) {
    logger.warn('task-event-unknown-task', { taskId, event });
  } else if (result.toStatus === null) {
    logger.warn('task-event-rejected', { taskId, event, fromStatus: result.fromStatus });
  }

  return result;
}

/**
 * Raise `event` on whichever task is currently governing one agent instance.
 *
 * The no-op is the important case. Prompts, auto-answers and human replies
 * happen constantly in sessions that were never sent a contract, and every
 * firing point calls this unconditionally — so "no active task" has to mean
 * "nothing happens", not "nothing to do, but raise something anyway". Anything
 * else would make Phase 3-1 a behaviour change for contract-less use.
 *
 * Never throws: these callers are pollers and API routes whose real job is the
 * message itself, and a task-log failure must not take that down with it.
 *
 * @param instanceId - Agent instance id; the tool id itself for the primary
 * @returns The result, or null when no active task governs this instance
 */
export function applyEventToActiveTask(
  db: Database.Database,
  worktreeId: string,
  cliToolId: string,
  instanceId: string,
  event: TaskEvent,
  payload?: TaskEventPayload
): ApplyTaskEventResult | null {
  try {
    const task = getActiveTaskForInstance(db, worktreeId, cliToolId, instanceId);
    if (!task) {
      return null;
    }
    return applyTaskEvent(db, task.id, event, payload);
  } catch (error) {
    logger.warn('task-event-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
