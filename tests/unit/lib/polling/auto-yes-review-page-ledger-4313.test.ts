/**
 * The Auto-Yes ledger does not record a question as "answered and resolved"
 * while Command Code's Review page still holds it (Issue #4313 再指示 1).
 *
 * Auto-Yes answers a single-select `AskUserQuestion` with its digit, and
 * Command Code then draws the Review page (`❯ 1. Submit` / `2. Cancel`). The
 * answers are not sent until a human confirms that page (#3497: Auto-Yes never
 * does). The poller reads the page as no prompt, so `endLedgerTick` used to
 * close the question's entry on that very tick as `resolved-after-answer`.
 *
 * Pinned on the 1.54.1 live captures; 1.88.2 is not captured (UAT).
 *
 *  1. question → Review → Review: no `closed` line while the page is up;
 *  2. 陰性対照: once the page is gone (the answer really went through), the
 *     entry closes as before — `resolved-after-answer`;
 *  3. 陰性対照: Auto-Yes still sends no key on the Review page.
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

import {
  detectAndRespondToPrompt,
  clearAllPollerStates,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { upsertWorktree } from '@/lib/db';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';

const WT = 'wt-4313-ledger';
const INSTANCE = 'command-code';
const DIR = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2754');
const fixture = (name: string): string => readFileSync(path.join(DIR, `${name}.txt`), 'utf8');

const QUESTION = fixture('singleselect-initial-unanswered-tabs');
const REVIEW = fixture('review-page-submit-cancel');
/** The pane once the page is gone: the agent carrying on, no dialog on it. */
const AFTER = ['# Command Code v1.54.1', '', '⠶ Updating calc.js', ''].join('\n');

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
function tickOn(raw: string, state: AutoYesPollerState): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, 'command-code', clean, clean.split('\n'), INSTANCE, raw);
}

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'cc-4313-ledger',
    path: '/tmp/cc-4313-ledger',
    branch: 'fix/4313',
    repositoryPath: '/tmp/cc-4313-ledger-repo',
    repositoryName: 'cc-4313-ledger-repo',
    cliToolId: 'command-code',
  });
  vi.clearAllMocks();
  mockLogger.withContext.mockReturnValue(mockLogger);
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  sendPromptAnswer.mockImplementation(async () => {});
});

afterEach(() => {
  clearAllPollerStates();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

describe('[#4313 再指示 1] the ledger while the Review page is up', () => {
  it('question → Review → Review: the answered question is not closed as resolved', async () => {
    const state = pollerState();
    expect(await tickOn(QUESTION, state)).toBe('responded');
    expect(lines(EV.opened)).toHaveLength(1);

    expect(await tickOn(REVIEW, state)).toBe('no_prompt');
    expect(await tickOn(REVIEW, state)).toBe('no_prompt');

    expect(lines(EV.closed)).toEqual([]);
    // 陰性対照: and Auto-Yes typed nothing at the page.
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('陰性対照: once the page is gone the entry closes as before (resolved-after-answer)', async () => {
    const state = pollerState();
    await tickOn(QUESTION, state);
    await tickOn(REVIEW, state);
    expect(await tickOn(AFTER, state)).toBe('no_prompt');

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ cliToolId: 'command-code', resolution: 'resolved-after-answer', answeredAtClose: true }),
    ]);
  });

  it('陰性対照: without the Review page the answered question closes on the next tick, as before', async () => {
    const state = pollerState();
    await tickOn(QUESTION, state);
    await tickOn(AFTER, state);

    expect(lines(EV.closed)).toEqual([
      expect.objectContaining({ resolution: 'resolved-after-answer' }),
    ]);
  });

  it('the Review page with no answered question before it opens no entry', async () => {
    const state = pollerState();
    await tickOn(REVIEW, state);
    await tickOn(AFTER, state);

    expect(lines(EV.opened)).toEqual([]);
    expect(lines(EV.closed)).toEqual([]);
  });
});
