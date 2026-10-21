/**
 * Issue #3822 (its third case): the Auto-Yes poller sends no keystroke while
 * the contract lookup fails, and answers again from the next tick once it
 * succeeds.
 *
 * Both answering exits of `detectAndRespondToPrompt` are driven: step 4
 * (`resolveAnswerUnderPolicy` in `polling/auto-yes-poller-steps`, over a real
 * Claude permission frame) and the Enter fallback's own policy step (#3397,
 * over a numbered list no detector reads). The failure is the database layer
 * throwing; everything else is a real migrated database, as in
 * `auto-yes-poller-policy.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

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

const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...args: unknown[]) => sendPromptAnswer(...(args as [])),
}));
const sendSpecialKeys = vi.fn(async (_session: string, _keys: string[]) => {});
vi.mock('@/lib/tmux/tmux', () => ({
  sendSpecialKeys: (session: string, keys: string[]) => sendSpecialKeys(session, keys),
}));

let lastTickRaw = '';
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => ''),
  captureSessionOutputFresh: vi.fn(async () => lastTickRaw),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? id}`,
      }),
    }),
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
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { AUTO_YES_ENTER_FALLBACK_ENV_VAR, clearEnterFallbacks } from '@/lib/polling/auto-yes-enter-fallback';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { POLLING_INTERVAL_MS } from '@/lib/auto-yes-state';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';

const WORKTREE_ID = 'wt-3822';
const FRAME = buildClaude1000RowPermissionFrame();

/** A numbered list under a `❯` cursor that no detector reads: the Enter fallback's screen (#3397). */
const UNRECOGNISED_LIST = [
  '⏺ Pick one',
  '',
  '❯ 1. On-premises deployment',
  '  2. Cloud-managed platform',
  '  3. Kubernetes',
  '',
  '  Which one?',
].join('\n');

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick of step 4 over the permission frame. */
function tick(state: AutoYesPollerState): Promise<string> {
  return detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', FRAME);
}

/** One tick over `raw` with the raw capture, as the Enter fallback needs it. */
function rawTick(state: AutoYesPollerState, raw: string): Promise<string> {
  lastTickRaw = raw;
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', clean, clean.split('\n'), undefined, raw);
}

function seedTask(autoYes: string): void {
  createTask(db, {
    worktreeId: WORKTREE_ID,
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

function suppressionWarnings(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .filter(([action]) => action === 'poller:auto-yes-suppressed-by-policy')
    .map(([, data]) => data as Record<string, unknown>);
}

const enterCalls = () => sendSpecialKeys.mock.calls.filter(([, keys]) => keys.length === 1 && keys[0] === 'Enter');

const originalEnv = process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  dbOpenFailure = null;
  taskLookupFailure = null;
  lastTickRaw = '';
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearEnterFallbacks();
  sendPromptAnswer.mockClear();
  sendSpecialKeys.mockClear();
  warn.mockClear();
  delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
});

afterEach(() => {
  db.close();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  clearEnterFallbacks();
  if (originalEnv === undefined) delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
  else process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = originalEnv;
});

const FAILURES = [
  ['getDbInstance throws', () => { dbOpenFailure = new Error('SQLITE_BUSY'); }],
  ['getActiveTaskForInstance throws', () => { taskLookupFailure = new Error('SQLITE_IOERR'); }],
] as const;

function recover(): void {
  dbOpenFailure = null;
  taskLookupFailure = null;
}

describe.each(FAILURES)('[#3822] step 4, %s', (_label, fail) => {
  it('sends no keystroke and records that the lookup failed', async () => {
    seedTask("autoYes:\n  mode: 'off'\n");
    fail();

    expect(await tick(pollerState())).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')).toMatchObject({
      reason: 'deny-pattern-unusable',
      mode: null,
      promptType: 'multiple_choice',
      policyLookupFailed: true,
    });
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')?.pattern).toBeUndefined();
    expect(suppressionWarnings()).toEqual([
      expect.objectContaining({ reason: 'deny-pattern-unusable', mode: null, policyLookupFailed: true }),
    ]);
  });

  it('sends no keystroke even with no contract, since none is known', async () => {
    fail();

    expect(await tick(pollerState())).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('answers from the next tick once the lookup succeeds (no contract)', async () => {
    const state = pollerState();
    fail();
    expect(await tick(state)).toBe('no_answer');

    recover();
    expect(await tick(state)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it("follows the contract from the next tick once the lookup succeeds (mode: 'off')", async () => {
    seedTask("autoYes:\n  mode: 'off'\n");
    const state = pollerState();
    fail();
    expect(await tick(state)).toBe('no_answer');

    recover();
    expect(await tick(state)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')).toMatchObject({ reason: 'mode-off', mode: 'off' });
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')?.policyLookupFailed).toBeUndefined();
  });
});

describe.each(FAILURES)('[#3822] the Enter fallback, %s', (_label, fail) => {
  it('sends no Enter and records that the lookup failed', async () => {
    const state = pollerState();
    fail();
    for (let i = 0; i < 3; i++) expect(await rawTick(state, UNRECOGNISED_LIST)).toBe('no_answer');

    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')).toMatchObject({
      reason: 'deny-pattern-unusable',
      policyLookupFailed: true,
    });
    expect(suppressionWarnings()).toEqual([
      expect.objectContaining({ policyLookupFailed: true, enterFallback: true }),
    ]);
  });

  it('sends the Enter once the lookup succeeds', async () => {
    const state = pollerState();
    fail();
    await rawTick(state, UNRECOGNISED_LIST);

    recover();
    expect(await rawTick(state, UNRECOGNISED_LIST)).toBe('no_answer');
    expect(await rawTick(state, UNRECOGNISED_LIST)).toBe('responded');
    expect(enterCalls()).toHaveLength(1);
  });
});

describe('[#3822] controls: a lookup that succeeds behaves as before', () => {
  it('no contract: answers', async () => {
    expect(await tick(pollerState())).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(suppressionWarnings()).toHaveLength(0);
  });

  it("mode: 'off': no keystroke, reason mode-off", async () => {
    seedTask("autoYes:\n  mode: 'off'\n");
    expect(await tick(pollerState())).toBe('no_answer');
    expect(suppressionWarnings()).toEqual([expect.objectContaining({ reason: 'mode-off', mode: 'off' })]);
    expect(suppressionWarnings()[0]).not.toHaveProperty('policyLookupFailed');
  });

  it('a deny pattern that matches: no keystroke, reason deny-pattern', async () => {
    seedTask("autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n  denyPatterns: ['useVirtualKeyboard']\n");
    expect(await tick(pollerState())).toBe('no_answer');
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude')).toMatchObject({
      reason: 'deny-pattern',
      pattern: 'useVirtualKeyboard',
    });
  });

  it('allow-listed with no matching deny pattern: answers', async () => {
    seedTask("autoYes:\n  mode: allow-listed\n  allowPromptTypes: [multiple_choice]\n  denyPatterns: ['^never-matches$']\n");
    expect(await tick(pollerState())).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('the Enter fallback with no contract: one Enter on the second tick', async () => {
    const state = pollerState();
    expect(await rawTick(state, UNRECOGNISED_LIST)).toBe('no_answer');
    expect(await rawTick(state, UNRECOGNISED_LIST)).toBe('responded');
    expect(enterCalls()).toHaveLength(1);
  });
});
