/**
 * The upstream fault reaches a phone from the POLLER, not from a read path
 * (Issue #2000).
 *
 * `upstreamFault` has existed since #1839, computed in `current-output-builder`
 * — which runs when a browser polls the status API or holds the WebSocket open.
 * That is the one situation a phone notification is not for. So the observation
 * is taken in `response-checker`, which the server runs on its own, and this
 * file drives the real `checkForResponse` with only `web-push` stubbed: a spied
 * notifier would pass with the observation wired to the wrong module.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const getSessionState = vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null }));
vi.mock('@/lib/db', () => ({
  createMessage: vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m })),
  getSessionState: (...a: unknown[]) => getSessionState(...(a as [])),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-2000f', name: 'feature-x' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { clearUpstreamFaultEpisodes } from '@/lib/push/failure-episode-state';
import { clearWaitingEpisodes } from '@/lib/session/waiting-episode-state';
import { stopWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';

const WT = 'wt-2000f';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

/** A Claude pane mid-turn with a 529 storm banner on it (shape from #1839). */
const FAULT_PANE = [
  '❯ run the migration',
  '',
  '⏺ Working on it…',
  '',
  'API Error: Repeated 529 Overloaded errors. Retrying in 34s · attempt 9/10',
].join('\n');

/** The same session with the banner gone — a healthy mid-turn frame. */
const CLEAN_PANE = [
  '❯ run the migration',
  '',
  '⏺ Working on it…',
  '',
  '  Reading src/lib/db/migrations/v57.ts',
].join('\n');

/**
 * A frame whose fault line has scrolled past the 100-row window the match is
 * judged on. The banner is still in the capture — 120 rows up — so a check that
 * read the whole capture instead of the tail would report a fault that the user
 * cannot see and `capture --json` does not publish.
 */
const SCROLLED_PAST_PANE = [
  'API Error: Repeated 529 Overloaded errors. Retrying in 34s · attempt 1/10',
  ...Array.from({ length: 120 }, (_, i) => `  line ${i}`),
].join('\n');

let savedEnv: Record<string, string | undefined>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function failurePayloads(): Array<{ kind: string; body: string }> {
  return sendNotification.mock.calls
    .map(([, payload]) => JSON.parse(payload as string) as { kind: string; body: string })
    .filter((p) => p.kind === 'failure');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-2000f', '/tmp/repo', 'repo', 1);
  upsertPushSubscription(db, {
    endpoint: 'https://push.example/a',
    p256dh: 'p',
    auth: 'a',
    locale: 'en',
  });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  vi.clearAllMocks();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  isSessionRunning.mockResolvedValue(true);
  getSessionState.mockReturnValue({ lastCapturedLine: 0, inProgressMessageId: null });

  stopPolling(WT, 'claude');
  clearWaitingEpisodes();
  clearUpstreamFaultEpisodes();
  resetNotificationDedup();
  resetWaitingPushDedup();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingEpisodes();
  clearUpstreamFaultEpisodes();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #2000: the poller notifies about an upstream fault', () => {
  it('sends one failure notification when the banner first appears', async () => {
    captureSessionOutput.mockResolvedValue(FAULT_PANE);

    await checkForResponse(WT, 'claude');
    await flush();

    expect(failurePayloads()).toHaveLength(1);
    expect(failurePayloads()[0].body).toContain('upstream API fault');
    expect(failurePayloads()[0].body).toContain('529 Overloaded');
  });

  it('does not send again on every poll of the same stall', async () => {
    captureSessionOutput.mockResolvedValue(FAULT_PANE);

    // Twenty polls — about 40 s of a stalled session at the 2 s interval.
    for (let i = 0; i < 20; i += 1) {
      stopPolling(WT, 'claude');
      await checkForResponse(WT, 'claude');
      await flush();
    }

    expect(failurePayloads()).toHaveLength(1);
  });

  it('says nothing about a healthy frame', async () => {
    captureSessionOutput.mockResolvedValue(CLEAN_PANE);

    await checkForResponse(WT, 'claude');
    await flush();

    expect(failurePayloads()).toHaveLength(0);
  });

  it('judges the same 100 rows the published upstreamFault field does', async () => {
    captureSessionOutput.mockResolvedValue(SCROLLED_PAST_PANE);

    await checkForResponse(WT, 'claude');
    await flush();

    expect(failurePayloads()).toHaveLength(0);
  });
});
