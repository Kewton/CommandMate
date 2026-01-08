/**
 * File Tree API Integration Tests
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 *
 * Tests for directory listing API endpoints
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { GET as getRootTree } from '@/app/api/worktrees/[id]/tree/route';
import { GET as getSubdirTree } from '@/app/api/worktrees/[id]/tree/[...path]/route';
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

// Helper function to create mock NextRequest
function createMockRequest(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

describe('File Tree API', () => {
  let testDir: string;
  let db: Database.Database;
  let testWorktree: Worktree;

  beforeAll(() => {
    // Create temporary directory structure
    testDir = join(tmpdir(), `file-tree-api-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create test file structure
    mkdirSync(join(testDir, 'src', 'components'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'lib'), { recursive: true });
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    mkdirSync(join(testDir, '.git'), { recursive: true }); // Should be excluded
    mkdirSync(join(testDir, 'node_modules'), { recursive: true }); // Should be excluded

    writeFileSync(join(testDir, 'package.json'), '{}');
    writeFileSync(join(testDir, 'README.md'), '# Test');
    writeFileSync(join(testDir, '.env'), 'SECRET=xxx'); // Should be excluded
    writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(testDir, 'src', 'components', 'App.tsx'), 'export function App() {}');
    writeFileSync(join(testDir, 'src', 'lib', 'utils.ts'), 'export function utils() {}');
  });

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

    // Create test worktree
    testWorktree = {
      id: 'test-worktree',
      name: 'test-worktree',
      path: testDir,
      repositoryPath: testDir,
      repositoryName: 'test-repo',
    };
    upsertWorktree(db, testWorktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  afterAll(() => {
    // Clean up temporary directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('GET /api/worktrees/:id/tree', () => {
    it('should return root directory contents', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree');
      const response = await getRootTree(request, { params: { id: 'test-worktree' } });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.path).toBe('');
      expect(data.name).toBe('');
      expect(data.parentPath).toBeNull();
      expect(Array.isArray(data.items)).toBe(true);

      // Check expected items are present
      const itemNames = data.items.map((i: { name: string }) => i.name);
      expect(itemNames).toContain('src');
      expect(itemNames).toContain('docs');
      expect(itemNames).toContain('package.json');
      expect(itemNames).toContain('README.md');

      // Check excluded items are not present
      expect(itemNames).not.toContain('.git');
      expect(itemNames).not.toContain('node_modules');
      expect(itemNames).not.toContain('.env');
    });

    it('should return directories first, then files', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree');
      const response = await getRootTree(request, { params: { id: 'test-worktree' } });

      const data = await response.json();

      // Find the index where files start
      let firstFileIndex = -1;
      let lastDirIndex = -1;

      data.items.forEach((item: { type: string }, index: number) => {
        if (item.type === 'directory') {
          lastDirIndex = index;
        } else if (item.type === 'file' && firstFileIndex === -1) {
          firstFileIndex = index;
        }
      });

      // All directories should come before files
      if (firstFileIndex !== -1 && lastDirIndex !== -1) {
        expect(lastDirIndex).toBeLessThan(firstFileIndex);
      }
    });

    it('should return 404 for non-existent worktree', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/non-existent/tree');
      const response = await getRootTree(request, { params: { id: 'non-existent' } });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it('should include file sizes and extensions', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree');
      const response = await getRootTree(request, { params: { id: 'test-worktree' } });

      const data = await response.json();
      const jsonFile = data.items.find((i: { name: string }) => i.name === 'package.json');

      expect(jsonFile).toBeDefined();
      expect(jsonFile.type).toBe('file');
      expect(jsonFile.size).toBeDefined();
      expect(typeof jsonFile.size).toBe('number');
      expect(jsonFile.extension).toBe('json');
    });

    it('should include directory item counts', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree');
      const response = await getRootTree(request, { params: { id: 'test-worktree' } });

      const data = await response.json();
      const srcDir = data.items.find((i: { name: string }) => i.name === 'src');

      expect(srcDir).toBeDefined();
      expect(srcDir.type).toBe('directory');
      expect(srcDir.itemCount).toBeDefined();
      expect(typeof srcDir.itemCount).toBe('number');
      expect(srcDir.itemCount).toBeGreaterThan(0);
    });
  });

  describe('GET /api/worktrees/:id/tree/:path', () => {
    it('should return subdirectory contents', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/src');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['src'] },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.path).toBe('src');
      expect(data.name).toBe('src');
      expect(data.parentPath).toBe('');
      expect(Array.isArray(data.items)).toBe(true);

      const itemNames = data.items.map((i: { name: string }) => i.name);
      expect(itemNames).toContain('components');
      expect(itemNames).toContain('lib');
      expect(itemNames).toContain('index.ts');
    });

    it('should return nested subdirectory contents', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/src/components');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['src', 'components'] },
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.path).toBe('src/components');
      expect(data.name).toBe('components');
      expect(data.parentPath).toBe('src');

      const itemNames = data.items.map((i: { name: string }) => i.name);
      expect(itemNames).toContain('App.tsx');
    });

    it('should return 404 for non-existent path', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/nonexistent');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['nonexistent'] },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it('should return 400 for file path (not a directory)', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/package.json');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['package.json'] },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('not a directory');
    });

    it('should return 404 for non-existent worktree', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/non-existent/tree/src');
      const response = await getSubdirTree(request, {
        params: { id: 'non-existent', path: ['src'] },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe('Security: Path Traversal Prevention', () => {
    it('should reject path traversal with ..', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/../etc');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['..', 'etc'] },
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('Access denied');
    });

    it('should reject encoded path traversal', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/%2e%2e/etc');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['%2e%2e', 'etc'] },
      });

      // Even if URL decoding happens, should still be rejected
      expect([400, 403, 404]).toContain(response.status);
    });

    it('should reject access to excluded directories', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/.git');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['.git'] },
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('Access denied');
    });

    it('should reject access to node_modules', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/node_modules');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['node_modules'] },
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('Access denied');
    });

    it('should reject access to .env files', async () => {
      const request = createMockRequest('http://localhost/api/worktrees/test-worktree/tree/.env');
      const response = await getSubdirTree(request, {
        params: { id: 'test-worktree', path: ['.env'] },
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('Access denied');
    });
  });
});
