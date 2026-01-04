/**
 * API Routes Integration Tests - Hooks
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as claudeDone } from '@/app/api/hooks/claude-done/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, getMessages, getSessionState } from '@/lib/db';
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
  capturePane: vi.fn(),
}));

describe('POST /api/hooks/claude-done', () => {
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

    // Reset tmux mock
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should capture tmux output and create Claude message', async () => {
    const { capturePane } = await import('@/lib/tmux');

    // Mock tmux output with log file info
    const mockOutput = `
Some command output
Previous lines...
───────────────────────────────────────────────────────────────
📄 Session log: /path/to/test/.claude/logs/2025-01-17_10-30-45_abc123.jsonl
Request ID: abc123
Summary: Implemented the user authentication feature
───────────────────────────────────────────────────────────────
    `.trim();

    vi.mocked(capturePane).mockResolvedValue(mockOutput);

    const requestBody = {
      worktreeId: 'test-worktree',
      sessionName: 'test-session',
    };

    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const response = await claudeDone(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    // Verify tmux was called
    expect(capturePane).toHaveBeenCalledWith('test-session', expect.any(Number));

    // Verify message was created
    const messages = getMessages(db, 'test-worktree');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('claude');
    expect(messages[0].summary).toBe('Implemented the user authentication feature');
    expect(messages[0].logFileName).toBe('2025-01-17_10-30-45_abc123.jsonl');
    expect(messages[0].requestId).toBe('abc123');

    // Verify session state was updated
    const sessionState = getSessionState(db, 'test-worktree');
    expect(sessionState).not.toBeNull();
    expect(sessionState?.lastCapturedLine).toBeGreaterThan(0);
  });

  it('should handle output without log file info', async () => {
    const { capturePane } = await import('@/lib/tmux');

    // Mock tmux output without log file separator
    const mockOutput = 'Some command output\nNo log info here';

    vi.mocked(capturePane).mockResolvedValue(mockOutput);

    const requestBody = {
      worktreeId: 'test-worktree',
      sessionName: 'test-session',
    };

    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const response = await claudeDone(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    // Verify message was created with default content
    const messages = getMessages(db, 'test-worktree');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('claude');
    expect(messages[0].content).toBeTruthy();
    expect(messages[0].logFileName).toBeUndefined();
    expect(messages[0].requestId).toBeUndefined();
  });

  it('should calculate lastCapturedLine correctly', async () => {
    const { capturePane } = await import('@/lib/tmux');

    const mockOutput = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    vi.mocked(capturePane).mockResolvedValue(mockOutput);

    const requestBody = {
      worktreeId: 'test-worktree',
      sessionName: 'test-session',
    };

    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    await claudeDone(request as unknown as import('next/server').NextRequest);

    const sessionState = getSessionState(db, 'test-worktree');
    expect(sessionState?.lastCapturedLine).toBe(5);
  });

  it('should reject request without worktreeId', async () => {
    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'test-session' }),
    });

    const response = await claudeDone(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('worktreeId');
  });

  it('should reject request without sessionName', async () => {
    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreeId: 'test-worktree' }),
    });

    const response = await claudeDone(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('sessionName');
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worktreeId: 'nonexistent',
        sessionName: 'test-session',
      }),
    });

    const response = await claudeDone(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 500 on database error', async () => {
    const { capturePane } = await import('@/lib/tmux');
    vi.mocked(capturePane).mockResolvedValue('Some output');

    db.close();

    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worktreeId: 'test-worktree',
        sessionName: 'test-session',
      }),
    });

    const response = await claudeDone(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should handle tmux capture errors gracefully', async () => {
    const { capturePane } = await import('@/lib/tmux');

    // Mock tmux error (returns empty string on error)
    vi.mocked(capturePane).mockResolvedValue('');

    const request = new Request('http://localhost:3000/api/hooks/claude-done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worktreeId: 'test-worktree',
        sessionName: 'test-session',
      }),
    });

    const response = await claudeDone(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    // Should still create a message even with empty capture
    const messages = getMessages(db, 'test-worktree');
    expect(messages).toHaveLength(1);
  });
});
