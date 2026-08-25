/**
 * Learning which opencode session an instance is in, and writing it down before
 * the pane that knows dies (Issue #2038).
 *
 * `./opencode-session-store` persists the answer and `./opencode-session-api`
 * asks the server; this is the part that decides *what the answer is*, which is
 * the only genuinely difficult half.
 *
 * ## Why the id is not simply "the last sessionID CommandMate saw"
 *
 * One opencode server carries several sessions at once and every frame on the
 * stream is tagged with its own `sessionID` — a sub-agent spawned by the `task`
 * tool runs in a session of its own, and its frames arrive on the same
 * connection (#1758 §5.6.1, #1900). `getLastAgentEvent` therefore answers "the
 * last session anything happened in", which after a sub-agent's turn is the
 * sub-agent's. Resuming *that* on the next launch would drop the operator into
 * the middle of a delegated task rather than back into their conversation.
 *
 * `../hooks/sources/opencode/turn-gate` already computes the right answer — its
 * `primarySession()` — but it lives inside one SSE connection's state and is
 * gone the moment the stream closes, which is precisely when this value is
 * needed. So the parentage is re-established from the source that survives:
 * opencode's own `Session.parentID`, read back over HTTP while the server is
 * still up, and followed upwards to the session that has no parent.
 *
 * ## Why this runs at `killSession` rather than on every event
 *
 * Because it can only be *verified* while the server is alive, and `killSession`
 * is the last moment that is true before the launch that wants the answer. The
 * verification is what makes the entry trustworthy: `Session.directory` is
 * opencode's own statement of which worktree the conversation belongs to, and
 * comparing it against the port assignment's worktree is the guard the Issue
 * asks for ("`ports.ts` の worktreePath 照合と同じ守り"). An event-time write
 * could not do any of that — `recordAgentEvent` is synchronous, tool-agnostic,
 * and has no port.
 *
 * The cost is bounded and known: an instance that has completed no turn since
 * this CommandMate process started, and is then killed, records nothing new and
 * keeps whatever the previous kill recorded. That is a resume that is one
 * session stale, not a resume of the wrong worktree — the directory guard still
 * holds — and it is repaired by the next turn.
 *
 * @module lib/session/opencode-session-recall
 */

import { createLogger } from '@/lib/logger';
import {
  getAssignedOpencodePort,
  getAssignedOpencodeWorktreePath,
} from '@/lib/hooks/sources/opencode/ports';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import { getLastAgentEvent } from './agent-event-state';
import { fetchOpencodeSession, type OpencodeSessionInfo } from './opencode-session-api';
import {
  getRememberedOpencodeSession,
  isOpencodeSessionId,
  rememberOpencodeSession,
  type OpencodeSessionMemory,
} from './opencode-session-store';

const logger = createLogger('lib/session/opencode-session-recall');

/**
 * How far up a `parentID` chain to walk before giving up.
 *
 * opencode nests sub-agents, and a cycle would be a server bug rather than an
 * expected shape — but this loop runs inside `killSession`, which is inside the
 * HTTP request that is stopping a session, so it is bounded by a small number
 * rather than by trust. Three is two more hops than anything measured.
 */
export const MAX_OPENCODE_PARENT_HOPS = 3;

/**
 * Follow `parentID` until the session that has none.
 *
 * @param port - The instance's server port
 * @param sessionId - Where to start
 * @returns The root session, or null when a hop could not be read
 */
export async function resolveOpencodeRootSession(
  port: number,
  sessionId: string
): Promise<OpencodeSessionInfo | null> {
  const seen = new Set<string>();
  let current = await fetchOpencodeSession(port, sessionId);
  for (let hop = 0; hop < MAX_OPENCODE_PARENT_HOPS; hop += 1) {
    if (current === null) return null;
    if (current.parentId === null) return current;
    if (seen.has(current.parentId)) return current;
    seen.add(current.parentId);
    logger.debug('opencode-session-parent-hop', { from: current.id, to: current.parentId });
    current = await fetchOpencodeSession(port, current.parentId);
  }
  return current;
}

/** Why {@link captureOpencodeSessionMemory} did not write anything. */
export type OpencodeCaptureSkip =
  /** No port: structured events are off, or none was ever allocated. */
  | 'no-port'
  /** Nothing on this instance's stream ever named a session. */
  | 'no-session-observed'
  /** The server did not describe the session — it is gone, or so is the server. */
  | 'session-unreadable'
  /** opencode reported no `directory` for it. Should not happen; refused anyway. */
  | 'no-directory'
  /** The session belongs to a different worktree than this instance's pane. */
  | 'directory-mismatch'
  /** The store refused the id. */
  | 'not-persisted';

/** What one capture attempt did. */
export type OpencodeCaptureOutcome =
  | { captured: true; memory: OpencodeSessionMemory }
  | { captured: false; skipped: OpencodeCaptureSkip };

/**
 * Write down the session this instance is in, verified against its own server.
 *
 * Call while the pane is still alive — from `OpenCodeTool.killSession`, before
 * the event stream is released and before `/exit` is typed.
 *
 * @param target - The instance whose pane is about to go
 * @returns What was recorded, or why nothing was
 */
export async function captureOpencodeSessionMemory(
  target: AgentInstanceRef
): Promise<OpencodeCaptureOutcome> {
  const instanceId = target.instanceId ?? target.cliToolId;

  const port = getAssignedOpencodePort(target);
  if (port === null) return { captured: false, skipped: 'no-port' };

  const observed = getLastAgentEvent(target.worktreeId, 'opencode', target.instanceId)?.sessionId;
  if (!isOpencodeSessionId(observed)) {
    return { captured: false, skipped: 'no-session-observed' };
  }

  const root = await resolveOpencodeRootSession(port, observed);
  if (root === null) return { captured: false, skipped: 'session-unreadable' };
  if (root.directory === null) return { captured: false, skipped: 'no-directory' };

  // The port assignment is the record of "this instance's pane runs there"
  // (`ports.ts`), so this compares opencode's answer with CommandMate's rather
  // than CommandMate's with its own. Null only when the assignment has already
  // been released, in which case there is nothing to contradict.
  const expected = getAssignedOpencodeWorktreePath(target);
  if (expected !== null && expected !== root.directory) {
    logger.warn('opencode-session-capture-directory-mismatch', {
      worktreeId: target.worktreeId,
      instanceId,
      expected,
      reported: root.directory,
    });
    return { captured: false, skipped: 'directory-mismatch' };
  }

  const written = rememberOpencodeSession(target, {
    sessionId: root.id,
    title: root.title,
    worktreePath: root.directory,
  });
  if (!written) return { captured: false, skipped: 'not-persisted' };

  logger.info('opencode-session-captured', {
    worktreeId: target.worktreeId,
    instanceId,
    sessionId: root.id,
    viaParentOf: root.id === observed ? null : observed,
  });
  return {
    captured: true,
    memory: {
      sessionId: root.id,
      title: root.title,
      worktreePath: root.directory,
      updatedAt: Date.now(),
    },
  };
}

/**
 * The session an operator's action (fork, or a title to display) should act on.
 *
 * Prefers what the live stream has seen — resolved up to its root, so a fork
 * branches the conversation rather than a sub-agent — and falls back to what
 * was persisted when nothing has arrived yet in this process.
 *
 * @param target - The instance
 * @returns The session id, or null when nothing knows
 */
export async function resolveOpencodeCurrentSessionId(
  target: AgentInstanceRef
): Promise<string | null> {
  const port = getAssignedOpencodePort(target);
  const observed = getLastAgentEvent(target.worktreeId, 'opencode', target.instanceId)?.sessionId;

  if (port !== null && isOpencodeSessionId(observed)) {
    const root = await resolveOpencodeRootSession(port, observed);
    if (root !== null) return root.id;
  }

  return getRememberedOpencodeSession(target)?.sessionId ?? null;
}
