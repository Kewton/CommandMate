/**
 * The hook-URL check fires where it was always needed: on a send into a session
 * that is already running (Issue #2433).
 *
 * ## What was wrong
 *
 * #2429 added the check — "this pane's launch line names a `CM_HOOK_URL` on
 * another port, so its lifecycle events are going somewhere else" — and hung it
 * off the adopt marker inside `BaseCLITool.startSession`. Measured 2026-09-08
 * against a live `mcbd-command-code-…` pane whose launch line named :3000 while
 * the server was :3010, it never once fired, from either a capture or a send.
 *
 * The chain is unreachable by construction. The marker is set in a tool's
 * `launchSession()` REUSE branch, so it needs `hasSession() === true`;
 * `launchSession()` is reached only through `startSession()`, and this route
 * calls `startSession()` only when `isRunning()` said false. For the three tools
 * that write `CM_HOOK_URL` onto the launch line at all — antigravity,
 * command-code, gemini — `isRunning()` IS `hasSession()`, so the two conditions
 * cannot both hold. The one situation #2429 was written for (a live pane raised
 * by another server, still being typed into) is exactly the one in which nothing
 * asks.
 *
 * ## Why this test is at the route and not at the method
 *
 * The Issue's acceptance says so, and it says so because the unit suite that
 * shipped with #2429 stayed green through all of the above: it calls
 * `warnIfHookUrlIsStale` directly, which proves the sentence is correct and says
 * nothing about whether anybody utters it. So everything below goes through the
 * real `POST /api/worktrees/:id/send` handler, the real `CLIToolManager`, and
 * the real `CommandCodeTool.isRunning()` — only tmux, the database, the push
 * notifier and the message send itself are stood in for. `capturePane` is
 * counted as well as observed, because the cost of asking on every Enter is the
 * reason #2429 did not ask here in the first place.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

/** `logger.warn` lines, in order, from every module under test. */
const warnLines = vi.hoisted(() => [] as Array<{ action: string; data?: Record<string, unknown> }>);

// Partial: the real module also publishes `generateRequestId` and the log
// config the rest of the graph reads, and a total mock would turn every log
// line in the code under test into a thrown error.
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  const stub: import('@/lib/logger').Logger = {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (action, data) => {
      warnLines.push({ action, data });
    },
    withContext: () => stub,
  };
  return { ...actual, createLogger: () => stub };
});

const hasSession = vi.fn();
const capturePane = vi.fn();
const killSession = vi.fn();
vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: (...args: unknown[]) => hasSession(...args),
    capturePane: (...args: unknown[]) => capturePane(...args),
    killSession: (...args: unknown[]) => killSession(...args),
    reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
    listSessions: vi.fn().mockResolvedValue([]),
  };
});

const getServerPort = vi.fn(() => 3000);
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  getServerPort: () => getServerPort(),
}));

const notifyStaleHookUrlPush = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/push/failure-push-notifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/failure-push-notifier')>()),
  notifyStaleHookUrlPush: (...args: unknown[]) => notifyStaleHookUrlPush(...args),
}));

const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));

// The create branch of the route touches both; neither is this Issue's subject.
vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => {
    throw new Error('not a repository');
  }),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { resetHookUrlProbesForTest } from '@/lib/cli-tools/base';
import { resetStaleHookUrlReportsForTest } from '@/lib/cli-tools/start-availability';

const WORKTREE_ID = 'wt-2433-send';

/**
 * The pane from the #2429 report, shortened: a launch line naming :3010 while
 * the server under test answers :3000. Single-quoted, `CM_PORT` beside the URL,
 * executable last — the shape `resolveAgentLaunchEnv` actually renders.
 */
const STALE_PANE = [
  '$ ',
  "CM_HOOK_URL='http://127.0.0.1:3010/api/hooks/agent-event?tool=command-code&worktreeId=wt-2433-send&instanceId=command-code' CM_PORT='3010' 'commandcode' --trust --skip-onboarding",
  '# Command Code v1.49.0',
  '❯ Ask your question...',
].join('\n');

/** The same pane, raised by THIS server. */
const CURRENT_PANE = STALE_PANE.replace(/3010/g, '3000');

function post(body: unknown) {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  });
}

/** Let the fire-and-forget probe and `reportStaleHookUrl`'s import settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every `session:hook-url-stale` line logged so far. */
function staleWarnings() {
  return warnLines.filter((line) => line.action === 'session:hook-url-stale');
}

describe('POST /send probes a RUNNING session\'s hook URL (Issue #2433)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    vi.clearAllMocks();
    warnLines.length = 0;
    resetHookUrlProbesForTest();
    resetStaleHookUrlReportsForTest();

    getServerPort.mockReturnValue(3000);
    hasSession.mockResolvedValue(true);
    capturePane.mockResolvedValue(STALE_PANE);
    killSession.mockResolvedValue(true);
    sendUserMessage.mockResolvedValue({
      ok: true,
      message: { id: 1, worktreeId: WORKTREE_ID, role: 'user', content: 'hi' },
    });

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Stale Hook URL',
      path: '/path/to/wt-2433-send',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'command-code',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('warns once, naming both ports, and leaves the session alive', async () => {
    // This is the reachability assertion: nothing here calls the probe by hand.
    // `hasSession` is true, so `CommandCodeTool.isRunning()` is true, so the
    // route skips `startSession()` — the exact branch in which #2429's check
    // could not run.
    const response = await post({ content: 'hello' });
    expect(response.status).toBe(201);
    await settle();

    expect(staleWarnings()).toHaveLength(1);
    expect(staleWarnings()[0].data).toMatchObject({
      cliToolId: 'command-code',
      sessionPort: 3010,
      serverPort: 3000,
    });
    expect(notifyStaleHookUrlPush).toHaveBeenCalledTimes(1);
    expect(notifyStaleHookUrlPush).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: WORKTREE_ID,
        cliToolId: 'command-code',
        toolName: 'Command Code CLI',
        sessionPort: 3010,
        serverPort: 3000,
      }),
    );

    // Warn, do not repair: the adopted session may be mid-turn, and killing a
    // generating agent to fix its telemetry costs the work.
    expect(killSession).not.toHaveBeenCalled();
    // And the message still went out.
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('says it once and then stops reading the pane at all', async () => {
    await post({ content: 'first' });
    await settle();
    const capturesAfterFirstSend = capturePane.mock.calls.length;
    expect(capturesAfterFirstSend).toBe(1);

    for (const content of ['second', 'third', 'fourth']) {
      await post({ content });
      await settle();
    }

    expect(staleWarnings()).toHaveLength(1);
    expect(notifyStaleHookUrlPush).toHaveBeenCalledTimes(1);
    // The cost half of the acceptance: three more sends, no more captures. The
    // ledger is consulted before tmux is touched, so a send into a pane already
    // read is a `Set` lookup and nothing else.
    expect(capturePane.mock.calls.length).toBe(capturesAfterFirstSend);
    expect(sendUserMessage).toHaveBeenCalledTimes(4);
  });

  it('reads the WHOLE scrollback, because the launch line is the oldest row', async () => {
    await post({ content: 'hello' });
    await settle();

    expect(capturePane).toHaveBeenCalledWith(
      `mcbd-command-code-${WORKTREE_ID}`,
      expect.objectContaining({ startLine: expect.any(Number) }),
    );
    const [, options] = capturePane.mock.calls[0] as [string, { startLine: number }];
    expect(options.startLine).toBeLessThanOrEqual(-20000);
  });

  it('says nothing when the pane names THIS server', async () => {
    // The control that keeps the test above from passing on a probe that always
    // warns.
    capturePane.mockResolvedValue(CURRENT_PANE);

    await post({ content: 'hello' });
    await settle();

    expect(staleWarnings()).toHaveLength(0);
    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
  });

  it('says nothing when the pane carries no hook URL at all', async () => {
    // claude and opencode keep their endpoint off the launch line; for them the
    // ordinary answer is "unreadable", and unreadable must never be a warning.
    capturePane.mockResolvedValue('$ commandcode\n❯ Ask your question...');

    await post({ content: 'hello' });
    await settle();

    expect(staleWarnings()).toHaveLength(0);
    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
  });

  it('treats a second instance as its own case', async () => {
    await post({ content: 'primary' });
    await settle();
    await post({ content: 'secondary', instanceId: 'command-code-2' });
    await settle();

    expect(staleWarnings()).toHaveLength(2);
    expect(notifyStaleHookUrlPush).toHaveBeenCalledTimes(2);
    expect(notifyStaleHookUrlPush).toHaveBeenLastCalledWith(
      expect.objectContaining({ instanceId: 'command-code-2', sessionPort: 3010 }),
    );
  });

  it('does not read the pane when the send CREATES the session', async () => {
    // The negative control the Issue names. A pane this server just typed the
    // launch line into is compared against its own port, so asking tmux would
    // buy nothing and cost a full-scrollback capture on the path the operator
    // is waiting on.
    const tool = CLIToolManager.getInstance().getTool('command-code');
    const isRunning = vi.spyOn(tool, 'isRunning').mockResolvedValue(false);
    const startSession = vi.spyOn(tool, 'startSession').mockResolvedValue(undefined);
    try {
      const response = await post({ content: 'hello' });
      expect(response.status).toBe(201);
      await settle();

      expect(startSession).toHaveBeenCalledTimes(1);
      expect(capturePane).not.toHaveBeenCalled();
      expect(staleWarnings()).toHaveLength(0);
      expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
    } finally {
      isRunning.mockRestore();
      startSession.mockRestore();
    }
  });

  it('never fails a send because the pane could not be captured', async () => {
    capturePane.mockRejectedValue(new Error("can't find pane"));

    const response = await post({ content: 'hello' });
    await settle();

    expect(response.status).toBe(201);
    expect(notifyStaleHookUrlPush).not.toHaveBeenCalled();
    // Not written off, either: a capture that never returned is not an answer,
    // so the next send asks again.
    await post({ content: 'again' });
    await settle();
    expect(capturePane.mock.calls.length).toBe(2);
  });
});
