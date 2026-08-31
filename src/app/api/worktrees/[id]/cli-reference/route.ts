/**
 * API Route: GET /api/worktrees/:id/cli-reference
 *
 * Issue #2120: how a CLI command aimed at this worktree must be SPELLED, for a
 * browser that cannot work it out for itself.
 *
 * Two facts live in the server process and nowhere else:
 *
 *   - the binary name. `commandmate start` stamps `CM_LAUNCHED_BY` on the
 *     server child, so an installed CommandMate answers `commandmate` and a
 *     development checkout answers `commandmatedev`. Next.js inlines only
 *     `NEXT_PUBLIC_*` into the browser bundle, so a client component reading
 *     `process.env.CM_LAUNCHED_BY` gets `undefined` and would print the same
 *     wrong command on every development machine.
 *   - the port. A worktree server started with `--issue N --auto-port` is not
 *     on 3000, and the four targeting commands define no `--port` flag; the
 *     documented way to aim one invocation elsewhere is the `CM_PORT=` prefix.
 *     Answering `null` here is the server saying the prefix is unnecessary, so
 *     the decision is made once, beside `getServerPort()`, rather than by a
 *     literal 3000 in the browser.
 *
 * What this route deliberately does NOT answer is which instance a command
 * targets. That is `GET /api/worktrees/:id/resolve-target`, and Issue #1925 is
 * the record of what happens when a second caller grows its own copy of the
 * precedence rules.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getClientIp } from '@/lib/security/ip-restriction';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { createLogger } from '@/lib/logger';
import {
  resolveCommandMateBinary,
  DEFAULT_SERVER_PORT,
  type CommandMateBinary,
} from '@/lib/cli/command-reference';
import { getServerPort } from '@/lib/env';

const logger = createLogger('api/cli-reference');

/**
 * Per-IP budget. Smaller than `resolve-target`'s 240 because nothing polls this
 * route: it is read once when a human opens the commands panel, and the answer
 * cannot change without the server restarting.
 */
const rateLimiter = createRequestRateLimiter({ limit: 60, windowMs: 60_000 });

/** Response shape consumed by the roster pane's CLI-commands panel. */
export interface CliReferenceResponse {
  /** `commandmate` or `commandmatedev`, from `CM_LAUNCHED_BY`. */
  binary: CommandMateBinary;
  /** The worktree id the CLI must be given (canonical, not the alias asked for). */
  worktreeId: string;
  /** Port to name in a `CM_PORT=` prefix; null when this server is on the default. */
  portPrefix: number | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const clientIp = getClientIp(request.headers) ?? 'unknown';
    const limit = rateLimiter.check(clientIp);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } }
      );
    }

    // A 404 here rather than an unconditional answer: the panel this feeds
    // prints a ready-to-paste command naming the worktree, and a command naming
    // a worktree the server does not have is worse than an error.
    const db = getDbInstance();
    if (!getWorktreeById(db, id)) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const port = getServerPort();
    const body: CliReferenceResponse = {
      binary: resolveCommandMateBinary(),
      worktreeId: id,
      portPrefix: port === DEFAULT_SERVER_PORT ? null : port,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-building-cli-reference:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to build CLI reference' }, { status: 500 });
  }
}
