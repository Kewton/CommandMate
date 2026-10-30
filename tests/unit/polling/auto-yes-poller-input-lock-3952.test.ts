/**
 * Auto-Yes's answer waits for a message send that holds the session's input,
 * and is read again after it (Issue #3952).
 *
 * The tick decided its answer on a frame read before the send; once the send
 * is over, the answer is typed only if a fresh capture still shows the same
 * prompt. When it does not, nothing is typed, the tick ends `no_answer` without
 * counting an error, and the next tick decides again on its own frame.
 *
 * Drives the real `detectAndRespondToPrompt` and `sendPromptAnswer`, as
 * `auto-yes-poller-failed-send-3839.test.ts` does; the screen reading and the
 * tmux module are stubbed, the lock is the real one.
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
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
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

/**
 * Issue #3952 review P1-2: the contract as the fresh lookup reads it; null
 * passes through to the real lookup.
 */
const contract = vi.hoisted(() => ({ override: null as unknown }));
vi.mock('@/lib/polling/auto-yes-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-policy')>();
  return {
    ...actual,
    getSessionAutoYesPolicy: (...args: Parameters<typeof actual.getSessionAutoYesPolicy>) =>
      (contract.override as ReturnType<typeof actual.getSessionAutoYesPolicy> | null) ??
      actual.getSessionAutoYesPolicy(...args),
  };
});

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
import { capturePane } from '@/lib/tmux/tmux';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WORKTREE_ID = 'wt-3952';
const SESSION = `cm-${WORKTREE_ID}-claude`;
const T0 = new Date('2026-10-23T10:00:00.000Z').getTime();

let now = T0;

/** claude's y/n confirmation, and the reading the real reader makes of it. */
const YES_NO_FRAME = ['some output', '', 'Do you want to proceed? (y/n)', ''].join('\n');
const YES_NO: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  status: 'pending',
  options: ['yes', 'no'],
  approvalTarget: 'some output\n\nDo you want to proceed? (y/n)',
};

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
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  mockLogger.info.mockImplementation(() => {});
  resetInstanceInputLocks();
  contract.override = null;
});

afterEach(() => {
  if (ORIGINAL_DIALOG_GATE_ENV === undefined) delete process.env.CM_AUTOYES_DIALOG_GATE;
  else process.env.CM_AUTOYES_DIALOG_GATE = ORIGINAL_DIALOG_GATE_ENV;
  vi.restoreAllMocks();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});


function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A message send holding the session's composer until `release`. */
function holdSend(): { release: () => void; done: Promise<void> } {
  const gate = deferred();
  const done = withInstanceInputLock(SESSION, async () => {
    delivered.push('<send>');
    await gate.promise;
  });
  return { release: gate.resolve, done };
}

describe('[#3952] Auto-Yes answers after a send in progress, only to the same prompt', () => {
  it('positive: the prompt is gone once the send is over — nothing typed, no error, decided again next tick', async () => {
    const state = pollerState();
    const held = holdSend();
    const tick = tickOn(state, YES_NO);
    await flush();
    expect(delivered).toEqual(['<send>']);
    vi.mocked(capturePane).mockResolvedValue('❯ ');
    held.release();
    await held.done;
    expect(await tick).toBe('no_answer');
    expect(delivered).toEqual(['<send>']);
    expect(state.consecutiveErrors).toBe(0);
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'no-keys-sent' })]);
    expect(lines('poller:auto-yes-answer-not-delivered')).toEqual([
      expect.objectContaining({ skip: 'target-changed' }),
    ]);

    // The prompt is back on a later frame: the tick answers it.
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    expect(await tickOn(state, YES_NO)).toBe('responded');
    expect(delivered).toEqual(['<send>', 'y', '<Enter>']);
  });

  it('negative: the same prompt is still up once the send is over — answered', async () => {
    const state = pollerState();
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    const held = holdSend();
    const tick = tickOn(state, YES_NO);
    await flush();
    expect(delivered).toEqual(['<send>']);
    held.release();
    await held.done;
    expect(await tick).toBe('responded');
    expect(delivered).toEqual(['<send>', 'y', '<Enter>']);
  });

  it('negative: with no send in the way the answer reads nothing again', async () => {
    const state = pollerState();
    expect(await tickOn(state, YES_NO)).toBe('responded');
    expect(delivered).toEqual(['y', '<Enter>']);
    expect(capturePane).not.toHaveBeenCalled();
  });
});

describe('[#3952 review P1-2] the contract is read again right before the first key', () => {
  it('positive: the contract turned off while the answer waited — nothing typed, no_answer, no error', async () => {
    const state = pollerState();
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    const held = holdSend();
    const tick = tickOn(state, YES_NO);
    await flush();
    expect(delivered).toEqual(['<send>']);
    contract.override = { mode: 'off', allowPromptTypes: [], denyPatterns: [] };
    held.release();
    await held.done;
    expect(await tick).toBe('no_answer');
    expect(delivered).toEqual(['<send>']);
    expect(state.consecutiveErrors).toBe(0);
    expect(lines('poller:auto-yes-answer-not-delivered')).toEqual([
      expect.objectContaining({ skip: 'answer-withheld' }),
    ]);
  });

  it('positive: a deny pattern added while the answer waited — nothing typed', async () => {
    const state = pollerState();
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    const held = holdSend();
    const tick = tickOn(state, YES_NO);
    await flush();
    contract.override = { mode: 'safe', allowPromptTypes: [], denyPatterns: ['proceed'] };
    held.release();
    await held.done;
    expect(await tick).toBe('no_answer');
    expect(delivered).toEqual(['<send>']);
  });

  it('negative: the contract unchanged after the wait — answered', async () => {
    const state = pollerState();
    vi.mocked(capturePane).mockResolvedValue(YES_NO_FRAME);
    const held = holdSend();
    const tick = tickOn(state, YES_NO);
    await flush();
    held.release();
    await held.done;
    expect(await tick).toBe('responded');
    expect(delivered).toEqual(['<send>', 'y', '<Enter>']);
  });
});
