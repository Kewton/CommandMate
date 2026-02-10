/**
 * API Routes Integration Tests - Logs
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 *
 * Issue #11: Updated to match current route.ts implementations
 * - fs mocks changed from sync (existsSync, readdirSync, readFileSync, statSync)
 *   to fs/promises (stat, readFile, readdir, access, mkdir)
 * - File extension changed from .jsonl to .md
 * - Error messages updated to match current validation ("Invalid filename")
 * - Added worktreeId prefix validation tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as getLogFile } from '@/app/api/worktrees/[id]/logs/[filename]/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
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

// Mock fs/promises module (used by both logs/route.ts and logs/[filename]/route.ts)
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    access: vi.fn(),
    mkdir: vi.fn(),
  },
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock log-manager (used by logs/route.ts)
vi.mock('@/lib/log-manager', () => ({
  listLogs: vi.fn(),
}));

// Mock log-config (used by logs/[filename]/route.ts)
vi.mock('@/config/log-config', () => ({
  getLogDir: vi.fn(() => '/mock/data/logs'),
}));

// Mock log-export-sanitizer (used by logs/[filename]/route.ts)
vi.mock('@/lib/log-export-sanitizer', () => ({
  sanitizeForExport: vi.fn((content: string) => content),
}));

describe('GET /api/worktrees/:id/logs/:filename', () => {
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

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return log file content', async () => {
    const fs = await import('fs/promises');
    const mockLogContent = '# Claude Code Conversation Log: test-worktree\n\nCreated: 2025-01-17 10:30:45\n\n---\n';

    vi.mocked(fs.default.stat).mockResolvedValue({
      isFile: () => true,
      size: mockLogContent.length,
      mtime: new Date('2025-01-17T10:30:45Z'),
    } as any);
    vi.mocked(fs.default.readFile).mockResolvedValue(mockLogContent);

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/test-worktree-2025-01-17.md'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'test-worktree-2025-01-17.md',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('filename');
    expect(data.filename).toBe('test-worktree-2025-01-17.md');
    expect(data).toHaveProperty('content');
    expect(data.content).toBe(mockLogContent);
    expect(data).toHaveProperty('cliToolId');
  });

  it('should return 400 for invalid filename (path traversal)', async () => {
    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/../../../etc/passwd'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: '../../../etc/passwd',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('Invalid filename');
  });

  it('should return 400 for non-.md files', async () => {
    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/test-worktree-malicious.sh'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'test-worktree-malicious.sh',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('Invalid filename');
  });

  it('should return 400 for filename not starting with worktree ID prefix', async () => {
    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/other-worktree-2025-01-17.md'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'other-worktree-2025-01-17.md',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('Invalid filename');
  });

  it('should return 404 when log file does not exist in any CLI tool directory', async () => {
    const fs = await import('fs/promises');

    // All CLI tool directories return ENOENT
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fs.default.stat).mockRejectedValue(enoentError);

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/test-worktree-nonexistent.md'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'test-worktree-nonexistent.md',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request(
      'http://localhost:3000/api/worktrees/nonexistent/logs/nonexistent-test.md'
    );
    const params = {
      params: {
        id: 'nonexistent',
        filename: 'nonexistent-test.md',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/test-worktree-test.md'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'test-worktree-test.md',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});
