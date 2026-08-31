/**
 * Which worktree a fan-out was for, as told by the log alone (Issue #2133).
 *
 * ## Why the log is the surface under test
 *
 * `push-fanout-complete` used to read `{kind, delivered, failed}` — nothing about
 * the subject. Three of the steps in `docs/qa/2001-cross-device-dismissal-uat.md`
 * (T-4 / T-6 / T-7) pass by observing that **no** notification went out, and the
 * only way to observe that on a running server is to count these lines. On
 * 2026-08-29 the Epic #2002 run had two lines land in the same second from a
 * neighbouring worktree; they were separated only because a co-timed
 * `resolution-push-sent` happened to name its `worktreeId`. A plain waiting push
 * has no such partner, so the reading was one coincidence away from wrong.
 *
 * So the property here is not "the object has a key". It is: **two fan-outs that
 * overlap in time can be told apart from their log lines and nothing else.**
 * That is why the concurrent case drives both directions through the real sender
 * at once rather than asserting one call's shape twice.
 *
 * ## Driven through the real sender against a real database
 *
 * Same construction as the #2001 / #2057 / #2124 suites, for the same reason:
 * only `web-push` is stubbed. A spied logger over a spied sender would agree
 * with itself while the line the operator greps stayed unchanged.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
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

// vi.hoisted so the instance exists when the hoisted vi.mock below runs.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { upsertPushSubscription } from '@/lib/db';
import { notifyPushSubscribers } from '@/lib/push/push-sender';
import { notifyPromptResolved } from '@/lib/push/resolution-push-notifier';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { clearAllPromptCards, markPromptCardShown } from '@/lib/push/prompt-card-state';
import { clearWaitingEpisodes } from '@/lib/session/waiting-episode-state';

const DEVICE_A = 'https://push.example/device-a';
const DEVICE_B = 'https://push.example/device-b';
const NOW = 1_800_000_000_000;

function register(endpoint: string): void {
  upsertPushSubscription(db, {
    endpoint,
    p256dh: 'p256dh-placeholder',
    auth: 'auth-placeholder',
    deviceLabel: 'test device',
    locale: 'en',
  });
}

/** Every `push-fanout-complete` context logged so far, in order. */
function fanoutLines(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls
    .filter(([action]) => action === 'push-fanout-complete')
    .map(([, context]) => context as Record<string, unknown>);
}

/** The context of the one `resolution-push-sent` line. */
function resolutionSentLine(): Record<string, unknown> | undefined {
  const call = mockLogger.info.mock.calls.find(([action]) => action === 'resolution-push-sent');
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('push-fanout-complete names its subject (Issue #2133)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    process.env.CM_VAPID_PUBLIC_KEY = 'BPublicKeyPlaceholder';
    process.env.CM_VAPID_PRIVATE_KEY = 'PrivateKeyPlaceholder';
    sendNotification.mockReset();
    sendNotification.mockResolvedValue(undefined);
    setVapidDetails.mockReset();
    resetNotificationDedup();
    resetWaitingPushDedup();
    clearAllPromptCards();
    clearWaitingEpisodes();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    register(DEVICE_A);
  });

  afterEach(() => {
    delete process.env.CM_VAPID_PUBLIC_KEY;
    delete process.env.CM_VAPID_PRIVATE_KEY;
    clearWaitingEpisodes();
    db.close();
  });

  it('carries the worktree the notification was about', async () => {
    await notifyPushSubscribers(
      { kind: 'prompt', worktreeId: 'wt-alpha', worktreeName: 'alpha', excerpt: 'continue?' },
      NOW
    );

    expect(fanoutLines()).toEqual([
      { kind: 'prompt', worktreeId: 'wt-alpha', delivered: 1, failed: 0 },
    ]);
  });

  it('tells two worktrees apart when they fan out at the same instant', async () => {
    // The acceptance condition, driven the way the incident happened: two
    // waiting pushes in flight together, same kind, same second — so the subject
    // is the *only* thing that separates them. One device fails for one of them
    // only, because the pairing is what matters: a summary that named a shared or
    // last-written worktree would still print two lines with the right counts,
    // and a reader counting "my worktree's pushes" would still be misled.
    register(DEVICE_B);
    sendNotification.mockImplementation((sub: { endpoint: string }, payload: string) =>
      sub.endpoint === DEVICE_B && payload.includes('wt-beta')
        ? Promise.reject(new Error('push service refused'))
        : Promise.resolve(undefined)
    );

    await Promise.all([
      notifyPushSubscribers(
        {
          kind: 'prompt',
          worktreeId: 'wt-alpha',
          worktreeName: 'alpha',
          excerpt: 'continue?',
          agentName: 'claude',
          instanceId: 'claude-2',
        },
        NOW
      ),
      notifyPushSubscribers(
        {
          kind: 'prompt',
          worktreeId: 'wt-beta',
          worktreeName: 'beta',
          excerpt: 'approve?',
          agentName: 'codex',
          instanceId: 'codex-3',
        },
        NOW
      ),
    ]);

    const lines = fanoutLines();
    expect(lines).toHaveLength(2);
    // Order between two concurrent fan-outs is not a property worth fixing; that
    // the reader can pick their own line out of the pair is.
    expect(lines).toContainEqual({
      kind: 'prompt',
      worktreeId: 'wt-alpha',
      instanceId: 'claude-2',
      delivered: 2,
      failed: 0,
    });
    expect(lines).toContainEqual({
      kind: 'prompt',
      worktreeId: 'wt-beta',
      instanceId: 'codex-3',
      delivered: 1,
      failed: 1,
    });
  });

  it('falls back to the agent name when no producer set an instance id', async () => {
    // The documented resolution of `NotificationEvent.instanceId`, and the one
    // the episode dedup key already uses. `resolution-push-notifier` reaches the
    // sender with `agentName` only, so without the fallback every resolution
    // fan-out would log no instance at all.
    await notifyPushSubscribers(
      {
        kind: 'prompt',
        worktreeId: 'wt-alpha',
        worktreeName: 'alpha',
        excerpt: 'continue?',
        agentName: 'claude-4',
      },
      NOW
    );

    expect(fanoutLines()[0]).toMatchObject({ instanceId: 'claude-4' });
  });

  it('omits instanceId from the line rather than logging an empty string', async () => {
    // The dedup key coerces a missing instance to `''` because a Map key has to
    // exist. A log line must not: `"instanceId":""` reads as "an instance with no
    // name" to whoever greps it, and JSON.stringify drops `undefined` outright.
    await notifyPushSubscribers(
      { kind: 'prompt', worktreeId: 'wt-alpha', worktreeName: 'alpha', excerpt: 'continue?' },
      NOW
    );

    const line = fanoutLines()[0];
    expect(line.instanceId).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain('instanceId');
  });

  it.each([
    { lang: 'ja', file: 'docs/user-guide/webapp-guide.md' },
    { lang: 'en', file: 'docs/en/user-guide/webapp-guide.md' },
  ])('the $lang guide prints the line this sender actually emits', async ({ file }) => {
    // Issue #2133's acceptance asks for code and documentation to agree, and the
    // guides teach the reader to grep this line by `worktreeId`. A sample that
    // shows a key the sender stopped emitting teaches a grep that silently
    // matches nothing — worse than no sample, because it reads as verified.
    // So the sample is compared against a real fan-out rather than eyeballed.
    await notifyPushSubscribers(
      {
        kind: 'prompt',
        worktreeId: 'wt-alpha',
        worktreeName: 'alpha',
        excerpt: 'continue?',
        instanceId: 'claude-2',
      },
      NOW
    );

    const text = fs.readFileSync(path.join(path.resolve(__dirname, '../../..'), file), 'utf-8');
    const sample = /push-fanout-complete (\{.*?\})/.exec(text);
    expect(sample, `${file} shows no push-fanout-complete sample`).not.toBeNull();

    expect(Object.keys(JSON.parse(sample![1]) as Record<string, unknown>)).toEqual(
      Object.keys(fanoutLines()[0])
    );
  });

  it('agrees with resolution-push-sent on the key names, so one episode greps together', async () => {
    // `resolution-push-notifier` was already logging `{worktreeId, instanceId}`;
    // #2133 aligned the fan-out line with it deliberately. If the two drift apart
    // the operator needs two greps to follow one wait, which is the state the
    // Issue was filed about.
    register(DEVICE_B);
    markPromptCardShown('wt-alpha', NOW);

    await notifyPromptResolved({ worktreeId: 'wt-alpha', agentName: 'claude-2', at: NOW });

    const resolution = resolutionSentLine();
    expect(resolution).toMatchObject({
      worktreeId: 'wt-alpha',
      instanceId: 'claude-2',
      reason: 'cross-device-clear',
    });
    expect(fanoutLines()).toEqual([
      { kind: 'prompt', worktreeId: 'wt-alpha', instanceId: 'claude-2', delivered: 2, failed: 0 },
    ]);
  });
});
