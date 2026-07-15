/**
 * API File Operations Integration Tests
 * Tests for PUT, POST, DELETE, PATCH methods on /api/worktrees/:id/files/:path
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PUT, POST, DELETE, PATCH, GET } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

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

describe('File Operations API', () => {
  let db: Database.Database;
  let testDir: string;
  let worktree: Worktree;

  beforeEach(async () => {
    // Create in-memory database
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    // Create test directory
    testDir = join(tmpdir(), `api-file-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Create test worktree
    worktree = {
      id: 'test-worktree',
      name: 'test',
      path: testDir,
      repositoryPath: testDir,
      repositoryName: 'TestRepo',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createRequest(
    method: string,
    path: string,
    body?: object,
    queryParams?: Record<string, string>
  ): NextRequest {
    let url = `http://localhost:3000/api/worktrees/test-worktree/files/${path}`;
    if (queryParams) {
      const params = new URLSearchParams(queryParams);
      url += `?${params.toString()}`;
    }

    return new NextRequest(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  describe('PUT /api/worktrees/:id/files/:path', () => {
    it('should update file content', async () => {
      // Create test file
      writeFileSync(join(testDir, 'test.md'), '# Old Content');

      const request = createRequest('PUT', 'test.md', { content: '# New Content' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['test.md'] }) };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(readFileSync(join(testDir, 'test.md'), 'utf-8')).toBe('# New Content');
    });

    it('should return 404 for non-existent file', async () => {
      const request = createRequest('PUT', 'nonexistent.md', { content: 'content' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['nonexistent.md'] }) };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FILE_NOT_FOUND');
    });

    it('should reject non-editable file types', async () => {
      writeFileSync(join(testDir, 'script.js'), 'console.log("test")');

      const request = createRequest('PUT', 'script.js', { content: 'new code' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['script.js'] }) };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_EDITABLE');
    });

    it('should reject path traversal', async () => {
      const request = createRequest('PUT', '../etc/passwd', { content: 'malicious' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['..', 'etc', 'passwd'] }) };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_PATH');
    });

    it('should reject binary content', async () => {
      writeFileSync(join(testDir, 'test.md'), '# Test');

      const request = createRequest('PUT', 'test.md', { content: 'Hello\x00World' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['test.md'] }) };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CONTENT');
    });
  });

  describe('POST /api/worktrees/:id/files/:path', () => {
    it('should create new file', async () => {
      const request = createRequest('POST', 'new-file.md', { type: 'file', content: '# New File' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['new-file.md'] }) };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(existsSync(join(testDir, 'new-file.md'))).toBe(true);
      expect(readFileSync(join(testDir, 'new-file.md'), 'utf-8')).toBe('# New File');
    });

    it('should create new directory', async () => {
      const request = createRequest('POST', 'new-dir', { type: 'directory' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['new-dir'] }) };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(existsSync(join(testDir, 'new-dir'))).toBe(true);
    });

    it('should return 409 if file exists', async () => {
      writeFileSync(join(testDir, 'existing.md'), 'content');

      const request = createRequest('POST', 'existing.md', { type: 'file', content: 'new' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['existing.md'] }) };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FILE_EXISTS');
    });

    it('should reject invalid type', async () => {
      const request = createRequest('POST', 'test.md', { type: 'invalid' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['test.md'] }) };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
    });
  });

  describe('DELETE /api/worktrees/:id/files/:path', () => {
    it('should delete file', async () => {
      writeFileSync(join(testDir, 'to-delete.md'), 'content');

      const request = createRequest('DELETE', 'to-delete.md');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['to-delete.md'] }) };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(existsSync(join(testDir, 'to-delete.md'))).toBe(false);
    });

    it('should require recursive=true for non-empty directory', async () => {
      mkdirSync(join(testDir, 'non-empty'));
      writeFileSync(join(testDir, 'non-empty', 'file.txt'), 'content');

      const request = createRequest('DELETE', 'non-empty');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['non-empty'] }) };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('DIRECTORY_NOT_EMPTY');
    });

    it('should delete non-empty directory with recursive=true', async () => {
      mkdirSync(join(testDir, 'non-empty'));
      writeFileSync(join(testDir, 'non-empty', 'file.txt'), 'content');

      const request = createRequest('DELETE', 'non-empty', undefined, { recursive: 'true' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['non-empty'] }) };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(existsSync(join(testDir, 'non-empty'))).toBe(false);
    });

    it('should reject deletion of .git directory', async () => {
      mkdirSync(join(testDir, '.git'));

      const request = createRequest('DELETE', '.git', undefined, { recursive: 'true' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['.git'] }) };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('PROTECTED_DIRECTORY');
    });

    it('should return 404 for non-existent file', async () => {
      const request = createRequest('DELETE', 'nonexistent.md');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['nonexistent.md'] }) };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
    });
  });

  describe('PATCH /api/worktrees/:id/files/:path', () => {
    it('should rename file when action is rename', async () => {
      writeFileSync(join(testDir, 'old-name.md'), 'content');

      const request = createRequest('PATCH', 'old-name.md', { action: 'rename', newName: 'new-name.md' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['old-name.md'] }) };

      const response = await PATCH(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.path).toBe('new-name.md');
      expect(existsSync(join(testDir, 'new-name.md'))).toBe(true);
      expect(existsSync(join(testDir, 'old-name.md'))).toBe(false);
    });

    it('should reject invalid action', async () => {
      writeFileSync(join(testDir, 'file.md'), 'content');

      const request = createRequest('PATCH', 'file.md', { action: 'invalid', newName: 'new.md' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['file.md'] }) };

      const response = await PATCH(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('should reject newName with directory separator', async () => {
      writeFileSync(join(testDir, 'file.md'), 'content');

      const request = createRequest('PATCH', 'file.md', { action: 'rename', newName: 'path/to/file.md' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['file.md'] }) };

      const response = await PATCH(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_NAME');
    });

    it('should reject newName with path traversal', async () => {
      writeFileSync(join(testDir, 'file.md'), 'content');

      const request = createRequest('PATCH', 'file.md', { action: 'rename', newName: '../outside.md' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['file.md'] }) };

      const response = await PATCH(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_NAME');
    });

    it('should return 409 if target exists', async () => {
      writeFileSync(join(testDir, 'source.md'), 'source');
      writeFileSync(join(testDir, 'target.md'), 'target');

      const request = createRequest('PATCH', 'source.md', { action: 'rename', newName: 'target.md' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['source.md'] }) };

      const response = await PATCH(request, params);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FILE_EXISTS');
    });
  });

  describe('GET /api/worktrees/:id/files/:path (with isPathSafe)', () => {
    it('should read file content', async () => {
      writeFileSync(join(testDir, 'test.md'), '# Test Content');

      const request = createRequest('GET', 'test.md');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['test.md'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.content).toBe('# Test Content');
    });

    it('should reject path traversal', async () => {
      const request = createRequest('GET', '../etc/passwd');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['..', 'etc', 'passwd'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_PATH');
    });
  });

  describe('GET /api/worktrees/:id/files/:path (video files - Issue #302)', () => {
    it('should return video content as Base64 data URI with isVideo flag', async () => {
      // Create a minimal valid MP4 file (ftyp box)
      const mp4Header = Buffer.from([
        0x00, 0x00, 0x00, 0x14, // box size (20 bytes)
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
        0x69, 0x73, 0x6F, 0x6D, // 'isom' brand
        0x00, 0x00, 0x00, 0x00, // minor version
        0x69, 0x73, 0x6F, 0x6D, // compatible brand
      ]);
      writeFileSync(join(testDir, 'test-video.mp4'), mp4Header);

      const request = createRequest('GET', 'test-video.mp4');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['test-video.mp4'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.isVideo).toBe(true);
      expect(data.mimeType).toBe('video/mp4');
      expect(data.content).toMatch(/^data:video\/mp4;base64,/);
    });

    it('should return 404 for non-existent video file', async () => {
      const request = createRequest('GET', 'nonexistent.mp4');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['nonexistent.mp4'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('Worktree not found', () => {
    it('should return 404 for non-existent worktree', async () => {
      const request = createRequest('GET', 'test.md');
      const params = { params: Promise.resolve({ id: 'nonexistent', path: ['test.md'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('WORKTREE_NOT_FOUND');
    });
  });

  // [Issue #723] Line-range mode + editable size pre-guard tests
  describe('GET line-range mode (Issue #723)', () => {
    function makeNumberedLines(count: number): string {
      const lines: string[] = [];
      for (let i = 1; i <= count; i++) lines.push(`line ${i}`);
      return lines.join('\n');
    }

    it('returns requested 1-based inclusive line range with metadata', async () => {
      writeFileSync(join(testDir, 'sample.log'), makeNumberedLines(100));

      const request = createRequest('GET', 'sample.log', undefined, { startLine: '10', endLine: '12' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['sample.log'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.content).toBe('line 10\nline 11\nline 12');
      expect(data.totalLines).toBe(100);
      expect(data.range).toEqual({ start: 10, end: 12 });
      expect(data.encoding).toBe('utf-8');
      expect(typeof data.totalBytes).toBe('number');
    });

    it('returns 400 INVALID_REQUEST for invalid range (startLine < 1)', async () => {
      writeFileSync(join(testDir, 'sample.log'), makeNumberedLines(10));

      const request = createRequest('GET', 'sample.log', undefined, { startLine: '0', endLine: '5' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['sample.log'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 INVALID_REQUEST for non-numeric startLine', async () => {
      writeFileSync(join(testDir, 'sample.log'), makeNumberedLines(10));

      const request = createRequest('GET', 'sample.log', undefined, { startLine: 'abc', endLine: '5' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['sample.log'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_REQUEST');
    });

    it('clamps endLine past EOF and returns 200', async () => {
      writeFileSync(join(testDir, 'short.log'), makeNumberedLines(5));

      const request = createRequest('GET', 'short.log', undefined, { startLine: '3', endLine: '99' });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['short.log'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.range).toEqual({ start: 3, end: 5 });
      expect(data.content).toBe('line 3\nline 4\nline 5');
    });

    it('skips If-Modified-Since when range is requested (always 200)', async () => {
      writeFileSync(join(testDir, 'always.log'), makeNumberedLines(10));

      const url = `http://localhost:3000/api/worktrees/test-worktree/files/always.log?startLine=1&endLine=3`;
      const request = new NextRequest(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          // Far future date so mtime <= clientDate
          'If-Modified-Since': new Date(Date.now() + 1000 * 3600 * 24 * 365).toUTCString(),
        },
      });
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['always.log'] }) };

      const response = await GET(request, params);
      expect(response.status).toBe(200);
    });
  });

  describe('GET editable size pre-guard (Issue #723)', () => {
    it('returns 413 FILE_TOO_LARGE for .md > 2MB', async () => {
      // Create a 2MB + 1 byte .md file
      const large = 'x'.repeat(2 * 1024 * 1024 + 1);
      writeFileSync(join(testDir, 'big.md'), large);

      const request = createRequest('GET', 'big.md');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['big.md'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(413);
      expect(data.error.code).toBe('FILE_TOO_LARGE');
    });

    it('returns 200 for .md at exactly 2MB', async () => {
      const exact = 'x'.repeat(2 * 1024 * 1024);
      writeFileSync(join(testDir, 'exact.md'), exact);

      const request = createRequest('GET', 'exact.md');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['exact.md'] }) };

      const response = await GET(request, params);
      expect(response.status).toBe(200);
    });

    it('returns 413 FILE_TOO_LARGE for .yaml > 2MB', async () => {
      const large = 'x'.repeat(2 * 1024 * 1024 + 1);
      writeFileSync(join(testDir, 'big.yaml'), large);

      const request = createRequest('GET', 'big.yaml');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['big.yaml'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(413);
      expect(data.error.code).toBe('FILE_TOO_LARGE');
    });

    it('returns 413 FILE_TOO_LARGE for .yml > 2MB', async () => {
      const large = 'x'.repeat(2 * 1024 * 1024 + 1);
      writeFileSync(join(testDir, 'big.yml'), large);

      const request = createRequest('GET', 'big.yml');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['big.yml'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(413);
      expect(data.error.code).toBe('FILE_TOO_LARGE');
    });

    it('returns 200 for .html at 4MB (existing 5MB ceiling preserved)', async () => {
      const fourMb = 'x'.repeat(4 * 1024 * 1024);
      writeFileSync(join(testDir, 'mid.html'), fourMb);

      const request = createRequest('GET', 'mid.html');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['mid.html'] }) };

      const response = await GET(request, params);
      expect(response.status).toBe(200);
    });

    it('returns 413 for .html > 5MB (Issue #490 preserved)', async () => {
      const sixMb = 'x'.repeat(6 * 1024 * 1024);
      writeFileSync(join(testDir, 'big.html'), sixMb);

      const request = createRequest('GET', 'big.html');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['big.html'] }) };

      const response = await GET(request, params);
      const data = await response.json();

      expect(response.status).toBe(413);
      expect(data.error.code).toBe('FILE_TOO_LARGE');
    });

    it('does not pre-guard non-editable plain text files (no size limit for non-editable)', async () => {
      // 3MB plain text file (non-editable extension) — should still be readable
      const threeMb = 'x'.repeat(3 * 1024 * 1024);
      writeFileSync(join(testDir, 'large.log'), threeMb);

      const request = createRequest('GET', 'large.log');
      const params = { params: Promise.resolve({ id: 'test-worktree', path: ['large.log'] }) };

      const response = await GET(request, params);
      expect(response.status).toBe(200);
    });
  });
});
