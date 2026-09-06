/**
 * The push for a model change (Issue #2357): the bucket it goes to, the words
 * it carries, and that one transition sends once.
 *
 * Driven against a real in-memory database with only `web-push` stubbed, for
 * the reason #2000's suite gives: the property under test is whether a
 * notification LEAVES the process, and a spied `notifyPushSubscribers` would
 * pass with the bucket lookup or the dedup removed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);
vi.mock('@/lib/logger', () => ({
  createLogger: () => mockLogger,
  generateRequestId: () => 'test-request-id',
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { upsertPushSubscription, updatePushSubscriptionPreferences } from '@/lib/db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
import {
  buildModelChangedBodies,
  buildModelChangedSentence,
  notifyModelChangePush,
  resolveReadersLocale,
} from '@/lib/push/model-change-push-notifier';
import { MODEL_CHANGE_TAG_SUFFIX, buildPushPayload } from '@/lib/push/push-sender';
import type { AgentModelChange } from '@/lib/session/agent-event-state';
import enWorktree from '../../../../locales/en/worktree.json';
import jaWorktree from '../../../../locales/ja/worktree.json';

const WT = 'wt-2357-push';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

const CHANGE: AgentModelChange = {
  worktreeId: WT,
  cliToolId: 'copilot',
  instanceId: 'copilot',
  from: 'gpt-5.6-sol',
  to: 'gpt-5-mini',
  source: 'frame',
  at: T0,
};

let savedEnv: Record<string, string | undefined>;

/** The payloads actually handed to web-push, with the endpoint they went to. */
function deliveries(): Array<{
  endpoint: string;
  payload: { kind: string; title: string; body: string; tag: string; worktreeId: string; url: string };
}> {
  return sendNotification.mock.calls.map(([sub, payload]) => ({
    endpoint: (sub as { endpoint: string }).endpoint,
    payload: JSON.parse(payload as string),
  }));
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-2357', '/tmp/wt-2357', '/tmp/repo', 'repo', T0);

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  for (const fn of [mockLogger.debug, mockLogger.info, mockLogger.warn, mockLogger.error]) {
    fn.mockReset();
  }
  resetNotificationDedup();
});

afterEach(() => {
  resetNotificationDedup();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// =============================================================================
// The words
// =============================================================================

describe('buildModelChangedSentence', () => {
  it('reads the same dictionary key the phone shows, per locale', () => {
    expect(buildModelChangedSentence('en', 'gpt-5.6-sol', 'gpt-5-mini')).toBe(
      enWorktree.agentModel.changed.replace('{from}', 'gpt-5.6-sol').replace('{to}', 'gpt-5-mini')
    );
    expect(buildModelChangedSentence('ja', 'gpt-5.6-sol', 'gpt-5-mini')).toBe(
      jaWorktree.agentModel.changed.replace('{from}', 'gpt-5.6-sol').replace('{to}', 'gpt-5-mini')
    );
    // The literal, so a dictionary edit that drops a placeholder is caught here.
    expect(buildModelChangedSentence('ja', 'gpt-5.6-sol', 'gpt-5-mini')).toBe(
      'モデルが gpt-5.6-sol から gpt-5-mini に変わりました'
    );
    expect(buildModelChangedSentence('en', 'gpt-5.6-sol', 'gpt-5-mini')).toBe(
      'Model changed from gpt-5.6-sol to gpt-5-mini'
    );
  });

  it('falls back to the default locale for an unknown or missing one', () => {
    expect(buildModelChangedSentence(null, 'a', 'b')).toBe(buildModelChangedSentence('en', 'a', 'b'));
    expect(buildModelChangedSentence('fr', 'a', 'b')).toBe(buildModelChangedSentence('en', 'a', 'b'));
  });

  it('states the fact only — no ranking, no direction word', () => {
    const sentence = buildModelChangedSentence('en', 'gpt-5.6-sol', 'gpt-5-mini');
    expect(sentence).not.toMatch(/downgrad|upgrad|lower|higher|worse|better/i);
  });

  it('prebuilds every supported locale for the fan-out', () => {
    const bodies = buildModelChangedBodies('a', 'b');
    expect(Object.keys(bodies).sort()).toEqual(['en', 'ja']);
    expect(bodies.ja).toContain('a');
    expect(bodies.ja).toContain('b');
  });
});

// =============================================================================
// The readers' language
// =============================================================================

describe('resolveReadersLocale', () => {
  it('is the default locale when nobody has registered a device', () => {
    expect(resolveReadersLocale(db)).toBe('en');
  });

  it('is the NEWEST subscription’s locale', () => {
    upsertPushSubscription(db, { endpoint: 'https://push.example/old', p256dh: 'p', auth: 'a', locale: 'en' });
    // Registered later, so its `updated_at` is later.
    db.prepare(`UPDATE push_subscriptions SET updated_at = ? WHERE endpoint = ?`).run(T0 - 10_000, 'https://push.example/old');
    upsertPushSubscription(db, { endpoint: 'https://push.example/new', p256dh: 'p', auth: 'a', locale: 'ja' });
    db.prepare(`UPDATE push_subscriptions SET updated_at = ? WHERE endpoint = ?`).run(T0, 'https://push.example/new');
    expect(resolveReadersLocale(db)).toBe('ja');
  });

  it('narrows a locale it cannot render to the default', () => {
    upsertPushSubscription(db, { endpoint: 'https://push.example/x', p256dh: 'p', auth: 'a', locale: 'fr' });
    expect(resolveReadersLocale(db)).toBe('en');
  });

  it('never throws — a closed database means the default locale', () => {
    const closed = new Database(':memory:');
    closed.close();
    expect(resolveReadersLocale(closed)).toBe('en');
  });
});

// =============================================================================
// The push
// =============================================================================

describe('notifyModelChangePush', () => {
  it('reaches every device on the default-ON bucket, in each device’s language', async () => {
    upsertPushSubscription(db, { endpoint: 'https://push.example/ja', p256dh: 'p', auth: 'a', locale: 'ja' });
    upsertPushSubscription(db, { endpoint: 'https://push.example/en', p256dh: 'p', auth: 'a', locale: 'en' });

    const suppressed = await notifyModelChangePush(CHANGE);
    expect(suppressed).toBeNull();

    const sent = deliveries();
    expect(sent).toHaveLength(2);
    const byEndpoint = Object.fromEntries(sent.map((d) => [d.endpoint, d.payload]));
    expect(byEndpoint['https://push.example/ja'].body).toBe(
      'モデルが gpt-5.6-sol から gpt-5-mini に変わりました'
    );
    expect(byEndpoint['https://push.example/en'].body).toBe(
      'Model changed from gpt-5.6-sol to gpt-5-mini'
    );
    // The title names the worktree and the instance, like every other push.
    expect(byEndpoint['https://push.example/en'].title).toBe('feature-2357 (copilot)');
    // A tag of its own: never the failure card's, never a prompt card's.
    expect(byEndpoint['https://push.example/en'].tag).toBe(`${WT}:${MODEL_CHANGE_TAG_SUFFIX}`);
    expect(byEndpoint['https://push.example/en'].url).toBe(`/worktrees/${WT}`);
    // The transport bucket, carried as data only.
    expect(byEndpoint['https://push.example/en'].kind).toBe('failure');
  });

  it('is governed by the "you need to act" toggle, which a new device starts with ON', async () => {
    // A fresh registration: nothing toggled. This is the whole of "既定 ON".
    upsertPushSubscription(db, { endpoint: 'https://push.example/fresh', p256dh: 'p', auth: 'a', locale: 'en' });
    await notifyModelChangePush(CHANGE);
    expect(deliveries()).toHaveLength(1);

    // …and a device that turned that toggle off is left alone, even with the
    // informational one on.
    resetNotificationDedup();
    sendNotification.mockClear();
    updatePushSubscriptionPreferences(db, 'https://push.example/fresh', {
      enabledPrompt: false,
      enabledCompletion: true,
    });
    await notifyModelChangePush(CHANGE);
    expect(deliveries()).toHaveLength(0);
  });

  it('sends ONE push for one transition, whichever way it is re-reported', async () => {
    upsertPushSubscription(db, { endpoint: 'https://push.example/d', p256dh: 'p', auth: 'a', locale: 'en' });
    await notifyModelChangePush(CHANGE);
    await notifyModelChangePush({ ...CHANGE, at: T0 + 2_000, source: 'hook' });
    expect(deliveries()).toHaveLength(1);
    // A DIFFERENT transition is its own notification.
    await notifyModelChangePush({ ...CHANGE, from: 'gpt-5-mini', to: 'gpt-5.6-sol', at: T0 + 5_000 });
    expect(deliveries()).toHaveLength(2);
  });

  it('does not displace, and is not displaced by, a failure card of the same worktree', () => {
    const modelPayload = buildPushPayload(
      {
        worktreeId: WT,
        worktreeName: 'feature-2357',
        kind: 'failure',
        modelChange: { from: 'a', to: 'b', body: buildModelChangedBodies('a', 'b') },
      },
      'en',
      T0
    );
    const failurePayload = buildPushPayload(
      {
        worktreeId: WT,
        worktreeName: 'feature-2357',
        kind: 'failure',
        failure: { reason: 'upstream-fault', signature: 'sig' },
      },
      'en',
      T0
    );
    expect(modelPayload.tag).not.toBe(failurePayload.tag);
    expect(modelPayload.body).toBe('Model changed from a to b');
    expect(failurePayload.body).not.toContain('Model changed');
  });

  it('stays quiet, and says why, when VAPID is not configured', async () => {
    delete process.env.CM_VAPID_PUBLIC_KEY;
    delete process.env.CM_VAPID_PRIVATE_KEY;
    upsertPushSubscription(db, { endpoint: 'https://push.example/d', p256dh: 'p', auth: 'a', locale: 'en' });
    expect(await notifyModelChangePush(CHANGE)).toBe('unconfigured');
    expect(deliveries()).toHaveLength(0);
    const reasons = (mockLogger.debug.mock.calls as Array<[string, Record<string, unknown>?]>)
      .filter(([name]) => name === 'model-change-push-suppressed')
      .map(([, ctx]) => ctx?.reason);
    expect(reasons).toEqual(['unconfigured']);
  });

  it('logs the transition it raised, with both models and the channel', async () => {
    upsertPushSubscription(db, { endpoint: 'https://push.example/d', p256dh: 'p', auth: 'a', locale: 'en' });
    await notifyModelChangePush(CHANGE);
    const raised = (mockLogger.info.mock.calls as Array<[string, Record<string, unknown>?]>)
      .filter(([name]) => name === 'model-change-push-raised')
      .map(([, ctx]) => ctx);
    expect(raised).toEqual([
      expect.objectContaining({ worktreeId: WT, instanceId: 'copilot', from: 'gpt-5.6-sol', to: 'gpt-5-mini', source: 'frame' }),
    ]);
  });

  it('falls back to the worktree id in the title when the row is gone, rather than dropping the push', async () => {
    upsertPushSubscription(db, { endpoint: 'https://push.example/d', p256dh: 'p', auth: 'a', locale: 'en' });
    await notifyModelChangePush({ ...CHANGE, worktreeId: 'wt-gone' });
    expect(deliveries()[0].payload.title).toBe('wt-gone (copilot)');
  });
});
