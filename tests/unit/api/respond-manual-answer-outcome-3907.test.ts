/**
 * `/respond`'s stored-message branch (`{ messageId, answer }`) reports how the
 * person's answer ended to Auto-Yes, as `/prompt-response` does (Issue #3907,
 * #3880's ticket).
 *
 * The branch types the answer at the pane, yet it never told Auto-Yes a person
 * was answering: a send of unknown outcome left the confirmation free for a
 * tick to type at again once nothing else held it, and an answer that went
 * through left Auto-Yes's own unknown send held. No PC, mobile or CLI path
 * posts a `messageId` today, but the branch is a public shape the existing
 * suites pin (`respond-multiselect-2755`, `respond-stored-reading-3881`), so it
 * is kept and goes through the ticket.
 *
 * Runs the real route, the real `sendPromptAnswer` and the real
 * `detectAndRespondToPrompt`; the screen reading and the tmux module are
 * stubbed (tmux failing as `TmuxSendError` does).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { ChatMessage, PromptData, Worktree } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

/** Review P2 (2nd): what the screen turns into while the sender reads the pane itself. */
const guardRead = vi.hoisted(() => ({ switchTo: null as unknown, failSpecialKeys: false }));

/** Every key that reached the pane, in order (a key that landed and then timed out included). */
let delivered: string[] = [];
type Failure = { at: 'text' | 'enter'; delivery: 'not-started' | 'indeterminate' };
/** The next `sendKeys` failure, consumed once; then {@link failAfter}. */
let failNext: Failure | null = null;
let failAfter: Failure | null = null;
vi.mock('@/lib/tmux/tmux', () => ({
  // The sender's own read of the pane (`readGuardFrame` when it is handed no
  // frame). `guardRead.switchTo` models the screen changing during that await.
  capturePane: vi.fn(async () => {
    if (guardRead.switchTo !== null) screen.prompt = guardRead.switchTo;
    return '';
  }),
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
    // Review P2 (2nd): the special keys landed and the call timed out.
    if (guardRead.failSpecialKeys) {
      guardRead.failSpecialKeys = false;
      throw Object.assign(new Error('Failed to send special keys to tmux session: Command failed'), {
        name: 'TmuxSendError',
        delivery: 'indeterminate',
        keysDelivered: 0,
      });
    }
  }),
}));

/** The frame `/respond` captures right before its send (review P2); `fail` makes that capture throw. */
const sendScreen = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  captureSessionOutputFresh: vi.fn(async () => {
    if (sendScreen.fail) throw new Error('capture failed');
    return 'respond-frame';
  }),
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
      getTool: (tool: string) => ({
        getSessionName: (id: string) => `cm-${id}-${tool}`,
        name: tool,
        isRunning: async () => true,
      }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
  foreignSessionErrorBody: vi.fn(() => ({})),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));

/** What the reading returns this tick. */
const screen = vi.hoisted(() => ({ prompt: null as unknown }));
vi.mock('@/lib/polling/response-checker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/response-checker')>()),
  detectPromptOnCleanFrame: () =>
    screen.prompt === null ? { isPrompt: false } : { isPrompt: true, promptData: screen.prompt },
}));

// `/respond`'s reading of that frame is the prompt on screen (`screen.prompt`);
// every other reading is the real one.
vi.mock('@/lib/polling/auto-yes-dialog-gate', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/polling/auto-yes-dialog-gate')>();
  return {
    ...original,
    assessPromptAnswerability: (cliToolId: Parameters<typeof original.assessPromptAnswerability>[0], frame: string) => {
      const assessed = original.assessPromptAnswerability(cliToolId, frame);
      if (frame !== 'respond-frame') return assessed;
      return {
        ...assessed,
        refusal: null,
        promptCheck: screen.prompt === null
          ? { isPrompt: false, cleanContent: '' }
          : { isPrompt: true, promptData: screen.prompt, cleanContent: '' },
      };
    },
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

import type { NextRequest } from 'next/server';
import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POST } from '@/app/api/worktrees/[id]/respond/route';
import { createMessage, upsertWorktree } from '@/lib/db';
import {
  clearManualAnswers,
  getManualAnswerSeq,
  MANUAL_ANSWER_HOLD_MS,
} from '@/lib/polling/auto-yes-manual-answer';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { clearPartialAnswers } from '@/lib/polling/auto-yes-poller-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';

const WORKTREE_ID = 'wt-3907-respond';
const T0 = new Date('2026-10-25T12:00:00.000Z').getTime();
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

/**
 * A person answers `yes` to the stored prompt row of `prompt`, by `messageId`,
 * while `onScreen` (by default the same prompt) is what the screen shows at the send.
 */
async function personAnswersRow(
  prompt: PromptData,
  onScreen: PromptData | null = prompt,
  answer = 'yes',
): Promise<number> {
  screen.prompt = onScreen;
  const row = createMessage(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: 'claude',
    role: 'assistant',
    content: prompt.question,
    messageType: 'prompt',
    promptData: prompt,
    timestamp: new Date(now),
  } as unknown as ChatMessage);
  const response = await POST(
    new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: row.id, answer }),
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
  upsertWorktree(db, {
    id: WORKTREE_ID,
    name: 'respond 3907',
    path: `/repo/${WORKTREE_ID}`,
    repositoryPath: '/repo',
    repositoryName: 'Repo',
    cliToolId: 'claude',
  } as Worktree);
  vi.clearAllMocks();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  delivered = [];
  failNext = null;
  failAfter = null;
  sendScreen.fail = false;
  guardRead.switchTo = null;
  guardRead.failSpecialKeys = false;
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

describe('[#3907] /respond { messageId } starts a manual answer', () => {
  it('moves the instance\'s manual-answer sequence on (a tick under way sends no further key)', async () => {
    const key = buildCompositeKey(WORKTREE_ID, 'claude', 'claude');
    expect(getManualAnswerSeq(key)).toBe(0);
    expect(await personAnswersRow(proceed('npm test'))).toBe(200);
    expect(getManualAnswerSeq(key)).toBeGreaterThan(0);
  });

  it('negative: a refusal before any key (unknown message) starts nothing', async () => {
    const key = buildCompositeKey(WORKTREE_ID, 'claude', 'claude');
    const response = await POST(
      new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: 'no-such-row', answer: 'yes' }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: WORKTREE_ID }) },
    );
    expect(response.status).toBe(404);
    expect(getManualAnswerSeq(key)).toBe(0);
    expect(delivered).toEqual([]);
  });
});

describe('[#3907] Auto-Yes held an unknown send; the person answers the stored row', () => {
  it('the answer goes through: released, the tick after the hold answers', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');

    expect(await personAnswersRow(proceed('npm test'))).toBe(200);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('outcome unknown (500): after the manual hold, the tick still does not type again', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    failAfter = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');

    expect(await personAnswersRow(proceed('npm test'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(delivered).toEqual(['y', 'y']);
  });
});

describe('[#3907] nothing held; the person\'s own send through /respond is cut short', () => {
  it('the Enter after their text times out: the confirmation is held for them', async () => {
    failNext = { at: 'enter', delivery: 'indeterminate' };
    const state = pollerState();

    expect(await personAnswersRow(proceed('npm test'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(delivered).toEqual(['y', '<Enter>']);
  });

  it('negative: refused by tmux before any key: nothing held, the tick after the hold answers', async () => {
    failNext = { at: 'text', delivery: 'not-started' };
    const state = pollerState();

    expect(await personAnswersRow(proceed('npm test'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('negative: another confirmation after it is answered', async () => {
    failNext = { at: 'enter', delivery: 'indeterminate' };
    const state = pollerState();

    await personAnswersRow(proceed('npm test'));
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm run build'))).toBe('responded');
  });
});

describe('[#3907 review P2] the send is registered at the screen it goes to, not the stored row\'s', () => {
  it('row A, screen B at the send, outcome unknown: after the hold, the tick does not type at B again', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    const state = pollerState();

    expect(await personAnswersRow(proceed('npm test'), proceed('npm run build'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm run build'))).toBe('no_answer');
    expect(delivered).toEqual(['y']);
  });

  it('the screen cannot be read at the send: held as an unidentified screen, B is not typed at again', async () => {
    failNext = { at: 'text', delivery: 'indeterminate' };
    sendScreen.fail = true;
    const state = pollerState();

    expect(await personAnswersRow(proceed('npm test'), proceed('npm run build'))).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm run build'))).toBe('no_answer');
    expect(delivered).toEqual(['y']);
  });

  it('negative: row A, screen B at the send, the answer goes through: B is answered after the hold', async () => {
    const state = pollerState();

    expect(await personAnswersRow(proceed('npm test'), proceed('npm run build'))).toBe(200);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm run build'))).toBe('responded');
  });

  it('negative: the frame is read once for the send', async () => {
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    expect(await personAnswersRow(proceed('npm test'))).toBe(200);
    expect(captureSessionOutputFresh).toHaveBeenCalledTimes(1);
  });
});

const choose = (command: string): PromptData => ({
  type: 'multiple_choice',
  question: 'Do you want to proceed?',
  status: 'pending',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: 'No', isDefault: false },
  ],
  approvalTarget: command,
});

describe('[#3907 review P2, 2nd] a numeric answer is sent at the frame it was registered at', () => {
  it('the sender is handed that frame: no second read of the pane where B could turn into C', async () => {
    const { capturePane } = await import('@/lib/tmux/tmux');
    guardRead.switchTo = choose('npm run deploy');
    guardRead.failSpecialKeys = true;
    const state = pollerState();

    expect(await personAnswersRow(choose('npm test'), choose('npm run build'), '1')).toBe(500);
    expect(capturePane).not.toHaveBeenCalled();
    now += MANUAL_ANSWER_HOLD_MS;
    // The screen the keys went to is the one registered: it is not typed at again.
    expect(await tickOn(state, screen.prompt as PromptData)).toBe('no_answer');
    expect(delivered).toHaveLength(1);
  });

  it('negative: a numeric answer on an unchanged screen that goes through is released as before', async () => {
    const state = pollerState();

    expect(await personAnswersRow(choose('npm test'), choose('npm test'), '1')).toBe(200);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, choose('npm test'))).toBe('responded');
  });

  it('negative: a `yes` answer is sent with the frame too, and behaves as before', async () => {
    const { capturePane } = await import('@/lib/tmux/tmux');
    const state = pollerState();

    expect(await personAnswersRow(proceed('npm test'))).toBe(200);
    expect(capturePane).not.toHaveBeenCalled();
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });
});
