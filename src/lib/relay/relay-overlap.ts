/**
 * What a bound relay can PROVE about sharing a turn with another request
 * (Issue #3957).
 *
 * Two directions, judged from what the send recorded and what the worker's
 * history holds — never from the reply's own text:
 *
 *  - **later** — a turn was already open on the worker when this request's
 *    input began (`turn_open_at_send = 1`): the request may have been folded
 *    into somebody else's turn.
 *  - **earlier** — another input reached the same instance after this one
 *    began and before the reply: somebody else's request may have been folded
 *    into this one's turn.
 *
 * `earlier` is claimed only when it is proven. A user row's timestamp can be
 * nudged for display ordering, and a transcript reader writes a second copy of
 * this send's own prompt under another id (#2387), so a row counts only when
 * it is not this send's row, does not carry this send's text, and was INSERTED
 * before the reply row (SQLite's rowid order). Anything else in the window is
 * "cannot tell", which makes the result `unknown` rather than `none` — PR 3
 * makes the earlier side exact; PR 2 lets it miss rather than guess.
 *
 * @module lib/relay/relay-overlap
 */

import type Database from 'better-sqlite3';
import { ACTIVE_FILTER, getMessageById } from '@/lib/db/chat-db';
import type { RelayBinding } from '@/lib/db/relay-db';
import { normalizeUserTurnContent } from '@/lib/history/user-turn-recorder';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ChatMessage } from '@/types/models';
import type { RelayOverlap } from '@/lib/relay/types';

/** The worker whose history is read. */
export interface RelayOverlapWorker {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
}

/** The verdict, with the evidence it rests on (for the log and the system line). */
export interface RelayOverlapVerdict {
  overlap: RelayOverlap;
  basis: string;
}

interface WindowRow {
  id: string;
  content: string;
  seq: number;
}

/** Whether another input provably arrived between the boundary and the reply. */
function judgeEarlier(
  db: Database.Database,
  binding: RelayBinding,
  worker: RelayOverlapWorker,
  reply: ChatMessage
): 'proven' | 'ambiguous' | 'none' {
  const boundary = binding.relay.inputBoundaryAt;
  if (boundary === null) return 'ambiguous';

  const replySeq = db
    .prepare('SELECT rowid AS seq FROM chat_messages WHERE id = ?')
    .get(reply.id) as { seq: number } | undefined;
  if (!replySeq) return 'ambiguous';

  const rows = db
    .prepare(`
      SELECT id, content, rowid AS seq FROM chat_messages
      WHERE worktree_id = ? AND role = 'user' ${ACTIVE_FILTER}
        AND COALESCE(cli_tool_id, 'claude') = ?
        AND COALESCE(instance_id, cli_tool_id, 'claude') = ?
        AND timestamp >= ? AND timestamp < ?
    `)
    .all(worker.worktreeId, worker.cliToolId, worker.instanceId, boundary, reply.timestamp.getTime()) as WindowRow[];

  const own = binding.inputMessageId ? getMessageById(db, binding.inputMessageId) : null;
  const ownText = own ? normalizeUserTurnContent(own.content) : null;

  let ambiguous = false;
  for (const row of rows) {
    if (row.id === binding.inputMessageId) continue;
    // Without this send's own text, no other row can be told from its echo.
    if (ownText === null || normalizeUserTurnContent(row.content) === ownText) {
      ambiguous = true;
      continue;
    }
    // Stamped before the reply but written after it: the order is not proven.
    if (row.seq > replySeq.seq) {
      ambiguous = true;
      continue;
    }
    return 'proven';
  }
  return ambiguous ? 'ambiguous' : 'none';
}

/**
 * Judge one reply against the relay's recorded send.
 *
 * `none` only when `later` was ruled out by a valid observation and nothing in
 * the window could be another input; every other undecided case is `unknown`.
 */
export function judgeRelayOverlap(
  db: Database.Database,
  binding: RelayBinding,
  worker: RelayOverlapWorker,
  reply: ChatMessage
): RelayOverlapVerdict {
  const { relay } = binding;
  const later = relay.turnOpenAtSend === true;
  const laterRuledOut = relay.turnOpenAtSend === false && relay.obsState === 'valid';
  const earlier = judgeEarlier(db, binding, worker, reply);

  if (later && earlier === 'proven') return { overlap: 'both', basis: 'turn-open-at-send+foreign-input' };
  if (later) return { overlap: 'later', basis: 'turn-open-at-send' };
  if (earlier === 'proven') return { overlap: 'earlier', basis: 'foreign-input' };
  if (laterRuledOut && earlier === 'none') return { overlap: 'none', basis: 'no-open-turn+no-other-input' };
  return {
    overlap: 'unknown',
    basis: laterRuledOut ? 'other-input-unproven' : 'turn-state-unknown',
  };
}
