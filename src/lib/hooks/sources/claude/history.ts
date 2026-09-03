/**
 * Writing Claude Code's own words into conversation history (Issue #2121).
 *
 * The second writer of `chat_messages` for a Claude turn, on the same terms
 * `../opencode/history` established for opencode (#2041): the first writer is
 * `lib/polling/response-checker`, which captures the pane and cleans it, and the
 * two are mutually exclusive.
 *
 * ## Pull, where opencode is push
 *
 * That is the one structural difference, and it decides the shape of this file.
 * opencode has a server CommandMate holds an SSE connection to, so its history
 * writer is driven by frames and flushed by `session.idle`. Claude has no
 * connection at all — its hooks are one-way HTTP posts that this process answers
 * and forgets. What it has instead is a **file**: every record of a session is
 * appended to `~/.claude/projects/<slug>/<session-id>.jsonl` as it happens.
 *
 * So there is nothing to subscribe to and nothing to flush, and the trigger has
 * to come from whatever already knows a turn just ended. That is the poller —
 * which is also the writer being replaced, so the handover happens in one place
 * and cannot half-happen: `lib/polling/structured-history-gate` calls
 * {@link captureClaudeTranscriptTurn} at the moment the scraped reply would be
 * saved, and saves it only if this returns false.
 *
 * ## Which file is this instance's
 *
 * The Issue's own framing, kept: **the session id is not a key, it is a mutable
 * pointer.** Identity stays the (worktree, tool, instance) triple that
 * `buildCompositeKey` has always spelled; the session id is only the answer to
 * "which transcript does that triple point at *right now*", and `/clear`
 * changing it is correct rather than a problem, because the conversation really
 * did change.
 *
 * The pointer is read from the structured events the agent already sends —
 * `getLastAgentEvent(...).sessionId`, which the `/api/hooks/agent-event`
 * receiver records for every hook — and latched here, because most events carry
 * a session id but the record is replaced by whichever event was newest. Two
 * consequences worth stating:
 *
 *  - **Two Claude instances in one worktree do not collide.** They share the
 *    project directory (the slug is a function of `cwd`), but the hook URL
 *    CommandMate injects carries `instanceId`, so each triple latches its own
 *    session id and therefore its own file.
 *  - **A session with no hooks has no pointer**, and this module returns false
 *    for it. That is the fail-open the acceptance criteria ask for: no
 *    transcript we can name means the scraper is still the only record there is.
 *
 * ## Nothing here throws
 *
 * Same contract as `../opencode/history`, for the same reason, and one more: a
 * throw here would propagate into the poller's save path and could cost the
 * scraped reply *as well as* the structured one. The database imports are
 * dynamic so that `better-sqlite3` does not enter the module graph of everything
 * that imports `@/lib/hooks/sources`.
 *
 * @module lib/hooks/sources/claude/history
 */

import { open, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import {
  recordUserTurn,
  type RecordedUserTurn,
  type RecordUserTurnOptions,
} from '@/lib/history/user-turn-recorder';
import { createLogger } from '@/lib/logger';
import { claudePromptRequestId, claudeTurnRequestId } from '@/types/agent-transcript';
import type { ChatMessage } from '@/types/models';
import type { AgentInstanceRef } from '../types';
import {
  buildClaudeTurns,
  claudeProjectSlug,
  CLAUDE_PROJECTS_DIR_SEGMENTS,
  isClaudePromptRecord,
  isClaudeTurnWritable,
  MAX_CLAUDE_TURN_BLOCKS,
  parseClaudeTranscript,
  renderClaudeTurn,
  type ClaudeContentBlock,
  type ClaudeRenderedTurn,
  type ClaudeTranscriptRecord,
  type ClaudeTurnAccumulator,
} from './transcript';

const logger = createLogger('lib/hooks/sources/claude/history');

/**
 * How much of the transcript's tail is read.
 *
 * The file grows for the life of the session and a long one is tens of
 * megabytes — the largest on this machine on 2026-08-31 was 23 MB — so reading
 * it whole on every finished turn would be the most expensive thing the poller
 * does. Only turns whose prompt record is inside the window are ever written
 * (see {@link captureClaudeTranscriptTurn}), which is also what stops a turn the
 * window opened halfway through being written from its middle.
 *
 * 4 MiB is roughly two orders of magnitude above the measured size of a single
 * turn and still small enough to read and parse in one tick. A turn that
 * genuinely does not fit produces orphaned assistant records, which is detected
 * and reported rather than written as a headless reply.
 */
export const CLAUDE_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/** `.jsonl`; the only extension this reader will open. */
const CLAUDE_TRANSCRIPT_EXTENSION = '.jsonl';

declare global {
  // eslint-disable-next-line no-var
  var __claudeTranscriptSessions: Map<string, string> | undefined;
}

/**
 * The last session id seen for each instance.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and the hook receiver's bundle would each
 * get a private copy of a module-scoped map.
 *
 * A latch and not a cache: `getLastAgentEvent` holds only the newest event, and
 * an event that carried no `session_id` would otherwise blank the pointer
 * mid-session. Same reasoning as `getLastKnownAgentModel`, which latches for the
 * same reason.
 */
const sessionPointers = (globalThis.__claudeTranscriptSessions ??= new Map<string, string>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/** Forget every instance's pointer. Test seam. */
export function resetClaudeTranscriptSessions(): void {
  sessionPointers.clear();
}

/**
 * The session id this instance's transcript is under, or null.
 *
 * Reads the structured event state first and falls back to the latched value.
 * The import is dynamic so that `agent-event-state`'s module graph does not
 * become a static dependency of the poller.
 */
export async function resolveClaudeSessionId(target: AgentInstanceRef): Promise<string | null> {
  const key = keyOf(target);
  try {
    const { getLastAgentEvent } = await import('@/lib/session/agent-event-state');
    const sessionId = getLastAgentEvent(
      target.worktreeId,
      target.cliToolId,
      target.instanceId
    )?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      sessionPointers.set(key, sessionId);
      return sessionId;
    }
  } catch (error) {
    // A state module that cannot be reached is one that knows no session id.
    logger.debug('claude-transcript-session-lookup-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return sessionPointers.get(key) ?? null;
}

/** `<home>/.claude/projects`. */
export function claudeProjectsRoot(homeDir: string): string {
  return join(homeDir, ...CLAUDE_PROJECTS_DIR_SEGMENTS);
}

/**
 * Where this session's transcript is, from the worktree's own path.
 *
 * `cwd` is the agent's working directory, and CommandMate starts every pane at
 * the worktree root, so the worktree path is the slug input. An agent the
 * operator `cd`-ed somewhere else writes to a different directory and this
 * answers a path that does not exist — read as "no transcript", which is the
 * fail-open direction.
 */
export function claudeTranscriptPath(
  homeDir: string,
  worktreePath: string,
  sessionId: string
): string {
  return join(
    claudeProjectsRoot(homeDir),
    claudeProjectSlug(worktreePath),
    `${sessionId}${CLAUDE_TRANSCRIPT_EXTENSION}`
  );
}

/**
 * A path named by something other than this module, accepted only if it is
 * really a transcript.
 *
 * The one caller is the `📄 Session log: …jsonl` line `lib/claude-output` reads
 * off the pane, which is text the agent printed and therefore text an agent
 * could print. Two conditions, both necessary: it must be under
 * `~/.claude/projects`, so a crafted line cannot make this open
 * `/etc/passwd`; and it must end in `.jsonl`.
 *
 * Containment is checked on the resolved path so that `..` cannot climb out,
 * and `resolve` is safe to use here — unlike in `validateHookCwd`, where the
 * value is echoed back — because the resolved string is the only thing that is
 * ever used.
 *
 * @returns The resolved path, or null when it is not acceptable
 */
export function acceptClaudeTranscriptHint(homeDir: string, hint: string): string | null {
  if (!hint.endsWith(CLAUDE_TRANSCRIPT_EXTENSION)) return null;
  if (hint.includes('\0')) return null;
  const root = resolve(claudeProjectsRoot(homeDir));
  const resolved = resolve(hint);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

/** What {@link captureClaudeTranscriptTurn} needs from its caller. */
export interface ClaudeTranscriptCapture {
  /** The worktree's path on disk; the slug input. */
  readonly worktreePath: string;
  /**
   * A transcript path the pane named, if any.
   *
   * Secondary to the session pointer, and present only because
   * `lib/claude-output` has been reading `📄 Session log:` out of Claude's
   * output since long before this Issue. It is what lets a session whose hooks
   * are switched off still be read, when the pane happens to say where.
   */
  readonly transcriptPathHint?: string | null;
  /** Test seam; defaults to the process's home directory. */
  readonly homeDir?: string;
}

/**
 * Read this instance's unwritten turns out of its transcript and write them.
 *
 * ## Why this is no longer "only the newest turn" (Issue #2246)
 *
 * #2121 wrote `built.turns.at(-1)` and nothing else, for a reason that was
 * sound and is still half true: every earlier turn of this session already has
 * a `chat_messages` row that the *scraper* wrote, and writing a Markdown row
 * for it as well would put the same reply in History twice — once as prose and
 * once as the pane drew it.
 *
 * What that argument did not cover is a turn **no writer recorded at all**. The
 * trigger for this reader is the poller deciding a turn finished, so a poll that
 * misjudges one completion (#2247's launch-banner heuristic, measured on
 * 2026-09-02) does not merely delay the turn: by the time the next completion is
 * judged, "the newest turn" is the *next* one, and the missed turn is nobody's.
 * One dropped completion cost one turn permanently.
 *
 * So the unit of work is now "every turn in the window that is not already a
 * row", written oldest first, and what preserves #2121's argument is the
 * **anchor**: the newest turn in the window that this reader has already written
 * is where the backfill starts. Turns after it are turns this reader was live
 * for, so a scraper row for them exists only in the case the anchor cannot see
 * — the reader answering false once for a transient reason (an empty body) and
 * the scraper saving that turn's pane copy. That trade is deliberate and in the
 * direction every Issue in this subsystem picks: two writers duplicate a reply,
 * no writer loses one.
 *
 * When the window holds **no** anchor — a session the reader has never written
 * for, and equally the first read after a `/clear` — this falls back to #2121's
 * behaviour exactly: the newest turn, and nothing before it. That is the case
 * where the earlier turns really are the scraper's, and there is no evidence in
 * the window that says otherwise.
 *
 * The return value is the poller's instruction, so the two failure directions
 * are worth stating plainly. **True** means this path has recorded the turn and
 * the scrape must be dropped. **False** means it has not, for any reason at all
 * — no session pointer, no file, an unreadable file, a turn with no assistant
 * text yet — and the scrape must be saved. Everything that can go wrong answers
 * false, which is the fail-open the acceptance criteria require: two writers
 * duplicate a reply, no writer loses one.
 *
 * **It is the newest turn the answer is about**, backfill or not. A run that
 * wrote three missed turns and then found the newest one still empty answers
 * false, because the scrape the poller is holding is the pane's copy of *that*
 * turn and dropping it would lose it.
 *
 * Never throws.
 *
 * @param target - The instance whose turn just ended
 * @returns Whether History now holds this instance's newest turn as Markdown
 */
export async function captureClaudeTranscriptTurn(
  target: AgentInstanceRef,
  capture: ClaudeTranscriptCapture
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const homeDir = capture.homeDir ?? homedir();
    if (typeof capture.worktreePath !== 'string' || capture.worktreePath.length === 0) {
      return false;
    }

    const sessionId = await resolveClaudeSessionId(target);
    const path = await locateClaudeTranscript(homeDir, capture, sessionId);
    if (!path) {
      logger.debug('claude-transcript-unavailable', {
        worktreeId: target.worktreeId,
        instanceId,
        sessionId,
        reason: sessionId ? 'no-file' : 'no-session-pointer',
      });
      return false;
    }

    const text = await readClaudeTranscriptTail(path);
    if (text === null) return false;

    const parsed = parseClaudeTranscript(text);
    const built = buildClaudeTurns(parsed.records, sessionId ?? '');
    if (built.turns.length === 0) {
      logger.info('claude-transcript-no-turn', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        records: parsed.records.length,
        malformedLines: parsed.malformedLines,
        orphanedAssistantRecords: built.orphanedAssistantRecords,
      });
      return false;
    }

    if (parsed.malformedLines > 0 || built.orphanedAssistantRecords > 0) {
      // Both are expected in small numbers — a fragment at the tail of a file
      // being appended to, and the head of the window landing mid-turn — and
      // both are the kind of thing that must be visible when it stops being
      // small.
      //
      // `orphanedAssistantRecords` is also the shape the Issue #2196 tail-window
      // trap takes: a turn whose prompt record fell outside
      // CLAUDE_TRANSCRIPT_TAIL_BYTES has assistant records and no prompt to
      // record a user row from. It is reported here rather than dropped in
      // silence, exactly as #2121 left it.
      logger.info('claude-transcript-partial-read', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        malformedLines: parsed.malformedLines,
        orphanedAssistantRecords: built.orphanedAssistantRecords,
        sidechainRecords: built.sidechainRecords,
      });
    }

    const pending = await selectUnwrittenClaudeTurns(target, built.turns);

    // Before anything is written: the rows that are already there (#2264). This
    // is deliberately ahead of the early return below, because "the newest turn
    // is already a row" is the state the nine short rows the Issue measured were
    // stuck in — the reader answered true and did nothing while the transcript
    // beside it held the missing paragraph.
    await refreshClaudeTurnRows(
      target,
      built.turns.slice(0, built.turns.length - pending.turns.length).slice(-CLAUDE_TURN_RECHECK_LIMIT),
      path
    );

    if (pending.turns.length === 0) {
      // The anchor is the newest turn in the window, so there is nothing to
      // write and the newest turn is a row. True, for the reason
      // {@link writeClaudeTurn} answers true to an already-saved turn: a second
      // poll of one finished turn must not put the pane's copy on top of it.
      logger.debug('claude-transcript-turns-already-saved', {
        worktreeId: target.worktreeId,
        instanceId,
        turnsInWindow: built.turns.length,
      });
      return true;
    }

    if (pending.turns.length > 1) {
      // The #2246 case, and the one worth a line in the log: more than one turn
      // was unwritten, so a completion went unnoticed at the time.
      logger.info('claude-transcript-backfilling-turns', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        pendingTurns: pending.turns.length,
        turnsInWindow: built.turns.length,
        anchored: pending.anchored,
      });
    }

    // Oldest first, and the ordering is load-bearing twice over: History sorts
    // by timestamp, and each turn's `/send` row is adopted against the previous
    // turn's start, so a later turn must not get to claim a row an earlier one
    // is about to ask for.
    let captured = false;
    for (let index = 0; index < pending.turns.length; index += 1) {
      const turn = pending.turns[index];
      const previousStartedAt =
        index === 0 ? pending.previousStartedAt : pending.turns[index - 1].startedAt;
      const userRow = await recordClaudeUserTurn(target, turn, previousStartedAt);
      captured = await writeClaudeTurn(
        target,
        turn,
        renderClaudeTurn(turn),
        resolveAssistantTimestampMs(turn, userRow),
        path
      );
    }
    return captured;
  } catch (error) {
    logger.error('claude-transcript-capture-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The turns {@link captureClaudeTranscriptTurn} still has to write (Issue #2246).
 *
 * The search runs **backwards from the newest turn** and stops at the first one
 * that is already a row. That turn is the *anchor*, and everything after it is
 * pending — by construction, since the anchor is the newest written turn in the
 * window.
 *
 * Two properties of that rule are worth stating because both were required:
 *
 *  - **Order, not time.** The comparison is the transcript's own record order
 *    and never a timestamp. A turn's assistant row is dated one millisecond
 *    after its user row (`resolveAssistantTimestampMs`), so the rows do not
 *    carry an ordering that could be trusted for this.
 *  - **The window bounds it.** `buildClaudeTurns` only opens a turn on a prompt
 *    record, so a turn whose prompt fell outside
 *    {@link CLAUDE_TRANSCRIPT_TAIL_BYTES} is not in `turns` at all and cannot be
 *    backfilled from its middle. Its records are counted as
 *    `orphanedAssistantRecords` instead, which is what the caller reports.
 *
 * A window with no anchor answers with the newest turn alone. See
 * {@link captureClaudeTranscriptTurn} for why that is #2121's behaviour rather
 * than a degraded one.
 *
 * @param turns - Every turn in the window, oldest first
 */
async function selectUnwrittenClaudeTurns(
  target: AgentInstanceRef,
  turns: readonly ClaudeTurnAccumulator[]
): Promise<PendingClaudeTurns> {
  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const requestId = claudeTurnRequestId(turns[index].promptUuid);
    if (!findMessageByRequestId(db, target.worktreeId, requestId)) continue;
    return {
      turns: turns.slice(index + 1),
      previousStartedAt: turns[index].startedAt,
      anchored: true,
    };
  }

  return {
    turns: turns.slice(-1),
    previousStartedAt: turns.length > 1 ? turns[turns.length - 2].startedAt : 0,
    anchored: false,
  };
}

/** What {@link selectUnwrittenClaudeTurns} answers. */
interface PendingClaudeTurns {
  /** The turns to write, oldest first. Empty when the newest one is a row. */
  readonly turns: readonly ClaudeTurnAccumulator[];
  /**
   * `startedAt` of the turn immediately before the first pending one, or 0.
   *
   * The lower bound on `/send` row adoption for that turn; see
   * {@link RecordUserTurnOptions}.
   */
  readonly previousStartedAt: number;
  /** Whether a written turn was found in the window. Logged, never branched on. */
  readonly anchored: boolean;
}

/**
 * The transcript file this instance would be read from, or null (Issue #2246).
 *
 * The same two steps {@link captureClaudeTranscriptTurn} opens with — resolve
 * the session pointer, then check the filesystem — asked without reading or
 * writing anything. The Stop receiver uses it to decide whether waiting half a
 * second and asking again could possibly help: a session with no transcript to
 * name will not have grown one by then, and a hook handler that sleeps for
 * nothing is a hook handler that slows every turn of every tool.
 *
 * Never throws.
 */
export async function resolveClaudeTranscriptPath(
  target: AgentInstanceRef,
  capture: ClaudeTranscriptCapture
): Promise<string | null> {
  try {
    const homeDir = capture.homeDir ?? homedir();
    if (typeof capture.worktreePath !== 'string' || capture.worktreePath.length === 0) {
      return null;
    }
    return await locateClaudeTranscript(homeDir, capture, await resolveClaudeSessionId(target));
  } catch {
    return null;
  }
}

/** What {@link readClaudeTurnProgress} answers. */
export interface ClaudeTurnProgress {
  /**
   * The id the live body is keyed on.
   *
   * Normally `claudeTurnRequestId(promptUuid)` — byte-identical to the
   * `requestId` {@link captureClaudeTranscriptTurn} will write, which is what
   * makes the client's swap a string comparison. The one exception is the
   * headless read described on {@link partial}, whose key is derived from the
   * session instead and is deliberately shaped so it can never collide with a
   * prompt-derived one.
   */
  readonly turnKey: string;
  /** The Markdown the agent has written so far. Never empty. */
  readonly body: string;
  /**
   * True when the body does not start at the beginning of the turn.
   *
   * There is exactly one way this happens, and it is worth stating precisely
   * because the obvious reading is wrong. `orphanedAssistantRecords > 0` alone
   * does NOT mean the *newest* turn lost its head: a 4 MiB window over a long
   * session almost always opens mid-turn, and the orphans that produces belong
   * to a turn that has already been written. Whenever a prompt record appears
   * anywhere in the window, the newest turn is the one it opened and its head is
   * complete.
   *
   * The head is missing only when the window holds assistant records and no
   * prompt record at all — a single turn whose own prompt has scrolled out of
   * {@link CLAUDE_TRANSCRIPT_TAIL_BYTES}. #2121 leaves that turn unwritten (there
   * is no `uuid` to key a row on) and this reader will not leave it invisible:
   * the readable tail is published and marked, because a reply shown from the
   * middle without saying so is worse than no reply at all.
   */
  readonly partial: boolean;
}

/**
 * The key for a body read with no prompt record in the window.
 *
 * `partial:` cannot be the prefix of a UUID, so this can never collide with
 * `claudeTurnRequestId(promptUuid)` — which matters because the two mean
 * different things to the client. A prompt-derived key is a promise that a row
 * with the same id is coming; this one is a promise that no such row exists, so
 * the bubble it draws is cleared by the session going idle rather than by a swap.
 */
function headlessClaudeTurnKey(sessionId: string): string {
  return claudeTurnRequestId(`partial:${sessionId}`);
}

/**
 * Everything the window holds for a turn whose prompt record is outside it.
 *
 * Built here rather than in `buildClaudeTurns` on purpose: that function drops
 * orphaned records for a stated reason — their text must never be attached to an
 * invented turn key, because an invented key is a row no later run can recognise
 * as already written. That argument is about **writing**, and this path writes
 * nothing. So the records are gathered separately, into an accumulator that is
 * rendered by the same `renderClaudeTurn` and never handed to a writer.
 *
 * Only the records before the first prompt record are taken, which is exactly
 * the set `buildClaudeTurns` counted as orphaned.
 */
function collectHeadlessClaudeTurn(
  records: readonly ClaudeTranscriptRecord[],
  sessionId: string
): ClaudeTurnAccumulator {
  const blocks: ClaudeContentBlock[] = [];
  let assistantRecords = 0;
  let overflowed = false;

  for (const record of records) {
    if (isClaudePromptRecord(record)) break;
    if (record.isSidechain || record.type !== 'assistant') continue;
    assistantRecords += 1;
    for (const block of record.blocks) {
      if (blocks.length >= MAX_CLAUDE_TURN_BLOCKS) {
        overflowed = true;
        break;
      }
      blocks.push(block);
    }
  }

  return {
    sessionId,
    promptUuid: `partial:${sessionId}`,
    startedAt: 0,
    promptText: '',
    promptIsOperatorInput: false,
    blocks,
    assistantRecords,
    // Never handed to a writer, so neither flag can be read off it; false is the
    // value that would refuse the write if one were ever attempted.
    closed: false,
    superseded: false,
    stopReasonObserved: false,
    overflowed,
  };
}

/**
 * Read the turn that is open right now, without writing anything (Issue #2199).
 *
 * The read half of {@link captureClaudeTranscriptTurn}, and *only* the read
 * half: no `chat_messages` row, no user row, no `broadcastMessage`. That
 * separation is the whole safety argument for this function. The write path is
 * idempotent because `findMessageByRequestId` answers for a `requestId` derived
 * from the prompt record's `uuid`; running it on every poll tick of an
 * unfinished turn would mean writing the reply as it grows and then finding the
 * row already there, so the row would freeze at whatever the first tick saw.
 * This path never reaches that code at all.
 *
 * The two also cannot fight over the file: both open it read-only, and the
 * writer is Claude.
 *
 * Deliberately **not** gated on whether the turn has ended. It cannot be — the
 * transcript has no end-of-turn record this reader could trust, which is why
 * #2121 put the trigger in the poller. The caller supplies that judgement (it
 * asks only while the session is generating), and a body read from a turn that
 * has just finished is harmless: the settled row carries the same
 * {@link ClaudeTurnProgress.turnKey}, so the client replaces one with the other.
 *
 * Never throws.
 *
 * @param target - The instance whose turn is in flight
 * @param capture - Where to look; the same {@link ClaudeTranscriptCapture} the writer takes
 * @returns The open turn's body, or null when there is nothing to show yet
 */
export async function readClaudeTurnProgress(
  target: AgentInstanceRef,
  capture: ClaudeTranscriptCapture
): Promise<ClaudeTurnProgress | null> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const homeDir = capture.homeDir ?? homedir();
    if (typeof capture.worktreePath !== 'string' || capture.worktreePath.length === 0) {
      return null;
    }

    const sessionId = await resolveClaudeSessionId(target);
    const path = await locateClaudeTranscript(homeDir, capture, sessionId);
    if (!path) return null;

    const text = await readClaudeTranscriptTail(path);
    if (text === null) return null;

    // A fragment at the tail of a file being appended to is the normal case here
    // — this reader runs *while* Claude is writing — and `parseClaudeTranscript`
    // already counts it rather than throwing. Nothing extra is needed, and that
    // is the property `claude-transcript-progress-2199` pins.
    const parsed = parseClaudeTranscript(text);
    const built = buildClaudeTurns(parsed.records, sessionId ?? '');
    const turn = built.turns.at(-1);

    if (turn) {
      const rendered = renderClaudeTurn(turn);
      if (rendered.body.length === 0) return null;
      return {
        turnKey: claudeTurnRequestId(rendered.promptUuid),
        body: rendered.body,
        partial: false,
      };
    }

    // No prompt record anywhere in the window. See {@link ClaudeTurnProgress.partial}.
    if (built.orphanedAssistantRecords === 0) return null;
    const headless = collectHeadlessClaudeTurn(parsed.records, sessionId ?? '');
    const rendered = renderClaudeTurn(headless);
    if (rendered.body.length === 0) return null;

    logger.info('claude-transcript-progress-headless', {
      worktreeId: target.worktreeId,
      instanceId,
      path,
      orphanedAssistantRecords: built.orphanedAssistantRecords,
      malformedLines: parsed.malformedLines,
    });

    return {
      turnKey: headlessClaudeTurnKey(sessionId ?? ''),
      body: rendered.body,
      partial: true,
    };
  } catch (error) {
    logger.debug('claude-transcript-progress-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Record the prompt this turn answers, before the reply is written (Issue #2196).
 *
 * Ordering is the reason this is a separate call and not a branch inside
 * {@link writeClaudeTurn}: the user row has to exist *before* the assistant row
 * so that {@link resolveAssistantTimestampMs} can put the reply after it, and so
 * that a browser watching the broadcast sees a prompt appear and then an answer
 * rather than the other way round.
 *
 * A turn whose prompt was not the operator's — a `<task-notification>`, a
 * compaction summary, a headless `sdk` run; see `isClaudeOperatorPromptRecord` —
 * is skipped and said so in the log. The assistant row is still written: the
 * agent really did reply, and #2121's behaviour for those turns is unchanged.
 *
 * Never throws; `recordUserTurn` reports its failures in the return value.
 *
 * @param previousStartedAt - When the turn before this one opened, or 0. Widens
 *   `/send` adoption backwards to that instant (Issue #2246): a prompt the agent
 *   queued for eleven minutes is still the row CommandMate wrote when it sent
 *   the text, and #2196's symmetric two-minute window cannot reach it. Never
 *   narrows — see {@link RecordUserTurnOptions}.
 */
async function recordClaudeUserTurn(
  target: AgentInstanceRef,
  turn: ClaudeTurnAccumulator,
  previousStartedAt = 0
): Promise<RecordedUserTurn> {
  const instanceId = target.instanceId ?? target.cliToolId;

  if (!turn.promptIsOperatorInput) {
    logger.debug('claude-transcript-user-turn-skipped', {
      worktreeId: target.worktreeId,
      instanceId,
      promptUuid: turn.promptUuid,
      reason: 'not-operator-input',
    });
    return { outcome: 'skipped', messageId: null, timestampMs: null };
  }

  const adoption: RecordUserTurnOptions =
    previousStartedAt > 0 ? { adoptionFromMs: previousStartedAt } : {};

  const recorded = await recordUserTurn(
    target,
    claudePromptRequestId(turn.promptUuid),
    turn.promptText,
    turn.startedAt,
    adoption
  );

  if (recorded.outcome === 'failed') {
    logger.warn('claude-transcript-user-turn-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: turn.sessionId,
      promptUuid: turn.promptUuid,
    });
  }

  return recorded;
}

/**
 * When the assistant row for this turn is dated.
 *
 * #2121 dated it by the prompt record's clock so that a row written a poll late
 * still sorts where the conversation put it, and that is still what happens for
 * every turn that produced no user row.
 *
 * When there *is* a user row, it sits on that same instant — both come from the
 * one prompt record — and `groupMessagesIntoPairs` orders by timestamp and
 * nothing else. A tie there is decided by whichever row the database happened to
 * return first, and the losing arrangement (assistant, then user) is exactly the
 * `orphan` pair this Issue exists to remove. So the reply is moved to the first
 * millisecond after the prompt: the smallest change that makes the order a
 * property of the data rather than of the query plan.
 */
function resolveAssistantTimestampMs(
  turn: ClaudeTurnAccumulator,
  userRow: RecordedUserTurn
): number {
  if (userRow.timestampMs === null) return turn.startedAt;
  return Math.max(turn.startedAt, userRow.timestampMs + 1);
}

/**
 * The transcript file for this instance, or null.
 *
 * The session pointer first, the pane's own claim second. Both are checked
 * against the filesystem rather than trusted, because "the path we would use"
 * and "the path that exists" differ for every session the operator started
 * outside CommandMate.
 */
async function locateClaudeTranscript(
  homeDir: string,
  capture: ClaudeTranscriptCapture,
  sessionId: string | null
): Promise<string | null> {
  if (sessionId) {
    const path = claudeTranscriptPath(homeDir, capture.worktreePath, sessionId);
    if (await isReadableFile(path)) return path;
  }

  const hint = capture.transcriptPathHint;
  if (typeof hint === 'string' && hint.length > 0) {
    const accepted = acceptClaudeTranscriptHint(homeDir, hint);
    if (accepted && (await isReadableFile(accepted))) return accepted;
  }

  return null;
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The last {@link CLAUDE_TRANSCRIPT_TAIL_BYTES} of the file, as UTF-8.
 *
 * Read at an offset rather than whole, and the first line of a windowed read is
 * dropped: starting mid-line would hand `parseClaudeTranscript` a fragment that
 * it would count as malformed anyway, and dropping it deliberately keeps that
 * counter meaning "the writer was mid-append", which is the thing worth seeing.
 *
 * @returns The text, or null when the file could not be read
 */
async function readClaudeTranscriptTail(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const offset = Math.max(0, size - CLAUDE_TRANSCRIPT_TAIL_BYTES);
    const length = size - offset;
    if (length <= 0) return '';

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset === 0) return text;

    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } catch (error) {
    logger.warn('claude-transcript-read-failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * How many already-written turns are re-rendered and compared (Issue #2264).
 *
 * The repair half of #2264 has to look at rows the reader has **already**
 * written, which is the one thing the anchor rule deliberately does not do — so
 * it is bounded here rather than by the window. Three, because the poller runs
 * every two seconds and re-rendering the whole 4 MiB window on every tick would
 * turn a repair into the most expensive thing the poll does, while a row that is
 * going to grow grows within a second of being written.
 *
 * The cost of the bound is only paid by rows the old code left short: those are
 * repaired on the next read that still has the turn among its newest three, and
 * a session that has moved four turns past one of them keeps it. The Issue's own
 * nine rows were all the newest turn at the time, so all nine are inside it.
 */
export const CLAUDE_TURN_RECHECK_LIMIT = 3;

/**
 * Replace a saved row whose body has since grown (Issue #2264).
 *
 * The second half of the fix, and the half that repairs what the first half
 * only stops happening again. A row keyed `claude-turn:<uuid>` is written once
 * and every later read answers "already saved" — so the nine short rows the
 * Issue measured were frozen, and the scrape that could have replaced them was
 * suppressed two seconds later by that same idempotency answer.
 *
 * **Strictly longer, never merely different.** Equality is the ordinary case and
 * must cost nothing, and a body that got *shorter* between two reads is not a
 * turn that grew — it is a window that slid, or a truncation marker, and
 * overwriting a full reply with a shorter one is the one outcome worse than the
 * bug. Longer implies different, so one comparison covers both halves of the
 * Issue's "differs and is longer".
 *
 * `message_updated`, never `message`: the row already existed and was already
 * delivered when it was created (#2195), so a client that appended instead of
 * replacing would show the reply twice.
 *
 * @param existing - The row `findMessageByRequestId` answered with
 * @returns Whether the row was replaced
 */
async function growClaudeTurnRow(
  target: AgentInstanceRef,
  existing: ChatMessage,
  rendered: ClaudeRenderedTurn,
  path: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  const previousLength = existing.content.length;
  if (rendered.body.length <= previousLength) return false;

  const [{ getDbInstance }, { updateMessageContent }, { broadcastMessage }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
    import('@/lib/ws-server'),
  ]);

  updateMessageContent(getDbInstance(), existing.id, rendered.body);
  broadcastMessage('message_updated', {
    worktreeId: target.worktreeId,
    message: { ...existing, content: rendered.body },
  });
  logger.info('claude-transcript-turn-updated', {
    worktreeId: target.worktreeId,
    instanceId,
    sessionId: rendered.sessionId,
    requestId: existing.requestId,
    path,
    previousLength,
    bodyLength: rendered.body.length,
    textBlocks: rendered.textBlocks,
    toolBlocks: rendered.toolBlocks,
  });
  return true;
}

/**
 * Re-read the newest already-written turns and grow the short ones (#2264).
 *
 * Runs before the pending turns are written and independently of whether there
 * are any — the case it exists for is precisely the one
 * {@link captureClaudeTranscriptTurn} used to return `true` from without doing
 * anything: the newest turn already has a row, and that row is missing its last
 * paragraph.
 *
 * Turns that are still open are skipped rather than compared. Their body is by
 * definition not the final one, and a repair that raced the agent would rewrite
 * the row on every poll of a long turn.
 *
 * The database is asked before the turn is rendered, so a candidate with no row
 * — every candidate, in a session this reader has never written to — costs one
 * indexed lookup and no Markdown.
 *
 * @param candidates - Already-written turns, oldest first, at most {@link CLAUDE_TURN_RECHECK_LIMIT}
 * @returns How many rows were replaced
 */
async function refreshClaudeTurnRows(
  target: AgentInstanceRef,
  candidates: readonly ClaudeTurnAccumulator[],
  path: string
): Promise<number> {
  if (candidates.length === 0) return 0;

  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  let updated = 0;
  for (const turn of candidates) {
    if (!isClaudeTurnWritable(turn)) continue;
    const existing = findMessageByRequestId(
      db,
      target.worktreeId,
      claudeTurnRequestId(turn.promptUuid)
    );
    if (!existing) continue;
    if (await growClaudeTurnRow(target, existing, renderClaudeTurn(turn), path)) updated += 1;
  }
  return updated;
}

/**
 * Write one rendered turn, unless it is already there.
 *
 * `findMessageByRequestId` is both the idempotency check and the reason a
 * repeat poll does not duplicate the row: the id is derived from the prompt
 * record's `uuid`, which does not change between reads of the same file.
 *
 * Answering **true** for a turn that was already saved is deliberate. It means
 * "History holds this turn as Markdown", which is exactly what the poller needs
 * to know — a second poll of the same finished turn must not save the pane's
 * copy on top of the row this path wrote for it.
 *
 * @returns Whether History holds this turn as the agent's own Markdown
 */
async function writeClaudeTurn(
  target: AgentInstanceRef,
  turn: ClaudeTurnAccumulator,
  rendered: ClaudeRenderedTurn,
  timestampMs: number,
  path: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

  if (!isClaudeTurnWritable(turn)) {
    // The agent has not said `end_turn` for this prompt and no later prompt has
    // taken over, so what is in the file is a turn in progress. Writing it would
    // put a reply with its last paragraph missing into History **permanently** —
    // the row is keyed on the prompt's `uuid`, so every later read finds it and
    // answers "already saved". That is Issue #2264 exactly: 9 of `claude-2`'s 20
    // turns on 2026-09-03 were saved as a bare `> **Tool calls (1)**` with not
    // one character of prose, because the Stop hook beat the last append and the
    // emptiness guard below cannot see the difference — a turn cut off after its
    // tool calls renders a *non-empty* body.
    //
    // Handing it back to the scraper costs the Markdown rendering for this turn
    // and nothing else: the Stop receiver asks again after a short delay, and
    // the poller asks again when the pane returns to the composer.
    logger.info('claude-transcript-turn-open', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      promptUuid: rendered.promptUuid,
      assistantRecords: turn.assistantRecords,
      textBlocks: rendered.textBlocks,
      toolBlocks: rendered.toolBlocks,
    });
    return false;
  }

  if (rendered.body.length === 0) {
    // The turn is open but the agent has not written anything to the file yet —
    // the prompt record is there and the assistant records are not. Answering
    // false hands the turn back to the scraper, which is the only correct
    // answer: an empty row would show as a blank reply forever, and suppressing
    // the scrape would lose the reply outright.
    logger.info('claude-transcript-turn-empty', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      promptUuid: rendered.promptUuid,
    });
    return false;
  }

  if (rendered.unknownBlockTypes.length > 0) {
    logger.info('claude-transcript-unknown-blocks', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      blockTypes: rendered.unknownBlockTypes,
    });
  }

  const requestId = claudeTurnRequestId(rendered.promptUuid);
  const [{ getDbInstance }, { createMessage, findMessageByRequestId }, { broadcastMessage }] =
    await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
      import('@/lib/ws-server'),
    ]);

  const db = getDbInstance();
  const existing = findMessageByRequestId(db, target.worktreeId, requestId);
  if (existing) {
    logger.debug('claude-transcript-turn-already-saved', {
      worktreeId: target.worktreeId,
      instanceId,
      requestId,
    });
    // The row may still be one of the short ones #2264 was reported for, and
    // this is the one place that knows both the row and the turn. See
    // {@link growClaudeTurnRow}.
    await growClaudeTurnRow(target, existing, rendered, path);
    return true;
  }

  const message = createMessage(db, {
    worktreeId: target.worktreeId,
    role: 'assistant',
    content: rendered.body,
    messageType: 'normal',
    // The agent's own clock, from the prompt record's `timestamp`, so a row
    // written a poll late still sorts where the conversation put it.
    timestamp: new Date(timestampMs > 0 ? timestampMs : Date.now()),
    cliToolId: target.cliToolId,
    instanceId,
    requestId,
  });

  broadcastMessage('message', { worktreeId: target.worktreeId, message });
  logger.info('claude-transcript-turn-saved', {
    worktreeId: target.worktreeId,
    instanceId,
    sessionId: rendered.sessionId,
    requestId,
    path,
    bodyLength: rendered.body.length,
    textBlocks: rendered.textBlocks,
    toolBlocks: rendered.toolBlocks,
  });
  return true;
}
