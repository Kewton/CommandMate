/**
 * Issue #3791 (Codex review N1): the poller publishes that the duplicate guard
 * (#306) actually held back the prompt on screen, and the push gate extends the
 * Auto-Yes hold to the guard's retry only on that reservation.
 *
 * Before this, the gate extended the hold on `lastAnsweredAt` alone. That time
 * survives a tick that reads another screen the poller will not answer (the
 * guard also needs the prompt key to match) and a failed tick (backoff), so
 * those waits notified at answer + 14 s instead of the usual 9 s. Each positive
 * control below drives the real poller tick and then asks the real gate; the
 * premise lines (`lastAnsweredAt` still set) are what the old gate extended on.
 *
 * Transport stubbed at both ends, as in `auto-yes-decision-3821.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Held open by a test while it asks the gate mid-tick (review N3). */
let ownershipGate: Promise<void> | null = null;
let ownershipVerdict: 'owned' | 'foreign' = 'owned';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: async () => {
    if (ownershipGate) await ownershipGate;
    return { verdict: ownershipVerdict, sessionPath: null };
  },
}));

import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: unknown) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params),
}));
vi.mock('@/lib/tmux/tmux', () => ({ sendSpecialKeys: vi.fn(async () => {}) }));
vi.mock('@/lib/polling/auto-yes-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-policy')>();
  return { ...actual, getSessionAutoYesPolicy: () => null };
});
const captureSessionOutput = vi.fn(async (..._args: unknown[]) => '');
const getSessionPresence = vi.fn(async (..._args: unknown[]) => 'present');
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...args: unknown[]) => captureSessionOutput(...args),
  captureSessionOutputFresh: vi.fn(async () => ''),
  getSessionPresence: (...args: unknown[]) => getSessionPresence(...args),
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
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? id}`,
      }),
    }),
  },
}));

import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  startAutoYesPolling,
  stopAllAutoYesPolling,
  type AutoYesPollerState,
  type AutoYesTickGeneration,
} from '@/lib/auto-yes-poller';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  COOLDOWN_INTERVAL_MS,
  DUPLICATE_RETRY_EXPIRY_MS,
  disableAutoYes,
  getAutoYesState,
  POLLING_INTERVAL_MS,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { getEnterFallbackSessionEpoch } from '@/lib/polling/auto-yes-enter-fallback';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearManualAnswers, getManualAnswerSeq } from '@/lib/polling/auto-yes-manual-answer';
import { clearAutoYesDecisions } from '@/lib/polling/auto-yes-decision-state';
import {
  AUTO_YES_ANSWER_AFTER_TICK_MS,
  AUTO_YES_ANSWER_GRACE_MS,
  autoYesHoldEndsAt,
  clearAutoYesHolds,
  decideAndLogPromptPush,
} from '@/lib/push/prompt-push-gate';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';

const WT = 'wt-3791-n1';
const KEY = buildCompositeKey(WT, 'claude');
const T0 = 1_800_000_000_000;

/** A permission-shaped choice claude's rules read and Auto-Yes answers (`1`). */
const PERMISSION = 'Select an option:\n❯ 1. Yes\n  2. No';
/** A numbered list claude's dialog rules decline (#3397): another screen, left to a human. */
const UNRECOGNISED_LIST = [
  '⏺ Pick one',
  '',
  '❯ 1. On-premises deployment',
  '  2. Cloud-managed platform',
  '  3. Kubernetes',
  '',
  '  Which one?',
].join('\n');

function poller(): AutoYesPollerState {
  return globalThis.__autoYesPollerStates!.get(KEY)!;
}

function generationOf(state: AutoYesPollerState): AutoYesTickGeneration {
  return {
    manualAnswerSeq: getManualAnswerSeq(KEY),
    compositeKey: KEY,
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: undefined,
    pollerState: state,
    grant: getAutoYesState(WT, 'claude')!,
    sessionEpoch: getEnterFallbackSessionEpoch(KEY),
    startedAt: Date.now(),
  };
}

/** One tick of the running poller over `raw`, as `pollAutoYes` hands it over. */
function tick(raw: string): Promise<string> {
  const state = poller();
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, 'claude', clean, clean.split('\n'), undefined, raw, generationOf(state));
}

/** The wait the gate holds: opened 1 s after the answer. */
const OPENED_AT = T0 + 1_000;
const wait = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: OPENED_AT };
const RETRY_HOLD_ENDS_AT = T0 + DUPLICATE_RETRY_EXPIRY_MS + AUTO_YES_ANSWER_AFTER_TICK_MS;

/**
 * Answer the permission at T0, and open the next wait at OPENED_AT, where the
 * gate first holds it (as the notifier and the response checker do on the edge).
 */
async function answeredThenWaiting(): Promise<void> {
  setAutoYesEnabled(WT, 'claude', true, 3_600_000);
  expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
  expect(await tick(PERMISSION)).toBe('responded');
  vi.setSystemTime(OPENED_AT);
  // Before the poller's next tick: nothing reserved yet, the usual hold.
  expect(poller().duplicateRetryReservation ?? null).toBeNull();
  expect(autoYesHoldEndsAt(wait, OPENED_AT)).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
}

/** The cooldown tick after the answer. */
function atCooldownTick(): void {
  vi.setSystemTime(T0 + COOLDOWN_INTERVAL_MS);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  captureSessionOutput.mockImplementation(async () => '');
  sendPromptAnswer.mockImplementation(async () => {});
  ownershipGate = null;
  ownershipVerdict = 'owned';
  getSessionPresence.mockImplementation(async () => 'present');
  clearManualAnswers();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesDecisions();
  clearAutoYesHolds();
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllAutoYesStates();
  clearAutoYesDecisions();
  clearPolicySuppressions();
  clearAutoYesHolds();
  db.close();
  vi.useRealTimers();
});

describe('[#3791 N1] the poller reserves the duplicate guard\'s retry only when the guard held the prompt back', () => {
  it('positive: the same prompt held back by the guard is reserved, and the gate holds until the retry', async () => {
    await answeredThenWaiting();
    atCooldownTick();
    expect(await tick(PERMISSION)).toBe('duplicate');
    expect(poller().duplicateRetryReservation).toEqual({
      promptKey: poller().lastAnsweredPromptKey,
      answeredAt: T0,
      observedAt: T0 + COOLDOWN_INTERVAL_MS,
    });
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(RETRY_HOLD_ENDS_AT);
  });

  it('negative: another screen after the answer (resolver leaves it to a human) — released, the usual 9 s', async () => {
    await answeredThenWaiting();
    atCooldownTick();
    expect(await tick(PERMISSION)).toBe('duplicate');

    vi.setSystemTime(T0 + COOLDOWN_INTERVAL_MS + POLLING_INTERVAL_MS);
    expect(await tick(UNRECOGNISED_LIST)).toBe('no_answer');
    // The premise: the answer the old gate extended on is still there.
    expect(poller().lastAnsweredAt).toBe(T0);
    expect(poller().duplicateRetryReservation).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: another screen straight after the answer (never reserved) — the usual 9 s', async () => {
    await answeredThenWaiting();
    atCooldownTick();
    expect(await tick(UNRECOGNISED_LIST)).toBe('no_answer');
    expect(poller().lastAnsweredAt).toBe(T0);
    expect(poller().duplicateRetryReservation ?? null).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: a failed capture (error backoff) after the answer — released, the usual 9 s', async () => {
    await answeredThenWaiting();
    atCooldownTick();
    expect(await tick(PERMISSION)).toBe('duplicate');
    expect(poller().duplicateRetryReservation).not.toBeNull();

    // The poller's own scheduled tick, whose capture fails.
    captureSessionOutput.mockRejectedValue(new Error('capture failed'));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(captureSessionOutput).toHaveBeenCalled();
    expect(poller().consecutiveErrors).toBe(1);
    expect(poller().lastAnsweredAt).toBe(T0);
    expect(poller().duplicateRetryReservation).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: the session went away (the session wait) — released, the usual 9 s', async () => {
    await answeredThenWaiting();
    atCooldownTick();
    expect(await tick(PERMISSION)).toBe('duplicate');

    captureSessionOutput.mockRejectedValue(new Error('no session'));
    getSessionPresence.mockResolvedValue('absent');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(poller().waitingForSession).toBe(true);
    expect(poller().consecutiveErrors).toBe(0);
    expect(poller().duplicateRetryReservation).toBeNull();
    // Only the session wait's own tick (#3793) can still extend this hold.
    expect(poller().sessionWaitTickAt).toBeGreaterThan(Date.now());
  });

  it('negative: a tick without a prompt — released', async () => {
    await answeredThenWaiting();
    atCooldownTick();
    expect(await tick(PERMISSION)).toBe('duplicate');
    expect(await tick('$ ')).toBe('no_prompt');
    expect(poller().duplicateRetryReservation).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: the poller stopped — no reservation is read', async () => {
    await answeredThenWaiting();
    atCooldownTick();
    expect(await tick(PERMISSION)).toBe('duplicate');
    stopAllAutoYesPolling();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });
});

// ---------------------------------------------------------------------------
// Review N3: the tick that sends the retry keeps the reservation until the send settles
// ---------------------------------------------------------------------------

/** A promise a test resolves by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Another permission, with another question: not the reserved prompt. */
const OTHER_PERMISSION = 'Allow this edit to src/app.ts?\n❯ 1. Yes\n  2. No';

/** When the guard has expired: the first tick after it sends the retry. */
const RETRY_TICK_AT = T0 + DUPLICATE_RETRY_EXPIRY_MS + POLLING_INTERVAL_MS / 2;

/** Answer at T0, the wait held at OPENED_AT, the guard holding the prompt back on its ticks. */
async function reservedUntilTheGuardExpires(): Promise<void> {
  await answeredThenWaiting();
  for (let at = T0 + COOLDOWN_INTERVAL_MS; at < T0 + DUPLICATE_RETRY_EXPIRY_MS; at += POLLING_INTERVAL_MS) {
    vi.setSystemTime(at);
    expect(await tick(PERMISSION)).toBe('duplicate');
  }
  vi.setSystemTime(RETRY_TICK_AT);
}

/** What the response checker's re-check of the same wait decides now. */
function gateReason(): string {
  return decideAndLogPromptPush({ ...wait, now: Date.now() }).reason;
}

describe('[#3791 N3] the retry of the reserved prompt keeps the hold while it is being sent', () => {
  it('positive: held on the ownership check — the hold stays at the retry plus two ticks, then the answer takes over', async () => {
    await reservedUntilTheGuardExpires();
    const gate = deferred();
    ownershipGate = gate.promise;

    const sending = tick(PERMISSION);
    await vi.advanceTimersByTimeAsync(0);
    // Mid-tick, past the 9 s of the hold: still Auto-Yes's to answer.
    expect(Date.now()).toBeGreaterThan(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
    expect(poller().duplicateRetryReservation).not.toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(RETRY_HOLD_ENDS_AT);
    expect(gateReason()).toBe('auto-yes-answering');

    gate.resolve();
    expect(await sending).toBe('responded');
    // The new answer takes over: released, and the hold counts from the answer.
    expect(poller().lastAnsweredAt).toBe(RETRY_TICK_AT);
    expect(poller().duplicateRetryReservation).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(RETRY_TICK_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('positive: held inside the sender — the hold stays at the retry plus two ticks', async () => {
    await reservedUntilTheGuardExpires();
    const gate = deferred();
    sendPromptAnswer.mockImplementation(() => gate.promise);

    const sending = tick(PERMISSION);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(2);
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(RETRY_HOLD_ENDS_AT);
    expect(gateReason()).toBe('auto-yes-answering');

    gate.resolve();
    expect(await sending).toBe('responded');
    expect(poller().duplicateRetryReservation).toBeNull();
  });

  it('the bound: a send still held past the retry plus two ticks no longer holds the wait', async () => {
    await reservedUntilTheGuardExpires();
    const gate = deferred();
    sendPromptAnswer.mockImplementation(() => gate.promise);

    const sending = tick(PERMISSION);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(RETRY_HOLD_ENDS_AT);
    expect(gateReason()).toBe('auto-yes-not-answered');

    gate.resolve();
    await sending;
  });

  it('negative: another prompt held on the ownership check — released before the await, the usual 9 s', async () => {
    await reservedUntilTheGuardExpires();
    const gate = deferred();
    ownershipGate = gate.promise;

    const sending = tick(OTHER_PERMISSION);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller().duplicateRetryReservation).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
    expect(gateReason()).toBe('auto-yes-not-answered');

    gate.resolve();
    expect(await sending).toBe('responded');
  });

  it('negative: the retry withheld (a session another server owns) — released', async () => {
    await reservedUntilTheGuardExpires();
    ownershipVerdict = 'foreign';
    expect(await tick(PERMISSION)).toBe('no_answer');
    expect(poller().lastAnsweredAt).toBe(T0);
    expect(poller().duplicateRetryReservation).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: the retry\'s send fails — released, the usual 9 s', async () => {
    await reservedUntilTheGuardExpires();
    sendPromptAnswer.mockRejectedValue(new Error('send failed'));
    expect(await tick(PERMISSION)).toBe('error');
    expect(poller().lastAnsweredAt).toBe(T0);
    expect(poller().duplicateRetryReservation).toBeNull();
    expect(autoYesHoldEndsAt(wait, Date.now())).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: Auto-Yes switched off during the retry\'s ownership check — released', async () => {
    await reservedUntilTheGuardExpires();
    const gate = deferred();
    ownershipGate = gate.promise;

    const sending = tick(PERMISSION);
    await vi.advanceTimersByTimeAsync(0);
    const state = poller();
    disableAutoYes(WT, 'claude');
    gate.resolve();
    expect(await sending).toBe('no_answer');
    expect(state.duplicateRetryReservation).toBeNull();
    expect(decideAndLogPromptPush({ ...wait, now: Date.now() }).reason).toBe('auto-yes-inactive');
  });
});
