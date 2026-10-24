/**
 * A person's answer through POST /prompt-response that fails keeps Auto-Yes off
 * the confirmation (Issue #3880, review P2).
 *
 * Starting a manual answer used to drop the answer Auto-Yes held there (a send
 * of unknown outcome, #3880). The manual send then failing — answered 500 —
 * put nothing back, so once the manual hold (`MANUAL_ANSWER_HOLD_MS`) passed,
 * a tick at the same screen typed the answer again. How the manual answer ENDS
 * now decides: through, or refused before any key — released; keys on the pane
 * or outcome unknown — the hold stays, or is recorded for the person's own send.
 *
 * Runs the real route, answer resolution and delivery, `sendPromptAnswer` and
 * `detectAndRespondToPrompt`; the screen reading, the frame verification and
 * the tmux module are stubbed (tmux failing as `TmuxSendError` does).
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
/** A second failure, consumed after `failNext` (the person's send after Auto-Yes's). */
let failAfter: { at: 'text' | 'enter'; delivery: 'not-started' | 'indeterminate' } | null = null;
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    const key = enter ? `${keys}<Enter>` : keys;
    const fail = failNext;
    if (fail !== null && fail.at === (enter ? 'enter' : 'text')) {
      failNext = failAfter;
      failAfter = null;
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
      getTool: (tool: string) => ({
        getSessionName: (id: string) => `cm-${id}-${tool}`,
        name: tool,
        isRunning: async () => true,
      }),
    }),
  },
}));

// The route's own collaborators (the POST below runs the real route, the real
// answer resolution and delivery, and the real `sendPromptAnswer`).
const route = vi.hoisted(() => ({ prompt: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  getWorktreeById: vi.fn((_db: unknown, id: string) => ({ id, path: `/repo/${id}`, cliToolId: 'claude' })),
  recordAnsweredPrompt: vi.fn(() => ({ created: true, message: {} })),
}));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
  foreignSessionErrorBody: vi.fn(() => ({})),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/app/api/worktrees/[id]/prompt-response/structured-decision', () => ({
  answerViaStructuredDecision: vi.fn(async () => null),
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/frame-verification', () => ({
  verifyPromptOnScreen: vi.fn(async () => ({
    value: {
      promptCheck: { isPrompt: true, promptData: route.prompt, cleanContent: 'pane', rawContent: 'pane' },
      verifiedFrame: 'pane',
      isCommandCodeQuestion: false,
      verificationFailed: false,
    },
  })),
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/ledger-record', () => ({
  notePromptResponseInLedger: vi.fn(async (_ctx: unknown, _request: unknown, response: unknown) => response),
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

import type { NextRequest } from 'next/server';
import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POST } from '@/app/api/worktrees/[id]/prompt-response/route';
import { clearManualAnswers, MANUAL_ANSWER_HOLD_MS } from '@/lib/polling/auto-yes-manual-answer';
import { clearPartialAnswers } from '@/lib/polling/auto-yes-poller-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';

const WORKTREE_ID = 'wt-3880-manual';
const T0 = new Date('2026-10-24T12:00:00.000Z').getTime();
let now = T0;

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

async function tickOn(state: AutoYesPollerState, prompt: PromptData | null): Promise<string> {
  screen.prompt = prompt;
  const result = await detectAndRespondToPrompt(WORKTREE_ID, state, 'claude', 'pane', ['pane'], 'claude');
  now += 2_000;
  return result;
}

/** A person answers `y` at the prompt on screen. */
async function personAnswers(prompt: PromptData): Promise<number> {
  screen.prompt = prompt;
  route.prompt = prompt;
  const response = await POST(
    new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/prompt-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'y', cliTool: 'claude', instanceId: 'claude' }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: WORKTREE_ID }) },
  );
  return response.status;
}

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
  failAfter = null;
  clearAllPollerStates();
  clearManualAnswers();
  clearPartialAnswers();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests({
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  if (ORIGINAL_DIALOG_GATE_ENV === undefined) delete process.env.CM_AUTOYES_DIALOG_GATE;
  else process.env.CM_AUTOYES_DIALOG_GATE = ORIGINAL_DIALOG_GATE_ENV;
  vi.restoreAllMocks();
  clearAllPollerStates();
  clearManualAnswers();
  clearPartialAnswers();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

describe('[#3880 P2] Auto-Yes held an unknown send; the person\'s send then fails', () => {
  it('outcome unknown (500): after the manual hold, the tick still does not type again', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    failAfter = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');

    expect(await personAnswers(proceed('npm test'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    // Auto-Yes's `y`, the person's `y` — and no third.
    expect(delivered).toEqual(['y', 'y']);
  });

  it('negative: refused by tmux before any key: released, the tick after the hold answers', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    failAfter = { at: 'text', delivery: 'not-started' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));

    expect(await personAnswers(proceed('npm test'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('negative: the person\'s answer goes through: released', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    await tickOn(state, proceed('npm test'));

    expect(await personAnswers(proceed('npm test'))).toBe(200);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });
});

describe('[#3880 P2] nothing held; the person\'s own send is cut short', () => {
  it('the Enter after their text times out: the confirmation is held for them', async () => {
    failNext = { at: 'enter', delivery: 'indeterminate' };
    const state = pollerState();

    expect(await personAnswers(proceed('npm test'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(delivered).toEqual(['y', '<Enter>']);
  });

  it('negative: another confirmation after it is answered', async () => {
    failNext = { at: 'enter', delivery: 'indeterminate' };
    const state = pollerState();

    await personAnswers(proceed('npm test'));
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm run build'))).toBe('responded');
  });
});
