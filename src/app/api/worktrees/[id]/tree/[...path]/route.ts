/**
 * API Route: GET /api/worktrees/:id/tree/:path*
 * Returns directory listing for subdirectory within worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  readDirectory,
  isExcludedPattern,
  parseDirectoryError,
  createWorktreeNotFoundError,
  createAccessDeniedError,
} from '@/lib/file-tree';
import { isPathSafe } from '@/lib/path-validator';

/**
 * Decode a URL-encoded path segment safely
 *
 * @param segment - The URL-encoded segment to decode
 * @returns Decoded segment, or original if decoding fails
 */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Check if any path segment matches an excluded pattern
 *
 * @param pathSegments - Array of path segments to check
 * @returns True if any segment is excluded
 */
function hasExcludedSegment(pathSegments: string[]): boolean {
  return pathSegments.some((segment) => {
    const decodedSegment = decodePathSegment(segment);
    return isExcludedPattern(decodedSegment);
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      const errorResponse = createWorktreeNotFoundError(params.id);
      return NextResponse.json(
        { error: errorResponse.error },
        { status: errorResponse.status }
      );
    }

    // Construct relative path from path segments
    const relativePath = params.path.join('/');

    // Security: Check if any path segment is excluded
    if (hasExcludedSegment(params.path)) {
      const errorResponse = createAccessDeniedError('Path contains excluded pattern');
      return NextResponse.json(
        { error: errorResponse.error },
        { status: errorResponse.status }
      );
    }

    // Security: Validate path is within worktree
    if (!isPathSafe(relativePath, worktree.path)) {
      const errorResponse = createAccessDeniedError('Invalid path');
      return NextResponse.json(
        { error: errorResponse.error },
        { status: errorResponse.status }
      );
    }

    // Read subdirectory
    const result = await readDirectory(worktree.path, relativePath);

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Error reading directory:', error);

    const errorResponse = parseDirectoryError(error);
    return NextResponse.json(
      { error: errorResponse.error },
      { status: errorResponse.status }
    );
  }
}
