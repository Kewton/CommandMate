/**
 * YAML File Operations Integration Tests (Issue #646)
 * Tests for YAML file CRUD operations via the file API.
 *
 * Covers:
 * - POST (new YAML file creation)
 * - PUT (edit and save YAML content)
 * - Dangerous YAML tag rejection
 * - .md regression (existing functionality preserved)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PUT, POST } from '@/app/api/worktrees/[id]/files/[...path]/route';
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

describe('YAML File Operations API (Issue #646)', () => {
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
    testDir = join(tmpdir(), `yaml-file-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  ): NextRequest {
    const url = `http://localhost:3000/api/worktrees/test-worktree/files/${path}`;

    return new NextRequest(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  describe('POST /api/worktrees/:id/files/:path (YAML creation)', () => {
    it('should create a new .yaml file', async () => {
      const yamlContent = 'name: test\nversion: 1.0';
      const request = createRequest('POST', 'config.yaml', { type: 'file', content: yamlContent });
      const params = { params: { id: 'test-worktree', path: ['config.yaml'] } };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(existsSync(join(testDir, 'config.yaml'))).toBe(true);
      expect(readFileSync(join(testDir, 'config.yaml'), 'utf-8')).toBe(yamlContent);
    });

    it('should create a new .yml file', async () => {
      const ymlContent = 'key: value\nlist:\n  - item1\n  - item2';
      const request = createRequest('POST', 'data.yml', { type: 'file', content: ymlContent });
      const params = { params: { id: 'test-worktree', path: ['data.yml'] } };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(existsSync(join(testDir, 'data.yml'))).toBe(true);
      expect(readFileSync(join(testDir, 'data.yml'), 'utf-8')).toBe(ymlContent);
    });

    it('should create a new .yaml file with empty content', async () => {
      const request = createRequest('POST', 'empty.yaml', { type: 'file', content: '' });
      const params = { params: { id: 'test-worktree', path: ['empty.yaml'] } };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
    });

    it('should reject creation of YAML file with dangerous tags', async () => {
      const dangerousContent = 'exploit: !ruby/object:Gem::Requirement\n  - test';
      const request = createRequest('POST', 'exploit.yaml', { type: 'file', content: dangerousContent });
      const params = { params: { id: 'test-worktree', path: ['exploit.yaml'] } };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CONTENT');
      expect(data.error.message).toContain('Dangerous YAML tags detected');
    });
  });

  describe('PUT /api/worktrees/:id/files/:path (YAML editing)', () => {
    it('should update existing .yaml file content', async () => {
      writeFileSync(join(testDir, 'config.yaml'), 'name: old');

      const request = createRequest('PUT', 'config.yaml', { content: 'name: updated\nversion: 2.0' });
      const params = { params: { id: 'test-worktree', path: ['config.yaml'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(readFileSync(join(testDir, 'config.yaml'), 'utf-8')).toBe('name: updated\nversion: 2.0');
    });

    it('should update existing .yml file content', async () => {
      writeFileSync(join(testDir, 'data.yml'), 'key: old');

      const request = createRequest('PUT', 'data.yml', { content: 'key: new\nlist:\n  - a\n  - b' });
      const params = { params: { id: 'test-worktree', path: ['data.yml'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(readFileSync(join(testDir, 'data.yml'), 'utf-8')).toBe('key: new\nlist:\n  - a\n  - b');
    });

    it('should reject PUT with dangerous YAML tags', async () => {
      writeFileSync(join(testDir, 'config.yaml'), 'name: safe');

      const dangerousContent = '!!python/object/apply:os.system ["echo pwned"]';
      const request = createRequest('PUT', 'config.yaml', { content: dangerousContent });
      const params = { params: { id: 'test-worktree', path: ['config.yaml'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CONTENT');
      expect(data.error.message).toContain('Dangerous YAML tags detected');
    });

    it('should reject PUT with !ruby/object tag in .yml file', async () => {
      writeFileSync(join(testDir, 'data.yml'), 'key: safe');

      const dangerousContent = 'exploit: !ruby/object:Gem::Installer\n  - payload';
      const request = createRequest('PUT', 'data.yml', { content: dangerousContent });
      const params = { params: { id: 'test-worktree', path: ['data.yml'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CONTENT');
    });

    it('should reject YAML content with binary data (NULL bytes)', async () => {
      writeFileSync(join(testDir, 'config.yaml'), 'name: safe');

      const request = createRequest('PUT', 'config.yaml', { content: 'key: value\x00' });
      const params = { params: { id: 'test-worktree', path: ['config.yaml'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CONTENT');
    });

    it('should reject YAML content exceeding 1MB', async () => {
      writeFileSync(join(testDir, 'config.yaml'), 'name: safe');

      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      const request = createRequest('PUT', 'config.yaml', { content: largeContent });
      const params = { params: { id: 'test-worktree', path: ['config.yaml'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_CONTENT');
    });
  });

  describe('.md regression (existing functionality preserved)', () => {
    it('should still create .md files successfully', async () => {
      const request = createRequest('POST', 'readme.md', { type: 'file', content: '# Readme' });
      const params = { params: { id: 'test-worktree', path: ['readme.md'] } };

      const response = await POST(request, params);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(readFileSync(join(testDir, 'readme.md'), 'utf-8')).toBe('# Readme');
    });

    it('should still update .md files successfully', async () => {
      writeFileSync(join(testDir, 'readme.md'), '# Old');

      const request = createRequest('PUT', 'readme.md', { content: '# Updated' });
      const params = { params: { id: 'test-worktree', path: ['readme.md'] } };

      const response = await PUT(request, params);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(readFileSync(join(testDir, 'readme.md'), 'utf-8')).toBe('# Updated');
    });
  });
});
