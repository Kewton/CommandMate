/**
 * Writing antigravity's own words into conversation history (Issue #2198).
 *
 * The antigravity half of the stand-down `lib/polling/structured-history-gate`
 * arbitrates, on the terms `../claude/history` established in #2121 and
 * `../codex/history` repeated in #2197: the poller captures the pane and cleans
 * it, this reads the agent's own transcript, and the two are mutually exclusive
 * because {@link captureAntigravityTranscriptTurn} answers whether it wrote the
 * turn.
 *
 * ## Pull, with a pointer that names the *directory* rather than the file
 *
 * There is no connection to subscribe to. agy appends every step of a
 * conversation to
 * `<agyHome>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
 * as it goes, and the trigger to read it has to come from whatever already knows
 * a turn just ended — the poller, on agy's `Stop` hook.
 *
 * This is the easiest of the three pull readers to point at its file, and the
 * measurement in `docs/design/antigravity-transcript-reader.md` §2 is why:
 *
 *  - **The hook's `conversationId` is the transcript's directory name.** agy
 *    puts `conversationId` on every event it sends — `SessionStart`, `Stop`,
 *    `PostToolUse`, and the `PreToolUse` that goes to the permission receiver —
 *    and that same uuid names the `brain/` directory and the `conversations/*.db`
 *    beside it. So the path is *computed*, not searched for: no directory scan
 *    of codex's kind, and no `cwd`-derived slug of claude's.
 *  - **`--continue` does not change it.** All three turns of the captured
 *    session carried one value, so the pointer is stable for the life of the
 *    conversation rather than per invocation.
 *  - **`cwd` is not usable and is not used.** agy runs its hook handlers with
 *    `cwd` set to `~/.gemini/config` — its own configuration directory, on 10 of
 *    10 captured payloads — and `workspacePaths` is empty in CLI mode (#1757).
 *    A cwd-based guess here would not merely be ambiguous between two instances
 *    the way codex's would be; it would point at the wrong directory every time.
 *  - **A session with no pointer is left to the scraper.** No hooks configured,
 *    a server restarted mid-session: both produce no pointer, and this module
 *    answers false for them. That is the fail-open the acceptance criteria ask
 *    for.
 *
 * ## The IDE cannot contaminate this
 *
 * agy's whole reason to be a go/no-go was that the CLI and an IDE backend share
 * state. Measured, they share a parent and nothing else: the CLI writes under
 * `~/.gemini/antigravity-cli/` and the IDE under `~/.gemini/antigravity/`. This
 * module reads only the former — see {@link ANTIGRAVITY_CLI_HOME_SEGMENTS} — and
 * the conversation ids are uuids in any case.
 *
 * ## Nothing here throws
 *
 * Same contract as the other three readers, for the same reason: this runs
 * inside the poller's save path, and an exception would cost the scraped reply
 * *as well as* the structured one. The database imports are dynamic so that
 * `better-sqlite3` does not enter the module graph of everything that imports
 * `@/lib/hooks/sources`.
 *
 * @module lib/hooks/sources/antigravity/history
 */

import { stat } from 'fs/promises';
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
import { antigravityPromptRequestId, antigravityTurnRequestId } from '@/types/agent-transcript';
import type { AgentInstanceRef } from '../types';
import {
  ANTIGRAVITY_BRAIN_DIR_SEGMENT,
  ANTIGRAVITY_TRANSCRIPT_EXTENSION,
  ANTIGRAVITY_TRANSCRIPT_PATH_SEGMENTS,
  buildAntigravityTurns,
  isAntigravityTurnWritable,
  parseAntigravityTranscript,
  renderAntigravityTurn,
  type AntigravityRenderedTurn,
  type AntigravityTurnAccumulator,
} from './transcript';

const logger = createLogger('lib/hooks/sources/antigravity/history');

/**
 * How much of the transcript's tail is read.
 *
 * The shared bound, named here so antigravity's reader states it the way the
 * other two do. agy's transcripts are the smallest of the three — the largest on
 * the capture machine was 86 KB — so the window is never the binding constraint;
 * it is here so that a pathological session cannot make the poller read an
 * unbounded file.
 */
export const ANTIGRAVITY_TRANSCRIPT_TAIL_BYTES = TRANSCRIPT_TAIL_BYTES;

/**
 * `~/.gemini/antigravity-cli` — where the `agy` CLI keeps its state.
 *
 * **Not `~/.gemini/antigravity`**, which is the same layout written by the
 * Antigravity IDE. CommandMate launches the CLI (`src/lib/cli-tools/antigravity.ts`),
 * so the CLI's directory is the one that holds its conversations; reading the
 * IDE's would be reading somebody else's session.
 *
 * There is no environment override, and that is a measurement rather than an
 * omission: a scan of the `agy` 1.1.18 binary for `AGY_*`, `ANTIGRAVITY_*` and
 * every `*_DIR` / `*_HOME` / `*_ROOT` name found nothing that relocates the
 * state directory. `$HOME` is the only lever, which is why the seam below is a
 * parameter rather than an env var.
 */
export const ANTIGRAVITY_CLI_HOME_SEGMENTS: readonly string[] = ['.gemini', 'antigravity-cli'];

/**
 * The shape an antigravity conversation id has, and the only shape this reader
 * will look up.
 *
 * A UUID, which is what agy mints. The check is not cosmetic: the value reaches
 * a path join, and an id carrying `/` or `..` would otherwise be a path
 * expression. Everything that fails it is treated as "no pointer", which falls
 * through to the scraper.
 */
const ANTIGRAVITY_CONVERSATION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

declare global {
  // eslint-disable-next-line no-var
  var __antigravityTranscriptConversations: Map<string, string> | undefined;
}

/**
 * The last conversation id seen for each instance.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and the hook receiver's bundle would each
 * get a private copy of a module-scoped map, one would write and the other would
 * read, and every lookup would answer null with no error at all.
 *
 * A latch and not a cache: `getLastAgentEvent` holds only the newest event, and
 * agy sends `conversationId` on every event it delivers — but a future one that
 * did not would otherwise blank the pointer mid-session.
 */
const conversationPointers = (globalThis.__antigravityTranscriptConversations ??= new Map<
  string,
  string
>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/** Forget every instance's pointer. Test seam. */
export function resetAntigravityTranscriptConversations(): void {
  conversationPointers.clear();
}

/**
 * The conversation id this instance's transcript is under, or null.
 *
 * Reads the structured event state first and falls back to the latched value.
 * The import is dynamic so that `agent-event-state`'s module graph does not
 * become a static dependency of the poller.
 *
 * `NormalizedAgentEvent.sessionId` is where it arrives: agy's payload spells the
 * field `conversationId`, and `../antigravity/source` maps it through
 * `conversationIdFields`. There is no `session_id` in an agy payload at all.
 *
 * **There is deliberately no fallback below this.** The obvious one — take the
 * newest conversation directory — is wrong for the case the feature exists for:
 * an IDE agy and a CLI agy running at once, or two CommandMate instances in two
 * worktrees, each write their own, and "newest" is whichever answered last. No
 * pointer means the scraper keeps being the only record, which is merely the
 * status quo.
 */
export async function resolveAntigravityConversationId(
  target: AgentInstanceRef
): Promise<string | null> {
  const key = keyOf(target);
  try {
    const { getLastAgentEvent } = await import('@/lib/session/agent-event-state');
    const conversationId = getLastAgentEvent(
      target.worktreeId,
      target.cliToolId,
      target.instanceId
    )?.sessionId;
    if (typeof conversationId === 'string' && conversationId.length > 0) {
      conversationPointers.set(key, conversationId);
      return conversationId;
    }
  } catch (error) {
    // A state module that cannot be reached is one that knows no conversation.
    logger.debug('antigravity-transcript-conversation-lookup-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return conversationPointers.get(key) ?? null;
}

/**
 * `~/.gemini/antigravity-cli`.
 *
 * @param home - The user's home directory; a seam so a test never reads the
 *   real one
 */
export function resolveAntigravityHome(home: string = homedir()): string {
  return join(home, ...ANTIGRAVITY_CLI_HOME_SEGMENTS);
}

/** `<agyHome>/brain`. */
export function antigravityBrainRoot(agyHome: string): string {
  return join(agyHome, ANTIGRAVITY_BRAIN_DIR_SEGMENT);
}

/**
 * Where this conversation's transcript is, or null.
 *
 * Computed rather than searched for: agy names the directory after the
 * conversation id the hook already handed over. The id is validated first
 * because it is about to become a path segment.
 *
 * @returns The absolute path, or null when the id is not one agy could have minted
 */
export function antigravityTranscriptPath(
  agyHome: string,
  conversationId: string
): string | null {
  if (!ANTIGRAVITY_CONVERSATION_ID_PATTERN.test(conversationId)) return null;
  return join(
    antigravityBrainRoot(agyHome),
    conversationId,
    ...ANTIGRAVITY_TRANSCRIPT_PATH_SEGMENTS
  );
}

/**
 * A transcript path, accepted only if it really is one.
 *
 * The same three conditions `acceptCodexRolloutPath` applies, for the same
 * reasons: it must be under `<agyHome>/brain`, so nothing can make this open
 * `/etc/passwd`; it must end in `.jsonl`; and it must carry no NUL. Containment
 * is checked on the *resolved* path so that `..` cannot climb out.
 *
 * It guards a path this module computed itself, which is not redundant: the
 * conversation id inside it came off the wire, and the pattern check above and
 * this containment check are two independent reasons the same value cannot
 * escape the directory.
 *
 * @returns The resolved path, or null when it is not acceptable
 */
export function acceptAntigravityTranscriptPath(
  agyHome: string,
  candidate: string
): string | null {
  if (!candidate.endsWith(ANTIGRAVITY_TRANSCRIPT_EXTENSION)) return null;
  if (candidate.includes('\0')) return null;
  const root = resolve(antigravityBrainRoot(agyHome));
  const resolved = resolve(candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

/** What {@link captureAntigravityTranscriptTurn} needs from its caller. */
export interface AntigravityTranscriptCapture {
  /**
   * Test seam; defaults to `~/.gemini/antigravity-cli`.
   *
   * A parameter rather than an environment variable because agy has none — see
   * {@link ANTIGRAVITY_CLI_HOME_SEGMENTS}. Its only purpose is to keep the unit
   * tests off the developer's real conversations.
   */
  readonly antigravityHome?: string;
}

/**
 * Read this instance's unwritten turns out of its transcript and write them.
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
 * means it does not, for any reason at all — no conversation pointer, no file, an
 * unreadable file, a window with no prompt in it — and the scrape must be saved.
 * Everything that can go wrong answers false: two writers duplicate a reply, no
 * writer loses one.
 *
 * The user row is written even when the assistant row is not, and that is
 * deliberate rather than an oversight. A prompt the operator typed into `tmux
 * attach` is the thing #2196 exists to record, and it is worth recording next to
 * a *scraped* reply just as much as next to a Markdown one. agy makes that case
 * more common than the other tools do rather than less: it has no
 * `UserPromptSubmit` hook at all (`./source.ts`), so the transcript is the only
 * place its prompts are written down.
 *
 * Never throws.
 *
 * @param target - The instance whose turn just ended
 * @param capture - See {@link AntigravityTranscriptCapture}
 * @returns Whether History now holds this turn as the agent's own Markdown
 */
export async function captureAntigravityTranscriptTurn(
  target: AgentInstanceRef,
  capture: AntigravityTranscriptCapture = {}
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const agyHome = capture.antigravityHome ?? resolveAntigravityHome();

    const conversationId = await resolveAntigravityConversationId(target);
    if (!conversationId) {
      logger.debug('antigravity-transcript-unavailable', {
        worktreeId: target.worktreeId,
        instanceId,
        reason: 'no-conversation-pointer',
      });
      return false;
    }

    const path = await locateAntigravityTranscript(agyHome, conversationId);
    if (!path) {
      logger.debug('antigravity-transcript-unavailable', {
        worktreeId: target.worktreeId,
        instanceId,
        conversationId,
        reason: 'no-file',
      });
      return false;
    }

    const text = await readTranscriptTail(path);
    if (text === null) return false;

    const parsed = parseAntigravityTranscript(text);
    const built = buildAntigravityTurns(parsed.records, conversationId);
    if (built.turns.length === 0) {
      // No `USER_INPUT` in the window. Two ordinary causes, both fail-open: the
      // 4 MiB window cut mid-conversation, and `transcript_full.jsonl` can hold
      // less than the whole history — one of the 41 files in the corpus held a
      // single record. Neither is a reason to lose the scraped reply.
      logger.info('antigravity-transcript-no-turn', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        records: parsed.records.length,
        malformedLines: parsed.malformedLines,
        preludeRecords: built.preludeRecords,
      });
      return false;
    }

    if (parsed.malformedLines > 0) {
      // Expected in small numbers — a fragment at the tail of a file being
      // appended to — and the kind of thing that must be visible when it stops
      // being small. The corpus has 0 of 1,024, so a number here is worth seeing.
      logger.info('antigravity-transcript-partial-read', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        malformedLines: parsed.malformedLines,
        preludeRecords: built.preludeRecords,
      });
    }

    const pending = await selectUnwrittenAntigravityTurns(target, built.turns);
    if (pending.turns.length === 0) {
      logger.debug('antigravity-transcript-turns-already-saved', {
        worktreeId: target.worktreeId,
        instanceId,
        turnsInWindow: built.turns.length,
      });
      return true;
    }

    if (pending.turns.length > 1) {
      logger.info('antigravity-transcript-backfilling-turns', {
        worktreeId: target.worktreeId,
        instanceId,
        path,
        pendingTurns: pending.turns.length,
        turnsInWindow: built.turns.length,
        anchored: pending.anchored,
      });
    }

    let captured = false;
    for (let index = 0; index < pending.turns.length; index += 1) {
      const turn = pending.turns[index];
      const previousStartedAt =
        index === 0 ? pending.previousStartedAt : pending.turns[index - 1].startedAt;
      const userRow = await recordAntigravityUserTurn(target, turn, previousStartedAt);
      captured = await writeAntigravityTurn(
        target,
        turn,
        renderAntigravityTurn(turn),
        resolveAssistantTimestampMs(turn, userRow),
        path
      );
    }
    return captured;
  } catch (error) {
    logger.error('antigravity-transcript-capture-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The transcript file this instance would be read from, or null (Issue #2246).
 *
 * The same two steps {@link captureAntigravityTranscriptTurn} opens with, asked
 * without reading or writing anything; see `../claude/history`'s
 * {@link resolveClaudeTranscriptPath} for what the Stop receiver does with it.
 *
 * Never throws.
 */
export async function resolveAntigravityTranscriptPath(
  target: AgentInstanceRef,
  capture: AntigravityTranscriptCapture = {}
): Promise<string | null> {
  try {
    const conversationId = await resolveAntigravityConversationId(target);
    if (!conversationId) return null;
    return await locateAntigravityTranscript(
      capture.antigravityHome ?? resolveAntigravityHome(),
      conversationId
    );
  } catch {
    return null;
  }
}

/** What {@link selectUnwrittenAntigravityTurns} answers. */
interface PendingAntigravityTurns {
  /** The turns to write, oldest first. Empty when the newest one is a row. */
  readonly turns: readonly AntigravityTurnAccumulator[];
  /** `startedAt` of the turn before the first pending one, or 0. */
  readonly previousStartedAt: number;
  /** Whether a written turn was found in the window. Logged, never branched on. */
  readonly anchored: boolean;
}

/**
 * The turns {@link captureAntigravityTranscriptTurn} still has to write (#2246).
 *
 * The same rule as `../claude/history`'s, on agy's own key: search backwards
 * from the newest turn for one that is already a row, and take everything after
 * it. Record order and never a timestamp — agy stamps `created_at` at
 * second resolution, so a turn and its own reply routinely share an instant.
 *
 * @param turns - Every turn in the window, oldest first
 */
async function selectUnwrittenAntigravityTurns(
  target: AgentInstanceRef,
  turns: readonly AntigravityTurnAccumulator[]
): Promise<PendingAntigravityTurns> {
  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const requestId = antigravityTurnRequestId(turn.conversationId, turn.stepIndex);
    if (!findMessageByRequestId(db, target.worktreeId, requestId)) continue;
    return {
      turns: turns.slice(index + 1),
      previousStartedAt: turn.startedAt,
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
 * The transcript file for this conversation, or null.
 *
 * No memo, unlike codex's: the path is a pure function of the conversation id,
 * so there is nothing a cache would save. The `stat` stays, because "the path we
 * can compute" and "the file that exists" differ for a conversation agy has not
 * flushed yet or one the operator has cleared.
 */
async function locateAntigravityTranscript(
  agyHome: string,
  conversationId: string
): Promise<string | null> {
  const candidate = antigravityTranscriptPath(agyHome, conversationId);
  if (!candidate) return null;

  const accepted = acceptAntigravityTranscriptPath(agyHome, candidate);
  if (!accepted) return null;

  return (await isReadableFile(accepted)) ? accepted : null;
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
 * One row, not codex's list: agy opens a turn with exactly one `USER_INPUT`
 * record — 63 of 63 in the corpus — so there is never a second prompt folded
 * into the same turn.
 *
 * Ordering is why this runs before the assistant row rather than inside
 * {@link writeAntigravityTurn}: the user row has to exist first so that
 * {@link resolveAssistantTimestampMs} can put the reply after it, and so that a
 * browser watching the broadcast sees a prompt appear and then an answer.
 *
 * Never throws; `recordUserTurn` reports its failures in the return value.
 */
async function recordAntigravityUserTurn(
  target: AgentInstanceRef,
  turn: AntigravityTurnAccumulator,
  previousStartedAt = 0
): Promise<RecordedUserTurn> {
  const skipped: RecordedUserTurn = { outcome: 'skipped', messageId: null, timestampMs: null };
  const prompt = turn.prompt;
  if (!prompt) return skipped;

  // Issue #2246: a turn read late is a turn whose `/send` row may be older than
  // #2196's symmetric window reaches. The previous turn's start is the tightest
  // honest bound, and it only ever widens the search.
  const adoption: RecordUserTurnOptions =
    previousStartedAt > 0 ? { adoptionFromMs: previousStartedAt } : {};

  const recorded = await recordUserTurn(
    target,
    antigravityPromptRequestId(turn.conversationId, prompt.stepIndex),
    prompt.text,
    prompt.timestampMs,
    adoption
  );
  if (recorded.outcome === 'failed') {
    logger.warn('antigravity-transcript-user-turn-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      conversationId: turn.conversationId,
      stepIndex: prompt.stepIndex,
    });
    return skipped;
  }
  return recorded;
}

/**
 * When the assistant row for this turn is dated.
 *
 * The turn's own clock, from the `USER_INPUT` record that opened it, so a row
 * written a poll late still sorts where the conversation put it.
 *
 * When there is a user row the reply is moved to the first millisecond after it:
 * `groupMessagesIntoPairs` orders by timestamp and nothing else, and agy stamps
 * both the prompt and the first reply of a fast turn with the *same second*
 * (measured — `created_at` is second-resolution, and turn 1 of the captured
 * session has `02:12:41Z` on both). A tie is then decided by whichever row the
 * database returned first, and the losing arrangement — assistant, then user —
 * is exactly the `orphan` pair #2196 exists to remove.
 */
function resolveAssistantTimestampMs(
  turn: AntigravityTurnAccumulator,
  userRow: RecordedUserTurn
): number {
  if (userRow.timestampMs === null) return turn.startedAt;
  return Math.max(turn.startedAt, userRow.timestampMs + 1);
}

/**
 * Write one rendered turn, unless it is already there.
 *
 * `findMessageByRequestId` is both the idempotency check and the reason a repeat
 * poll does not duplicate the row: the id is `(conversationId, step_index)`,
 * neither half of which changes between reads of the same file.
 *
 * Answering **true** for a turn that was already saved is deliberate. It means
 * "History holds this turn as Markdown", which is what the poller needs to know
 * — a second poll of the same finished turn must not save the pane's copy on top
 * of the row this path wrote.
 *
 * @returns Whether History holds this turn as the agent's own Markdown
 */
async function writeAntigravityTurn(
  target: AgentInstanceRef,
  turn: AntigravityTurnAccumulator,
  rendered: AntigravityRenderedTurn,
  timestampMs: number,
  path: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

  if (!isAntigravityTurnWritable(turn)) {
    // agy has not finished this answer and no later prompt has taken over, so
    // what is in the file is a turn in progress. Writing it would put a reply
    // with its last paragraph missing into History permanently — the row is
    // keyed on `(conversationId, step_index)`, so every later read finds it and
    // answers "already saved". That is Issue #2264, reported against claude and
    // structurally identical here: a turn cut off after its `tool_calls` renders
    // a *non-empty* body, so the emptiness guard below cannot see it.
    logger.info('antigravity-transcript-turn-open', {
      worktreeId: target.worktreeId,
      instanceId,
      conversationId: rendered.conversationId,
      stepIndex: rendered.stepIndex,
      records: turn.records.length,
      textBlocks: rendered.textBlocks,
      toolBlocks: rendered.toolBlocks,
    });
    return false;
  }

  if (rendered.body.length === 0) {
    // A turn that said nothing. agy has no `task_complete`, so a closed turn
    // that rendered to nothing and an interrupted one look alike here — and
    // answering false is right for both readings: the scraper keeps the reply if
    // there was one, and an empty row that would show as a blank answer forever
    // is never written.
    logger.info('antigravity-transcript-turn-empty', {
      worktreeId: target.worktreeId,
      instanceId,
      conversationId: rendered.conversationId,
      stepIndex: rendered.stepIndex,
      records: turn.records.length,
    });
    return false;
  }

  if (rendered.unknownRecordTypes.length > 0) {
    // Never dropped in silence: a record type this reader has no rule for is an
    // agy release that has grown one, and the tally is how that becomes visible
    // before somebody notices a missing paragraph.
    logger.info('antigravity-transcript-unknown-records', {
      worktreeId: target.worktreeId,
      instanceId,
      conversationId: rendered.conversationId,
      stepIndex: rendered.stepIndex,
      recordTypes: rendered.unknownRecordTypes,
    });
  }

  if (turn.overflowed) {
    logger.info('antigravity-transcript-turn-overflowed', {
      worktreeId: target.worktreeId,
      instanceId,
      conversationId: rendered.conversationId,
      stepIndex: rendered.stepIndex,
    });
  }

  const requestId = antigravityTurnRequestId(rendered.conversationId, rendered.stepIndex);
  const [{ getDbInstance }, { createMessage, findMessageByRequestId }, { broadcastMessage }] =
    await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
      import('@/lib/ws-server'),
    ]);

  const db = getDbInstance();
  if (findMessageByRequestId(db, target.worktreeId, requestId)) {
    logger.debug('antigravity-transcript-turn-already-saved', {
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
  logger.info('antigravity-transcript-turn-saved', {
    worktreeId: target.worktreeId,
    instanceId,
    conversationId: rendered.conversationId,
    requestId,
    path,
    bodyLength: rendered.body.length,
    textBlocks: rendered.textBlocks,
    toolBlocks: rendered.toolBlocks,
  });
  return true;
}
