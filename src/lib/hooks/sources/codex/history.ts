/**
 * Writing codex's own words into conversation history (Issue #2197).
 *
 * The codex half of the stand-down `lib/polling/structured-history-gate`
 * arbitrates, on exactly the terms `../claude/history` established for Claude
 * Code in #2121: the poller captures the pane and cleans it, this reads the
 * agent's own transcript, and the two are mutually exclusive because
 * {@link captureCodexTranscriptTurn} answers whether it wrote the turn.
 *
 * ## Pull, like claude — with a pointer codex hands over itself
 *
 * There is no connection to subscribe to. codex appends every record of a
 * session to `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<local time>-<session
 * id>.jsonl` as it goes, and the trigger to read it has to come from whatever
 * already knows a turn just ended — the poller.
 *
 * Which file is this instance's is the same question #2121 answered for claude,
 * and it has a better answer here. **The session id is a mutable pointer, not a
 * key**: identity stays the (worktree, tool, instance) triple `buildCompositeKey`
 * spells, and the session id only answers "which rollout does that triple point
 * at *right now*". `/new` changing it is correct rather than a problem, because
 * the conversation really did change — measured on codex-cli 0.151.0, where
 * `/new` minted a new `session_id`, opened a new rollout file and fired a second
 * `SessionStart` hook carrying it.
 *
 * Three consequences, all measured (`docs/design/codex-transcript-reader.md` §3):
 *
 *  - **The hook's `session_id` is the rollout file's own uuid.** Verified on
 *    three live sessions: the id on every `SessionStart` / `UserPromptSubmit` /
 *    `Stop` payload was byte-identical to the uuid in the file name, and the
 *    payload's `transcript_path` was the absolute path of that same file.
 *  - **Two codex instances in one worktree do not collide.** They share a `cwd`,
 *    so a cwd-based guess would hand `codex-2`'s turn to `codex`; they do not
 *    share a session id. Verified by running two codex processes in one
 *    directory: two session ids, two files. This is why there is no cwd
 *    fallback here — see {@link resolveCodexSessionId}.
 *  - **A session with no pointer is left to the scraper.** No hooks configured,
 *    hooks configured but never trusted (codex skips untrusted hooks in
 *    silence — #1757 P4), or a server restarted mid-session: all three produce
 *    no pointer, and this module answers false for them. That is the fail-open
 *    the acceptance criteria ask for.
 *
 * ## Nothing here throws
 *
 * Same contract as the other two readers, for the same reason: this runs inside
 * the poller's save path, and an exception would cost the scraped reply *as well
 * as* the structured one. The database imports are dynamic so that
 * `better-sqlite3` does not enter the module graph of everything that imports
 * `@/lib/hooks/sources`.
 *
 * @module lib/hooks/sources/codex/history
 */

import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { readTranscriptTail, TRANSCRIPT_TAIL_BYTES } from '@/lib/history/transcript-tail';
import {
  recordUserTurn,
  type RecordedUserTurn,
  type RecordUserTurnOptions,
} from '@/lib/history/user-turn-recorder';
import { createLogger } from '@/lib/logger';
import { codexPromptRequestId, codexTurnRequestId } from '@/types/agent-transcript';
import type { AgentInstanceRef } from '../types';
import {
  buildCodexTurns,
  CODEX_ROLLOUT_EXTENSION,
  CODEX_SESSIONS_DIR_SEGMENTS,
  parseCodexRollout,
  renderCodexTurn,
  type CodexRenderedTurn,
  type CodexRolloutRecord,
  type CodexTurnAccumulator,
} from './transcript';

const logger = createLogger('lib/hooks/sources/codex/history');

/**
 * How much of the rollout's tail is read.
 *
 * The shared bound, named here so codex's reader states it the way claude's
 * does. The largest rollout on this machine on 2026-09-01 was 273 MB, which is
 * an order of magnitude past claude's worst case and the reason the window is
 * not optional.
 */
export const CODEX_TRANSCRIPT_TAIL_BYTES = TRANSCRIPT_TAIL_BYTES;

/** `$CODEX_HOME`, honoured so a sandboxed codex stays sandboxed. */
export const CODEX_HOME_ENV_VAR = 'CODEX_HOME';

/** `~/.codex` — where codex keeps its state when `$CODEX_HOME` is unset. */
export const CODEX_DEFAULT_HOME_SEGMENT = '.codex';

/** `rollout-` — the prefix codex puts on every session file. */
export const CODEX_ROLLOUT_FILE_PREFIX = 'rollout-';

/**
 * How deep under `sessions/` a rollout file may sit.
 *
 * `<year>/<month>/<day>/<file>` is the observed layout on every one of the 1,791
 * files on this machine, which is three directory levels. The bound is stated so
 * that a scan cannot walk an arbitrary tree if codex ever puts something else
 * under `sessions/`.
 */
export const CODEX_SESSIONS_MAX_DEPTH = 4;

/**
 * The shape a codex session id has, and the only shape this reader will look up.
 *
 * A UUID, which is what codex mints (a v7, so the ids sort by time). The check
 * is not cosmetic: the value reaches a file-name comparison, and an id carrying
 * `/` or `..` would otherwise be a path expression. Everything that fails it is
 * treated as "no pointer", which falls through to the scraper.
 */
const CODEX_SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

declare global {
  // eslint-disable-next-line no-var
  var __codexTranscriptSessions: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __codexTranscriptPaths: Map<string, string> | undefined;
}

/**
 * The last session id seen for each instance.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and the hook receiver's bundle would each
 * get a private copy of a module-scoped map, one would write and the other would
 * read, and every lookup would answer null with no error at all.
 *
 * A latch and not a cache: `getLastAgentEvent` holds only the newest event, and
 * codex sends `session_id` on every event it delivers — but a future one that
 * did not would otherwise blank the pointer mid-session.
 */
const sessionPointers = (globalThis.__codexTranscriptSessions ??= new Map<string, string>());

/**
 * Where each session id's rollout file was found.
 *
 * Keyed by `<codexHome>\0<sessionId>`, and a memo rather than a source of truth:
 * every hit is re-`stat`ed before it is used. It exists because the lookup is a
 * directory scan — codex names the file after the *local* wall-clock time the
 * session started, which is not derivable from the id — and a scan of 1,791
 * files on every finished turn is not something to do twice.
 */
const rolloutPaths = (globalThis.__codexTranscriptPaths ??= new Map<string, string>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/** Forget every instance's pointer and every memoised path. Test seam. */
export function resetCodexTranscriptSessions(): void {
  sessionPointers.clear();
  rolloutPaths.clear();
}

/**
 * The session id this instance's rollout is under, or null.
 *
 * Reads the structured event state first and falls back to the latched value.
 * The import is dynamic so that `agent-event-state`'s module graph does not
 * become a static dependency of the poller.
 *
 * **There is deliberately no fallback below this.** The obvious one — take the
 * newest rollout whose `cwd` is this worktree — is wrong in the case the
 * feature exists for: `codex` and `codex-2` in one worktree share a `cwd`, so
 * the newest file is whichever of them answered last, and the primary's turn
 * would be filed under the second's conversation. No pointer means the scraper
 * keeps being the only record, which is merely the status quo.
 */
export async function resolveCodexSessionId(target: AgentInstanceRef): Promise<string | null> {
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
    logger.debug('codex-transcript-session-lookup-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return sessionPointers.get(key) ?? null;
}

/**
 * `$CODEX_HOME`, or `~/.codex`.
 *
 * @param env - The environment to read; `Record` rather than `NodeJS.ProcessEnv`
 *   so a caller can pass the two variables that matter instead of a whole one
 */
export function resolveCodexHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env[CODEX_HOME_ENV_VAR];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return join(homedir(), CODEX_DEFAULT_HOME_SEGMENT);
}

/** `<codexHome>/sessions`. */
export function codexSessionsRoot(codexHome: string): string {
  return join(codexHome, ...CODEX_SESSIONS_DIR_SEGMENTS);
}

/**
 * A rollout path named by something other than this module, accepted only if it
 * really is one.
 *
 * The same three conditions `acceptClaudeTranscriptHint` applies, for the same
 * reasons: it must be under `<codexHome>/sessions`, so nothing can make this
 * open `/etc/passwd`; it must end in `.jsonl`; and it must carry no NUL.
 * Containment is checked on the *resolved* path so that `..` cannot climb out,
 * and `resolve` is safe here — unlike in `validateHookCwd`, where the value is
 * echoed back — because the resolved string is the only thing ever used.
 *
 * @returns The resolved path, or null when it is not acceptable
 */
export function acceptCodexRolloutPath(codexHome: string, candidate: string): string | null {
  if (!candidate.endsWith(CODEX_ROLLOUT_EXTENSION)) return null;
  if (candidate.includes('\0')) return null;
  const root = resolve(codexSessionsRoot(codexHome));
  const resolved = resolve(candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

/** Whether a file name is the rollout of this session. */
export function isCodexRolloutFileFor(name: string, sessionId: string): boolean {
  return (
    name.startsWith(CODEX_ROLLOUT_FILE_PREFIX) &&
    name.endsWith(`-${sessionId}${CODEX_ROLLOUT_EXTENSION}`)
  );
}

/**
 * Find this session's rollout file under `<codexHome>/sessions`.
 *
 * A scan, because the file name embeds the **local** wall-clock time the session
 * started (`rollout-2026-09-01T10-08-39-<uuid>.jsonl` for a session whose own
 * `timestamp` is `01:08:53Z`), so the directory and the name cannot be computed
 * from the id. Directories are walked newest-modified first, which puts today's
 * date directory first and makes the common case a two-level descent.
 *
 * @returns The absolute path, or null when nothing under the root matches
 */
export async function findCodexRolloutPath(
  codexHome: string,
  sessionId: string,
  depth: number = CODEX_SESSIONS_MAX_DEPTH
): Promise<string | null> {
  if (!CODEX_SESSION_ID_PATTERN.test(sessionId)) return null;
  return scanForRollout(codexSessionsRoot(codexHome), sessionId, depth);
}

async function scanForRollout(
  dir: string,
  sessionId: string,
  depth: number
): Promise<string | null> {
  if (depth <= 0) return null;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A root that does not exist is a session this reader cannot see, which is
    // the same answer as a session with no file: null, and the scraper keeps it.
    return null;
  }

  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      if (isCodexRolloutFileFor(entry.name, sessionId)) return join(dir, entry.name);
      continue;
    }
    if (entry.isDirectory()) directories.push(entry.name);
  }

  // Newest first: the layout is <year>/<month>/<day>, so descending name order
  // is descending date order without a `stat` per directory.
  directories.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const name of directories) {
    const found = await scanForRollout(join(dir, name), sessionId, depth - 1);
    if (found) return found;
  }
  return null;
}

/** What {@link captureCodexTranscriptTurn} needs from its caller. */
export interface CodexTranscriptCapture {
  /**
   * Test seam; defaults to `$CODEX_HOME`, else `~/.codex`.
   *
   * Honouring the environment variable is not a convenience: `CODEX_HOME` is the
   * only per-invocation isolation codex has (#1757 §5.1.2), and a CommandMate
   * started with one set is pointing every codex it launches at that directory.
   */
  readonly codexHome?: string;
}

/**
 * Read this instance's unwritten turns out of its rollout and write them.
 *
 * **Every turn in the window that is not already a row**, oldest first, which is
 * the shape Issue #2246 gave all three pull readers and the reasoning for it is
 * written out once on `../claude/history`'s
 * {@link captureClaudeTranscriptTurn}. The short version: this reader only runs
 * when the poller judges a turn finished, so a missed judgement used to lose a
 * turn permanently — by the next judgement "the newest turn" had moved on.
 *
 * #2121's one-row-per-turn argument is preserved by the **anchor**: the newest
 * turn in the window this reader has already written is where the backfill
 * starts, and a window with no anchor falls back to the newest turn alone.
 *
 * The return value is the poller's instruction, and it is about the **newest**
 * turn whatever else was written on the way. **True** means History holds
 * this turn as the agent's own Markdown and the scrape must be dropped. **False**
 * means it does not, for any reason at all — no session pointer, no file, an
 * unreadable file, a turn codex has not closed yet — and the scrape must be
 * saved. Everything that can go wrong answers false: two writers duplicate a
 * reply, no writer loses one.
 *
 * The user rows are written even when the assistant row is not, and that is
 * deliberate rather than an oversight. A prompt the operator typed into `tmux
 * attach` is the thing #2196 exists to record, and it is worth recording next to
 * a *scraped* reply just as much as next to a Markdown one.
 *
 * Never throws.
 *
 * @param target - The instance whose turn just ended
 * @param capture - See {@link CodexTranscriptCapture}
 * @returns Whether History now holds this turn as the agent's own Markdown
 */
export async function captureCodexTranscriptTurn(
  target: AgentInstanceRef,
  capture: CodexTranscriptCapture = {}
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const codexHome = capture.codexHome ?? resolveCodexHome();

    const sessionId = await resolveCodexSessionId(target);
    if (!sessionId) {
      logger.debug('codex-transcript-unavailable', {
        worktreeId: target.worktreeId,
        instanceId,
        reason: 'no-session-pointer',
      });
      return false;
    }

    const path = await locateCodexRollout(codexHome, sessionId);
    if (!path) {
      logger.debug('codex-transcript-unavailable', {
        worktreeId: target.worktreeId,
        instanceId,
        sessionId,
        reason: 'no-file',
      });
      return false;
    }

    const text = await readTranscriptTail(path);
    if (text === null) return false;

    const parsed = parseCodexRollout(text);
    const built = buildCodexTurns(parsed.records, sessionId);
    if (built.turns.length === 0) {
      logger.info('codex-transcript-no-turn', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        records: parsed.records.length,
        malformedLines: parsed.malformedLines,
        duplicateStreamRecords: built.duplicateStreamRecords,
      });
      return false;
    }

    if (parsed.malformedLines > 0) {
      // Expected in small numbers — a fragment at the tail of a file being
      // appended to — and the kind of thing that must be visible when it stops
      // being small.
      logger.info('codex-transcript-partial-read', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        malformedLines: parsed.malformedLines,
        turnlessRecords: built.turnlessRecords,
        duplicateStreamRecords: built.duplicateStreamRecords,
      });
    }

    const pending = await selectUnwrittenCodexTurns(target, built.turns);
    if (pending.turns.length === 0) {
      logger.debug('codex-transcript-turns-already-saved', {
        worktreeId: target.worktreeId,
        instanceId,
        turnsInWindow: built.turns.length,
      });
      return true;
    }

    if (pending.turns.length > 1) {
      logger.info('codex-transcript-backfilling-turns', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        pendingTurns: pending.turns.length,
        turnsInWindow: built.turns.length,
        anchored: pending.anchored,
      });
    }

    // Every prompt row first, then every reply (Issue #2273). The two passes are
    // what let a reply be dated at its turn's END without overtaking the NEXT
    // turn's prompt: a queued `/send` row is written while this turn is still
    // running, so its instant is only knowable once that row has been recorded.
    // With one turn pending — the ordinary case — this is the single call it
    // always was.
    const userRows: RecordedUserTurn[] = [];
    for (let index = 0; index < pending.turns.length; index += 1) {
      const previousStartedAt =
        index === 0 ? pending.previousStartedAt : pending.turns[index - 1].startedAt;
      userRows.push(await recordCodexUserTurns(target, pending.turns[index], previousStartedAt));
    }

    const lastRecordAt = lastCodexRecordAt(parsed.records);
    let captured = false;
    for (let index = 0; index < pending.turns.length; index += 1) {
      const turn = pending.turns[index];
      captured = await writeCodexTurn(
        target,
        turn,
        renderCodexTurn(turn),
        resolveAssistantTimestampMs(
          turn,
          userRows[index],
          lastRecordAt.get(turn.turnId) ?? 0,
          nextTurnOpensAt(pending.turns, userRows, index)
        ),
        path
      );
    }
    return captured;
  } catch (error) {
    logger.error('codex-transcript-capture-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The rollout file this instance would be read from, or null (Issue #2246).
 *
 * The same two steps {@link captureCodexTranscriptTurn} opens with, asked
 * without reading or writing anything; see `../claude/history`'s
 * {@link resolveClaudeTranscriptPath} for what the Stop receiver does with it.
 *
 * Never throws.
 */
export async function resolveCodexTranscriptPath(
  target: AgentInstanceRef,
  capture: CodexTranscriptCapture = {}
): Promise<string | null> {
  try {
    const sessionId = await resolveCodexSessionId(target);
    if (!sessionId) return null;
    return await locateCodexRollout(capture.codexHome ?? resolveCodexHome(), sessionId);
  } catch {
    return null;
  }
}

/** What {@link selectUnwrittenCodexTurns} answers. */
interface PendingCodexTurns {
  /** The turns to write, oldest first. Empty when the newest one is a row. */
  readonly turns: readonly CodexTurnAccumulator[];
  /** `startedAt` of the turn before the first pending one, or 0. */
  readonly previousStartedAt: number;
  /** Whether a written turn was found in the window. Logged, never branched on. */
  readonly anchored: boolean;
}

/**
 * The turns {@link captureCodexTranscriptTurn} still has to write (Issue #2246).
 *
 * The same rule as `../claude/history`'s, on codex's own key: search backwards
 * from the newest turn for one that is already a row, and take everything after
 * it. Record order and never a timestamp, and bounded by the window — a turn
 * whose records fell outside {@link CODEX_TRANSCRIPT_TAIL_BYTES} is not in `turns`.
 *
 * @param turns - Every turn in the window, oldest first
 */
async function selectUnwrittenCodexTurns(
  target: AgentInstanceRef,
  turns: readonly CodexTurnAccumulator[]
): Promise<PendingCodexTurns> {
  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const requestId = codexTurnRequestId(turns[index].turnId);
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

/**
 * The rollout file for this session, or null.
 *
 * The memo first, the scan second, and the filesystem is the arbiter of both:
 * "the path we found last time" and "the path that exists" differ the moment
 * codex rotates or the operator clears a session directory.
 */
async function locateCodexRollout(codexHome: string, sessionId: string): Promise<string | null> {
  const memoKey = `${codexHome}\0${sessionId}`;
  const memoised = rolloutPaths.get(memoKey);
  if (memoised && (await isReadableFile(memoised))) return memoised;
  if (memoised) rolloutPaths.delete(memoKey);

  const found = await findCodexRolloutPath(codexHome, sessionId);
  if (!found) return null;

  const accepted = acceptCodexRolloutPath(codexHome, found);
  if (!accepted) return null;

  rolloutPaths.set(memoKey, accepted);
  return accepted;
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Record every prompt this turn answers, before the reply is written (#2196).
 *
 * One row per `UserMessage` item rather than one per turn: codex folds a prompt
 * submitted while a turn is running into that same turn, so a turn can carry
 * several, and `codexPromptRequestId` is keyed on the item's own id so that each
 * of them is written once and recognised on a re-read.
 *
 * Ordering is why this runs before the assistant row rather than inside
 * {@link writeCodexTurn}: the user row has to exist first so that
 * {@link resolveAssistantTimestampMs} can put the reply after it, and so that a
 * browser watching the broadcast sees a prompt appear and then an answer.
 *
 * Never throws; `recordUserTurn` reports its failures in the return value.
 *
 * @returns The last row written or found, for the timestamp
 */
async function recordCodexUserTurns(
  target: AgentInstanceRef,
  turn: CodexTurnAccumulator,
  previousStartedAt = 0
): Promise<RecordedUserTurn> {
  const instanceId = target.instanceId ?? target.cliToolId;
  let last: RecordedUserTurn = { outcome: 'skipped', messageId: null, timestampMs: null };
  // Issue #2246: a turn read late is a turn whose `/send` row may be older than
  // #2196's symmetric window reaches. The previous turn's start is the tightest
  // honest bound, and it only ever widens the search.
  const adoption: RecordUserTurnOptions =
    previousStartedAt > 0 ? { adoptionFromMs: previousStartedAt } : {};

  for (const prompt of turn.prompts) {
    const recorded = await recordUserTurn(
      target,
      codexPromptRequestId(prompt.itemId),
      prompt.text,
      prompt.timestampMs,
      adoption
    );
    if (recorded.outcome === 'failed') {
      logger.warn('codex-transcript-user-turn-failed', {
        worktreeId: target.worktreeId,
        instanceId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        promptItemId: prompt.itemId,
      });
      continue;
    }
    last = recorded;
  }

  return last;
}

/**
 * When the assistant row for this turn is dated.
 *
 * **The turn's LAST record, not its first (Issue #2273).** #2197 dated the reply
 * by the first record bearing the `turn_id` so that a row written a poll late
 * still sorted where the conversation put it, and #2196 moved it one millisecond
 * past the last prompt so that `groupMessagesIntoPairs` — which orders by
 * timestamp and nothing else — could never return the answer above the question.
 * Both properties survive: `earliest` is a floor this never goes under, and for
 * codex it is the floor that matters most, because a turn can carry SEVERAL
 * prompts (measured at more than one on 23 of 326 archived turns) and the reply
 * has to sort past all of them.
 *
 * What neither accounted for is the row that lands BETWEEN the prompt and the
 * reply. A tool approval is written when the dialog appears, seconds into the
 * turn, and the chat surface orders its rows by timestamp — so a reply dated at
 * the turn's start draws ABOVE an approval that really happened before it. The
 * turn's last record — for codex, the `task_complete` that closes it — is the
 * moment the turn ended, so everything it produced on the way sorts before it.
 *
 * `nextTurnOpensAt` is the ceiling. The next turn's prompt row may be a `/send`
 * row written while THIS turn was still running — a queued prompt — and a reply
 * that overtook it would be paired with the wrong question.
 *
 * @param lastRecordAt - Epoch ms of the turn's last record, or 0 when unknown
 * @param nextTurnOpensAt - Epoch ms of the next turn's user row, or null when
 *   this is the newest turn in the window
 */
function resolveAssistantTimestampMs(
  turn: CodexTurnAccumulator,
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
 * When each turn's last record was written (Issue #2273).
 *
 * Keyed by `turn_id` and walked over the same records {@link buildCodexTurns}
 * walks, with the same `response_item` exclusion — that stream is codex's
 * duplicate of the same events and counting it would be counting each record
 * twice. It is a second pass rather than a field on the accumulator because
 * `./transcript` is not this Issue's to change.
 *
 * Every record of the turn counts, `task_complete` included: that one IS the
 * turn's end and is exactly the instant the reply should be dated by.
 *
 * @returns `turn_id` → epoch ms; absent for a turn with no timestamped record
 */
function lastCodexRecordAt(records: readonly CodexRolloutRecord[]): Map<string, number> {
  const at = new Map<string, number>();

  for (const record of records) {
    if (record.type === 'response_item') continue;
    const turnId = record.turnId;
    if (!turnId || record.timestampMs === null) continue;
    if (record.timestampMs > (at.get(turnId) ?? 0)) at.set(turnId, record.timestampMs);
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
  turns: readonly CodexTurnAccumulator[],
  userRows: readonly RecordedUserTurn[],
  index: number
): number | null {
  const next = turns[index + 1];
  if (!next) return null;
  return userRows[index + 1]?.timestampMs ?? next.startedAt;
}

/**
 * Write one rendered turn, unless it is already there.
 *
 * `findMessageByRequestId` is both the idempotency check and the reason a repeat
 * poll does not duplicate the row: the id is codex's own `turn_id`, which does
 * not change between reads of the same file.
 *
 * Answering **true** for a turn that was already saved is deliberate. It means
 * "History holds this turn as Markdown", which is what the poller needs to know
 * — a second poll of the same finished turn must not save the pane's copy on top
 * of the row this path wrote.
 *
 * @returns Whether History holds this turn as the agent's own Markdown
 */
async function writeCodexTurn(
  target: AgentInstanceRef,
  turn: CodexTurnAccumulator,
  rendered: CodexRenderedTurn,
  timestampMs: number,
  path: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

  if (!turn.closed) {
    // codex has not written the `task_complete` for this `turn_id` yet, so what
    // is in the file is a turn in progress. Writing it would put a truncated
    // reply in History permanently — and unlike an empty one, a truncated one
    // looks finished. Handing it back to the scraper costs the Markdown
    // rendering for this turn and nothing else.
    logger.info('codex-transcript-turn-open', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      turnId: rendered.turnId,
      items: turn.items.length,
    });
    return false;
  }

  if (rendered.body.length === 0) {
    // A closed turn that said nothing — a `/`-command turn, or one whose only
    // items were silent. Answering false hands it to the scraper, which is the
    // only correct answer: an empty row would show as a blank reply forever.
    logger.info('codex-transcript-turn-empty', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      turnId: rendered.turnId,
    });
    return false;
  }

  if (rendered.unknownBlockTypes.length > 0) {
    // Never dropped in silence: an item type this reader has no rule for is a
    // codex release that has grown one, and the tally is how that becomes
    // visible before somebody notices a missing paragraph.
    logger.info('codex-transcript-unknown-items', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      turnId: rendered.turnId,
      itemTypes: rendered.unknownBlockTypes,
    });
  }

  if (turn.overflowed) {
    logger.info('codex-transcript-turn-overflowed', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      turnId: rendered.turnId,
    });
  }

  const requestId = codexTurnRequestId(rendered.turnId);
  const [{ getDbInstance }, { createMessage, findMessageByRequestId }, { broadcastMessage }] =
    await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
      import('@/lib/ws-server'),
    ]);

  const db = getDbInstance();
  if (findMessageByRequestId(db, target.worktreeId, requestId)) {
    logger.debug('codex-transcript-turn-already-saved', {
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
    timestamp: new Date(timestampMs > 0 ? timestampMs : Date.now()),
    cliToolId: target.cliToolId,
    instanceId,
    requestId,
  });

  broadcastMessage('message', { worktreeId: target.worktreeId, message });
  logger.info('codex-transcript-turn-saved', {
    worktreeId: target.worktreeId,
    instanceId,
    sessionId: rendered.sessionId,
    requestId,
    path,
    bodyLength: rendered.body.length,
    textBlocks: rendered.textBlocks,
    toolBlocks: rendered.toolBlocks,
    prompts: turn.prompts.length,
  });
  return true;
}
