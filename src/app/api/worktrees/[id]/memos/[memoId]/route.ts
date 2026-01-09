/**
 * API Route: /api/worktrees/:id/memos/:memoId
 * PUT: Updates a specific memo
 * DELETE: Deletes a specific memo
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, getMemoById, updateMemo, deleteMemo } from '@/lib/db';

/** Maximum title length */
const MAX_TITLE_LENGTH = 100;

/** Maximum content length */
const MAX_CONTENT_LENGTH = 10000;

/**
 * PUT /api/worktrees/:id/memos/:memoId
 * Updates a specific memo's title and/or content
 *
 * Request body:
 * - title?: string - New memo title (max 100 chars)
 * - content?: string - New memo content (max 10000 chars)
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string; memoId: string } }
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

    // Check if memo exists
    const existingMemo = getMemoById(db, params.memoId);
    if (!existingMemo) {
      return NextResponse.json(
        { error: `Memo '${params.memoId}' not found` },
        { status: 404 }
      );
    }

    // Parse request body
    const body = await request.json().catch(() => ({}));
    const { title, content } = body;

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

    // Update the memo
    updateMemo(db, params.memoId, { title, content });

    // Fetch the updated memo
    const updatedMemo = getMemoById(db, params.memoId);

    return NextResponse.json({ memo: updatedMemo }, { status: 200 });
  } catch (error) {
    console.error('Error updating memo:', error);
    return NextResponse.json(
      { error: 'Failed to update memo' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/worktrees/:id/memos/:memoId
 * Deletes a specific memo
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; memoId: string } }
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

    // Check if memo exists
    const existingMemo = getMemoById(db, params.memoId);
    if (!existingMemo) {
      return NextResponse.json(
        { error: `Memo '${params.memoId}' not found` },
        { status: 404 }
      );
    }

    // Delete the memo
    deleteMemo(db, params.memoId);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Error deleting memo:', error);
    return NextResponse.json(
      { error: 'Failed to delete memo' },
      { status: 500 }
    );
  }
}
