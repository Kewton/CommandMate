/**
 * Security Tests
 * Tests for path traversal, XSS protection, recursive delete safety
 *
 * [SEC-SF-001] Content validation
 * [SEC-SF-002] Error response security
 * [SEC-SF-003] Rename path validation
 * [SEC-SF-004] Recursive delete safety
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PUT, POST, DELETE, PATCH } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { isValidNewName } from '@/lib/file-operations';
import { isProtectedDirectory, DELETE_SAFETY_CONFIG } from '@/config/file-operations';
import { validateContent } from '@/config/editable-extensions';

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

// Mock logger module (Issue #480)
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('Security Tests', () => {
  let db: Database.Database;
  let testDir: string;
  let worktree: Worktree;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

    testDir = join(tmpdir(), `security-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

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
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();

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

  describe('[SEC-SF-003] Rename path validation', () => {
    it('should reject newName containing /', () => {
      const result = isValidNewName('path/to/file.md');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('path');
    });

    it('should reject newName containing \\', () => {
      const result = isValidNewName('path\\to\\file.md');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('path');
    });

    it('should reject newName containing ..', () => {
      const result = isValidNewName('../outside.md');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('..');
    });

    it('should reject empty newName', () => {
      const result = isValidNewName('');
      expect(result.valid).toBe(false);
    });

    it('should reject whitespace-only newName', () => {
      const result = isValidNewName('   ');
      expect(result.valid).toBe(false);
    });

    it('should accept valid newName', () => {
      expect(isValidNewName('valid-file.md').valid).toBe(true);
      expect(isValidNewName('file_name.txt').valid).toBe(true);
      expect(isValidNewName('CamelCase.MD').valid).toBe(true);
    });

    it('should reject rename with path traversal via API', async () => {
      writeFileSync(join(testDir, 'file.md'), 'content');

      const request = createRequest('PATCH', 'file.md', {
        action: 'rename',
        newName: '../../../etc/passwd',
      });
      const params = { params: { id: 'test-worktree', path: ['file.md'] } };

      const response = await PATCH(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_NAME');
    });
  });

  describe('[SEC-SF-004] Recursive delete safety', () => {
    it('should protect .git directory', () => {
      expect(isProtectedDirectory('.git')).toBe(true);
    });

    it('should protect .github directory', () => {
      expect(isProtectedDirectory('.github')).toBe(true);
    });

    it('should protect node_modules directory', () => {
      expect(isProtectedDirectory('node_modules')).toBe(true);
    });

    it('should protect subdirectories of protected directories', () => {
      expect(isProtectedDirectory('.git/objects')).toBe(true);
      expect(isProtectedDirectory('.git/refs/heads')).toBe(true);
      expect(isProtectedDirectory('.github/workflows')).toBe(true);
    });

    it('should not protect directories with similar names', () => {
      expect(isProtectedDirectory('.gitignore')).toBe(false);
      expect(isProtectedDirectory('my.git')).toBe(false);
      expect(isProtectedDirectory('not_node_modules')).toBe(false);
    });

    it('should have MAX_RECURSIVE_DELETE_FILES set to 100', () => {
      expect(DELETE_SAFETY_CONFIG.MAX_RECURSIVE_DELETE_FILES).toBe(100);
    });

    it('should reject deletion of .git via API', async () => {
      mkdirSync(join(testDir, '.git'));

      const request = createRequest('DELETE', '.git', undefined, { recursive: 'true' });
      const params = { params: { id: 'test-worktree', path: ['.git'] } };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe('PROTECTED_DIRECTORY');
      expect(existsSync(join(testDir, '.git'))).toBe(true);
    });

    it('should reject deletion of .git/objects via API', async () => {
      mkdirSync(join(testDir, '.git', 'objects'), { recursive: true });

      const request = createRequest('DELETE', '.git/objects', undefined, { recursive: 'true' });
      const params = { params: { id: 'test-worktree', path: ['.git', 'objects'] } };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe('PROTECTED_DIRECTORY');
    });
  });

  describe('[SEC-SF-001] Content validation', () => {
    it('should detect binary content (NULL bytes)', () => {
      const result = validateContent('.md', 'Hello\x00World');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Binary content detected');
    });

    it('should reject file exceeding size limit', () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      const result = validateContent('.md', largeContent);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size exceeds limit');
    });

    it('should warn on control characters but allow', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = validateContent('.md', 'Hello\x01World');
      expect(result.valid).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith('Content contains control characters');

      warnSpy.mockRestore();
    });

    it('should accept normal content', () => {
      const result = validateContent('.md', '# Hello\n\nThis is content with\ttabs and\nnewlines.');
      expect(result.valid).toBe(true);
    });

    it('should reject binary content via API', async () => {
      writeFileSync(join(testDir, 'test.md'), '# Test');

      const request = createRequest('PUT', 'test.md', { content: 'Binary\x00Content' });
      const params = { params: { id: 'test-worktree', path: ['test.md'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_CONTENT');
      expect(data.error.message).toContain('Binary');
    });
  });

  describe('[SEC-SF-002] Error response security', () => {
    it('should not include absolute paths in error messages', async () => {
      const request = createRequest('PUT', 'nonexistent.md', { content: 'test' });
      const params = { params: { id: 'test-worktree', path: ['nonexistent.md'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(404);

      // Check that the error message does not contain the absolute path
      const errorMessage = JSON.stringify(data);
      expect(errorMessage).not.toContain(testDir);
      expect(errorMessage).not.toContain('/var');
      expect(errorMessage).not.toContain('/tmp');
      expect(errorMessage).not.toContain('/home');
    });

    it('should return generic error codes without system details', async () => {
      const request = createRequest('DELETE', '../etc/passwd');
      const params = { params: { id: 'test-worktree', path: ['..', 'etc', 'passwd'] } };

      const response = await DELETE(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_PATH');
      expect(data.error.message).toBe('Invalid file path');

      // Should not expose internal details
      const errorMessage = JSON.stringify(data);
      expect(errorMessage).not.toContain('stack');
      expect(errorMessage).not.toContain('errno');
    });
  });

  describe('Path traversal attack vectors', () => {
    const traversalVectors = [
      ['..', 'etc', 'passwd'],
      ['..', '..', '..', 'etc', 'passwd'],
      ['docs', '..', '..', 'etc', 'passwd'],
      ['%2e%2e', 'etc', 'passwd'],
    ];

    for (const pathSegments of traversalVectors) {
      const pathDisplay = pathSegments.join('/');

      it(`should block traversal: ${pathDisplay}`, async () => {
        const request = createRequest('PUT', pathSegments.join('/'), { content: 'malicious' });
        const params = { params: { id: 'test-worktree', path: pathSegments } };

        const response = await PUT(request, params);

        expect(response.status).toBe(400);
      });
    }
  });

  describe('Protected resource access', () => {
    it('should not allow editing non-.md files', async () => {
      writeFileSync(join(testDir, '.env'), 'SECRET=value');

      const request = createRequest('PUT', '.env', { content: 'COMPROMISED=true' });
      const params = { params: { id: 'test-worktree', path: ['.env'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe('NOT_EDITABLE');
    });

    it('should not allow editing JavaScript files', async () => {
      writeFileSync(join(testDir, 'script.js'), 'console.log("safe")');

      const request = createRequest('PUT', 'script.js', { content: 'malicious()' });
      const params = { params: { id: 'test-worktree', path: ['script.js'] } };

      const response = await PUT(request, params);

      expect(response.status).toBe(403);
    });
  });
});
