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
 * ## Saving and finishing are two questions (Issue #2443)
 *
 * agy writes no record that closes a turn, so "may this be saved" has to be
 * answered from the shape of its last words — and an interim report has the
 * same shape as a conclusion. #2438 made the row that follows repairable. #2443
 * separates the *second* consequence of the same evidence: whether the body may
 * be handed onward as the answer. Two states, and the reader reports which one
 * the newest turn is in:
 *
 *  - **provisional** — History holds the turn, the scraper stands down, the row
 *    keeps being re-read and grown, and `broadcastMessage('message_updated', …)`
 *    refreshes what a browser is showing. Nothing leaves the server.
 *  - **settled** — agy's own `Stop` arrived at or after the turn's newest
 *    record, so the body is the one it finished on. The gate announces the
 *    completion edge exactly once for that body.
 *
 * `docs/design/antigravity-turn-completion-2443.md` is the argument, including
 * what happens when the evidence never arrives.
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
import { advanceCapturedLineForTranscriptTurn } from '@/lib/assistant-response-saver';
import { createLogger } from '@/lib/logger';
import { antigravityPromptRequestId, antigravityTurnRequestId } from '@/types/agent-transcript';
import type { AgentInstanceRef } from '../types';
import type { ChatMessage } from '@/types/models';
import type { StructuredHistoryCaptureReport } from '@/lib/polling/structured-history-gate';
import {
  ANTIGRAVITY_BRAIN_DIR_SEGMENT,
  ANTIGRAVITY_TRANSCRIPT_EXTENSION,
  ANTIGRAVITY_TRANSCRIPT_PATH_SEGMENTS,
  antigravityTurnLastRecordAt,
  buildAntigravityTurns,
  isAntigravityTurnWritable,
  parseAntigravityTranscript,
  renderAntigravityTurn,
  resolveAntigravityTurnCompletion,
  type AntigravityRenderedTurn,
  type AntigravityTurnAccumulator,
  type AntigravityTurnCompletion,
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
  // eslint-disable-next-line no-var
  var __antigravityUnsettledTurns: Map<string, UnsettledAntigravityTurns> | undefined;
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

/**
 * How many written-but-unconfirmed turns one instance may be following (#2443).
 *
 * The bound on the answer to "a saved row must be able to catch up with its
 * conclusion even once three later turns have been written". Sixteen and not
 * "however many are in the window", because the list is walked on **every**
 * poll: each entry costs one indexed `findMessageByRequestId` and, only when
 * that finds a row, one render of a turn that is already parsed. Sixteen turns
 * is more than a working session accumulates without a single `Stop` arriving,
 * and it is a fixed ceiling on a per-instance map rather than a function of a
 * file somebody else appends to.
 *
 * Eviction is oldest-first and is a real loss of coverage, which is why it is
 * logged (`antigravity-transcript-unsettled-evicted`) rather than silent. What
 * is left is #2438's behaviour for that row: the newest
 * {@link ANTIGRAVITY_TURN_RECHECK_LIMIT} turns are re-read regardless of this
 * list, so an evicted entry loses the *extra* reach and not the ordinary one.
 */
export const ANTIGRAVITY_UNSETTLED_TURN_LIMIT = 16;

/** One instance's unconfirmed rows, and the conversation they belong to. */
interface UnsettledAntigravityTurns {
  /** Rows from another conversation are not this session's to follow. */
  conversationId: string;
  /** `step_index` of each written-but-unconfirmed turn, oldest first. */
  steps: number[];
}

/**
 * Which written turns are still waiting for agy to vouch for them (#2443).
 *
 * On `globalThis` for the reason {@link conversationPointers} is: under `next
 * dev` the poller's bundle and the hook receiver's bundle each get their own
 * copy of a module-scoped map, and a list only one of the two writers can see is
 * not a list.
 *
 * In memory and not in SQLite, deliberately. The entry describes a turn this
 * *process* wrote provisionally and has not seen confirmed; a restart loses it,
 * and what remains is exactly {@link ANTIGRAVITY_TURN_RECHECK_LIMIT} — the same
 * coverage #2438 shipped. Persisting it would make a row's repair depend on a
 * table that outlives the transcript window it can only be repaired from.
 */
const unsettledTurns = (globalThis.__antigravityUnsettledTurns ??= new Map<
  string,
  UnsettledAntigravityTurns
>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/**
 * Forget every instance's pointer and every unconfirmed row it was following.
 *
 * Test seam. Both maps, because they are two halves of one per-instance state:
 * a suite that reset the pointer and kept the follow list would carry one test's
 * `step_index` values into the next one's conversation.
 */
export function resetAntigravityTranscriptConversations(): void {
  conversationPointers.clear();
  unsettledTurns.clear();
}

/** Forget the unconfirmed rows alone. Test seam. */
export function resetAntigravityUnsettledTurns(): void {
  unsettledTurns.clear();
}

/**
 * The steps this instance is following in `conversationId`, oldest first.
 *
 * A conversation that is not the one the list was built for answers empty and
 * drops the list: `/clear` mints a new conversation id, and following the old
 * one's `step_index` values into it would re-check turns that are not the same
 * turns. This is the leak test #2443 asks for, expressed as the read path
 * rather than as a promise.
 */
function unsettledStepsFor(key: string, conversationId: string): readonly number[] {
  const entry = unsettledTurns.get(key);
  if (!entry) return [];
  if (entry.conversationId !== conversationId) {
    unsettledTurns.delete(key);
    return [];
  }
  return entry.steps;
}

/**
 * Start, or stop, following one written turn (Issue #2443).
 *
 * `confirmed` is {@link AntigravityTurnCompletion.confirmed}: a turn agy has
 * vouched for cannot grow again without a later record, and a later record takes
 * the confirmation away and re-adds it here on the very next pass. So the list
 * holds exactly the rows whose body is still provisional.
 *
 * @returns The step that was evicted to make room, or null
 */
function noteAntigravityTurnCompletion(
  key: string,
  conversationId: string,
  stepIndex: number,
  confirmed: boolean
): number | null {
  const entry = unsettledTurns.get(key);
  if (entry && entry.conversationId !== conversationId) unsettledTurns.delete(key);

  if (confirmed) {
    const current = unsettledTurns.get(key);
    if (!current) return null;
    current.steps = current.steps.filter((step) => step !== stepIndex);
    if (current.steps.length === 0) unsettledTurns.delete(key);
    return null;
  }

  const current = unsettledTurns.get(key) ?? { conversationId, steps: [] };
  unsettledTurns.set(key, current);
  if (current.steps.includes(stepIndex)) return null;
  current.steps.push(stepIndex);
  if (current.steps.length <= ANTIGRAVITY_UNSETTLED_TURN_LIMIT) return null;
  return current.steps.shift() ?? null;
}

/** Stop following steps the current read window no longer contains. */
function forgetAntigravityTurnsOutsideWindow(
  key: string,
  conversationId: string,
  present: ReadonlySet<number>
): number[] {
  const entry = unsettledTurns.get(key);
  if (!entry || entry.conversationId !== conversationId) return [];
  const dropped = entry.steps.filter((step) => !present.has(step));
  if (dropped.length === 0) return [];
  entry.steps = entry.steps.filter((step) => present.has(step));
  if (entry.steps.length === 0) unsettledTurns.delete(key);
  return dropped;
}

/**
 * When this instance last reported that its loop stopped, or null (#2443).
 *
 * The one piece of evidence {@link resolveAntigravityTurnCompletion} is asked to
 * judge against, read the way {@link resolveAntigravityConversationId} reads its
 * own: dynamically, so `agent-event-state`'s module graph is not a static
 * dependency of the poller, and defensively, so a state module that cannot be
 * reached — or a build in which this reader is newer than its neighbour — is one
 * that knows of no stop rather than one that throws inside the save path.
 *
 * `recordAgentStopEvent` runs **before** the Stop receiver asks for a capture
 * (`lib/hooks/agent-event-service`), so the value is already there on the read
 * that stop itself triggers. That ordering is what lets one seam serve both
 * triggers instead of the receiver having to hand a flag down through the gate.
 */
async function resolveAntigravityStopAt(target: AgentInstanceRef): Promise<number | null> {
  try {
    const state = await import('@/lib/session/agent-event-state');
    const read = state.getLastStopEventAt;
    if (typeof read !== 'function') return null;
    return read(target.worktreeId, target.cliToolId, target.instanceId) ?? null;
  } catch (error) {
    logger.debug('antigravity-transcript-stop-lookup-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
 * **A row this reader wrote is not final (Issue #2438).** Before anything is
 * written, the newest already-written turns — at most
 * {@link ANTIGRAVITY_TURN_RECHECK_LIMIT} of them — are re-rendered and compared
 * against the rows they produced, and a row whose turn now renders *strictly
 * longer* is replaced in place. agy has no record that closes a turn, so an
 * interim report reads as a finished answer (`isAntigravityTurnClosingRecord`)
 * and used to freeze a half-written reply into History forever. That is a
 * repair and not a second verdict: growing an older row changes neither the
 * return value nor `report`, both of which are about the **newest** turn.
 *
 * Since Issue #2436 the false can explain itself: pass a
 * `StructuredHistoryCaptureReport` and `outcome` is set to `'not_yet_closed'`
 * when the newest turn is one the agent has not finished writing — the case the
 * `-turn-open` line below reports, and the one where the caller's scraped copy
 * is worth holding rather than saving. Every other false leaves it unset, which
 * the gate reads as `'unavailable'`.
 *
 * **A saved turn is not a finished turn (Issue #2443).** #2438 made the frozen
 * row repairable and left the other half of the damage in place: the same
 * `true` that tells the poller to drop its scrape also told the relay that the
 * turn was over, so an interim report was **delivered** to whoever had asked
 * agy a question, and no later `message_updated` could take that back. So the
 * `true` now carries a second word. `report.completion` is `'settled'` only
 * when {@link resolveAntigravityTurnCompletion} can show, from agy's own `Stop`
 * event, that the body in hand is the one it finished on; otherwise it is
 * `'provisional'` — History still holds the row, the repair still runs on every
 * later read, and nothing is announced to a relay. Rows written provisionally
 * are followed by `step_index` (see {@link ANTIGRAVITY_UNSETTLED_TURN_LIMIT}),
 * so the conclusion is still picked up once the turn has fallen out of
 * {@link ANTIGRAVITY_TURN_RECHECK_LIMIT}'s window.
 *
 * @param target - The instance whose turn just ended
 * @param capture - See {@link AntigravityTranscriptCapture}
 * @param report - Optional out-parameter; see `StructuredHistoryCaptureReport`
 * @returns Whether History now holds this turn as the agent's own Markdown
 */
export async function captureAntigravityTranscriptTurn(
  target: AgentInstanceRef,
  capture: AntigravityTranscriptCapture = {},
  report?: StructuredHistoryCaptureReport
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

    // Issue #2443: one read of the evidence, applied to every turn in the
    // window. `stopAt` is agy's own account of when its loop ended; see
    // {@link resolveAntigravityTurnCompletion} for why an ordering against the
    // turn's newest record — rather than a word, a silence or a `status` — is
    // what the promotion to "final" rests on.
    const instanceKey = keyOf(target);
    const stopAt = await resolveAntigravityStopAt(target);
    const completions = new Map<number, AntigravityTurnCompletion>();
    for (const turn of built.turns) {
      completions.set(turn.stepIndex, resolveAntigravityTurnCompletion(turn, stopAt));
    }
    const newestTurn = built.turns[built.turns.length - 1];
    const newestCompletion =
      completions.get(newestTurn.stepIndex) ??
      resolveAntigravityTurnCompletion(newestTurn, stopAt);

    // A step this read can no longer see is a step no later read can repair:
    // the 4 MiB tail slid past it, its `USER_INPUT` is outside the window, or
    // the file was replaced. Logged rather than dropped in silence, because it
    // is the boundary of what #2443 promises.
    const forgotten = forgetAntigravityTurnsOutsideWindow(
      instanceKey,
      conversationId,
      new Set(built.turns.map((turn) => turn.stepIndex))
    );
    if (forgotten.length > 0) {
      logger.info('antigravity-transcript-unsettled-out-of-window', {
        worktreeId: target.worktreeId,
        instanceId,
        conversationId,
        steps: forgotten,
        turnsInWindow: built.turns.length,
      });
    }

    const pending = await selectUnwrittenAntigravityTurns(target, built.turns);
    const writtenTurns = built.turns.slice(0, built.turns.length - pending.turns.length);

    // Before anything is written: the rows that are already there (#2438). This
    // is deliberately ahead of the early return below, because "the newest turn
    // is already a row" is exactly the state the frozen row the Issue measured
    // was stuck in — agy said "waiting for the worker", the writer saved that,
    // and every later read answered true and did nothing while the conclusion
    // sat in the transcript beside it. Written turns are re-checked whether or
    // not anything is pending, so an old turn can be repaired in the same pass
    // that writes a new one.
    await refreshAntigravityTurnRows(
      target,
      selectAntigravityRecheckCandidates(
        writtenTurns,
        unsettledStepsFor(instanceKey, conversationId)
      ),
      path,
      { instanceKey, conversationId, completions }
    );

    if (pending.turns.length === 0) {
      logger.debug('antigravity-transcript-turns-already-saved', {
        worktreeId: target.worktreeId,
        instanceId,
        turnsInWindow: built.turns.length,
      });
      // Issue #2437: this turn is already History's Markdown, so the pane rows
      // behind it must stop being "unsaved output" the pre-send flush can pick up.
      await advanceCapturedLineForTranscriptTurn(target);
      reportAntigravityCompletion(report, newestTurn, newestCompletion);
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
      userRows.push(await recordAntigravityUserTurn(target, pending.turns[index], previousStartedAt));
    }

    let captured = false;
    for (let index = 0; index < pending.turns.length; index += 1) {
      const turn = pending.turns[index];
      captured = await writeAntigravityTurn(
        target,
        turn,
        renderAntigravityTurn(turn),
        resolveAssistantTimestampMs(
          turn,
          userRows[index],
          antigravityTurnLastRecordAt(turn),
          nextTurnOpensAt(pending.turns, userRows, index)
        ),
        path,
        report
      );
      // Issue #2443: a row now exists for this turn, and whether it is the body
      // agy finished on is a separate question from whether it could be saved.
      // An unconfirmed one joins the follow list so that its conclusion is still
      // picked up once three later turns have pushed it out of #2438's window.
      if (captured) {
        noteUnsettledAntigravityTurn(
          target,
          instanceKey,
          turn,
          completions.get(turn.stepIndex) ?? resolveAntigravityTurnCompletion(turn, stopAt)
        );
      }
    }
    if (captured) {
      // Issue #2437: History now holds this turn as the agent's own Markdown.
      // Park the pre-send flush's cursor past the pane rows it covers, or a
      // `/send` arriving before the next poll tick saves the whole finished turn
      // a second time.
      await advanceCapturedLineForTranscriptTurn(target);
      reportAntigravityCompletion(report, newestTurn, newestCompletion);
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
 * **The turn's LAST record, not its first (Issue #2273).** #2196 dated the reply
 * one millisecond after the prompt so that `groupMessagesIntoPairs` — which
 * orders by timestamp and nothing else — could never put the answer above the
 * question. That is still guaranteed, by `earliest` below, and it is still
 * necessary: agy stamps the prompt and the first reply of a fast turn with the
 * *same second* (measured — `created_at` is second-resolution, and turn 1 of the
 * captured session has `02:12:41Z` on both).
 *
 * What #2196 did not account for is the row that lands BETWEEN the two. A tool
 * approval is written when the dialog appears, seconds into the turn, and the
 * chat surface orders its rows by timestamp: a reply dated at the turn's start
 * therefore draws above an approval that really happened before it. The measured
 * case is in the Issue — prompt `04:49:50.989Z`, reply `04:49:54.000Z`, approval
 * `04:49:57.513Z` — and the reply's own last record is later than all three. So
 * the last record's instant is what the row is dated by: it is the moment the
 * turn actually ended, and everything the turn produced sorts before it.
 *
 * Two bounds keep the move honest:
 *
 *  - `earliest` is a floor, never overridden. A turn with no timestamped
 *    record (`lastRecordAt === 0`) is dated exactly where #2196 put it.
 *  - `nextTurnOpensAt` is a ceiling. The next turn's prompt row may be a `/send`
 *    row written while THIS turn was still running — a queued prompt — and a
 *    reply that overtook it would be paired with the wrong question.
 *
 * @param lastRecordAt - Epoch ms of the turn's last record, or 0 when unknown
 * @param nextTurnOpensAt - Epoch ms of the next turn's user row, or null when
 *   this is the newest turn in the window
 */
function resolveAssistantTimestampMs(
  turn: AntigravityTurnAccumulator,
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
 * The instant the next pending turn's prompt row carries, or null (Issue #2273).
 *
 * The user row's own timestamp when there is one, because that is what History
 * sorts on and it can be EARLIER than the turn's start — an adopted `/send` row
 * was written when CommandMate handed the text to the pane, which for a queued
 * prompt is while the previous turn was still running. The turn's start is the
 * fallback for a turn that produced no row at all.
 */
function nextTurnOpensAt(
  turns: readonly AntigravityTurnAccumulator[],
  userRows: readonly RecordedUserTurn[],
  index: number
): number | null {
  const next = turns[index + 1];
  if (!next) return null;
  return userRows[index + 1]?.timestampMs ?? next.startedAt;
}

/**
 * How many already-written turns are re-rendered and compared (Issue #2438).
 *
 * The repair half of #2438 has to look at rows this reader has **already**
 * written, which is the one thing the anchor rule of
 * {@link selectUnwrittenAntigravityTurns} deliberately does not do — so it is
 * bounded here rather than by the read window. Three, the number claude and
 * command-code settled on in #2264 and for the same arithmetic: the poller runs
 * every couple of seconds, re-rendering the whole window on every tick would
 * make a repair the most expensive thing the poll does, and a turn that is going
 * to grow grows within seconds of being written.
 *
 * The cost of the bound is paid by rows a session has already moved three turns
 * past: those keep whatever they were written with. The measured case — one
 * conversation whose only turn was `#0` — is inside it by a wide margin.
 */
export const ANTIGRAVITY_TURN_RECHECK_LIMIT = 3;

/**
 * Replace a saved row whose body has since grown (Issue #2438).
 *
 * The defect this exists for is not that the wrong body was written; it is that
 * the row was written **early**. `isAntigravityTurnClosingRecord` reads prose
 * with no `tool_calls` as agy finishing, and an interim report — "waiting for
 * the worker" — has exactly that shape. The row is keyed
 * `antigravity-turn:<conversationId>#<stepIndex>`, so once it exists every later
 * read finds it, answers "already saved", and the gate suppresses the scrape
 * that could have carried the conclusion instead. Nothing else in the system
 * ever revisits that row.
 *
 * **Strictly longer, never merely different.** Equality is the ordinary case and
 * must cost nothing, and a body that got *shorter* between two reads is not a
 * turn that grew — it is a window that slid, or a truncation marker, and
 * overwriting a full reply with a shorter one is the one outcome worse than the
 * bug. Longer implies different, so one comparison covers both.
 *
 * Only `content` moves. The row's `id`, `request_id`, `timestamp`, worktree,
 * tool and instance are what History sorts and pairs on, and a repair that
 * disturbed any of them would move an old answer to the bottom of the
 * conversation.
 *
 * `message_updated`, never `message`: the row already existed and was already
 * delivered when it was created, so a client that appended instead of replacing
 * would show the reply twice.
 *
 * @param existing - The row `findMessageByRequestId` answered with
 * @returns Whether the row was replaced
 */
async function growAntigravityTurnRow(
  target: AgentInstanceRef,
  existing: ChatMessage,
  rendered: AntigravityRenderedTurn,
  path: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

  // The stored body is the only evidence of what History holds, so a row that
  // carries none is not evidence that anything grew. Same answer as "not
  // longer": leave it alone. This runs inside the poller's save path, where the
  // module contract is that nothing throws.
  const previous = existing.content;
  if (typeof previous !== 'string') return false;
  const previousLength = previous.length;
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
  logger.info('antigravity-transcript-turn-updated', {
    worktreeId: target.worktreeId,
    instanceId,
    conversationId: rendered.conversationId,
    stepIndex: rendered.stepIndex,
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
 * Re-read the newest already-written turns and grow the short ones (#2438).
 *
 * Runs before the pending turns are written and independently of whether there
 * are any — the case it exists for is precisely the one
 * {@link captureAntigravityTranscriptTurn} used to return `true` from without
 * doing anything: the newest turn already has a row, and that row stopped at
 * agy's interim report.
 *
 * Turns that are open again are skipped rather than compared. A turn whose last
 * record is a `tool_calls` is one agy is still working through, its body is by
 * definition not the final one, and a repair that raced the agent would rewrite
 * the row on every poll of a long turn. **This is not a second chance to write
 * a turn**: a candidate with no row is left alone, because the anchor rule
 * already decided it is not this pass's to create.
 *
 * The database is asked before the turn is rendered, so a candidate with no row
 * — every candidate, in a session this reader has never written to — costs one
 * indexed lookup and no Markdown.
 *
 * Serialisation is the gate's, per instance: this adds no loop and no timer of
 * its own, it is one more thing the poll's existing pass does.
 *
 * @param candidates - Already-written turns, oldest first, at most
 *   {@link ANTIGRAVITY_TURN_RECHECK_LIMIT}
 * @returns How many rows were replaced
 */
async function refreshAntigravityTurnRows(
  target: AgentInstanceRef,
  candidates: readonly AntigravityTurnAccumulator[],
  path: string,
  follow: AntigravityFollowContext
): Promise<number> {
  if (candidates.length === 0) return 0;

  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  let updated = 0;
  for (const turn of candidates) {
    // Issue #2443: the row lookup moved ahead of the writable check, because
    // the follow list is a statement about ROWS. A turn that is open again has a
    // row whose body is provisional by definition and must stay followed, and a
    // candidate whose row has gone — History cleared, the key rewritten — is one
    // nothing can repair and is dropped here rather than re-queried forever.
    const existing = findMessageByRequestId(
      db,
      target.worktreeId,
      antigravityTurnRequestId(turn.conversationId, turn.stepIndex)
    );
    if (!existing) {
      noteAntigravityTurnCompletion(follow.instanceKey, follow.conversationId, turn.stepIndex, true);
      continue;
    }
    noteUnsettledAntigravityTurn(
      target,
      follow.instanceKey,
      turn,
      follow.completions.get(turn.stepIndex) ?? resolveAntigravityTurnCompletion(turn, null)
    );
    if (!isAntigravityTurnWritable(turn)) continue;
    if (await growAntigravityTurnRow(target, existing, renderAntigravityTurn(turn), path)) {
      updated += 1;
    }
  }
  return updated;
}

/** What {@link refreshAntigravityTurnRows} needs to keep the follow list honest. */
interface AntigravityFollowContext {
  /** `buildCompositeKey` of the instance whose list this is. */
  readonly instanceKey: string;
  /** The conversation the window was read from. */
  readonly conversationId: string;
  /** `step_index` → the verdict {@link resolveAntigravityTurnCompletion} gave it. */
  readonly completions: ReadonlyMap<number, AntigravityTurnCompletion>;
}

/**
 * The written turns to re-read on this pass (Issue #2443).
 *
 * Two sources, concatenated oldest-first and de-duplicated:
 *
 *  - **the newest {@link ANTIGRAVITY_TURN_RECHECK_LIMIT}**, which is #2438's
 *    window exactly and is what covers the ordinary case — a row saved at an
 *    interim report and concluded seconds later, while the session has not moved
 *    on. It is kept as a floor rather than replaced, so a cold process (one that
 *    restarted, or one whose follow list was evicted) still has #2438's reach.
 *  - **the followed steps**, which are the rows this process wrote from a body
 *    agy had not vouched for. They are the ones the limit above loses: four
 *    prompts queued back to back push the first turn out of the window in
 *    seconds, and nothing else in the system ever revisits it.
 *
 * The result is bounded by `ANTIGRAVITY_TURN_RECHECK_LIMIT +
 * {@link ANTIGRAVITY_UNSETTLED_TURN_LIMIT}` — a fixed 19 — whatever the window
 * holds, so a long transcript cannot make a poll's cost grow with it.
 *
 * @param writtenTurns - Turns in the window that already have rows, oldest first
 * @param followed - `step_index` values from the follow list
 */
function selectAntigravityRecheckCandidates(
  writtenTurns: readonly AntigravityTurnAccumulator[],
  followed: readonly number[]
): readonly AntigravityTurnAccumulator[] {
  const recent = writtenTurns.slice(-ANTIGRAVITY_TURN_RECHECK_LIMIT);
  if (followed.length === 0) return recent;

  const inRecent = new Set(recent.map((turn) => turn.stepIndex));
  const followedSteps = new Set(followed);
  const older = writtenTurns.filter(
    (turn) => followedSteps.has(turn.stepIndex) && !inRecent.has(turn.stepIndex)
  );
  return older.length === 0 ? recent : [...older, ...recent];
}

/**
 * Follow this row, or stop following it, and say so once (Issue #2443).
 *
 * The log line is the only place an operator can see why a repair did or did not
 * keep happening, so it carries the reason word rather than the boolean:
 * `no-stop-event` and `stop-before-last-record` are very different sessions.
 */
function noteUnsettledAntigravityTurn(
  target: AgentInstanceRef,
  instanceKey: string,
  turn: AntigravityTurnAccumulator,
  completion: AntigravityTurnCompletion
): void {
  const evicted = noteAntigravityTurnCompletion(
    instanceKey,
    turn.conversationId,
    turn.stepIndex,
    completion.confirmed
  );
  if (evicted === null) return;
  logger.info('antigravity-transcript-unsettled-evicted', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    conversationId: turn.conversationId,
    step: evicted,
    limit: ANTIGRAVITY_UNSETTLED_TURN_LIMIT,
  });
}

/**
 * Tell the caller whether the turn it was handed is final (Issue #2443).
 *
 * `completion` is what the gate reads to decide whether a relay may be told the
 * turn ended; `completionKey` is what stops it being told twice about one body.
 * The key names the turn **and** the instant of its newest record, so a turn
 * that grows after being confirmed is a new state and is announced again once
 * the new state is itself confirmed — which is exactly the `Stop`-then-`continue`
 * case `./source` warns about, handled without a second rule.
 *
 * Left entirely alone when the body is not confirmed, apart from the word
 * `provisional`: the gate defaults an absent `completion` to `settled`, so this
 * is the one place antigravity opts out of the pre-#2443 announcement.
 */
function reportAntigravityCompletion(
  report: StructuredHistoryCaptureReport | undefined,
  turn: AntigravityTurnAccumulator,
  completion: AntigravityTurnCompletion
): void {
  if (!report) return;
  report.completion = completion.confirmed ? 'settled' : 'provisional';
  report.completionKey = completion.confirmed
    ? `${antigravityTurnRequestId(turn.conversationId, turn.stepIndex)}@${completion.lastRecordAt}`
    : undefined;
  report.completionReason = completion.reason;
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
 * of the row this path wrote. Since #2438 that row is no longer left as it was
 * found: it is the same comparison {@link growAntigravityTurnRow} makes for the
 * turns the recheck window covers, made here where both the row and the turn
 * are already in hand.
 *
 * @returns Whether History holds this turn as the agent's own Markdown
 */
async function writeAntigravityTurn(
  target: AgentInstanceRef,
  turn: AntigravityTurnAccumulator,
  rendered: AntigravityRenderedTurn,
  timestampMs: number,
  path: string,
  report?: StructuredHistoryCaptureReport
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;

  // Issue #2436: the caller's report is about the turn THIS call is deciding.
  // The loop above walks oldest-first, so a verdict left by an earlier turn has
  // to be cleared before this one's is written.
  if (report) report.outcome = undefined;

  if (!isAntigravityTurnWritable(turn)) {
    // agy has not finished this answer and no later prompt has taken over, so
    // what is in the file is a turn in progress. Writing it would put a reply
    // with its last paragraph missing into History — the row is keyed on
    // `(conversationId, step_index)`, so every later read finds it and answers
    // "already saved". That is Issue #2264, reported against claude and
    // structurally identical here: a turn cut off after its `tool_calls` renders
    // a *non-empty* body, so the emptiness guard below cannot see it.
    //
    // #2438 made such a row repairable rather than making it acceptable: a
    // short row only grows while its turn is still among the newest
    // {@link ANTIGRAVITY_TURN_RECHECK_LIMIT}, and nothing at all rewinds what a
    // relay already delivered from it. Not writing it in the first place is
    // still the fix; the repair is the second line.
    if (report) report.outcome = 'not_yet_closed';
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
  const existing = findMessageByRequestId(db, target.worktreeId, requestId);
  if (existing) {
    logger.debug('antigravity-transcript-turn-already-saved', {
      worktreeId: target.worktreeId,
      instanceId,
      requestId,
    });
    // The row may be one of the ones #2438 was reported for — saved at agy's
    // interim report — and this is the one place that holds both the row and
    // the turn. The comparison and the notification are not repeated here; see
    // {@link growAntigravityTurnRow}. The verdict is unchanged: History holds
    // this turn either way, and `report.outcome` is about this turn's
    // completeness rather than about an edit.
    await growAntigravityTurnRow(target, existing, rendered, path);
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
