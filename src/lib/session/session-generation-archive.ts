/**
 * Retire the previous process's chat history when a new one takes its place
 * (Issue #2444).
 *
 * `chat_messages.archived` means "a previous session's history", and until this
 * module the only thing that ever wrote it was
 * `POST /api/worktrees/:id/kill-session`. That covers the one ending nobody
 * actually gets: a session killed *through CommandMate*. A tmux server that
 * went away, a CLI that was `/exit`ed back to its shell, a machine that
 * rebooted — none of those pass through that route, so the dead session's rows
 * stayed `archived = 0` and the chat surface kept showing them as the current
 * conversation. Worse, the route refuses to help afterwards: with no live
 * session left to kill it returns 404 *before* reaching the archive call, so
 * the rows could not be retired by hand either.
 *
 * ## Why the seam is "a new process starts", not "the old one died"
 *
 * Observing the death is the tempting place — `current-output-builder`'s
 * `!running` branch already knows — and it is the wrong one. `isRunning` is a
 * `has-session` probe with a timeout in front of it and a liquid status
 * verdict behind it; a single slow probe reads as `false` for a session that is
 * very much alive, and archiving there would throw away a live conversation.
 * "A new agent process is being created for this (worktree, instance)" is not a
 * judgement call: {@link beginAgentSession} is called on exactly that fact, on
 * every tool's creation path and on codex's / opencode's relaunch-into-the-same-pane
 * path (#2070), and deliberately NOT on opencode's live-reuse path, where the
 * process is the same process. The rows that belong to the process being
 * replaced are precisely the ones to retire.
 *
 * ## Why it is its own module
 *
 * `agent-session-lifecycle` is an in-memory fence and nothing else — no
 * database, no sockets — and every `src/lib/cli-tools/<tool>.ts` imports it.
 * Keeping the database and the WebSocket here means that graph does not change:
 * the lifecycle module calls one function, inside a `try`, and a failure to
 * archive is a logged warning rather than a session that refuses to start.
 *
 * ## Known limitation
 *
 * A transcript reader that INSERTs a *new* row for the previous session after
 * this has run writes it with `archived = 0`, so it lands in the new session's
 * history. Updates to rows that already exist are unaffected: no writer touches
 * `archived` on update. Measured as rare enough to leave alone — the readers
 * run behind the same `startSession` that triggers this — and it is recorded
 * here rather than guarded, because guarding it means a second notion of "which
 * generation is this row from" and that is the schema #168 rejected.
 *
 * @module lib/session/session-generation-archive
 */

import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import { deleteMessagesByInstance, recomputeLastUserMessage } from '@/lib/db/chat-db';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';
import type { AgentInstanceRef } from '@/lib/hooks/sources';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/session/session-generation-archive');

/**
 * The database this module archives through, or `null` when there is none to
 * archive through.
 *
 * `getDbInstance()` **creates** a database when the file is not there yet, and
 * that is the one thing this call must never do from here. Every production
 * caller arrives via an API route that has already opened the connection, so
 * the singleton is warm and this is a map lookup. A Vitest worker is the
 * opposite case: `beginAgentSession` is reached by a dozen suites that mock
 * tmux and never touch a database, and opening one for them would either
 * fabricate `<cwd>/data/cm.db` or — when the suite runs in a checkout that has
 * one — hand those fixtures the developer's real chat history to write into.
 *
 * So under Vitest the answer is "no database" unless a test hands one in
 * explicitly (see {@link archiveSupersededSessionMessages}'s `db` parameter) or
 * mocks `@/lib/db/db-instance` **and** clears `VITEST`, which is how the
 * integration test drives the production branch. Only `VITEST` is consulted,
 * never `NODE_ENV`: `vitest.config.ts` `define`s `process.env.NODE_ENV` to the
 * literal `'test'` at transform time, so a `NODE_ENV` check here would fold to
 * a constant and no test could ever reach the other branch.
 */
export function resolveSessionArchiveDatabase(): Database.Database | null {
  if (process.env.VITEST) return null;
  return getDbInstance();
}

/** What {@link archiveSupersededSessionMessages} did. */
export interface SessionArchiveResult {
  /** Rows moved from `archived = 0` to `archived = 1`. */
  archived: number;
  /** The instance the rows were archived for (`instanceId ?? cliToolId`). */
  instanceId: string;
}

/**
 * Archive the active chat rows of the process being replaced.
 *
 * Scoped to one `(worktreeId, instanceId)` pair, which is what makes a restart
 * of `codex` leave `codex-2`'s conversation alone — the two share a worktree and
 * a tool id and nothing else. Already-archived rows are not touched (the SQL
 * filters on `archived = 0`), so calling this twice is not two generations.
 *
 * Nothing happens when there was nothing to archive: no `recomputeLastUserMessage`
 * (the sidebar's value cannot have changed) and no frame on the wire (a client
 * asked to re-read identical history would just be paying for a round trip).
 * That is also what keeps a healthy-reuse `startSession` — the path that never
 * calls in here at all — indistinguishable from a first-ever launch.
 *
 * Throws whatever the database throws; the caller in `agent-session-lifecycle`
 * catches, because failing to retire old rows must not stop a session from
 * starting.
 *
 * @param target - The instance whose previous process is being replaced
 * @param db - The database to write through; defaults to
 *   {@link resolveSessionArchiveDatabase}
 * @returns The row count and the instance it was scoped to
 */
export function archiveSupersededSessionMessages(
  target: AgentInstanceRef,
  db: Database.Database | null = resolveSessionArchiveDatabase(),
): SessionArchiveResult {
  const instanceId = target.instanceId ?? target.cliToolId;
  if (!db) return { archived: 0, instanceId };

  const archived = deleteMessagesByInstance(db, target.worktreeId, instanceId);
  if (archived === 0) return { archived: 0, instanceId };

  // Same pairing `kill-session` uses: the sidebar's `last_user_message` is
  // derived from the *active* rows, so archiving without recomputing leaves it
  // quoting a conversation the surface no longer shows.
  recomputeLastUserMessage(db, target.worktreeId);

  logger.info('session-generation-archived', {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId,
    archived,
  });

  broadcastMessagesInvalidated(target.worktreeId, target.cliToolId, instanceId);

  return { archived, instanceId };
}

/**
 * Tell every open pane for this instance to re-read its history.
 *
 * A scope rather than a payload, for the reason `MESSAGES_INVALIDATED_EVENT_TYPE`
 * gives: an archive has no row to publish — `message` / `message_updated` can
 * only ever say what a row now *looks like* — so the settled state has to come
 * from the server. PC split panes and the phone both listen through
 * `useSplitMessages`, which matches on (worktreeId, cliToolId, instanceId) and
 * does not branch on `reason`.
 *
 * Detached, and the `ws-server` import is dynamic, for the same bargain
 * `broadcastRecordedRow` in `current-output-builder` strikes: this module sits
 * in the import graph of every `src/lib/cli-tools/<tool>.ts` (through
 * `agent-session-lifecycle`), and none of them should pull the WebSocket server
 * in just by starting a pane. The rows are already committed when this runs, so
 * a socket write that throws cannot turn a completed archive into a failure.
 */
function broadcastMessagesInvalidated(
  worktreeId: string,
  cliToolId: AgentInstanceRef['cliToolId'],
  instanceId: string,
): void {
  void import('@/lib/ws-server')
    .then(({ broadcastMessage }) => {
      broadcastMessage(MESSAGES_INVALIDATED_EVENT_TYPE, {
        worktreeId,
        cliToolId,
        instanceId,
        reason: 'session_generation',
      });
    })
    .catch((error: unknown) => {
      logger.warn('session-generation-invalidate-broadcast-failed', {
        worktreeId,
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
