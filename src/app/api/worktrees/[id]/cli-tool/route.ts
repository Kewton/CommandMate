/**
 * API Route: PATCH /api/worktrees/:id/cli-tool
 * Updates the CLI tool for a worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, upsertWorktree } from '@/lib/db';
import { CLI_TOOL_IDS, isCliToolType } from '@/lib/cli-tools/types';

export async function PATCH(
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

    // Parse request body
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    // Validate cliToolId
    if (!('cliToolId' in body) || typeof body.cliToolId !== 'string' || body.cliToolId.length === 0) {
      return NextResponse.json(
        { error: 'CLI tool ID is required' },
        { status: 400 }
      );
    }

    // Issue #368: Use CLI_TOOL_IDS instead of hardcoded array (DRY, R2-001)
    if (!isCliToolType(body.cliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID: ${body.cliToolId}. Valid values are: ${CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Update worktree with new CLI tool
    const updatedWorktree = {
      ...worktree,
      cliToolId: body.cliToolId,
      updatedAt: new Date(),
    };

    upsertWorktree(db, updatedWorktree);

    // Return updated worktree
    return NextResponse.json(updatedWorktree, { status: 200 });
  } catch (error: unknown) {
    console.error('Error updating CLI tool:', error);
    return NextResponse.json(
      { error: 'Failed to update CLI tool' },
      { status: 500 }
    );
  }
}
