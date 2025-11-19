/**
 * API Route: GET /api/worktrees/:id/messages
 * Returns chat messages for a specific worktree with pagination
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, getMessages } from '@/lib/db';

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
    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    const cliToolId = cliToolParam as 'claude' | 'codex' | 'gemini' | undefined;

    // Validate CLI tool ID
    if (cliToolId && !['claude', 'codex', 'gemini'].includes(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliTool parameter (must be claude, codex, or gemini)' },
        { status: 400 }
      );
    }

    // Validate limit
    if (isNaN(limit) || limit < 1 || limit > 100) {
      return NextResponse.json(
        { error: 'Invalid limit parameter (must be 1-100)' },
        { status: 400 }
      );
    }

    // Get messages with optional CLI tool filter
    const messages = getMessages(db, params.id, before, limit, cliToolId);

    // Filter out messages with empty content (defensive programming)
    const validMessages = messages.filter((m) => m.content && m.content.trim() !== '');

    // API consumers expect chronological order, so reverse the DESC query results
    const chronologicalMessages = [...validMessages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return NextResponse.json(chronologicalMessages, { status: 200 });
  } catch (error) {
    console.error('Error fetching messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}
