/**
 * API Routes Integration Tests - Send Message with CLI Tool Support
 * Tests the /api/worktrees/:id/send endpoint with multi-CLI tool support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Mock CLI tool modules
vi.mock('@/lib/claude-session', () => ({
  startClaudeSession: vi.fn(),
  isClaudeRunning: vi.fn(() => Promise.resolve(false)),
  sendMessageToClaude: vi.fn(),
  isClaudeInstalled: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return false; }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-codex-${id}`; }
  }
}));

vi.mock('@/lib/cli-tools/gemini', () => ({
  GeminiTool: class {
    id = 'gemini';
    name = 'Gemini CLI';
    command = 'gemini';
    async isInstalled() { return true; }
    async isRunning() { return false; }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-gemini-${id}`; }
  }
}));

vi.mock('@/lib/claude-poller', () => ({
  startPolling: vi.fn(),
}));

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

describe('POST /api/worktrees/:id/send - CLI Tool Support', () => {
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

  describe('Default behavior (Claude)', () => {
    it('should use claude tool by default when no cliToolId specified', async () => {
      // Create test worktree (cli_tool_id defaults to 'claude')
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'Test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test message' }),
      });

      const response = await sendMessage(request, { params: { id: 'test-worktree' } });

      expect(response.status).toBe(201);

      // Verify Claude session was used
      const { startClaudeSession, sendMessageToClaude } = await import('@/lib/claude-session');
      expect(startClaudeSession).toHaveBeenCalledWith({
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/test',
        baseUrl: expect.any(String),
      });
      expect(sendMessageToClaude).toHaveBeenCalledWith('test-worktree', 'Test message');
    });
  });

  describe('Codex tool support', () => {
    it('should use codex tool when worktree has cliToolId=codex', async () => {
      // Create test worktree with codex
      const worktree: Worktree = {
        id: 'codex-worktree',
        name: 'Codex Test',
        path: '/path/to/codex-test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'codex',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/codex-worktree/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test codex message' }),
      });

      const response = await sendMessage(request, { params: { id: 'codex-worktree' } });

      expect(response.status).toBe(201);

      // Verify message was created
      const data = await response.json();
      expect(data).toHaveProperty('id');
      expect(data.content).toBe('Test codex message');
      expect(data.role).toBe('user');
    });

    it('should support cliToolId override in request body', async () => {
      // Create test worktree with claude (default)
      const worktree: Worktree = {
        id: 'test-override',
        name: 'Test Override',
        path: '/path/to/test-override',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-override/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message',
          cliToolId: 'codex',  // Override to use codex
        }),
      });

      const response = await sendMessage(request, { params: { id: 'test-override' } });

      expect(response.status).toBe(201);
    });
  });

  describe('Gemini tool support', () => {
    it('should use gemini tool when worktree has cliToolId=gemini', async () => {
      // Create test worktree with gemini
      const worktree: Worktree = {
        id: 'gemini-worktree',
        name: 'Gemini Test',
        path: '/path/to/gemini-test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
        cliToolId: 'gemini',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/gemini-worktree/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Test gemini message' }),
      });

      const response = await sendMessage(request, { params: { id: 'gemini-worktree' } });

      expect(response.status).toBe(201);

      // Verify message was created
      const data = await response.json();
      expect(data).toHaveProperty('id');
      expect(data.content).toBe('Test gemini message');
      expect(data.role).toBe('user');
    });
  });

  describe('Error handling', () => {
    it('should return 400 for invalid cliToolId', async () => {
      const worktree: Worktree = {
        id: 'test-invalid',
        name: 'Test Invalid',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'TestRepo',
      };
      upsertWorktree(db, worktree);

      const request = new Request('http://localhost:3000/api/worktrees/test-invalid/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message',
          cliToolId: 'invalid-tool',  // Invalid tool
        }),
      });

      const response = await sendMessage(request, { params: { id: 'test-invalid' } });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('Invalid CLI tool');
    });
  });
});
