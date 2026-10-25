/**
 * An answer whose send ended with its outcome unknown is not sent again
 * (Issue #3880).
 *
 * A tmux call that timed out after its key landed (`TmuxSendError` with
 * `delivery: 'indeterminate'`) says no key is KNOWN to be on the pane, yet the
 * key may be there. The tick holds it as #3839 holds a failure with keys on the
 * pane: the next tick withholds the same confirmation (step 2.5) instead of
 * typing `y` again over it. The ledger (#3820) still counts the attempt
 * `failed` — "may or may not be on the pane" — not `partial`. A refusal before
 * any key (`not-started`) is free to be sent again, and the hold is not for
 * ever: the screen changing, the session being relaunched, or a person's
 * answer going through releases it (its start alone does not).
 *
 * Drives the real `detectAndRespondToPrompt` and `sendPromptAnswer`, as
 * `auto-yes-poller-failed-send-3839.test.ts` does; the screen reading and the
 * tmux module are stubbed.
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

/** Every key that reached the pane, in order (a key that landed and then timed out included). */
let delivered: string[] = [];
/**
 * The next `sendKeys` failure, consumed once (Issue #3880): the typed text or
 * its Enter, failing the way the real tmux module reports it (`TmuxSendError`).
 * `indeterminate`: the key landed and the call timed out; `not-started`: tmux
 * refused it before any key.
 */
let failNext: { at: 'text' | 'enter'; delivery: 'not-started' | 'indeterminate' } | null = null;
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    const key = enter ? `${keys}<Enter>` : keys;
    const fail = failNext;
    if (fail !== null && fail.at === (enter ? 'enter' : 'text')) {
      failNext = null;
      if (fail.delivery === 'indeterminate') delivered.push(key);
      throw Object.assign(new Error('Failed to send keys to tmux session: Command failed'), {
        name: 'TmuxSendError',
        delivery: fail.delivery,
        keysDelivered: 0,
      });
    }
    delivered.push(key);
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
import {
  noteManualAnswerStarted,
  clearManualAnswers,
  MANUAL_ANSWER_HOLD_MS,
  settleManualAnswer,
} from '@/lib/polling/auto-yes-manual-answer';
import { beginEnterFallbackSession } from '@/lib/polling/auto-yes-enter-fallback-state';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WORKTREE_ID = 'wt-3880';
const T0 = new Date('2026-10-24T10:00:00.000Z').getTime();

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


/**
 * Issue #3822: an enforce tool's dialog gate refuses a `(y/n)` its own rules do
 * not vouch for, so the typed-answer path this file exercises (`y`, a wait,
 * Enter) is reached on claude only under the kill switch's `legacy` — the
 * setting an operator restores it with. What is pinned here is the send, not
 * the gate (the gate's refusal: `auto-yes-generic-yes-no-3822.test.ts`).
 */
const ORIGINAL_DIALOG_GATE_ENV = process.env.CM_AUTOYES_DIALOG_GATE;

beforeEach(() => {
  process.env.CM_AUTOYES_DIALOG_GATE = 'claude=legacy';
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  delivered = [];
  failNext = null;
  clearAllPollerStates();
  clearManualAnswers();
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
  if (ORIGINAL_DIALOG_GATE_ENV === undefined) delete process.env.CM_AUTOYES_DIALOG_GATE;
  else process.env.CM_AUTOYES_DIALOG_GATE = ORIGINAL_DIALOG_GATE_ENV;
  vi.restoreAllMocks();
  clearAllPollerStates();
  clearManualAnswers();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

const COMPOSITE_KEY = buildCompositeKey(WORKTREE_ID, 'claude', 'claude');

describe('[#3880] the typed answer times out after landing (indeterminate)', () => {
  it('the next ticks do not type `y` again at the same confirmation', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');

    // Not `yy` + Enter.
    expect(delivered).toEqual(['y']);
    // #3820: no key is known to be there — `failed` ("whether keys reached the
    // pane is not known"), not `partial`; its interval stays open while held.
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect(lines(EV.withholdStarted)).toEqual([expect.objectContaining({ reason: 'send-failed' })]);
    // Step 2.5 is what withholds it on the next ticks.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'poller:auto-yes-skipped-partial-answer',
      expect.objectContaining({ worktreeId: WORKTREE_ID }),
    );
  });

  it('the Enter times out after the text: held, counted partial (#3839)', async () => {
    failNext = { at: 'enter', delivery: 'indeterminate' };
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');

    expect(delivered).toEqual(['y', '<Enter>']);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'partial' })]);
  });

  it('negative: tmux refused the text before any key: the next tick answers', async () => {
    failNext = { at: 'text', delivery: 'not-started' };
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');

    expect(delivered).toEqual(['y', '<Enter>']);
    // Known not sent: `no-keys-sent`.
    expect(lines(EV.attemptSettled).map((line) => line.result)).toEqual(['no-keys-sent', 'ok']);
  });
});

describe('[#3880] the hold is released (not for ever)', () => {
  it('the screen changing to another confirmation: answered', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    expect(await tickOn(state, proceed('npm run build'))).toBe('responded');
    expect(delivered).toEqual(['y', 'y', '<Enter>']);
  });

  it('the prompt leaving the screen: its return is answered', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    expect(await tickOn(state, null)).toBe('no_prompt');
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('the session relaunched (a new epoch): answered', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    beginEnterFallbackSession(WORKTREE_ID, 'claude', 'claude');
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('a person answering: theirs while their hold lasts, answered after it', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    const answer = noteManualAnswerStarted(COMPOSITE_KEY, now);
    // Their answer went through (review P2: the end of it releases, not the start).
    settleManualAnswer(answer, 'answered');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('negative: a person only starting to answer does not release it', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    noteManualAnswerStarted(COMPOSITE_KEY, now);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(delivered).toEqual(['y']);
  });

  it('negative: with nothing changed, the hold stays', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(delivered).toEqual(['y']);
  });
});
