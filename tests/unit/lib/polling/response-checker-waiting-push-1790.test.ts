/**
 * The poller and the waiting edge report one wait, not two (Issue #1790).
 *
 * `response-checker` still raises the prompt notification — the edge alone would
 * not do, because `observeWaitingEdge` is called from the worktree status API
 * and therefore only when a client is looking, which is not the situation a
 * phone notification exists for. So both producers are live, and what has to be
 * true is that they *agree*: the poller opens the same episode the status probe
 * would, and the second report of a wait says nothing.
 *
 * Driven through the real `checkForResponse` with a real database and only
 * `web-push` stubbed, because a spied `notifyPushSubscribers` would count calls
 * rather than notifications and pass with the dedup removed.
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

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const getSessionState = vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...(a as [])),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-1790p', name: 'feature-x' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import {
  resetNotificationDedup,
  resetWaitingPushDedup,
} from '@/lib/push/notification-dedup';
import {
  isWaitingPushNotifierActive,
  stopWaitingPushNotifier,
  startWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  getWaitingEpisode,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-1790p';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

/** A Claude pane sitting on a permission prompt. */
const PROMPT_PANE = [
  '❯ apply the refactor',
  '',
  '⏺ I need permission to edit the file.',
  '',
  'Do you want to make this edit to useVirtualKeyboard.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

/** The same pane after the edit was approved and Claude answered. */
const REPLY_PANE = [
  '❯ apply the refactor',
  '⏺ Done — the hook now debounces resize events.',
  '',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
  '  ⏸ manual mode on · ? for shortcuts                       focus',
].join('\n');

let savedEnv: Record<string, string | undefined>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The notification payloads actually handed to web-push. */
function payloads(): Array<{ kind: string; body: string }> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as { kind: string; body: string }
  );
}

function promptPayloads(): Array<{ kind: string; body: string }> {
  return payloads().filter((p) => p.kind === 'prompt');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
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
  resetNotificationDedup();
  resetWaitingPushDedup();
  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingEpisodes();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #1790: the poller and the edge name the same wait', () => {
  it('arms the edge subscription just by being loaded', () => {
    // The listener has to exist before the first edge, and `server.ts` reaches
    // this module at boot. Nothing in this file called `startWaitingPushNotifier`
    // before the import, so an active subscription here is the module's own.
    expect(isWaitingPushNotifierActive()).toBe(true);
  });

  it('opens the episode the status probe would have opened', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);

    expect(await checkForResponse(WT, 'claude')).toBe(true);
    await flush();

    const episode = getWaitingEpisode(WT, 'claude');
    expect(episode).not.toBeNull();
    expect(episode?.kind).toBe('prompt');
    expect(promptPayloads()).toHaveLength(1);
    // The poller's body, quoting what the agent actually asked.
    expect(promptPayloads()[0].body).toContain('useVirtualKeyboard.ts');
  });

  it('sends nothing extra when the status probe then reports the same wait', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);
    await checkForResponse(WT, 'claude');
    await flush();
    expect(promptPayloads()).toHaveLength(1);

    // What `/api/worktrees` does a moment later, for the wait already open.
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt' });
    await flush();

    expect(promptPayloads()).toHaveLength(1);
  });

  it('closes the episode on a reply, so the next prompt notifies again', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);
    await checkForResponse(WT, 'claude');
    await flush();
    expect(promptPayloads()).toHaveLength(1);

    // The agent answers. Without the closing edge the wait would stay open and
    // every later prompt of this session would be folded into it.
    stopPolling(WT, 'claude');
    captureSessionOutput.mockResolvedValue(REPLY_PANE);
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    await flush();
    expect(getWaitingEpisode(WT, 'claude')).toBeNull();

    // A second, byte-identical prompt — well inside the 30 s window the old
    // content dedup would have swallowed it in.
    stopPolling(WT, 'claude');
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    await flush();

    expect(promptPayloads()).toHaveLength(2);
  });
});
