/**
 * Whether somebody better-informed is already recording this turn (Issue #2041,
 * extended for Claude Code in #2121, codex in #2197, antigravity in #2198 and
 * Command Code in #2252).
 *
 * The poller's job has always been to be the only writer of conversation
 * history, because for most of the seven tools the terminal is the only place
 * the reply exists. Five of them now have a second writer: opencode publishes
 * its replies over the SSE stream CommandMate subscribes to (#1763/#2041), and
 * claude, codex, antigravity and command-code each keep their own transcript
 * file on disk. Two writers for one turn would put the same answer in History
 * twice — once as the agent wrote it and once as its TUI drew it — so one of
 * them has to stand down, and it is the one reading the screen.
 *
 * ## Why this is a module and not an `if`
 *
 * Two reasons, and the second is the one that matters. The obvious one is that
 * `response-checker` is 1,000 lines with a single tool-agnostic spine, and a
 * `cliToolId === 'opencode' && …` in the middle of the save path is exactly the
 * kind of branch that gets copied to the next tool that grows a reader. The real
 * one is the import: `@/lib/hooks/sources/opencode/subscription` reaches the
 * whole opencode client through its module graph, and the poller's tests replace
 * that graph wholesale. One named seam is one thing to stub.
 *
 * ## The tool names are gone (Issue #2197)
 *
 * Until this Issue the two functions below opened with `if (cliToolId !==
 * 'opencode')` and `if (cliToolId !== CLAUDE_CLI_TOOL_ID)`, which is the branch
 * the module comment above says it exists to prevent — the third tool arrived
 * and the third `!==` was about to be written. What replaces them is a value the
 * source declares about itself:
 * `AgentSourceCapabilities.transcriptHistory` (`'pull' | 'push' | null`, see
 * `lib/hooks/agent-event-types`). A tool with no second writer says `null` and
 * both questions below answer false for it without naming it — which is what let
 * #2198 add antigravity by editing its own `source.ts` and this file's reader
 * table and nothing else, and what leaves gemini and copilot on the scraper
 * without a line of code mentioning them.
 *
 * The word has three values rather than two because the two shapes are asked
 * *different questions*:
 *
 *  - **push** — a subscription is already receiving the reply, so the only thing
 *    to ask is whether that connection is live
 *    ({@link isStructuredHistoryWriterLive}).
 *  - **pull** — there is no connection, only a file, and nothing reads it until
 *    something asks. So the question is not "is anyone recording?" but "record
 *    it now, and tell me whether you did"
 *    ({@link captureStructuredHistoryTurn}). The call has to be here rather than
 *    in the hook receiver for a reason beyond tidiness: a hook post is answered
 *    and forgotten, so the only moment CommandMate knows a turn is *finished and
 *    about to be written* is this one, and doing the handover at the point of
 *    the write is what makes it impossible for both writers to run.
 *
 * ## What is NOT gated
 *
 * Only the two calls that *record the reply* — the `chat_messages` row and the
 * Markdown conversation log. Prompt rows, Auto-Yes, the waiting-episode edges,
 * push notifications, task events and the session-state cursor all stay on the
 * scraper, because none of them are things the second writer duplicates: a
 * `permission.asked` becomes a pending decision, never a history row, and the
 * push fan-out has no second producer at all. Gating them would trade a
 * duplicated reply for a silent notification, which is the worse failure.
 *
 * @module lib/polling/structured-history-gate
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { TranscriptHistoryMode } from '@/lib/hooks/agent-event-types';
import { createLogger } from '@/lib/logger';
import { isOpencodeStructuredHistoryLive } from '@/lib/hooks/sources/opencode/subscription';
import {
  captureClaudeTranscriptTurn,
  resolveClaudeTranscriptPath,
  type ClaudeTranscriptCapture,
} from '@/lib/hooks/sources/claude/history';
import {
  captureCodexTranscriptTurn,
  resolveCodexTranscriptPath,
  type CodexTranscriptCapture,
} from '@/lib/hooks/sources/codex/history';
import {
  captureAntigravityTranscriptTurn,
  resolveAntigravityTranscriptPath,
  type AntigravityTranscriptCapture,
} from '@/lib/hooks/sources/antigravity/history';
import {
  captureCommandCodeTranscriptTurn,
  resolveCommandCodeTranscriptPath,
  type CommandCodeTranscriptCapture,
} from '@/lib/hooks/sources/command-code/history';
import { CLAUDE_CLI_TOOL_ID } from '@/lib/hooks/sources/claude/tool-id';
import { CODEX_CLI_TOOL_ID } from '@/lib/hooks/sources/codex/tool-id';
import { ANTIGRAVITY_CLI_TOOL_ID } from '@/lib/hooks/sources/antigravity/tool-id';
import { COMMAND_CODE_CLI_TOOL_ID } from '@/lib/hooks/sources/command-code/tool-id';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import { onRelayTurnCompleted } from '@/lib/relay/relay-triggers';

const logger = createLogger('lib/polling/structured-history-gate');

declare global {
  // eslint-disable-next-line no-var
  var __structuredHistoryCaptureQueue: Map<string, Promise<void>> | undefined;
  // eslint-disable-next-line no-var
  var __structuredHistoryAnnouncedCompletions: Map<string, string> | undefined;
}

/**
 * One in-flight capture per instance (Issue #2246).
 *
 * Until this Issue there was one caller — the poller's save path, whose ticks do
 * not overlap — and the Stop hook receiver is now a second one, arriving at
 * exactly the moment the poller is most likely to be inside the same turn. Two
 * things follow, and it is worth separating them because #2246's own text runs
 * them together.
 *
 * **The duplicate-row race it describes is not open today, and this is what
 * keeps it shut.** The readers are idempotent through `findMessageByRequestId`,
 * which is a check-then-write over a *non-unique* index — but the check and the
 * write are adjacent and synchronous (`better-sqlite3` is), and the only `await`
 * in that stretch is the dynamic import *before* the check. So there is no point
 * for a second caller to interleave at, and two concurrent captures of one turn
 * already end in one row. That is a property of two adjacent statements, which
 * is exactly the kind of property a later refactor removes without noticing: an
 * `await` inserted between them re-opens the window silently, and the row it
 * costs is a duplicated reply nobody sees until an operator reports it.
 *
 * **What it saves today is the work.** Both triggers otherwise read, parse and
 * render the same 4 MiB tail at the same time, and the second one throws all of
 * it away.
 *
 * A queue rather than a shared result: the second caller runs the read again
 * after the first finishes, because it may be asking about a newer turn and
 * because the answer it needs is about the file as it is *now*. Re-running is
 * cheap and, after the first call, finds the row and answers true.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and the hook receiver's bundle would each
 * get a private copy of a module-scoped map, and a lock only one of two bundles
 * can see is not a lock.
 */
const captureQueue = (globalThis.__structuredHistoryCaptureQueue ??= new Map<
  string,
  Promise<void>
>());

/**
 * The last completion each instance was announced for (Issue #2443).
 *
 * Keyed by the same triple as {@link captureQueue}, holding whatever
 * `StructuredHistoryCaptureReport.completionKey` the reader minted. Its only job
 * is to make the completion edge an *edge*: the poller re-reads a finished turn
 * every couple of seconds, and #2443 forbids adding a path that re-delivers a
 * body somebody already has.
 *
 * On `globalThis` for the reason {@link captureQueue} is, and in memory for the
 * reason `session/agent-event-state` gives: the value describes a live session,
 * and a restart that forgets it costs at most one extra announcement into a
 * relay whose own stash guard already refuses a second payload.
 */
const announcedCompletions = (globalThis.__structuredHistoryAnnouncedCompletions ??= new Map<
  string,
  string
>());

/** Forget every instance's in-flight capture and announced completion. Test seam. */
export function resetStructuredHistoryCaptureQueue(): void {
  captureQueue.clear();
  announcedCompletions.clear();
}

/**
 * Whether this completion has already been announced for this instance (#2443).
 *
 * A reader that minted no key is always announced — the pre-#2443 behaviour, and
 * the behaviour claude, codex and command-code keep. Records the key as a side
 * effect when the answer is "no", because the two steps must not be separable:
 * an announcement that forgot to record would repeat on the next poll.
 */
function claimCompletionAnnouncement(key: string, completionKey: string | undefined): boolean {
  if (completionKey === undefined) return true;
  if (announcedCompletions.get(key) === completionKey) return false;
  announcedCompletions.set(key, completionKey);
  return true;
}

/** The queue key; the same triple `buildCompositeKey` spells everywhere else. */
function captureKeyOf(worktreeId: string, cliToolId: CLIToolType, instanceId: string): string {
  return `${worktreeId}\u0000${cliToolId}\u0000${instanceId}`;
}

/**
 * Run `work` after whatever is already running for this instance.
 *
 * The stored promise is a settled-only shadow of the real one, so a caller that
 * throws cannot reject the next caller's chain, and the entry is removed only by
 * whoever put it there — a later call that has already replaced it must not have
 * its own lock deleted underneath it.
 */
function serializePerInstance<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = captureQueue.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  captureQueue.set(key, settled);
  void settled.then(() => {
    if (captureQueue.get(key) === settled) captureQueue.delete(key);
  });
  return result;
}

/**
 * Everything the pull readers may be told about where to look.
 *
 * A union rather than a per-tool argument, because the caller is one line in
 * `response-checker` that knows nothing about which reader will run. Every field
 * is optional to somebody: claude needs the worktree path (its directory name is
 * a function of `cwd`) and takes the pane's `📄 Session log:` line as a hint,
 * while codex needs neither — its session pointer names the file outright — and
 * takes only the `$CODEX_HOME` seam. antigravity needs least of all: its
 * `conversationId` is the transcript's directory name, so its only field is the
 * home-directory seam its tests use to stay off the developer's own sessions.
 * command-code needs neither a path nor a slug: its project directory name is
 * `slugify(cwd)` and is not computed, so the reader finds the file by session id
 * and takes only its own home-directory seam (Issue #2252).
 */
export type StructuredHistoryCapture = ClaudeTranscriptCapture &
  CodexTranscriptCapture &
  AntigravityTranscriptCapture &
  CommandCodeTranscriptCapture;

/**
 * The three answers a pull capture can give (Issue #2436).
 *
 * Until this Issue there were two, and one of them was carrying two meanings.
 * `captureStructuredHistoryTurn` answered a bare boolean, so "the agent has not
 * closed this turn yet — ask again in a second" and "there is no transcript
 * here and there never will be" arrived at the caller as the same `false`, and
 * the only thing the caller could do with a `false` was save the pane's copy.
 * The readers could already tell the two apart — a `codex-transcript-turn-open`
 * line is written on exactly one of them — and the information stopped at the
 * return statement.
 *
 * What it cost is measured in #2436: for a turn whose transcript closes ~700 ms
 * after the frame goes quiet, History ends up with the agent's Markdown AND the
 * whole pane (prompt echo, intermediate output, footer; 234,323 characters at
 * the extreme) as two rows of one turn.
 *
 *  - `captured` — History holds the turn as the agent's own Markdown, written
 *    by this call or by an earlier poll of the same finished turn.
 *  - `not_yet_closed` — the transcript exists and was read, and the newest turn
 *    in it is still open. The row IS coming; a caller holding a scraped copy
 *    should wait rather than write it.
 *  - `unavailable` — nothing was written and nothing is expected: a tool with
 *    no reader, no session pointer, no file, an unreadable one, a window with no
 *    turn in it, or a closed turn that said nothing. The scraper is the only
 *    writer this turn will ever have.
 *
 * Reported through {@link StructuredHistoryCaptureReport} rather than as the
 * return value, and that is deliberate: `false` has meant "the scraper still
 * owns this turn" since #2121, every caller and every test double reads it that
 * way, and a three-valued return would be TRUTHY in all three states — the
 * `if (await captureStructuredHistoryTurn(...))` in `lib/hooks/
 * stop-history-capture` would start reporting an open turn as a captured one,
 * silently, with nothing for `tsc` to catch. The extra information is extra; it
 * does not belong in a return type that already means something.
 */
export type StructuredHistoryCaptureOutcome = 'captured' | 'not_yet_closed' | 'unavailable';

/**
 * Whether a captured turn is finished, or only saved so far (Issue #2443).
 *
 * The distinction #2443 exists to draw, and it is orthogonal to
 * {@link StructuredHistoryCaptureOutcome}: `captured` says History holds the
 * turn and the scraper must stand down, which stays true of a body the agent may
 * still add to. What must NOT be true of such a body is that it is delivered
 * onward as the answer somebody asked for.
 *
 *  - `settled` — the agent's own account says this is the body it finished on.
 *    The completion edge is announced and a waiting relay may take it.
 *  - `provisional` — History holds the newest turn, and the reader cannot show
 *    that the agent is done with it. The row keeps being repaired
 *    (`broadcastMessage('message_updated', …)`, which is a display update and
 *    reaches no other session), and **nothing is announced**: a relay waits on
 *    its own existing deadline instead of being handed an interim report.
 */
export type StructuredHistoryTurnCompletion = 'settled' | 'provisional';

/**
 * Where a caller that needs the third value asks for it (Issue #2436).
 *
 * An out-parameter: pass an object and the gate fills `outcome` in before it
 * returns. Optional at every level, so a caller that only needs "did the
 * scraper just get relieved of this turn?" keeps asking exactly the question it
 * asked before.
 */
export interface StructuredHistoryCaptureReport {
  /** Set on every call that reaches the gate; see {@link StructuredHistoryCaptureOutcome}. */
  outcome?: StructuredHistoryCaptureOutcome;
  /**
   * Whether the saved body is the one the agent finished on (Issue #2443).
   *
   * **Absent means `settled`**, which is the pre-#2443 contract and is what
   * keeps claude, codex and command-code exactly where they were: for them a
   * written row has always been a finished turn, because each of the three has a
   * record that closes one. antigravity has none — see
   * `hooks/sources/antigravity/transcript`'s
   * `resolveAntigravityTurnCompletion` — so it is the reader that fills this in.
   */
  completion?: StructuredHistoryTurnCompletion;
  /**
   * An opaque name for the settled turn *and the body it settled with* (#2443).
   *
   * Present only alongside `completion: 'settled'`, and only from a reader that
   * can name one. The gate announces a completion once per distinct value, so a
   * poll that re-reads the same finished turn adds no second announcement, while
   * a turn that grows and is confirmed again does.
   *
   * A reader that supplies nothing is announced on every capture — again the
   * pre-#2443 behaviour, and the reason this is a separate optional field rather
   * than a required identity every reader has to mint.
   */
  completionKey?: string;
  /**
   * Why the reader called the turn settled or provisional (Issue #2443).
   *
   * Diagnostic only, and deliberately a bare string: the vocabulary is the
   * reader's — `AntigravityTurnCompletionReason` today — and this layer must
   * not grow a union that every future reader has to be added to.
   */
  completionReason?: string;
}

/** What a pull-mode reader is asked to do. */
interface PullTranscriptReader {
  /**
   * Record every turn this instance has not had written yet.
   *
   * `report` is the reader's chance to say WHY it answered false (Issue #2436);
   * see {@link StructuredHistoryCaptureOutcome}. A reader that leaves it unset
   * is read as `unavailable`, which is the pre-#2436 behaviour exactly.
   */
  readonly capture: (
    target: AgentInstanceRef,
    capture: StructuredHistoryCapture,
    report?: StructuredHistoryCaptureReport
  ) => Promise<boolean>;
  /**
   * Name the file {@link PullTranscriptReader.capture} would read, without
   * reading it (Issue #2246).
   *
   * The second member exists for the Stop receiver, which retries a failed
   * capture after a short delay and must not spend that delay on an instance
   * with no transcript at all. See {@link hasStructuredHistoryTranscript}.
   */
  readonly locate: (
    target: AgentInstanceRef,
    capture: StructuredHistoryCapture
  ) => Promise<string | null>;
}

/**
 * Which reader answers for which tool.
 *
 * The one place a tool id still appears, and it is a dispatch table rather than
 * a decision: *whether* to ask is
 * `AgentSourceCapabilities.transcriptHistory === 'pull'`, and this only says who
 * to ask. It cannot be folded into the capability itself because #1921 D3
 * requires every declared capability to be JSON-serialisable — the block is
 * copied onto the wire in `structuredEvents.source`, so a capability that were a
 * function would vanish silently on the way out.
 *
 * A tool that declares `'pull'` and is missing here is a bug, and a loud one:
 * {@link captureStructuredHistoryTurn} logs it and falls back to the scraper.
 */
const PULL_TRANSCRIPT_READERS: Partial<Record<CLIToolType, PullTranscriptReader>> = {
  [CLAUDE_CLI_TOOL_ID]: {
    capture: (
      target: AgentInstanceRef,
      capture: StructuredHistoryCapture,
      report?: StructuredHistoryCaptureReport
    ) => captureClaudeTranscriptTurn(target, capture, report),
    locate: (target: AgentInstanceRef, capture: StructuredHistoryCapture) =>
      resolveClaudeTranscriptPath(target, capture),
  },
  [CODEX_CLI_TOOL_ID]: {
    capture: (
      target: AgentInstanceRef,
      capture: StructuredHistoryCapture,
      report?: StructuredHistoryCaptureReport
    ) => captureCodexTranscriptTurn(target, capture, report),
    locate: (target: AgentInstanceRef, capture: StructuredHistoryCapture) =>
      resolveCodexTranscriptPath(target, capture),
  },
  [ANTIGRAVITY_CLI_TOOL_ID]: {
    capture: (
      target: AgentInstanceRef,
      capture: StructuredHistoryCapture,
      report?: StructuredHistoryCaptureReport
    ) => captureAntigravityTranscriptTurn(target, capture, report),
    locate: (target: AgentInstanceRef, capture: StructuredHistoryCapture) =>
      resolveAntigravityTranscriptPath(target, capture),
  },
  [COMMAND_CODE_CLI_TOOL_ID]: {
    capture: (
      target: AgentInstanceRef,
      capture: StructuredHistoryCapture,
      report?: StructuredHistoryCaptureReport
    ) => captureCommandCodeTranscriptTurn(target, capture, report),
    locate: (target: AgentInstanceRef, capture: StructuredHistoryCapture) =>
      resolveCommandCodeTranscriptPath(target, capture),
  },
};

/**
 * What this tool's source says about who records its replies.
 *
 * Never throws: a registry that cannot be reached is one that declares nothing,
 * and nothing means the scraper keeps writing — the safe direction, as
 * everywhere else in this module.
 */
function transcriptHistoryModeOf(cliToolId: CLIToolType): TranscriptHistoryMode {
  try {
    return getAgentEventSource(cliToolId).capabilities.transcriptHistory ?? null;
  } catch (error) {
    logger.warn('structured-history-capability-unavailable', {
      cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Whether this tool keeps a transcript a reader can be asked to pull from.
 *
 * Exported for the Stop receiver (Issue #2246), which has to decide whether the
 * *retry* below is worth waiting for before it answers the agent's hook. It is
 * the same question {@link captureStructuredHistoryTurn} opens with, asked
 * without doing the read — never a tool id comparison, here or there.
 */
export function isPullTranscriptHistory(cliToolId: CLIToolType): boolean {
  return transcriptHistoryModeOf(cliToolId) === 'pull';
}

/**
 * Whether the agent's own server is recording this instance's replies.
 *
 * False for every tool whose source does not declare `transcriptHistory: 'push'`
 * — today that is all of them but opencode — and false for an opencode instance
 * whose subscription is anything other than `live`; see
 * {@link isOpencodeStructuredHistoryLive} for why `lost` counts as "nobody is
 * writing this down" rather than as "somebody will". The fallback direction is
 * the safe one: two writers duplicate a reply, no writer loses it.
 *
 * Never throws. A source that cannot be asked is one that is not writing.
 *
 * @param worktreeId - The worktree
 * @param cliToolId - The tool driving the pane
 * @param instanceId - The agent instance; defaults to the primary
 */
export function isStructuredHistoryWriterLive(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): boolean {
  if (transcriptHistoryModeOf(cliToolId) !== 'push') return false;
  try {
    // One probe, because there is one push source. A second one adds a table
    // here of the shape `PULL_TRANSCRIPT_READERS` already has; it does not add
    // another `cliToolId ===`.
    return isOpencodeStructuredHistoryLive({
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
    });
  } catch (error) {
    logger.warn('structured-history-gate-unavailable', {
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Ask the pull-mode structured writer to record this turn now (#2121, #2197).
 *
 * The file-backed half of the stand-down. Returns true when `chat_messages`
 * holds this turn as the agent's own Markdown — because this call wrote it, or
 * because an earlier poll of the same finished turn already did — and the caller
 * must therefore drop the scraped copy.
 *
 * False for every tool that does not declare `transcriptHistory: 'pull'`, and
 * false for one that does whenever anything at all prevented the write: no
 * session pointer (a pane started without hooks, or with hooks codex has not
 * been told to trust), no transcript file, an unreadable one, a window with no
 * prompt in it, or a turn the agent has not finished writing. That is the
 * fail-open every one of these Issues' acceptance criteria asks for in as many
 * words — 転写ファイルが無い / 読めない場合は従来のスクレイプ経路にフォール
 * バックする. Two writers duplicate a reply; no writer loses one.
 *
 * Never throws, for the same reason {@link isStructuredHistoryWriterLive} does
 * not: this runs inside the poller's save path, and an exception here would cost
 * the scraped reply as well as the structured one.
 *
 * Since Issue #2436 the `false` can be asked to explain itself: pass a
 * {@link StructuredHistoryCaptureReport} and `outcome` says whether the turn is
 * merely still open — the row is coming, and a caller holding the pane's copy
 * should wait — or whether nothing will ever be written for it. The boolean is
 * unchanged in meaning and in value; see
 * {@link StructuredHistoryCaptureOutcome} for why the third value is reported
 * beside it rather than in it.
 *
 * @param worktreeId - The worktree
 * @param cliToolId - The tool driving the pane
 * @param instanceId - The agent instance; defaults to the primary
 * @param capture - Where to look; see {@link StructuredHistoryCapture}
 * @param report - Optional out-parameter; see {@link StructuredHistoryCaptureReport}
 */
export async function captureStructuredHistoryTurn(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  capture: StructuredHistoryCapture,
  report?: StructuredHistoryCaptureReport
): Promise<boolean> {
  if (report) report.outcome = 'unavailable';
  if (!isPullTranscriptHistory(cliToolId)) return false;

  const reader = PULL_TRANSCRIPT_READERS[cliToolId];
  if (!reader) {
    logger.warn('structured-history-reader-missing', {
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
    });
    return false;
  }

  const resolvedInstanceId = instanceId ?? cliToolId;
  const captureKey = captureKeyOf(worktreeId, cliToolId, resolvedInstanceId);
  return serializePerInstance(
    captureKey,
    async (): Promise<boolean> => {
      // The reader's own report, kept local and copied out below: `report` is
      // the caller's object and must end up holding one verdict, not whatever
      // the last reader to touch it happened to leave there.
      const readerReport: StructuredHistoryCaptureReport = {};
      try {
        const captured = await reader.capture(
          { worktreeId, cliToolId, instanceId: resolvedInstanceId },
          capture,
          readerReport
        );
        // Issue #2443: absent means `settled`, which is what leaves the three
        // readers that have a turn-closing record exactly where they were.
        const completion: StructuredHistoryTurnCompletion =
          readerReport.completion ?? 'settled';
        if (report) {
          // A reader that says nothing is read as `unavailable` — the pre-#2436
          // behaviour, and the safe direction: the scraper keeps the turn.
          report.outcome = captured ? 'captured' : readerReport.outcome ?? 'unavailable';
          report.completion = completion;
          report.completionKey = readerReport.completionKey;
          report.completionReason = readerReport.completionReason;
        }
        // Issue #2377: the moment a relay is waiting for. This is the single
        // point BOTH triggers of a pull capture pass through — the poller's save
        // path and the Stop hook receiver — which is why the relay needs one
        // hook here and not one in each of them. The turn is closed by the
        // agent's own account, so the delivery needs no quiet window.
        //
        // Announced only when the capture actually wrote something: a `false`
        // means the scraper is still the writer for this turn, and the poller's
        // own call below will announce it.
        //
        // Issue #2443 adds the second condition, and it is the whole Issue.
        // `captured` means History holds the newest turn; it does **not** mean
        // the agent is finished with it, because antigravity has no record that
        // closes a turn and an interim report is saved under the same key the
        // conclusion will land on. Announcing here would hand a relay the
        // interim body as the answer, and `broadcastMessage('message_updated',
        // …)` — the repair #2438 added — does not take a delivered message
        // back. So a provisional capture announces nothing at all; the relay
        // keeps waiting on the deadline it already has, and the settled capture
        // that follows announces the finished body.
        if (captured && completion === 'settled') {
          if (claimCompletionAnnouncement(captureKey, readerReport.completionKey)) {
            onRelayTurnCompleted(worktreeId, cliToolId, resolvedInstanceId, true);
          }
        } else if (captured) {
          logger.info('structured-history-capture-provisional', {
            worktreeId,
            cliToolId,
            instanceId: resolvedInstanceId,
            // The reader's own word for what is missing; see
            // `AntigravityTurnCompletionReason`. This is the line #2443 asks for
            // — the reason left on the relay's waiting path.
            reason: readerReport.completionReason ?? 'unknown',
          });
        }
        return captured;
      } catch (error) {
        logger.warn('structured-history-capture-unavailable', {
          worktreeId,
          cliToolId,
          instanceId: resolvedInstanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
  );
}

/**
 * Whether a pull reader can name a transcript for this instance (Issue #2246).
 *
 * Not "is there a turn to write" and not "did anything get written" — only
 * whether the file the reader would open exists right now. The one caller is
 * `lib/hooks/stop-history-capture`, which asks it after a capture answered
 * false, to decide whether waiting half a second and asking again could help.
 * An instance with no transcript will not have one in half a second, and the
 * delay would be paid on every `stop` of every session without hooks.
 *
 * False for every tool that does not declare `transcriptHistory: 'pull'`, and
 * never throws — an unanswerable question is one whose answer is "no file",
 * which costs the retry and nothing else.
 *
 * @param worktreeId - The worktree
 * @param cliToolId - The tool driving the pane
 * @param instanceId - The agent instance; defaults to the primary
 * @param capture - Where to look; see {@link StructuredHistoryCapture}
 */
export async function hasStructuredHistoryTranscript(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  capture: StructuredHistoryCapture
): Promise<boolean> {
  const reader = isPullTranscriptHistory(cliToolId) ? PULL_TRANSCRIPT_READERS[cliToolId] : undefined;
  if (!reader) return false;

  try {
    const path = await reader.locate(
      { worktreeId, cliToolId, instanceId: instanceId ?? cliToolId },
      capture
    );
    return path !== null;
  } catch (error) {
    logger.warn('structured-history-locate-unavailable', {
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
