/**
 * A send that failed with keys already on the pane is not typed again
 * (Issue #3839).
 *
 * A tick that keeps its generation and whose send throws after a key reached
 * the pane records the partial answer, as a tick that lost its generation does
 * (#3706): the next tick withholds the same screen (step 2.5) and hands it to a
 * human. The screen leaving, or another confirmation coming up, forgets it
 * (`forgetPartialAnswer`), so the next confirmation is answered.
 *
 * Drives the real `detectAndRespondToPrompt` (one call per tick, as in
 * `auto-yes-poller-confirmation-ledger-3820.test.ts`) and the real
 * `sendPromptAnswer`; the screen reading and the tmux module are stubbed.
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

/** Every key that reached the pane, in order. */
let delivered: string[] = [];
/** The next `sendKeys` failure, consumed once: the typed text, its Enter, or a given error. */
let failNext: 'text' | 'enter' | Error | null = null;
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    const fail = failNext;
    if (fail instanceof Error) {
      failNext = null;
      throw fail;
    }
    if (fail === (enter ? 'enter' : 'text')) {
      failNext = null;
      throw new Error('tmux send-keys failed');
    }
    delivered.push(enter ? `${keys}<Enter>` : keys);
  }),
  sendSpecialKeys: vi.fn(async (_session: string, keys: string[]) => {
    delivered.push(...keys);
  }),
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
      getTool: (tool: string) => ({ getSessionName: (id: string) => `cm-${id}-${tool}`, name: tool }),
    }),
  },
}));

/** What the reading returns this tick. */
const screen = vi.hoisted(() => ({ prompt: null as unknown }));
vi.mock('@/lib/polling/response-checker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/response-checker')>()),
  detectPromptOnCleanFrame: () =>
    screen.prompt === null ? { isPrompt: false } : { isPrompt: true, promptData: screen.prompt },
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
  clearAllPollerStates,
  detectAndRespondToPrompt,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { MultiSelectAnswerRejectedError } from '@/lib/prompt-answer-sender';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WORKTREE_ID = 'wt-3839';
const T0 = new Date('2026-10-23T10:00:00.000Z').getTime();

let now = T0;

/** The same question, two different commands (`approvalTarget`). */
const proceed = (command: string): PromptData => ({
  type: 'yes_no',
  question: 'Do you want to proceed?',
  status: 'pending',
  options: ['yes', 'no'],
  approvalTarget: command,
});

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick over a pane whose reading is given; ticks are 2 seconds apart. */
async function tickOn(state: AutoYesPollerState, prompt: PromptData | null): Promise<string> {
  screen.prompt = prompt;
  const result = await detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', 'pane', ['pane'], 'claude');
  now += 2_000;
  return result;
}

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  delivered = [];
  failNext = null;
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  mockLogger.info.mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

describe('[#3839] A: a failure that says keysSent: true, in a tick that kept its generation', () => {
  it('the next ticks do not answer the same screen', async () => {
    failNext = new MultiSelectAnswerRejectedError('recapture-failed', true, [1]);
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');

    expect(delivered).toEqual([]);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'partial' })]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'partial-answer' })]);
  });

  it('negative: a failure that says keysSent: false leaves the next tick free to answer', async () => {
    failNext = new MultiSelectAnswerRejectedError('recapture-failed', false, [1]);
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');

    expect(delivered).toEqual(['y', '<Enter>']);
    expect(lines(EV.attemptSettled).map((line) => line.result)).toEqual(['no-keys-sent', 'ok']);
  });
});

describe('[#3839] B: the Enter after the typed answer fails', () => {
  it('is a partial answer: the next ticks do not type `y` again over it', async () => {
    failNext = 'enter';
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');

    // Not `yy` + Enter.
    expect(delivered).toEqual(['y']);
    // #3820: counted as partial — keysSent went from null to true.
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'partial' })]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'partial-answer' })]);
  });

  it('negative: a failure typing the text itself is still failed, and the next tick answers', async () => {
    failNext = 'text';
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');

    expect(delivered).toEqual(['y', '<Enter>']);
    expect(lines(EV.attemptSettled).map((line) => line.result)).toEqual(['failed', 'ok']);
  });
});

describe('[#3839] the memory goes with the screen (forgetPartialAnswer)', () => {
  it('once the prompt left the screen, its return is answered', async () => {
    failNext = 'enter';
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    expect(await tickOn(state, null)).toBe('no_prompt');
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');

    expect(delivered).toEqual(['y', 'y', '<Enter>']);
  });

  it('another confirmation on screen is answered', async () => {
    failNext = 'enter';
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    expect(await tickOn(state, proceed('npm run build'))).toBe('responded');

    expect(delivered).toEqual(['y', 'y', '<Enter>']);
  });
});
