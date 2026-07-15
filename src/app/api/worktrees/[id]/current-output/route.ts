/**
 * API Route: GET /api/worktrees/:id/current-output
 * Gets the current tmux output for a worktree (even if incomplete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/current-output');

/** Issue #368: Derive from CLI_TOOL_IDS (DRY) */
function isCliTool(value: string | null): value is CLIToolType {
  return !!value && (CLI_TOOL_IDS as readonly string[]).includes(value);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // [SEC-DS4-F006] Validate worktree ID format (Issue #314)
    const { id } = await params;
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const url = new URL(request.url);
    const cliToolParam = url.searchParams.get('cliTool');
    const cliToolId: CLIToolType = isCliTool(cliToolParam) ? cliToolParam : (worktree.cliToolId || 'claude');

    // Issue #868: optional instance selector. Validate (embedded in session name)
    // and resolve to the primary instance (instanceId === cliToolId) when omitted.
    const instanceParam = url.searchParams.get('instance');
    if (instanceParam !== null && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instance parameter' },
        { status: 400 }
      );
    }
    const instanceId = instanceParam ?? undefined;

    // Issue #1120: payload assembly is shared with the WS terminal streamer via
    // buildCurrentOutput() so the pull (HTTP) and push (WS) paths stay identical.
    const payload = await buildCurrentOutput(db, id, cliToolId, instanceId);
    return NextResponse.json(payload, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-getting-current-output:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to get current output' },
      { status: 500 }
    );
  }
}
