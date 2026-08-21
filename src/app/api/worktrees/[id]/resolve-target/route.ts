/**
 * API Route: GET /api/worktrees/:id/resolve-target
 *
 * Issue #1925 (design §4 D5 決定 1): the server is the authority on which CLI
 * tool and instance a request targets, and this is how the CLI asks. Before it
 * existed the CLI carried its own copy of the precedence rules — a copy that
 * was missing the primary-anchor stage, so `--instance codex` against a roster
 * that never registered `codex` resolved to the worktree default on the client
 * and to codex on the server. Two authorities, two answers, one tmux session
 * name built from whichever one happened to run.
 *
 * Read-only by construction (DR3-015): a request whose explicit tool
 * contradicts the roster still answers 200 with the roster's answer and the
 * contradiction attached, because `capture` polls this path and an error here
 * would stall the monitor loops that treat a non-zero capture as "skip this
 * poll". Callers with a side effect refuse the contradiction themselves.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getClientIp } from '@/lib/security/ip-restriction';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import {
  resolveSessionTarget,
  type SessionTargetConflict,
  type SessionTargetResolvedBy,
} from '@/lib/session/resolve-session-target';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/resolve-target');

/**
 * Per-IP budget (DR4-015 / S20). Applied — unlike `/api/capabilities` — because
 * every call reads the worktree row and the roster. Sized for the polling
 * callers rather than for a human: `capture` resolves once per poll at the
 * 5-second cadence the monitor skills use, and several workers share one server.
 */
const rateLimiter = createRequestRateLimiter({ limit: 240, windowMs: 60_000 });

/** Response shape consumed by the CLI's thin resolution client. */
export interface ResolveTargetResponse {
  cliToolId: CLIToolType;
  instanceId: string;
  resolvedBy: SessionTargetResolvedBy;
  /** Null rather than absent so the field is always readable. */
  conflict: SessionTargetConflict | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json(
        { error: 'Invalid worktree ID format' },
        { status: 400 }
      );
    }

    const clientIp = getClientIp(request.headers) ?? 'unknown';
    const limit = rateLimiter.check(clientIp);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } }
      );
    }

    const db = getDbInstance();
    // The roster lookup is scoped to this worktree, so a 404 here is what stops
    // an instance id from resolving against somebody else's worktree.
    if (!getWorktreeById(db, id)) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    const url = new URL(request.url);

    const instanceParam = url.searchParams.get('instance');
    if (instanceParam !== null && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instance parameter' },
        { status: 400 }
      );
    }

    const cliToolParam = url.searchParams.get('cliTool');
    if (cliToolParam !== null && !(CLI_TOOL_IDS as readonly string[]).includes(cliToolParam)) {
      return NextResponse.json(
        { error: `Invalid cliTool: '${cliToolParam}'. Valid values: ${CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    const target = resolveSessionTarget(db, id, {
      instanceId: instanceParam ?? undefined,
      requestedCliTool: (cliToolParam as CLIToolType | null) ?? undefined,
    });

    const body: ResolveTargetResponse = {
      cliToolId: target.cliToolId,
      instanceId: target.instanceId,
      resolvedBy: target.resolvedBy,
      conflict: target.conflict ?? null,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-resolving-session-target:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to resolve session target' },
      { status: 500 }
    );
  }
}
