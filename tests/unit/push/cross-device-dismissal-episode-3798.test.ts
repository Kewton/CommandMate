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
import fs, { readFileSync } from 'fs';
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

// --- Per-device delivery, end to end ----------------------------------------
//
// The server's payloads, as each device actually received them, fed through the
// shipped `public/sw.js`. Delivery fails per device, and the resolution goes out
// only once nothing in the worktree waits, so a device can hold an older card
// than the one the resolution names; or receive the resolution after a newer
// wait's card. Only order (`waitingSince` against the resolution's `timestamp`)
// tells the two apart.

const swSource = readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');

interface DeviceCard {
  title: string;
  tag: string;
  body: string;
  silent?: boolean;
  data: Record<string, unknown>;
  close: () => void;
}

function device() {
  const shown: DeviceCard[] = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn((title: string, options: Record<string, unknown>) => {
    const n: DeviceCard = {
      title,
      tag: options.tag as string,
      body: options.body as string,
      silent: options.silent as boolean | undefined,
      data: options.data as Record<string, unknown>,
      close: () => {
        const i = shown.indexOf(n);
        if (i >= 0) shown.splice(i, 1);
      },
    };
    shown.push(n);
    return Promise.resolve();
  });
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners[type] = handler;
    },
    location: { origin: 'https://app.example' },
    registration: {
      showNotification,
      getNotifications: (filter?: { tag?: string }) =>
        Promise.resolve(shown.filter((n) => !filter?.tag || n.tag === filter.tag)),
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(() => Promise.resolve([])), openWindow: vi.fn() },
  };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', swSource)(self, { open: vi.fn(), keys: vi.fn(), match: vi.fn(), delete: vi.fn() });
  return {
    shown,
    showNotification,
    async receive(payload: Record<string, unknown>): Promise<void> {
      const event: { data: { json: () => unknown }; waitUntil: (p: unknown) => void; _p?: unknown } = {
        data: { json: () => payload },
        waitUntil: (p) => {
          event._p = p;
        },
      };
      listeners.push(event);
      await event._p;
    },
  };
}

const X = 'https://push.example/a';
const Y = 'https://push.example/b';

/** Route each delivered payload to its endpoint's inbox; `fails` decides per device. */
function routeDeliveries(fails: (endpoint: string, payload: Record<string, unknown>) => boolean) {
  const inbox: Record<string, Array<Record<string, unknown>>> = { [X]: [], [Y]: [] };
  sendNotification.mockImplementation((sub: { endpoint: string }, raw: string) => {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (fails(sub.endpoint, payload)) {
      return Promise.reject(Object.assign(new Error('push service unavailable'), { statusCode: 500 }));
    }
    inbox[sub.endpoint].push(payload);
    return Promise.resolve({ statusCode: 201 });
  });
  return inbox;
}

async function settle(): Promise<void> {
  await flush();
  await flush();
}

describe('[#3798] per-device delivery: the resolution leaves only a newer wait standing', () => {
  it('old A / resolution B: the device that missed B closes its stale A card', async () => {
    startWaitingPushNotifier();
    // B's card is the one whose wait opened at T0 + 100.
    const inbox = routeDeliveries((endpoint, p) => endpoint === X && p.resolved !== true && p.waitingSince === T0 + 100);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    const idA = getWaitingEpisodeRecord(WT, 'claude')!.episodeId;
    await settle();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'codex', waiting: true, kind: 'prompt', now: T0 + 100 });
    const idB = getWaitingEpisodeRecord(WT, 'codex')!.episodeId;
    await settle();
    // A ends while B still waits: no resolution.
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: T0 + 200 });
    await settle();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'codex', waiting: false, now: T0 + 300 });
    await settle();

    // X got A only; Y got A and B. Both got B's resolution.
    expect(inbox[X].map((p) => p.episodeId ?? p.resolvedEpisodeId)).toEqual([idA, idB]);
    expect(inbox[X][1]).toMatchObject({ resolved: true, resolvedEpisodeId: idB, timestamp: T0 + 300 });
    expect(inbox[Y].map((p) => p.episodeId ?? p.resolvedEpisodeId)).toEqual([idA, idB, idB]);

    const x = device();
    const y = device();
    for (const p of inbox[X]) await x.receive(p);
    for (const p of inbox[Y]) await y.receive(p);

    for (const d of [x, y]) {
      expect(d.shown).toHaveLength(1);
      expect(d.shown[0].data).toMatchObject({ resolved: true });
      expect(d.shown[0].silent).toBe(true);
    }
    // Before the fix X re-showed A — a finished wait no later push would close.
    expect(x.shown[0].data.episodeId).toBeUndefined();
  });

  it('new B / resolution A: the late resolution leaves B standing on the device it overtook', async () => {
    startWaitingPushNotifier();
    // Y misses B's card; X receives A's resolution only after B's card.
    const inbox = routeDeliveries((endpoint, p) => endpoint === Y && p.resolved !== true && p.waitingSince === T0 + 200);

    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    const idA = getWaitingEpisodeRecord(WT, 'claude')!.episodeId;
    await settle();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: T0 + 100 });
    await settle();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'codex', waiting: true, kind: 'prompt', now: T0 + 200 });
    const idB = getWaitingEpisodeRecord(WT, 'codex')!.episodeId;
    await settle();

    expect(inbox[X].map((p) => p.episodeId ?? p.resolvedEpisodeId)).toEqual([idA, idA, idB]);
    expect(inbox[X][1]).toMatchObject({ resolved: true, timestamp: T0 + 100 });
    expect(inbox[X][2]).toMatchObject({ episodeId: idB, waitingSince: T0 + 200 });
    expect(inbox[Y].map((p) => p.episodeId ?? p.resolvedEpisodeId)).toEqual([idA, idA]);

    const x = device();
    const y = device();
    // X: A's card, then B's card overtakes A's resolution.
    await x.receive(inbox[X][0]);
    await x.receive(inbox[X][2]);
    await x.receive(inbox[X][1]);
    for (const p of inbox[Y]) await y.receive(p);

    expect(x.shown).toHaveLength(1);
    expect(x.shown[0].data).toMatchObject({ episodeId: idB, resolved: false });
    expect(x.shown[0].silent).toBe(true);
    expect(x.showNotification).toHaveBeenCalledTimes(3);
    expect(y.shown).toHaveLength(1);
    expect(y.shown[0].data).toMatchObject({ resolved: true });

    // B ends: its resolution closes B on X too.
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'codex', waiting: false, now: T0 + 300 });
    await settle();
    const last = inbox[X][inbox[X].length - 1];
    expect(last).toMatchObject({ resolved: true, resolvedEpisodeId: idB });
    await x.receive(last);
    expect(x.shown).toHaveLength(1);
    expect(x.shown[0].data).toMatchObject({ resolved: true });
  });
});
