/**
 * API Route: GET /api/worktrees/:id/files/:path
 * Reads file content from a worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { readFile } from 'fs/promises';
import { join, normalize } from 'path';
import { existsSync } from 'fs';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
  try {
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Construct file path
    const requestedPath = params.path.join('/');
    const normalizedPath = normalize(requestedPath);

    // Security: Prevent path traversal attacks
    if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 400 }
      );
    }

    const fullPath = join(worktree.path, normalizedPath);

    // Check if file exists
    if (!existsSync(fullPath)) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    // Read file content
    const content = await readFile(fullPath, 'utf-8');

    // Get file extension for syntax highlighting
    const extension = normalizedPath.split('.').pop() || '';

    return NextResponse.json({
      path: normalizedPath,
      content,
      extension,
      worktreePath: worktree.path,
    });
  } catch (error: unknown) {
    console.error('Error reading file:', error);

    // Handle specific error cases
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EISDIR') {
      return NextResponse.json(
        { error: 'Path is a directory, not a file' },
        { status: 400 }
      );
    }

    if (nodeError.code === 'ENOENT') {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    if (nodeError.code === 'EACCES') {
      return NextResponse.json(
        { error: 'Permission denied' },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to read file' },
      { status: 500 }
    );
  }
}
