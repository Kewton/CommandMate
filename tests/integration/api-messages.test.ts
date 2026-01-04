/**
 * API Routes Integration Tests - Messages
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as getMessages } from '@/app/api/worktrees/[id]/messages/route';
import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import type { Worktree, ChatMessage } from '@/types/models';

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

describe('GET /api/worktrees/:id/messages', () => {
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
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return empty array when no messages exist', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/messages');
    const params = { params: { id: 'test-worktree' } };
    const response = await getMessages(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual([]);
  });

  it('should return messages sorted by timestamp DESC', async () => {
    // Create test messages
    const message1 = createMessage(db, {
      worktreeId: 'test-worktree',
      role: 'user',
      content: 'First message',
      messageType: 'normal',
      timestamp: new Date('2025-01-17T10:00:00Z'),
    });

    const message2 = createMessage(db, {
      worktreeId: 'test-worktree',
      role: 'assistant',
      content: 'Second message',
      messageType: 'normal',
      timestamp: new Date('2025-01-17T11:00:00Z'),
    });

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/messages');
    const params = { params: { id: 'test-worktree' } };
    const response = await getMessages(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveLength(2);

    // Should be sorted by timestamp DESC (newest first)
    expect(data[0].id).toBe(message2.id);
    expect(data[1].id).toBe(message1.id);
  });

  it('should support pagination with before parameter', async () => {
    // Create test messages
    const message1 = createMessage(db, {
      worktreeId: 'test-worktree',
      role: 'user',
      content: 'Message 1',
      messageType: 'normal',
      timestamp: new Date('2025-01-17T10:00:00Z'),
    });

    const message2 = createMessage(db, {
      worktreeId: 'test-worktree',
      role: 'user',
      content: 'Message 2',
      messageType: 'normal',
      timestamp: new Date('2025-01-17T11:00:00Z'),
    });

    const message3 = createMessage(db, {
      worktreeId: 'test-worktree',
      role: 'user',
      content: 'Message 3',
      messageType: 'normal',
      timestamp: new Date('2025-01-17T12:00:00Z'),
    });

    // Request messages before message3's timestamp
    const beforeDate = new Date('2025-01-17T11:30:00Z').toISOString();
    const request = new Request(
      `http://localhost:3000/api/worktrees/test-worktree/messages?before=${beforeDate}`
    );
    const params = { params: { id: 'test-worktree' } };
    const response = await getMessages(request as unknown as import('next/server').NextRequest, params);

    const data = await response.json();

    // Should only return message1 and message2 (before the specified time)
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe(message2.id);
    expect(data[1].id).toBe(message1.id);
  });

  it('should support pagination with limit parameter', async () => {
    // Create 5 test messages
    for (let i = 0; i < 5; i++) {
      createMessage(db, {
        worktreeId: 'test-worktree',
        role: 'user',
        content: `Message ${i}`,
        messageType: 'normal',
        timestamp: new Date(`2025-01-17T10:0${i}:00Z`),
      });
    }

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/messages?limit=3'
    );
    const params = { params: { id: 'test-worktree' } };
    const response = await getMessages(request as unknown as import('next/server').NextRequest, params);

    const data = await response.json();
    expect(data).toHaveLength(3);
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/nonexistent/messages');
    const params = { params: { id: 'nonexistent' } };
    const response = await getMessages(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/messages');
    const params = { params: { id: 'test-worktree' } };
    const response = await getMessages(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('POST /api/worktrees/:id/send', () => {
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
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should create a new user message', async () => {
    const requestBody = {
      content: 'Test user message',
    };

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await sendMessage(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data).toHaveProperty('id');
    expect(data.worktreeId).toBe('test-worktree');
    expect(data.role).toBe('user');
    expect(data.content).toBe('Test user message');
    expect(data).toHaveProperty('timestamp');
  });

  it('should reject request without content', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await sendMessage(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('content');
  });

  it('should reject request with empty content', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await sendMessage(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/nonexistent/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Test message' }),
    });
    const params = { params: { id: 'nonexistent' } };
    const response = await sendMessage(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Test message' }),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await sendMessage(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});
