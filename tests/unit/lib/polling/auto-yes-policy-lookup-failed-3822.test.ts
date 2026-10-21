/**
 * Issue #3822 (its third case): a contract lookup that fails is "contract
 * unknown", not "no contract".
 *
 * Until #3822 the catch in `readPolicy` returned null — the unconstrained
 * policy — and cached it for five seconds, so one failed read let Auto-Yes
 * answer past a contract stating `mode: off` or a deny pattern. Here the lookup
 * yields `AUTO_YES_POLICY_UNKNOWN` on the answering side, which the resolver
 * withholds on; the display side still reads it as no contract (never as a
 * contract it did not see); and the failure is not cached.
 *
 * The failure is the database layer throwing (`getDbInstance` /
 * `getActiveTaskForInstance`), against a real migrated database otherwise.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
let dbOpenFailure: Error | null = null;
let taskLookupFailure: Error | null = null;
const taskLookups = vi.fn();

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    if (dbOpenFailure) throw dbOpenFailure;
    return db;
  },
}));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    getActiveTaskForInstance: (...args: Parameters<typeof actual.getActiveTaskForInstance>) => {
      taskLookups();
      if (taskLookupFailure) throw taskLookupFailure;
      return actual.getActiveTaskForInstance(...args);
    },
  };
});

import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import {
  clearAutoYesPolicyCache,
  getSessionAutoYesPolicy,
  getSessionAutoYesPolicyEntry,
  getSessionContractPolicySummary,
  isSessionAutoYesBlockedByContract,
} from '@/lib/polling/auto-yes-policy';
import {
  AUTO_YES_POLICY_UNKNOWN,
  evaluatePolicyAgainstTexts,
  isAutoYesPolicyUnknown,
  policyLookupMode,
  resolveAutoAnswerWithPolicy,
} from '@/lib/polling/auto-yes-resolver';
import type { PromptData } from '@/types/models';

const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Proceed?',
  options: ['yes', 'no'],
  status: 'pending',
};

function seedOff(): void {
  createTask(db, {
    worktreeId: 'wt-1',
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
autoYes:
  mode: 'off'
`,
      'task.yaml'
    ),
    status: 'running',
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  dbOpenFailure = null;
  taskLookupFailure = null;
  taskLookups.mockClear();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  db.close();
  clearAutoYesPolicyCache();
});

describe.each([
  ['getDbInstance throws', () => { dbOpenFailure = new Error('SQLITE_BUSY'); }],
  ['getActiveTaskForInstance throws', () => { taskLookupFailure = new Error('SQLITE_IOERR'); }],
])('[#3822] %s', (_label, fail) => {
  it('the answering lookup is unknown, not null', () => {
    seedOff();
    fail();

    const policy = getSessionAutoYesPolicy('wt-1', 'claude');
    expect(policy).not.toBeNull();
    expect(isAutoYesPolicyUnknown(policy)).toBe(true);
    expect(policyLookupMode(policy)).toBeNull();
  });

  it('the resolver withholds the answer and says the lookup failed', () => {
    seedOff();
    fail();

    expect(resolveAutoAnswerWithPolicy(YES_NO, getSessionAutoYesPolicy('wt-1', 'claude'))).toEqual({
      answer: null,
      suppressedBy: 'deny-pattern-unusable',
      policyLookupFailed: true,
    });
  });

  it('the display lookups read no contract, never a contract they did not see', () => {
    seedOff();
    fail();

    expect(getSessionAutoYesPolicyEntry('wt-1', 'claude')).toEqual({ policy: null, taskId: null });
    expect(getSessionContractPolicySummary('wt-1', 'claude')).toBeNull();
    expect(isSessionAutoYesBlockedByContract('wt-1', 'claude')).toBe(false);
  });

  it('the failure is not cached: the next lookup reads again and sees the contract', () => {
    seedOff();
    fail();
    expect(isAutoYesPolicyUnknown(getSessionAutoYesPolicy('wt-1', 'claude'))).toBe(true);

    dbOpenFailure = null;
    taskLookupFailure = null;
    expect(getSessionAutoYesPolicy('wt-1', 'claude')?.mode).toBe('off');
  });

  it('the failure is not cached: no contract after recovery answers at once', () => {
    fail();
    expect(resolveAutoAnswerWithPolicy(YES_NO, getSessionAutoYesPolicy('wt-1', 'claude')).answer).toBeNull();

    dbOpenFailure = null;
    taskLookupFailure = null;
    expect(resolveAutoAnswerWithPolicy(YES_NO, getSessionAutoYesPolicy('wt-1', 'claude')).answer).toBe('y');
  });
});

describe('[#3822] controls', () => {
  it('no contract (a lookup that succeeds and finds none) still answers', () => {
    const policy = getSessionAutoYesPolicy('wt-1', 'claude');
    expect(policy).toBeNull();
    expect(resolveAutoAnswerWithPolicy(YES_NO, policy)).toEqual({ answer: 'y', suppressedBy: null });
  });

  it('a successful lookup is still cached for the TTL', () => {
    seedOff();
    getSessionAutoYesPolicy('wt-1', 'claude');
    getSessionAutoYesPolicy('wt-1', 'claude');
    expect(taskLookups).toHaveBeenCalledTimes(1);
  });

  it('a failed lookup reads the database again on every call', () => {
    taskLookupFailure = new Error('SQLITE_IOERR');
    getSessionAutoYesPolicy('wt-1', 'claude');
    getSessionAutoYesPolicy('wt-1', 'claude');
    expect(taskLookups).toHaveBeenCalledTimes(2);
  });

  it('the hook evaluator denies an unknown policy, and allows a null one', () => {
    expect(evaluatePolicyAgainstTexts('multiple_choice', ['git status'], AUTO_YES_POLICY_UNKNOWN)).toEqual({
      reason: 'deny-pattern-unusable',
      policyLookupFailed: true,
    });
    expect(evaluatePolicyAgainstTexts('multiple_choice', ['git status'], null)).toBeNull();
  });

  it('a real policy is never read as unknown', () => {
    expect(isAutoYesPolicyUnknown({ mode: 'off', allowPromptTypes: [], denyPatterns: [] })).toBe(false);
    expect(isAutoYesPolicyUnknown(null)).toBe(false);
    expect(isAutoYesPolicyUnknown(undefined)).toBe(false);
  });
});
