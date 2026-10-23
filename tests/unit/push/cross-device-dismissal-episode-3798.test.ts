/**
 * Issue #3798 PR 2: the card mark keeps the episode it was last sent for, and
 * the resolution names it (design `docs/design/issue-3798-waiting-episode.md`
 * §2.4 規則 5 and §6.2).
 *
 * The id lives in a second `app_settings` row written in the same statement as
 * the time row (one write), whose value repeats the time; the time row keeps
 * the bare timestamp #2057 stores, so a mark written before #3798 (time row
 * only) reads as a card with no id, and its resolution carries none — which the
 * Service Worker handles as it always has.
 *
 * The database is a file in a `mkdtemp` directory so a restart (the process
 * forgetting, the file staying) is real.
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
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { clearAutoYesHolds } from '@/lib/push/prompt-push-gate';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  clearAllPromptCards,
  forgetPromptCardMemory,
  getPromptCardEpisodeId,
  hasPromptCard,
  markPromptCardShown,
  PROMPT_CARD_EPISODE_KEY_PREFIX,
  PROMPT_CARD_KEY_PREFIX,
  promptCardCount,
} from '@/lib/push/prompt-card-state';
import { notifyPromptResolved } from '@/lib/push/resolution-push-notifier';
import { startWaitingPushNotifier, stopWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-card';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function payloads(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as Record<string, unknown>
  );
}

function row(key: string): string | undefined {
  return (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3798-card-'));
  db = new Database(path.join(tmpDir, 'db.sqlite'));
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', path.join(tmpDir, 'wt'), path.join(tmpDir, 'repo'), 'repo', T0);
  upsertPushSubscription(db, { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a', locale: 'en' });
  upsertPushSubscription(db, { endpoint: 'https://push.example/b', p256dh: 'p', auth: 'a', locale: 'en' });

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
  clearAutoYesHolds();
  clearAllPromptCards();
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllAutoYesStates();
  clearAutoYesHolds();
  clearAllPromptCards();
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('[#3798] the card mark carries its episode', () => {
  it('card mark keeps the last episode id in one write', () => {
    const prepare = vi.spyOn(db, 'prepare');
    markPromptCardShown(WT, T0, 'wep-1');
    const writes = prepare.mock.calls.filter(([sql]) => /INSERT/i.test(String(sql)));
    expect(writes).toHaveLength(1);
    prepare.mockRestore();

    markPromptCardShown(WT, T0 + 1_000, 'wep-2');
    expect(getPromptCardEpisodeId(WT)).toBe('wep-2');
    // #2057's row keeps the bare timestamp; the id sits beside it.
    expect(row(`${PROMPT_CARD_KEY_PREFIX}${WT}`)).toBe(String(T0 + 1_000));
    expect(row(`${PROMPT_CARD_EPISODE_KEY_PREFIX}${WT}`)).toBe(`${T0 + 1_000}:wep-2`);

    // After a restart it is read back from storage.
    forgetPromptCardMemory();
    expect(hasPromptCard(WT, T0 + 2_000)).toBe(true);
    expect(getPromptCardEpisodeId(WT)).toBe('wep-2');
    // The episode row is not counted as a card of its own.
    expect(promptCardCount(T0 + 2_000)).toBe(1);

    // A newer id-less card leaves no older id behind.
    markPromptCardShown(WT, T0 + 3_000, null);
    expect(getPromptCardEpisodeId(WT)).toBeNull();
    forgetPromptCardMemory();
    expect(getPromptCardEpisodeId(WT)).toBeNull();
  });

  it('legacy time-only mark reads as id-less', async () => {
    // What a server before #3798 wrote: the time row alone.
    db.prepare('INSERT INTO app_settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      `${PROMPT_CARD_KEY_PREFIX}${WT}`,
      String(T0),
      T0,
      T0
    );
    expect(hasPromptCard(WT, T0 + 1)).toBe(true);
    expect(getPromptCardEpisodeId(WT)).toBeNull();

    await notifyPromptResolved({ worktreeId: WT, agentName: 'claude', at: T0 + 1 });
    const resolutions = payloads().filter((p) => p.resolved === true);
    expect(resolutions).toHaveLength(2);
    for (const p of resolutions) expect(p).not.toHaveProperty('resolvedEpisodeId');
  });

  it('an id row from another mark (its time differs) is not this card’s id', () => {
    markPromptCardShown(WT, T0, 'wep-1');
    // An older server overwrote the time row and left the id row alone.
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(String(T0 + 5), `${PROMPT_CARD_KEY_PREFIX}${WT}`);
    forgetPromptCardMemory();
    expect(hasPromptCard(WT, T0 + 10)).toBe(true);
    expect(getPromptCardEpisodeId(WT)).toBeNull();
  });

  it('clearing the card removes both rows', () => {
    markPromptCardShown(WT, T0, 'wep-1');
    clearAllPromptCards();
    expect(row(`${PROMPT_CARD_KEY_PREFIX}${WT}`)).toBeUndefined();
    expect(row(`${PROMPT_CARD_EPISODE_KEY_PREFIX}${WT}`)).toBeUndefined();
  });
});

describe('[#3798] the resolution names the card it clears', () => {
  it('a notified wait closes: the resolution carries that episode id', async () => {
    startWaitingPushNotifier();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    const id = getWaitingEpisodeRecord(WT, 'claude')!.episodeId;
    await flush();
    expect(payloads()).toHaveLength(2);
    for (const p of payloads()) expect(p).toMatchObject({ episodeId: id });
    expect(getPromptCardEpisodeId(WT)).toBe(id);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: T0 + 1_000 });
    await flush();
    await flush();
    const resolutions = payloads().filter((p) => p.resolved === true);
    expect(resolutions).toHaveLength(2);
    for (const p of resolutions) expect(p).toMatchObject({ resolvedEpisodeId: id });
    // The mark is cleared as before.
    expect(hasPromptCard(WT, T0 + 2_000)).toBe(false);
  });

  it('negative: an id-less waiting push (the response poller) marks an id-less card', async () => {
    const { notifyPushSubscribers } = await import('@/lib/push/push-sender');
    await notifyPushSubscribers(
      { worktreeId: WT, worktreeName: 'feature-x', kind: 'prompt', agentName: 'claude', waitingSince: T0 },
      T0
    );
    expect(hasPromptCard(WT, T0 + 1)).toBe(true);
    expect(getPromptCardEpisodeId(WT)).toBeNull();
    for (const p of payloads()) expect(p).not.toHaveProperty('episodeId');
  });
});
