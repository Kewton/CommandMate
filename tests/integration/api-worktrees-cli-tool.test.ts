/**
 * API Routes Integration Tests - Worktrees List with CLI Tool Support
 * Tests the /api/worktrees endpoint with multi-CLI tool support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as getWorktrees } from '@/app/api/worktrees/route';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Issue #405/#875: the worktrees route no longer calls cliTool.isRunning().
// Session-running status is derived from the batched tmux session list
// (listSessions) plus, for claude, a health check (isSessionHealthy). Tests
// drive those layers instead. Session name format is `mcbd-{cliToolId}-{worktreeId}`.
const mockListSessions = vi.fn(
  (): Promise<Array<{ name: string; windows: number; attached: boolean }>> => Promise.resolve([])
);
vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  listSessions: () => mockListSessions(),
}));

// Claude's presence is gated by a health check; force healthy so a listed
// claude session counts as running.
vi.mock('@/lib/session/claude-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/claude-session')>()),
  isSessionHealthy: vi.fn(() => Promise.resolve({ healthy: true })),
}));

// Avoid real tmux capture for running sessions; status detection (waiting/
// processing) is not under test here, only isSessionRunning/cliToolId.
vi.mock('@/lib/session/cli-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/cli-session')>()),
  captureSessionOutput: vi.fn(() => Promise.resolve('')),
}));

/** Build a listSessions() entry for a worktree's primary session of a CLI tool. */
function sessionEntry(cliToolId: string, worktreeId: string) {
  return { name: `mcbd-${cliToolId}-${worktreeId}`, windows: 1, attached: false };
}

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

describe('GET /api/worktrees - CLI Tool Support', () => {
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
    // Default: no tmux sessions running (each test opts specific ones in).
    mockListSessions.mockResolvedValue([]);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return correct session status for different CLI tools', async () => {
    // Running sessions: claude-wt and gemini-wt. codex-wt is absent → not running.
    mockListSessions.mockResolvedValue([
      sessionEntry('claude', 'claude-wt'),
      sessionEntry('gemini', 'gemini-wt'),
    ]);

    // Create test worktrees with different CLI tools
    const claudeWorktree: Worktree = {
      id: 'claude-wt',
      name: 'Claude Worktree',
      path: '/path/to/claude',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
      updatedAt: new Date('2025-01-18T10:00:00Z'),
    };

    const codexWorktree: Worktree = {
      id: 'codex-wt',
      name: 'Codex Worktree',
      path: '/path/to/codex',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'codex',
      updatedAt: new Date('2025-01-18T11:00:00Z'),
    };

    const geminiWorktree: Worktree = {
      id: 'gemini-wt',
      name: 'Gemini Worktree',
      path: '/path/to/gemini',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'gemini',
      updatedAt: new Date('2025-01-18T12:00:00Z'),
    };

    upsertWorktree(db, claudeWorktree);
    upsertWorktree(db, codexWorktree);
    upsertWorktree(db, geminiWorktree);

    const request = new NextRequest('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.worktrees).toHaveLength(3);

    // Check Claude worktree (running)
    const claudeWt = data.worktrees.find((wt: any) => wt.id === 'claude-wt');
    expect(claudeWt).toBeDefined();
    expect(claudeWt.cliToolId).toBe('claude');
    expect(claudeWt.isSessionRunning).toBe(true);

    // Check Codex worktree (not running)
    const codexWt = data.worktrees.find((wt: any) => wt.id === 'codex-wt');
    expect(codexWt).toBeDefined();
    expect(codexWt.cliToolId).toBe('codex');
    expect(codexWt.isSessionRunning).toBe(false);

    // Check Gemini worktree (running)
    const geminiWt = data.worktrees.find((wt: any) => wt.id === 'gemini-wt');
    expect(geminiWt).toBeDefined();
    expect(geminiWt.cliToolId).toBe('gemini');
    expect(geminiWt.isSessionRunning).toBe(true);
  });

  it('should default to claude when cliToolId is not specified', async () => {
    // The default worktree's claude session is running.
    mockListSessions.mockResolvedValue([sessionEntry('claude', 'default-wt')]);

    // Create worktree without cliToolId (defaults to claude)
    const worktree: Worktree = {
      id: 'default-wt',
      name: 'Default Worktree',
      path: '/path/to/default',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      // cliToolId not specified - should default to 'claude'
    };

    upsertWorktree(db, worktree);

    const request = new NextRequest('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    const defaultWt = data.worktrees.find((wt: any) => wt.id === 'default-wt');

    expect(defaultWt).toBeDefined();
    expect(defaultWt.cliToolId).toBe('claude');
    expect(defaultWt.isSessionRunning).toBe(true);
  });

  it('should include cliToolId in worktree response', async () => {
    // No running sessions (default) — this test only checks cliToolId passthrough.
    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'codex',
    };

    upsertWorktree(db, worktree);

    const request = new NextRequest('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.worktrees).toHaveLength(1);
    expect(data.worktrees[0].cliToolId).toBe('codex');
  });
});
