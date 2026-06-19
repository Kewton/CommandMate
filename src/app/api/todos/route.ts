/**
 * API Route: /api/todos
 * GET: Returns every todo across all repositories (global Home ToDo widget).
 *
 * Issue #907: the Home ToDo widget shows a cross-repository list — all
 * repositories' todos are displayed regardless of the dropdown selection,
 * while creation stays scoped to the selected repository via
 * /api/repositories/:id/todos. The `{ todos }` shape matches the per-repo GET.
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getAllTodos } from '@/lib/db';
import { createLogger } from '@/lib/logger';

// Issue #911: Force dynamic rendering so the route reads the live DB on every
// request instead of being statically prerendered at build time. Without this,
// ToDo add/done/delete mutations would not reflect until a hard reload.
export const dynamic = 'force-dynamic';

const logger = createLogger('api/todos');

/**
 * GET /api/todos
 * Returns all todos across every repository, ordered by repository then position.
 */
export async function GET() {
  try {
    const db = getDbInstance();
    const todos = getAllTodos(db);

    return NextResponse.json({ todos }, { status: 200 });
  } catch (error) {
    logger.error('error-fetching-all-todos:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to fetch todos' },
      { status: 500 }
    );
  }
}
