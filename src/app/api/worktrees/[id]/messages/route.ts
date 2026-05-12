/**
 * API Route: GET /api/worktrees/:id/messages
 * Returns chat messages for a specific worktree with pagination
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, getMessages } from '@/lib/db';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { MAX_MESSAGES_LIMIT, DEFAULT_MESSAGES_LIMIT } from '@/config/history-display-config';

const logger = createLogger('api/messages');

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

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const beforeParam = searchParams.get('before');
    const limitParam = searchParams.get('limit');
    const cliToolParam = searchParams.get('cliTool');

    const before = beforeParam ? new Date(beforeParam) : undefined;
    const limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_MESSAGES_LIMIT;
    const cliToolId = cliToolParam as CLIToolType | undefined;
    const includeArchivedParam = searchParams.get('includeArchived');
    const includeArchived = includeArchivedParam === 'true';

    // Issue #368: Use CLI_TOOL_IDS instead of hardcoded array (DRY)
    if (cliToolId && !(CLI_TOOL_IDS as readonly string[]).includes(cliToolId)) {
      return NextResponse.json(
        { error: `Invalid cliTool parameter (must be one of: ${CLI_TOOL_IDS.join(', ')})` },
        { status: 400 }
      );
    }

    // Validate limit (Issue #701: upper bound raised to MAX_MESSAGES_LIMIT)
    if (isNaN(limit) || limit < 1 || limit > MAX_MESSAGES_LIMIT) {
      return NextResponse.json(
        { error: `Invalid limit parameter (must be 1-${MAX_MESSAGES_LIMIT})` },
        { status: 400 }
      );
    }

    // Get messages with optional CLI tool filter
    const messages = getMessages(db, params.id, { before, limit, cliToolId, includeArchived });

    // Filter out messages with empty content (defensive programming)
    const validMessages = messages.filter((m) => m.content && m.content.trim() !== '');

    // API consumers expect chronological order, so reverse the DESC query results
    const chronologicalMessages = [...validMessages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return NextResponse.json(chronologicalMessages, { status: 200 });
  } catch (error) {
    logger.error('error-fetching-messages:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}
