/**
 * Writing opencode's own words into conversation history (Issue #2041).
 *
 * The second writer of `chat_messages` for an agent turn. The first is
 * `lib/polling/response-checker`, which captures the pane and cleans it; this
 * one reads the text off the SSE stream CommandMate is already subscribed to,
 * and the two are mutually exclusive — the poller stands down on
 * `isOpencodeStructuredHistoryLive` (declared in `./subscription`, which owns
 * the liveness this module is downstream of).
 *
 * ## Why a second writer rather than a better cleaner
 *
 * `cleanOpenCodeResponse` has to undo a rendering. The pane is 200 columns, the
 * agent's paragraph is 967 characters (measured), and by the time the poller
 * sees it the text has been hard-wrapped, gutter-prefixed and — if the turn
 * outgrew the pane — had its head scrolled off. #1911 is three separate defects
 * from exactly that, and the Layer-2 accumulator that patches the third one is
 * documented as preferring "a possible duplicate over a guaranteed truncation".
 * None of those problems exist on the source text, so this path does not solve
 * them; it does not have them.
 *
 * ## Two ways in, one renderer
 *
 * - **Live.** `./subscription` hands every `message.updated` /
 *   `message.part.updated` frame to {@link recordOpencodeTranscriptFrame`}, and
 *   `session.idle` flushes with {@link flushOpencodeTurn}.
 * - **Backfill.** {@link backfillOpencodeHistory} reads
 *   `GET /session/:id/message` after a (re)connect. Necessary rather than
 *   belt-and-braces: a fresh subscription to `/event` replays **nothing**
 *   (measured — one `server.connected` and then silence), so every turn that
 *   ran while CommandMate was down is unreachable from the stream.
 *
 * Both build the same {@link OpencodeTurnAccumulator} and call the same
 * `renderOpencodeTurn`, and both derive the row's id with
 * `opencodeTurnRequestId`, so the second one to arrive finds the row already
 * there and does nothing.
 *
 * ## Nothing here throws
 *
 * Same contract as `./ingest`, for the same reason: a history row is a record
 * of a session that is still running, and failing to write it must cost the
 * record, never the session. The database imports are dynamic for the reason
 * `./ingest` documents — `../registry` statically imports `./source`, and
 * anything in that graph puts `better-sqlite3` into every import of
 * `@/lib/hooks/sources`.
 *
 * @module lib/hooks/sources/opencode/history
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import { createLogger } from '@/lib/logger';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import { isPlainObject, readStringField } from '../event-mapper';
import type { AgentInstanceRef } from '../types';
import { fetchOpencodeSessionMessages, type OpencodeFrame } from './client';
import {
  addOpencodePart,
  buildOpencodeTurnsFromMessages,
  claimOpencodeMessage,
  createOpencodeTurn,
  ownsOpencodeMessage,
  readOpencodePart,
  renderOpencodeTurn,
  type OpencodeRenderedTurn,
  type OpencodeTurnAccumulator,
} from './transcript';

const logger = createLogger('lib/hooks/sources/opencode/history');

/**
 * Cap on turns held in memory for one instance.
 *
 * A turn is dropped from the map the moment it is flushed, so this only bounds
 * turns that never ended — a session abandoned mid-reply, or one whose
 * `session.idle` was lost with the connection. Small on purpose: an unflushed
 * turn is recoverable from `GET /session/:id/message`, so forgetting one costs
 * a round trip and never the text.
 */
export const MAX_OPENCODE_OPEN_TURNS = 16;

/**
 * Cap on turns one backfill pass will write.
 *
 * The document comes off a server CommandMate did not start and a long-lived
 * session accumulates without bound. Bounded, newest first, and the overflow is
 * logged — the same treatment `MAX_RESYNCED_DECISIONS` gets, and for the same
 * reason.
 */
export const MAX_OPENCODE_BACKFILLED_TURNS = 50;

/** One instance's in-flight turns, by `ses_…`. */
type InstanceTurns = Map<string, OpencodeTurnAccumulator>;

declare global {
  // eslint-disable-next-line no-var
  var __opencodeTranscripts: Map<string, InstanceTurns> | undefined;
}

/**
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the subscription's bundle and the poller's bundle would
 * otherwise each get a private copy, and the turn accumulated by one would be
 * invisible to the other.
 */
const transcripts = (globalThis.__opencodeTranscripts ??= new Map<string, InstanceTurns>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/** The turns held for one instance, created on demand. */
function turnsFor(target: AgentInstanceRef): InstanceTurns {
  const key = keyOf(target);
  let turns = transcripts.get(key);
  if (!turns) {
    turns = new Map();
    transcripts.set(key, turns);
  }
  return turns;
}

/**
 * Drop the oldest turns until the map is within {@link MAX_OPENCODE_OPEN_TURNS}.
 *
 * Insertion order, so what goes is what has been open longest — which is the
 * one least likely to still be receiving parts.
 */
function boundOpenTurns(target: AgentInstanceRef, turns: InstanceTurns): void {
  while (turns.size > MAX_OPENCODE_OPEN_TURNS) {
    const oldest = turns.keys().next();
    if (oldest.done) break;
    turns.delete(oldest.value);
    logger.info('opencode-transcript-turn-evicted', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      sessionId: oldest.value,
      reason: 'max-open-turns',
    });
  }
}

/**
 * Take in one frame that may carry part of a reply.
 *
 * Two frame types matter and they arrive in this order:
 *
 *  - `message.updated` with `info.role === "assistant"` **opens** the turn. It
 *    is the only frame that names the `parentID` the turn is keyed on; a part
 *    carries its `messageID` but never its parent, so a part that arrives for a
 *    turn this has not opened has nowhere to go and is counted rather than
 *    guessed at. Measured on 1.18.22: the assistant `message.updated` precedes
 *    its first part by 3.5 s in turn 1 and 1.7 s in turn 2, so the ordering is
 *    not a race being relied on.
 *  - `message.part.updated` fills a slot. `message.part.delta` is deliberately
 *    **not** read — see `./transcript` for the measurement that decided it.
 *
 * A `message.updated` whose role is `user` is skipped: its text is the prompt,
 * which `send` has already written as the user half of the pair.
 *
 * Never throws.
 *
 * @param target - The instance the subscription belongs to
 * @param frame - `{ id, type, properties }`, straight off the stream
 * @param receivedAt - Epoch ms
 */
export function recordOpencodeTranscriptFrame(
  target: AgentInstanceRef,
  frame: OpencodeFrame,
  receivedAt: number
): void {
  try {
    const type = readStringField(frame, 'type');
    const properties = isPlainObject(frame.properties) ? frame.properties : {};
    const sessionId = readStringField(properties, 'sessionID');
    if (!sessionId) return;

    if (type === 'message.updated') {
      const info = isPlainObject(properties.info) ? properties.info : null;
      if (!info || info.role !== 'assistant') return;
      const userMessageId = readStringField(info, 'parentID');
      if (!userMessageId) return;

      const turns = turnsFor(target);
      const existing = turns.get(sessionId);
      // A second assistant message inside one turn keeps the open accumulator —
      // measured, the tool-calling turn produced two, and closing the first
      // here would split one reply across two rows.
      const turn =
        existing?.userMessageId === userMessageId
          ? existing
          : createOpencodeTurn(sessionId, userMessageId, receivedAt);
      if (turn !== existing) {
        // A new turn while the previous one is still open means its
        // `session.idle` never arrived — the stream dropped mid-turn, or the
        // flush lost a race with the next prompt. What was accumulated is
        // abandoned rather than merged into the wrong prompt's reply; the
        // backfill is what recovers it.
        if (existing) {
          logger.info('opencode-transcript-turn-superseded', {
            worktreeId: target.worktreeId,
            instanceId: target.instanceId ?? target.cliToolId,
            sessionId,
            abandoned: existing.userMessageId,
          });
        }
        turns.set(sessionId, turn);
        boundOpenTurns(target, turns);
      }
      const messageId = readStringField(info, 'id');
      if (messageId) claimOpencodeMessage(turn, messageId);
      return;
    }

    if (type !== 'message.part.updated') return;

    const part = readOpencodePart(properties.part);
    if (!part) return;

    const turn = turnsFor(target).get(sessionId);
    // The ownership check is the one that keeps the operator's own prompt out of
    // the reply that answers it: the user's text part travels on this same
    // stream, and nothing but `assistantMessageIds` distinguishes it from the
    // agent's. Measured, it arrives before the turn is even open — but this way
    // the outcome does not depend on that staying true.
    if (!turn || !ownsOpencodeMessage(turn, part.messageId)) {
      // The stream opened mid-turn, or the part belongs to the user's own
      // message (whose `message.updated` this deliberately ignores). Either way
      // the backfill is what recovers it.
      logger.debug('opencode-transcript-part-unattached', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        sessionId,
        partType: part.type,
        reason: turn ? 'foreign-message' : 'no-open-turn',
      });
      return;
    }
    if (!addOpencodePart(turn, part)) {
      logger.warn('opencode-transcript-turn-overflow', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        sessionId,
        partType: part.type,
      });
    }

    // Issue #2199: the chat surface's live body. Fire-and-forget — this function
    // is on the SSE reader's hot path and its contract is that a frame is
    // accounted for by the time it returns; awaiting a broadcast would make the
    // accumulator's correctness depend on a WebSocket.
    void publishOpencodeTurnProgress(target, turn);
  } catch (error) {
    logger.error('opencode-transcript-record-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Push the open turn's body to the chat surface (Issue #2199).
 *
 * The push half of the same fact `flushOpencodeTurn` eventually writes, and
 * deliberately built from the SAME accumulator through the SAME
 * `renderOpencodeTurn`: a live body rendered by a second, "cheaper" path would
 * differ from the row that replaces it, and the replacement would read as the
 * reply changing its mind at the moment it finished.
 *
 * `opencodeTurnRequestId(turn.userMessageId)` is the key on both sides, so the
 * client's swap is a string comparison and needs no notion of ordering. Which is
 * what makes the re-sent boundary frames harmless twice over: the accumulator
 * overwrites a repeat into the same `prt_…` slot (see `./transcript`), so the
 * rendered body is byte-identical and the shared builder's no-change rule drops
 * it before it reaches the wire.
 *
 * The import is dynamic for the reason every database import in this file is:
 * `current-output-builder` statically imports `@/lib/db`, and a static import
 * here would put `better-sqlite3` into the graph of everything that imports
 * `@/lib/hooks/sources`.
 *
 * Never throws.
 */
async function publishOpencodeTurnProgress(
  target: AgentInstanceRef,
  turn: OpencodeTurnAccumulator
): Promise<void> {
  try {
    const { emitChatTurnProgress } = await import('@/lib/session/current-output-builder');
    await emitChatTurnProgress(
      {
        worktreeId: target.worktreeId,
        cliToolId: target.cliToolId,
        instanceId: target.instanceId ?? target.cliToolId,
      },
      () => {
        const rendered = renderOpencodeTurn(turn);
        if (rendered.body.length === 0) return null;
        return {
          turnKey: opencodeTurnRequestId(rendered.userMessageId),
          body: rendered.body,
          // The stream carries the turn from its first part, so nothing is ever
          // missing from the head. The only cut this body can take is the
          // shared builder's size bound, which reports itself.
          partial: false,
        };
      }
    );
  } catch (error) {
    logger.debug('opencode-transcript-progress-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The turn currently open on this session, for tests and for callers that need
 * to know whether a flush would do anything.
 */
export function peekOpencodeTurn(
  target: AgentInstanceRef,
  sessionId: string
): OpencodeTurnAccumulator | null {
  return transcripts.get(keyOf(target))?.get(sessionId) ?? null;
}

/**
 * Close the turn on this session and write it.
 *
 * Called from `session.idle`, which is where opencode says a turn is over — the
 * same frame `./turn-gate` publishes as `stop`. Deliberately *not* gated on the
 * gate's verdict: the gate suppresses the **second** `session.idle` of an abort
 * (19-23 ms after the first, #1758 §5.3.2) so a `wait` is not resolved twice,
 * and a suppressed repeat here is a no-op anyway because the accumulator has
 * already been taken. Reading the frame keeps the two decisions independent, the
 * same way `watchOpencodeSessionIdle` does (#2034).
 *
 * Never throws.
 *
 * @param target - The instance
 * @param sessionId - `ses_…` from the `session.idle` frame
 * @returns Whether a row was written
 */
export async function flushOpencodeTurn(
  target: AgentInstanceRef,
  sessionId: string
): Promise<boolean> {
  const turns = transcripts.get(keyOf(target));
  const turn = turns?.get(sessionId);
  if (!turn || !turns) return false;
  // Taken before the await: a second `session.idle` for the same session must
  // not find the accumulator still there and race a duplicate insert past the
  // existence check below.
  turns.delete(sessionId);

  return writeOpencodeTurn(target, renderOpencodeTurn(turn), turn.startedAt, 'stream');
}

/**
 * Forget everything held for one instance.
 *
 * Called when the subscription closes, on the same terms as
 * `forgetAgentSessionTelemetry` (#2040): the accumulator describes a reply a
 * process was in the middle of writing, and a process that is gone will not
 * finish it. Anything already produced is still in `opencode.db` and is
 * recovered by the backfill on the next attach.
 */
export function forgetOpencodeTranscripts(target: AgentInstanceRef): void {
  transcripts.delete(keyOf(target));
}

/** Drop every instance's turns. Test seam. */
export function resetOpencodeTranscripts(): void {
  transcripts.clear();
}

/**
 * Write one rendered turn, unless it is already there.
 *
 * The existence check and the insert are not in a transaction, and do not need
 * to be: both writers derive the same `request_id` from the same `parentID`, so
 * the worst a lost race can produce is two identical rows — and the two writers
 * that exist cannot run concurrently, because the stream path is a single
 * subscription's callback and the backfill runs before it starts delivering.
 *
 * @param origin - `stream` or `backfill`, for the log only
 * @returns Whether a row was written
 */
async function writeOpencodeTurn(
  target: AgentInstanceRef,
  rendered: OpencodeRenderedTurn,
  timestampMs: number,
  origin: 'stream' | 'backfill'
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    if (rendered.body.length === 0) {
      // A turn that produced only bookkeeping parts — an abort before the first
      // token, or a `session.idle` for a session that was never this pane's.
      // Nothing to say, and an empty row would show as a blank reply forever.
      logger.info('opencode-transcript-turn-empty', {
        worktreeId: target.worktreeId,
        instanceId,
        sessionId: rendered.sessionId,
        origin,
      });
      return false;
    }

    if (rendered.unknownPartTypes.length > 0) {
      // C8's rule applied to parts: a shape this reader has no words for is
      // counted, never guessed at. The tally is how a later opencode's new part
      // variant becomes visible instead of silently vanishing from history.
      logger.info('opencode-transcript-unknown-parts', {
        worktreeId: target.worktreeId,
        instanceId,
        sessionId: rendered.sessionId,
        partTypes: rendered.unknownPartTypes,
      });
    }

    const requestId = opencodeTurnRequestId(rendered.userMessageId);
    const [{ getDbInstance }, { createMessage, findMessageByRequestId }, { broadcastMessage }] =
      await Promise.all([
        import('@/lib/db/db-instance'),
        import('@/lib/db'),
        import('@/lib/ws-server'),
      ]);

    const db = getDbInstance();
    if (findMessageByRequestId(db, target.worktreeId, requestId)) {
      logger.debug('opencode-transcript-turn-already-saved', {
        worktreeId: target.worktreeId,
        instanceId,
        requestId,
        origin,
      });
      return false;
    }

    const message = createMessage(db, {
      worktreeId: target.worktreeId,
      role: 'assistant',
      content: rendered.body,
      messageType: 'normal',
      // The agent's own clock where it gave one (`info.time.created` on the
      // backfill path), so a run of rows rebuilt after a restart keeps the order
      // the conversation happened in rather than the order it was recovered in.
      timestamp: new Date(timestampMs > 0 ? timestampMs : Date.now()),
      cliToolId: target.cliToolId,
      instanceId,
      requestId,
    });

    broadcastMessage('message', { worktreeId: target.worktreeId, message });
    logger.info('opencode-transcript-turn-saved', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      requestId,
      origin,
      bodyLength: rendered.body.length,
      textParts: rendered.textParts,
      toolParts: rendered.toolParts,
    });
    return true;
  } catch (error) {
    logger.error('opencode-transcript-write-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      origin,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Recover every turn of a session that is not in history yet.
 *
 * Runs after a (re)connect. The turns already saved are skipped by the same
 * `request_id` check the live path uses, so this is safe to run on every
 * connect rather than only on the first — and it has to be, because the case it
 * covers is not only "CommandMate restarted" but also "the stream dropped
 * mid-turn and the `session.idle` was lost with it".
 *
 * Never throws.
 *
 * @param target - The instance
 * @param port - Its server
 * @param sessionId - `ses_…`; the caller resolves which session is this pane's
 * @returns How many rows were written
 */
export async function backfillOpencodeHistory(
  target: AgentInstanceRef,
  port: number,
  sessionId: string
): Promise<number> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const body = await fetchOpencodeSessionMessages(port, sessionId);
    if (body === null) {
      logger.info('opencode-transcript-backfill-unavailable', {
        worktreeId: target.worktreeId,
        instanceId,
        port,
        sessionId,
      });
      return 0;
    }

    const turns = buildOpencodeTurnsFromMessages(body, sessionId);
    // Newest first, so a session past the cap keeps the turns a reader is
    // actually looking at rather than the ones it has scrolled away from.
    const ordered = [...turns].sort((a, b) => b.startedAt - a.startedAt);
    const kept = ordered.slice(0, MAX_OPENCODE_BACKFILLED_TURNS);
    if (ordered.length > kept.length) {
      logger.warn('opencode-transcript-backfill-truncated', {
        worktreeId: target.worktreeId,
        instanceId,
        sessionId,
        examined: kept.length,
        skipped: ordered.length - kept.length,
        limit: MAX_OPENCODE_BACKFILLED_TURNS,
      });
    }

    let written = 0;
    // Oldest of the kept ones first, so the rows are inserted in conversation
    // order and `updateWorktreeTimestamp` ends on the newest.
    for (const turn of [...kept].reverse()) {
      const saved = await writeOpencodeTurn(
        target,
        renderOpencodeTurn(turn),
        turn.startedAt,
        'backfill'
      );
      if (saved) written += 1;
    }

    logger.info('opencode-transcript-backfill-done', {
      worktreeId: target.worktreeId,
      instanceId,
      port,
      sessionId,
      turns: turns.length,
      written,
    });
    return written;
  } catch (error) {
    logger.error('opencode-transcript-backfill-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      port,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
