/**
 * The cross-device dismissal across a server restart (Issue #2057).
 *
 * ## What a restart actually is, here
 *
 * Every live-session store in `lib/push` and `lib/session` is a `globalThis`
 * map, so a restart is exactly: those maps are empty and the database file is
 * untouched. {@link restart} is that and nothing else — it drops the card
 * memory through `forgetPromptCardMemory` (which deliberately leaves the
 * `app_settings` rows alone) rather than through `clearAllPromptCards`, because
 * clearing the rows too would model "the DB was wiped as well", which is not
 * what restarting a server does.
 *
 * ## What #2057 measured, and where the Issue's premise needed correcting
 *
 * The Issue says the mark is lost and the closing edge then decides `no-card`.
 * The outcome is right; the sufficient condition in the Issue is not, and the
 * difference is what these tests pin:
 *
 *  - A **plain** restart does not lose it. The status probe re-observes the
 *    still-open wait, `observeWaitingEdge` reports a fresh *opening* edge, and
 *    the prompt push that follows re-marks the card — so even before #2057 the
 *    resolution decided `cross-device-clear`. (`the re-opening edge re-marks`.)
 *  - It is lost when that re-opening push is **gated**: Auto-Yes running at the
 *    moment the wait is re-observed makes #1999's gate suppress it, nothing
 *    re-marks, and the resolution reads `no-card` for a card that is provably
 *    still on the other phone. This is the defect, and it is the test that goes
 *    red without the persistence.
 *  - A wait that resolves with **nothing re-observing it** raises no closing
 *    edge at all, because `observeWaitingEdge` emits nothing for a
 *    `waiting: false` poll on an instance it has no episode for. Durable marks
 *    cannot reach that case; it is pinned here as a known limitation so the
 *    boundary is a decision on the record rather than an oversight.
 *
 * Driven like the #2001 suite — a real in-memory database with only `web-push`
 * stubbed — because the property under test is whether a resolution payload
 * leaves the process after a restart, and a spied fan-out would pass with the
 * persistence wired to nothing.
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
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  clearAllPromptCards,
  clearPromptCard,
  forgetPromptCardMemory,
  hasPromptCard,
  markPromptCardShown,
  promptCardCount,
  PROMPT_CARD_KEY_PREFIX,
  PROMPT_CARD_MAX_AGE_MS,
} from '@/lib/push/prompt-card-state';
import { decidePromptResolution, notifyPromptResolved } from '@/lib/push/resolution-push-notifier';
import {
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-2057';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

/** Let the fire-and-forget fan-out reach `web-push`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function addDevice(suffix: string, locale = 'en'): void {
  upsertPushSubscription(db, {
    endpoint: `https://push.example/${suffix}`,
    p256dh: 'p',
    auth: 'a',
    locale,
  });
}

/** Open a wait for one instance, exactly as the status probe / poller does. */
function startWaiting(now: number, instanceId?: string): void {
  observeWaitingEdge({
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId,
    waiting: true,
    kind: 'prompt',
    now,
  });
}

/** Close it again. */
function stopWaiting(now: number, instanceId?: string): void {
  observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', instanceId, waiting: false, now });
}

/**
 * Restart the server: every `globalThis` store comes back empty, the database
 * file comes back exactly as it was.
 */
function restart(): void {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  forgetPromptCardMemory();
  resetNotificationDedup();
  resetWaitingPushDedup();
  startWaitingPushNotifier();
}

/** What `app_settings` holds for this worktree's card, straight from SQL. */
function persistedMark(worktreeId = WT): string | undefined {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(`${PROMPT_CARD_KEY_PREFIX}${worktreeId}`) as { value: string } | undefined;
  return row?.value;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-2057', '/tmp/repo', 'repo', T0);

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
  clearAllPromptCards();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });

  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllPromptCards();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('the mark survives the process that made it', () => {
  it('writes the fanned-out card through to app_settings', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting(T0);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(persistedMark()).toBe(String(T0));
  });

  it('answers hasPromptCard from storage when this process never marked it', () => {
    markPromptCardShown(WT, T0);
    restart();

    expect(hasPromptCard(WT, T0 + 60_000)).toBe(true);
  });

  it('counts a mark it only knows from storage', () => {
    markPromptCardShown(WT, T0);
    restart();

    expect(promptCardCount(T0 + 60_000)).toBe(1);
  });

  it('records nothing for a wait that never rang, restart or not', async () => {
    addDevice('iphone');
    addDevice('android');
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting(T0);
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
    expect(persistedMark()).toBeUndefined();

    restart();
    expect(hasPromptCard(WT, T0 + 60_000)).toBe(false);
  });
});

describe('a wait still open across the restart is still cleared when it ends', () => {
  /**
   * The defect. Auto-Yes is switched on while the server is down, so the
   * re-opening edge is suppressed by #1999's gate and nothing re-marks the
   * card — which before #2057 left the resolution deciding `no-card` for a card
   * that is still on the other phone.
   */
  it('replaces the stale card when the re-opening push is suppressed', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting(T0);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(2); // the prompt itself

    restart();
    setAutoYesEnabled(WT, 'claude', true);

    // The probe re-observes the wait that was already in progress. #1999's gate
    // suppresses the notification, so this edge marks nothing.
    startWaiting(T0 + 60_000);
    await flush();
    sendNotification.mockClear();

    stopWaiting(T0 + 70_000);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const [, payload] of sendNotification.mock.calls) {
      expect(JSON.parse(payload as string)).toMatchObject({
        kind: 'prompt',
        resolved: true,
        tag: `${WT}:prompt`,
      });
    }
  });

  it('names the surviving mark in the decision', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting(T0);
    await flush();
    restart();

    expect(decidePromptResolution(WT, T0 + 70_000)).toEqual({
      send: true,
      reason: 'cross-device-clear',
      deviceCount: 2,
    });
  });

  it('still clears when the re-opening edge did re-mark the card', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting(T0);
    await flush();

    restart();

    // No Auto-Yes: the re-observed wait notifies again and re-marks. This
    // already worked before #2057 — pinned so the persistence cannot be blamed
    // for a regression on the path that never needed it.
    startWaiting(T0 + 60_000);
    await flush();
    expect(persistedMark()).toBe(String(T0 + 60_000));
    sendNotification.mockClear();

    stopWaiting(T0 + 70_000);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('sends one resolution per card, not one per closing edge, after a restart', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting(T0);
    await flush();
    restart();
    setAutoYesEnabled(WT, 'claude', true);
    startWaiting(T0 + 60_000);
    await flush();
    sendNotification.mockClear();

    stopWaiting(T0 + 70_000);
    await flush();
    // Both producers raise the closing edge; the second must find nothing.
    stopWaiting(T0 + 71_000);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(persistedMark()).toBeUndefined();
  });
});

describe('clearing removes the mark from both layers', () => {
  it('drops the row so a later restart cannot resurrect the card', () => {
    markPromptCardShown(WT, T0);
    expect(clearPromptCard(WT)).toBe(true);
    expect(persistedMark()).toBeUndefined();

    restart();
    expect(hasPromptCard(WT, T0 + 1)).toBe(false);
  });

  it('reports a clear for a mark this process only ever read from storage', () => {
    markPromptCardShown(WT, T0);
    restart();

    expect(clearPromptCard(WT)).toBe(true);
    expect(clearPromptCard(WT)).toBe(false);
  });

  it('drops the row on the resolution that decided not to send', async () => {
    addDevice('only');
    markPromptCardShown(WT, T0);
    restart();

    await notifyPromptResolved({ worktreeId: WT, at: T0 + 1_000 });

    expect(sendNotification).not.toHaveBeenCalled();
    expect(persistedMark()).toBeUndefined();
  });

  it('wipes every persisted mark on clearAllPromptCards', () => {
    markPromptCardShown(WT, T0);
    markPromptCardShown(`${WT}-other`, T0);

    clearAllPromptCards();

    expect(promptCardCount(T0)).toBe(0);
    expect(persistedMark()).toBeUndefined();
    expect(persistedMark(`${WT}-other`)).toBeUndefined();
  });
});

describe('the persisted mark expires', () => {
  it('is believed right up to PROMPT_CARD_MAX_AGE_MS', () => {
    markPromptCardShown(WT, T0);
    restart();

    expect(hasPromptCard(WT, T0 + PROMPT_CARD_MAX_AGE_MS - 1)).toBe(true);
  });

  it('is gone at PROMPT_CARD_MAX_AGE_MS, and takes its row with it', () => {
    markPromptCardShown(WT, T0);
    restart();

    expect(hasPromptCard(WT, T0 + PROMPT_CARD_MAX_AGE_MS)).toBe(false);
    expect(persistedMark()).toBeUndefined();
  });

  it('decides no-card for an expired mark rather than spending a push', async () => {
    addDevice('iphone');
    addDevice('android');
    markPromptCardShown(WT, T0);
    restart();

    expect(decidePromptResolution(WT, T0 + PROMPT_CARD_MAX_AGE_MS).reason).toBe('no-card');
    await notifyPromptResolved({ worktreeId: WT, at: T0 + PROMPT_CARD_MAX_AGE_MS });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('leaves an expired mark out of the count', () => {
    markPromptCardShown(WT, T0);
    restart();

    expect(promptCardCount(T0 + PROMPT_CARD_MAX_AGE_MS)).toBe(0);
  });
});

describe('storage never disturbs the caller', () => {
  it('reads and writes total against an unusable database', () => {
    const good = db;
    db = new Database(':memory:'); // migrated to nothing: no app_settings table

    expect(() => markPromptCardShown(WT, T0)).not.toThrow();
    // The in-memory layer still answers, so a database problem degrades to the
    // pre-#2057 behaviour rather than to silence.
    expect(hasPromptCard(WT, T0 + 1)).toBe(true);
    forgetPromptCardMemory();
    expect(hasPromptCard(WT, T0 + 1)).toBe(false);
    expect(() => clearPromptCard(WT)).not.toThrow();
    expect(promptCardCount(T0 + 1)).toBe(0);
    expect(() => clearAllPromptCards()).not.toThrow();

    db.close();
    db = good;
  });

  it('treats a malformed stored value as no card', () => {
    markPromptCardShown(WT, T0);
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?')
      .run('not-a-number', `${PROMPT_CARD_KEY_PREFIX}${WT}`);
    restart();

    expect(hasPromptCard(WT, T0 + 1)).toBe(false);
  });

  it('does not read one worktree’s mark for another whose id it prefixes', () => {
    markPromptCardShown(`${WT}-extra`, T0);
    restart();

    expect(hasPromptCard(WT, T0 + 1)).toBe(false);
    expect(hasPromptCard(`${WT}-extra`, T0 + 1)).toBe(true);
  });
});

describe('what durability still does not reach', () => {
  /**
   * Known limitation, recorded rather than fixed: `waiting-episode-state` is in
   * memory, and `observeWaitingEdge` emits nothing for a `waiting: false` poll
   * on an instance it has no episode for. So a wait that ended while the server
   * was down raises no closing edge, and the resolution is never asked. Closing
   * this would mean making the waiting episode durable, which belongs to
   * `lib/session`. See §6.2 of the design note.
   */
  it('raises no closing edge for a wait nothing re-observed after the restart', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting(T0);
    await flush();
    restart();
    sendNotification.mockClear();

    stopWaiting(T0 + 70_000);
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
    // The mark is still there — it is the *edge* that is missing, not the card
    // state, which is what makes this a `lib/session` question.
    expect(persistedMark()).toBe(String(T0));
  });
});
