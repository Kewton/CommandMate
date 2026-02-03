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
  type AutoYesState,
} from '@/lib/auto-yes-manager';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** Allowed CLI tool IDs */
const ALLOWED_CLI_TOOLS: CLIToolType[] = ['claude', 'codex', 'gemini'];

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
  return ALLOWED_CLI_TOOLS.includes(cliToolId as CLIToolType);
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
    const notFound = validateWorktreeExists(params.id);
    if (notFound) return notFound;

    const body = await request.json();
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled must be a boolean' },
        { status: 400 }
      );
    }

    // Validate cliToolId if provided (default: 'claude')
    const cliToolId: CLIToolType = isValidCliTool(body.cliToolId)
      ? body.cliToolId
      : 'claude';

    const state = setAutoYesEnabled(params.id, body.enabled);

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
