/**
 * Issue #1547: resolving the autoYes policy of the task governing a session.
 *
 * Driven against a real migrated SQLite database rather than a mocked
 * `getActiveTaskForInstance`, because the part most likely to be wrong is the
 * SQL itself: the primary instance is recorded as `instance_id` NULL *or* the
 * tool id, and `= ?` matches neither reliably. A mock would have agreed with any
 * implementation.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
const openedDatabases = vi.fn();

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    openedDatabases();
    return db;
  },
}));

import { createTask, type Task, type TaskStatus } from '@/lib/db';
// See tasks-db.test.ts: fixtures reach past the barrel on purpose (#1548).
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract, type TaskContract } from '@/lib/tasks/contract-parser';
import {
  AUTO_YES_POLICY_CACHE_TTL_MS,
  clearAutoYesPolicyCache,
  getSessionAutoYesPolicy,
  invalidateSessionAutoYesPolicy,
} from '@/lib/polling/auto-yes-policy';

function contract(autoYes = "autoYes:\n  mode: 'off'\n"): TaskContract {
  return parseTaskContract(
    `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYes}`,
    'task.yaml'
  );
}

function seed(
  overrides: Partial<{
    worktreeId: string;
    cliToolId: string;
    instanceId: string | null;
    status: TaskStatus;
    autoYes: string;
  }> = {}
): Task {
  return createTask(db, {
    worktreeId: overrides.worktreeId ?? 'wt-1',
    cliToolId: overrides.cliToolId ?? 'claude',
    instanceId: overrides.instanceId ?? null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: contract(overrides.autoYes),
    status: overrides.status ?? 'running',
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  clearAutoYesPolicyCache();
  openedDatabases.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('getSessionAutoYesPolicy', () => {
  it('returns null when the worktree has no task at all', () => {
    expect(getSessionAutoYesPolicy('wt-1', 'claude')).toBeNull();
  });

  it('returns the autoYes block of the active task', () => {
    seed({ autoYes: "autoYes:\n  mode: safe\n  denyPatterns: ['rm -rf']\n" });

    expect(getSessionAutoYesPolicy('wt-1', 'claude')).toEqual({
      mode: 'safe',
      allowPromptTypes: [],
      denyPatterns: ['rm -rf'],
    });
  });

  it('returns mode null for a contract that declares no autoYes block', () => {
    // The shape that must behave exactly like "no contract" downstream.
    seed({ autoYes: '' });

    expect(getSessionAutoYesPolicy('wt-1', 'claude')).toEqual({
      mode: null,
      allowPromptTypes: [],
      denyPatterns: [],
    });
  });

  it('ignores a task that has not been sent yet', () => {
    seed({ status: 'pending' });

    expect(getSessionAutoYesPolicy('wt-1', 'claude')).toBeNull();
  });

  it.each(['succeeded', 'failed', 'cancelled', 'not_started'] as const)(
    'returns to unconstrained behaviour once the task is %s',
    status => {
      const task = seed();
      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');

      updateTaskStatus(db, task.id, status);
      invalidateSessionAutoYesPolicy('wt-1:claude');

      expect(getSessionAutoYesPolicy('wt-1', 'claude')).toBeNull();
    }
  );

  it('does not leak another worktree\'s contract', () => {
    seed({ worktreeId: 'wt-other' });

    expect(getSessionAutoYesPolicy('wt-1', 'claude')).toBeNull();
  });

  it('does not leak another agent\'s contract', () => {
    seed({ cliToolId: 'codex' });

    expect(getSessionAutoYesPolicy('wt-1', 'claude')).toBeNull();
  });

  describe('instance scoping', () => {
    it('matches the primary instance when the row records NULL', () => {
      seed({ instanceId: null });

      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');
      expect(getSessionAutoYesPolicy('wt-1', 'claude', 'claude')?.mode).toBe('off');
    });

    it('matches the primary instance when the row records the tool id', () => {
      // `send --instance claude` records 'claude', not NULL; both mean primary.
      seed({ instanceId: 'claude' });

      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');
    });

    it('does not apply an alias instance contract to the primary instance', () => {
      seed({ cliToolId: 'codex', instanceId: 'codex-2' });

      expect(getSessionAutoYesPolicy('wt-1', 'codex')).toBeNull();
      expect(getSessionAutoYesPolicy('wt-1', 'codex', 'codex-2')?.mode).toBe('off');
    });

    it('keeps concurrent instances of one agent independent', () => {
      seed({ cliToolId: 'codex', instanceId: null, autoYes: "autoYes:\n  mode: safe\n" });
      seed({ cliToolId: 'codex', instanceId: 'codex-2', autoYes: "autoYes:\n  mode: 'off'\n" });

      expect(getSessionAutoYesPolicy('wt-1', 'codex')?.mode).toBe('safe');
      expect(getSessionAutoYesPolicy('wt-1', 'codex', 'codex-2')?.mode).toBe('off');
    });
  });

  describe('caching', () => {
    it('reads the database once within the TTL', () => {
      seed();

      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');
      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');
      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');

      expect(openedDatabases).toHaveBeenCalledTimes(1);
    });

    it('caches "no contract" too, so contract-less sessions do not poll the database', () => {
      getSessionAutoYesPolicy('wt-1', 'claude');
      getSessionAutoYesPolicy('wt-1', 'claude');

      expect(openedDatabases).toHaveBeenCalledTimes(1);
    });

    it('re-reads after the TTL expires', () => {
      vi.useFakeTimers();
      const task = seed();
      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');

      updateTaskStatus(db, task.id, 'succeeded');
      vi.advanceTimersByTime(AUTO_YES_POLICY_CACHE_TTL_MS - 1);
      expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');
      expect(openedDatabases).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(getSessionAutoYesPolicy('wt-1', 'claude')).toBeNull();
      expect(openedDatabases).toHaveBeenCalledTimes(2);
    });

    it('invalidates only the requested composite key', () => {
      seed({ cliToolId: 'claude' });
      seed({ cliToolId: 'codex' });
      getSessionAutoYesPolicy('wt-1', 'claude');
      getSessionAutoYesPolicy('wt-1', 'codex');
      expect(openedDatabases).toHaveBeenCalledTimes(2);

      invalidateSessionAutoYesPolicy('wt-1:claude');

      getSessionAutoYesPolicy('wt-1', 'codex');
      expect(openedDatabases).toHaveBeenCalledTimes(2);
      getSessionAutoYesPolicy('wt-1', 'claude');
      expect(openedDatabases).toHaveBeenCalledTimes(3);
    });
  });

  it('falls back to unconstrained behaviour when the lookup throws', () => {
    // A database failure must not suppress auto-yes: every user without a
    // contract would otherwise lose auto-answering because of an unrelated fault.
    seed();
    invalidateSessionAutoYesPolicy('wt-1:claude');
    db.close();

    expect(getSessionAutoYesPolicy('wt-1', 'claude')).toBeNull();

    // Reopen so afterEach's close() has a live handle.
    db = new Database(':memory:');
  });
});
