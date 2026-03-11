/**
 * Integration tests for files API 304 Not Modified response
 * GET /api/worktrees/:id/files/:path
 *
 * Issue #469: File auto-update - HTTP conditional requests
 *
 * Tests the Last-Modified header and If-Modified-Since 304 response
 * for text file content polling optimization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies before importing the route handler
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(() => ({
    id: 'test-wt',
    path: '/tmp/test-worktree',
    branch: 'main',
  })),
}));

vi.mock('@/lib/path-validator', () => ({
  isPathSafe: vi.fn(() => true),
  resolveAndValidateRealPath: vi.fn(() => true),
}));

vi.mock('@/config/image-extensions', () => ({
  isImageExtension: vi.fn(() => false),
}));

vi.mock('@/config/video-extensions', () => ({
  isVideoExtension: vi.fn(() => false),
}));

const mockStat = vi.fn();
const mockReadFile = vi.fn();
vi.mock('fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock('@/lib/file-operations', () => ({
  readFileContent: vi.fn(() => ({
    success: true,
    content: 'const x = 1;',
  })),
  isEditableFile: vi.fn(() => true),
}));

vi.mock('@/config/editable-extensions', () => ({
  validateContent: vi.fn(() => ({ valid: true })),
  isEditableExtension: vi.fn(() => true),
}));

// Import the route handler after mocking
import { GET } from '@/app/api/worktrees/[id]/files/[...path]/route';

describe('GET /api/worktrees/:id/files/:path - 304 response', () => {
  const baseMtime = new Date('2026-03-10T12:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({
      mtime: baseMtime,
      size: 100,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should include Last-Modified header in 200 response', async () => {
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts');
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Last-Modified')).toBe(baseMtime.toUTCString());
  });

  it('should include Cache-Control: no-store, private in 200 response', async () => {
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts');
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('should return 304 when If-Modified-Since matches mtime', async () => {
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts', {
      headers: {
        'If-Modified-Since': baseMtime.toUTCString(),
      },
    });
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('Last-Modified')).toBe(baseMtime.toUTCString());
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('should return 304 when If-Modified-Since is after mtime', async () => {
    const futureDate = new Date('2026-03-11T00:00:00Z');
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts', {
      headers: {
        'If-Modified-Since': futureDate.toUTCString(),
      },
    });
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    expect(response.status).toBe(304);
  });

  it('should return 200 when If-Modified-Since is before mtime', async () => {
    const pastDate = new Date('2026-03-09T00:00:00Z');
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts', {
      headers: {
        'If-Modified-Since': pastDate.toUTCString(),
      },
    });
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    expect(response.status).toBe(200);
  });

  it('should return 200 with full body when If-Modified-Since is invalid string', async () => {
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts', {
      headers: {
        'If-Modified-Since': 'invalid',
      },
    });
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Last-Modified')).toBe(baseMtime.toUTCString());
  });

  it('should return 200 with full body when If-Modified-Since is nonsensical date', async () => {
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts', {
      headers: {
        'If-Modified-Since': '9999-99-99',
      },
    });
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    // isNaN check should fallback to 200
    expect(response.status).toBe(200);
  });

  it('should not include If-Modified-Since check when header is absent', async () => {
    const request = new NextRequest('http://localhost/api/worktrees/test-wt/files/src/index.ts');
    const response = await GET(request, {
      params: { id: 'test-wt', path: ['src', 'index.ts'] },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});
