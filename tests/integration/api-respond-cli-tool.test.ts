/**
 * API Routes Integration Tests - Respond to Prompt with CLI Tool Support
 * Tests the /api/worktrees/:id/respond endpoint with multi-CLI tool support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as respondToPrompt } from '@/app/api/worktrees/[id]/respond/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import type { Worktree, ChatMessage } from '@/types/models';

// Mock tmux
vi.mock('@/lib/tmux', () => ({
  sendKeys: vi.fn(() => Promise.resolve()),
  sendMessageWithEnter: vi.fn(() => Promise.resolve()),
}));

// Mock claude-poller
vi.mock('@/lib/claude-poller', () => ({
  startPolling: vi.fn(),
}));

// Mock ws-server
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: vi.fn(),
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

describe('POST /api/worktrees/:id/respond - CLI Tool Support', () => {
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
    it('should send response to claude session', async () => {
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

      // Create prompt message
      const promptMessage: Partial<ChatMessage> = {
        worktreeId: 'claude-test',
        role: 'assistant',
        content: 'Do you want to proceed?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Do you want to proceed?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      };
      const message = createMessage(db, promptMessage as any);

      const request = new Request('http://localhost:3000/api/worktrees/claude-test/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'claude-test' } });

      expect(response.status).toBe(200);

      // Verify tmux sendMessageWithEnter was called with correct session name (Task-PRE-003)
      const { sendMessageWithEnter } = await import('@/lib/tmux');
      expect(sendMessageWithEnter).toHaveBeenCalledWith('mcbd-claude-claude-test', 'y', 100);
    });
  });

  describe('Codex tool', () => {
    it('should send response to codex session', async () => {
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

      // Create prompt message
      const promptMessage: Partial<ChatMessage> = {
        worktreeId: 'codex-test',
        role: 'assistant',
        content: 'Choose an option:\n 1. Option A\n 2. Option B',
        messageType: 'prompt',
        promptData: {
          type: 'multiple_choice',
          question: 'Choose an option',
          options: [
            { number: 1, label: 'Option A', isDefault: true },
            { number: 2, label: 'Option B' },
          ],
          status: 'pending',
        },
        timestamp: new Date(),
      };
      const message = createMessage(db, promptMessage as any);

      const request = new Request('http://localhost:3000/api/worktrees/codex-test/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: '1',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'codex-test' } });

      expect(response.status).toBe(200);

      // Verify tmux sendMessageWithEnter was called with correct session name (Task-PRE-003)
      const { sendMessageWithEnter } = await import('@/lib/tmux');
      expect(sendMessageWithEnter).toHaveBeenCalledWith('mcbd-codex-codex-test', '1', 100);
    });
  });

  describe('Gemini tool', () => {
    it('should send response to gemini session', async () => {
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

      // Create prompt message
      const promptMessage: Partial<ChatMessage> = {
        worktreeId: 'gemini-test',
        role: 'assistant',
        content: 'Do you want to continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Do you want to continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      };
      const message = createMessage(db, promptMessage as any);

      const request = new Request('http://localhost:3000/api/worktrees/gemini-test/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'no',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'gemini-test' } });

      expect(response.status).toBe(200);

      // Verify tmux sendMessageWithEnter was called with correct session name (Task-PRE-003)
      const { sendMessageWithEnter } = await import('@/lib/tmux');
      expect(sendMessageWithEnter).toHaveBeenCalledWith('mcbd-gemini-gemini-test', 'n', 100);
    });
  });

  describe('Error handling', () => {
    it('should return 404 when worktree not found', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/nonexistent/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'some-id',
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'nonexistent' } });

      expect(response.status).toBe(404);
    });
  });
});
