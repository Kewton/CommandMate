/**
 * Issue #3798 PR 2: the waiting-edge notifier names a wait by its episode id
 * (design `docs/design/issue-3798-waiting-episode.md` §5 and §6.2).
 *
 * It subscribes with `onWaitingEpisodeTransition`, so a replacement is told
 * from a new wait: the old wait's timers and hold go, no resolution is sent,
 * and the new wait gets a hold of its own. Every re-read of the store (hold
 * end, classification grace, reminder) compares the id it reads with
 * `getWaitingEpisodeRecord`. Two waits on one `since` are two notifications.
 *
 * Positive controls fail on the since-only notifier (the second wait on one
 * `since` was deduped, inherited the first wait's hold, or earned the first
 * wait's reminder). Scaffold as in `waiting-push-answer-grace-3757.test.ts`:
 * a real database (in a `mkdtemp` directory), only `web-push` stubbed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
let tmpDir: string;

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
import { AUTO_YES_ANSWER_GRACE_MS, clearAutoYesHolds } from '@/lib/push/prompt-push-gate';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup, shouldSendWaitingPush } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import { clearAllPromptCards, markPromptCardShown } from '@/lib/push/prompt-card-state';
import {
  CLASSIFICATION_GRACE_MS,
  heldWaitCount,
  pendingEscalationCount,
  runEscalationTick,
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  closeEpisode,
  getWaitingEpisodeRecord,
  openEpisode,
  replaceEpisode,
  type EpisodeBinding,
} from '@/lib/session/waiting-episode-state';
import type { WaitingKind } from '@/lib/session/waiting-kind';

const WT = 'wt-3798-notifier';
const PARTS = { worktreeId: WT, cliToolId: 'claude' as const };
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;
const BINDING: EpisodeBinding = { kind: 'unattributed', generation: { kind: 'none' }, lastClosedTurnId: null };

let savedEnv: Record<string, string | undefined>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function payloads(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as Record<string, unknown>
  );
}

function open(since: number, at: number, kind: WaitingKind | null = 'prompt'): string {
  return openEpisode(PARTS, { since, kind, binding: BINDING, openedBy: 'status-probe' }, at).episodeId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3798-notifier-'));
  db = new Database(path.join(tmpDir, 'db.sqlite'));
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', path.join(tmpDir, 'wt'), path.join(tmpDir, 'repo'), 'repo', T0);
  upsertPushSubscription(db, { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a', locale: 'en' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  setVapidDetails.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);

  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  stopWaitingPushNotifier();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllAutoYesStates();
  clearAutoYesHolds();
  clearPolicySuppressions();
  clearAllPromptCards();
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });

  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllAutoYesStates();
  clearAutoYesHolds();
  clearPolicySuppressions();
  clearAllPromptCards();
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('[#3798] two waits on one since', () => {
  it('same since, two episode ids notify twice with two holds', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    const first = open(T0, T0);
    await flush();
    // The first wait closes 3 s in; the next one reuses the structured since.
    await vi.advanceTimersByTimeAsync(3_000);
    closeEpisode(PARTS, first, 'turn-stop', T0 + 3_000);
    const second = open(T0, T0 + 3_000);
    expect(second).not.toBe(first);

    // Positive control: sharing the first wait's hold, it rang at 9 s.
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 3_000);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    // Its own hold ends 9 s after it began.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ kind: 'prompt', episodeId: second });

    // A third wait on the same since, Auto-Yes off: notified again on the edge.
    closeEpisode(PARTS, second, 'turn-stop', T0 + 13_000);
    setAutoYesEnabled(WT, 'claude', false);
    const third = open(T0, T0 + 13_000);
    await flush();
    expect(payloads()).toHaveLength(2);
    expect(payloads()[1]).toMatchObject({ episodeId: third });
  });

  it('negative: the same episode reported twice is one notification', async () => {
    const id = open(T0, T0);
    await flush();
    // The store refreshes the kind in place: not an edge, nothing more sent.
    const record = getWaitingEpisodeRecord(WT, 'claude');
    expect(record?.episodeId).toBe(id);
    expect(payloads()).toHaveLength(1);
  });
});

describe('[#3798] replaced', () => {
  it('replaced cancels the old timers and sends no resolution', async () => {
    // Two devices and an outstanding card: a closing edge would send a resolution.
    upsertPushSubscription(db, { endpoint: 'https://push.example/b', p256dh: 'p', auth: 'a', locale: 'en' });
    markPromptCardShown(WT, T0 - 1_000, null);
    setAutoYesEnabled(WT, 'claude', true);

    // An unnamed wait: held for classification, then for Auto-Yes.
    const first = open(T0, T0, null);
    expect(heldWaitCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    const replaced = replaceEpisode(
      PARTS,
      first,
      { since: T0, kind: 'prompt', binding: BINDING, openedBy: 'response-checker' },
      'turn-superseded',
      T0 + 3_000
    );
    expect(replaced).not.toBeNull();
    // The old wait's classification hold is gone; the new wait is the one pending.
    expect(heldWaitCount()).toBe(0);
    expect(pendingEscalationCount()).toBe(1);
    await flush();
    // No resolution for the replacement.
    expect(payloads().filter((p) => p.resolved === true)).toHaveLength(0);

    // Neither the old classification timer (8 s) nor an inherited hold (9 s) rings.
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 3_000);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(CLASSIFICATION_GRACE_MS).toBeLessThan(AUTO_YES_ANSWER_GRACE_MS);

    // The new wait's own hold ends 9 s after the replacement.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(payloads()).toHaveLength(2);
    expect(payloads().every((p) => p.resolved === undefined)).toBe(true);
    expect(payloads()[0]).toMatchObject({ episodeId: replaced!.episodeId });
  });

  it('negative: a closing edge still sends the resolution', async () => {
    upsertPushSubscription(db, { endpoint: 'https://push.example/b', p256dh: 'p', auth: 'a', locale: 'en' });
    const id = open(T0, T0);
    await flush();
    expect(payloads()).toHaveLength(2);
    closeEpisode(PARTS, id, 'turn-stop', T0 + 1_000);
    await flush();
    await flush();
    expect(payloads().filter((p) => p.resolved === true)).toHaveLength(2);
    expect(payloads().filter((p) => p.resolved === true)[0]).toMatchObject({ resolvedEpisodeId: id });
  });
});

describe('[#3798] the reminder', () => {
  it('escalation re-reads by episode id', async () => {
    const first = open(T0, T0);
    await flush();
    expect(payloads()).toHaveLength(1);

    // The store moves to another wait on the same since while the notifier is
    // not listening (its edges were lost): only the re-read can tell.
    clearWaitingTransitionListeners();
    closeEpisode(PARTS, first, 'turn-stop', T0 + 1_000);
    open(T0, T0 + 1_000);

    // Positive control: by since, the first wait's reminder went out for it.
    runEscalationTick(T0 + 11 * 60_000);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(pendingEscalationCount()).toBe(0);
  });

  it('negative: the same episode still earns its one reminder', async () => {
    const id = open(T0, T0);
    await flush();
    runEscalationTick(T0 + 11 * 60_000);
    await flush();
    expect(payloads()).toHaveLength(2);
    expect(payloads()[1]).toMatchObject({ episodeId: id });
  });
});

describe('[#3798] the episode dedup', () => {
  const ev = { worktreeId: WT, instanceId: 'claude' };

  it('mixed: an id-less send then the id-bearing send of one since is one notification', () => {
    expect(shouldSendWaitingPush({ ...ev, since: T0 })).toBe(true);
    expect(shouldSendWaitingPush({ ...ev, since: T0, episodeId: 'wep-1' })).toBe(false);
    // Named now: another id on the same since is another wait.
    expect(shouldSendWaitingPush({ ...ev, since: T0, episodeId: 'wep-2' })).toBe(true);
    // Its reminder once, and an id-less repeat of its since stays deduped.
    expect(shouldSendWaitingPush({ ...ev, since: T0, episodeId: 'wep-2', escalated: true })).toBe(true);
    expect(shouldSendWaitingPush({ ...ev, since: T0, episodeId: 'wep-2', escalated: true })).toBe(false);
    expect(shouldSendWaitingPush({ ...ev, since: T0 })).toBe(false);
  });

  it('negative: id-less sends keep the since-only rule of #1790', () => {
    expect(shouldSendWaitingPush({ ...ev, since: T0 })).toBe(true);
    expect(shouldSendWaitingPush({ ...ev, since: T0 })).toBe(false);
    expect(shouldSendWaitingPush({ ...ev, since: T0 + 1 })).toBe(true);
  });
});
