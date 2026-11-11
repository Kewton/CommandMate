/**
 * The reader of "the update before the end was confirmed" (Issue #4227 G-PR3, S-C; design
 * `docs/design/mem-ui-4227.md` §0.0b S-C・§4.6). D2 (#4224) asks it when a new process
 * boundary opens (`previousEndLead`'s X4): `recorded` only when the conversation that just
 * ended closed through the hand-off with every condition of §0.1 G5 (`confirmed`).
 *
 * Read only: no write, no side effect, nothing but the hand-off's request table and D1's
 * boundary ledger. Anything it cannot tell is `not_recorded` (the next generation is then
 * told "cannot be confirmed" — the safe side).
 *
 * @module lib/handoff/pre-end
 */

import type Database from 'better-sqlite3';
import { getWorktreeIncarnation } from '@/lib/mem/incarnation';

/** What D2's X4 reads (the answer of `readPreEndUpdate`). */
export type PreEndUpdate = 'recorded' | 'not_recorded';

interface EndedRequestRow {
  boundary_id: string;
  target_worktree_incarnation: string;
  outcome: string | null;
}

/**
 * `recorded` when the newest `ended` request of this (worktree, instance) that ended before
 * `before` (epoch ms, the new boundary's opening) is `confirmed`, belongs to the worktree's
 * current lifetime, and was made in the conversation right before the new boundary (its
 * pinned boundary is the newest row opened before `before`). Otherwise — none, `unconfirmed`,
 * an earlier generation's, a request still `ending` or `expired`, a read that throws —
 * `not_recorded`.
 */
export function readHandoffPreEndUpdate(
  db: Database.Database,
  query: { worktreeId: string; instanceId: string; before: number }
): PreEndUpdate {
  try {
    const { worktreeId, instanceId, before } = query;
    const ended = db
      .prepare(
        `SELECT boundary_id, target_worktree_incarnation, outcome FROM mem_handoff_requests
         WHERE target_worktree_id = ? AND instance_id = ? AND state = 'ended' AND ended_at IS NOT NULL AND ended_at < ?
         ORDER BY ended_at DESC, rowid DESC LIMIT 1`
      )
      .get(worktreeId, instanceId, before) as EndedRequestRow | undefined;
    if (!ended || ended.outcome !== 'confirmed') return 'not_recorded';
    if (getWorktreeIncarnation(db, worktreeId) !== ended.target_worktree_incarnation) return 'not_recorded';
    const previous = db
      .prepare(
        `SELECT id FROM session_brief_boundaries
         WHERE worktree_id = ? AND instance_id = ? AND opened_at < ?
         ORDER BY seq DESC LIMIT 1`
      )
      .get(worktreeId, instanceId, before) as { id: string } | undefined;
    return previous?.id === ended.boundary_id ? 'recorded' : 'not_recorded';
  } catch {
    return 'not_recorded';
  }
}
