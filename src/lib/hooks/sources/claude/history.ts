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

import { open, stat, type FileHandle } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import {
  recordUserTurn,
  type RecordedUserTurn,
  type RecordUserTurnOptions,
} from '@/lib/history/user-turn-recorder';
import { advanceCapturedLineForTranscriptTurn } from '@/lib/assistant-response-saver';
import { createLogger } from '@/lib/logger';
import {
  CLAUDE_HEADLESS_TURN_ID_PREFIX,
  claudePromptRequestId,
  claudeTurnRequestId,
} from '@/types/agent-transcript';
import type { ChatMessage } from '@/types/models';
import type { AgentInstanceRef } from '../types';
import type { StructuredHistoryCaptureReport } from '@/lib/polling/structured-history-gate';
import {
  buildClaudeTurns,
  buildHeadlessClaudeTurn,
  claudeProjectSlug,
  CLAUDE_PROJECTS_DIR_SEGMENTS,
  CLAUDE_TURN_TRUNCATION_MARKER,
  isClaudePromptRecord,
  isClaudeTurnWritable,
  MAX_CLAUDE_TURN_BLOCKS,
  MAX_CLAUDE_TURN_BODY_LENGTH,
  parseClaudeTranscript,
  readClaudeTranscriptRecord,
  renderClaudeTurn,
  type ClaudeContentBlock,
  type ClaudeRenderedTurn,
  type ClaudeTranscriptParse,
  type ClaudeTranscriptRecord,
  type ClaudeTurnAccumulator,
  type ClaudeTurnBuild,
} from './transcript';

const logger = createLogger('lib/hooks/sources/claude/history');

/**
 * How much of the transcript's tail is read first.
 *
 * The file grows for the life of the session and a long one is tens of
 * megabytes — the largest on this machine on 2026-08-31 was 23 MB — so reading
 * it whole on every finished turn would be the most expensive thing the poller
 * does. A turn is only ever written from a prompt record inside the window (see
 * {@link captureClaudeTranscriptTurn}), which is also what stops a turn the
 * window opened halfway through being written from its middle.
 *
 * #2121 sized this as "roughly two orders of magnitude above a single turn".
 * Issue #2470 measured that and it does not hold at the top of the
 * distribution. Over the 27 transcripts in this repository's project directory
 * written in the 14 days to 2026-09-11 — 1,663 turns — the bytes one turn
 * occupies in the file, from its prompt record to the next, were:
 *
 * | p50 | p90 | p99 | max | over 4 MiB |
 * |---|---|---|---|---|
 * | 0.04 MiB | 0.24 MiB | 4.71 MiB | 23.72 MiB | 19 turns (1.1%) |
 *
 * Every one of the 19 was a long, human-started orchestrate or UAT turn — the
 * replies an operator most wants to read back — and before #2470 every one of
 * them was reported as orphaned records and written by nobody. 4 MiB is kept as
 * the size of the *first* read, which is the whole read for 99% of turns; a turn
 * that does not fit is read further back instead of dropped. See
 * {@link CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES}.
 */
export const CLAUDE_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * How far back a finished turn's prompt record is looked for (Issue #2470).
 *
 * When the first window holds assistant records and no prompt record at all,
 * {@link captureClaudeTranscriptTurn} doubles it — 8, 16, 32, 64 MiB — until a
 * prompt record is inside, and stops there. 64 MiB is almost three times the
 * largest turn measured (23.72 MiB), and it bounds the one cost this adds:
 * reading up to 60 MiB more of the file, once per ask, for a turn that ran that
 * long. Measured on 2026-09-11 with a synthetic transcript of 20 KiB tool
 * results, reading and parsing a 64 MiB tail took 41 ms (4 MiB: 3 ms).
 *
 * A turn longer than this is still not dropped: what can be read of it is saved
 * behind {@link CLAUDE_TURN_HEAD_MISSING_MARKER}. See
 * {@link captureClaudeTranscriptTurn}.
 */
export const CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES = 64 * 1024 * 1024;

/**
 * The first line of a reply saved without its beginning (Issue #2470).
 *
 * Plain English Markdown, the way {@link CLAUDE_TURN_TRUNCATION_MARKER} marks
 * the other end of a cut reply, rather than a translated string. `content` is
 * fixed when the row is written and read back by every viewer in whatever
 * language they use, and this layer has nobody to ask: the Stop hook that
 * writes the row arrives with no request and no locale behind it. The
 * `--- Output truncated (exceeded 100KB limit) ---` line
 * `lib/session/claude-executor` appends to a scheduled run's output is the same
 * choice for the same reason.
 */
export const CLAUDE_TURN_HEAD_MISSING_MARKER = `_(The beginning of this reply is not shown: the turn runs further back than the ${CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES / (1024 * 1024)} MiB of transcript that is read.)_`;

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
 * ## A turn longer than the window (Issue #2470)
 *
 * A turn can be bigger than {@link CLAUDE_TRANSCRIPT_TAIL_BYTES} — 1.1% of the
 * turns measured were, and they were the longest replies of all. Its window
 * holds its assistant records and no prompt record, so `buildClaudeTurns` finds
 * no turn, and before #2470 this answered false with nobody left to write the
 * reply: the Stop receiver has no scrape to fall back on, and the poller that
 * has one may have been restarted, or have given up at its 30-minute limit, long
 * before a fifty-minute turn ends. The measured case wrote no row at all.
 *
 * Two steps now, and both only when the window holds orphaned assistant records
 * and **no** prompt record. A window with a prompt record anywhere in it is read
 * exactly as before, byte for byte.
 *
 *  1. **Read further back** ({@link extendClaudeTranscriptRead}). The window
 *     doubles, up to {@link CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES}, until a prompt
 *     record is in it, and the turn is then written like any other — user row,
 *     backfill anchor, #2264's open-turn gate and all.
 *  2. **Save what can be read** ({@link captureHeadlessClaudeTurn}). A turn whose
 *     prompt is further back than even that is written as a reply behind
 *     {@link CLAUDE_TURN_HEAD_MISSING_MARKER}, with no user row, keyed on the
 *     record that closed it. Only when the read stopped at the limit rather than
 *     at the start of the file: a whole file with no prompt record in it is not a
 *     turn too long to reach but a shape this reader does not understand, and the
 *     scraper keeps it, as it did before.
 *
 * Either way the answer is still about the newest turn and means what it always
 * meant: a headless row answers true because History now holds the turn, and an
 * open one answers false with `not_yet_closed`.
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
 * Since Issue #2436 the false can explain itself: pass a
 * `StructuredHistoryCaptureReport` and `outcome` is set to `'not_yet_closed'`
 * when the newest turn is one the agent has not finished writing — the case the
 * `-turn-open` line below reports, and the one where the caller's scraped copy
 * is worth holding rather than saving. Every other false leaves it unset, which
 * the gate reads as `'unavailable'`.
 *
 * @param target - The instance whose turn just ended
 * @param report - Optional out-parameter; see `StructuredHistoryCaptureReport`
 * @returns Whether History now holds this instance's newest turn as Markdown
 */
export async function captureClaudeTranscriptTurn(
  target: AgentInstanceRef,
  capture: ClaudeTranscriptCapture,
  report?: StructuredHistoryCaptureReport
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

    const read = await readClaudeTranscriptTurns(target, path, sessionId ?? '');
    if (read === null) return false;

    const { parsed, built } = read;
    if (built.turns.length === 0) {
      const orphaned = built.orphanedAssistantRecords;
      // A warning since Issue #2470: when this line was `info`, the measured
      // incident — a fifty-minute turn whose reply reached no writer at all —
      // was three of them in a row and nothing else.
      logger.warn('claude-transcript-no-turn', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        records: parsed.records.length,
        malformedLines: parsed.malformedLines,
        orphanedAssistantRecords: orphaned,
        // Orphans are the one reason the window can be to blame, so they are
        // when how much of the file the read covered is worth reading.
        ...(orphaned > 0 ? { readBytes: read.size - read.startByte, size: read.size } : {}),
      });
      if (orphaned > 0 && read.reachedLimit) {
        return await captureHeadlessClaudeTurn(target, parsed.records, sessionId ?? '', path, report);
      }
      return false;
    }

    if (parsed.malformedLines > 0 || built.orphanedAssistantRecords > 0) {
      // Both are expected in small numbers — a fragment at the tail of a file
      // being appended to, and the head of the window landing mid-turn — and
      // both are the kind of thing that must be visible when it stops being
      // small.
      //
      // `orphanedAssistantRecords` used to be the shape the Issue #2196
      // tail-window trap took as well: a turn whose prompt record fell outside
      // CLAUDE_TRANSCRIPT_TAIL_BYTES. Since #2470 that shape never gets here —
      // a window with no prompt record in it is read further back first — so
      // what is counted now is the harmless half: the tail of an earlier turn,
      // in front of the prompt that opened the newest one.
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
      // Issue #2437: this turn is already History's Markdown, so the pane rows
      // behind it must stop being "unsaved output" the pre-send flush can pick up.
      await advanceCapturedLineForTranscriptTurn(target);
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
    //
    // Every prompt row is recorded before any reply is written (Issue #2273).
    // That is what lets a reply be dated at its turn's END without overtaking
    // the NEXT turn's prompt: a queued `/send` row is written while this turn is
    // still running, so its instant is only knowable once that row has been
    // recorded. With one turn pending — the ordinary case — this is the single
    // call it always was.
    const userRows: RecordedUserTurn[] = [];
    for (let index = 0; index < pending.turns.length; index += 1) {
      const previousStartedAt =
        index === 0 ? pending.previousStartedAt : pending.turns[index - 1].startedAt;
      userRows.push(await recordClaudeUserTurn(target, pending.turns[index], previousStartedAt));
    }

    const lastRecordAt = lastClaudeAssistantRecordAt(parsed.records);
    let captured = false;
    for (let index = 0; index < pending.turns.length; index += 1) {
      const turn = pending.turns[index];
      captured = await writeClaudeTurn(
        target,
        turn,
        renderClaudeTurn(turn),
        resolveAssistantTimestampMs(
          turn,
          userRows[index],
          lastRecordAt.get(turn.promptUuid) ?? 0,
          nextTurnOpensAt(pending.turns, userRows, index)
        ),
        path,
        report
      );
    }
    if (captured) {
      // Issue #2437: History now holds this turn as the agent's own Markdown.
      // Park the pre-send flush's cursor past the pane rows it covers, or a
      // `/send` arriving before the next poll tick saves the whole finished turn
      // a second time.
      await advanceCapturedLineForTranscriptTurn(target);
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
 *    record, so a turn whose prompt fell outside the window is not in `turns` at
 *    all and cannot be backfilled from its middle. Its records are counted as
 *    `orphanedAssistantRecords` instead, which is what the caller reports. Since
 *    Issue #2470 the window can be wider than {@link CLAUDE_TRANSCRIPT_TAIL_BYTES}
 *    — widened only because the newest turn's prompt was not in the first one —
 *    and the rule is the same over it: an older turn the wider read happens to
 *    bring in is a candidate like any other, and one whose prompt is still
 *    outside is not.
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
   * {@link CLAUDE_TRANSCRIPT_TAIL_BYTES}. #2121 left that turn unwritten. Since
   * Issue #2470 the writer reads further back for its prompt once the turn has
   * ended, and saves the readable end under a key of its own when even that
   * fails; this reader does neither (see {@link readClaudeTurnProgress} for
   * why), so while the turn runs the readable tail is published and marked,
   * because a reply shown from the middle without saying so is worse than no
   * reply at all.
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
 *
 * Since Issue #2470 a row for the same turn usually does follow — under the
 * prompt's key once the writer has read back far enough to find it, or under
 * `claudeHeadlessTurnId` when it cannot — but never under this key, which is one
 * per session and must not be written: the session's second long turn would
 * find the first one's row and read "already saved".
 */
function headlessClaudeTurnKey(sessionId: string): string {
  return claudeTurnRequestId(`${CLAUDE_HEADLESS_TURN_ID_PREFIX}${sessionId}`);
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
 *
 * The writer's counterpart is `buildHeadlessClaudeTurn` (Issue #2470), and the
 * two are kept apart on purpose. That one is keyed on the record that closed
 * the turn, reads `closed` off it, and keeps the turn's *end* when the block cap
 * bites; this one keeps the first window's first blocks, as the live bubble
 * always has, and its accumulator still never reaches a writer.
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
 * **Not widened (Issue #2470).** The writer reads further back than
 * {@link CLAUDE_TRANSCRIPT_TAIL_BYTES} when a window holds no prompt record; this
 * reader deliberately does not, and keeps the one window and the `partial`
 * bubble. The Issue left the choice to a measurement, and the measurement is
 * about *when* the cost is paid rather than how big it is: a 64 MiB tail read
 * and parsed in 41 ms on 2026-09-11 against 3 ms for 4 MiB, which is nothing
 * once per finished turn and is a 10–40 ms stall of the server's event loop
 * **every second** here — this runs on each generating tick with a subscriber
 * (`CHAT_TURN_PROGRESS_MIN_INTERVAL_MS`), and the only turns that would widen are
 * the ones that generate longest. What the wider read would buy is the prompt's
 * key on the bubble instead of the partial marker; the reply itself is already
 * on screen, and the row the writer saves when the turn ends replaces it.
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

    const window = await readClaudeTranscriptTail(path);
    if (window === null) return null;

    // A fragment at the tail of a file being appended to is the normal case here
    // — this reader runs *while* Claude is writing — and `parseClaudeTranscript`
    // already counts it rather than throwing. Nothing extra is needed, and that
    // is the property `claude-transcript-progress-2199` pins.
    const parsed = parseClaudeTranscript(window.text);
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
 * **The turn's LAST assistant record, not its prompt (Issue #2273).** #2121
 * dated the reply by the prompt record's clock so that a row written a poll late
 * still sorted where the conversation put it, and #2196 moved it one millisecond
 * on so that `groupMessagesIntoPairs` — which orders by timestamp and nothing
 * else — could never return the answer above the question. Both properties
 * survive: `earliest` is a floor this never goes under.
 *
 * What neither accounted for is the row that lands BETWEEN the prompt and the
 * reply. A tool approval is written when the dialog appears, seconds into the
 * turn, and the chat surface orders its rows by timestamp — so a reply dated at
 * the turn's start draws ABOVE an approval that really happened before it. The
 * measured case is in the Issue: prompt `04:49:50.989Z`, reply `04:49:54.000Z`,
 * approval `04:49:57.513Z`, rendered as question → answer → approval.
 *
 * The turn's last assistant record is the moment the reply was finished, so
 * everything the turn produced on the way sorts before it. `lastRecordAt` is 0
 * when the window held no timestamped assistant record for the turn, and the row
 * is then dated exactly where #2196 put it.
 *
 * `nextTurnOpensAt` is the ceiling. The next turn's prompt row may be a `/send`
 * row written while THIS turn was still running — a queued prompt — and a reply
 * that overtook it would be paired with the wrong question.
 *
 * @param lastRecordAt - Epoch ms of the turn's last assistant record, or 0
 * @param nextTurnOpensAt - Epoch ms of the next turn's user row, or null when
 *   this is the newest turn in the window
 */
function resolveAssistantTimestampMs(
  turn: ClaudeTurnAccumulator,
  userRow: RecordedUserTurn,
  lastRecordAt = 0,
  nextTurnOpensAt: number | null = null
): number {
  const earliest =
    userRow.timestampMs === null
      ? turn.startedAt
      : Math.max(turn.startedAt, userRow.timestampMs + 1);
  const latest = nextTurnOpensAt === null ? Number.POSITIVE_INFINITY : nextTurnOpensAt - 1;
  return Math.max(earliest, Math.min(lastRecordAt, latest));
}

/**
 * When each turn's last assistant record was written (Issue #2273).
 *
 * Keyed by `promptUuid`, which is the turn key {@link buildClaudeTurns} uses, and
 * walked over the same records with the same two rules — sidechains skipped, a
 * prompt record opening a turn — so the two passes cannot disagree about which
 * turn a record belongs to. It is a second pass rather than a field on the
 * accumulator because `./transcript` is not this Issue's to change.
 *
 * Only `assistant` records count. A turn's `user` records are its tool RESULTS,
 * and the last of those is a step the agent took before it had finished
 * answering; the reply is dated by the agent's last word.
 *
 * @returns `promptUuid` → epoch ms; absent for a turn with no timestamped
 *   assistant record
 */
function lastClaudeAssistantRecordAt(
  records: readonly ClaudeTranscriptRecord[]
): Map<string, number> {
  const at = new Map<string, number>();
  let key: string | null = null;

  for (const record of records) {
    if (record.isSidechain) continue;
    if (isClaudePromptRecord(record)) {
      key = record.uuid;
      continue;
    }
    if (record.type !== 'assistant' || key === null || record.timestampMs === null) continue;
    if (record.timestampMs > (at.get(key) ?? 0)) at.set(key, record.timestampMs);
  }

  return at;
}

/**
 * The instant the next pending turn's prompt row carries, or null (Issue #2273).
 *
 * The user row's own timestamp when there is one, because that is what History
 * sorts on and it can be EARLIER than the turn's start — an adopted `/send` row
 * was written when CommandMate handed the text to the pane, which for a queued
 * prompt is while the previous turn was still running. The turn's start is the
 * fallback for a turn that produced no row at all.
 */
function nextTurnOpensAt(
  turns: readonly ClaudeTurnAccumulator[],
  userRows: readonly RecordedUserTurn[],
  index: number
): number | null {
  const next = turns[index + 1];
  if (!next) return null;
  return userRows[index + 1]?.timestampMs ?? next.startedAt;
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

/** `\n`, which in UTF-8 is one byte and never part of another character. */
const LINE_FEED = 0x0a;

/** A run of whole lines read out of a transcript (Issue #2470). */
interface ClaudeTranscriptSpan {
  /** The lines, decoded as UTF-8, with a windowed read's cut first line dropped. */
  readonly text: string;
  /** Where {@link text} starts in the file; 0 once a read has reached the start. */
  readonly startByte: number;
}

/** The span at the end of the file, and how big the file was when it was read. */
interface ClaudeTranscriptWindow extends ClaudeTranscriptSpan {
  /** The file's size when it was opened. Every later read of one ask stops here. */
  readonly size: number;
}

/**
 * The last {@link CLAUDE_TRANSCRIPT_TAIL_BYTES} of the file, as UTF-8.
 *
 * Read at an offset rather than whole, and the first line of a windowed read is
 * dropped: starting mid-line would hand `parseClaudeTranscript` a fragment that
 * it would count as malformed anyway, and dropping it deliberately keeps that
 * counter meaning "the writer was mid-append", which is the thing worth seeing.
 *
 * Since Issue #2470 the cut line is found by its byte rather than its
 * character, because the window now says where its text starts and a read
 * further back continues from there. The text is the same either way: the line
 * feed is one byte that no other character contains, so decoding what follows
 * it gives exactly what decoding the whole window and slicing after it did.
 *
 * @returns The window, or null when the file could not be read
 */
async function readClaudeTranscriptTail(path: string): Promise<ClaudeTranscriptWindow | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const offset = Math.max(0, size - CLAUDE_TRANSCRIPT_TAIL_BYTES);
    const length = size - offset;
    if (length <= 0) return { text: '', size, startByte: 0 };

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    if (offset === 0) return { text: bytes.toString('utf8'), size, startByte: 0 };

    const firstBreak = bytes.indexOf(LINE_FEED);
    if (firstBreak === -1) return { text: '', size, startByte: size };
    return {
      text: bytes.subarray(firstBreak + 1).toString('utf8'),
      size,
      startByte: offset + firstBreak + 1,
    };
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
 * The whole lines of `[from, to)`, for a read continuing in front of one whose
 * text started at `to` (Issue #2470).
 *
 * `to` is always the start of a line — it is where the previous read's text
 * began — so the only line that can be cut is the one at `from`, and it is
 * dropped for the reason {@link readClaudeTranscriptTail} drops it.
 *
 * @returns The span, or null when fewer bytes came back than were asked for —
 *   the file is no longer the one the reads before this were taken from
 */
async function readClaudeTranscriptSpan(
  handle: FileHandle,
  from: number,
  to: number
): Promise<ClaudeTranscriptSpan | null> {
  const length = to - from;
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, from);
  if (bytesRead !== length) return null;
  if (from === 0) return { text: buffer.toString('utf8'), startByte: 0 };

  const firstBreak = buffer.indexOf(LINE_FEED);
  if (firstBreak === -1) return { text: '', startByte: to };
  return { text: buffer.subarray(firstBreak + 1).toString('utf8'), startByte: from + firstBreak + 1 };
}

/** What {@link readClaudeTranscriptTurns} answers. */
interface ClaudeTranscriptTurnsRead {
  readonly parsed: ClaudeTranscriptParse;
  readonly built: ClaudeTurnBuild;
  /** The file's size when it was opened. */
  readonly size: number;
  /** Where the parsed text starts in the file. */
  readonly startByte: number;
  /**
   * True when the read stopped at {@link CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES} with
   * file still in front of it and no prompt record found: the newest turn's
   * prompt record, if it has one, is further back than this reader goes.
   */
  readonly reachedLimit: boolean;
}

/**
 * The transcript's last records, read back far enough to hold the newest turn's
 * prompt record where that is possible (Issue #2470).
 *
 * The first read is {@link readClaudeTranscriptTail} and nothing else, and for a
 * window holding a prompt record anywhere that is the whole of it: the records
 * and the turns are exactly what they were before #2470. Only a window of
 * orphaned assistant records and no prompt record is read further back — see
 * {@link extendClaudeTranscriptRead}.
 *
 * @returns The records and turns, or null when the file could not be read
 */
async function readClaudeTranscriptTurns(
  target: AgentInstanceRef,
  path: string,
  sessionId: string
): Promise<ClaudeTranscriptTurnsRead | null> {
  const window = await readClaudeTranscriptTail(path);
  if (window === null) return null;

  const parsed = parseClaudeTranscript(window.text);
  const built = buildClaudeTurns(parsed.records, sessionId);
  const read: ClaudeTranscriptTurnsRead = {
    parsed,
    built,
    size: window.size,
    startByte: window.startByte,
    reachedLimit: false,
  };
  if (built.turns.length > 0 || built.orphanedAssistantRecords === 0 || window.startByte === 0) {
    return read;
  }
  // A read further back that fails leaves the first window's answer standing,
  // which is the pre-#2470 answer: no turn, and the scraper keeps it.
  return (await extendClaudeTranscriptRead(target, path, sessionId, read)) ?? read;
}

/**
 * Double the window until the newest turn's prompt record is in it (Issue #2470).
 *
 * 8, 16, 32, 64 MiB, stopping at the first size that brings a prompt record in,
 * at the start of the file, or at {@link CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES}. One
 * sequence per ask, and one `claude-transcript-window-extended` line for it.
 *
 * Each step reads only the bytes in front of the previous one and puts their
 * records in front of the records already parsed, so the cost of reaching a
 * prompt 20 MiB back is one read of 20-odd MiB, not four overlapping ones. That
 * is sound because the file is append-only and every read of one ask is bounded
 * by the size it was first opened at: the bytes already read do not change. It
 * also means the newest prompt record, once there is one, is in the span just
 * read — nothing behind it held one — which is where its offset is looked up.
 *
 * @returns The widened read, or null when a read failed part-way
 */
async function extendClaudeTranscriptRead(
  target: AgentInstanceRef,
  path: string,
  sessionId: string,
  first: ClaudeTranscriptTurnsRead
): Promise<ClaudeTranscriptTurnsRead | null> {
  const { size } = first;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    let records = first.parsed.records;
    let malformedLines = first.parsed.malformedLines;
    let built = first.built;
    let startByte = first.startByte;
    let windowBytes = CLAUDE_TRANSCRIPT_TAIL_BYTES;
    let promptOffsetFromEnd: number | null = null;

    while (
      built.turns.length === 0 &&
      startByte > 0 &&
      windowBytes < CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES
    ) {
      windowBytes *= 2;
      const span = await readClaudeTranscriptSpan(handle, Math.max(0, size - windowBytes), startByte);
      if (span === null) return null;

      const prefix = parseClaudeTranscript(span.text);
      records = [...prefix.records, ...records];
      malformedLines += prefix.malformedLines;
      startByte = span.startByte;
      built = buildClaudeTurns(records, sessionId);

      const newest = built.turns.at(-1);
      if (newest) promptOffsetFromEnd = claudeRecordOffsetFromEnd(span, newest.promptUuid, size);
    }

    logger.info('claude-transcript-window-extended', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      path,
      fromBytes: CLAUDE_TRANSCRIPT_TAIL_BYTES,
      toBytes: windowBytes,
      size,
      // Null when no prompt record was found; see `reachedLimit`.
      promptOffsetFromEnd,
      records: records.length,
    });

    return {
      parsed: { records, malformedLines },
      built,
      size,
      startByte,
      reachedLimit: built.turns.length === 0 && startByte > 0,
    };
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
 * How far from the end of the file the line holding this record starts, or null.
 *
 * The number `claude-transcript-window-extended` reports, and nothing branches
 * on it: it says how much bigger than the first window the turn was. A line is
 * accepted only once it parses as the record with this `uuid`, because the same
 * string is also the next record's `parentUuid`.
 */
function claudeRecordOffsetFromEnd(
  span: ClaudeTranscriptSpan,
  uuid: string,
  size: number
): number | null {
  const { text } = span;
  for (let at = text.indexOf(uuid); at !== -1; at = text.indexOf(uuid, at + uuid.length)) {
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const lineEnd = text.indexOf('\n', at);
    let record: ClaudeTranscriptRecord | null = null;
    try {
      record = readClaudeTranscriptRecord(
        JSON.parse(text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd))
      );
    } catch {
      // Not a whole record; keep looking.
    }
    if (record?.uuid === uuid) {
      return size - span.startByte - Buffer.byteLength(text.slice(0, lineStart), 'utf8');
    }
  }
  return null;
}

/** A turn with no prompt record writes no user row; see {@link recordClaudeUserTurn}. */
const NO_USER_ROW: RecordedUserTurn = { outcome: 'skipped', messageId: null, timestampMs: null };

/**
 * Save what can be read of a turn whose prompt record is out of reach (Issue #2470).
 *
 * The safety net under {@link CLAUDE_TRANSCRIPT_MAX_TAIL_BYTES}: the window has
 * been widened as far as it goes and still holds no prompt record, so there is
 * no prompt `uuid` to key a row on and no user row to write. What the window
 * does hold is the turn's end — the part the operator most wants, and the part a
 * long turn's pane has scrolled furthest past — and this writes that rather than
 * leave the turn with no row at all. The body opens with
 * {@link CLAUDE_TURN_HEAD_MISSING_MARKER}, so it never reads as the whole reply.
 *
 * Everything that makes a prompt-opened row safe to write applies unchanged,
 * because the row goes through the same {@link writeClaudeTurn}: an open turn is
 * refused and reported `not_yet_closed` (#2264, #2436), an empty one is handed
 * back to the scraper, and a second read finds the row by its key and answers
 * true. The key is the one difference, and {@link buildHeadlessClaudeTurn} says
 * why it can be written under at all: it names the record that closed the turn,
 * which every later read sees too.
 *
 * Neither the live bubble's body nor its key. {@link collectHeadlessClaudeTurn}
 * builds the bubble from the first window under the session's one live key, and
 * that key, written, would make the session's next long turn read "already
 * saved".
 *
 * @returns Whether History now holds the turn, marked as missing its beginning
 */
async function captureHeadlessClaudeTurn(
  target: AgentInstanceRef,
  records: readonly ClaudeTranscriptRecord[],
  sessionId: string,
  path: string,
  report?: StructuredHistoryCaptureReport
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  const headless = buildHeadlessClaudeTurn(records, sessionId);
  if (headless === null) {
    logger.debug('claude-transcript-headless-unkeyed', {
      worktreeId: target.worktreeId,
      instanceId,
      path,
    });
    return false;
  }

  const { turn } = headless;
  const rendered = renderClaudeTurn(turn);
  logger.info('claude-transcript-headless-turn', {
    worktreeId: target.worktreeId,
    instanceId,
    sessionId: turn.sessionId,
    requestId: claudeTurnRequestId(turn.promptUuid),
    path,
    assistantRecords: turn.assistantRecords,
    overflowed: turn.overflowed,
  });

  const captured = await writeClaudeTurn(
    target,
    turn,
    // An empty body stays empty, so the writer hands the turn back to the
    // scraper instead of saving a row that is nothing but the marker.
    rendered.body.length === 0 ? rendered : markClaudeTurnHeadMissing(rendered),
    resolveAssistantTimestampMs(turn, NO_USER_ROW, headless.lastRecordAt, null),
    path,
    report
  );
  if (captured) {
    // Issue #2437, for the reason the prompt-opened path gives.
    await advanceCapturedLineForTranscriptTurn(target);
  }
  return captured;
}

/**
 * A rendered turn with {@link CLAUDE_TURN_HEAD_MISSING_MARKER} as its first line.
 *
 * Held to {@link MAX_CLAUDE_TURN_BODY_LENGTH} the way `renderClaudeTurn` holds
 * every body, so a turn already cut at its end is still cut the same way.
 */
function markClaudeTurnHeadMissing(rendered: ClaudeRenderedTurn): ClaudeRenderedTurn {
  let body = `${CLAUDE_TURN_HEAD_MISSING_MARKER}\n\n${rendered.body}`;
  if (body.length > MAX_CLAUDE_TURN_BODY_LENGTH) {
    body =
      body.slice(0, MAX_CLAUDE_TURN_BODY_LENGTH - CLAUDE_TURN_TRUNCATION_MARKER.length) +
      CLAUDE_TURN_TRUNCATION_MARKER;
  }
  return { ...rendered, body };
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
 * record's `uuid` — or, for a turn whose prompt record is out of reach (Issue
 * #2470), from the record that closed it (`claudeHeadlessTurnId`) — and neither
 * changes between reads of the same file.
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
  path: string,
  report?: StructuredHistoryCaptureReport
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

  // Issue #2436: the caller's report is about the turn THIS call is deciding.
  // The loop above walks oldest-first, so a verdict left by an earlier turn has
  // to be cleared before this one's is written.
  if (report) report.outcome = undefined;

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
    if (report) report.outcome = 'not_yet_closed';
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
