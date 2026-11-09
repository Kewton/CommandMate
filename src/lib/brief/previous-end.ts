/**
 * The line a brief starts its data with after an end nobody planned (Issue #4224, design
 * `docs/design/brief-injection-d2-4224.md` §7): "the update before the end cannot be
 * confirmed". Fixed words and a number only (Epic D1: no model), never a verdict
 * ("did not update", "forgot") — the elapsed time alone says nothing of that.
 *
 * Read-only SQL, read once before the conditions are evaluated (2nd review, X-f): a
 * condition's close overwrites `updated_at`, so it is read before that can happen.
 *
 * Who wrote an update is decided the way #4221 decides who may write (`ownedBy`): the
 * instance's incarnation, so the same-named primary of another worktree on the branch is
 * never "this instance" (2nd review ②). The earlier conversation is bounded by the
 * incarnation's `created_at` only when #4222 says it was issued `roster` (a new pair): a
 * `lazy` or pre-v67 one was not born then (`incarnation.ts`, `IncarnationIssuedBy`).
 *
 * @module lib/brief/previous-end
 */

import type Database from 'better-sqlite3';
import { getInstanceIncarnationRow } from '@/lib/mem/incarnation';
import type { BriefBoundaryKind } from '@/lib/session/brief-provider';

/** The kinds of boundary a process ended at (X2): reset and resume are conversation steps. */
export const PREVIOUS_END_KINDS: ReadonlySet<BriefBoundaryKind> = new Set<BriefBoundaryKind>(['launch', 'auto_restart']);

/** The longest the line can be (design §7.1), counted in the budget. */
export const PREVIOUS_END_LINE_MAX_BYTES = 128;

export interface PreviousEndFacts {
  /** A conversation of this instance before the boundary (X3 (a)). */
  hadConversation: boolean;
  /** Epoch ms of this instance's own last update (§7.3), or null when none is counted. */
  lastUpdateAt: number | null;
}

/** What the boundary of `before` (epoch ms) of this instance can tell. */
export function readPreviousEnd(
  db: Database.Database,
  query: { worktreeId: string; instanceId: string; before: number }
): PreviousEndFacts {
  const { worktreeId, instanceId, before } = query;
  const incarnation = getInstanceIncarnationRow(db, worktreeId, instanceId);
  const from = incarnation?.issuedBy === 'roster' ? incarnation.createdAt : Number.MIN_SAFE_INTEGER;
  const conversation = db
    .prepare(
      `SELECT 1 FROM chat_messages
       WHERE worktree_id = ? AND role = 'user' AND COALESCE(instance_id, cli_tool_id, 'claude') = ?
         AND timestamp < ? AND timestamp >= ? LIMIT 1`
    )
    .get(worktreeId, instanceId, before, from);
  let lastUpdateAt: number | null = null;
  if (incarnation) {
    const note = db
      .prepare(
        `SELECT MAX(updated_at) AS at FROM session_notes
         WHERE worktree_id = ? AND instance_id = ? AND updated_by = 'agent' AND mem_incarnation = ?`
      )
      .get(worktreeId, instanceId, incarnation.incarnation) as { at: number | null };
    const item = db
      .prepare(
        `SELECT MAX(updated_at) AS at FROM mem_items
         WHERE updated_by = 'agent' AND updated_by_instance = ? AND origin_incarnation = ?`
      )
      .get(instanceId, incarnation.incarnation) as { at: number | null };
    const times = [note.at, item.at].filter((at): at is number => typeof at === 'number' && at < before);
    lastUpdateAt = times.length > 0 ? Math.max(...times) : null;
  }
  return { hadConversation: conversation !== undefined || lastUpdateAt !== null, lastUpdateAt };
}

/**
 * Whether an earlier lifetime recorded its update before it ended (X4). G (#4227) and F
 * (#4226) are its writers; until they come nothing is recorded, so it is never confirmed.
 */
export function readPreEndUpdate(
  _db: Database.Database,
  _query: { worktreeId: string; instanceId: string; before: number }
): 'recorded' | 'not_recorded' {
  return 'not_recorded';
}

/** The line (design §7.1). `now` and `lastUpdateAt` in epoch ms. */
export function previousEndLine(lastUpdateAt: number | null, now: number): string {
  if (lastUpdateAt === null) return '終わる前の更新を確認できない（この instance の更新の記録なし）';
  const hours = Math.floor(Math.max(0, now - lastUpdateAt) / 3_600_000);
  return `終わる前の更新を確認できない（この instance の最終更新は ${hours < 1 ? '1 時間未満' : `${hours} 時間前`}）`;
}

export interface PreviousEndInput {
  mode: 'derived' | 'on';
  kind: BriefBoundaryKind;
  openedAt: number;
  now: number;
}

/**
 * The line when every condition of §7.2 holds, else null. `facts` were read before the
 * evaluation; `recorded` is {@link readPreEndUpdate}'s answer.
 */
export function previousEndLead(input: PreviousEndInput, facts: PreviousEndFacts, recorded: 'recorded' | 'not_recorded'): string | null {
  if (input.mode !== 'on') return null; // X1
  if (!PREVIOUS_END_KINDS.has(input.kind)) return null; // X2
  if (!facts.hadConversation) return null; // X3
  if (recorded === 'recorded') return null; // X4
  return previousEndLine(facts.lastUpdateAt, input.now);
}
