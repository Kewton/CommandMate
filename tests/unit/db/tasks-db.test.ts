/**
 * Unit tests for tasks-db (Issue #1545, migration v50).
 *
 * The selection rules are what the rest of the feature depends on:
 * `getActiveTask` is how a `wait --verify` with no task id finds the contract it
 * should verify against, so "which row wins" is asserted directly rather than
 * inferred from a happy path.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createTask,
  getActiveTask,
  getTask,
  isTerminalTaskStatus,
  listTasks,
  updateTaskStatus,
  type Task,
  type TaskStatus,
} from '@/lib/db';
import { parseTaskContract, type TaskContract } from '@/lib/tasks/contract-parser';

let db: Database.Database;

function contract(overrides: { title?: string; gates?: string[] } = {}): TaskContract {
  const gates = overrides.gates ? `verify:\n  gates: [${overrides.gates.join(', ')}]\n` : '';
  return parseTaskContract(
    `version: 1
title: "${overrides.title ?? 'a task'}"
goal: do the thing
scope:
  allow: ["src/**"]
${gates}`,
    'task.yaml'
  );
}

function seed(
  overrides: Partial<{
    worktreeId: string;
    cliToolId: string;
    instanceId: string | null;
    status: TaskStatus;
    title: string;
    gates: string[];
  }> = {}
): Task {
  return createTask(db, {
    worktreeId: overrides.worktreeId ?? 'wt-1',
    cliToolId: overrides.cliToolId ?? 'claude',
    instanceId: overrides.instanceId ?? null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: contract({ title: overrides.title, gates: overrides.gates }),
    status: overrides.status,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('createTask', () => {
  it('opens a task as pending with no started_at', () => {
    const task = seed();

    expect(task.status).toBe('pending');
    expect(task.startedAt).toBeNull();
    expect(task.finishedAt).toBeNull();
    expect(task.lastVerificationRunId).toBeNull();
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('copies title and goal out of the contract so a listing needs no re-parse', () => {
    const task = seed({ title: 'loader work' });
    expect(task.title).toBe('loader work');
    expect(task.goal).toBe('do the thing');
  });

  it('round-trips the contract snapshot', () => {
    const task = seed({ gates: ['lint', 'unit'] });
    expect(task.contract.verify.gates).toEqual(['lint', 'unit']);
    expect(getTask(db, task.id)?.contract).toEqual(task.contract);
  });

  it('stamps started_at when the caller opens the task past pending', () => {
    expect(seed({ status: 'running' }).startedAt).toBeInstanceOf(Date);
  });
});

describe('getTask / listTasks', () => {
  it('returns null for an unknown id', () => {
    expect(getTask(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('lists a worktree newest first and honours the limit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00Z'));
    const first = seed({ title: 'one' });
    vi.setSystemTime(new Date('2026-07-30T00:00:01Z'));
    const second = seed({ title: 'two' });
    vi.setSystemTime(new Date('2026-07-30T00:00:02Z'));
    const third = seed({ title: 'three' });

    const all = listTasks(db, 'wt-1');
    expect(all.map((t) => t.id)).toEqual([third.id, second.id, first.id]);
    expect(listTasks(db, 'wt-1', 2).map((t) => t.id)).toEqual([third.id, second.id]);
  });

  it('orders same-millisecond tasks by insertion, since ids are random UUIDs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00Z'));
    const first = seed({ title: 'one' });
    const second = seed({ title: 'two' });

    expect(listTasks(db, 'wt-1').map((t) => t.id)).toEqual([second.id, first.id]);
  });

  it('does not leak tasks across worktrees', () => {
    seed({ worktreeId: 'wt-1' });
    const other = seed({ worktreeId: 'wt-2' });
    expect(listTasks(db, 'wt-2').map((t) => t.id)).toEqual([other.id]);
  });
});

describe('updateTaskStatus', () => {
  it('stamps started_at on the first move out of pending and never rewrites it', () => {
    const task = seed();
    const running = updateTaskStatus(db, task.id, 'running');
    expect(running.startedAt).toBeInstanceOf(Date);

    const verifying = updateTaskStatus(db, task.id, 'verifying');
    expect(verifying.startedAt?.getTime()).toBe(running.startedAt?.getTime());
    expect(verifying.finishedAt).toBeNull();
  });

  it('stamps finished_at for terminal statuses only', () => {
    const task = seed({ status: 'running' });
    expect(updateTaskStatus(db, task.id, 'verifying').finishedAt).toBeNull();
    expect(updateTaskStatus(db, task.id, 'succeeded').finishedAt).toBeInstanceOf(Date);
  });

  it('records the verification run and keeps it when a later transition omits it', () => {
    const task = seed({ status: 'running' });
    expect(updateTaskStatus(db, task.id, 'verifying', { lastVerificationRunId: 7 })
      .lastVerificationRunId).toBe(7);
    expect(updateTaskStatus(db, task.id, 'failed').lastVerificationRunId).toBe(7);
  });

  it('throws for an unknown task instead of silently recording nothing', () => {
    expect(() => updateTaskStatus(db, '00000000-0000-4000-8000-000000000000', 'running')).toThrow(
      /not found/
    );
  });

  it('classifies terminal statuses consistently with the status list', () => {
    expect(isTerminalTaskStatus('succeeded')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('not_started')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('verifying')).toBe(false);
    expect(isTerminalTaskStatus('pending')).toBe(false);
  });
});

describe('getActiveTask', () => {
  it('returns null when the worktree has no tasks at all', () => {
    expect(getActiveTask(db, 'wt-1')).toBeNull();
  });

  it('ignores a pending task: nothing has been sent, so there is no work to judge', () => {
    seed({ status: 'pending' });
    expect(getActiveTask(db, 'wt-1')).toBeNull();
  });

  it.each(['succeeded', 'failed', 'not_started', 'cancelled'] as const)(
    'ignores a %s task',
    (status) => {
      seed({ status });
      expect(getActiveTask(db, 'wt-1')).toBeNull();
    }
  );

  it.each(['running', 'waiting_input', 'verifying'] as const)('finds a %s task', (status) => {
    const task = seed({ status });
    expect(getActiveTask(db, 'wt-1')?.id).toBe(task.id);
  });

  it('takes the most recently updated active task', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00Z'));
    const older = seed({ status: 'running', title: 'older' });
    vi.setSystemTime(new Date('2026-07-30T00:00:01Z'));
    const newer = seed({ status: 'running', title: 'newer' });

    expect(getActiveTask(db, 'wt-1')?.id).toBe(newer.id);

    // Touching the older task makes it the most recent — the rule is
    // "last updated", not "last created".
    vi.setSystemTime(new Date('2026-07-30T00:00:02Z'));
    updateTaskStatus(db, older.id, 'waiting_input');
    expect(getActiveTask(db, 'wt-1')?.id).toBe(older.id);
  });

  it('scopes to the worktree', () => {
    seed({ worktreeId: 'wt-2', status: 'running' });
    expect(getActiveTask(db, 'wt-1')).toBeNull();
  });

  it('narrows by cliToolId when one is supplied', () => {
    const claude = seed({ status: 'running', cliToolId: 'claude' });
    const codex = seed({ status: 'running', cliToolId: 'codex' });

    expect(getActiveTask(db, 'wt-1', 'claude')?.id).toBe(claude.id);
    expect(getActiveTask(db, 'wt-1', 'codex')?.id).toBe(codex.id);
    expect(getActiveTask(db, 'wt-1', 'gemini')).toBeNull();
  });

  it('narrows by instanceId when one is supplied', () => {
    seed({ status: 'running', cliToolId: 'codex', instanceId: null });
    const second = seed({ status: 'running', cliToolId: 'codex', instanceId: 'codex-2' });

    expect(getActiveTask(db, 'wt-1', 'codex', 'codex-2')?.id).toBe(second.id);
    expect(getActiveTask(db, 'wt-1', 'codex', 'codex-3')).toBeNull();
  });
});
