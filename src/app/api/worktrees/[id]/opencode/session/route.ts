/**
 * API Route: /api/worktrees/:id/opencode/session (Issue #2038)
 *
 * The opencode-only session operations: what session each instance is in
 * (`GET`), and the three the operator can perform on it (`POST`) — start a new
 * one, open opencode's own session list, fork the current one.
 *
 * ## Why this is not part of `current-output`
 *
 * `current-output` answers "what is this instance doing", for every tool, on a
 * poll. These are opencode-specific facts and opencode-specific side effects,
 * and three of the four are `POST`s into the agent's own HTTP server. Folding
 * them into a polled endpoint would make every worktree's status poll carry a
 * tool-specific request that only one tool can answer.
 *
 * ## Why there is no "list this instance's sessions" here
 *
 * Measured on opencode 1.18.22: `GET /session` on a server started in directory
 * A returns directory B's sessions as well — sessions belong to opencode's own
 * database, not to a server, and both came back under `projectID: "global"`.
 * That is #1758 §5.6.3 re-measured. So the session list CommandMate offers is
 * the TUI's own picker (`POST /tui/open-sessions`), which opencode scopes for
 * itself, rather than a list this route would have to guess the scope of.
 *
 * A `true` from any of the `/tui/*` endpoints means "accepted onto the TUI
 * control channel" and not "the dialog is on screen" — a headless server with no
 * TUI at all answers `true` — so the response field is named `accepted`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getAgentInstances, getWorktreeById } from '@/lib/db';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { createLogger } from '@/lib/logger';
import { OPENCODE_CLI_TOOL_ID } from '@/lib/hooks/sources/opencode/tool-id';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import {
  OPENCODE_TUI_NEW_SESSION_COMMAND,
  executeOpencodeTuiCommand,
  fetchOpencodeSession,
  forkOpencodeSession,
  openOpencodeSessionPicker,
  selectOpencodeSession,
} from '@/lib/session/opencode-session-api';
import { resolveOpencodeCurrentSessionId } from '@/lib/session/opencode-session-recall';
import {
  forgetOpencodeSession,
  getRememberedOpencodeSession,
  rememberOpencodeSession,
} from '@/lib/session/opencode-session-store';

const logger = createLogger('api/opencode-session');

/** The actions `POST` accepts. */
const OPENCODE_SESSION_ACTIONS = ['new', 'list', 'fork'] as const;
type OpencodeSessionAction = (typeof OPENCODE_SESSION_ACTIONS)[number];

function isAction(value: unknown): value is OpencodeSessionAction {
  return (
    typeof value === 'string' &&
    (OPENCODE_SESSION_ACTIONS as readonly string[]).includes(value)
  );
}

function opencodeRef(worktreeId: string, instanceId: string): AgentInstanceRef {
  return {
    worktreeId,
    cliToolId: OPENCODE_CLI_TOOL_ID,
    // The primary instance is addressed with no id at all, exactly as every
    // other opencode caller does (`opencodeTarget`), so the composite key this
    // resolves to is the same one the launcher and the ports file use.
    instanceId: instanceId === OPENCODE_CLI_TOOL_ID ? undefined : instanceId,
  };
}

/**
 * Every opencode instance this worktree has.
 *
 * The roster plus the primary id, because an untouched worktree has no roster
 * row for `opencode` and still runs a session under that name.
 */
function opencodeInstanceIds(worktreeId: string): string[] {
  const db = getDbInstance();
  const ids = new Set<string>([OPENCODE_CLI_TOOL_ID]);
  for (const instance of getAgentInstances(db, worktreeId)) {
    if (instance.cliTool === OPENCODE_CLI_TOOL_ID) ids.add(instance.id);
  }
  return [...ids];
}

/** One instance's session, as this route reports it. */
interface OpencodeInstanceSession {
  instanceId: string;
  sessionId: string | null;
  title: string | null;
  /** The directory opencode reported the session belongs to, or null. */
  worktreePath: string | null;
  updatedAt: number | null;
  /** Whether a port is assigned, i.e. whether the actions below can be sent. */
  live: boolean;
}

/**
 * What one instance is in, live answer preferred.
 *
 * The persisted memory is the fallback and the *only* answer for a stopped
 * instance — which is the interesting case, because that is the id the next
 * launch will resume.
 */
async function describeInstance(
  worktreeId: string,
  instanceId: string
): Promise<OpencodeInstanceSession> {
  const target = opencodeRef(worktreeId, instanceId);
  const remembered = getRememberedOpencodeSession(target);
  const port = getAssignedOpencodePort(target);

  if (port !== null) {
    const liveId = await resolveOpencodeCurrentSessionId(target);
    if (liveId !== null) {
      const info = await fetchOpencodeSession(port, liveId);
      return {
        instanceId,
        sessionId: liveId,
        title: info?.title ?? remembered?.title ?? null,
        worktreePath: info?.directory ?? remembered?.worktreePath ?? null,
        updatedAt: remembered?.updatedAt ?? null,
        live: true,
      };
    }
  }

  return {
    instanceId,
    sessionId: remembered?.sessionId ?? null,
    title: remembered?.title ?? null,
    worktreePath: remembered?.worktreePath ?? null,
    updatedAt: remembered?.updatedAt ?? null,
    live: port !== null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const worktreeId = canonicalWorktreeId(requestedWorktreeId);

    const worktree = getWorktreeById(getDbInstance(), worktreeId);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${worktreeId}' not found` }, { status: 404 });
    }

    const requested = request.nextUrl.searchParams.get('instance');
    if (requested !== null && !isValidInstanceId(requested)) {
      return NextResponse.json({ error: 'Invalid instance parameter' }, { status: 400 });
    }

    const ids = requested === null ? opencodeInstanceIds(worktreeId) : [requested];
    const instances = await Promise.all(ids.map((id) => describeInstance(worktreeId, id)));

    return NextResponse.json({ instances }, { status: 200 });
  } catch (error: unknown) {
    logger.error('opencode-session:get-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to read opencode sessions' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const worktreeId = canonicalWorktreeId(requestedWorktreeId);

    const worktree = getWorktreeById(getDbInstance(), worktreeId);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${worktreeId}' not found` }, { status: 404 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // An empty body is not an action; the validation below reports it.
    }

    if (!isAction(body.action)) {
      return NextResponse.json(
        { error: `action must be one of: ${OPENCODE_SESSION_ACTIONS.join(', ')}` },
        { status: 400 }
      );
    }
    const action = body.action;

    const instanceId =
      typeof body.instanceId === 'string' ? body.instanceId : OPENCODE_CLI_TOOL_ID;
    if (!isValidInstanceId(instanceId)) {
      return NextResponse.json({ error: 'Invalid instanceId' }, { status: 400 });
    }
    if (!opencodeInstanceIds(worktreeId).includes(instanceId)) {
      return NextResponse.json(
        { error: `Instance '${instanceId}' is not an opencode instance` },
        { status: 400 }
      );
    }

    const target = opencodeRef(worktreeId, instanceId);
    const port = getAssignedOpencodePort(target);
    if (port === null) {
      // No port means no server to talk to: the session is stopped, or it was
      // launched with `CM_AGENT_HOOKS_INJECT=0`. 409 rather than 404 — the
      // instance exists, it just cannot be asked right now.
      return NextResponse.json(
        { error: 'No opencode server is attached to this instance', code: 'NO_OPENCODE_PORT' },
        { status: 409 }
      );
    }

    if (action === 'list') {
      const accepted = await openOpencodeSessionPicker(port);
      logger.info('opencode-session:list', { worktreeId, instanceId, accepted });
      return NextResponse.json({ action, accepted }, { status: 200 });
    }

    if (action === 'new') {
      const accepted = await executeOpencodeTuiCommand(port, OPENCODE_TUI_NEW_SESSION_COMMAND);
      if (accepted) {
        // The operator asked to leave this conversation behind; resuming it on
        // the next launch would undo exactly that.
        forgetOpencodeSession(target);
      }
      logger.info('opencode-session:new', { worktreeId, instanceId, accepted });
      return NextResponse.json({ action, accepted }, { status: 200 });
    }

    const currentId = await resolveOpencodeCurrentSessionId(target);
    if (currentId === null) {
      return NextResponse.json(
        { error: 'No opencode session to fork yet', code: 'NO_OPENCODE_SESSION' },
        { status: 409 }
      );
    }

    const forked = await forkOpencodeSession(port, currentId);
    if (!forked) {
      return NextResponse.json({ error: 'Fork was refused by opencode' }, { status: 502 });
    }

    // The fork exists but the pane is still showing the original, so the
    // operator would see nothing happen. `select-session` is what moves it.
    const selected = await selectOpencodeSession(port, forked.id);
    if (forked.directory) {
      rememberOpencodeSession(target, {
        sessionId: forked.id,
        title: forked.title,
        worktreePath: forked.directory,
      });
    }

    logger.info('opencode-session:fork', {
      worktreeId,
      instanceId,
      from: currentId,
      to: forked.id,
      selected,
    });
    return NextResponse.json(
      {
        action,
        accepted: true,
        selected,
        session: { id: forked.id, title: forked.title },
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('opencode-session:post-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to perform opencode session action' }, { status: 500 });
  }
}
