/**
 * API Routes Integration Tests - Kill Session with CLI Tool Support
 * Tests the /api/worktrees/:id/kill-session endpoint with multi-CLI tool support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as killSession } from '@/app/api/worktrees/[id]/kill-session/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Mock tmux
vi.mock('@/lib/tmux', () => ({
  killSession: vi.fn(() => Promise.resolve(true)),
  hasSession: vi.fn(() => Promise.resolve(true)),
}));

// Mock claude-poller
vi.mock('@/lib/claude-poller', () => ({
  stopPolling: vi.fn(),
}));

// Mock ws-server
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
}));

// Declare mock function type
declare module '@/lib/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

// Mock the database instance
vi.mock('@/lib/db-instance', () => {
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
    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
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

      const request = new Request('http://localhost:3000/api/worktrees/claude-test/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request as unknown as import('next/server').NextRequest, { params: { id: 'claude-test' } });

      expect(response.status).toBe(200);

      // Verify tmux killSession was called with correct session name
      const { killSession: killSessionMock } = await import('@/lib/tmux');
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

      const request = new Request('http://localhost:3000/api/worktrees/codex-test/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request as unknown as import('next/server').NextRequest, { params: { id: 'codex-test' } });

      expect(response.status).toBe(200);

      // Verify tmux killSession was called with correct session name
      const { killSession: killSessionMock } = await import('@/lib/tmux');
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

      const request = new Request('http://localhost:3000/api/worktrees/gemini-test/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request as unknown as import('next/server').NextRequest, { params: { id: 'gemini-test' } });

      expect(response.status).toBe(200);

      // Verify tmux killSession was called with correct session name
      const { killSession: killSessionMock } = await import('@/lib/tmux');
      expect(killSessionMock).toHaveBeenCalledWith('mcbd-gemini-gemini-test');
    });
  });

  describe('Error handling', () => {
    it('should return 404 when worktree not found', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/nonexistent/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request as unknown as import('next/server').NextRequest, { params: { id: 'nonexistent' } });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('not found');
    });

    it('should return 404 when session is not running', async () => {
      // Mock isRunning to return false
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

      const request = new Request('http://localhost:3000/api/worktrees/no-session/kill-session', {
        method: 'POST',
      });

      const response = await killSession(request as unknown as import('next/server').NextRequest, { params: { id: 'no-session' } });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('No active session');
    });
  });
});
