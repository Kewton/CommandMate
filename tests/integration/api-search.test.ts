/**
 * Integration Tests for Search API
 * [Issue #21] File tree search functionality
 *
 * Tests for:
 * - API endpoint functionality
 * - Error handling
 * - Security measures (SEC-SF-001, SEC-SF-002, SEC-SF-003)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/[id]/search/route';

// Mock dependencies
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

vi.mock('@/lib/file-search', () => ({
  searchWithTimeout: vi.fn(),
  validateSearchQuery: vi.fn((query: string) => query.length > 0 && query.length <= 1000),
  SearchTimeoutError: class SearchTimeoutError extends Error {
    constructor(msg = 'Search timed out') {
      super(msg);
      this.name = 'SearchTimeoutError';
    }
  },
  SEARCH_MAX_RESULTS: 100,
}));

vi.mock('@/lib/logger', () => {
  const createMockLogger = () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(() => logger),
    };
    return logger;
  };
  return {
    createLogger: vi.fn(() => createMockLogger()),
    generateRequestId: vi.fn(() => 'test-request-id'),
  };
});

// Import mocked modules for manipulation
import { getWorktreeById } from '@/lib/db';
import { searchWithTimeout, SearchTimeoutError } from '@/lib/file-search';

const mockGetWorktreeById = getWorktreeById as ReturnType<typeof vi.fn>;
const mockSearchWithTimeout = searchWithTimeout as ReturnType<typeof vi.fn>;

describe('Search API Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  /**
   * Helper to create NextRequest with search params
   */
  function createRequest(searchParams: Record<string, string>): NextRequest {
    const url = new URL('http://localhost:3000/api/worktrees/test-id/search');
    Object.entries(searchParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return new NextRequest(url);
  }

  // ============================================================================
  // Success Cases
  // ============================================================================

  describe('Success Cases', () => {
    it('should return search results for valid query', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/test/path',
      });

      mockSearchWithTimeout.mockResolvedValue({
        results: [
          {
            filePath: 'src/test.ts',
            fileName: 'test.ts',
            matches: [{ line: 1, content: 'hello world' }],
          },
        ],
        totalMatches: 1,
        truncated: false,
        executionTimeMs: 100,
      });

      const request = createRequest({ q: 'hello', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].filePath).toBe('src/test.ts');
      expect(data.totalMatches).toBe(1);
      expect(data.truncated).toBe(false);
      expect(data.executionTimeMs).toBe(100);
    });

    it('should return empty results when no matches found', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/test/path',
      });

      mockSearchWithTimeout.mockResolvedValue({
        results: [],
        totalMatches: 0,
        truncated: false,
        executionTimeMs: 50,
      });

      const request = createRequest({ q: 'nonexistent', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.results).toHaveLength(0);
      expect(data.totalMatches).toBe(0);
    });

    it('should return truncated flag when results exceed limit', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/test/path',
      });

      mockSearchWithTimeout.mockResolvedValue({
        results: Array(100).fill({
          filePath: 'test.ts',
          fileName: 'test.ts',
          matches: [{ line: 1, content: 'match' }],
        }),
        totalMatches: 150,
        truncated: true,
        executionTimeMs: 200,
      });

      const request = createRequest({ q: 'match', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.truncated).toBe(true);
    });

    it('[SEC-SF-001] should return relative paths only', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/absolute/worktree/path',
      });

      mockSearchWithTimeout.mockResolvedValue({
        results: [
          {
            filePath: 'src/module/file.ts', // Relative path
            fileName: 'file.ts',
            matches: [{ line: 5, content: 'test content' }],
          },
        ],
        totalMatches: 1,
        truncated: false,
        executionTimeMs: 75,
      });

      const request = createRequest({ q: 'test', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(200);
      // Verify path is relative (doesn't start with /)
      expect(data.results[0].filePath).not.toMatch(/^\//);
      expect(data.results[0].filePath).toBe('src/module/file.ts');
    });
  });

  // ============================================================================
  // Error Cases
  // ============================================================================

  describe('Error Cases', () => {
    it('should return 400 for invalid mode', async () => {
      const request = createRequest({ q: 'test', mode: 'name' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_MODE');
    });

    it('should return 400 for empty query', async () => {
      const request = createRequest({ q: '', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_QUERY');
    });

    it('should return 404 for non-existent worktree', async () => {
      mockGetWorktreeById.mockReturnValue(null);

      const request = createRequest({ q: 'test', mode: 'content' });
      const response = await GET(request, { params: { id: 'nonexistent' } });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('WORKTREE_NOT_FOUND');
    });

    it('should return 408 for search timeout', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/test/path',
      });

      mockSearchWithTimeout.mockRejectedValue(new SearchTimeoutError('Timeout'));

      const request = createRequest({ q: 'test', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(408);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('SEARCH_TIMEOUT');
    });

    it('should return 500 for internal errors', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/test/path',
      });

      mockSearchWithTimeout.mockRejectedValue(new Error('Internal error'));

      const request = createRequest({ q: 'test', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ============================================================================
  // Response Format Validation
  // ============================================================================

  describe('Response Format', () => {
    it('should return consistent success response structure', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/test/path',
      });

      mockSearchWithTimeout.mockResolvedValue({
        results: [],
        totalMatches: 0,
        truncated: false,
        executionTimeMs: 10,
      });

      const request = createRequest({ q: 'test', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      // Verify all required fields are present
      expect(data).toHaveProperty('success', true);
      expect(data).toHaveProperty('results');
      expect(data).toHaveProperty('totalMatches');
      expect(data).toHaveProperty('truncated');
      expect(data).toHaveProperty('executionTimeMs');
    });

    it('should return consistent error response structure', async () => {
      mockGetWorktreeById.mockReturnValue(null);

      const request = createRequest({ q: 'test', mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      // Verify error structure
      expect(data).toHaveProperty('success', false);
      expect(data).toHaveProperty('error');
      expect(data.error).toHaveProperty('code');
      expect(data.error).toHaveProperty('message');
    });
  });

  // ============================================================================
  // Default Behavior
  // ============================================================================

  describe('Default Behavior', () => {
    it('should default to content mode if not specified', async () => {
      mockGetWorktreeById.mockReturnValue({
        id: 'test-id',
        path: '/test/path',
      });

      mockSearchWithTimeout.mockResolvedValue({
        results: [],
        totalMatches: 0,
        truncated: false,
        executionTimeMs: 10,
      });

      // Request without mode parameter
      const request = createRequest({ q: 'test' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should handle missing query parameter as empty string', async () => {
      const request = createRequest({ mode: 'content' });
      const response = await GET(request, { params: { id: 'test-id' } });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe('INVALID_QUERY');
    });
  });
});
