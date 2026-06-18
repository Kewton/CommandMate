/**
 * API Route: /api/repositories/:id/todos/:todoId
 * PATCH: Updates a specific todo (content and/or done state)
 * DELETE: Deletes a specific todo
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryById } from '@/lib/db/db-repository';
import { getTodoById, updateTodo, deleteTodo } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { MAX_TODO_CONTENT_LENGTH } from '@/config/todo-config';

const logger = createLogger('api/repository-todos');

/**
 * PATCH /api/repositories/:id/todos/:todoId
 * Updates a todo's content and/or done state.
 *
 * Request body:
 * - content?: string - New content (non-empty, max 2000 chars)
 * - done?: boolean - Completion state
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; todoId: string }> }
) {
  try {
    const { id, todoId } = await params;
    const db = getDbInstance();

    const repository = getRepositoryById(db, id);
    if (!repository) {
      return NextResponse.json(
        { error: `Repository '${id}' not found` },
        { status: 404 }
      );
    }

    const existing = getTodoById(db, todoId);
    if (!existing || existing.repositoryId !== id) {
      return NextResponse.json(
        { error: `Todo '${todoId}' not found` },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { content, done } = body;

    if (content === undefined && done === undefined) {
      return NextResponse.json(
        { error: 'content or done is required' },
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

    if (done !== undefined && typeof done !== 'boolean') {
      return NextResponse.json(
        { error: 'done must be a boolean' },
        { status: 400 }
      );
    }

    updateTodo(db, todoId, { content: trimmed, done });

    const updatedTodo = getTodoById(db, todoId);

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
 * DELETE /api/repositories/:id/todos/:todoId
 * Deletes a specific todo.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; todoId: string }> }
) {
  try {
    const { id, todoId } = await params;
    const db = getDbInstance();

    const repository = getRepositoryById(db, id);
    if (!repository) {
      return NextResponse.json(
        { error: `Repository '${id}' not found` },
        { status: 404 }
      );
    }

    const existing = getTodoById(db, todoId);
    if (!existing || existing.repositoryId !== id) {
      return NextResponse.json(
        { error: `Todo '${todoId}' not found` },
        { status: 404 }
      );
    }

    deleteTodo(db, todoId);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-deleting-todo:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to delete todo' },
      { status: 500 }
    );
  }
}
