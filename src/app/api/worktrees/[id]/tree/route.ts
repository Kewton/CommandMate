/**
 * API Route: GET /api/worktrees/:id/tree
 * Returns directory listing for worktree root
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  readDirectory,
  parseDirectoryError,
  createWorktreeNotFoundError,
} from '@/lib/file-tree';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
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

    // Read root directory
    const result = await readDirectory(worktree.path);

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
