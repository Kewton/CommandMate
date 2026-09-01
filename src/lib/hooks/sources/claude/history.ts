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
import { recordUserTurn, type RecordedUserTurn } from '@/lib/history/user-turn-recorder';
import { createLogger } from '@/lib/logger';
import { claudePromptRequestId, claudeTurnRequestId } from '@/types/agent-transcript';
import type { AgentInstanceRef } from '../types';
import {
  buildClaudeTurns,
  claudeProjectSlug,
  CLAUDE_PROJECTS_DIR_SEGMENTS,
  isClaudePromptRecord,
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
 * does. Only the newest turn is ever written (see {@link captureClaudeTranscriptTurn}),
 * so only the newest turn has to be in the window.
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
 * Read the newest turn out of this instance's transcript and write it.
 *
 * **Only the newest turn**, and that is the deliberate difference from
 * opencode's backfill. Every earlier turn of this session already has a
 * `chat_messages` row that the *scraper* wrote, and writing a Markdown row for
 * it as well would put the same reply in History twice — once as prose and once
 * as the pane drew it. The scraper wrote exactly one row per turn and this
 * writes exactly one row per turn, so the swap is one-for-one and history is
 * neither duplicated nor rewritten.
 *
 * The return value is the poller's instruction, so the two failure directions
 * are worth stating plainly. **True** means this path has recorded the turn and
 * the scrape must be dropped. **False** means it has not, for any reason at all
 * — no session pointer, no file, an unreadable file, a turn with no assistant
 * text yet — and the scrape must be saved. Everything that can go wrong answers
 * false, which is the fail-open the acceptance criteria require: two writers
 * duplicate a reply, no writer loses one.
 *
 * Never throws.
 *
 * @param target - The instance whose turn just ended
 * @returns Whether History now holds this turn as the agent's own Markdown
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
    const turn = built.turns.at(-1);
    if (!turn) {
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

    const userRow = await recordClaudeUserTurn(target, turn);
    return await writeClaudeTurn(
      target,
      renderClaudeTurn(turn),
      resolveAssistantTimestampMs(turn, userRow),
      path
    );
  } catch (error) {
    logger.error('claude-transcript-capture-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
 */
async function recordClaudeUserTurn(
  target: AgentInstanceRef,
  turn: ClaudeTurnAccumulator
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

  const recorded = await recordUserTurn(
    target,
    claudePromptRequestId(turn.promptUuid),
    turn.promptText,
    turn.startedAt
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
  rendered: ClaudeRenderedTurn,
  timestampMs: number,
  path: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

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
  if (findMessageByRequestId(db, target.worktreeId, requestId)) {
    logger.debug('claude-transcript-turn-already-saved', {
      worktreeId: target.worktreeId,
      instanceId,
      requestId,
    });
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
