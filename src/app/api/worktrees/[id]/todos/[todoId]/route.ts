/**
 * API Route: /api/worktrees/:id/todos/:todoId
 * PATCH:  Updates a specific todo (content and/or done state)
 * DELETE: Deletes a specific todo
 *
 * Branch-scoped ToDo list (Issue #1015). The item-update verb is PATCH
 * (matching the repository ToDo template), NOT the memo child route's PUT.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getWorktreeById,
  getWorktreeTodoById,
  updateWorktreeTodo,
  deleteWorktreeTodo,
  isWorktreeTodoStatus,
  WORKTREE_TODO_STATUSES,
} from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { MAX_TODO_CONTENT_LENGTH, MAX_TODO_DETAIL_LENGTH } from '@/config/todo-config';

const logger = createLogger('api/worktree-todos');

/**
 * PATCH /api/worktrees/:id/todos/:todoId
 * Updates a todo's content and/or done state.
 *
 * Request body (at least one of):
 * - content?: string - New content (non-empty, max MAX_TODO_CONTENT_LENGTH chars)
 * - detail?: string - Supplementary notes (may be empty, max MAX_TODO_DETAIL_LENGTH chars, Issue #1034)
 * - status?: 'todo' | 'doing' | 'done' - Progress state (Issue #1032)
 * - done?: boolean - Legacy completion state (mapped to status when status omitted)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; todoId: string }> }
) {
  try {
    const { id, todoId } = await params;
    const db = getDbInstance();

    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const existing = getWorktreeTodoById(db, todoId);
    if (!existing || existing.worktreeId !== id) {
      return NextResponse.json(
        { error: `Todo '${todoId}' not found` },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { content, detail, done, status } = body;

    if (
      content === undefined &&
      detail === undefined &&
      done === undefined &&
      status === undefined
    ) {
      return NextResponse.json(
        { error: 'content, detail, status, or done is required' },
        { status: 400 }
      );
    }

    let trimmed: string | undefined;
    if (content !== undefined) {
      if (typeof content !== 'string' || content.trim().length === 0) {
        return NextResponse.json(
          { error: 'content must be a non-empty string' },
          { status: 400 }
        );
      }
      trimmed = content.trim();
      if (trimmed.length > MAX_TODO_CONTENT_LENGTH) {
        return NextResponse.json(
          { error: `content must be ${MAX_TODO_CONTENT_LENGTH} characters or less` },
          { status: 400 }
        );
      }
    }

    // detail (Issue #1034) may be empty and is stored verbatim; only the type
    // and max length are validated.
    if (detail !== undefined) {
      if (typeof detail !== 'string') {
        return NextResponse.json(
          { error: 'detail must be a string' },
          { status: 400 }
        );
      }
      if (detail.length > MAX_TODO_DETAIL_LENGTH) {
        return NextResponse.json(
          { error: `detail must be ${MAX_TODO_DETAIL_LENGTH} characters or less` },
          { status: 400 }
        );
      }
    }

    if (done !== undefined && typeof done !== 'boolean') {
      return NextResponse.json(
        { error: 'done must be a boolean' },
        { status: 400 }
      );
    }

    if (status !== undefined && !isWorktreeTodoStatus(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${WORKTREE_TODO_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    updateWorktreeTodo(db, todoId, { content: trimmed, detail, done, status });

    const updatedTodo = getWorktreeTodoById(db, todoId);

    return NextResponse.json({ todo: updatedTodo }, { status: 200 });
  } catch (error) {
    logger.error('error-updating-todo:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to update todo' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/worktrees/:id/todos/:todoId
 * Deletes a specific todo.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; todoId: string }> }
) {
  try {
    const { id, todoId } = await params;
    const db = getDbInstance();

    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const existing = getWorktreeTodoById(db, todoId);
    if (!existing || existing.worktreeId !== id) {
      return NextResponse.json(
        { error: `Todo '${todoId}' not found` },
        { status: 404 }
      );
    }

    deleteWorktreeTodo(db, todoId);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-deleting-todo:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to delete todo' },
      { status: 500 }
    );
  }
}
