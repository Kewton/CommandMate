/**
 * API Route: GET /api/worktrees/:id/messages
 * Returns chat messages for a specific worktree with pagination
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, getMessages } from '@/lib/db';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { MAX_MESSAGES_LIMIT, DEFAULT_MESSAGES_LIMIT } from '@/config/history-display-config';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/messages');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const beforeParam = searchParams.get('before');
    const limitParam = searchParams.get('limit');
    const cliToolParam = searchParams.get('cliTool');
    const instanceParam = searchParams.get('instance');

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

    // Issue #869: optional instance selector. When provided, scopes messages to a
    // single agent instance (overrides cliTool filtering in getMessages).
    if (instanceParam !== null && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instance parameter' },
        { status: 400 }
      );
    }
    const instanceId = instanceParam ?? undefined;

    // Issue #1407: optional unit for `limit`. 'pairs' counts conversation turns so
    // the History pane renders `limit` cards; 'messages' (default) keeps the legacy
    // raw-row semantics for other API consumers.
    const unitParam = searchParams.get('unit');
    if (unitParam !== null && unitParam !== 'messages' && unitParam !== 'pairs') {
      return NextResponse.json(
        { error: 'Invalid unit parameter (must be "messages" or "pairs")' },
        { status: 400 }
      );
    }
    const limitUnit = (unitParam ?? 'messages') as 'messages' | 'pairs';

    // Issue #1685: optional message-type filter. 'prompt' is the audit-trail
    // listing consumed by `commandmate capture --prompts`.
    const messageTypeParam = searchParams.get('messageType');
    if (messageTypeParam !== null && messageTypeParam !== 'prompt' && messageTypeParam !== 'normal') {
      return NextResponse.json(
        { error: 'Invalid messageType parameter (must be "prompt" or "normal")' },
        { status: 400 }
      );
    }
    if (messageTypeParam !== null && limitUnit === 'pairs') {
      // 'pairs' counts user turns; a type filter that excludes user rows would
      // silently break that contract.
      return NextResponse.json(
        { error: 'messageType cannot be combined with unit=pairs' },
        { status: 400 }
      );
    }
    const messageType = (messageTypeParam ?? undefined) as 'prompt' | 'normal' | undefined;

    // Validate limit. Upper bound is MAX_MESSAGES_LIMIT (Issue #701).
    if (isNaN(limit) || limit < 1 || limit > MAX_MESSAGES_LIMIT) {
      return NextResponse.json(
        { error: `Invalid limit parameter (must be 1-${MAX_MESSAGES_LIMIT})` },
        { status: 400 }
      );
    }

    // Get messages with optional CLI tool / instance filter
    const messages = getMessages(db, id, { before, limit, cliToolId, instanceId, includeArchived, messageType, limitUnit });

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
