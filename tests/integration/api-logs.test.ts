/**
 * API Routes Integration Tests - Logs
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as getLogs } from '@/app/api/worktrees/[id]/logs/route';
import { GET as getLogFile } from '@/app/api/worktrees/[id]/logs/[filename]/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import fs from 'fs';
import path from 'path';

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

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  },
}));

describe('GET /api/worktrees/:id/logs', () => {
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

    // Reset fs mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return list of log files', async () => {
    // Mock fs to return log files
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([
      '2025-01-17_10-30-45_abc123.jsonl' as any,
      '2025-01-17_11-00-00_def456.jsonl' as any,
    ]);
    vi.mocked(fs.statSync).mockImplementation((filePath: any) => {
      const filename = filePath.toString();
      // Return different mtimes based on filename
      if (filename.includes('11-00-00')) {
        return {
          isFile: () => true,
          size: 1024,
          mtime: new Date('2025-01-17T11:00:00Z'),
        } as any;
      } else {
        return {
          isFile: () => true,
          size: 1024,
          mtime: new Date('2025-01-17T10:30:45Z'),
        } as any;
      }
    });

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/logs');
    const params = { params: { id: 'test-worktree' } };
    const response = await getLogs(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveLength(2);
    expect(data[0].filename).toBe('2025-01-17_11-00-00_def456.jsonl');
    expect(data[1].filename).toBe('2025-01-17_10-30-45_abc123.jsonl');
    expect(data[0]).toHaveProperty('size');
    expect(data[0]).toHaveProperty('modifiedAt');
  });

  it('should return empty array when logs directory does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/logs');
    const params = { params: { id: 'test-worktree' } };
    const response = await getLogs(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual([]);
  });

  it('should filter out non-.jsonl files', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([
      '2025-01-17_10-30-45_abc123.jsonl' as any,
      'README.md' as any,
      '.DS_Store' as any,
    ]);
    vi.mocked(fs.statSync).mockImplementation((filePath: any) => ({
      isFile: () => filePath.toString().endsWith('.jsonl'),
      size: 1024,
      mtime: new Date('2025-01-17T10:30:45Z'),
    }) as any);

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/logs');
    const params = { params: { id: 'test-worktree' } };
    const response = await getLogs(request as unknown as import('next/server').NextRequest, params);

    const data = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].filename).toBe('2025-01-17_10-30-45_abc123.jsonl');
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/nonexistent/logs');
    const params = { params: { id: 'nonexistent' } };
    const response = await getLogs(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/logs');
    const params = { params: { id: 'test-worktree' } };
    const response = await getLogs(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

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

    // Reset fs mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return log file content', async () => {
    const mockLogContent = JSON.stringify({
      request_id: 'abc123',
      messages: [
        { role: 'user', content: 'Test message' },
      ],
    });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(mockLogContent);
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => true,
      size: mockLogContent.length,
      mtime: new Date('2025-01-17T10:30:45Z'),
    } as any);

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/2025-01-17_10-30-45_abc123.jsonl'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: '2025-01-17_10-30-45_abc123.jsonl',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('filename');
    expect(data.filename).toBe('2025-01-17_10-30-45_abc123.jsonl');
    expect(data).toHaveProperty('content');
    expect(data.content).toBe(mockLogContent);
  });

  it('should return 400 for invalid filename', async () => {
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

  it('should return 400 for non-.jsonl files', async () => {
    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/malicious.sh'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'malicious.sh',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('must be a .jsonl file');
  });

  it('should return 404 when log file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/logs/nonexistent.jsonl'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'nonexistent.jsonl',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request(
      'http://localhost:3000/api/worktrees/nonexistent/logs/test.jsonl'
    );
    const params = {
      params: {
        id: 'nonexistent',
        filename: 'test.jsonl',
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
      'http://localhost:3000/api/worktrees/test-worktree/logs/test.jsonl'
    );
    const params = {
      params: {
        id: 'test-worktree',
        filename: 'test.jsonl',
      },
    };
    const response = await getLogFile(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});
