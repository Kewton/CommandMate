/**
 * API Route: /api/worktrees/:id/memos
 * GET: Returns all memos for a worktree
 * POST: Creates a new memo for a worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, getMemosByWorktreeId, createMemo } from '@/lib/db';

/** Maximum number of memos allowed per worktree */
const MAX_MEMOS = 5;

/** Maximum title length */
const MAX_TITLE_LENGTH = 100;

/** Maximum content length */
const MAX_CONTENT_LENGTH = 10000;

/**
 * GET /api/worktrees/:id/memos
 * Returns all memos for a worktree sorted by position
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
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

    // Get all memos for the worktree
    const memos = getMemosByWorktreeId(db, params.id);

    return NextResponse.json({ memos }, { status: 200 });
  } catch (error) {
    console.error('Error fetching memos:', error);
    return NextResponse.json(
      { error: 'Failed to fetch memos' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/worktrees/:id/memos
 * Creates a new memo for a worktree
 *
 * Request body:
 * - title?: string - Memo title (default: 'Memo', max 100 chars)
 * - content?: string - Memo content (default: '', max 10000 chars)
 * - position?: number - Position in the list (auto-assigned if not provided)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
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

    // Parse request body
    const body = await request.json().catch(() => ({}));
    const { title, content, position: requestedPosition } = body;

    // Validate title length
    if (title !== undefined && title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json(
        { error: `title must be ${MAX_TITLE_LENGTH} characters or less` },
        { status: 400 }
      );
    }

    // Validate content length
    if (content !== undefined && content.length > MAX_CONTENT_LENGTH) {
      return NextResponse.json(
        { error: `content must be ${MAX_CONTENT_LENGTH} characters or less` },
        { status: 400 }
      );
    }

    // Get existing memos to check limit and determine next position
    const existingMemos = getMemosByWorktreeId(db, params.id);

    // Check memo limit
    if (existingMemos.length >= MAX_MEMOS) {
      return NextResponse.json(
        { error: `Maximum memo limit (${MAX_MEMOS}) reached` },
        { status: 400 }
      );
    }

    // Determine position: use requested position or next available
    let position: number;
    if (requestedPosition !== undefined && typeof requestedPosition === 'number') {
      position = requestedPosition;
    } else {
      // Find next available position
      const usedPositions = new Set(existingMemos.map((m) => m.position));
      position = 0;
      while (usedPositions.has(position) && position < MAX_MEMOS) {
        position++;
      }
    }

    // Create the memo
    const memo = createMemo(db, params.id, {
      title,
      content,
      position,
    });

    return NextResponse.json({ memo }, { status: 201 });
  } catch (error) {
    console.error('Error creating memo:', error);
    return NextResponse.json(
      { error: 'Failed to create memo' },
      { status: 500 }
    );
  }
}
