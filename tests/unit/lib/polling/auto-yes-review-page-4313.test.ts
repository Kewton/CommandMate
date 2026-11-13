/**
 * Auto-Yes still leaves Command Code's Review page to a human (Issue #4313 (b)).
 *
 * #4313 lets `/prompt-response` confirm the Review page (`❯ 1. Submit` /
 * `2. Cancel` / `← to go back and edit`) for a human. Auto-Yes must not: the
 * #3497 decision stands — `Submit` commits whatever stands as the answers, and
 * an Auto-Yes `1` there would present the worker's own recommendation as the
 * human's approval.
 *
 * 陰性対照: the single-select question one screen earlier is still answered
 * with its default digit, exactly as before.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) =>
    sendPromptAnswer(params as { answer: string; promptData?: PromptData }),
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
      getTool: () => ({
        name: 'Command Code',
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? 'command-code'}`,
      }),
    }),
  },
}));

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...(args as [])),
    error: vi.fn(),
  }),
}));

import {
  detectAndRespondToPrompt,
  clearAllPollerStates,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { upsertWorktree } from '@/lib/db';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  clearPolicySuppressions,
} from '@/lib/polling/auto-yes-suppression-state';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';

const WT = 'wt-4313-autoyes';
const INSTANCE = 'command-code';
const FIXTURES = path.resolve(__dirname, '../../../fixtures');

function fixture(dir: string, file: string): string {
  return readFileSync(path.join(FIXTURES, dir, file), 'utf8');
}

const REVIEW = fixture('command-code-askuserquestion-2754', 'review-page-submit-cancel.txt');
const SINGLE_SELECT_2754 = fixture(
  'command-code-askuserquestion-2754',
  'singleselect-initial-unanswered-tabs.txt',
);

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'command-code',
    instanceId: INSTANCE,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick of the poller on `raw`, spelled the way `capturePollerFrame` hands it over. */
function respondTo(raw: string, state: AutoYesPollerState = pollerState()): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(
    WT,
    state,
    'command-code',
    clean,
    clean.split('\n'),
    INSTANCE,
    raw,
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'cc-4313',
    path: '/tmp/cc-4313',
    branch: 'fix/4313',
    repositoryPath: '/tmp/cc-4313-repo',
    repositoryName: 'cc-4313-repo',
    cliToolId: 'command-code',
  });
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  sendPromptAnswer.mockClear();
  warn.mockClear();
});

afterEach(() => {
  db.close();
});

describe('[#4313] Auto-Yes on the Review page', () => {
  it('sends no key, on the first tick and on the next', async () => {
    const state = pollerState();
    expect(await respondTo(REVIEW, state)).not.toBe('responded');
    expect(await respondTo(REVIEW, state)).not.toBe('responded');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('陰性対照: the single-select question before it is answered `1` as before', async () => {
    expect(await respondTo(SINGLE_SELECT_2754)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });
});
