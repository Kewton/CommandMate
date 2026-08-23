/**
 * API Route: GET /api/worktrees/:id/current-output
 * Gets the current tmux output for a worktree (even if incomplete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import { getDetectorStalenessSnapshot } from '@/lib/detection/version-probes';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

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
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
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
    // An unknown `?cliTool` is dropped rather than refused, which is what this
    // route has always done. Passing it through would make the shared resolver
    // answer with a tool id no CLIToolManager knows.
    const cliToolParam = url.searchParams.get('cliTool');
    const requestedCliTool = isCliTool(cliToolParam) ? cliToolParam : undefined;

    // Issue #868: optional instance selector. Validate (embedded in session name)
    // and resolve to the primary instance (instanceId === cliToolId) when omitted.
    const instanceParam = url.searchParams.get('instance');
    if (instanceParam !== null && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instance parameter' },
        { status: 400 }
      );
    }

    // Issue #1884: `?instance=` is resolved to a CLI tool here, through the one
    // shared resolver (Issue #1925, design §4 D5 決定 3). This route used to read
    // `?cliTool` and otherwise take the worktree default, ignoring the instance
    // entirely — so on a worktree whose default is claude, `?instance=opencode`
    // asked getTool('claude').isRunning(id, 'opencode') for a session named
    // `mcbd-claude-<id>-opencode` that has never existed. It answered
    // `isRunning: false` while the opencode session was generating, and
    // `commandmate wait --instance opencode` (which has no --agent to correct it
    // with) reported NOT_STARTED / exit 21 on a live agent.
    //
    // Read path, so a `?cliTool` the roster contradicts resolves rather than
    // failing: the roster wins and the contradiction ships in the payload
    // (DR3-015). See CurrentOutputPayload.conflict.
    const target = resolveSessionTarget(db, id, {
      instanceId: instanceParam ?? undefined,
      requestedCliTool,
    });

    if (target.conflict) {
      logger.warn('instance-tool-conflict:', {
        worktreeId: id,
        instanceId: target.conflict.instanceId,
        rosterCliTool: target.conflict.rosterCliTool,
        requestedCliTool: target.conflict.requestedCliTool,
      });
    }

    // Issue #1120: payload assembly is shared with the WS terminal streamer via
    // buildCurrentOutput() so the pull (HTTP) and push (WS) paths stay identical.
    const payload = await buildCurrentOutput(db, id, target.cliToolId, target.instanceId, {
      resolvedBy: target.resolvedBy,
      conflict: target.conflict,
    });

    // Issue #1929 (§4 D2 / DR3-013): whether the detector's rules were read off
    // the build that is installed. This is the 5-second polling path, so the
    // SNAPSHOT is used — it answers from a process-level cache or answers
    // `undefined` and probes in the background, and never awaits a child.
    // `detector` is therefore absent until the cache is warm, which the reader
    // must take as "not known yet" rather than "nothing is stale".
    //
    // Attached here rather than inside buildCurrentOutput on purpose: DR4-008
    // limits this to authenticated surfaces (`capture --json` / `commandmate
    // status`), and the builder is also the WS terminal streamer's payload.
    const staleness = getDetectorStalenessSnapshot();
    return NextResponse.json(
      staleness === undefined ? payload : { ...payload, detector: { staleness } },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('error-getting-current-output:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to get current output' },
      { status: 500 }
    );
  }
}
