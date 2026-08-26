/**
 * API Route: /api/worktrees/:id/opencode/share (Issue #2051)
 *
 * The one control in CommandMate that publishes something to the public
 * internet: `POST` hands an opencode session to opencode's own hosting, where
 * anyone holding the link can read it. `GET` answers whether that control may be
 * offered at all, and `DELETE` takes the page back down.
 *
 * Measured against opencode 1.18.22; the record is
 * `docs/design/opencode-server-live-verification.md` §23.
 *
 * ## Why `GET` exists rather than the button just trying
 *
 * With `share: "disabled"` in the config, opencode answers `POST /share` with a
 * bare **HTTP 500 `UnknownError`**. The real reason —
 * `Error: Sharing is disabled in configuration` — is only in the server's log,
 * and the body carries no code that separates it from any other 500. So the
 * refusal cannot be decoded after the fact, and the Issue's acceptance criterion
 * ("the button does not appear when share is disabled") has to be met by asking
 * `GET /config` first. That is what `GET` here is for.
 *
 * `share` is absent from `GET /config` unless the operator set it, and absent is
 * **not** `disabled` — so the gate is `=== 'disabled'` and nothing wider. See
 * `src/types/opencode-share.ts`.
 *
 * ## Why the response never claims a session is "currently shared"
 *
 * `DELETE` genuinely unpublishes, but the session record **keeps** its
 * `share: { url }` — after the delete, in `GET /session/:id`, and across a
 * server restart. There is therefore no field anywhere that means "the page is
 * up right now", and this route does not synthesise one. What it reports is
 * `lastShareUrl`: the URL opencode last minted, which is a record of a past
 * publication. The UI keeps the revoke action available whenever that is set,
 * because offering a revoke for an already-revoked page costs one no-op request
 * and the opposite mistake leaves a conversation published.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getAgentInstances, getWorktreeById } from '@/lib/db';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { createLogger } from '@/lib/logger';
import { OPENCODE_CLI_TOOL_ID } from '@/lib/hooks/sources/opencode/tool-id';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { resolveOpencodeCurrentSessionId } from '@/lib/session/opencode-session-recall';
import { getRememberedOpencodeSession } from '@/lib/session/opencode-session-store';
import {
  fetchOpencodeSessionShareUrl,
  fetchOpencodeShareMode,
  shareOpencodeSession,
  unshareOpencodeSession,
} from '@/lib/hooks/sources/opencode/client';
import {
  isOpencodeSharingDisabled,
  type OpencodeShareMode,
  type OpencodeShareState,
} from '@/types/opencode-share';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const logger = createLogger('api/opencode-share');

/**
 * The primary instance is addressed with no id at all, exactly as every other
 * opencode caller does, so the composite key this resolves to is the one the
 * launcher and the ports file use.
 */
function opencodeRef(worktreeId: string, instanceId: string): AgentInstanceRef {
  return {
    worktreeId,
    cliToolId: OPENCODE_CLI_TOOL_ID,
    instanceId: instanceId === OPENCODE_CLI_TOOL_ID ? undefined : instanceId,
  };
}

/** Every opencode instance id this worktree has: the roster plus the primary. */
function opencodeInstanceIds(worktreeId: string): string[] {
  const db = getDbInstance();
  const ids = new Set<string>([OPENCODE_CLI_TOOL_ID]);
  for (const instance of getAgentInstances(db, worktreeId)) {
    if (instance.cliTool === OPENCODE_CLI_TOOL_ID) ids.add(instance.id);
  }
  return [...ids];
}

/** What one request resolved to before it can act. */
interface ResolvedTarget {
  target: AgentInstanceRef;
  instanceId: string;
  port: number | null;
  sessionId: string | null;
}

async function resolveTarget(
  worktreeId: string,
  instanceId: string
): Promise<ResolvedTarget> {
  const target = opencodeRef(worktreeId, instanceId);
  const port = getAssignedOpencodePort(target);
  if (port === null) {
    // No port means no server: the pane exited, or it was launched with
    // `CM_AGENT_HOOKS_INJECT=0`. The remembered session is still the honest
    // answer to "which session is this instance in".
    return {
      target,
      instanceId,
      port: null,
      sessionId: getRememberedOpencodeSession(target)?.sessionId ?? null,
    };
  }
  const live = await resolveOpencodeCurrentSessionId(target);
  return {
    target,
    instanceId,
    port,
    sessionId: live ?? getRememberedOpencodeSession(target)?.sessionId ?? null,
  };
}

/**
 * Validate `instanceId` from a query parameter or a body field.
 *
 * @returns The id, or a response to return instead
 */
function readInstanceId(
  worktreeId: string,
  raw: unknown
): { instanceId: string } | { error: NextResponse } {
  const instanceId = typeof raw === 'string' && raw !== '' ? raw : OPENCODE_CLI_TOOL_ID;
  if (!isValidInstanceId(instanceId)) {
    return { error: NextResponse.json({ error: 'Invalid instanceId' }, { status: 400 }) };
  }
  if (!opencodeInstanceIds(worktreeId).includes(instanceId)) {
    return {
      error: NextResponse.json(
        { error: `Instance '${instanceId}' is not an opencode instance` },
        { status: 400 }
      ),
    };
  }
  return { instanceId };
}

/** The worktree, or the 404 to return instead. */
function requireWorktree(worktreeId: string): NextResponse | null {
  const worktree = getWorktreeById(getDbInstance(), worktreeId);
  if (!worktree) {
    return NextResponse.json({ error: `Worktree '${worktreeId}' not found` }, { status: 404 });
  }
  return null;
}

/**
 * Whether the share control may be offered for this instance.
 *
 * Three conditions, all measured: a live server to ask, a session to publish,
 * and a `share` setting that is not the one value opencode refuses on.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const worktreeId = canonicalWorktreeId(requestedWorktreeId);

    const missing = requireWorktree(worktreeId);
    if (missing) return missing;

    const resolved = readInstanceId(
      worktreeId,
      request.nextUrl.searchParams.get('instance') ?? undefined
    );
    if ('error' in resolved) return resolved.error;

    const { instanceId, port, sessionId } = await resolveTarget(
      worktreeId,
      resolved.instanceId
    );

    let shareMode: OpencodeShareMode | null = null;
    let lastShareUrl: string | null = null;
    if (port !== null) {
      shareMode = await fetchOpencodeShareMode(port);
      if (sessionId !== null) {
        lastShareUrl = await fetchOpencodeSessionShareUrl(port, sessionId);
      }
    }

    const state: OpencodeShareState = {
      instanceId,
      shareMode,
      canShare: port !== null && sessionId !== null && !isOpencodeSharingDisabled(shareMode),
      sessionId,
      lastShareUrl,
    };
    return NextResponse.json(state, { status: 200 });
  } catch (error: unknown) {
    logger.error('opencode-share:get-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to read opencode share state' }, { status: 500 });
  }
}

/**
 * Publish this instance's current session.
 *
 * **The resulting page is readable by anyone with the link, and carries the
 * conversation unredacted** — measured: the published HTML held the prompts,
 * the replies and the session's absolute `directory` path. The confirmation
 * that this is intended is taken in the UI; what this route adds is the config
 * gate, so that a server configured to refuse is told apart from one that
 * failed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const worktreeId = canonicalWorktreeId(requestedWorktreeId);

    const missing = requireWorktree(worktreeId);
    if (missing) return missing;

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // An absent body means the primary instance; the default below covers it.
    }

    const resolved = readInstanceId(worktreeId, body.instanceId);
    if ('error' in resolved) return resolved.error;

    const { instanceId, port, sessionId } = await resolveTarget(
      worktreeId,
      resolved.instanceId
    );
    if (port === null) {
      return NextResponse.json(
        { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
        { status: 409 }
      );
    }
    if (sessionId === null) {
      return NextResponse.json(
        { error: 'No opencode session to share yet', code: 'NO_OPENCODE_SESSION' },
        { status: 409 }
      );
    }

    // Asked before publishing, not after: the refusal is a bare 500 with no
    // code, so this is the only point at which "disabled" is knowable.
    const shareMode = await fetchOpencodeShareMode(port);
    if (isOpencodeSharingDisabled(shareMode)) {
      return NextResponse.json(
        { error: 'Sharing is disabled in this opencode configuration', code: 'SHARE_DISABLED' },
        { status: 409 }
      );
    }

    const outcome = await shareOpencodeSession(port, sessionId);
    if (outcome.kind === 'shared') {
      logger.info('opencode-share:created', { worktreeId, instanceId, sessionId });
      return NextResponse.json({ sessionId, url: outcome.url }, { status: 200 });
    }
    if (outcome.kind === 'not-found') {
      return NextResponse.json(
        { error: `opencode has no session '${sessionId}'`, code: 'NO_OPENCODE_SESSION' },
        { status: 409 }
      );
    }
    if (outcome.kind === 'refused') {
      // Reached with `share` unset or `manual`/`auto`, so this is not the
      // disabled case the gate above catches — the server declined for a reason
      // it did not name. 502: the failure is opencode's, not the caller's.
      logger.warn('opencode-share:refused', {
        worktreeId,
        instanceId,
        status: outcome.status,
      });
      return NextResponse.json(
        { error: 'opencode refused to share this session', code: 'SHARE_REFUSED' },
        { status: 502 }
      );
    }
    logger.warn('opencode-share:failed', { worktreeId, instanceId, reason: outcome.reason });
    return NextResponse.json(
      { error: 'Failed to reach opencode to share this session' },
      { status: 502 }
    );
  } catch (error: unknown) {
    logger.error('opencode-share:post-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to share opencode session' }, { status: 500 });
  }
}

/**
 * Take the published page down.
 *
 * No config gate: revoking is the safe direction, and a server with sharing
 * disabled can still be holding a page published before it was disabled.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const worktreeId = canonicalWorktreeId(requestedWorktreeId);

    const missing = requireWorktree(worktreeId);
    if (missing) return missing;

    const resolved = readInstanceId(
      worktreeId,
      request.nextUrl.searchParams.get('instance') ?? undefined
    );
    if ('error' in resolved) return resolved.error;

    const { instanceId, port, sessionId } = await resolveTarget(
      worktreeId,
      resolved.instanceId
    );
    if (port === null) {
      return NextResponse.json(
        { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
        { status: 409 }
      );
    }
    if (sessionId === null) {
      return NextResponse.json(
        { error: 'No opencode session to unshare', code: 'NO_OPENCODE_SESSION' },
        { status: 409 }
      );
    }

    const removed = await unshareOpencodeSession(port, sessionId);
    if (!removed) {
      return NextResponse.json(
        { error: 'opencode refused to unshare this session' },
        { status: 502 }
      );
    }
    logger.info('opencode-share:removed', { worktreeId, instanceId, sessionId });
    // No `lastShareUrl` in the answer even though opencode still reports one:
    // echoing it back is how a UI ends up showing a revoked page as live.
    return NextResponse.json({ sessionId, removed: true }, { status: 200 });
  } catch (error: unknown) {
    logger.error('opencode-share:delete-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to unshare opencode session' }, { status: 500 });
  }
}
