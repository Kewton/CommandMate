/**
 * A `claude -p` that cannot be exec'd at all rings too (Issue #2022).
 *
 * `POST /api/assistant/start` refuses a missing CLI and notifies, so this covers
 * the second window: the binary disappeared between that check and the send.
 * Assistant Chat never creates a tmux session, so `spawn`'s ENOENT is the only
 * refusal this path can produce — the exact fact
 * `SessionStartUnavailableError` names, which is why the existing
 * `session-start-unavailable` reason is reused rather than a new one invented.
 *
 * The narrowing matters as much as the notification: every other `error` event
 * is already reported to the user as a failed message, and ringing for all of
 * them would turn one missing dependency into a notification for every transient
 * exec fault. Both halves are asserted.
 *
 * What is driven is the real runner and the real notifier, with only `web-push`
 * mocked — so the assertion is a payload leaving the process.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository, type Repository } from '@/lib/db/db-repository';
import { createAssistantConversation, createAssistantMessage, getAssistantConversationById } from '@/lib/db';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
import { startNonInteractiveAssistantExecution } from '@/lib/assistant/non-interactive-runner';
// Statically imported for their side effect on the module cache, NOT to call
// them: the report reaches the notifier through two chained `await import()`s
// (the tool graph for `ICLITool.name`, then the notifier), and an uncached
// resolution takes an unbounded number of event-loop turns to settle. Loading
// them here makes both a cache hit, so `flush()` is a bounded drain rather than
// a race this file would lose intermittently (the #2009 suite's reasoning).
import '@/lib/cli-tools/manager';
import '@/lib/push/failure-push-notifier';

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

// `exec` / `execFile` are here because the tool graph the report loads to read
// `ICLITool.name` promisifies them at module scope; a `{ spawn }`-only mock
// makes that import throw, and the report would vanish into its own `.catch`.
vi.mock('child_process', () => ({ spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), execSync: vi.fn(), spawnSync: vi.fn() }));

// Nothing may reach a real tmux server from a unit suite.
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn().mockResolvedValue(''),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  setSessionEnvironment: vi.fn(),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

// The prompt builder walks the repository (git status, file reads); none of that
// changes what `spawn` answers.
vi.mock('@/lib/assistant/non-interactive-prompt-builder', () => ({
  buildNonInteractivePrompt: vi.fn(() => 'PROMPT'),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

let savedEnv: Record<string, string | undefined>;
let repository: Repository;
let conversationId: string;
let userMessageId: string;
let child: FakeChild;

function startExecution() {
  return startNonInteractiveAssistantExecution({
    db,
    conversationId,
    cliToolId: 'claude',
    repository,
    userMessageId,
    userMessage: 'hello',
  });
}

/** ENOENT as Node reports it from a failed `spawn`. */
function spawnEnoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
  error.code = 'ENOENT';
  error.syscall = 'spawn claude';
  error.path = 'claude';
  return error;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function failurePayloads(): Array<{ kind: string; body: string; title: string; url: string }> {
  return sendNotification.mock.calls
    .map(([, payload]) => JSON.parse(payload as string))
    .filter((p) => p.kind === 'failure');
}

beforeEach(() => {
  vi.clearAllMocks();
  sendNotification.mockResolvedValue({ statusCode: 201 });

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  repository = createRepository(db, {
    name: 'repo-alpha',
    path: '/tmp/repo-alpha',
    cloneSource: 'local',
  });
  conversationId = createAssistantConversation(db, {
    repositoryId: repository.id,
    cliToolId: 'claude',
    workingDirectory: repository.path,
    executionMode: 'non_interactive',
    status: 'ready',
  }).id;
  userMessageId = createAssistantMessage(db, {
    conversationId,
    role: 'user',
    content: 'hello',
    messageType: 'normal',
    deliveryStatus: 'pending',
    timestamp: new Date(),
  }).id;
  upsertPushSubscription(db, {
    endpoint: 'https://push.example/2022-runner',
    p256dh: 'p',
    auth: 'a',
    locale: 'en',
  });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  child = new FakeChild();
  vi.mocked(spawn).mockReturnValue(child as never);
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

describe('Issue #2022: the assistant runner reports a binary it cannot exec', () => {
  it('rings, addressed to the repository and the chat screen, on spawn ENOENT', async () => {
    await startExecution();
    child.emit('error', spawnEnoent());
    await flush();

    const payloads = failurePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].title).toBe('repo-alpha (claude)');
    expect(payloads[0].url).toBe('/chat');
    expect(payloads[0].body).toContain('Claude Code');
    expect(payloads[0].body).toContain('is not installed');
  });

  it('still finalizes the conversation exactly as Issue #1344 requires', async () => {
    await startExecution();
    child.emit('error', spawnEnoent());
    await flush();

    // The notification is advisory: it must not change what the conversation
    // does next, or a phone that cannot be reached would lock the chat.
    expect(getAssistantConversationById(db, conversationId)?.status).toBe('ready');
  });

  it('stays quiet for an error that is not a missing binary', async () => {
    await startExecution();
    const error: NodeJS.ErrnoException = new Error('spawn claude EAGAIN');
    error.code = 'EAGAIN';
    child.emit('error', error);
    await flush();

    // Already surfaced to the user as a failed message. Ringing here would make
    // every transient exec fault a push about a missing dependency.
    expect(failurePayloads()).toHaveLength(0);
    expect(getAssistantConversationById(db, conversationId)?.status).toBe('ready');
  });
});
