/**
 * Issue #3822 (its third case): the `PermissionRequest` hook does not `allow`
 * while the contract lookup fails.
 *
 * The hook's `allow` runs the command without a dialog, so a lookup that throws
 * must end where every other uncertain branch ends — no decision, which the
 * route turns into the source's abstain body and the agent into its ordinary
 * approval dialog — with the reason recorded. Driven through the production
 * policy source (`getSessionAutoYesPolicy` over a real migrated database), not
 * `deps.readPolicy`, with the database layer made to throw.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
let dbOpenFailure: Error | null = null;
let taskLookupFailure: Error | null = null;

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
      if (taskLookupFailure) throw taskLookupFailure;
      return actual.getActiveTaskForInstance(...args);
    },
  };
});

/** The allow audit row; recorded here so the test does not depend on the database being up. */
const created: Array<Record<string, unknown>> = [];
vi.mock('@/lib/db/chat-db', () => ({
  createMessage: (_db: unknown, message: Record<string, unknown>) => {
    created.push(message);
    return { id: 'msg-1', ...message };
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const self: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => warn(...args),
      error: vi.fn(),
    };
    self.withContext = () => self;
    return self;
  },
}));

import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { parsePermissionRequestPayload, type PermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import {
  decidePermissionRequest,
  resolvePermissionRequest,
  type PermissionRequestSession,
} from '@/lib/hooks/permission-decision-service';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';

const SESSION: PermissionRequestSession = { worktreeId: 'wt-3822', cliToolId: 'claude', instanceId: 'claude' };
const ONE_HOUR_MS = 3_600_000;

function bash(command: string): PermissionRequestPayload {
  const parsed = parsePermissionRequestPayload({
    session_id: 's-3822',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command, description: 'run a command' },
  });
  if (!parsed) throw new Error('payload failed to parse');
  return parsed;
}

function seedTask(autoYes: string): void {
  createTask(db, {
    worktreeId: SESSION.worktreeId,
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYes}`,
      'task.yaml'
    ),
    status: 'running',
  });
}

function recover(): void {
  dbOpenFailure = null;
  taskLookupFailure = null;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  recover();
  created.length = 0;
  warn.mockClear();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  setAutoYesEnabled(SESSION.worktreeId, SESSION.cliToolId, true, ONE_HOUR_MS);
});

afterEach(() => {
  db.close();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  clearAgentStopEvents();
});

describe.each([
  ['getDbInstance throws', () => { dbOpenFailure = new Error('SQLITE_BUSY'); }],
  ['getActiveTaskForInstance throws', () => { taskLookupFailure = new Error('SQLITE_IOERR'); }],
])('[#3822] %s', (_label, fail) => {
  it('makes no decision instead of allowing', () => {
    seedTask("autoYes:\n  mode: 'off'\n");
    fail();

    expect(decidePermissionRequest(SESSION, bash('rm -rf build'))).toEqual({
      behavior: null,
      reason: 'policy-suppressed',
      suppressedBy: 'deny-pattern-unusable',
      pattern: undefined,
      mode: null,
      policyLookupFailed: true,
    });
  });

  it('makes no decision even with no contract, since none is known', () => {
    fail();

    expect(decidePermissionRequest(SESSION, bash('git status')).behavior).toBeNull();
  });

  it('records why, and writes no allow audit row', () => {
    fail();

    expect(resolvePermissionRequest(SESSION, bash('git status')).behavior).toBeNull();
    expect(getLastPolicySuppression(SESSION.worktreeId, SESSION.cliToolId, SESSION.instanceId)).toMatchObject({
      reason: 'deny-pattern-unusable',
      mode: null,
      promptType: 'multiple_choice',
      policyLookupFailed: true,
    });
    expect(warn).toHaveBeenCalledWith(
      'permission-request:suppressed-by-policy',
      expect.objectContaining({ reason: 'deny-pattern-unusable', policyLookupFailed: true })
    );
    expect(created).toHaveLength(0);
  });

  it('allows on the next request once the lookup succeeds (no contract)', () => {
    fail();
    expect(decidePermissionRequest(SESSION, bash('git status')).behavior).toBeNull();

    recover();
    expect(decidePermissionRequest(SESSION, bash('git status'))).toMatchObject({ behavior: 'allow', reason: 'auto-yes' });
  });

  it("follows the contract once the lookup succeeds (mode: 'off')", () => {
    seedTask("autoYes:\n  mode: 'off'\n");
    fail();
    decidePermissionRequest(SESSION, bash('git status'));

    recover();
    const decision = decidePermissionRequest(SESSION, bash('git status'));
    expect(decision).toMatchObject({ behavior: null, suppressedBy: 'mode-off', mode: 'off' });
    expect(decision).not.toHaveProperty('policyLookupFailed');
  });
});

describe('[#3822] controls: a lookup that succeeds behaves as before', () => {
  it('no contract: allow', () => {
    expect(resolvePermissionRequest(SESSION, bash('git status'))).toEqual({
      behavior: 'allow',
      reason: 'auto-yes',
      mode: null,
    });
    expect(created).toHaveLength(1);
  });

  it("mode: 'off': no decision, mode-off", () => {
    seedTask("autoYes:\n  mode: 'off'\n");
    expect(decidePermissionRequest(SESSION, bash('git status'))).toEqual({
      behavior: null,
      reason: 'policy-suppressed',
      suppressedBy: 'mode-off',
      pattern: undefined,
      mode: 'off',
    });
  });

  it('a matching deny pattern: no decision, deny-pattern', () => {
    seedTask("autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n  denyPatterns: ['rm -rf']\n");
    expect(decidePermissionRequest(SESSION, bash('rm -rf build'))).toMatchObject({
      behavior: null,
      suppressedBy: 'deny-pattern',
      pattern: 'rm -rf',
    });
  });

  it('allow-listed multiple_choice with no matching deny pattern: allow', () => {
    seedTask("autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n  denyPatterns: ['rm -rf']\n");
    expect(decidePermissionRequest(SESSION, bash('git status'))).toEqual({
      behavior: 'allow',
      reason: 'auto-yes',
      mode: 'allow-listed',
    });
  });
});
