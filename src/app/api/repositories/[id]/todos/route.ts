/**
 * API Route: /api/repositories/:id/todos
 * GET: Returns all todos for a repository
 * POST: Creates a new todo for a repository
 *
 * Global Home ToDo feature: lightweight, checkbox-style notes scoped to a
 * repository (repositories.id).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryById } from '@/lib/db/db-repository';
import { getTodosByRepositoryId, createTodo } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import { MAX_TODOS_PER_REPOSITORY, MAX_TODO_CONTENT_LENGTH } from '@/config/todo-config';

const logger = createLogger('api/repository-todos');

/**
 * GET /api/repositories/:id/todos
 * Returns all todos for a repository sorted by position.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    const repository = getRepositoryById(db, id);
    if (!repository) {
      return NextResponse.json(
        { error: `Repository '${id}' not found` },
        { status: 404 }
      );
    }

    const todos = getTodosByRepositoryId(db, id);

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
 * POST /api/repositories/:id/todos
 * Creates a new todo for a repository.
 *
 * Request body:
 * - content: string - ToDo text (required, non-empty, max 2000 chars)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    const repository = getRepositoryById(db, id);
    if (!repository) {
      return NextResponse.json(
        { error: `Repository '${id}' not found` },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { content } = body;

    // Validate content
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

    // Check todo limit
    const existing = getTodosByRepositoryId(db, id);
    if (existing.length >= MAX_TODOS_PER_REPOSITORY) {
      return NextResponse.json(
        { error: `Maximum todo limit (${MAX_TODOS_PER_REPOSITORY}) reached` },
        { status: 400 }
      );
    }

    const todo = createTodo(db, id, {
      content: trimmed,
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
