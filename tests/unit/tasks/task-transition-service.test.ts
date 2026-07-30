/**
 * applyTaskEvent / applyEventToActiveTask (Issue #1548, Phase 3-1).
 *
 * What matters here is not that the happy path works but that the failure
 * modes are the intended ones: a rejected transition is *recorded* rather than
 * dropped, a failing INSERT takes the UPDATE down with it, and a session with
 * no contract produces no rows at all.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, getTask, listTaskEvents, type Task, type TaskStatus } from '@/lib/db';
// Fixtures place a task in states the machine would refuse to reach; see
// tasks-db.test.ts for why this import bypasses the barrel.
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import {
  applyTaskEvent,
  applyEventToActiveTask,
} from '@/lib/tasks/task-transition-service';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

let db: Database.Database;

const CONTRACT = `version: 1
title: state machine work
goal: do the work
scope:
  allow: ["src/**"]
`;

function seedTask(
  options: { status?: TaskStatus; instanceId?: string | null; cliToolId?: string } = {}
): Task {
  return createTask(db, {
    worktreeId: 'wt-1',
    cliToolId: options.cliToolId ?? 'claude',
    instanceId: options.instanceId ?? null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(CONTRACT, 'task.yaml'),
    status: options.status ?? 'running',
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('applyTaskEvent — accepted transition', () => {
  it('moves the task and appends one event', () => {
    const task = seedTask({ status: 'pending' });
    const result = applyTaskEvent(db, task.id, 'message_sent');

    expect(result).not.toBeNull();
    expect(result?.fromStatus).toBe('pending');
    expect(result?.toStatus).toBe('running');
    expect(result?.task.status).toBe('running');
    expect(getTask(db, task.id)?.status).toBe('running');

    const events = listTaskEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'message_sent',
      fromStatus: 'pending',
      toStatus: 'running',
      payload: null,
    });
    expect(events[0].id).toBe(result?.eventId);
  });

  it('stores the payload and mirrors runId onto the task', () => {
    const task = seedTask();
    applyTaskEvent(db, task.id, 'verify_started', { runId: 12 });

    expect(getTask(db, task.id)?.lastVerificationRunId).toBe(12);
    expect(listTaskEvents(db, task.id)[0].payload).toEqual({ runId: 12 });
  });

  it('keeps a full history in order across a whole lifecycle', () => {
    const task = seedTask({ status: 'pending' });
    applyTaskEvent(db, task.id, 'message_sent');
    applyTaskEvent(db, task.id, 'prompt_detected', { promptType: 'yes_no' });
    applyTaskEvent(db, task.id, 'prompt_answered_human');
    applyTaskEvent(db, task.id, 'verify_started', { runId: 3 });
    applyTaskEvent(db, task.id, 'verify_passed', { runId: 3 });

    expect(listTaskEvents(db, task.id).map((e) => [e.event, e.toStatus])).toEqual([
      ['message_sent', 'running'],
      ['prompt_detected', 'waiting_input'],
      ['prompt_answered_human', 'running'],
      ['verify_started', 'verifying'],
      ['verify_passed', 'succeeded'],
    ]);
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });
});

describe('applyTaskEvent — rejected transition', () => {
  it('records the attempt with to_status null and leaves the task alone', () => {
    const task = seedTask({ status: 'verifying' });
    const result = applyTaskEvent(db, task.id, 'prompt_detected');

    expect(result?.fromStatus).toBe('verifying');
    expect(result?.toStatus).toBeNull();
    expect(result?.task.status).toBe('verifying');
    expect(getTask(db, task.id)?.status).toBe('verifying');

    const events = listTaskEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'prompt_detected',
      fromStatus: 'verifying',
      toStatus: null,
    });
  });

  it('does not write runId onto the task when the event was refused', () => {
    const task = seedTask({ status: 'succeeded' });
    applyTaskEvent(db, task.id, 'verify_started', { runId: 9 });

    expect(getTask(db, task.id)?.lastVerificationRunId).toBeNull();
    expect(listTaskEvents(db, task.id)[0].toStatus).toBeNull();
  });

  it('never moves a task out of succeeded, whatever is thrown at it', () => {
    const task = seedTask({ status: 'succeeded' });
    for (const event of ['message_sent', 'cancel', 'verify_failed', 'agent_idle'] as const) {
      applyTaskEvent(db, task.id, event);
    }

    expect(getTask(db, task.id)?.status).toBe('succeeded');
    const events = listTaskEvents(db, task.id);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.toStatus === null)).toBe(true);
  });

  it('returns null and writes nothing for a task that does not exist', () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(applyTaskEvent(db, missing, 'message_sent')).toBeNull();
    expect(listTaskEvents(db, missing)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
  });
});

describe('applyTaskEvent — atomicity', () => {
  it('rolls the status update back when the event insert fails', () => {
    const task = seedTask({ status: 'pending' });
    // Force the INSERT half to fail without touching the UPDATE half. If the
    // two were not one transaction, the task would land on `running` with no
    // event explaining it — the exact divergence the transaction exists to stop.
    db.exec('DROP TABLE task_events');

    expect(() => applyTaskEvent(db, task.id, 'message_sent')).toThrow();
    expect(getTask(db, task.id)?.status).toBe('pending');
  });

  it('rolls the event insert back when the status update fails', () => {
    const task = seedTask({ status: 'pending' });
    // The reverse ordering: a CHECK the UPDATE cannot satisfy. The event row is
    // written first, so surviving this proves the rollback covers it.
    db.exec(`
      CREATE TRIGGER reject_running BEFORE UPDATE ON tasks
      WHEN NEW.status = 'running'
      BEGIN SELECT RAISE(ABORT, 'nope'); END;
    `);

    expect(() => applyTaskEvent(db, task.id, 'message_sent')).toThrow(/nope/);
    expect(getTask(db, task.id)?.status).toBe('pending');
    expect(listTaskEvents(db, task.id)).toHaveLength(0);
  });

  it('serialises a nested apply without losing either event', () => {
    // better-sqlite3 is synchronous, so "concurrent" callers interleave only by
    // nesting. The inner transaction must become a savepoint, not a second
    // top-level transaction that commits the outer one early.
    const task = seedTask({ status: 'pending' });
    const nested = db.transaction(() => {
      applyTaskEvent(db, task.id, 'message_sent');
      applyTaskEvent(db, task.id, 'prompt_detected');
    });
    nested();

    expect(getTask(db, task.id)?.status).toBe('waiting_input');
    expect(listTaskEvents(db, task.id).map((e) => e.event)).toEqual([
      'message_sent',
      'prompt_detected',
    ]);
  });
});

describe('applyEventToActiveTask', () => {
  it('does nothing at all when no task governs the instance', () => {
    const result = applyEventToActiveTask(db, 'wt-1', 'claude', 'claude', 'prompt_detected');

    expect(result).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
  });

  it('does nothing when the only task for the instance is already closed', () => {
    const task = seedTask();
    updateTaskStatus(db, task.id, 'succeeded');

    expect(applyEventToActiveTask(db, 'wt-1', 'claude', 'claude', 'prompt_detected')).toBeNull();
    // Not merely "no transition" — a closed task is not active, so the lookup
    // never reaches the machine and no rejected-attempt row is written either.
    expect(listTaskEvents(db, task.id)).toHaveLength(0);
  });

  it('finds the primary instance by tool id when instance_id is null', () => {
    const task = seedTask({ instanceId: null });
    const result = applyEventToActiveTask(db, 'wt-1', 'claude', 'claude', 'prompt_detected');

    expect(result?.toStatus).toBe('waiting_input');
    expect(getTask(db, task.id)?.status).toBe('waiting_input');
  });

  it('does not let one instance move another instance\'s task', () => {
    const primary = seedTask({ cliToolId: 'codex', instanceId: null });
    const second = seedTask({ cliToolId: 'codex', instanceId: 'codex-2' });

    applyEventToActiveTask(db, 'wt-1', 'codex', 'codex-2', 'prompt_detected');

    expect(getTask(db, second.id)?.status).toBe('waiting_input');
    expect(getTask(db, primary.id)?.status).toBe('running');
  });

  it('swallows a database failure instead of taking the caller down', () => {
    // The callers are pollers and API routes whose real job is delivering the
    // message; the task log must never be the thing that fails the request.
    db.exec('DROP TABLE tasks');

    expect(() =>
      applyEventToActiveTask(db, 'wt-1', 'claude', 'claude', 'prompt_detected')
    ).not.toThrow();
    expect(applyEventToActiveTask(db, 'wt-1', 'claude', 'claude', 'prompt_detected')).toBeNull();
  });
});
