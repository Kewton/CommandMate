/**
 * The card an adopted session's stale hook URL produces (Issue #2429, 副).
 *
 * Driven against a real in-memory database with only `web-push` stubbed, for
 * the reason #2000's suite gives: the property under test is whether a
 * notification **leaves the process** with a body a reader can act on, and a
 * spied `notifyPushSubscribers` would pass with the fan-out removed.
 *
 * ## Why this body is not in the dictionary
 *
 * Every other failure signal is `<template>` + one `{excerpt}`. This one is a
 * relation between two numbers and the remedy that follows from them, and the
 * layer holding the numbers is the producer. `push-sender`'s
 * `ProducerWordedFailureReason` is that escape hatch, and #2357's
 * `modelChange` established it. What keeps it from being a hole is the type —
 * `Record<SupportedLocale, string>` — and the assertions below, which read both
 * locales off a real fan-out rather than off the producer's own return value.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { upsertPushSubscription } from '@/lib/db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
import { notifyStaleHookUrlPush } from '@/lib/push/failure-push-notifier';
import { buildPushPayload } from '@/lib/push/push-sender';

const WT = 'rag-document';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

const REPORT = {
  worktreeId: WT,
  cliToolId: 'command-code' as const,
  instanceId: 'command-code',
  toolName: 'Command Code CLI',
  sessionPort: 3010,
  serverPort: 3000,
};

/** The payloads actually handed to web-push, keyed by the endpoint they went to. */
function payloadsByEndpoint(): Record<string, { kind: string; title: string; body: string }> {
  const out: Record<string, { kind: string; title: string; body: string }> = {};
  for (const [subscription, payload] of sendNotification.mock.calls) {
    const endpoint = (subscription as { endpoint: string }).endpoint;
    out[endpoint] = JSON.parse(payload as string);
  }
  return out;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'rag-document', '/tmp/rag-document', '/tmp/repo', 'repo', T0);
  upsertPushSubscription(db, { endpoint: 'https://push.example/en', p256dh: 'p', auth: 'a', locale: 'en' });
  upsertPushSubscription(db, { endpoint: 'https://push.example/ja', p256dh: 'p', auth: 'a', locale: 'ja' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
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

describe('[#2429] the stale-hook-URL card', () => {
  it("reaches every device, in the reader's own language, naming both ports", async () => {
    await notifyStaleHookUrlPush(REPORT);

    const byEndpoint = payloadsByEndpoint();
    const en = byEndpoint['https://push.example/en'];
    const ja = byEndpoint['https://push.example/ja'];

    // The title says which agent, so a worktree running three of them in
    // parallel can be told which pane to restart (#2125's rule).
    expect(en.title).toBe('rag-document (command-code)');
    expect(en.kind).toBe('failure');

    for (const payload of [en, ja]) {
      // Both numbers and the remedy: the fact on its own is not actionable,
      // because CommandMate deliberately does not repair it.
      expect(payload.body).toContain('3010');
      expect(payload.body).toContain('3000');
      expect(payload.body).toContain('Command Code CLI');
    }
    expect(en.body).toMatch(/restart the session/i);
    expect(ja.body).toContain('再起動');
    // Not the same sentence twice: a Japanese subscriber must not get English.
    expect(ja.body).not.toBe(en.body);
  });

  it('never reads like the generic failure copy', async () => {
    // The regression this guards is a `ProducerWordedFailureReason` losing its
    // body on the way and falling through to "Failed" / "失敗しました", which
    // names nothing an operator could act on.
    await notifyStaleHookUrlPush(REPORT);

    const bodies = Object.values(payloadsByEndpoint()).map((p) => p.body);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toBe('Failed');
      expect(body).not.toBe('失敗しました');
    }
  });

  it('gives a third server its own incident rather than repeating this one', async () => {
    // The signature is the dedup content, and it carries both ports — so a pane
    // that later points somewhere else is a new card even inside the 30 s
    // content window.
    await notifyStaleHookUrlPush(REPORT);
    const first = sendNotification.mock.calls.length;

    await notifyStaleHookUrlPush(REPORT);
    expect(sendNotification.mock.calls.length).toBe(first);

    await notifyStaleHookUrlPush({ ...REPORT, sessionPort: 3011 });
    expect(sendNotification.mock.calls.length).toBeGreaterThan(first);
  });
});

describe('[#2429] buildPushPayload with a producer-worded reason', () => {
  const BASE = { worktreeId: WT, worktreeName: 'rag-document', kind: 'failure' as const };

  it('renders the producer sentence verbatim, ignoring any excerpt', () => {
    const body = { en: 'Hooks go to 3010; this server is 3000.', ja: 'フックは 3010 宛です。' };

    for (const [locale, expected] of Object.entries(body)) {
      expect(
        buildPushPayload(
          {
            ...BASE,
            excerpt: 'ignored',
            failure: { reason: 'hook-url-stale', signature: 'sig', body },
          },
          locale,
          1000
        ).body
      ).toBe(expected);
    }
  });

  it('falls back to the generic copy when a producer forgets the body', () => {
    // Honest rather than misleading: nothing in the dictionary describes this
    // reason, so borrowing another signal's template would misreport it.
    expect(
      buildPushPayload(
        { ...BASE, failure: { reason: 'hook-url-stale', signature: 'sig' } },
        'en',
        1000
      ).body
    ).toBe('Failed');
  });

  it('leaves the dictionary-backed reasons exactly as #2000 shipped them', () => {
    expect(
      buildPushPayload(
        {
          ...BASE,
          excerpt: 'lint, unit',
          failure: { reason: 'verification-failed', signature: 'sig' },
        },
        'en',
        1000
      ).body
    ).toBe('Verification failed: lint, unit');
  });
});
