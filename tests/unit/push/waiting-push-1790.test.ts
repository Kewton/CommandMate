/**
 * Waiting-edge driven push notifications (Issue #1790).
 *
 * Driven end-to-end against a real in-memory database with only `web-push`
 * stubbed, because the properties under test are precisely the ones a mocked
 * sender would hide: whether *one* notification leaves the process when two
 * producers report the same wait, and what the body actually says. Asserting on
 * a spied `notifyPushSubscribers` would pass with the dedup deleted.
 *
 * The escalation clock is injected (`runEscalationTick(now)`) rather than
 * mocked globally, except in the one test that exists to prove the interval is
 * really wired to it. CI runs the whole suite in a single process, so the
 * subscription, the outstanding waits and the interval are all torn down in
 * `afterEach`.
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
import { notifyPushSubscribers } from '@/lib/push/push-sender';
import {
  resetNotificationDedup,
  resetWaitingPushDedup,
  shouldSendWaitingPush,
} from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  CLASSIFICATION_GRACE_MS,
  ESCALATION_TICK_MS,
  heldWaitCount,
  pendingEscalationCount,
  runEscalationTick,
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-1790';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

/** Let the fire-and-forget fan-out reach `web-push`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Every notification body handed to web-push, in order. */
function bodies(): string[] {
  return sendNotification.mock.calls.map(
    ([, payload]) => (JSON.parse(payload as string) as { body: string }).body
  );
}

function payloads(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as Record<string, unknown>
  );
}

function subscribe(endpoint: string, locale: string): void {
  upsertPushSubscription(db, { endpoint, p256dh: 'p', auth: 'a', locale });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-1790', '/tmp/repo', 'repo', T0);

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
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  vi.useRealTimers();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('a waiting edge notifies without the response poller', () => {
  it('notifies on an edge nothing but the status probe observed', async () => {
    // The scenario the Issue is about: no poller is running (none is started
    // anywhere in this file), and the wait is reported the way a hooks-only
    // dialog is — through #1786's edge and nothing else.
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(payloads()[0]).toMatchObject({
      kind: 'prompt',
      title: 'feature-x (claude)',
      body: 'Waiting for your reply',
      url: `/worktrees/${WT}`,
      waitingKind: 'prompt',
    });
  });

  it('notifies for a wait no prompt detector could classify', async () => {
    // Coverage pattern 4: a selection list, a pager and a structured-only
    // dialog never reached `promptDetection.isPrompt`, so they never notified.
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'menu', now: T0 });
    await flush();

    expect(bodies()).toEqual(['Needs attention in the terminal']);
  });

  it('notifies a second instance of the same worktree independently', async () => {
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    observeWaitingEdge({
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId: 'claude-2',
      waiting: true,
      kind: 'prompt',
      now: T0 + 1_000,
    });
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(payloads().map((p) => p.title)).toEqual([
      'feature-x (claude)',
      'feature-x (claude-2)',
    ]);
  });
});

describe('one wait produces one notification', () => {
  it('does not double-send when the poller and the edge both report it', async () => {
    // Exactly what `response-checker` does on its prompt branch, in the same
    // order: raise the notification (which still has the prompt's own question)
    // and then open the episode it belongs to.
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    void notifyPushSubscribers({
      worktreeId: WT,
      worktreeName: 'feature-x',
      kind: 'prompt',
      agentName: 'claude',
      instanceId: 'claude',
      waitingKind: 'prompt',
      waitingSince: T0,
      excerpt: 'Continue?',
    });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    // The poller's body wins because it got there first — it is the only one of
    // the two that knows what the agent actually asked.
    expect(bodies()).toEqual(['Waiting for reply: Continue?']);
  });

  it('suppresses a repeat of the same episode however often it is reported', async () => {
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    // A later poll of the same wait: same `since`, different question text.
    await notifyPushSubscribers({
      worktreeId: WT,
      worktreeName: 'feature-x',
      kind: 'prompt',
      agentName: 'claude',
      instanceId: 'claude',
      waitingKind: 'prompt',
      waitingSince: T0,
      excerpt: 'A completely different question?',
    });
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('notifies again once the wait ended and a new one began', async () => {
    // Coverage pattern 2: the second prompt of a turn. Same worktree, same
    // instance, identical question, well inside the old 30 s content window —
    // and it is a different wait, so it notifies.
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: T0 + 2_000 });
    observeWaitingEdge({
      worktreeId: WT,
      cliToolId: 'claude',
      waiting: true,
      kind: 'prompt',
      now: T0 + 4_000,
    });
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('keys the guard on the episode, not on the content', () => {
    expect(shouldSendWaitingPush({ worktreeId: WT, instanceId: 'claude', since: T0 })).toBe(true);
    expect(shouldSendWaitingPush({ worktreeId: WT, instanceId: 'claude', since: T0 })).toBe(false);
    expect(shouldSendWaitingPush({ worktreeId: WT, instanceId: 'claude', since: T0 + 1 })).toBe(true);
    // Another instance of the same worktree is a separate wait.
    expect(shouldSendWaitingPush({ worktreeId: WT, instanceId: 'codex', since: T0 })).toBe(true);
  });
});

describe('the body says what kind of attention is needed', () => {
  // `unclassified` is not in this table because it is not decided on the edge
  // any more — see the Issue #2156 block below, which pins both of its outcomes.
  it.each([
    ['prompt', 'Waiting for your reply', '応答待ちです'],
    ['menu', 'Needs attention in the terminal', '端末の確認が必要です'],
  ] as const)('renders %s in both locales', async (kind, en, ja) => {
    subscribe('https://push.example/en', 'en');
    subscribe('https://push.example/ja', 'ja');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind, now: T0 });
    await flush();

    expect(bodies().sort()).toEqual([en, ja].sort());
  });
});

describe('a wait that has not named itself yet (Issue #2156)', () => {
  /**
   * The whole block runs on fake timers because the property under test *is*
   * the delay: the classification the notification must quote only exists after
   * a later probe has written it, and that write is deliberately not an edge.
   */
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  /** One probe of an open wait. Refreshes the kind; emits nothing (#1786). */
  function probe(kind: 'prompt' | 'menu' | 'unclassified', at: number): void {
    vi.setSystemTime(at);
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind, now: at });
  }

  it('says "waiting for your reply" once the probe classifies it', async () => {
    // The AskUserQuestion session from the Issue: the episode opens before the
    // dialog is on the pane, so the first verdict is `unclassified`, and the
    // probe 6 s later reads it as an answerable prompt.
    subscribe('https://push.example/en', 'en');
    subscribe('https://push.example/ja', 'ja');
    startWaitingPushNotifier();

    probe('unclassified', T0);
    // Nothing has left the process yet — this is the notification that used to
    // go out saying "check the terminal".
    expect(sendNotification).not.toHaveBeenCalled();
    expect(heldWaitCount()).toBe(1);

    probe('prompt', T0 + 6_000);

    await vi.advanceTimersByTimeAsync(CLASSIFICATION_GRACE_MS);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(bodies().sort()).toEqual(['Waiting for your reply', '応答待ちです'].sort());
    expect(payloads()[0]).toMatchObject({ waitingKind: 'prompt' });
    // Held, not duplicated: the wait produced exactly one card per device.
    expect(heldWaitCount()).toBe(0);
    expect(pendingEscalationCount()).toBe(1);
  });

  it('still says "check the terminal" for a wait that never gets named', async () => {
    // The regression guard for the other half of the acceptance criterion: the
    // grace must not turn every unreadable frame into an answerable prompt.
    subscribe('https://push.example/en', 'en');
    subscribe('https://push.example/ja', 'ja');
    startWaitingPushNotifier();

    probe('unclassified', T0);
    probe('unclassified', T0 + 6_000);

    await vi.advanceTimersByTimeAsync(CLASSIFICATION_GRACE_MS);

    expect(bodies().sort()).toEqual(
      ['Needs attention in the terminal', '端末の確認が必要です'].sort()
    );
    expect(payloads()[0]).toMatchObject({ waitingKind: 'unclassified' });
  });

  it('does not hold a wait the probe already named', async () => {
    // `menu` is a positive reading of the pane, not an absence of one, so it
    // notifies on the edge with no delay at all.
    subscribe('https://push.example/en', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'menu', now: T0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(bodies()).toEqual(['Needs attention in the terminal']);
    expect(heldWaitCount()).toBe(0);
  });

  it('sends nothing at all when the wait ends inside the grace', async () => {
    // Auto-Yes, or a human at the terminal. The notification would have been
    // about something already over, so it is dropped rather than corrected.
    subscribe('https://push.example/en', 'en');
    startWaitingPushNotifier();

    probe('unclassified', T0);
    vi.setSystemTime(T0 + 2_000);
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: T0 + 2_000 });

    await vi.advanceTimersByTimeAsync(CLASSIFICATION_GRACE_MS * 2);

    expect(bodies()).toEqual([]);
    expect(heldWaitCount()).toBe(0);
    expect(pendingEscalationCount()).toBe(0);
  });

  it('still earns its reminder after being held', async () => {
    setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });
    subscribe('https://push.example/en', 'en');
    startWaitingPushNotifier();

    probe('unclassified', T0);
    probe('prompt', T0 + 6_000);
    await vi.advanceTimersByTimeAsync(CLASSIFICATION_GRACE_MS);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    runEscalationTick(T0 + 11 * MINUTE);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toBe('Still waiting for your reply (11 min)');
  });
});

describe('escalation', () => {
  beforeEach(() => {
    setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });
  });

  it('re-notifies once, and only once, past the threshold', async () => {
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    runEscalationTick(T0 + 9 * MINUTE);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    runEscalationTick(T0 + 11 * MINUTE);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toBe('Still waiting for your reply (11 min)');

    runEscalationTick(T0 + 30 * MINUTE);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('says "check the terminal" when that is what the wait needs', async () => {
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'menu', now: T0 });
    await flush();

    runEscalationTick(T0 + 12 * MINUTE);
    await flush();
    expect(bodies()[1]).toBe('Still needs attention in the terminal (12 min)');
  });

  it('does not re-notify a wait that has been answered', async () => {
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: T0 + MINUTE });

    runEscalationTick(T0 + 20 * MINUTE);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(pendingEscalationCount()).toBe(0);
  });

  it('does not re-notify when the closing edge was never seen but the wait is over', async () => {
    // The store, not this module's own map, is the authority: an answer given
    // through another surface clears the episode, and the reminder follows.
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();
    clearWaitingEpisodes();

    runEscalationTick(T0 + 20 * MINUTE);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(pendingEscalationCount()).toBe(0);
  });

  it('sends nothing when the reminder is switched off', async () => {
    setPushEscalationSettings({ enabled: false, thresholdMinutes: 10 });
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();

    runEscalationTick(T0 + 60 * MINUTE);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('honours a threshold the user shortened', async () => {
    setPushEscalationSettings({ enabled: true, thresholdMinutes: 5 });
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();

    runEscalationTick(T0 + 6 * MINUTE);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('is driven by an interval that exists only while something is waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await vi.advanceTimersByTimeAsync(ESCALATION_TICK_MS);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(pendingEscalationCount()).toBe(1);

    // No `runEscalationTick` call of our own: the reminder below can only come
    // from the interval this module armed.
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    // Nothing outstanding any more, so the interval is gone with it.
    expect(pendingEscalationCount()).toBe(0);
  });
});

describe('an install without VAPID keys', () => {
  beforeEach(() => {
    for (const key of VAPID_ENV) delete process.env[key];
  });

  it('is inert on every path rather than merely quiet', async () => {
    subscribe('https://push.example/a', 'en');
    startWaitingPushNotifier();

    expect(() =>
      observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 })
    ).not.toThrow();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
    // Not tracked at all: no wait held, so no interval and no database read.
    expect(pendingEscalationCount()).toBe(0);

    expect(() => runEscalationTick(T0 + 60 * MINUTE)).not.toThrow();
    await expect(
      notifyPushSubscribers({
        worktreeId: WT,
        worktreeName: 'feature-x',
        kind: 'prompt',
        waitingKind: 'prompt',
        waitingSince: T0,
      })
    ).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
