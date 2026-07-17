/**
 * API Route: /api/worktrees/:id/memos
 * GET: Returns all memos for a worktree
 * POST: Creates a new memo for a worktree
 * PATCH: Reorders the memos of a worktree (Issue #944)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, getMemosByWorktreeId, createMemo, reorderMemos, MemoDbError } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { validateMemoReorderInput } from '@/lib/memo-reorder-validator';
import { createLogger } from '@/lib/logger';
import { MAX_MEMOS } from '@/config/memo-config';

const logger = createLogger('api/memos');

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
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    // Get all memos for the worktree
    const memos = getMemosByWorktreeId(db, id);

    return NextResponse.json({ memos }, { status: 200 });
  } catch (error) {
    logger.error('error-fetching-memos:', { error: error instanceof Error ? error.message : String(error) });
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
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
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
    const existingMemos = getMemosByWorktreeId(db, id);

    // Check memo limit
    if (existingMemos.length >= MAX_MEMOS) {
      return NextResponse.json(
        { error: `Maximum memo limit (${MAX_MEMOS}) reached` },
        { status: 400 }
      );
    }

    const usedPositions = new Set(existingMemos.map((m) => m.position));

    // Determine position: use requested position or next available
    let position: number;
    if (requestedPosition !== undefined && typeof requestedPosition === 'number') {
      // An explicit position must not collide with the UNIQUE(worktree_id, position)
      // constraint; return an explicit 409 instead of letting the raw INSERT surface
      // as an opaque 500 (Issue #1351).
      if (usedPositions.has(requestedPosition)) {
        return NextResponse.json(
          {
            error: `Memo position ${requestedPosition} is already in use`,
            code: 'DUPLICATE_POSITION',
          },
          { status: 409 }
        );
      }
      position = requestedPosition;
    } else {
      // Find next available position
      position = 0;
      while (usedPositions.has(position) && position < MAX_MEMOS) {
        position++;
      }
    }

    // Create the memo
    const memo = createMemo(db, id, {
      title,
      content,
      position,
    });

    return NextResponse.json({ memo }, { status: 201 });
  } catch (error) {
    // INSERT-side guard: covers a race between the pre-check and the insert
    // where a concurrent request took the same position (Issue #1351).
    if (error instanceof MemoDbError && error.code === 'DUPLICATE_POSITION') {
      return NextResponse.json(
        { error: 'Memo position is already in use', code: 'DUPLICATE_POSITION' },
        { status: 409 }
      );
    }
    logger.error('error-creating-memo:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to create memo' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/worktrees/:id/memos
 * Reorders the memos of a worktree (Issue #944).
 *
 * Request body:
 * - memoIds: string[] - The complete set of memo IDs in the desired order
 *
 * Responses:
 * - 200 { success: true }   - Reorder applied
 * - 400 INVALID_WORKTREE_ID - Malformed worktree ID
 * - 400 INVALID_MEMO_IDS    - Payload failed domain validation
 * - 404                     - Worktree not found
 * - 500                     - Unexpected server error
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Validate worktree ID format (mirrors PATCH /api/worktrees/[id])
    const { id } = await params;
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format', code: 'INVALID_WORKTREE_ID' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found`, code: 'WORKTREE_NOT_FOUND' },
        { status: 404 }
      );
    }

    // Parse request body
    const body = await request.json().catch(() => ({}));
    const memoIds = (body as { memoIds?: unknown }).memoIds;

    // Domain validation against the worktree's existing memos
    const existingMemos = getMemosByWorktreeId(db, id);
    const validation = validateMemoReorderInput(memoIds, existingMemos);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error, code: 'INVALID_MEMO_IDS' },
        { status: 400 }
      );
    }

    reorderMemos(db, id, memoIds as string[]);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-reordering-memos:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to reorder memos' },
      { status: 500 }
    );
  }
}
