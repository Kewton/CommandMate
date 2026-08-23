/**
 * A session that refuses to start reaches a phone (Issue #2000).
 *
 * `SessionStartFailedError` has existed since #1637 and was only ever an HTTP
 * response body. It is the clearest "you have to act" of the three signals —
 * #1637's own wording is "retrying will not help until that is resolved" — so
 * the notification is raised at the throw site.
 *
 * Its sibling `SessionStartTimeoutError` deliberately does NOT notify, and that
 * asymmetry is asserted here: #1637 documents a slow start as "a slow start,
 * not a failed one — nothing needs repairing", and a phone that buzzes for it
 * would be reporting the opposite.
 *
 * Driven through the real `startClaudeSession` with tmux stubbed and only
 * `web-push` mocked, so what is measured is a notification leaving the process.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { useIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

// #1722 writes a hooks settings file on every session start; without this the
// suite would litter the developer's real ~/.commandmate/hooks.
useIsolatedAgentHooksDir('session-start-failure-push-2000');

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

// Mirrors the mock set in tests/unit/lib/claude-session.test.ts: claude
// delegates its sends to this module (#1469), and the real one reaches tmux.
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    callback(null, {
      stdout: cmd.includes('which claude') ? '/usr/local/bin/claude' : '',
      stderr: '',
    });
    return {};
  }),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { capturePane, createSession, hasSession, sendKeys } from '@/lib/tmux/tmux';
import {
  CLAUDE_INIT_POLL_INTERVAL,
  CLAUDE_INIT_TIMEOUT,
  clearCachedClaudePath,
  startClaudeSession,
} from '@/lib/session/claude-session';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';

const WT = 'wt-2000-start';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

/** One of CLAUDE_SESSION_ERROR_PATTERNS — a start that cannot succeed. */
const NESTED_SESSION_ERROR =
  'Claude Code cannot be launched inside another Claude Code session';

let savedEnv: Record<string, string | undefined>;

/**
 * Let the fire-and-forget notification reach `web-push`.
 *
 * Real timers first: `vi.useFakeTimers()` fakes `setImmediate` too, so a
 * macrotask hop taken under them never runs. The session start has already
 * settled by the time this is called, so nothing is left for the fake clock.
 */
async function flush(): Promise<void> {
  vi.useRealTimers();
  await new Promise((resolve) => setImmediate(resolve));
}

function failurePayloads(): Array<{ kind: string; body: string; title: string }> {
  return sendNotification.mock.calls
    .map(
      ([, payload]) =>
        JSON.parse(payload as string) as { kind: string; body: string; title: string }
    )
    .filter((p) => p.kind === 'failure');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-2000-start', '/tmp/repo', 'repo', 1);
  upsertPushSubscription(db, {
    endpoint: 'https://push.example/start',
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
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(createSession).mockResolvedValue();
  vi.mocked(sendKeys).mockResolvedValue();
  clearCachedClaudePath();
  resetNotificationDedup();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetNotificationDedup();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #2000: session start failure notification', () => {
  it('notifies when the CLI prints an error it cannot start past', async () => {
    vi.mocked(capturePane).mockResolvedValue(NESTED_SESSION_ERROR);

    const promise = startClaudeSession({ worktreeId: WT, worktreePath: '/tmp/wt-2000-start' });
    const assertion = expect(promise).rejects.toThrow('reported an error while starting');
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2);
    await assertion;
    await flush();

    expect(failurePayloads()).toHaveLength(1);
    expect(failurePayloads()[0].title).toBe('feature-x (claude)');
    expect(failurePayloads()[0].body).toContain('Could not start the session');
    expect(failurePayloads()[0].body).toContain(NESTED_SESSION_ERROR);
  });

  it('stays quiet for a start that is merely slow', async () => {
    // #1637: the tmux session and its process are both alive and deliberately
    // left running. Nothing needs repairing, so nothing is worth a phone.
    vi.mocked(capturePane).mockResolvedValue('Loading...');

    const promise = startClaudeSession({ worktreeId: WT, worktreePath: '/tmp/wt-2000-start' });
    const assertion = expect(promise).rejects.toThrow('initialization timeout');
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);
    await assertion;
    await flush();

    expect(failurePayloads()).toHaveLength(0);
  });

  it('stays quiet for a start that succeeds', async () => {
    vi.mocked(capturePane).mockResolvedValue('> ');

    const promise = startClaudeSession({ worktreeId: WT, worktreePath: '/tmp/wt-2000-start' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4 + 5_000);
    await expect(promise).resolves.toBeUndefined();
    await flush();

    expect(failurePayloads()).toHaveLength(0);
  });
});
