/**
 * API Route: /api/worktrees/:id/todos
 * GET:   Returns all todos for a worktree (sorted by position)
 * POST:  Creates a new todo for a worktree
 * PATCH: Reorders the todos of a worktree
 *
 * Branch-scoped ToDo list (Issue #1015). URL/CRUD structure mirrors
 * /api/worktrees/:id/memos; item updates live on the child [todoId] route and
 * use PATCH (matching the repository ToDo template, not memo's PUT).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getWorktreeById,
  getTodosByWorktreeId,
  createWorktreeTodo,
  reorderWorktreeTodos,
} from '@/lib/db';
import { createLogger } from '@/lib/logger';
import {
  MAX_TODOS_PER_WORKTREE,
  MAX_TODO_CONTENT_LENGTH,
  MAX_TODO_DETAIL_LENGTH,
} from '@/config/todo-config';

const logger = createLogger('api/worktree-todos');

/**
 * GET /api/worktrees/:id/todos
 * Returns all todos for a worktree sorted by position.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const todos = getTodosByWorktreeId(db, id);

    return NextResponse.json({ todos }, { status: 200 });
  } catch (error) {
    logger.error('error-fetching-todos:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to fetch todos' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/worktrees/:id/todos
 * Creates a new todo for a worktree.
 *
 * Request body:
 * - content: string - ToDo text (required, non-empty, max MAX_TODO_CONTENT_LENGTH chars)
 * - detail?: string - Supplementary notes (optional, max MAX_TODO_DETAIL_LENGTH chars, Issue #1034)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { content, detail } = body;

    // Validate content presence.
    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'content is required' },
        { status: 400 }
      );
    }

    const trimmed = content.trim();
    if (trimmed.length > MAX_TODO_CONTENT_LENGTH) {
      return NextResponse.json(
        { error: `content must be ${MAX_TODO_CONTENT_LENGTH} characters or less` },
        { status: 400 }
      );
    }

    // Validate the optional detail (Issue #1034). Unlike content it may be empty
    // and is stored verbatim (leading/trailing whitespace preserved).
    if (detail !== undefined && typeof detail !== 'string') {
      return NextResponse.json(
        { error: 'detail must be a string' },
        { status: 400 }
      );
    }
    if (typeof detail === 'string' && detail.length > MAX_TODO_DETAIL_LENGTH) {
      return NextResponse.json(
        { error: `detail must be ${MAX_TODO_DETAIL_LENGTH} characters or less` },
        { status: 400 }
      );
    }

    // Enforce the per-worktree todo count limit.
    const existing = getTodosByWorktreeId(db, id);
    if (existing.length >= MAX_TODOS_PER_WORKTREE) {
      return NextResponse.json(
        { error: `Maximum todo limit (${MAX_TODOS_PER_WORKTREE}) reached` },
        { status: 400 }
      );
    }

    const todo = createWorktreeTodo(db, id, {
      content: trimmed,
      detail: typeof detail === 'string' ? detail : undefined,
      position: existing.length,
    });

    return NextResponse.json({ todo }, { status: 201 });
  } catch (error) {
    logger.error('error-creating-todo:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to create todo' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/worktrees/:id/todos
 * Reorders the todos of a worktree.
 *
 * Request body:
 * - todoIds: string[] - The complete set of todo IDs in the desired order.
 *
 * Note: item-level updates (content/done) use PATCH on the child [todoId]
 * route; this collection-level PATCH is dedicated to reordering (mirrors the
 * memos collection route).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const todoIds = (body as { todoIds?: unknown }).todoIds;

    // The payload must be the complete set of the worktree's todo IDs, in the
    // desired order (no missing/extra/duplicate ids).
    const existing = getTodosByWorktreeId(db, id);
    const existingIds = existing.map((t) => t.id);

    if (
      !Array.isArray(todoIds) ||
      todoIds.some((todoId) => typeof todoId !== 'string') ||
      todoIds.length !== existingIds.length ||
      new Set(todoIds as string[]).size !== todoIds.length ||
      !(todoIds as string[]).every((todoId) => existingIds.includes(todoId))
    ) {
      return NextResponse.json(
        { error: 'todoIds must be the complete set of this worktree\'s todo ids' },
        { status: 400 }
      );
    }

    reorderWorktreeTodos(db, id, todoIds as string[]);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('error-reordering-todos:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to reorder todos' },
      { status: 500 }
    );
  }
}
