/**
 * Issue #4303 (#4303-A): Auto-Yes types nothing into a pane whose agent is not
 * known to hold it, and does not record that it answered.
 *
 * Drives the real `detectAndRespondToPrompt` and `sendPromptAnswer` (the
 * harness of `auto-yes-poller-input-lock-3952.test.ts`); the screen reading
 * and the tmux module are stubbed, `readPaneForeground` (#4300) among them.
 *
 * - shell / unknown: `no_answer`, no key, no error counted, the ledger's
 *   attempt settled `no-keys-sent`, and the prompt not remembered as answered
 *   (`lastAnsweredPromptKey` stays null), so a later tick may answer it.
 * - positive control: the agent back in the foreground — the same prompt is
 *   answered, once.
 * - review P1: the foreground read is an await. The contract turned off, or a
 *   deny pattern added, while it is held: released `other`, still no key and
 *   `no_answer`. Unchanged, the answer goes out once (negative control).
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

const h = vi.hoisted(() => ({
  foreground: 'other' as 'shell' | 'other' | 'unknown',
  delivered: [] as string[],
  /** Review P1: when set, the foreground read waits for it. */
  hold: null as Promise<void> | null,
}));

vi.mock('@/lib/tmux/tmux', () => ({
  readPaneForeground: vi.fn(async () => {
    if (h.hold !== null) await h.hold;
    return h.foreground;
  }),
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    h.delivered.push(enter ? `${keys}<Enter>` : keys);
  }),
  sendSpecialKeys: vi.fn(async (_session: string, keys: string[]) => {
    h.delivered.push(...keys);
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

const screen = vi.hoisted(() => ({ prompt: null as unknown }));
vi.mock('@/lib/polling/response-checker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/response-checker')>()),
  detectPromptOnCleanFrame: () =>
    screen.prompt === null ? { isPrompt: false } : { isPrompt: true, promptData: screen.prompt },
}));

/** Review P1: the contract as the fresh lookup reads it; null passes through. */
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
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { clearAllPollerStates, detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { readPaneForeground } from '@/lib/tmux/tmux';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_LEDGER_EVENTS as EV } from '@/lib/polling/auto-yes-confirmation-ledger-types';

const WORKTREE_ID = 'wt-4303';
const SESSION = `cm-${WORKTREE_ID}-claude`;
const T0 = new Date('2026-11-13T10:00:00.000Z').getTime();
let now = T0;

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

async function tickOn(state: AutoYesPollerState, prompt: PromptData | null): Promise<string> {
  screen.prompt = prompt;
  const result = await detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', 'pane', ['pane'], 'claude');
  now += 2_000;
  return result;
}

const lines = (event: string): Array<Record<string, unknown>> =>
  mockLogger.info.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields as Record<string, unknown>);

/** The typed-answer path on claude is reached under the gate's `legacy` (as in the #3952 file). */
const ORIGINAL_DIALOG_GATE_ENV = process.env.CM_AUTOYES_DIALOG_GATE;

beforeEach(() => {
  process.env.CM_AUTOYES_DIALOG_GATE = 'claude=legacy';
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  h.delivered = [];
  h.foreground = 'other';
  h.hold = null;
  contract.override = null;
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

describe('[#4303] Auto-Yes and the pane foreground', () => {
  it.each(['shell', 'unknown'] as const)(
    '%s: no key, no_answer, not recorded as answered; answered once the agent is back',
    async (foreground) => {
      const state = pollerState();
      h.foreground = foreground;
      expect(await tickOn(state, YES_NO)).toBe('no_answer');
      expect(h.delivered).toEqual([]);
      expect(readPaneForeground).toHaveBeenCalledWith(SESSION);
      expect(state.consecutiveErrors).toBe(0);
      expect(state.lastAnsweredPromptKey).toBeNull();
      expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'no-keys-sent' })]);
      expect(lines('poller:auto-yes-answer-not-delivered')).toHaveLength(1);

      // Positive control: the agent holds the pane again — the same prompt is answered, once.
      h.foreground = 'other';
      expect(await tickOn(state, YES_NO)).toBe('responded');
      expect(h.delivered).toEqual(['y', '<Enter>']);
    }
  );
});

/** Hold the foreground read until released (review P1). */
function holdForeground(): { release: () => void } {
  let release: () => void = () => {};
  h.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release };
}

/** Let the tick run up to the held read. */
async function untilForegroundAsked(): Promise<void> {
  for (let i = 0; i < 50 && vi.mocked(readPaneForeground).mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(readPaneForeground).toHaveBeenCalledTimes(1);
}

describe('[#4303 review P1] the contract is read again after the foreground read', () => {
  it.each([
    ['turned off', { mode: 'off', allowPromptTypes: [], denyPatterns: [] }],
    ['a deny pattern added', { mode: 'safe', allowPromptTypes: [], denyPatterns: ['proceed'] }],
  ] as const)('%s while the read was held, released other: no key, no_answer', async (_label, changed) => {
    const state = pollerState();
    const held = holdForeground();
    const tick = tickOn(state, YES_NO);
    await untilForegroundAsked();
    contract.override = changed;
    held.release();
    expect(await tick).toBe('no_answer');
    expect(h.delivered).toEqual([]);
    expect(state.consecutiveErrors).toBe(0);
    expect(state.lastAnsweredPromptKey).toBeNull();
    expect(lines(EV.attemptSettled)).toEqual([expect.objectContaining({ result: 'no-keys-sent' })]);
    expect(lines('poller:auto-yes-answer-not-delivered')).toEqual([
      expect.objectContaining({ skip: 'answer-withheld' }),
    ]);
  });

  it('negative control: nothing changed while the read was held — one answer', async () => {
    const state = pollerState();
    const held = holdForeground();
    const tick = tickOn(state, YES_NO);
    await untilForegroundAsked();
    held.release();
    expect(await tick).toBe('responded');
    expect(h.delivered).toEqual(['y', '<Enter>']);
  });
});
