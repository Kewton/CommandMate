/**
 * `antigravity-autoyes-withheld-by-policy` blames the contract only for what
 * the contract actually withheld (Issue #3724, review round 1).
 *
 * The line is written when a receipt-gated agy dialog is still on the pane past
 * the receipt window. Two things must hold for it:
 *
 *  1. The verdict is the poller's own — `resolveAutoAnswerWithPolicy`, base rules
 *     first and the contract after. A prompt the base rules never answer (a
 *     checkbox, an option that needs typing) would stay unanswered under any
 *     contract, so it is not the contract's doing.
 *  2. `reason` / `mode` and `taskId` come from one lookup: a cache that expires
 *     between two reads must not pair one task's verdict with another's id.
 *
 * Unlike `auto-yes-poller-antigravity-receipt-2857.test.ts`, the screen reading
 * is stubbed here: agy fixtures do not produce a checkbox, and what is under
 * test is the poller's judgement of a reading, not the reading. The stub keeps
 * the one property the poller relies on — with `receiptScope` the dialog is
 * withheld, without it the same frame is a prompt.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `cm-${id}-antigravity`, name: 'Antigravity' }),
    }),
  },
}));

/** What the ungated reading returns; the gated one is always withheld. */
const screen = vi.hoisted(() => ({ prompt: null as unknown }));
vi.mock('@/lib/polling/response-checker', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/polling/response-checker')>()),
  detectPromptOnCleanFrame: (
    _clean: string,
    _tool: string,
    _lines?: string[],
    _raw?: string,
    receiptScope?: unknown,
  ) => (receiptScope === undefined ? { isPrompt: true, promptData: screen.prompt } : { isPrompt: false }),
}));

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { createTask, type Task } from '@/lib/db';
// Fixtures place a task in a state directly; production writes go through applyTaskEvent.
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import {
  AUTO_YES_POLICY_CACHE_TTL_MS,
  clearAutoYesPolicyCache,
  getSessionAutoYesPolicy,
} from '@/lib/polling/auto-yes-policy';

const WORKTREE_ID = 'wt-3724';
const T0 = new Date('2026-10-16T10:00:00.000Z').getTime();
const BY_POLICY_LOG = 'antigravity-autoyes-withheld-by-policy';
const NO_RECEIPT_LOG = 'antigravity-autoyes-withheld-no-hook-receipt';

/** A single-select approval: the base rules answer it with the default, `1`. */
const SINGLE: PromptData = {
  type: 'multiple_choice',
  question: 'Allow this command?',
  status: 'pending',
  options: [
    { number: 1, label: 'Allow once', isDefault: true },
    { number: 2, label: 'Deny', isDefault: false },
  ],
};

/** The same question as a checkbox (#2755): the base rules never answer it. */
const CHECKBOX: PromptData = {
  type: 'multiple_choice',
  question: 'Which files should I update?',
  status: 'pending',
  multiSelect: true,
  options: [
    { number: 1, label: 'calc.js', isDefault: true, checked: false },
    { number: 2, label: 'README.md', isDefault: false, checked: true },
  ],
};

/** A default option that needs typing: the base rules have nothing to send. */
const TYPED: PromptData = {
  type: 'multiple_choice',
  question: 'What should I name it?',
  status: 'pending',
  options: [{ number: 1, label: 'Type something...', isDefault: true, requiresTextInput: true }],
};

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

function seedContract(autoYes: string): Task {
  return createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'antigravity',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
${autoYes}`,
      'task.yaml',
    ),
    status: 'running',
  });
}

/** One tick of the poller over a pane whose (ungated) reading is `prompt`. */
async function tick(prompt: PromptData): Promise<string> {
  screen.prompt = prompt;
  return detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'antigravity', 'pane', ['pane'], 'antigravity');
}

const linesNamed = (name: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([n]) => n === name).map(([, fields]) => fields as Record<string, unknown>);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(T0);
  clearAllPollerStates();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  db.close();
});

describe('[#3724] withheld-by-policy follows the poller verdict: base rules, then the contract', () => {
  it('is written under `mode: off` for a prompt the base rules would answer', async () => {
    const task = seedContract("autoYes:\n  mode: 'off'\n");

    expect(await tick(SINGLE)).toBe('no_prompt');

    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(linesNamed(BY_POLICY_LOG)).toEqual([
      expect.objectContaining({ reason: 'mode-off', mode: 'off', taskId: task.id }),
    ]);
    expect(linesNamed(NO_RECEIPT_LOG)).toHaveLength(0);
  });

  it('is not written for a checkbox under the same contract: no contract would make it answerable', async () => {
    seedContract("autoYes:\n  mode: 'off'\n");

    await tick(CHECKBOX);

    expect(linesNamed(BY_POLICY_LOG)).toHaveLength(0);
    // Handled as with no contract: the receipt line, as before #3724.
    expect(linesNamed(NO_RECEIPT_LOG)).toHaveLength(1);
  });

  it('is not written for an option that needs typing under the same contract', async () => {
    seedContract("autoYes:\n  mode: 'off'\n");

    await tick(TYPED);

    expect(linesNamed(BY_POLICY_LOG)).toHaveLength(0);
    expect(linesNamed(NO_RECEIPT_LOG)).toHaveLength(1);
  });
});

describe('[#3724] reason, mode and taskId come from one lookup', () => {
  it('does not pair the cached task verdict with the next task id when the cache expires mid-line', async () => {
    // Task A (mode off) is read into the cache, then replaced by task B (safe).
    const a = seedContract("autoYes:\n  mode: 'off'\n");
    expect(getSessionAutoYesPolicy(WORKTREE_ID, 'antigravity')?.mode).toBe('off');
    updateTaskStatus(db, a.id, 'succeeded');
    const b = seedContract("autoYes:\n  mode: safe\n");

    // A clock that stands one millisecond short of the cache expiry for the
    // first read the policy module makes, and past it for every read after.
    // Two lookups in one line would see A, then B.
    let policyReads = 0;
    vi.mocked(Date.now).mockImplementation(() => {
      if (!/auto-yes-policy/.test(new Error().stack ?? '')) return T0 + AUTO_YES_POLICY_CACHE_TTL_MS - 1;
      policyReads += 1;
      return policyReads === 1 ? T0 + AUTO_YES_POLICY_CACHE_TTL_MS - 1 : T0 + AUTO_YES_POLICY_CACHE_TTL_MS + 1;
    });

    await tick(SINGLE);

    const [line] = linesNamed(BY_POLICY_LOG);
    expect(line).toEqual(expect.objectContaining({ reason: 'mode-off', mode: 'off', taskId: a.id }));
    expect(line.taskId).not.toBe(b.id);
  });
});
