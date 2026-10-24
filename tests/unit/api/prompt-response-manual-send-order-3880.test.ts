/**
 * A person's answer that ends late, or with no screen read, or while a tick
 * waits, holds what IT did and nothing else (Issue #3880, review 2: N1〜N4).
 *
 * - N1: the end of a manual answer is matched to that answer — the order it
 *   began in, the screen and the session epoch fixed right before its first
 *   key. A late answer that goes through does not release the hold a later
 *   person's send left; a late failure records nothing after a relaunch or
 *   after its prompt was seen gone, and does not overwrite a later hold.
 * - N2: a send made after the capture failed (no prompt read) that ends with
 *   its outcome unknown still holds — the first confirmation read after it —
 *   until a frame with no prompt, another confirmation, or a relaunch.
 * - N3: a tick waiting on the ownership check when a person's send ends that
 *   way types nothing after the wait.
 * - N4: agy's dialog past the receipt window keeps a person's hold, and says
 *   why (`partial-answer`).
 *
 * Runs the real route, answer resolution and delivery, `sendPromptAnswer` and
 * `detectAndRespondToPrompt`; the screen reading, the frame verification and
 * the tmux module are stubbed (tmux failing as `TmuxSendError` does).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Held open by a test while a manual answer ends under a tick waiting on it. */
const ownership = vi.hoisted(() => ({ gate: null as Promise<void> | null, entered: () => {} }));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => {
    ownership.entered();
    if (ownership.gate) await ownership.gate;
    return { verdict: 'owned', sessionPath: null };
  }),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

/** Every key that reached the pane, in order (a key that landed and then timed out included). */
let delivered: string[] = [];
/**
 * What each typed text (`sendKeys` without Enter) does, one per send in the
 * order the sends reach tmux: told when it is entered, held until `gate`
 * resolves, then landing — or failing the way the real tmux module reports it
 * (`indeterminate`: the key landed and the call timed out; `not-started`:
 * refused before any key). No step: it lands. The Enter after it always lands.
 */
interface SendStep {
  entered?: () => void;
  gate?: Promise<void>;
  fail?: 'not-started' | 'indeterminate';
}
let steps: SendStep[] = [];
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(async () => ''),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    if (enter) {
      delivered.push(`${keys}<Enter>`);
      return;
    }
    const step = steps.shift() ?? {};
    step.entered?.();
    if (step.gate) await step.gate;
    if (step.fail !== undefined) {
      if (step.fail === 'indeterminate') delivered.push(keys);
      throw Object.assign(new Error('Failed to send keys to tmux session: Command failed'), {
        name: 'TmuxSendError',
        delivery: step.fail,
        keysDelivered: 0,
      });
    }
    delivered.push(keys);
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

// The route's own collaborators.
/** The prompt the route's fresh capture reads; `captureFailed`: that capture failed. */
const route = vi.hoisted(() => ({ prompt: null as unknown, captureFailed: false }));
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
  // The capture failing: what `verifyPromptOnScreen` hands on (it does not
  // block a manual answer, frame-verification.ts `captureFrame`).
  verifyPromptOnScreen: vi.fn(async () => ({
    value: route.captureFailed
      ? { promptCheck: null, verifiedFrame: null, isCommandCodeQuestion: false, verificationFailed: true }
      : {
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

/**
 * What the reading returns this tick. `gated`: agy's receipt gate withholds
 * the dialog from the reading that carries the receipt scope (past the
 * window); the reading without it still sees it.
 */
const screen = vi.hoisted(() => ({ prompt: null as unknown, gated: false }));
vi.mock('@/lib/polling/response-checker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/response-checker')>()),
  detectPromptOnCleanFrame: (...args: unknown[]) =>
    screen.prompt === null || (screen.gated && args[4] !== undefined)
      ? { isPrompt: false }
      : { isPrompt: true, promptData: screen.prompt },
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
  stopAllAutoYesPolling,
  type AutoYesPollerState,
  type AutoYesTickGeneration,
} from '@/lib/auto-yes-poller';
import { POST } from '@/app/api/worktrees/[id]/prompt-response/route';
import {
  clearManualAnswers,
  getManualAnswerSeq,
  MANUAL_ANSWER_HOLD_MS,
  noteManualAnswerStarted,
  noteManualSendStarting,
  settleManualAnswer,
} from '@/lib/polling/auto-yes-manual-answer';
import { clearPartialAnswers, getPartialAnswer } from '@/lib/polling/auto-yes-poller-state';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  beginEnterFallbackSession,
  getEnterFallbackSessionEpoch,
} from '@/lib/polling/auto-yes-enter-fallback-state';
import { buildCompositeKey, clearAllAutoYesStates, getAutoYesState, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  resetAutoYesConfirmationLedgerForTests,
  setAutoYesLedgerClockTimersForTests,
} from '@/lib/polling/auto-yes-confirmation-ledger';

const WORKTREE_ID = 'wt-3880-order';
const KEY = buildCompositeKey(WORKTREE_ID, 'claude', 'claude');
const T0 = new Date('2026-10-24T14:00:00.000Z').getTime();
let now = T0;

const proceed = (command: string): PromptData => ({
  type: 'yes_no',
  question: 'Do you want to proceed?',
  status: 'pending',
  options: ['yes', 'no'],
  approvalTarget: command,
});

function pollerState(cliToolId: 'claude' | 'antigravity' = 'claude'): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId,
    instanceId: cliToolId,
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

async function tickOn(
  state: AutoYesPollerState,
  prompt: PromptData | null,
  generation?: AutoYesTickGeneration,
): Promise<string> {
  screen.prompt = prompt;
  const result = await detectAndRespondToPrompt(
    WORKTREE_ID,
    state,
    state.cliToolId,
    'pane',
    ['pane'],
    state.instanceId,
    undefined,
    generation,
  );
  now += 2_000;
  return result;
}

/** A person answers `y` at the prompt the route's capture reads; resolves to the status. */
async function personAnswers(prompt: PromptData): Promise<number> {
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A send step held until released; `entered` resolves once its text reached tmux. */
function heldStep(fail?: SendStep['fail']): { step: SendStep; entered: Promise<void>; release: () => void } {
  const gate = deferred();
  const entered = deferred();
  return {
    step: { entered: entered.resolve, gate: gate.promise, ...(fail !== undefined ? { fail } : {}) },
    entered: entered.promise,
    release: gate.resolve,
  };
}

/** A person's answer that starts now and is held in its first key until released. */
async function personAnswersHeld(
  prompt: PromptData,
  fail?: SendStep['fail'],
): Promise<{ release: () => void; status: Promise<number> }> {
  const held = heldStep(fail);
  steps.push(held.step);
  const status = personAnswers(prompt);
  await held.entered;
  return { release: held.release, status };
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
  steps = [];
  route.prompt = null;
  route.captureFailed = false;
  screen.prompt = null;
  screen.gated = false;
  ownership.gate = null;
  ownership.entered = () => {};
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
  stopAllAutoYesPolling();
  clearAllAutoYesStates();
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

describe('[#3880 N1] a manual answer that ends late changes only what it did', () => {
  it('a late answer that goes through does not release the hold a later person\'s send left', async () => {
    const a = await personAnswersHeld(proceed('npm test'));
    steps.push({ fail: 'indeterminate' });
    expect(await personAnswers(proceed('npm test'))).toBe(500);
    a.release();
    expect(await a.status).toBe(200);

    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(pollerState(), proceed('npm test'))).toBe('no_answer');
    // B's `y` (timed out), A's `y` and Enter — and nothing from Auto-Yes.
    expect(delivered).toEqual(['y', 'y', '<Enter>']);
  });

  it('negative: with no later send, the late answer releases the hold recorded before it', async () => {
    steps.push({ fail: 'indeterminate' });
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('error');
    const a = await personAnswersHeld(proceed('npm test'));
    a.release();
    expect(await a.status).toBe(200);

    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('a late earlier failure does not overwrite the hold of a later person\'s send', async () => {
    const a = await personAnswersHeld(proceed('npm test'), 'indeterminate');
    steps.push({ fail: 'indeterminate' });
    expect(await personAnswers(proceed('npm run build'))).toBe(500);
    a.release();
    expect(await a.status).toBe(500);

    now += MANUAL_ANSWER_HOLD_MS;
    // The later send's screen is the one held, not the earlier one's.
    expect(await tickOn(pollerState(), proceed('npm run build'))).toBe('no_answer');
  });

  it('a late failure after a relaunch records nothing for the new session', async () => {
    const a = await personAnswersHeld(proceed('npm test'), 'indeterminate');
    beginEnterFallbackSession(WORKTREE_ID, 'claude', 'claude');
    a.release();
    expect(await a.status).toBe(500);

    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(pollerState(), proceed('npm test'))).toBe('responded');
  });

  it('a late failure after its prompt was seen gone records nothing', async () => {
    const a = await personAnswersHeld(proceed('npm test'), 'indeterminate');
    const state = pollerState();
    expect(await tickOn(state, null)).toBe('no_prompt');
    a.release();
    expect(await a.status).toBe(500);

    now += MANUAL_ANSWER_HOLD_MS;
    // The same command asked again: a new confirmation, answered.
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('negative: the same late failure with nothing in between holds the confirmation', async () => {
    const a = await personAnswersHeld(proceed('npm test'), 'indeterminate');
    a.release();
    expect(await a.status).toBe(500);

    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(pollerState(), proceed('npm test'))).toBe('no_answer');
    expect(delivered).toEqual(['y']);
  });
});

describe('[#3880 N2] the capture before the person\'s send failed', () => {
  it('outcome unknown: the tick after the manual hold does not type again', async () => {
    route.captureFailed = true;
    steps.push({ fail: 'indeterminate' });
    expect(await personAnswers(proceed('npm test'))).toBe(500);

    now += MANUAL_ANSWER_HOLD_MS;
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(getLastPolicySuppression(WORKTREE_ID, 'claude', 'claude')?.reason).toBe('partial-answer');
    expect(delivered).toEqual(['y']);
  });

  it('negative: once read as the first confirmation, another one after it is answered', async () => {
    route.captureFailed = true;
    steps.push({ fail: 'indeterminate' });
    await personAnswers(proceed('npm test'));

    now += MANUAL_ANSWER_HOLD_MS;
    const state = pollerState();
    expect(await tickOn(state, proceed('npm test'))).toBe('no_answer');
    expect(await tickOn(state, proceed('npm run build'))).toBe('responded');
  });

  it('negative: a frame with no prompt releases it', async () => {
    route.captureFailed = true;
    steps.push({ fail: 'indeterminate' });
    await personAnswers(proceed('npm test'));

    const state = pollerState();
    expect(await tickOn(state, null)).toBe('no_prompt');
    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(state, proceed('npm test'))).toBe('responded');
  });

  it('negative: refused by tmux before any key: nothing is held', async () => {
    route.captureFailed = true;
    steps.push({ fail: 'not-started' });
    expect(await personAnswers(proceed('npm test'))).toBe(500);

    now += MANUAL_ANSWER_HOLD_MS;
    expect(await tickOn(pollerState(), proceed('npm test'))).toBe('responded');
  });
});

describe('[#3880 N3] a tick waiting on the ownership check when a person\'s send fails', () => {
  /**
   * Auto-Yes on, and a tick of its poller as `pollAutoYes` hands it over. The
   * poller's state is registered without its timer, so no tick runs but these.
   */
  function enable(): { state: AutoYesPollerState; generation: () => AutoYesTickGeneration } {
    setAutoYesEnabled(WORKTREE_ID, 'claude', true, 3_600_000, undefined, 'claude');
    const state = pollerState();
    globalThis.__autoYesPollerStates!.set(KEY, state);
    return {
      state,
      generation: () => ({
        manualAnswerSeq: getManualAnswerSeq(KEY),
        compositeKey: KEY,
        worktreeId: WORKTREE_ID,
        cliToolId: 'claude',
        instanceId: 'claude',
        pollerState: state,
        grant: getAutoYesState(WORKTREE_ID, 'claude', 'claude')!,
        sessionEpoch: getEnterFallbackSessionEpoch(KEY),
        startedAt: Date.now(),
      }),
    };
  }

  async function tickHeldAtOwnership(
    state: AutoYesPollerState,
    generation: AutoYesTickGeneration,
  ): Promise<{ release: () => void; result: Promise<string> }> {
    const gate = deferred();
    const entered = deferred();
    ownership.gate = gate.promise;
    ownership.entered = entered.resolve;
    const result = tickOn(state, proceed('npm test'), generation);
    await entered.promise;
    return { release: gate.resolve, result };
  }

  it('the send ends with its outcome unknown during the wait: the tick types nothing after it', async () => {
    const { state, generation } = enable();
    const a = await personAnswersHeld(proceed('npm test'), 'indeterminate');
    now += MANUAL_ANSWER_HOLD_MS;
    // Past the manual hold, and nothing held yet: the tick goes on to the wait.
    const t = await tickHeldAtOwnership(state, generation());
    a.release();
    expect(await a.status).toBe(500);
    t.release();

    expect(await t.result).toBe('no_answer');
    expect(delivered).toEqual(['y']);
  });

  it('negative: refused before any key during the wait: the tick answers', async () => {
    const { state, generation } = enable();
    const a = await personAnswersHeld(proceed('npm test'), 'not-started');
    now += MANUAL_ANSWER_HOLD_MS;
    const t = await tickHeldAtOwnership(state, generation());
    a.release();
    expect(await a.status).toBe(500);
    t.release();

    expect(await t.result).toBe('responded');
  });
});

describe('[#3880 N4] agy: a person\'s hold past the receipt window', () => {
  const AGY_KEY = buildCompositeKey(WORKTREE_ID, 'antigravity', 'antigravity');

  /** A person's send to agy's dialog that ended with its keys maybe on the pane. */
  function personsSendMayBeOnPane(dialog: PromptData): void {
    const answer = noteManualAnswerStarted(AGY_KEY, now);
    noteManualSendStarting(answer, dialog);
    settleManualAnswer(answer, 'may-be-on-pane', now);
  }

  it('the dialog still up: the hold stays, published as partial-answer', async () => {
    const dialog = proceed('rm -rf build');
    personsSendMayBeOnPane(dialog);
    // Past agy's 8-second receipt window, still inside the 10-second manual hold.
    now += 9_000;
    screen.gated = true;
    const state = pollerState('antigravity');
    expect(await tickOn(state, dialog)).toBe('no_prompt');

    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity')?.reason).toBe('partial-answer');
    expect(getPartialAnswer(AGY_KEY, getEnterFallbackSessionEpoch(AGY_KEY))).not.toBeNull();
    // And a later reading that sees the dialog again (a receipt let it through) still holds it.
    now += MANUAL_ANSWER_HOLD_MS;
    screen.gated = false;
    expect(await tickOn(state, dialog)).toBe('no_answer');
    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity')?.reason).toBe('partial-answer');
    expect(delivered).toEqual([]);
  });

  it('negative: the dialog gone: the hold goes, and no partial-answer is published', async () => {
    personsSendMayBeOnPane(proceed('rm -rf build'));
    now += 9_000;
    const state = pollerState('antigravity');
    expect(await tickOn(state, null)).toBe('no_prompt');

    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity')?.reason).not.toBe('partial-answer');
    expect(getPartialAnswer(AGY_KEY, getEnterFallbackSessionEpoch(AGY_KEY))).toBeNull();
  });

  it('negative: another dialog past the window is not taken for the held one', async () => {
    personsSendMayBeOnPane(proceed('rm -rf build'));
    now += 9_000;
    screen.gated = true;
    expect(await tickOn(pollerState('antigravity'), proceed('git push'))).toBe('no_prompt');

    expect(getLastPolicySuppression(WORKTREE_ID, 'antigravity', 'antigravity')?.reason).not.toBe('partial-answer');
    expect(getPartialAnswer(AGY_KEY, getEnterFallbackSessionEpoch(AGY_KEY))).toBeNull();
  });
});
