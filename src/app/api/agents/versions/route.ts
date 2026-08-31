/**
 * GET /api/agents/versions — installed versions of the agent CLIs, plus codex's
 * own "there is a newer one" (Issue #2069).
 *
 * Before this route CommandMate displayed no CLI version anywhere: a user whose
 * codex was three releases behind had no way to learn that from the app, and
 * the detector's own staleness hint (#1929) only ever surfaced in
 * `commandmate status`.
 *
 * Two properties worth stating, because they are what make it safe to render on
 * a settings screen and inside the agent pane:
 *
 *  - **No network.** The installed half is `<cli> --version`; the "is there a
 *    newer one" half is `~/.codex/version.json`, which codex writes for itself.
 *  - **Cached, single-flight.** `getAgentVersions()` fans out one child process
 *    per tool behind a 30s TTL (#1913's hot-path rule). `?refresh=1` bypasses
 *    it — that is what the client sends immediately after an update, so the new
 *    version is visible without waiting the TTL out.
 *
 * @module api/agents/versions
 */

// Probes the machine on every request; a prerendered answer would be a snapshot
// of whatever was installed on the build host.
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getAgentVersions, type AgentVersionRow } from '@/lib/updates/agent-versions';
import { UPDATABLE_AGENT_TOOLS } from '@/lib/updates/agent-updater';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/agents/versions');

/** Success body. */
export interface AgentVersionsResponse {
  status: 'success';
  tools: AgentVersionRow[];
  /** Tool ids the update route accepts, so the UI never hardcodes the list. */
  updatable: string[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const force = request.nextUrl?.searchParams?.get('refresh') === '1';
    const tools = await getAgentVersions({ force });
    return NextResponse.json(
      {
        status: 'success' as const,
        tools,
        updatable: [...UPDATABLE_AGENT_TOOLS],
      },
      {
        status: 200,
        // The whole point is freshness; an intermediary cache would defeat
        // `?refresh=1` for the one caller that needs it.
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (error) {
    logger.error('agent-versions-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ status: 'error', error: 'Internal server error' }, { status: 500 });
  }
}
