/**
 * API Route: GET/POST /api/worktrees/:id/auto-yes
 * Manages auto-yes mode state for a worktree
 *
 * Issue #138: Extended to trigger server-side polling
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  getAutoYesState,
  setAutoYesEnabled,
  startAutoYesPolling,
  stopAutoYesPolling,
  stopAutoYesPollingByWorktree,
  buildCompositeKey,
  getCompositeKeysByWorktree,
  extractCliToolId,
  type AutoYesState,
} from '@/lib/polling/auto-yes-manager';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isAllowedDuration, DEFAULT_AUTO_YES_DURATION, validateStopPattern, type AutoYesDuration } from '@/config/auto-yes-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/auto-yes');

/**
 * Allowed CLI tool IDs for interactive auto-yes (session-based).
 * Derived from CLI_TOOL_IDS (Issue #368: DRY).
 * Note: This differs from claude-executor.ts ALLOWED_CLI_TOOLS which is for
 * non-interactive (-p flag) schedule execution. See R3-006.
 */
const ALLOWED_CLI_TOOLS: readonly CLIToolType[] = CLI_TOOL_IDS;

/** Response shape for auto-yes state */
interface AutoYesResponse {
  enabled: boolean;
  expiresAt: number | null;
  pollingStarted?: boolean;
}

/** Build the JSON response shape from an AutoYesState */
function buildAutoYesResponse(
  state: AutoYesState | null,
  pollingStarted?: boolean
): AutoYesResponse {
  const response: AutoYesResponse = {
    enabled: state?.enabled ?? false,
    expiresAt: state?.enabled ? state.expiresAt : null,
  };
  if (pollingStarted !== undefined) {
    response.pollingStarted = pollingStarted;
  }
  return response;
}

/** Validate that the worktree exists; returns 404 response if not found */
function validateWorktreeExists(worktreeId: string): NextResponse | null {
  const db = getDbInstance();
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) {
    return NextResponse.json(
      { error: `Worktree '${worktreeId}' not found` },
      { status: 404 }
    );
  }
  return null;
}

/** Validate CLI tool ID */
function isValidCliTool(cliToolId: string | undefined): cliToolId is CLIToolType {
  if (!cliToolId) return false;
  return (ALLOWED_CLI_TOOLS as readonly string[]).includes(cliToolId);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // [SEC4-SF-003] Validate worktree ID format
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const notFound = validateWorktreeExists(params.id);
    if (notFound) return notFound;

    // Issue #525: cliToolId query parameter support
    const url = new URL(request.url);
    const cliToolIdParam = url.searchParams.get('cliToolId');

    if (cliToolIdParam) {
      // Single agent query
      if (!isValidCliTool(cliToolIdParam)) {
        return NextResponse.json(
          { error: 'Invalid cliToolId' },
          { status: 400 }
        );
      }
      const state = getAutoYesState(params.id, cliToolIdParam);
      return NextResponse.json(buildAutoYesResponse(state));
    }

    // No cliToolId: return map of all agents
    const compositeKeys = getCompositeKeysByWorktree(params.id);
    const agentStates: Record<string, ReturnType<typeof buildAutoYesResponse>> = {};
    for (const key of compositeKeys) {
      const agentId = extractCliToolId(key);
      if (!agentId) continue;
      const state = getAutoYesState(params.id, agentId);
      agentStates[agentId] = buildAutoYesResponse(state);
    }

    // For backward compatibility, also include top-level fields from default agent
    const defaultState = getAutoYesState(params.id, 'claude');
    return NextResponse.json({
      ...buildAutoYesResponse(defaultState),
      agents: agentStates,
    });
  } catch (error: unknown) {
    logger.error('error-getting-auto-yes-state:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to get auto-yes state' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // [SEC-MF-001] Validate worktree ID format before DB query
    if (!isValidWorktreeId(params.id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const notFound = validateWorktreeExists(params.id);
    if (notFound) return notFound;

    // [SEC-SF-001] JSON parse error handling
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled must be a boolean' },
        { status: 400 }
      );
    }

    // [SEC-SF-002] Validate duration if provided (whitelist check with type guard)
    let duration: AutoYesDuration = DEFAULT_AUTO_YES_DURATION;
    if (body.enabled && body.duration !== undefined) {
      if (!isAllowedDuration(body.duration)) {
        return NextResponse.json(
          { error: 'Invalid duration value. Allowed values: 3600000, 10800000, 28800000' },
          { status: 400 }
        );
      }
      duration = body.duration;
    }

    // [SEC-SF-003] Validate stopPattern if provided (Issue #314)
    let stopPattern: string | undefined;
    if (body.enabled && body.stopPattern !== undefined) {
      const trimmed = typeof body.stopPattern === 'string' ? body.stopPattern.trim() : '';
      if (trimmed) {
        const validation = validateStopPattern(trimmed);
        if (!validation.valid) {
          return NextResponse.json(
            { error: validation.error },
            { status: 400 }
          );
        }
        stopPattern = trimmed;
      }
    }

    // [SEC4-SF-002] Validate cliToolId: reject invalid values (no fallback)
    if (body.cliToolId !== undefined && !isValidCliTool(body.cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId' },
        { status: 400 }
      );
    }
    const cliToolId: CLIToolType = body.cliToolId ?? 'claude';

    // Issue #138, #525: Start or stop server-side polling
    let pollingStarted = false;
    let state;
    if (body.enabled) {
      state = setAutoYesEnabled(
        params.id,
        cliToolId,
        true,
        duration,
        stopPattern
      );
      const result = startAutoYesPolling(params.id, cliToolId);
      pollingStarted = result.started;
      if (!result.started) {
        logger.warn('polling-not-started:');
      }
    } else {
      // Issue #525: cliToolId specified -> stop individual; not specified -> stop all
      if (body.cliToolId) {
        state = setAutoYesEnabled(params.id, cliToolId, false);
        const compositeKey = buildCompositeKey(params.id, cliToolId);
        stopAutoYesPolling(compositeKey);
      } else {
        // Disable all agents for this worktree
        const keys = getCompositeKeysByWorktree(params.id);
        for (const key of keys) {
          const toolId = extractCliToolId(key);
          if (toolId) {
            setAutoYesEnabled(params.id, toolId, false);
          }
        }
        stopAutoYesPollingByWorktree(params.id);
        state = { enabled: false, enabledAt: 0, expiresAt: 0 };
      }
    }

    return NextResponse.json(buildAutoYesResponse(state, pollingStarted));
  } catch (error: unknown) {
    logger.error('error-setting-auto-yes-state:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to set auto-yes state' },
      { status: 500 }
    );
  }
}
