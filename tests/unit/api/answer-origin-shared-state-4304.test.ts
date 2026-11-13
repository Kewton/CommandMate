/**
 * Issue #4304 F1-a (the contract after §6-6, acceptance table §3.4 T3 / T4 /
 * T5 / T6 / T9): the pane an answer was decided for travels with the answer
 * to its send, the hold it records or releases, and everything it does to the
 * instance's current state afterwards.
 *
 * The session's pane is replaced by an outside `new-window -k` (pane G → H,
 * the session epoch unchanged) at the steps below; ONLY the pane changes.
 *
 * - T3 (Auto-Yes → Auto-Yes): `y` typed at G, then the Enter refused because
 *   the session shows H: G's hold does not keep Auto-Yes off H's identical
 *   question.
 * - T4 (manual → Auto-Yes, and back): a person's `y` at G cut short the same
 *   way does not hold H either; a person's answer decided at G does not release
 *   the hold Auto-Yes keeps at H.
 * - T5 / T6 / T9: the task event, the response-poll restart and the push act
 *   on the instance only while it still shows the answered pane — looked at
 *   after the last await (the dynamic import of the poller, the send) — and
 *   the answered pane dead by the answer still counts.
 *
 * Runs the real `/prompt-response` route, answer resolution and delivery, the
 * real `sendPromptAnswer`, `detectAndRespondToPrompt` and the shared Auto-Yes
 * state; the screen reading, the frame verification and the tmux transport are
 * stubbed (as `prompt-response-manual-send-hold-3880.test.ts` does).
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
import type { PaneGeneration } from '@/lib/session/cli-session';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const hooks = vi.hoisted(() => ({
  /** Run right after a key reaches the pane: (the key as delivered). */
  afterKey: null as null | ((key: string) => void),
  /** Run inside the Auto-Yes audit row's write (after the first look, before the restart's). */
  inAudit: null as null | (() => void),
  /** The generation the route's verified frame is bound to. */
  routeGeneration: null as null | PaneGeneration,
  /** Make the next Enter fail as a tmux call with no exit status. */
  enterIndeterminate: false,
}));

/** Every key that reached the pane, in order. */
let delivered: string[] = [];
vi.mock('@/lib/tmux/tmux', async () => (await import('@tests/unit/session/bound-frame-test-helper')).withPaneGenerationTmuxDoubles({
  readPaneForeground: async () => 'other' as const,
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    const key = enter ? `${keys}<Enter>` : keys;
    if (enter && hooks.enterIndeterminate) {
      hooks.enterIndeterminate = false;
      delivered.push(key);
      throw Object.assign(new Error('Failed to send keys to tmux session: Command failed'), {
        name: 'TmuxSendError',
        delivery: 'indeterminate',
        keysDelivered: 0,
      });
    }
    delivered.push(key);
    hooks.afterKey?.(key);
  }),
  sendSpecialKeys: vi.fn(async (_session: string, keys: string[]) => {
    delivered.push(...keys);
  }),
}));

vi.mock('@/lib/session/cli-session', async () => (await import('@tests/unit/session/bound-frame-test-helper')).withBoundCaptureCliSessionDoubles({
  captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));
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

const route = vi.hoisted(() => ({ prompt: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  getWorktreeById: vi.fn((_db: unknown, id: string) => ({ id, path: `/repo/${id}`, cliToolId: 'claude' })),
  recordAnsweredPrompt: vi.fn(() => ({ created: true, message: {} })),
}));
vi.mock('@/lib/db/chat-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/chat-db')>();
  return {
    ...actual,
    recordAnsweredPrompt: (...args: Parameters<typeof actual.recordAnsweredPrompt>) => {
      const hook = hooks.inAudit;
      hooks.inAudit = null;
      hook?.();
      return actual.recordAnsweredPrompt(...args);
    },
  };
});
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
  foreignSessionErrorBody: vi.fn(() => ({})),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/app/api/worktrees/[id]/prompt-response/structured-decision', () => ({
  answerViaStructuredDecision: vi.fn(async () => null),
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/frame-verification', () => ({
  verifyPromptOnScreen: vi.fn(async () => {
    const helper = await import('@tests/unit/session/bound-frame-test-helper');
    return {
      value: {
        promptCheck: { isPrompt: true, promptData: route.prompt, cleanContent: 'pane', rawContent: 'pane' },
        verifiedFrame: helper.testBoundFrame('pane', {
          sessionName: 'cm-wt-4304-origin-claude',
          ...(hooks.routeGeneration !== null ? { generation: hooks.routeGeneration } : {}),
        }),
        isCommandCodeQuestion: false,
        verificationFailed: false,
      },
    };
  }),
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/ledger-record', () => ({
  notePromptResponseInLedger: vi.fn(async (_ctx: unknown, _request: unknown, response: unknown) => response),
}));

const screen = vi.hoisted(() => ({ prompt: null as unknown }));
vi.mock('@/lib/polling/response-checker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/response-checker')>()),
  detectPromptOnCleanFrame: () =>
    screen.prompt === null ? { isPrompt: false } : { isPrompt: true, promptData: screen.prompt },
}));

const mockLogger = vi.hoisted(() => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
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
import { clearPartialAnswers, getPartialAnswer, partialAnswerScreenKey } from '@/lib/polling/auto-yes-poller-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';
import { getEnterFallbackSessionEpoch } from '@/lib/polling/auto-yes-enter-fallback-state';
import { startPolling } from '@/lib/polling/response-poller';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { recordAnsweredPrompt as recordRouteAudit } from '@/lib/db';
import {
  getAutoYesDecisionRecord,
  reaffirmAutoYesAnswering,
  recordAutoYesDecision,
} from '@/lib/polling/auto-yes-decision-state';
import {
  TEST_PANE_GENERATION,
  resetTestPaneGenerations,
  setTestPaneGeneration,
  testBoundFrame,
} from '@tests/unit/session/bound-frame-test-helper';

const WORKTREE_ID = 'wt-4304-origin';
const SESSION = `cm-${WORKTREE_ID}-claude`;
const KEY = `${WORKTREE_ID}:claude`;
const G: PaneGeneration = TEST_PANE_GENERATION;
const H: PaneGeneration = { ...TEST_PANE_GENERATION, paneId: '%99' };
const T0 = new Date('2026-11-14T12:00:00.000Z').getTime();
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

/** The session now shows `generation` (alive unless said). */
function sessionShows(generation: PaneGeneration, dead = false): void {
  setTestPaneGeneration(SESSION, { generation, dead });
}

/** One Auto-Yes tick on a frame of `generation` showing `prompt`. */
async function tickOn(state: AutoYesPollerState, prompt: PromptData | null, generation: PaneGeneration): Promise<string> {
  screen.prompt = prompt;
  const result = await detectAndRespondToPrompt(
    WORKTREE_ID, state, 'claude', 'pane', ['pane'], 'claude', undefined, undefined, undefined, undefined, undefined, undefined,
    testBoundFrame('', { sessionName: SESSION, generation }),
  );
  now += 2_000;
  return result;
}

/** A person answers `y` at the prompt, verified on a frame of `generation`. */
async function personAnswers(prompt: PromptData, generation: PaneGeneration): Promise<number> {
  screen.prompt = prompt;
  route.prompt = prompt;
  hooks.routeGeneration = generation;
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

/** After the text `y` reaches the pane, the session shows H (the Enter is refused). */
function replacedAfterText(): void {
  hooks.afterKey = (key) => {
    if (key === 'y') {
      hooks.afterKey = null;
      sessionShows(H);
    }
  };
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
  hooks.afterKey = null;
  hooks.inAudit = null;
  hooks.routeGeneration = null;
  hooks.enterIndeterminate = false;
  resetTestPaneGenerations();
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
  resetTestPaneGenerations();
  clearAllPollerStates();
  clearManualAnswers();
  clearPartialAnswers();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  resetAutoYesConfirmationLedgerForTests();
  setAutoYesLedgerClockTimersForTests(null);
  db.close();
});

describe('[#4304 F1-a T3] Auto-Yes: keys typed at G do not hold H', () => {
  it('positive: `y` at G, the Enter refused (H now) — the next tick answers H, and G\'s record stays', async () => {
    const state = pollerState();
    replacedAfterText();
    expect(await tickOn(state, proceed('npm test'), G)).toBe('error');
    expect(delivered).toEqual(['y']);
    expect(getPartialAnswer(KEY, getEnterFallbackSessionEpoch(KEY))).not.toBeNull();

    expect(await tickOn(state, proceed('npm test'), H)).toBe('responded');
    expect(delivered).toEqual(['y', 'y', '<Enter>']);
  });

  it('negative: the same pane G — the partial answer holds the next tick at G', async () => {
    const state = pollerState();
    hooks.enterIndeterminate = true;
    expect(await tickOn(state, proceed('npm test'), G)).toBe('error');
    expect(await tickOn(state, proceed('npm test'), G)).toBe('no_answer');
    expect(delivered).toEqual(['y', '<Enter>']);
  });
});

describe('[#4304 F1-a T4] the hold a person\'s answer records or releases is its own pane\'s', () => {
  it('positive: a person\'s `y` at G cut short (H now) — after the manual hold, Auto-Yes answers H', async () => {
    replacedAfterText();
    expect(await personAnswers(proceed('npm test'), G)).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(pollerState(), proceed('npm test'), H)).toBe('responded');
    expect(delivered).toEqual(['y', 'y', '<Enter>']);
  });

  it('negative: the person\'s Enter at G times out (G still) — the tick at G stays off it', async () => {
    hooks.enterIndeterminate = true;
    expect(await personAnswers(proceed('npm test'), G)).toBe(500);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(pollerState(), proceed('npm test'), G)).toBe('no_answer');
  });

  it('positive (reverse): a person\'s answer decided at G, refused (the session shows H), does not release H\'s hold', async () => {
    sessionShows(H);
    const state = pollerState();
    hooks.enterIndeterminate = true;
    expect(await tickOn(state, proceed('npm test'), H)).toBe('error');

    // Decided on a frame of G; the send finds H and types nothing (not-sent).
    expect(await personAnswers(proceed('npm test'), G)).toBe(200);
    now += MANUAL_ANSWER_HOLD_MS;
    // H still holds Auto-Yes's `y` and the Enter of unknown outcome: no second `y`.
    expect(await tickOn(state, proceed('npm test'), H)).toBe('no_answer');
    expect(delivered).toEqual(['y', '<Enter>']);
  });

  it('negative (reverse): a person\'s answer at H that goes through releases H\'s hold', async () => {
    sessionShows(H);
    const state = pollerState();
    hooks.enterIndeterminate = true;
    expect(await tickOn(state, proceed('npm test'), H)).toBe('error');

    expect(await personAnswers(proceed('npm test'), H)).toBe(200);
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'), H)).toBe('responded');
  });
});

describe('[#4304 F1-a T5 / T6 / T9] the current state only while the session shows the answered pane', () => {
  it('T5 positive: Auto-Yes — H after the first look, before the restart\'s: the restart is not made', async () => {
    hooks.inAudit = () => sessionShows(H);
    expect(await tickOn(pollerState(), proceed('npm test'), G)).toBe('responded');
    // The first look saw G: the task event was written; the audit row too.
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    expect(startPolling).not.toHaveBeenCalled();
  });

  it('T5 negative: Auto-Yes on G throughout — the task event and the restart', async () => {
    expect(await tickOn(pollerState(), proceed('npm test'), G)).toBe('responded');
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    expect(startPolling).toHaveBeenCalledTimes(1);
  });

  it('T6 positive: a person\'s answer — H once the Enter is out: no task event, no restart; the audit row is the answer\'s own', async () => {
    hooks.afterKey = (key) => {
      if (key === '<Enter>') sessionShows(H);
    };
    expect(await personAnswers(proceed('npm test'), G)).toBe(200);
    expect(delivered).toEqual(['y', '<Enter>']);
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
    expect(startPolling).not.toHaveBeenCalled();
    expect(recordRouteAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordRouteAudit).mock.calls[0][1]).toHaveProperty('pendingSavedAtOrBefore');
  });

  it('T9: a person\'s answer that leaves its own pane G dead — the task event and the restart, as an answer that ended the agent', async () => {
    hooks.afterKey = (key) => {
      if (key === '<Enter>') sessionShows(G, true);
    };
    expect(await personAnswers(proceed('npm test'), G)).toBe(200);
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    expect(startPolling).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordRouteAudit).mock.calls[0][1]).not.toHaveProperty('pendingSavedAtOrBefore');
  });
});

describe('[#4304 F1-a A3 / A8] the duplicate guard and the decision are about the answered pane', () => {
  it('positive: G answered, the session now H with the same question — H is answered, not skipped as a duplicate', async () => {
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'), G)).toBe('responded');
    sessionShows(H);
    expect(await tickOn(state, proceed('npm test'), H)).toBe('responded');
    expect(delivered).toEqual(['y', '<Enter>', 'y', '<Enter>']);
  });

  it('negative: the same pane G — the duplicate guard holds the same question back, as before', async () => {
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'), G)).toBe('responded');
    expect(await tickOn(state, proceed('npm test'), G)).toBe('duplicate');
    expect(delivered).toEqual(['y', '<Enter>']);
  });

  it('an `answering` decision read from G is not reaffirmed by a tick reading H; G\'s own tick reaffirms it', () => {
    const decision = { promptData: proceed('npm test'), grant: null, epoch: 0 };
    recordAutoYesDecision(KEY, { ...decision, state: 'answering', reason: null, pane: { kind: 'pane', generation: G } });
    expect(reaffirmAutoYesAnswering(KEY, { ...decision, pane: { kind: 'pane', generation: G } })).toBe(true);
    expect(reaffirmAutoYesAnswering(KEY, { ...decision, pane: { kind: 'pane', generation: H } })).toBe(false);
    expect(getAutoYesDecisionRecord(KEY)).toBeNull();
  });

  it('a decision with no pane (written before #4304) is not taken for the pane a tick knows', () => {
    const decision = { promptData: proceed('npm test'), grant: null, epoch: 0 };
    recordAutoYesDecision(KEY, { ...decision, state: 'answering', reason: null });
    expect(reaffirmAutoYesAnswering(KEY, { ...decision, pane: { kind: 'pane', generation: G } })).toBe(false);
  });
});

describe('[#4304 F1-a §3.3-2] a hold kept by a hot reload from before #4304 has no pane: it is not taken for this pane\'s', () => {
  function keptHold(origin?: { kind: 'pane'; generation: PaneGeneration }): void {
    globalThis.__autoYesPartialAnswers?.set(KEY, {
      screenKey: partialAnswerScreenKey(proceed('npm test')),
      epoch: getEnterFallbackSessionEpoch(KEY),
      at: now,
      seq: 1,
      ...(origin !== undefined ? { origin } : {}),
    } as never);
  }

  it('positive: a hold with no origin does not keep a tick that knows its pane off the prompt', async () => {
    keptHold();
    expect(await tickOn(pollerState(), proceed('npm test'), G)).toBe('responded');
  });

  it('negative: a hold about this very pane G still does', async () => {
    keptHold({ kind: 'pane', generation: G });
    expect(await tickOn(pollerState(), proceed('npm test'), G)).toBe('no_answer');
  });
});
