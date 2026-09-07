/**
 * Putting the operator's own input into conversation history (Issue #2196).
 *
 * ## The gap this closes
 *
 * `chat_messages` has had exactly one producer of `role: 'user'` rows —
 * `sendUserMessage`, which `/send` and the Timer go through. Everything else the
 * operator can type reaches the agent without passing that function: `tmux
 * attach` and a keyboard, `UnsentComposerBar`'s Run (which sends Enter through
 * `/special-keys` and nothing else), a script calling `tmux send-keys`. The
 * agent answers all of them, the poller saves the answer, and
 * `groupMessagesIntoPairs` has a reply with no prompt in front of it — the
 * `orphan` pair. That is not a rendering problem: History genuinely does not
 * know what was asked.
 *
 * The agents do know, because each of them keeps its own record of the
 * conversation. This module is the half of the fix that is the same whatever
 * that record looks like: given "instance X was prompted with this text at this
 * moment, and here is a stable name for that prompt", make History hold exactly
 * one user row for it. `lib/hooks/sources/claude/history` supplies those four
 * things from Claude's transcript JSONL; #2197 and #2198 will supply them from
 * codex's and antigravity's own records. Nothing below mentions a tool.
 *
 * ## Three outcomes, and why the middle one exists
 *
 * 1. **The key is already on a row** — nothing happens. The callers are pollers,
 *    so being asked to record the same prompt again is the normal case rather
 *    than an error.
 * 1b. **A RELAY delivery's row already holds this text** (Issue #2392) — the
 *    same answer, reached without the key. A relay hands session A the reply
 *    session B wrote by sending it into A's composer, and the row it writes
 *    carries `relay:<ledgerId>` so that the ledger can be read back out of it
 *    (#2387). Being keyed is exactly what put it beyond outcome 2's claim, so
 *    until this Issue every delivery left the operator reading the reply twice.
 *    The row is recognised here but deliberately **not** claimed: nothing is
 *    written, its key stays `relay:<ledgerId>`, and the caller is told
 *    `already-recorded` with that row's id — because re-pointing it at a
 *    transcript key would take the loop guard's only route back to the ledger
 *    away with it.
 * 2. **An unkeyed row already holds this text** — that row is *claimed*, not
 *    duplicated. This is the `/send` case, and it is the whole reason the
 *    recorder is not simply an insert: `sendUserMessage` wrote the operator's
 *    message the instant it was sent, and the agent then recorded the same text
 *    in its own log a moment later. Two records of one keystroke. Inserting
 *    would show the operator their own message twice, which is a worse defect
 *    than the orphan pair this Issue set out to remove — so the pre-existing row
 *    wins and merely gains the key, and every later call recognises it through
 *    outcome 1.
 * 3. **Neither** — insert, and broadcast so an open History pane sees it without
 *    a reload.
 *
 * ## Nothing here throws
 *
 * The same contract as the transcript readers that call it, for a sharper
 * reason: this runs inside the poller's save path, immediately before the
 * *assistant* row is written. An exception escaping would cost the reply as
 * well as the prompt, so a failure to record the prompt is reported in the
 * return value and in the log, and the caller carries on.
 *
 * The database imports are dynamic, so that `better-sqlite3` does not enter the
 * module graph of everything that imports `@/lib/hooks/sources`.
 *
 * @module lib/history/user-turn-recorder
 */

import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const logger = createLogger('lib/history/user-turn-recorder');

/**
 * How far from the agent's own clock a `/send` row may sit and still be the
 * same keystroke.
 *
 * Two minutes, and it is a tolerance rather than a guess at a latency. The two
 * timestamps being compared are written by different clocks for different
 * events: `sendUserMessage` stamps the row when CommandMate hands the text to
 * the pane, and the agent stamps its own record when it accepts the prompt.
 * Between them sit the composer, a `waitForPrompt`, a folder-trust dialog, a
 * queued prompt waiting for the previous turn to finish, and — for a prompt
 * typed while the agent was busy — however long that turn took to end.
 *
 * Erring wide is the cheap direction. Too wide costs a mis-adoption only if the
 * *same instance* was sent the *byte-identical* text twice inside four minutes,
 * in which case the two rows are interchangeable anyway. Too narrow costs a
 * duplicate row on every `/send` the agent was slow to accept, which is visible
 * to the operator on every single turn.
 */
export const USER_TURN_ADOPTION_WINDOW_MS = 120_000;

/** What {@link recordUserTurn} did. */
export type UserTurnOutcome =
  /**
   * This prompt is already in History; nothing was written.
   *
   * Either the key is on a row, or — Issue #2392 — a relay delivery's own row
   * holds this text and keeps its own key. Callers treat the two the same: the
   * prompt is on record and `messageId` names the row it is on.
   */
  | 'already-recorded'
  /** An unkeyed row held this text and was claimed for the key. */
  | 'adopted'
  /** A new row was written and broadcast. */
  | 'inserted'
  /** There was nothing to record — no key, or no text once normalised. */
  | 'skipped'
  /** The database could not be reached or refused the write. */
  | 'failed';

/**
 * How far back a `/send` row may sit and still be this prompt's (Issue #2246).
 *
 * {@link USER_TURN_ADOPTION_WINDOW_MS} is symmetric around the agent's clock and
 * that is right for the ordinary case, where the transcript is read within
 * seconds of the turn ending. Reading a turn the poller *missed* breaks the
 * assumption the symmetry rests on: the row being adopted was written when
 * CommandMate handed the text to the pane, and the turn that answers it may have
 * been accepted long after — a queued prompt waits for the previous turn to
 * finish, and the measured incident behind this Issue had eleven minutes between
 * the two.
 *
 * The bound the caller supplies instead is the **previous turn's own start**,
 * which is the tightest honest one: a `/send` row for turn N cannot have been
 * written before turn N-1 opened, because it had not been sent yet. Only the
 * lower bound moves, and only outwards — see {@link recordUserTurn}, which takes
 * the wider of this and the standard window so that a caller can never *narrow*
 * adoption by supplying one.
 */
export interface RecordUserTurnOptions {
  /**
   * Earliest `timestamp`, as epoch ms, a row may carry and still be adopted.
   *
   * Ignored when it is later than the standard window's lower edge.
   */
  readonly adoptionFromMs?: number;
}

/** The result of one {@link recordUserTurn} call. */
export interface RecordedUserTurn {
  readonly outcome: UserTurnOutcome;
  /** The row the key now names, when there is one. */
  readonly messageId: string | null;
  /**
   * The `timestamp` on that row, as epoch ms.
   *
   * The caller needs it to keep the turn in order: the assistant row it writes
   * next must sort *after* this one, and `groupMessagesIntoPairs` orders by
   * timestamp and nothing else, so an equal pair of timestamps is an ordering
   * that depends on which row the database happens to return first.
   */
  readonly timestampMs: number | null;
}

/**
 * The form two pieces of text are compared in.
 *
 * Trailing whitespace per line, `\r\n`, and blank lines at either end are the
 * three differences that a round trip through a TUI composer actually
 * introduces, so they are the three this ignores. Nothing else is touched — in
 * particular interior blank lines are significant, because a prompt whose
 * paragraph breaks were collapsed is not the same prompt.
 */
export function normalizeUserTurnContent(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t　]+$/u, ''))
    .join('\n')
    .trim();
}

/** How far the recorder's log calls identify the instance. */
function describe(target: AgentInstanceRef): Record<string, string> {
  return {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: target.instanceId ?? target.cliToolId,
  };
}

/**
 * Make History hold exactly one `user` row for one prompt.
 *
 * Never throws.
 *
 * @param target - The instance that was prompted
 * @param key - A stable name for this prompt, unique per (worktree, prompt).
 *   Written to `chat_messages.request_id`, which is what makes a second call
 *   with the same key a no-op. Callers derive it from the agent's own id for the
 *   prompt — see `claudePromptRequestId` — so that it survives a restart, a
 *   re-read of the log and a `/clear`.
 * @param content - The prompt, as the agent recorded it
 * @param timestampMs - When the agent says it was prompted, epoch ms
 * @param options - See {@link RecordUserTurnOptions}; the defaults are #2196's
 */
export async function recordUserTurn(
  target: AgentInstanceRef,
  key: string,
  content: string,
  timestampMs: number,
  options: RecordUserTurnOptions = {}
): Promise<RecordedUserTurn> {
  const instanceId = target.instanceId ?? target.cliToolId;
  const normalized = normalizeUserTurnContent(content);

  if (key.length === 0 || normalized.length === 0) {
    return { outcome: 'skipped', messageId: null, timestampMs: null };
  }

  try {
    const [{ getDbInstance }, chatDb, { broadcastMessage }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db/chat-db'),
      import('@/lib/ws-server'),
    ]);

    const db = getDbInstance();

    const existing = chatDb.findMessageByRequestId(db, target.worktreeId, key);
    if (existing) {
      return {
        outcome: 'already-recorded',
        messageId: existing.id,
        timestampMs: existing.timestamp.getTime(),
      };
    }

    const at = timestampMs > 0 ? timestampMs : Date.now();
    const adopted = adoptExistingRow(chatDb, db, target, instanceId, key, normalized, at, options);
    if (adopted) return adopted;

    const message = chatDb.createMessage(db, {
      worktreeId: target.worktreeId,
      role: 'user',
      content,
      messageType: 'normal',
      timestamp: new Date(at),
      cliToolId: target.cliToolId,
      instanceId,
      requestId: key,
    });

    broadcastMessage('message', { worktreeId: target.worktreeId, message });
    logger.info('user-turn-recorded', {
      ...describe(target),
      requestId: key,
      contentLength: content.length,
    });
    return { outcome: 'inserted', messageId: message.id, timestampMs: at };
  } catch (error) {
    logger.error('user-turn-record-failed', {
      ...describe(target),
      requestId: key,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: 'failed', messageId: null, timestampMs: null };
  }
}

/** The database surface {@link recordUserTurn} uses; narrowed for readability. */
type ChatDbModule = typeof import('@/lib/db/chat-db');

/** The handle `chat-db` takes, without naming `better-sqlite3` statically. */
type ChatDbHandle = Parameters<ChatDbModule['findUnkeyedUserMessages']>[0];

/** One `chat_messages` row, in the shape `chat-db` hands it back. */
type ChatDbUserRow = ReturnType<ChatDbModule['findUnkeyedUserMessages']>[number];

/**
 * Recognise the row this prompt is already on, if there is one.
 *
 * One window, two kinds of row in it, and what may be done with them differs:
 *
 * 1. the `/send` row, which carries no key and is **claimed** — this is #2196's
 *    case and the reason the recorder is not simply an insert;
 * 2. a relay delivery's row, which carries `relay:<ledgerId>` and is **left
 *    exactly as it is** — Issue #2392. `includeRelayDelivered` is what puts it
 *    in the answer at all, and `requestId` is what tells the two apart.
 *
 * The claim is tried across every unkeyed candidate first, so the presence of a
 * delivery cannot cost an orphan row its key. It can lose —
 * `setMessageRequestId` refuses a row that acquired a key between the read and
 * the write. Losing means some other producer got there first, so the next
 * candidate is tried and, if none is left, the delivery is considered and then
 * the caller falls through to the insert. It cannot loop: each attempt either
 * claims a row or removes it from contention.
 *
 * @returns The row this prompt is on, or null when nothing here is this prompt's
 */
function adoptExistingRow(
  chatDb: ChatDbModule,
  db: ChatDbHandle,
  target: AgentInstanceRef,
  instanceId: string,
  key: string,
  normalized: string,
  at: number,
  options: RecordUserTurnOptions
): RecordedUserTurn | null {
  // `Math.min` and not a replacement: {@link RecordUserTurnOptions} may widen
  // the search backwards and may never narrow it, so a caller that supplies a
  // bound *inside* the standard window changes nothing.
  const fromMs = Math.min(
    at - USER_TURN_ADOPTION_WINDOW_MS,
    options.adoptionFromMs ?? Number.POSITIVE_INFINITY
  );

  const candidates = sameText(
    chatDb.findUnkeyedUserMessages(db, {
      worktreeId: target.worktreeId,
      cliToolId: target.cliToolId,
      instanceId,
      fromMs,
      toMs: at + USER_TURN_ADOPTION_WINDOW_MS,
      // Issue #2392. Without this the relay delivery's row is not in the answer
      // at all, and the prompt it holds is inserted a second time.
      includeRelayDelivered: true,
    }),
    normalized,
    at
  );

  for (const candidate of candidates) {
    // A relay delivery, kept for the pass below: claiming it would overwrite the
    // `relay:<ledgerId>` the loop guard reads the ledger back out of.
    if (candidate.requestId) continue;
    if (!chatDb.setMessageRequestId(db, candidate.id, key)) continue;
    logger.info('user-turn-adopted', {
      ...describe(target),
      requestId: key,
      messageId: candidate.id,
      driftMs: candidate.timestamp.getTime() - at,
    });
    return {
      outcome: 'adopted',
      messageId: candidate.id,
      timestampMs: candidate.timestamp.getTime(),
    };
  }

  // Issue #2392. Nothing is written here and that is the whole point: the row
  // already says what this prompt says, and its `request_id` is the loop guard's
  // only way back to the ledger entry that produced it (`findParentRelayHops`,
  // #2387). So the prompt is reported as recorded on the row that holds it, and
  // the insert below is not reached. `setMessageRequestId` would refuse the
  // write anyway — it is a compare-and-set on `request_id IS NULL` — but the
  // branch above says so explicitly rather than leaning on that.
  //
  // No direction test on the timestamp, unlike #2387's `isEchoOfRelayRow`: that
  // one is deciding whether a row it can already see is an echo, while this is
  // deciding whether to write a row at all, and a transcript whose clock rounds
  // a prompt to a whole second would land just *before* the delivery and bring
  // the duplicate straight back. The symmetric window is safe here because the
  // text being matched is a relay body — `buildRelayReplyMessage`'s framing, not
  // anything an operator types.
  const delivered = candidates.find((candidate) => candidate.requestId);
  if (delivered) {
    logger.info('user-turn-already-relayed', {
      ...describe(target),
      requestId: key,
      messageId: delivered.id,
      relayRequestId: delivered.requestId ?? null,
      driftMs: delivered.timestamp.getTime() - at,
    });
    return {
      outcome: 'already-recorded',
      messageId: delivered.id,
      timestampMs: delivered.timestamp.getTime(),
    };
  }

  return null;
}

/**
 * The rows here that hold this prompt's text, nearest the agent's clock first.
 *
 * Content is compared normalised, because that is the only comparison
 * `chat_messages` cannot make for itself (see `findUnkeyedUserMessages`). The
 * ordering only matters when the same text sits on two rows inside the window,
 * and nearest-in-time is the right tie-break then too.
 */
function sameText(rows: ChatDbUserRow[], normalized: string, at: number): ChatDbUserRow[] {
  return rows
    .filter((row) => normalizeUserTurnContent(row.content) === normalized)
    .sort((a, b) => Math.abs(a.timestamp.getTime() - at) - Math.abs(b.timestamp.getTime() - at));
}
