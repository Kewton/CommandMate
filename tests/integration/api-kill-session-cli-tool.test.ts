/**
 * API Routes Integration Tests - Kill Session with CLI Tool Support
 * Tests the /api/worktrees/:id/kill-session endpoint with multi-CLI tool support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as killSession } from '@/app/api/worktrees/[id]/kill-session/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage, getWorktreeById } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Mock tmux
vi.mock('@/lib/tmux/tmux', () => ({
  killSession: vi.fn(() => Promise.resolve(true)),
  hasSession: vi.fn(() => Promise.resolve(true)),
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

  describe('Claude tool', () => {
    it('should kill claude session', async () => {
      // Mock isRunning to return true for claude session
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const manager = CLIToolManager.getInstance();
      const claudeTool = manager.getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);

      // Create test worktree with claude
      const worktree: Worktree = {
        id: 'claude-test',
        name: 'Claude Test',
        path: '/path/to/claude',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'claude',
      };
      upsertWorktree(db, worktree);

      const request = new NextRequest('http://localhost:3000/api/worktrees/claude-test/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request, { params: { id: 'claude-test' } });

      expect(response.status).toBe(200);

      // Verify tmux killSession was called with correct session name
      const { killSession: killSessionMock } = await import('@/lib/tmux/tmux');
      expect(killSessionMock).toHaveBeenCalledWith('mcbd-claude-claude-test');
    });
  });

  describe('Codex tool', () => {
    it('should kill codex session', async () => {
      // Mock isRunning to return true for codex session
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const manager = CLIToolManager.getInstance();
      const codexTool = manager.getTool('codex');
      vi.spyOn(codexTool, 'isRunning').mockResolvedValue(true);

      // Create test worktree with codex
      const worktree: Worktree = {
        id: 'codex-test',
        name: 'Codex Test',
        path: '/path/to/codex',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'codex',
      };
      upsertWorktree(db, worktree);

      const request = new NextRequest('http://localhost:3000/api/worktrees/codex-test/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request, { params: { id: 'codex-test' } });

      expect(response.status).toBe(200);

      // Verify tmux killSession was called with correct session name
      const { killSession: killSessionMock } = await import('@/lib/tmux/tmux');
      expect(killSessionMock).toHaveBeenCalledWith('mcbd-codex-codex-test');
    });
  });

  describe('Gemini tool', () => {
    it('should kill gemini session', async () => {
      // Mock isRunning to return true for gemini session
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const manager = CLIToolManager.getInstance();
      const geminiTool = manager.getTool('gemini');
      vi.spyOn(geminiTool, 'isRunning').mockResolvedValue(true);

      // Create test worktree with gemini
      const worktree: Worktree = {
        id: 'gemini-test',
        name: 'Gemini Test',
        path: '/path/to/gemini',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'gemini',
      };
      upsertWorktree(db, worktree);

      const request = new NextRequest('http://localhost:3000/api/worktrees/gemini-test/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request, { params: { id: 'gemini-test' } });

      expect(response.status).toBe(200);

      // Verify tmux killSession was called with correct session name
      const { killSession: killSessionMock } = await import('@/lib/tmux/tmux');
      expect(killSessionMock).toHaveBeenCalledWith('mcbd-gemini-gemini-test');
    });
  });

  describe('Error handling', () => {
    it('should return 404 when worktree not found', async () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees/nonexistent/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request, { params: { id: 'nonexistent' } });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('not found');
    });

    it('should return 404 when session is not running', async () => {
      // No cliTool query param means the route probes every CLI tool. Force the
      // tmux hasSession probe to report no session so isRunning() is false for
      // ALL tools (not just claude); otherwise the default hasSession=true mock
      // makes other tools appear running and the route returns 200 (Issue #1102).
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const manager = CLIToolManager.getInstance();
      const claudeTool = manager.getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(false);

      const worktree: Worktree = {
        id: 'no-session',
        name: 'No Session',
        path: '/path/to/no-session',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'claude',
      };
      upsertWorktree(db, worktree);

      const request = new NextRequest('http://localhost:3000/api/worktrees/no-session/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request, { params: { id: 'no-session' } });

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

      const worktree: Worktree = {
        id: 'wt-metadata',
        name: 'Metadata Test',
        path: '/path/to/meta',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'claude',
      };
      upsertWorktree(db, worktree);

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

      const request = new NextRequest(
        'http://localhost:3000/api/worktrees/wt-metadata/kill-session?cliTool=claude&instance=claude-2',
        { method: 'POST' },
      );
      const response = await killSession(request, { params: { id: 'wt-metadata' } });
      expect(response.status).toBe(200);

      // The alias message was archived; last_user_message falls back to the
      // still-active primary message rather than being cleared.
      expect(getWorktreeById(db, 'wt-metadata')?.lastUserMessage).toBe('primary remains');
    });

    it('clears last_user_message when the kill archives the last remaining message', async () => {
      const { CLIToolManager } = await import('@/lib/cli-tools/manager');
      const claudeTool = CLIToolManager.getInstance().getTool('claude');
      vi.spyOn(claudeTool, 'isRunning').mockResolvedValue(true);

      const worktree: Worktree = {
        id: 'wt-metadata-clear',
        name: 'Metadata Clear',
        path: '/path/to/meta2',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'claude',
      };
      upsertWorktree(db, worktree);

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
      const request = new NextRequest(
        'http://localhost:3000/api/worktrees/wt-metadata-clear/kill-session?cliTool=claude&instance=claude',
        { method: 'POST' },
      );
      const response = await killSession(request, { params: { id: 'wt-metadata-clear' } });
      expect(response.status).toBe(200);

      // No active user message remains → cleared (undefined), as before #1171.
      expect(getWorktreeById(db, 'wt-metadata-clear')?.lastUserMessage).toBeUndefined();
    });
  });
});
