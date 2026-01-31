/**
 * API Route: GET /api/worktrees/:id/search
 * [Issue #21] File content search functionality
 *
 * Security measures:
 * - [SEC-MF-001] No RegExp usage (ReDoS prevention)
 * - [SEC-SF-001] Returns relative paths only
 * - [SEC-SF-002] Content truncated to 500 characters
 * - [SEC-SF-003] Access logging
 * - Worktree existence validation
 * - Query validation
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  searchWithTimeout,
  validateSearchQuery,
  SearchTimeoutError,
  SEARCH_MAX_RESULTS,
} from '@/lib/file-search';
import { createLogger, generateRequestId } from '@/lib/logger';
import { createWorktreeNotFoundError } from '@/lib/file-tree';

// Logger for search API
const logger = createLogger('api-search');

// ============================================================================
// Types
// ============================================================================

interface SearchSuccessResponse {
  success: true;
  results: Array<{
    filePath: string;
    fileName: string;
    matches?: Array<{
      line: number;
      content: string;
    }>;
  }>;
  totalMatches: number;
  truncated: boolean;
  executionTimeMs: number;
}

interface SearchErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Hash query for logging (privacy protection)
 * [SEC-SF-003] Query content is not logged directly
 */
function hashQuery(query: string): string {
  // Simple base64 encoding, truncated for identifier purposes
  return Buffer.from(query).toString('base64').slice(0, 8);
}

// ============================================================================
// API Handler
// ============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse<SearchSuccessResponse | SearchErrorResponse>> {
  const startTime = Date.now();
  const requestId = generateRequestId();
  const worktreeId = params.id;

  // Create logger with context
  const log = logger.withContext({ worktreeId, requestId });

  try {
    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';
    const mode = searchParams.get('mode') || 'content';

    // Validate mode (only 'content' is supported for API)
    if (mode !== 'content') {
      log.warn('search:invalid-mode', { mode });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_MODE',
            message: 'Only mode=content is supported for API search',
          },
        },
        { status: 400 }
      );
    }

    // Validate query
    if (!validateSearchQuery(query)) {
      log.warn('search:invalid-query', { queryLength: query.length });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_QUERY',
            message: 'Query cannot be empty or exceed 1000 characters',
          },
        },
        { status: 400 }
      );
    }

    // Check if worktree exists
    const db = getDbInstance();
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) {
      const errorResponse = createWorktreeNotFoundError(worktreeId);
      log.warn('search:worktree-not-found');
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'WORKTREE_NOT_FOUND',
            message: errorResponse.error,
          },
        },
        { status: errorResponse.status }
      );
    }

    // Execute search with timeout
    const result = await searchWithTimeout(worktree.path, {
      query,
      maxResults: SEARCH_MAX_RESULTS,
      timeoutMs: 5000,
    });

    // [SEC-SF-003] Log search access (privacy-aware)
    log.info('search:complete', {
      queryHash: hashQuery(query),
      executionTimeMs: result.executionTimeMs,
      resultCount: result.results.length,
      totalMatches: result.totalMatches,
      truncated: result.truncated,
    });

    return NextResponse.json({
      success: true,
      results: result.results,
      totalMatches: result.totalMatches,
      truncated: result.truncated,
      executionTimeMs: result.executionTimeMs,
    });
  } catch (error: unknown) {
    // Handle timeout error
    if (error instanceof SearchTimeoutError) {
      const executionTimeMs = Date.now() - startTime;
      log.warn('search:timeout', { executionTimeMs });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'SEARCH_TIMEOUT',
            message: 'Search timed out. Try a more specific query.',
          },
        },
        { status: 408 }
      );
    }

    // Handle other errors
    const executionTimeMs = Date.now() - startTime;
    log.error('search:error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTimeMs,
    });

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An error occurred while searching',
        },
      },
      { status: 500 }
    );
  }
}
