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

/**
 * Ids `createTask` will hand out, oldest first. Empty means "use the real
 * randomUUID", so only the tie-break tests below take control of them.
 *
 * The tie-break tests cannot use real ids: `id DESC` over random UUIDs matches
 * insertion order roughly half the time for two rows, so a test built on them
 * passes or fails by coin flip and guards nothing.
 */
const { queuedIds } = vi.hoisted(() => ({ queuedIds: [] as string[] }));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    default: actual,
    randomUUID: (...args: unknown[]): string =>
      queuedIds.shift() ??
      (actual.randomUUID as unknown as (...a: unknown[]) => string)(...args),
  };
});
import {
  createTask,
  getActiveTask,
  getTask,
  isTerminalTaskStatus,
  listTasks,
  type Task,
  type TaskStatus,
} from '@/lib/db';
// `updateTaskStatus` is deliberately not re-exported from the `@/lib/db` barrel
// (#1548): production code must go through `applyTaskEvent`, which is the only
// writer that also records why the status moved. These tests are the unit tests
// *of* `updateTaskStatus`, so they take the module's own path.
import { updateTaskStatus } from '@/lib/db/tasks-db';
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

/**
 * Ids whose descending lexicographic order is NOT reverse insertion order.
 *
 * Inserted A → B → C, an insertion-order tie-break yields C, B, A while an
 * `id DESC` tie-break yields B, C, A. The two disagree in the first position, so
 * a test asserting the former fails deterministically under the latter — which
 * is the whole point of pinning the ids.
 */
const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'cccccccc-0000-4000-8000-000000000002';
const ID_C = 'bbbbbbbb-0000-4000-8000-000000000003';

/** Hand `createTask` the next ids to use, in order. */
function queueIds(...ids: string[]): void {
  queuedIds.length = 0;
  queuedIds.push(...ids);
}

/**
 * Create three tasks that share `created_at` and `updated_at` to the
 * millisecond, so only the tie-break can decide their order.
 */
function seedTiedTrio(status?: TaskStatus): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-30T00:00:00Z'));
  queueIds(ID_A, ID_B, ID_C);

  const created = [
    seed({ title: 'A', status }),
    seed({ title: 'B', status }),
    seed({ title: 'C', status }),
  ];

  // Without this the pinned ids are silently not in effect (a broken module
  // mock, a changed id source) and the tie-break assertions below would be back
  // to comparing random UUIDs — passing by luck.
  expect(created.map((task) => task.id)).toEqual([ID_A, ID_B, ID_C]);
  const timestamps = created.map((task) => task.createdAt.getTime());
  expect(new Set(timestamps).size).toBe(1);
  expect(created.map((task) => task.updatedAt.getTime())).toEqual(timestamps);
}

beforeEach(() => {
  queuedIds.length = 0;
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

  it('breaks a same-millisecond tie by insertion order, not by id', () => {
    seedTiedTrio();

    // Insertion order reversed. An `id DESC` tie-break would return
    // [ID_B, ID_C, ID_A] here: ids are random UUIDs in production, so ordering
    // by them puts same-millisecond tasks in an order nothing chose.
    expect(listTasks(db, 'wt-1').map((task) => task.id)).toEqual([ID_C, ID_B, ID_A]);
  });

  it('applies the limit to the tie-broken order, not to an arbitrary one', () => {
    seedTiedTrio();

    // The newest two by insertion. Under an `id DESC` tie-break the second slot
    // would be ID_C, so a truncated list would silently drop the wrong task.
    expect(listTasks(db, 'wt-1', 2).map((task) => task.id)).toEqual([ID_C, ID_B]);
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

  it('breaks a same-millisecond tie by insertion order, not by id', () => {
    seedTiedTrio('running');

    // The last task sent is the one a verification run belongs to. An `id DESC`
    // tie-break would answer ID_B here — a task that was superseded before the
    // run started, so the run would be judged against the wrong contract.
    expect(getActiveTask(db, 'wt-1')?.id).toBe(ID_C);
  });

  it('still prefers a later update over the insertion tie-break', () => {
    seedTiedTrio('running');

    // The tie-break only decides when updated_at is equal; touching an older
    // task must still win outright.
    vi.setSystemTime(new Date('2026-07-30T00:00:01Z'));
    updateTaskStatus(db, ID_A, 'waiting_input');
    expect(getActiveTask(db, 'wt-1')?.id).toBe(ID_A);
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
