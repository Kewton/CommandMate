/**
 * API Routes Integration Tests - Prompt Handling
 * Tests the complete prompt detection and response flow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as respondToPrompt } from '@/app/api/worktrees/[id]/respond/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, createMessage, getMessageById } from '@/lib/db';
import type { Worktree } from '@/types/models';

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

// Mock tmux module
vi.mock('@/lib/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendMessageWithEnter: vi.fn().mockResolvedValue(undefined),
  isClaudeRunning: vi.fn().mockResolvedValue(true),
}));

// Mock claude-session module
vi.mock('@/lib/claude-session', () => ({
  getSessionName: vi.fn((worktreeId: string) => `mcbd-${worktreeId}`),
  isClaudeRunning: vi.fn().mockResolvedValue(true),
}));

// Mock claude-poller module
vi.mock('@/lib/claude-poller', () => ({
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
}));

// Mock ws-server module
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: vi.fn(),
}));

describe('POST /api/worktrees/:id/respond', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

    // Create test worktree
    const worktree: Worktree = {
      id: 'test-worktree',
      name: 'test',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
    };
    upsertWorktree(db, worktree);

    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
  });

  describe('Responding to prompts', () => {
    it('should respond to a yes/no prompt with "yes"', async () => {
      // Create a prompt message
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
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
      });

      // Send response
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.message).toBeDefined();
      expect(data.message.promptData.status).toBe('answered');
      expect(data.message.promptData.answer).toBe('yes');
      expect(data.message.promptData.answeredAt).toBeDefined();

      // Verify database was updated
      const updatedMessage = getMessageById(db, message.id);
      expect(updatedMessage).toBeDefined();
      expect(updatedMessage?.promptData?.status).toBe('answered');
      expect(updatedMessage?.promptData?.answer).toBe('yes');
    });

    it('should respond to a yes/no prompt with "no"', async () => {
      // Create a prompt message
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Do you want to delete this file?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Do you want to delete this file?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      // Send response
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'no',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.message.promptData.answer).toBe('no');
    });

    it('should send "y" to tmux when answering yes', async () => {
      const { sendMessageWithEnter } = await import('@/lib/tmux');

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'test-worktree' } });

      expect(sendMessageWithEnter).toHaveBeenCalledWith('mcbd-test-worktree', 'y', 100);
    });

    it('should send "n" to tmux when answering no', async () => {
      const { sendMessageWithEnter } = await import('@/lib/tmux');

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'no',
        }),
      });

      await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'test-worktree' } });

      expect(sendMessageWithEnter).toHaveBeenCalledWith('mcbd-test-worktree', 'n', 100);
    });

    it('should resume polling after responding', async () => {
      const { startPolling } = await import('@/lib/claude-poller');

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'test-worktree' } });

      expect(startPolling).toHaveBeenCalledWith('test-worktree');
    });

    it('should broadcast updated message via WebSocket', async () => {
      const { broadcastMessage } = await import('@/lib/ws-server');

      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      await respondToPrompt(request as unknown as import('next/server').NextRequest, { params: { id: 'test-worktree' } });

      expect(broadcastMessage).toHaveBeenCalledWith('message_updated', {
        worktreeId: 'test-worktree',
        message: expect.objectContaining({
          id: message.id,
          promptData: expect.objectContaining({
            status: 'answered',
            answer: 'yes',
          }),
        }),
      });
    });
  });

  describe('Error handling', () => {
    it('should return 400 if messageId is missing', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('messageId and answer are required');
    });

    it('should return 400 if answer is missing', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'some-id',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('messageId and answer are required');
    });

    it('should return 404 if message not found', async () => {
      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'nonexistent-id',
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Message not found');
    });

    it('should return 400 if message is not a prompt', async () => {
      // Create a normal message (not a prompt)
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'user',
        content: 'Hello',
        messageType: 'normal',
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'yes',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Message is not a prompt');
    });

    it('should return 400 if prompt already answered', async () => {
      // Create an already-answered prompt
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'answered',
          answer: 'yes',
          answeredAt: new Date().toISOString(),
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'no',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Prompt already answered');
    });

    it('should return 400 if answer is invalid', async () => {
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'maybe',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('Invalid answer');
    });
  });

  describe('Case insensitivity', () => {
    it('should accept "YES" as valid answer', async () => {
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'YES',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('should accept "Y" as valid answer', async () => {
      const message = createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Continue?',
        messageType: 'prompt',
        promptData: {
          type: 'yes_no',
          question: 'Continue?',
          options: ['yes', 'no'],
          status: 'pending',
        },
        timestamp: new Date(),
      });

      const request = new Request('http://localhost:3000/api/worktrees/test-worktree/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: message.id,
          answer: 'Y',
        }),
      });

      const response = await respondToPrompt(request as unknown as import('next/server').NextRequest, {
        params: { id: 'test-worktree' },
      });

      expect(response.status).toBe(200);
    });
  });
});
