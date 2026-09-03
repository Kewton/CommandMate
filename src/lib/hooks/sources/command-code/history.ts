/**
 * Writing Command Code's own words into conversation history (Issue #2252,
 * Epic #2249 Phase C).
 *
 * The fifth writer of `chat_messages` for an agent turn, on the terms
 * `../opencode/history` established (#2041) and `../claude/history` generalised
 * (#2121): the first writer is `lib/polling/response-checker`, which captures
 * the pane and cleans it, and the two are mutually exclusive.
 * `lib/polling/structured-history-gate` calls {@link captureCommandCodeTranscriptTurn}
 * at the moment the scraped reply would be saved and saves it only if this
 * returns false.
 *
 * ## Which file is this instance's, when the directory name is not computable
 *
 * This is the one place Command Code differs structurally from claude, and it is
 * why Phase B (#2251) shipped `readCommandCodeTranscriptPath` for this Issue to
 * pick up. claude's project directory is a pure function of `cwd`
 * (`[^A-Za-z0-9] → -`, verified on 512 directories), so `../claude/history` can
 * *compute* the path. Command Code's is `slugify(cwd)` from its own bundle, and
 * the captured pair shows that slugify splits camel case as well —
 * `…/MyCodeBranchDesk/probe` → `…-my-code-branch-desk-probe`. Reimplementing an
 * unpublished slug is a rule that stops matching the day the tool changes it,
 * and Epic #2249 決定 4 says not to.
 *
 * So the file is *found* rather than derived, in two steps:
 *
 *  1. **A hint, if the caller has one** — {@link acceptCommandCodeTranscriptHint}
 *     validates it against `~/.commandcode/projects` and `.jsonl` before anything
 *     opens it, which is what stops a value the agent printed naming
 *     `/etc/passwd`.
 *  2. **A one-level scan of `~/.commandcode/projects/*` for
 *     `<session_id>.jsonl`.** The session id is a uuid the hooks already deliver
 *     on every event, and the directory holds one file per session, so this is
 *     exact rather than heuristic. Memoised per `(home, session)` and re-`stat`ed
 *     on every use, which is the shape `../codex/history` uses for its own scan.
 *
 * **The hint is not wired to the hook payload by this Issue, and that is
 * deliberate rather than forgotten.** `transcript_path` arrives on the hook
 * payload, and the only code that sees a raw payload *and* knows which instance
 * sent it is `src/app/api/hooks/agent-event/route.ts`, which is outside this
 * Issue's scope. Phase B says as much on {@link readCommandCodeTranscriptPath}.
 * Rather than leave the reader unable to find its file until a route changes,
 * step 2 makes the pointer sufficient on its own — and step 1 is implemented,
 * tested and used for `capture.transcriptPathHint`, so the day the payload is
 * plumbed the change is one line at the producer.
 *
 * ## Nothing here throws
 *
 * Same contract as its four siblings, and one more reason: a throw here would
 * propagate into the poller's save path and could cost the scraped reply *as
 * well as* the structured one. The database imports are dynamic so that
 * `better-sqlite3` does not enter the module graph of everything that imports
 * `@/lib/hooks/sources`.
 *
 * @module lib/hooks/sources/command-code/history
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
import { commandCodePromptRequestId, commandCodeTurnRequestId } from '@/types/agent-transcript';
import type { ChatMessage } from '@/types/models';
import type { AgentInstanceRef } from '../types';
import {
  buildCommandCodeTurns,
  COMMAND_CODE_PROJECTS_DIR_SEGMENTS,
  COMMAND_CODE_TRANSCRIPT_EXTENSION,
  isCommandCodeTurnWritable,
  parseCommandCodeTranscript,
  renderCommandCodeTurn,
  type CommandCodeRenderedTurn,
  type CommandCodeTurnAccumulator,
} from './transcript';

const logger = createLogger('lib/hooks/sources/command-code/history');

/**
 * How much of the transcript's tail is read.
 *
 * The shared bound. Command Code's own files are small next to codex's — the
 * captured sessions are single-digit kilobytes — but the file grows for the life
 * of a session and the window is what makes "only turns whose prompt record is
 * inside it are ever written" true, which is what stops a turn the window opened
 * halfway through being written from its middle.
 */
export const COMMAND_CODE_TRANSCRIPT_TAIL_BYTES = TRANSCRIPT_TAIL_BYTES;

/**
 * The shape a Command Code session id has, and the only shape this reader will
 * look up.
 *
 * A uuid, which is what the tool mints (`newSession` calls its uuid generator).
 * The check is not cosmetic: the value reaches a file-name comparison, and an id
 * carrying `/` or `..` would otherwise be a path expression. Everything that
 * fails it is treated as "no pointer", which falls through to the scraper.
 */
const COMMAND_CODE_SESSION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

declare global {
  // eslint-disable-next-line no-var
  var __commandCodeTranscriptSessions: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __commandCodeTranscriptPaths: Map<string, string> | undefined;
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
 * Command Code sends `session_id` on all four of its events — but an event that
 * did not would otherwise blank the pointer mid-session.
 */
const sessionPointers = (globalThis.__commandCodeTranscriptSessions ??= new Map<string, string>());

/**
 * Where each session id's transcript was found.
 *
 * Keyed by `<home>\0<sessionId>`, and a memo rather than a source of truth:
 * every hit is re-`stat`ed before it is used. It exists because the lookup is a
 * directory scan — the project directory name is `slugify(cwd)` and not
 * derivable — and a scan on every finished turn is not something to do twice.
 */
const transcriptPaths = (globalThis.__commandCodeTranscriptPaths ??= new Map<string, string>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/** Forget every instance's pointer and every memoised path. Test seam. */
export function resetCommandCodeTranscriptSessions(): void {
  sessionPointers.clear();
  transcriptPaths.clear();
}

/**
 * The session id this instance's transcript is under, or null.
 *
 * Reads the structured event state first and falls back to the latched value.
 * The import is dynamic so that `agent-event-state`'s module graph does not
 * become a static dependency of the poller.
 *
 * **There is deliberately no fallback below this.** The obvious one — take the
 * newest transcript whose `cwd` is this worktree — is wrong in the case the
 * feature exists for: `command-code` and `command-code-2` in one worktree share
 * a `cwd` and therefore a project directory, so the newest file is whichever of
 * them answered last, and the primary's turn would be filed under the second's
 * conversation. No pointer means the scraper keeps being the only record, which
 * is merely the status quo.
 */
export async function resolveCommandCodeSessionId(
  target: AgentInstanceRef
): Promise<string | null> {
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
    logger.debug('command-code-transcript-session-lookup-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return sessionPointers.get(key) ?? null;
}

/** `<home>/.commandcode/projects`. */
export function commandCodeProjectsRoot(homeDir: string): string {
  return join(homeDir, ...COMMAND_CODE_PROJECTS_DIR_SEGMENTS);
}

/**
 * A transcript path named by something other than this module, accepted only if
 * it really is one.
 *
 * The value this exists for is the hook payload's `transcript_path`, which is a
 * string an agent process chose. Three conditions, all necessary and all the
 * ones `acceptClaudeTranscriptHint` and `acceptCodexRolloutPath` apply: it must
 * be under `~/.commandcode/projects`, so a crafted value cannot make this open
 * `/etc/passwd`; it must end in `.jsonl`; and it must carry no NUL.
 *
 * Containment is checked on the **resolved** path so that `..` cannot climb out,
 * and `resolve` is safe to use here — unlike in `validateHookCwd`, where the
 * value is echoed back — because the resolved string is the only thing that is
 * ever used.
 *
 * @returns The resolved path, or null when it is not acceptable
 */
export function acceptCommandCodeTranscriptHint(homeDir: string, hint: string): string | null {
  if (!hint.endsWith(COMMAND_CODE_TRANSCRIPT_EXTENSION)) return null;
  if (hint.includes('\0')) return null;
  const root = resolve(commandCodeProjectsRoot(homeDir));
  const resolved = resolve(hint);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

/**
 * Find this session's transcript under `~/.commandcode/projects`.
 *
 * One level: the layout is `projects/<slug>/<session_id>.jsonl` and the slug is
 * the only unknown, so every child directory is asked whether it holds this
 * session's file. Directories are visited newest-modified first, because the
 * session being asked about is almost always the one whose project directory was
 * touched last — which makes the common case one `stat` rather than N.
 *
 * Never throws: a root that does not exist is a session this reader cannot see,
 * which is the same answer as a session with no file.
 *
 * @returns The absolute path, or null when nothing under the root matches
 */
export async function findCommandCodeTranscriptPath(
  homeDir: string,
  sessionId: string
): Promise<string | null> {
  if (!COMMAND_CODE_SESSION_ID_PATTERN.test(sessionId)) return null;

  const root = commandCodeProjectsRoot(homeDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const directories: { name: string; modifiedAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let modifiedAt = 0;
    try {
      modifiedAt = (await stat(join(root, entry.name))).mtimeMs;
    } catch {
      // A directory that vanished between `readdir` and `stat` is one with no
      // file in it as far as this scan is concerned; it still gets asked below,
      // where the failure costs one `stat` and nothing else.
    }
    directories.push({ name: entry.name, modifiedAt });
  }
  directories.sort((a, b) => b.modifiedAt - a.modifiedAt);

  const fileName = `${sessionId}${COMMAND_CODE_TRANSCRIPT_EXTENSION}`;
  for (const directory of directories) {
    const candidate = join(root, directory.name, fileName);
    if (await isReadableFile(candidate)) return candidate;
  }
  return null;
}

/** What {@link captureCommandCodeTranscriptTurn} needs from its caller. */
export interface CommandCodeTranscriptCapture {
  /**
   * A transcript path something else named, if any.
   *
   * Shared with `../claude/history`, which is safe because each reader validates
   * the value against **its own** root: a `~/.claude/projects/…` hint is rejected
   * by {@link acceptCommandCodeTranscriptHint} and a `~/.commandcode/projects/…`
   * one by `acceptClaudeTranscriptHint`, so neither reader can be pointed at the
   * other's file. Today's only producer is claude's pane line, so this is null
   * for every Command Code instance; see the module comment for why the reader
   * does not depend on it.
   */
  readonly transcriptPathHint?: string | null;
  /**
   * Test seam; defaults to the process's home directory.
   *
   * The home the `.commandcode` directory sits in, not `.commandcode` itself —
   * Command Code's own `homeDirOf` is `env.HOME ?? env.USERPROFILE` and it
   * appends the rest, so there is no `$COMMAND_CODE_HOME` to honour the way
   * `../codex/history` honours `$CODEX_HOME`.
   */
  readonly commandCodeHome?: string;
}

/**
 * Read this instance's unwritten turns out of its transcript and write them.
 *
 * **Every turn in the window that is not already a row**, oldest first, which is
 * the shape Issue #2246 gave the pull readers; the reasoning is written out once
 * on `../claude/history`'s `captureClaudeTranscriptTurn` and is not repeated
 * here. The short version: this reader only runs when something judges a turn
 * finished, so a missed judgement used to lose a turn permanently — by the next
 * judgement, "the newest turn" had moved on.
 *
 * The return value is the poller's instruction. **True** means `chat_messages`
 * holds this instance's newest turn as Markdown — because this call wrote it, or
 * because an earlier read of the same finished turn already did — and the scrape
 * must be dropped. **False** means it does not, for any reason at all: no
 * session pointer, no file, an unreadable file, a window with no prompt in it,
 * or a turn the agent has not finished writing. Everything that can go wrong
 * answers false, which is the fail-open the acceptance criteria require.
 *
 * Never throws.
 *
 * @param target - The instance whose turn just ended
 * @returns Whether History now holds this instance's newest turn as Markdown
 */
export async function captureCommandCodeTranscriptTurn(
  target: AgentInstanceRef,
  capture: CommandCodeTranscriptCapture
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const homeDir = capture.commandCodeHome ?? homedir();
    const sessionId = await resolveCommandCodeSessionId(target);
    const path = await locateCommandCodeTranscript(homeDir, capture, sessionId);
    if (!path) {
      logger.debug('command-code-transcript-unavailable', {
        worktreeId: target.worktreeId,
        instanceId,
        sessionId,
        reason: sessionId ? 'no-file' : 'no-session-pointer',
      });
      return false;
    }

    const text = await readTranscriptTail(path);
    if (text === null) return false;

    const parsed = parseCommandCodeTranscript(text);
    const built = buildCommandCodeTurns(parsed.records, parsed.sessionId ?? sessionId ?? '');
    if (built.turns.length === 0) {
      logger.info('command-code-transcript-no-turn', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        records: parsed.records.length,
        malformedLines: parsed.malformedLines,
        orphanedAssistantRecords: built.orphanedAssistantRecords,
      });
      return false;
    }

    if (
      parsed.malformedLines > 0 ||
      built.orphanedAssistantRecords > 0 ||
      parsed.parentSession !== null
    ) {
      // All three are expected in small numbers and all three are the kind of
      // thing that must be visible when they stop being small: a fragment at the
      // tail of a file being appended to, the head of the window landing
      // mid-turn, and — the one Issue #2252 scopes out by name — a session that
      // was forked from another, whose records this reader makes no attempt to
      // reattach to their original conversation.
      logger.info('command-code-transcript-partial-read', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        malformedLines: parsed.malformedLines,
        orphanedAssistantRecords: built.orphanedAssistantRecords,
        unresolvedParentRecords: built.unresolvedParentRecords,
        nonMessageRecords: built.nonMessageRecords,
        parentSession: parsed.parentSession,
      });
    }

    const pending = await selectUnwrittenCommandCodeTurns(target, built.turns);

    // Before anything is written: the rows that are already there (#2264). This
    // is deliberately ahead of the early return below, because "the newest turn
    // is already a row" is the state a row saved from a half-flushed turn is
    // stuck in — the reader answers true and does nothing while the transcript
    // beside it holds the missing paragraph.
    await refreshCommandCodeTurnRows(
      target,
      built.turns
        .slice(0, built.turns.length - pending.turns.length)
        .slice(-COMMAND_CODE_TURN_RECHECK_LIMIT),
      path
    );

    if (pending.turns.length === 0) {
      logger.debug('command-code-transcript-turns-already-saved', {
        worktreeId: target.worktreeId,
        instanceId,
        turnsInWindow: built.turns.length,
      });
      return true;
    }

    if (pending.turns.length > 1) {
      logger.info('command-code-transcript-backfilling-turns', {
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
      const userRow = await recordCommandCodeUserTurn(target, turn, previousStartedAt);
      captured = await writeCommandCodeTurn(
        target,
        turn,
        renderCommandCodeTurn(turn),
        resolveAssistantTimestampMs(turn, userRow),
        path
      );
    }
    return captured;
  } catch (error) {
    logger.error('command-code-transcript-capture-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** What {@link selectUnwrittenCommandCodeTurns} answers. */
interface PendingCommandCodeTurns {
  /** The turns to write, oldest first. Empty when the newest one is a row. */
  readonly turns: readonly CommandCodeTurnAccumulator[];
  /** `startedAt` of the turn immediately before the first pending one, or 0. */
  readonly previousStartedAt: number;
  /** Whether a written turn was found in the window. Logged, never branched on. */
  readonly anchored: boolean;
}

/**
 * The turns {@link captureCommandCodeTranscriptTurn} still has to write (#2246).
 *
 * The search runs **backwards from the newest turn** and stops at the first one
 * that is already a row. That turn is the *anchor*, and everything after it is
 * pending. The comparison is the transcript's own record order and never a
 * timestamp — a turn's assistant row is dated one millisecond after its user row
 * ({@link resolveAssistantTimestampMs}), so the rows carry no ordering that
 * could be trusted for this.
 *
 * A window with no anchor answers with the newest turn alone, which is #2121's
 * behaviour and the right one: the earlier turns really are the scraper's, and
 * there is no evidence in the window that says otherwise.
 */
async function selectUnwrittenCommandCodeTurns(
  target: AgentInstanceRef,
  turns: readonly CommandCodeTurnAccumulator[]
): Promise<PendingCommandCodeTurns> {
  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const requestId = commandCodeTurnRequestId(turns[index].promptId);
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
 * The transcript file this instance would be read from, or null (Issue #2246).
 *
 * The same two steps {@link captureCommandCodeTranscriptTurn} opens with, asked
 * without reading or writing anything. The Stop receiver uses it to decide
 * whether waiting half a second and asking again could possibly help: a session
 * with no transcript to name will not have grown one by then.
 *
 * Never throws.
 */
export async function resolveCommandCodeTranscriptPath(
  target: AgentInstanceRef,
  capture: CommandCodeTranscriptCapture
): Promise<string | null> {
  try {
    const homeDir = capture.commandCodeHome ?? homedir();
    return await locateCommandCodeTranscript(
      homeDir,
      capture,
      await resolveCommandCodeSessionId(target)
    );
  } catch {
    return null;
  }
}

/**
 * The transcript file for this instance, or null.
 *
 * The hint first because it names the file outright, the scan second. Both are
 * checked against the filesystem rather than trusted, and the memo is re-`stat`ed
 * for the same reason: "the path we would use" and "the path that exists" differ
 * for every session that has been deleted, renamed or never persisted at all
 * (`--no-session` writes nothing here, which is measured).
 */
async function locateCommandCodeTranscript(
  homeDir: string,
  capture: CommandCodeTranscriptCapture,
  sessionId: string | null
): Promise<string | null> {
  const hint = capture.transcriptPathHint;
  if (typeof hint === 'string' && hint.length > 0) {
    const accepted = acceptCommandCodeTranscriptHint(homeDir, hint);
    if (accepted && (await isReadableFile(accepted))) return accepted;
  }

  if (!sessionId) return null;

  const memoKey = `${homeDir}\0${sessionId}`;
  const memoised = transcriptPaths.get(memoKey);
  if (memoised && (await isReadableFile(memoised))) return memoised;

  const found = await findCommandCodeTranscriptPath(homeDir, sessionId);
  if (found) transcriptPaths.set(memoKey, found);
  else transcriptPaths.delete(memoKey);
  return found;
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Record the prompt this turn answers, before the reply is written (#2196).
 *
 * Ordering is the reason this is a separate call and not a branch inside
 * {@link writeCommandCodeTurn}: the user row has to exist *before* the assistant
 * row so that {@link resolveAssistantTimestampMs} can put the reply after it,
 * and so that a browser watching the broadcast sees a prompt appear and then an
 * answer rather than the other way round.
 *
 * A turn whose prompt was not the operator's — a `steering` or `followup`
 * message the agent loop appended; see `isCommandCodeOperatorPromptRecord` — is
 * skipped and said so in the log. The assistant row is still written: the agent
 * really did reply.
 *
 * Never throws; `recordUserTurn` reports its failures in the return value.
 *
 * @param previousStartedAt - When the turn before this one opened, or 0. Widens
 *   `/send` adoption backwards to that instant (#2246); never narrows.
 */
async function recordCommandCodeUserTurn(
  target: AgentInstanceRef,
  turn: CommandCodeTurnAccumulator,
  previousStartedAt = 0
): Promise<RecordedUserTurn> {
  const instanceId = target.instanceId ?? target.cliToolId;

  if (!turn.promptIsOperatorInput) {
    logger.debug('command-code-transcript-user-turn-skipped', {
      worktreeId: target.worktreeId,
      instanceId,
      promptId: turn.promptId,
      reason: 'not-operator-input',
    });
    return { outcome: 'skipped', messageId: null, timestampMs: null };
  }

  const adoption: RecordUserTurnOptions =
    previousStartedAt > 0 ? { adoptionFromMs: previousStartedAt } : {};

  const recorded = await recordUserTurn(
    target,
    commandCodePromptRequestId(turn.promptId),
    turn.promptText,
    turn.startedAt,
    adoption
  );

  if (recorded.outcome === 'failed') {
    logger.warn('command-code-transcript-user-turn-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: turn.sessionId,
      promptId: turn.promptId,
    });
  }

  return recorded;
}

/**
 * When the assistant row for this turn is dated.
 *
 * By the prompt record's own clock — `meta.createdAt`, which is the instant the
 * message was made rather than the instant Command Code's buffered store
 * appended it — so a row written a poll late still sorts where the conversation
 * put it. When there *is* a user row it sits on that same instant, and a tie is
 * decided by whichever row the database happened to return first, so the reply
 * is moved to the first millisecond after the prompt.
 */
function resolveAssistantTimestampMs(
  turn: CommandCodeTurnAccumulator,
  userRow: RecordedUserTurn
): number {
  if (userRow.timestampMs === null) return turn.startedAt;
  return Math.max(turn.startedAt, userRow.timestampMs + 1);
}

/**
 * How many already-written turns are re-rendered and compared (Issue #2264).
 *
 * The repair half of #2264 has to look at rows the reader has **already**
 * written, which is the one thing the anchor rule deliberately does not do — so
 * it is bounded here rather than by the window. Three, the same as claude's:
 * the poller runs every two seconds and re-rendering the whole window on every
 * tick would turn a repair into the most expensive thing the poll does, while a
 * row that is going to grow grows within a second of being written.
 */
export const COMMAND_CODE_TURN_RECHECK_LIMIT = 3;

/**
 * Replace a saved row whose body has since grown (Issue #2264).
 *
 * The second half of the fix, and the half that repairs what the first half only
 * stops happening again. A row keyed `command-code-turn:<id>` is written once and
 * every later read answers "already saved", so a row saved from a turn whose last
 * record had not been flushed yet would be frozen short — and the scrape that
 * could have replaced it is suppressed by that same idempotency answer.
 *
 * **Strictly longer, never merely different.** Equality is the ordinary case and
 * must cost nothing, and a body that got *shorter* between two reads is not a
 * turn that grew — it is a window that slid, or a truncation marker — and
 * overwriting a full reply with a shorter one is the one outcome worse than the
 * bug. Longer implies different, so one comparison covers both halves.
 *
 * `message_updated`, never `message`: the row already existed and was already
 * delivered when it was created (#2195), so a client that appended instead of
 * replacing would show the reply twice.
 *
 * @param existing - The row `findMessageByRequestId` answered with
 * @returns Whether the row was replaced
 */
async function growCommandCodeTurnRow(
  target: AgentInstanceRef,
  existing: ChatMessage,
  rendered: CommandCodeRenderedTurn,
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
  logger.info('command-code-transcript-turn-updated', {
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
 * {@link captureCommandCodeTranscriptTurn} would otherwise return `true` from
 * without doing anything.
 *
 * Turns that are still open are skipped rather than compared. Their body is by
 * definition not the final one, and a repair that raced the agent would rewrite
 * the row on every poll of a long turn.
 *
 * The database is asked before the turn is rendered, so a candidate with no row
 * — every candidate, in a session this reader has never written to — costs one
 * indexed lookup and no Markdown.
 *
 * @param candidates - Already-written turns, oldest first, at most
 *   {@link COMMAND_CODE_TURN_RECHECK_LIMIT}
 * @returns How many rows were replaced
 */
async function refreshCommandCodeTurnRows(
  target: AgentInstanceRef,
  candidates: readonly CommandCodeTurnAccumulator[],
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
    if (!isCommandCodeTurnWritable(turn)) continue;
    const existing = findMessageByRequestId(
      db,
      target.worktreeId,
      commandCodeTurnRequestId(turn.promptId)
    );
    if (!existing) continue;
    if (await growCommandCodeTurnRow(target, existing, renderCommandCodeTurn(turn), path)) {
      updated += 1;
    }
  }
  return updated;
}

/**
 * Write one rendered turn, unless it is already there.
 *
 * `findMessageByRequestId` is both the idempotency check and the reason a repeat
 * read does not duplicate the row: the id is derived from the prompt record's
 * `id`, which does not change between reads of the same file.
 *
 * Answering **true** for a turn that was already saved is deliberate. It means
 * "History holds this turn as Markdown", which is exactly what the poller needs
 * to know — a second poll of the same finished turn must not save the pane's
 * copy on top of the row this path wrote for it.
 *
 * @returns Whether History holds this turn as the agent's own Markdown
 */
async function writeCommandCodeTurn(
  target: AgentInstanceRef,
  turn: CommandCodeTurnAccumulator,
  rendered: CommandCodeRenderedTurn,
  timestampMs: number,
  path: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

  if (!isCommandCodeTurnWritable(turn)) {
    // The agent's last word in this turn reached for a tool and no later prompt
    // has taken over, so what is in the file is a turn in progress. Writing it
    // would put a reply with its last paragraph missing into History
    // **permanently** — the row is keyed on the prompt's `id`, so every later
    // read finds it and answers "already saved" — and the emptiness guard below
    // cannot see the difference, because a turn cut off after its tool calls
    // renders a *non-empty* body. That is Issue #2264, reproduced here before it
    // could be reported: the measured `-p --session` resume leaves exactly this
    // shape on disk, a prompt and a tool call with the reply never flushed.
    //
    // Handing it back to the scraper costs the Markdown rendering for this turn
    // and nothing else: the Stop receiver asks again after a short delay, and
    // the poller asks again when the pane returns to the composer.
    logger.info('command-code-transcript-turn-open', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      promptId: rendered.promptId,
      assistantRecords: turn.assistantRecords,
      textBlocks: rendered.textBlocks,
      toolBlocks: rendered.toolBlocks,
    });
    return false;
  }

  if (rendered.body.length === 0) {
    // The prompt record is there and the assistant records are not. Answering
    // false hands the turn back to the scraper, which is the only correct
    // answer: an empty row would show as a blank reply forever, and suppressing
    // the scrape would lose the reply outright.
    logger.info('command-code-transcript-turn-empty', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      promptId: rendered.promptId,
    });
    return false;
  }

  if (rendered.unknownBlockTypes.length > 0) {
    logger.info('command-code-transcript-unknown-blocks', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      blockTypes: rendered.unknownBlockTypes,
    });
  }

  const requestId = commandCodeTurnRequestId(rendered.promptId);
  const [{ getDbInstance }, { createMessage, findMessageByRequestId }, { broadcastMessage }] =
    await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
      import('@/lib/ws-server'),
    ]);

  const db = getDbInstance();
  const existing = findMessageByRequestId(db, target.worktreeId, requestId);
  if (existing) {
    logger.debug('command-code-transcript-turn-already-saved', {
      worktreeId: target.worktreeId,
      instanceId,
      requestId,
    });
    // The row may still be one of the short ones #2264 was reported for, and
    // this is the one place that knows both the row and the turn.
    await growCommandCodeTurnRow(target, existing, rendered, path);
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
  logger.info('command-code-transcript-turn-saved', {
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
