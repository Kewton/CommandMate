/**
 * API Routes Integration Tests - Kill Session with CLI Tool Support
 * Tests the /api/worktrees/:id/kill-session endpoint with multi-CLI tool support
 *
 * ## The contract this file pins changed in Issue #1905
 *
 * It used to assert that the route called `lib/tmux`'s `killSession(sessionName)`
 * itself. That is the exact thing #1905 removed: the route now goes through
 * `ICLITool.killSession(worktreeId, instanceId)` (design §4 D4), because reaching
 * past the gateway skipped every tool-specific shutdown step — most visibly
 * OpenCode's, where the pane was destroyed while the SSE subscription stayed open
 * and the allocated port stayed recorded as in use.
 *
 * The old assertion is NOT simply deleted. "The route does not kill the pane
 * itself" is a central acceptance criterion of #1905, so it is asserted the
 * positive way *and* the negative way, side by side: with each tool's
 * `killSession` stubbed, `cliTool.killSession` must be called with the resolved
 * (worktreeId, instanceId), and the tmux `killSession` mock must have zero calls.
 * A route that reached tmux directly fails both halves; a route that reached tmux
 * *in addition to* the gateway still fails the negative half. Both were confirmed
 * by mutation rather than assumed.
 *
 * Where the tmux kill lives now is asserted too — inside the tool, after its
 * graceful exit — so the end-to-end path (route → tool → tmux) still has a test
 * and the old `mcbd-<tool>-<worktree>` expectation is kept rather than dropped.
 *
 * ## Why this file failed on PR #1958, measured rather than assumed
 *
 * Two different failures, one cause. The `vi.mock` below exported only
 * `killSession` and `hasSession`, which was sufficient while the route did the
 * kill; once each tool's own `killSession` started running, they reached bindings
 * the mock does not define and vitest threw
 * `No "sendSpecialKey" export is defined on the "@/lib/tmux/tmux" mock`.
 *
 * - **`should kill claude session` → `Number of calls: 0`.** `stopSession`
 *   (session-key-sender) catches that throw and returns false, so the route saw a
 *   successful kill and answered 200 — but the tmux kill at the end of
 *   `stopSession` was never reached.
 * - **`should kill codex session` → `expected 500 to be 200`.** `CodexTool`
 *   rethrows instead of swallowing. With no `?cliTool` the route probes every
 *   tool, and a blanket `hasSession: true` made all seven report a live pane, so
 *   all seven targets threw and the route's "every target failed" branch answered
 *   500. The 500 was the route reporting the truth about a broken mock, not a
 *   route defect.
 *
 * Hence two changes to the mock: the tmux surface is mocked whole, and
 * `hasSession` defaults to **false** so a case is only about the tool it spies —
 * with it true, all seven tools run their graceful exits and the file spends
 * ~25 s sleeping (measured) for assertions about one route.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as killSessionRoute } from '@/app/api/worktrees/[id]/kill-session/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage, getWorktreeById } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock tmux. The whole surface a tool's `killSession` can touch — see the note
// above on why `killSession` + `hasSession` alone stopped being enough, and why
// `hasSession` defaults to false.
vi.mock('@/lib/tmux/tmux', () => ({
  killSession: vi.fn(() => Promise.resolve(true)),
  hasSession: vi.fn(() => Promise.resolve(false)),
  createSession: vi.fn(() => Promise.resolve(undefined)),
  capturePane: vi.fn(() => Promise.resolve('')),
  sendKeys: vi.fn(() => Promise.resolve(undefined)),
  sendSpecialKey: vi.fn(() => Promise.resolve(undefined)),
  sendSpecialKeys: vi.fn(() => Promise.resolve(undefined)),
  clearInputLine: vi.fn(() => Promise.resolve(undefined)),
  reconcileSessionGeometry: vi.fn(() => Promise.resolve(false)),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

// Mock ws-server
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
}));

// Declare mock function type
declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

// Mock the database instance
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDbInstance: () => {
      if (!mockDb) {
        throw new Error('Mock database not initialized');
      }
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

function post(worktreeId: string, query = ''): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${worktreeId}/kill-session${query}`,
    { method: 'POST' }
  );
  return killSessionRoute(request, { params: Promise.resolve({ id: worktreeId }) });
}

/** Drive a request whose tool sleeps through a graceful-exit wait. */
async function postWithTimers(worktreeId: string, query = ''): Promise<Response> {
  vi.useFakeTimers();
  try {
    const pending = post(worktreeId, query);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

function seedWorktree(db: Database.Database, id: string, cliToolId: CLIToolType): void {
  const worktree: Worktree = {
    id,
    name: `${cliToolId} Test`,
    path: `/path/to/${cliToolId}`,
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId,
  };
  upsertWorktree(db, worktree);
}

describe('POST /api/worktrees/:id/kill-session - CLI Tool Support', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
    // Restore vi.spyOn(...isRunning) spies so a running-session spy from one
    // test doesn't leak into the next (clearAllMocks resets calls, not spies).
    // Without this the "no session running" case sees other tools still spied
    // as running and returns 200 instead of 404 (Issue #1102).
    vi.restoreAllMocks();
  });

  describe('kills through the CLITool gateway (Issue #1905)', () => {
    const TOOLS: [CLIToolType, string, string][] = [
      ['claude', 'claude-test', 'mcbd-claude-claude-test'],
      ['codex', 'codex-test', 'mcbd-codex-codex-test'],
      ['gemini', 'gemini-test', 'mcbd-gemini-gemini-test'],
    ];

    it.each(TOOLS)(
      'should kill %s session through the tool, not through tmux',
      async (cliToolId, worktreeId, sessionName) => {
        const { CLIToolManager } = await import('@/lib/cli-tools/manager');
        const tool = CLIToolManager.getInstance().getTool(cliToolId);
        vi.spyOn(tool, 'isRunning').mockResolvedValue(true);
        const gatewayKill = vi.spyOn(tool, 'killSession').mockResolvedValue(undefined);

        seedWorktree(db, worktreeId, cliToolId);

        const response = await post(worktreeId);

        expect(response.status).toBe(200);
        // Positive half: the gateway is what the route calls, and it is handed
        // the ids — not a session name the route resolved for itself.
        expect(gatewayKill).toHaveBeenCalledWith(worktreeId, cliToolId);
        // Negative half: with the gateway stubbed, nothing should have reached
        // tmux. Before #1905 this is where the route killed the pane itself.
        const { killSession: tmuxKillSession } = await import('@/lib/tmux/tmux');
        expect(tmuxKillSession).not.toHaveBeenCalled();
        // The session name the old assertion cared about is still the one this
        // pane answers to; it is just no longer the route's business.
        expect(tool.getSessionName(worktreeId, cliToolId)).toBe(sessionName);
      }
    );

    /**
     * Where the tmux kill went. This one deliberately does NOT stub the tool, so
     * the path under test is the whole of route → tool → tmux: the graceful exit
     * runs first and the pane is destroyed afterwards, under the same session
     * name the pre-#1905 assertion expected.
     */
    it('lets the tool run its graceful exit before the pane is destroyed', async () => {
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const tmux = await import('@/lib/tmux/tmux');
      const claudeTool = CLIToolManager.getInstance().getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);
      // A live pane, so the tool takes its graceful branch instead of skipping
      // straight to the kill. Scoped with `?cliTool` so the other six tools do
      // not also report a pane and run their own exits.
      vi.mocked(tmux.hasSession).mockResolvedValue(true);

      seedWorktree(db, 'claude-test', 'claude');

      const response = await postWithTimers('claude-test', '?cliTool=claude');

      expect(response.status).toBe(200);
      expect(tmux.sendSpecialKey).toHaveBeenCalledWith('mcbd-claude-claude-test', 'C-d');
      expect(tmux.killSession).toHaveBeenCalledWith('mcbd-claude-claude-test');
      expect(vi.mocked(tmux.sendSpecialKey).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(tmux.killSession).mock.invocationCallOrder[0]
      );
    });

    /**
     * The route reports which panes it could not end instead of archiving their
     * messages and broadcasting `isRunning: false` over them (Issue #1905).
     */
    it('answers 500 with the failed session when the tool refuses to die', async () => {
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const claudeTool = CLIToolManager.getInstance().getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);
      vi.spyOn(claudeTool, 'killSession').mockRejectedValue(new Error('tmux is wedged'));

      seedWorktree(db, 'claude-test', 'claude');

      const response = await post('claude-test', '?cliTool=claude');

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        failedSessions: ['mcbd-claude-claude-test'],
      });
    });
  });

  describe('Error handling', () => {
    it('should return 404 when worktree not found', async () => {
      const response = await post('nonexistent');

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('not found');
    });

    it('should return 404 when session is not running', async () => {
      // No cliTool query param means the route probes every CLI tool. The tmux
      // hasSession probe reports no session, so isRunning() is false for ALL
      // tools (not just claude); otherwise other tools appear running and the
      // route returns 200 (Issue #1102).
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const manager = CLIToolManager.getInstance();
      const claudeTool = manager.getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(false);

      seedWorktree(db, 'no-session', 'claude');

      const response = await post('no-session');

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('No active session');
    });
  });

  describe('last_user_message recompute (Issue #1171)', () => {
    it('recomputes last_user_message from remaining messages after a targeted instance kill', async () => {
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const claudeTool = CLIToolManager.getInstance().getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);

      seedWorktree(db, 'wt-metadata', 'claude');

      // Primary-instance user message (older) — must remain and drive metadata.
      createMessage(db, {
        worktreeId: 'wt-metadata',
        role: 'user',
        content: 'primary remains',
        timestamp: new Date(1000),
        messageType: 'normal',
        cliToolId: 'claude',
        instanceId: 'claude',
      });
      // Alias-instance user message (newer) — archived by the targeted kill.
      createMessage(db, {
        worktreeId: 'wt-metadata',
        role: 'user',
        content: 'alias goes away',
        timestamp: new Date(2000),
        messageType: 'normal',
        cliToolId: 'claude',
        instanceId: 'claude-2',
      });

      // Before the kill: last_user_message is the newest (alias) message.
      expect(getWorktreeById(db, 'wt-metadata')?.lastUserMessage).toBe('alias goes away');

      const response = await post('wt-metadata', '?cliTool=claude&instance=claude-2');
      expect(response.status).toBe(200);

      // The alias message was archived; last_user_message falls back to the
      // still-active primary message rather than being cleared.
      expect(getWorktreeById(db, 'wt-metadata')?.lastUserMessage).toBe('primary remains');
    });

    it('clears last_user_message when the kill archives the last remaining message', async () => {
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const claudeTool = CLIToolManager.getInstance().getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);

      seedWorktree(db, 'wt-metadata-clear', 'claude');

      createMessage(db, {
        worktreeId: 'wt-metadata-clear',
        role: 'user',
        content: 'only message',
        timestamp: new Date(1000),
        messageType: 'normal',
        cliToolId: 'claude',
        instanceId: 'claude',
      });
      expect(getWorktreeById(db, 'wt-metadata-clear')?.lastUserMessage).toBe('only message');

      // Kill the only (primary) instance; its message is the last remaining one.
      const response = await post('wt-metadata-clear', '?cliTool=claude&instance=claude');
      expect(response.status).toBe(200);

      // No active user message remains → cleared (undefined), as before #1171.
      expect(getWorktreeById(db, 'wt-metadata-clear')?.lastUserMessage).toBeUndefined();
    });
  });
});
