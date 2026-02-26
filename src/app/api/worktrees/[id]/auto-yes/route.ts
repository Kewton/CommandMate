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
  isValidWorktreeId,
  startAutoYesPolling,
  stopAutoYesPolling,
  type AutoYesState,
} from '@/lib/auto-yes-manager';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isAllowedDuration, DEFAULT_AUTO_YES_DURATION, validateStopPattern, type AutoYesDuration } from '@/config/auto-yes-config';

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
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const notFound = validateWorktreeExists(params.id);
    if (notFound) return notFound;

    const state = getAutoYesState(params.id);
    return NextResponse.json(buildAutoYesResponse(state));
  } catch (error: unknown) {
    console.error('Error getting auto-yes state:', error);
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

    // Validate cliToolId if provided (default: 'claude')
    const cliToolId: CLIToolType = isValidCliTool(body.cliToolId)
      ? body.cliToolId
      : 'claude';

    const state = setAutoYesEnabled(
      params.id,
      body.enabled,
      body.enabled ? duration : undefined,
      body.enabled ? stopPattern : undefined
    );

    // Issue #138: Start or stop server-side polling
    let pollingStarted = false;
    if (body.enabled) {
      const result = startAutoYesPolling(params.id, cliToolId);
      pollingStarted = result.started;
      if (!result.started) {
        console.warn(`[Auto-Yes API] Polling not started: ${result.reason}`);
      }
    } else {
      stopAutoYesPolling(params.id);
    }

    return NextResponse.json(buildAutoYesResponse(state, pollingStarted));
  } catch (error: unknown) {
    console.error('Error setting auto-yes state:', error);
    return NextResponse.json(
      { error: 'Failed to set auto-yes state' },
      { status: 500 }
    );
  }
}
