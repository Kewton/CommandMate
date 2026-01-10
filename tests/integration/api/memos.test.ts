/**
 * API Routes Integration Tests - Memos
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 *
 * Tests for:
 * - GET /api/worktrees/:id/memos - List all memos for a worktree
 * - POST /api/worktrees/:id/memos - Create a new memo
 * - PUT /api/worktrees/:id/memos/:memoId - Update a memo
 * - DELETE /api/worktrees/:id/memos/:memoId - Delete a memo
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, getMemosByWorktreeId, createMemo } from '@/lib/db';
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

describe('GET /api/worktrees/:id/memos', () => {
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

  it('should return empty array when no memos exist', async () => {
    const { GET } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos');
    const params = { params: { id: 'test-worktree' } };
    const response = await GET(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('memos');
    expect(data.memos).toEqual([]);
  });

  it('should return memos list sorted by position', async () => {
    // Create memos in different positions
    createMemo(db, 'test-worktree', { title: 'Memo 2', content: 'Content 2', position: 2 });
    createMemo(db, 'test-worktree', { title: 'Memo 0', content: 'Content 0', position: 0 });
    createMemo(db, 'test-worktree', { title: 'Memo 1', content: 'Content 1', position: 1 });

    const { GET } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos');
    const params = { params: { id: 'test-worktree' } };
    const response = await GET(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.memos).toHaveLength(3);
    expect(data.memos[0].title).toBe('Memo 0');
    expect(data.memos[0].position).toBe(0);
    expect(data.memos[1].title).toBe('Memo 1');
    expect(data.memos[1].position).toBe(1);
    expect(data.memos[2].title).toBe('Memo 2');
    expect(data.memos[2].position).toBe(2);
  });

  it('should return 404 for non-existent worktreeId', async () => {
    const { GET } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/nonexistent/memos');
    const params = { params: { id: 'nonexistent' } };
    const response = await GET(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const { GET } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos');
    const params = { params: { id: 'test-worktree' } };
    const response = await GET(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('POST /api/worktrees/:id/memos', () => {
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

  it('should create a new memo with default values', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data).toHaveProperty('memo');
    expect(data.memo).toHaveProperty('id');
    expect(data.memo.worktreeId).toBe('test-worktree');
    expect(data.memo.title).toBe('Memo');
    expect(data.memo.content).toBe('');
    expect(data.memo.position).toBe(0);
  });

  it('should create a memo with provided title and content', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'My Custom Title',
        content: 'My custom content',
      }),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.memo.title).toBe('My Custom Title');
    expect(data.memo.content).toBe('My custom content');
  });

  it('should auto-assign next available position', async () => {
    // Create memos at positions 0 and 1
    createMemo(db, 'test-worktree', { title: 'Memo 0', position: 0 });
    createMemo(db, 'test-worktree', { title: 'Memo 1', position: 1 });

    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Memo 2' }),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.memo.position).toBe(2);
  });

  it('should return 400 when memo limit (5) exceeded', async () => {
    // Create 5 memos
    for (let i = 0; i < 5; i++) {
      createMemo(db, 'test-worktree', { title: `Memo ${i}`, position: i });
    }

    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Memo 6' }),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('limit');
  });

  it('should return 404 for non-existent worktreeId', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/nonexistent/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const params = { params: { id: 'nonexistent' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  it('should return 400 for title exceeding 100 characters', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const longTitle = 'a'.repeat(101);
    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: longTitle }),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('title');
  });

  it('should return 400 for content exceeding 10000 characters', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const longContent = 'a'.repeat(10001);
    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: longContent }),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('content');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const { POST } = await import('@/app/api/worktrees/[id]/memos/route');

    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await POST(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('PUT /api/worktrees/:id/memos/:memoId', () => {
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

  it('should update memo title', async () => {
    const memo = createMemo(db, 'test-worktree', {
      title: 'Original Title',
      content: 'Content',
      position: 0,
    });

    const { PUT } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      `http://localhost:3000/api/worktrees/test-worktree/memos/${memo.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      }
    );
    const params = { params: { id: 'test-worktree', memoId: memo.id } };
    const response = await PUT(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('memo');
    expect(data.memo.title).toBe('Updated Title');
    expect(data.memo.content).toBe('Content'); // Should not change
  });

  it('should update memo content', async () => {
    const memo = createMemo(db, 'test-worktree', {
      title: 'Title',
      content: 'Original Content',
      position: 0,
    });

    const { PUT } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      `http://localhost:3000/api/worktrees/test-worktree/memos/${memo.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Updated Content' }),
      }
    );
    const params = { params: { id: 'test-worktree', memoId: memo.id } };
    const response = await PUT(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.memo.title).toBe('Title'); // Should not change
    expect(data.memo.content).toBe('Updated Content');
  });

  it('should update both title and content', async () => {
    const memo = createMemo(db, 'test-worktree', {
      title: 'Original Title',
      content: 'Original Content',
      position: 0,
    });

    const { PUT } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      `http://localhost:3000/api/worktrees/test-worktree/memos/${memo.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Title', content: 'New Content' }),
      }
    );
    const params = { params: { id: 'test-worktree', memoId: memo.id } };
    const response = await PUT(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.memo.title).toBe('New Title');
    expect(data.memo.content).toBe('New Content');
  });

  it('should return 404 for non-existent memoId', async () => {
    const { PUT } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/memos/nonexistent-memo-id',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      }
    );
    const params = { params: { id: 'test-worktree', memoId: 'nonexistent-memo-id' } };
    const response = await PUT(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  it('should return 404 for non-existent worktreeId', async () => {
    const { PUT } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      'http://localhost:3000/api/worktrees/nonexistent/memos/some-memo-id',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      }
    );
    const params = { params: { id: 'nonexistent', memoId: 'some-memo-id' } };
    const response = await PUT(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 400 for title exceeding 100 characters', async () => {
    const memo = createMemo(db, 'test-worktree', { title: 'Title', position: 0 });

    const { PUT } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const longTitle = 'a'.repeat(101);
    const request = new Request(
      `http://localhost:3000/api/worktrees/test-worktree/memos/${memo.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: longTitle }),
      }
    );
    const params = { params: { id: 'test-worktree', memoId: memo.id } };
    const response = await PUT(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const { PUT } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/memos/some-memo-id',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      }
    );
    const params = { params: { id: 'test-worktree', memoId: 'some-memo-id' } };
    const response = await PUT(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('DELETE /api/worktrees/:id/memos/:memoId', () => {
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

  it('should delete memo by id', async () => {
    const memo = createMemo(db, 'test-worktree', { title: 'To Delete', position: 0 });

    const { DELETE } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      `http://localhost:3000/api/worktrees/test-worktree/memos/${memo.id}`,
      { method: 'DELETE' }
    );
    const params = { params: { id: 'test-worktree', memoId: memo.id } };
    const response = await DELETE(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('success', true);

    // Verify memo is deleted
    const memos = getMemosByWorktreeId(db, 'test-worktree');
    expect(memos).toHaveLength(0);
  });

  it('should only delete specified memo', async () => {
    const memo0 = createMemo(db, 'test-worktree', { title: 'Memo 0', position: 0 });
    createMemo(db, 'test-worktree', { title: 'Memo 1', position: 1 });

    const { DELETE } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      `http://localhost:3000/api/worktrees/test-worktree/memos/${memo0.id}`,
      { method: 'DELETE' }
    );
    const params = { params: { id: 'test-worktree', memoId: memo0.id } };
    const response = await DELETE(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const memos = getMemosByWorktreeId(db, 'test-worktree');
    expect(memos).toHaveLength(1);
    expect(memos[0].title).toBe('Memo 1');
  });

  it('should return 404 for non-existent memoId', async () => {
    const { DELETE } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/memos/nonexistent-memo-id',
      { method: 'DELETE' }
    );
    const params = { params: { id: 'test-worktree', memoId: 'nonexistent-memo-id' } };
    const response = await DELETE(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  it('should return 404 for non-existent worktreeId', async () => {
    const { DELETE } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      'http://localhost:3000/api/worktrees/nonexistent/memos/some-memo-id',
      { method: 'DELETE' }
    );
    const params = { params: { id: 'nonexistent', memoId: 'some-memo-id' } };
    const response = await DELETE(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const { DELETE } = await import('@/app/api/worktrees/[id]/memos/[memoId]/route');

    const request = new Request(
      'http://localhost:3000/api/worktrees/test-worktree/memos/some-memo-id',
      { method: 'DELETE' }
    );
    const params = { params: { id: 'test-worktree', memoId: 'some-memo-id' } };
    const response = await DELETE(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});
