/**
 * Issue #3798 (review R3): `fanOutAfterCommit` — a producer commits the
 * waiting episode, then fans out naming the id the commit created, and the
 * gate the episode's own edge runs in the notifier waits until that fan-out is
 * done. So the producer's notification (with the prompt's question) claims the
 * episode dedup, the edge's one for the same id is deduped, and a fan-out
 * that throws still lets the held gate run.
 *
 * Scaffold as in `waiting-push-episode-id-3798.test.ts`: a real database (in a
 * `mkdtemp` directory, removed after each test), only `web-push` stubbed.
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
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { upsertPushSubscription } from '@/lib/db';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { clearAutoYesHolds } from '@/lib/push/prompt-push-gate';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { clearAllPromptCards } from '@/lib/push/prompt-card-state';
import { notifyPushSubscribers } from '@/lib/push/push-sender';
import { fanOutAfterCommit, startWaitingPushNotifier, stopWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  openEpisode,
  type EpisodeBinding,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-fan-out';
const PARTS = { worktreeId: WT, cliToolId: 'claude' as const };
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;
const BINDING: EpisodeBinding = { kind: 'unattributed', generation: { kind: 'none' }, lastClosedTurnId: null };

let savedEnv: Record<string, string | undefined>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function payloads(): Array<{ episodeId?: string; body: string }> {
  return sendNotification.mock.calls.map(([, payload]) => JSON.parse(payload as string) as { episodeId?: string; body: string });
}

function open(): string {
  return openEpisode(PARTS, { since: T0, kind: 'prompt', binding: BINDING, openedBy: 'response-checker' }, T0).episodeId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3798-fan-out-'));
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
  sendNotification.mockResolvedValue({ statusCode: 201 });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  clearAllAutoYesStates();
  clearAutoYesHolds();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllPromptCards();
  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  clearAllPromptCards();
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('[#3798] fanOutAfterCommit', () => {
  it('the producer fans out with the committed id before the edge gate; one card, the producer\'s, with that id', async () => {
    let sentDuringFanOut = -1;
    const id = fanOutAfterCommit(PARTS, open, (episodeId) => {
      // The edge's own gate has not run yet: nothing claimed the episode.
      sentDuringFanOut = sendNotification.mock.calls.length;
      void notifyPushSubscribers({
        worktreeId: WT,
        worktreeName: 'feature-x',
        kind: 'prompt',
        agentName: 'claude',
        instanceId: 'claude',
        waitingKind: 'prompt',
        waitingSince: T0,
        waitingEpisodeId: episodeId,
        excerpt: 'Do you want to make this edit to package.json?',
      });
    });
    await flush();
    expect(sentDuringFanOut).toBe(0);
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ episodeId: id });
    expect(payloads()[0].body).toContain('package.json');
  });

  it('control: without it, the edge notifies at once on the commit (no question to quote)', async () => {
    const id = open();
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ episodeId: id });
    expect(payloads()[0].body).not.toContain('package.json');
  });

  it('a fan-out that throws still lets the held gate run', async () => {
    expect(() =>
      fanOutAfterCommit(PARTS, open, () => {
        throw new Error('fan-out failed');
      }),
    ).toThrow('fan-out failed');
    await flush();
    expect(payloads()).toHaveLength(1);
  });
});
