/**
 * Auto-Yes leaves Command Code's `AskUserQuestion` confirm page to a human
 * (Issue #3497).
 *
 * Kewton/Musunest#283: a worker asked a free-text question whose answer was its
 * own proposal, on a page drawn as `❯ 1. Submit` / `2. Cancel`. Auto-Yes sent
 * `1` and the worker implemented the proposal as if a human had approved it.
 *
 * (a) the confirm page gets no key, and the suppression is recorded through the
 *     #1684 channel so `capture --json` / `cmate wait` can name it;
 * (b) 陰性対照: an ordinary question screen, and a yes/no prompt, are answered as
 *     before.
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
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME } from '@tests/fixtures/command-code-askuserquestion-3497/free-text-confirm';

const WT = 'wt-3497-autoyes';
const INSTANCE = 'command-code';
const FIXTURES = path.resolve(__dirname, '../../../fixtures');

function fixture(dir: string, file: string): string {
  return readFileSync(path.join(FIXTURES, dir, file), 'utf8');
}

const NO_BACK_HINT = fixture('command-code-askuserquestion-3497', 'review-page-no-back-hint.txt');
const FREE_TEXT_CONFIRM = COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME;
const REPORTED_2521 = fixture(
  'command-code-askuserquestion-2521',
  'askuserquestion-wrapped-1530-200x1000.txt',
);
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

function skipWarnings(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .filter(([event]) => event === 'poller:auto-yes-skipped-question-confirm')
    .map(([, data]) => data as Record<string, unknown>);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'cc-3497',
    path: '/tmp/cc-3497',
    branch: 'fix/3497',
    repositoryPath: '/tmp/cc-3497-repo',
    repositoryName: 'cc-3497-repo',
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

describe('[#3497] (a) the confirm page is not Auto-Yes’s to answer', () => {
  it.each([
    ['the Review page without its back hint', NO_BACK_HINT],
    ['a free-text question drawn as Submit / Cancel', FREE_TEXT_CONFIRM],
  ])('%s: no key is sent', async (_name, raw) => {
    expect(await respondTo(raw)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('records why, through the suppression channel', async () => {
    await respondTo(FREE_TEXT_CONFIRM);
    // Issue #3748: its own reason (was `unclassified-frame`, whose `cmate wait`
    // wording says no detector recognised the frame).
    expect(getLastPolicySuppression(WT, 'command-code', INSTANCE)).toMatchObject({
      reason: 'question-confirm-page',
      mode: null,
      promptType: 'multiple_choice',
    });
  });

  it('logs the question and the options it left alone, once per frame', async () => {
    const state = pollerState();
    expect(await respondTo(FREE_TEXT_CONFIRM, state)).toBe('no_answer');
    expect(await respondTo(FREE_TEXT_CONFIRM, state)).toBe('no_answer');
    const warnings = skipWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      worktreeId: WT,
      cliToolId: 'command-code',
      instanceId: INSTANCE,
      promptType: 'multiple_choice',
      options: ['1. Submit', '2. Cancel'],
    });
    expect(String(warnings[0].question)).toContain('Should I move it into the queue worker');
  });
});

describe('[#3497] (b) 陰性対照: ordinary prompts are answered as before', () => {
  it.each([
    ['#2521 question screen (1.53.0)', REPORTED_2521],
    ['#2754 single-select question (1.54.1)', SINGLE_SELECT_2754],
  ])('%s: sends the default `1`', async (_name, raw) => {
    expect(await respondTo(raw)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
    expect(skipWarnings()).toEqual([]);
  });

  it('a yes/no prompt is answered `y`', async () => {
    const raw = ['Working on the change.', '', 'Do you want to proceed? (y/n)', ''].join('\n');
    expect(await respondTo(raw)).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('y');
    expect(skipWarnings()).toEqual([]);
  });
});
