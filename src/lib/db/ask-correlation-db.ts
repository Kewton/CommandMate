/**
 * The ask correlation ledger (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3・§4). Table `ask_correlations` (v72).
 *
 * Synchronous, short statements: the reservation and the send's outcome are two
 * separate writes with the input between them, and no transaction is held across
 * the input (§3.2).
 *
 * Terminal states (`matched`, `ambiguous`) are never overwritten (M6): every
 * update below that sets an attribution state is guarded by
 * `attribution_state = 'pending'`.
 *
 * @module lib/db/ask-correlation-db
 */

import type Database from 'better-sqlite3';
import type {
  AskAttributionReason,
  AskAttributionState,
  AskCorrelation,
  AskSendState,
} from '@/types/ask-correlation';

/** Rows older than this are pruned (§3.4 R1). */
export const ASK_CORRELATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Newest rows kept per worktree regardless of age (§3.4 R1). */
export const ASK_CORRELATION_MAX_ROWS_PER_WORKTREE = 500;

interface RawAskCorrelation {
  ask_id: string;
  worktree_id: string;
  instance_id: string;
  cli_tool_id: string;
  body_digest: string;
  send_state: AskSendState;
  sent_message_id: string | null;
  native_session_id: string | null;
  native_input_id: string | null;
  native_turn_key: string | null;
  assistant_message_ids: string;
  turn_open_at_send: number | null;
  notified: number;
  attribution_state: Exclude<AskAttributionState, 'unavailable'>;
  reason: AskAttributionReason | null;
  created_at: number;
  updated_at: number;
}

function parseIds(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function toRow(raw: RawAskCorrelation): AskCorrelation {
  return {
    askId: raw.ask_id,
    worktreeId: raw.worktree_id,
    instanceId: raw.instance_id,
    cliToolId: raw.cli_tool_id,
    bodyDigest: raw.body_digest,
    sendState: raw.send_state,
    sentMessageId: raw.sent_message_id,
    nativeSessionId: raw.native_session_id,
    nativeInputId: raw.native_input_id,
    nativeTurnKey: raw.native_turn_key,
    assistantMessageIds: parseIds(raw.assistant_message_ids),
    turnOpenAtSend: raw.turn_open_at_send === null ? null : raw.turn_open_at_send === 1,
    notified: raw.notified === 1,
    attributionState: raw.attribution_state,
    reason: raw.reason,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** The row for `askId`, or null. */
export function getAskCorrelation(db: Database.Database, askId: string): AskCorrelation | null {
  const raw = db.prepare('SELECT * FROM ask_correlations WHERE ask_id = ?').get(askId) as RawAskCorrelation | undefined;
  return raw ? toRow(raw) : null;
}

/** What {@link reserveAsk} answers (§4). */
export type ReserveAskResult =
  | { kind: 'reserved'; row: AskCorrelation }
  /** The same askId and the same body: nothing new is typed (§3.2). */
  | { kind: 'existing'; row: AskCorrelation }
  /** The same askId with another body: refused, nothing typed. */
  | { kind: 'conflict'; row: AskCorrelation };

/**
 * Reserve `askId` for one send, before anything is typed (§4).
 *
 * The INSERT is one statement (`OR IGNORE` on the primary key), so two requests
 * racing on one askId cannot both reserve it. Throws only on a database failure.
 */
export function reserveAsk(
  db: Database.Database,
  input: { askId: string; worktreeId: string; instanceId: string; cliToolId: string; bodyDigest: string; now?: number },
): ReserveAskResult {
  const now = input.now ?? Date.now();
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO ask_correlations
         (ask_id, worktree_id, instance_id, cli_tool_id, body_digest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.askId, input.worktreeId, input.instanceId, input.cliToolId, input.bodyDigest, now, now);
  const row = getAskCorrelation(db, input.askId);
  if (!row) throw new Error(`ask correlation ${input.askId} could not be read back`);
  if (inserted.changes === 1) return { kind: 'reserved', row };
  return row.bodyDigest === input.bodyDigest ? { kind: 'existing', row } : { kind: 'conflict', row };
}

/**
 * Prune the ledger (§3.4 R1): rows past {@link ASK_CORRELATION_RETENTION_MS},
 * and in `worktreeId` the rows beyond the newest
 * {@link ASK_CORRELATION_MAX_ROWS_PER_WORKTREE}. Outside the reservation's statement.
 */
export function pruneAskCorrelations(db: Database.Database, worktreeId: string, now = Date.now()): number {
  const aged = db.prepare('DELETE FROM ask_correlations WHERE created_at < ?').run(now - ASK_CORRELATION_RETENTION_MS).changes;
  const over = db
    .prepare(
      `DELETE FROM ask_correlations WHERE worktree_id = ? AND ask_id NOT IN (
         SELECT ask_id FROM ask_correlations WHERE worktree_id = ? ORDER BY created_at DESC, ask_id DESC LIMIT ?
       )`,
    )
    .run(worktreeId, worktreeId, ASK_CORRELATION_MAX_ROWS_PER_WORKTREE).changes;
  return aged + over;
}

/**
 * How the send ended (§4 `recordSendOutcome`), after the input. Only a row still
 * `reserved` takes it, so a re-POST cannot rewrite a settled send.
 */
export function recordAskSendOutcome(
  db: Database.Database,
  askId: string,
  outcome: { sendState: Exclude<AskSendState, 'reserved'>; sentMessageId?: string | null; turnOpenAtSend?: boolean | null },
  now = Date.now(),
): boolean {
  const turnOpen = outcome.turnOpenAtSend === undefined || outcome.turnOpenAtSend === null ? null : outcome.turnOpenAtSend ? 1 : 0;
  return (
    db
      .prepare(
        `UPDATE ask_correlations
            SET send_state = ?, sent_message_id = ?, turn_open_at_send = ?, updated_at = ?
          WHERE ask_id = ? AND send_state = 'reserved'`,
      )
      .run(outcome.sendState, outcome.sentMessageId ?? null, turnOpen, now, askId).changes === 1
  );
}

/**
 * The native input that carried the envelope, first sighting only (§4
 * `recordNativeAskInput`). A row that already names an input keeps it.
 */
export function recordAskNativeInput(
  db: Database.Database,
  askId: string,
  input: { nativeInputId: string; nativeSessionId: string | null },
  now = Date.now(),
): boolean {
  return (
    db
      .prepare(
        `UPDATE ask_correlations
            SET native_input_id = ?, native_session_id = ?, updated_at = ?
          WHERE ask_id = ? AND native_input_id IS NULL AND attribution_state = 'pending'`,
      )
      .run(input.nativeInputId, input.nativeSessionId, now, askId).changes === 1
  );
}

/**
 * Settle a pending row (§4 `bindCompletedTurn`). A terminal row is left as it
 * is and the answer is false (M6).
 */
export function settleAskAttribution(
  db: Database.Database,
  askId: string,
  settled: {
    state: Exclude<AskAttributionState, 'pending' | 'unavailable'>;
    reason: AskAttributionReason | null;
    nativeTurnKey?: string | null;
    assistantMessageIds?: readonly string[];
    /** The turn absorbed a background-task notice (§7 (a) ②). */
    notified?: boolean;
  },
  now = Date.now(),
): boolean {
  return (
    db
      .prepare(
        `UPDATE ask_correlations
            SET attribution_state = ?, reason = ?, native_turn_key = COALESCE(?, native_turn_key),
                assistant_message_ids = ?, notified = ?, updated_at = ?
          WHERE ask_id = ? AND attribution_state = 'pending'`,
      )
      .run(
        settled.state,
        settled.reason,
        settled.nativeTurnKey ?? null,
        JSON.stringify(settled.assistantMessageIds ?? []),
        settled.notified ? 1 : 0,
        now,
        askId,
      ).changes === 1
  );
}
