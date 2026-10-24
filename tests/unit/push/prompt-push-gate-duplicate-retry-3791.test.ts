/**
 * Issue #3791 (item 1, the rest): the Auto-Yes hold reaches the duplicate
 * guard's retry.
 *
 * The 9 s grace counts from the poller's last answer and assumes the next
 * prompt is answered a cooldown later. The duplicate guard (#306) does not
 * answer a prompt with the same type and question as the one it answered
 * (`lastAnsweredPromptKey`) for `DUPLICATE_RETRY_EXPIRY_MS` (10 s) — Claude's
 * consecutive Bash approvals all ask `Do you want to proceed?` — and answers
 * it on the first tick after that. So such a prompt is answered 10 s plus a
 * tick after the last answer, and before this fix the gate notified once
 * `auto-yes-not-answered` at 9 s. The hold now also reaches the guard's retry
 * plus two ticks while the poller reports that the guard actually held this
 * wait's prompt back (`duplicateRetryReservation`, Codex review N1) — not on
 * `lastAnsweredAt` alone, which outlives a tick that reads another screen or
 * fails. `auto-yes-duplicate-retry-reservation-3791.test.ts` (tests/unit/polling)
 * drives the real tick that sets and releases it.
 *
 * Positive controls fail on the gate before this fix (they notify at 9 s
 * after the answer); negative controls hold the 9 s behaviour for a wait the
 * poller is not about to answer. Scaffold as in
 * `prompt-push-gate-next-tick-3791.test.ts`: real database, only `web-push`
 * stubbed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { upsertPushSubscription } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  AUTO_YES_ANSWER_AFTER_TICK_MS,
  AUTO_YES_ANSWER_GRACE_MS,
  autoYesHoldEndsAt,
  clearAutoYesHolds,
  decideAndLogPromptPush,
  isPromptPushSuppressed,
} from '@/lib/push/prompt-push-gate';
import { DUPLICATE_RETRY_EXPIRY_MS, POLLING_INTERVAL_MS } from '@/lib/auto-yes-state';
import {
  isDuplicatePrompt,
  releaseDuplicateRetry,
  reserveDuplicateRetry,
} from '@/lib/polling/auto-yes-poller-generation';
import { calculateBackoffInterval, COOLDOWN_INTERVAL_MS } from '@/lib/auto-yes-state';
import { clearPolicySuppressions, recordPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3791-dup';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

/** Let the fire-and-forget fan-out reach `web-push`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function payloads(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as Record<string, unknown>
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-3791', '/tmp/repo', 'repo', T0);
  upsertPushSubscription(db, { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a', locale: 'en' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  setVapidDetails.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });

  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  stopWaitingPushNotifier();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });

  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  vi.useRealTimers();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Open the wait this file is about. */
function startWaiting(instanceId?: string, now = T0): void {
  observeWaitingEdge({
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId,
    waiting: true,
    kind: 'prompt',
    now,
  });
}

/**
 * Put an Auto-Yes poller state under the default instance of this worktree, as
 * the poller keeps it on `globalThis`, and return it (its identity is what the
 * gate checks). `sessionWaitTickAt` is the session wait's pending tick.
 */
function putPoller(fields: Partial<AutoYesPollerState> = {}): AutoYesPollerState {
  const states = (globalThis.__autoYesPollerStates ??= new Map<string, AutoYesPollerState>());
  const state = { lastServerResponseTimestamp: null, consecutiveErrors: 0, currentInterval: POLLING_INTERVAL_MS, ...fields } as AutoYesPollerState;
  states.set(buildCompositeKey(WT, 'claude'), state);
  return state;
}

function dropPoller(): void {
  globalThis.__autoYesPollerStates?.delete(buildCompositeKey(WT, 'claude'));
}

const ANSWERED_AT = T0;
/** When the identical prompt's wait opened: 1 s after the answer. */
const OPENED_AT = T0 + 1_000;
const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: OPENED_AT };
/** When the duplicate guard lets the poller answer again, plus its two ticks. */
const RETRY_HOLD_ENDS_AT = ANSWERED_AT + DUPLICATE_RETRY_EXPIRY_MS + AUTO_YES_ANSWER_AFTER_TICK_MS;

const PROMPT_KEY = 'multiple_choice:Do you want to proceed?';

/** The poller just answered a prompt whose key the guard now holds. */
function answeredJustNow(): AutoYesPollerState {
  return putPoller({
    lastServerResponseTimestamp: ANSWERED_AT,
    lastAnsweredPromptKey: PROMPT_KEY,
    lastAnsweredAt: ANSWERED_AT,
  });
}

/** The poller's tick at `at` found the same prompt and the guard held it back (review N1). */
function guardHeldBack(poller: AutoYesPollerState, at: number): void {
  expect(isDuplicatePrompt(poller, PROMPT_KEY)).toBe(true);
  reserveDuplicateRetry(poller, PROMPT_KEY, at);
}

/** When the poller's first tick after the answer runs: a cooldown later. */
const COOLDOWN_TICK_AT = ANSWERED_AT + COOLDOWN_INTERVAL_MS;

describe('[#3791] the hold reaches the duplicate guard\'s retry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(OPENED_AT);
    clearAutoYesHolds();
    dropPoller();
  });

  afterEach(() => {
    clearAutoYesHolds();
    dropPoller();
  });

  it('the premise: the guard holds the same prompt back past the 9 s after the answer', () => {
    const poller = answeredJustNow();
    vi.setSystemTime(ANSWERED_AT + AUTO_YES_ANSWER_GRACE_MS);
    expect(isDuplicatePrompt(poller, 'multiple_choice:Do you want to proceed?')).toBe(true);
    vi.setSystemTime(ANSWERED_AT + DUPLICATE_RETRY_EXPIRY_MS);
    expect(isDuplicatePrompt(poller, 'multiple_choice:Do you want to proceed?')).toBe(false);
  });

  it('positive: the identical prompt the poller answers after the guard expires sends nothing', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = answeredJustNow();

    startWaiting(undefined, OPENED_AT);
    await flush();
    await vi.advanceTimersByTimeAsync(COOLDOWN_TICK_AT - OPENED_AT);
    guardHeldBack(poller, Date.now());
    // 9 s after the answer, the guard still holds: before this fix, the one false notification.
    await vi.advanceTimersByTimeAsync(ANSWERED_AT + DUPLICATE_RETRY_EXPIRY_MS + POLLING_INTERVAL_MS - COOLDOWN_TICK_AT - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    // The first tick past the guard answers it: the wait closes.
    await vi.advanceTimersByTimeAsync(1);
    poller.lastServerResponseTimestamp = Date.now();
    poller.lastAnsweredAt = Date.now();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: Date.now() });
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('positive: the guard expired and nothing answered — it notifies two ticks after the retry, once', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = answeredJustNow();

    startWaiting(undefined, OPENED_AT);
    await flush();
    await vi.advanceTimersByTimeAsync(COOLDOWN_TICK_AT - OPENED_AT);
    guardHeldBack(poller, Date.now());
    await vi.advanceTimersByTimeAsync(RETRY_HOLD_ENDS_AT - COOLDOWN_TICK_AT - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ kind: 'prompt' });

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
    await flush();
    expect(payloads()).toHaveLength(1);
  });

  it('positive (response-checker path): held past 9 s after the answer, then "not answered" after the retry', () => {
    setAutoYesEnabled(WT, 'claude', true);
    guardHeldBack(answeredJustNow(), OPENED_AT);

    expect(isPromptPushSuppressed({ ...gate, now: OPENED_AT })).toBe(true);
    expect(isPromptPushSuppressed({ ...gate, now: OPENED_AT + AUTO_YES_ANSWER_GRACE_MS })).toBe(true);
    expect(decideAndLogPromptPush({ ...gate, now: RETRY_HOLD_ENDS_AT }).reason).toBe('auto-yes-not-answered');
  });

  it('negative: no answer in the guard (a screen nobody answered) is the 9 s hold', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ lastAnsweredPromptKey: null, lastAnsweredAt: null });

    startWaiting(undefined, OPENED_AT);
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('negative: a tick without a prompt since the answer (the guard cleared) is the 9 s hold from the answer', () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ lastServerResponseTimestamp: ANSWERED_AT, lastAnsweredPromptKey: null, lastAnsweredAt: null });
    expect(autoYesHoldEndsAt(gate, OPENED_AT)).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: a guard that expired long ago does not extend the hold', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({
      lastServerResponseTimestamp: OPENED_AT - 60_000,
      lastAnsweredPromptKey: PROMPT_KEY,
      lastAnsweredAt: OPENED_AT - 60_000,
    });
    poller.duplicateRetryReservation = { promptKey: PROMPT_KEY, answeredAt: OPENED_AT - 60_000, observedAt: OPENED_AT };
    expect(autoYesHoldEndsAt(gate, OPENED_AT)).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: no poller (stopped, or never started) is the 9 s hold', () => {
    setAutoYesEnabled(WT, 'claude', true);
    expect(autoYesHoldEndsAt(gate, OPENED_AT)).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: a recorded policy suppression still notifies at once', () => {
    setAutoYesEnabled(WT, 'claude', true);
    guardHeldBack(answeredJustNow(), OPENED_AT);
    recordPolicySuppression(
      WT,
      'claude',
      undefined,
      { reason: 'question-left-to-human', mode: null, promptType: 'multiple_choice' },
      OPENED_AT,
    );
    expect(decideAndLogPromptPush({ ...gate, now: OPENED_AT }).reason).toBe('policy-withheld');
  });

  // Codex review N1: an answer alone (`lastAnsweredAt`) is not the guard holding this wait.

  it('negative (N1): another screen after a successful answer — the guard did not hold it — notifies at 9 s', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = answeredJustNow();

    startWaiting(undefined, OPENED_AT);
    await flush();
    // The cooldown tick read a different prompt: the guard's key did not match, nothing reserved.
    await vi.advanceTimersByTimeAsync(COOLDOWN_TICK_AT - OPENED_AT);
    expect(isDuplicatePrompt(poller, 'multiple_choice:Pick one')).toBe(false);
    releaseDuplicateRetry(poller);
    expect(poller.lastAnsweredAt).toBe(ANSWERED_AT);

    await vi.advanceTimersByTimeAsync(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS - COOLDOWN_TICK_AT - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(payloads()).toHaveLength(1);
  });

  it('negative (N1): an error backoff after a successful answer notifies at 9 s, even after a reservation', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = answeredJustNow();

    startWaiting(undefined, OPENED_AT);
    await flush();
    await vi.advanceTimersByTimeAsync(COOLDOWN_TICK_AT - OPENED_AT);
    guardHeldBack(poller, Date.now());
    // The next tick's capture failed: the poller backs off and drops the reservation.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    poller.consecutiveErrors = 1;
    poller.currentInterval = calculateBackoffInterval(1);
    releaseDuplicateRetry(poller);
    expect(poller.lastAnsweredAt).toBe(ANSWERED_AT);

    await vi.advanceTimersByTimeAsync(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS - Date.now() - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(payloads()).toHaveLength(1);
  });

  it('negative (N1): a reservation for an earlier answer does not extend the hold of a later one', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = answeredJustNow();
    guardHeldBack(poller, OPENED_AT);
    // Answered again since; the guard now counts from the new answer and has held nothing back yet.
    const answeredAgainAt = OPENED_AT + 2_000;
    poller.lastServerResponseTimestamp = answeredAgainAt;
    poller.lastAnsweredAt = answeredAgainAt;
    expect(autoYesHoldEndsAt(gate, answeredAgainAt)).toBe(answeredAgainAt + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative (N1): a reservation made before this wait opened is not this wait\'s', () => {
    setAutoYesEnabled(WT, 'claude', true);
    guardHeldBack(answeredJustNow(), OPENED_AT - 1);
    expect(autoYesHoldEndsAt(gate, OPENED_AT)).toBe(OPENED_AT + AUTO_YES_ANSWER_GRACE_MS);
  });
});
