/**
 * Assistant Chat rings when its CLI is missing, and its install check is the
 * tool's own (Issue #2022).
 *
 * ## What was wrong
 *
 * `POST /api/assistant/start` answered "is the CLI installed?" itself and
 * composed its own 503. That is the second gate #2009 removed from
 * `POST /api/worktrees/:id/send`, and its cost here was the same: the tools'
 * refusals — and with them the one seam that reports a failed start to a phone —
 * were unreachable, so a missing `claude` left the Home screen showing an error
 * and every subscribed device silent.
 *
 * ## Why the Issue's proposed fix would not have worked
 *
 * The Issue asked for the check to be **deleted**, on the reading that
 * `cliTool.startSession()` further down the handler would then take over. The
 * last two cases below are the measurement that says otherwise: that call is
 * dead code for every input the route accepts, so deleting the check would have
 * made start answer `status: 'ready'` for a tool that cannot run. Those cases
 * are not decoration — they are the reason the fix is a付け替え, and they fail
 * the moment `NON_INTERACTIVE_TOOLS` narrows and the branch comes back to life.
 *
 * ## What is driven
 *
 * The real route handler, against a real (in-memory) database, with `which`
 * failing and only `web-push` and tmux mocked. So the assertions are about a
 * payload leaving the process and a row that does or does not exist — not about
 * which functions were called.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let testDb: Database.Database;

/** Flipped per case: `false` makes every `which` lookup fail. */
let toolsOnPath = false;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

vi.mock('child_process', () => {
  const answer = (...args: unknown[]) => {
    const callback = args.find((a) => typeof a === 'function') as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    queueMicrotask(() =>
      toolsOnPath
        ? callback?.(null, '/usr/local/bin/tool\n', '')
        : callback?.(new Error('command not found'), '', '')
    );
    return {};
  };
  return { exec: vi.fn(answer), execFile: vi.fn(answer), spawn: vi.fn(answer) };
});

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

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => testDb }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { POST } from '@/app/api/assistant/start/route';
import { createRepository } from '@/lib/db/db-repository';
import { getAssistantConversationByRepositoryAndCliTool } from '@/lib/db';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isAssistantNonInteractiveTool } from '@/lib/assistant/tool-capabilities';
import { BaseCLITool } from '@/lib/cli-tools/base';
import { SESSION_START_UNAVAILABLE_CODE } from '@/lib/session/session-start-error';
// Statically imported for its side effect on the module cache, NOT to call it:
// the report reaches the notifier through `await import()`, and an uncached
// resolution takes an unbounded number of event-loop turns to settle. Loading it
// here makes that import a cache hit, so `flush()` is a bounded drain rather
// than a race this file would lose intermittently (the #2009 suite's reasoning).
import '@/lib/push/failure-push-notifier';

const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

let savedEnv: Record<string, string | undefined>;
let repositoryId: string;

function post(cliToolId: string, repoId = repositoryId): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/assistant/start', {
      method: 'POST',
      body: JSON.stringify({ cliToolId, repositoryId: repoId }),
    })
  );
}

/** Drain the fire-and-forget notification (it is deliberately not awaited). */
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
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  runMigrations(testDb);
  repositoryId = createRepository(testDb, {
    name: 'repo-alpha',
    path: '/tmp/repo-alpha',
    cloneSource: 'local',
  }).id;
  upsertPushSubscription(testDb, {
    endpoint: 'https://push.example/2022',
    p256dh: 'p',
    auth: 'a',
    locale: 'en',
  });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  toolsOnPath = false;
  vi.clearAllMocks();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  resetNotificationDedup();
});

afterEach(() => {
  resetNotificationDedup();
  testDb.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #2022: a missing CLI rings, and start still answers 503', () => {
  it('rings a phone, naming the tool and linking to the chat screen', async () => {
    const response = await post('claude');
    await flush();

    expect(response.status).toBe(503);

    const payloads = failurePayloads();
    expect(payloads).toHaveLength(1);
    // The repository names itself: `resolveWorktreeName` would have answered
    // with the raw `assistant-repo-<uuid>` id, which no reader recognises.
    expect(payloads[0].title).toBe('repo-alpha (claude)');
    // The tap target is Assistant Chat. `/worktrees/assistant-repo-<uuid>` is a
    // worktree page that does not exist.
    expect(payloads[0].url).toBe('/chat');
    expect(payloads[0].body).toContain('Claude Code');
    expect(payloads[0].body).toContain('is not installed');
  });

  it('answers 503 with the stable code and the tool\'s own remedy in the body', async () => {
    const response = await post('claude');
    const body = (await response.json()) as { error: string; code?: string };

    expect(response.status).toBe(503);
    // Unchanged status, new code: the same token `POST /api/worktrees/:id/send`
    // already publishes for this exact condition (#2009).
    expect(body.code).toBe(SESSION_START_UNAVAILABLE_CODE);
    // The body is now the tool's sentence rather than the route's
    // `CLI tool 'claude' is not installed` — it names the tool the way a human
    // does and says what to do, which the internal id never did.
    expect(body.error).toContain('Claude Code');
    expect(body.error).toContain('install');
  });

  it('leaves no conversation row behind when the start is refused', async () => {
    await post('claude');

    // The panel renders a chat as soon as `GET /api/assistant/conversation`
    // answers with a row, so a refused start that created one would replace the
    // Start screen the user never got past.
    expect(getAssistantConversationByRepositoryAndCliTool(testDb, repositoryId, 'claude')).toBeNull();
  });

  it('does not ring for a repository that does not exist', async () => {
    const response = await post('claude', 'no-such-repository');
    await flush();

    expect(response.status).toBe(404);
    expect(failurePayloads()).toHaveLength(0);
  });

  // =========================================================================
  // The dead-code measurement that redirected this fix
  // =========================================================================

  it('never reaches cliTool.startSession() for any tool it accepts', async () => {
    toolsOnPath = true;
    const startSession = vi.spyOn(BaseCLITool.prototype, 'startSession');

    const accepted: CLIToolType[] = [];
    for (const cliToolId of CLI_TOOL_IDS) {
      const response = await post(cliToolId);
      if (response.status !== 400) accepted.push(cliToolId);
    }

    // Every tool the route lets past is non-interactive, and the branch that
    // owns `startSession()` is guarded by the same predicate — so the seam
    // Issue #2022 was told to rely on cannot fire from here at all. Deleting
    // the install check, as the Issue asked, would therefore have produced a
    // successful start for an uninstalled tool rather than a notification.
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.filter((id) => !isAssistantNonInteractiveTool(id))).toEqual([]);
    expect(startSession).not.toHaveBeenCalled();

    startSession.mockRestore();
  });

  it('starts non-interactively when the CLI is present', async () => {
    toolsOnPath = true;

    const response = await post('claude');
    const body = (await response.json()) as { success: boolean; executionMode: string };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.executionMode).toBe('non_interactive');
    expect(failurePayloads()).toHaveLength(0);
  });
});
