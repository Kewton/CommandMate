/**
 * The two-layer status merge: the screen scrape set against the agent's own
 * account of its turn (Issue #3215).
 *
 * Moved verbatim out of `current-output-builder`, which re-exports
 * `mergeStructuredStatus`, `ScraperVerdict` and `MergedStatusVerdict` under the
 * same names, so an import from either module reads the same declaration. The
 * comments came along unedited: where one says "this module", it was written
 * about `current-output-builder`.
 *
 * `summarizeAskUserQuestion`, `staleReadyCandidate` and `readNewestPromptAt`
 * are exported for `buildPayload` and for nothing else; they are not part of
 * what `current-output-builder` re-exports.
 */

import type Database from 'better-sqlite3';
// Issue #2429: the send ledger, read directly from `chat-db` rather than from
// the `@/lib/db` barrel because that barrel does not re-export it. It is the
// SAME row `commandmate wait` asks for over
// `GET /api/worktrees/:id/messages?limit=1&unit=pairs` (see `readNewestPromptAt`
// in `cli/commands/wait.ts`), so the server and the CLI cannot disagree about
// when this instance was last handed a prompt.
import { getLastUserMessageForInstance } from '@/lib/db/chat-db';
import { createLogger } from '@/lib/logger';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { SessionStatus } from '@/lib/detection/status-detector';
import type {
  AskUserQuestionEpisode,
  StructuredPromptWaitingState,
  StructuredSessionState,
} from '@/lib/session/agent-event-state';
import { structuredWaitingReason } from '@/lib/session/prompt-waiting-composition';
import type { PublishedTurn } from '@/lib/session/provisional-turn';
import type { StatusEvidence } from '@/lib/session/status-evidence';
import type { StructuredAskUserQuestionSummary } from '@/lib/session/structured-prompt';

// Issue #3215: the name is the one this line has always been logged under. It
// is what an operator greps for, so it did not move with the code.
const logger = createLogger('current-output-builder');

/** What `detectSessionStatus()` said about this frame, as this module uses it. */
export interface ScraperVerdict {
  status: SessionStatus;
  reason: string;
  /** The agent is producing output right now. */
  thinking: boolean;
  /**
   * Whether `status` was positively confirmed (Issue #1924).
   *
   * Produced by the detector since #1927 (§8 Phase 3): an `input_prompt` frame
   * that no tool-specific idle-composer rule vouches for is `'none'` here, with
   * the same status and reason on the wire as one that was vouched for.
   *
   * NOT the negation of {@link ScraperVerdict.isUnclassifiedActive}, though it
   * was when both were introduced. Issue #2011 separated them after the rollout
   * made the two sets diverge — see `status-evidence.ts` for the two questions
   * and which consumer asks which.
   */
  evidence: StatusEvidence;
  /**
   * The frame is interactive but could not be classified (#1497 / #1708).
   *
   * `isUnclassifiedFrame(status, reason)` — the reason vocabulary, not the
   * evidence. A published CLI contract (`capture --json`, and `wait`'s
   * `ready && !isUnclassifiedActive` completion rule), so it is derived from the
   * one expression in `status-evidence.ts` at the single site that produces a
   * verdict and carried through everywhere else — two expressions for one fact
   * is how §4 D1 decision 2 says this drifts, and #2011 is what it cost.
   */
  isUnclassifiedActive: boolean;
}

export interface MergedStatusVerdict extends ScraperVerdict {
  /** True when the structured layer, not the scraper, decided `status`. */
  structuredApplied: boolean;
}

/**
 * The `AskUserQuestion` call as the degraded prompt can describe it
 * (Issue #1726).
 *
 * Only the first question, and no option numbers — see
 * {@link StructuredAskUserQuestionSummary} for why a layer that cannot see the
 * screen must not publish numbers for it.
 */
export function summarizeAskUserQuestion(
  episode: AskUserQuestionEpisode | null,
): StructuredAskUserQuestionSummary | null {
  const first = episode?.spec.questions[0];
  if (!first) return null;
  return {
    question: first.question,
    labels: first.choices.map((choice) => choice.label),
    questionCount: episode!.spec.questions.length,
    // Issue #2951: a question that takes a typed answer, so the panel and the
    // phone sheet can offer an input for it.
    ...(first.custom ? { custom: true as const } : {}),
  };
}

/**
 * Prefer the agent's own account of what it is doing over the screen scrape
 * (Issue #1723).
 *
 * Pure, and exported so the whole precedence table can be tested without a tmux
 * session behind it.
 *
 * ## Why the scraper still wins in two cases
 *
 * **`waiting` on the scraper's side always wins.** A frame the detector reads
 * as a prompt, a selection list or a pager is a frame a human has to act on,
 * and this Issue deliberately does not touch `isPromptWaiting` / `promptData` /
 * `isSelectionListActive` (they are #1725's). Letting a structured `running`
 * overwrite `sessionStatus` while those three still said "answer me" would
 * publish a self-contradicting payload. It is also the empirically necessary
 * rule: the live capture found that Claude emits **no event at all** while an
 * `AskUserQuestion` selection or "Ready to submit your answers?" screen is up
 * (`agent-hooks-live-verification.md` §5.6), so the newest structured fact
 * there is the `user_prompt_submit` that opened the turn — `running` — while
 * the truth on screen is "waiting for a human". That is precisely the #1708
 * stall, and the scraper is the only layer that can see it.
 *
 * **A structured `waiting` is applied only through the prompt-waiting state**
 * (Issue #1725). #1723 recorded `Notification(permission_prompt)` and stopped
 * there, for a reason that had to be answered before it could be promoted:
 * nothing marks a permission prompt as *answered*, so a verdict read off the
 * last event alone would stick until the next `Stop` and describe a session
 * that went back to work minutes ago. `getStructuredPromptWaiting` is that
 * answer — it is released by `Stop` / `user_prompt_submit` / a generation
 * change, by the scraper reporting the frame it corroborated has cleared, and
 * by expiry. So the `waiting` promoted here is the one that survives all of
 * those, passed in explicitly; the raw `structured.status === 'waiting'` still
 * decides nothing on its own.
 *
 * ## `isUnclassifiedActive` is not this function's to move (Issue #2011)
 *
 * The flag is carried through from the scraper on every path. It answers "could
 * the detection layer read this frame?", and no amount of knowledge about the
 * TURN changes the answer for the FRAME:
 *
 *  - a static overlay left on screen after a turn (`/help`, #1497) reads as
 *    `running`/`no_recent_output` while the structured layer says `ready` — the
 *    structured layer adds nothing about the screen, and clearing the flag would
 *    take away the navigation hatch the user needs to escape;
 *  - a frame nobody can classify while the structured layer says `running` is
 *    still a frame nobody can classify. `wait`'s unclassified dwell (exit 10)
 *    is the last hatch for a screen that produces no events at all, and #1708
 *    exists because it was missing. A structured `running` does not prove a
 *    human is not needed — see the AskUserQuestion case above.
 *
 * `#1723`'s reported case — `Stop` arrives while the spinner is still painted —
 * needs no help from here: that frame reads `running`/`thinking_indicator`, which
 * is classified, so the flag was already down and `wait` completes on the
 * structured `ready` alone.
 *
 * What this function DOES move is `evidence`, and only upwards: see
 * {@link hookClosedTurn}.
 *
 * @param turn - The published turn record for this instance, or null. Read only
 *   for {@link hookClosedTurn}; `structured` remains the status authority.
 */
export function mergeStructuredStatus(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  promptWaiting: StructuredPromptWaitingState | null = null,
  turn: PublishedTurn | null = null,
  lastPromptAt: number | null = null,
): MergedStatusVerdict {
  if (scraper.status === 'waiting') {
    return { ...scraper, structuredApplied: false };
  }

  // Issue #1725, the OR rule at the status level: the scraper reads this frame
  // as running or ready, and the agent has told us a dialog is in front of it.
  // Publishing `running` next to `isPromptWaiting: true` would be a payload
  // that contradicts itself, and every consumer of `sessionStatus` — the
  // sidebar dot, `deriveSessionStatus`, the worktrees API — would show a worker
  // that needs a human as one that is busy.
  if (promptWaiting !== null) {
    return {
      status: 'waiting',
      reason: structuredWaitingReason(promptWaiting),
      thinking: false,
      // Untouched: what the scraper could read about this frame does not change
      // because the agent told us a dialog is open (Issue #1924).
      evidence: scraper.evidence,
      isUnclassifiedActive: scraper.isUnclassifiedActive,
      structuredApplied: true,
    };
  }

  if (structured === null || structured.status === 'waiting') {
    return { ...scraper, structuredApplied: false };
  }

  // Issue #2429: the structured `ready` is about a turn older than the prompt
  // this instance is currently answering, and the screen says so. See
  // {@link structuredReadyPredatesPrompt} for why that combination is the only
  // one in which the scraper wins a `running`.
  if (structuredReadyPredatesPrompt(scraper, structured, turn, lastPromptAt)) {
    return { ...scraper, structuredApplied: false };
  }

  const thinking = structured.status === 'running';
  // Issue #2011 (対応 2): the agent's own turn close IS positive evidence.
  //
  // #1927 (DR2-003) guarded this override with `scraper.evidence === 'positive'`
  // to stop a structured `ready` clearing `isUnclassifiedActive` on a frame
  // nobody could read. It over-corrected twice over. First, the conjunct made
  // the whole expression a no-op: `evidence = cond ? 'positive' : scraper.evidence`
  // where `cond` requires `scraper.evidence === 'positive'` returns
  // `scraper.evidence` on both arms, so the branch could not change a value in
  // any direction. Second, the fix it was reaching for belonged one field over —
  // the hatch is held open by {@link ScraperVerdict.isUnclassifiedActive}, which
  // is carried through below rather than re-derived, so the evidence no longer
  // has to be understated to protect it.
  //
  // What that leaves is a payload that stopped contradicting itself. A pane
  // whose `reason` reads `hook_stop` while `statusEvidence` reads `'none'` is
  // denying, in one field, the strongest positive signal this server can get: a
  // `Stop` from the agent, for a turn this server watched open. `closedAt >
  // openedAt` is what narrows it to that case — a `Stop` that arrived with no
  // turn open publishes `openedAt: null` (see `recordAgentEvent`), and a close
  // the SCREEN inferred carries one of the other {@link TurnCloseReason} values.
  // Freshness needs no bound of its own: `getStructuredSessionState` answered
  // null above once the display event passed STRUCTURED_STATE_MAX_AGE_MS.
  //
  // `scraper.status === 'running'` is deliberately NOT required. The session this
  // Issue was reported from sat at `ready`/`input_prompt` with `closedBy: 'stop'`
  // — the agent had said it was done and the frame agreed — and the old conjunct
  // is what kept publishing `'none'` for it.
  const evidence: StatusEvidence =
    structured.status === 'ready' && hookClosedTurn(turn) ? 'positive' : scraper.evidence;
  return {
    status: structured.status,
    reason: structured.reason,
    thinking,
    evidence,
    // Issue #2011: what the structured layer knows about the TURN says nothing
    // about whether this FRAME could be read. #1708's dwell and the nav hatch
    // are the last way out of a pane nothing can drive, and a `Stop` does not
    // make an unreadable pane readable — see the `/help` overlay fixture in
    // `tests/unit/lib/detection/fixtures/claude-live-2011/`.
    isUnclassifiedActive: scraper.isUnclassifiedActive,
    structuredApplied: true,
  };
}

/**
 * Whether the agent's own `Stop` closed a turn this server watched open
 * (Issue #2011, 対応 2).
 *
 * Both halves are required. `closedBy: 'stop'` rules out the five close reasons
 * that are the server's inference rather than the agent's word (`stale`,
 * `generation`, `session_end`, `scraper_evidence`, `resync_idle`), and
 * `closedAt > openedAt` rules out a `Stop` whose turn was never observed
 * opening — `recordAgentEvent` publishes `openedAt: null` for that, and a close
 * with nothing behind it is not a completion anybody watched.
 */
function hookClosedTurn(turn: PublishedTurn | null): boolean {
  if (turn === null) return false;
  const { closedBy, closedAt, openedAt } = turn;
  return closedBy === 'stop' && closedAt !== null && openedAt !== null && closedAt > openedAt;
}

/**
 * Whether a structured `ready` could be about a turn that ended before the
 * prompt now on screen (Issue #2429).
 *
 * The cheap half of {@link structuredReadyPredatesPrompt}, split out because
 * `buildPayload` asks it FIRST: it is the gate on the one database read this
 * rule needs, and a session that is not in this state must not pay for the send
 * ledger on every poll. One expression, two callers — the alternative is the
 * "two expressions for one fact" the merge's own docblock says is how this
 * layer drifts.
 *
 * Three conjuncts, and all three are about the same instant:
 *
 *  - **the screen is positively generating.** `ScraperVerdict.thinking` is
 *    `isGeneratingStatus`, i.e. `running` with `thinking_indicator` /
 *    `opencode_processing_indicator` behind it — a spinner, `✻ Thinking…` or
 *    `esc to interrupt` that a tool's own pattern matched. It is deliberately
 *    NOT `scraper.status === 'running'`: the `no_recent_output` and
 *    `unknown_frame` floors are also `running`, and neither is evidence of
 *    anything. A frame that merely stopped changing must never retire a `Stop`
 *    the agent actually sent.
 *  - **the structured layer says `ready`.** `running` and `waiting` already win
 *    on their own paths and are not in question here.
 *  - **that `ready` came from the agent's own `Stop`.**
 *    `getStructuredSessionState` publishes `ready / hook_stop` exactly when the
 *    turn record carries `closedBy: 'stop'` with a `closedAt`, so the record is
 *    read rather than the folded reason.
 *
 * `openedAt` is deliberately not required, which is what separates this from
 * {@link hookClosedTurn}. A `Stop` that arrived with no turn open publishes
 * `openedAt: null`, and for the tool this Issue was reported from that is the
 * ORDINARY shape: Command Code cannot emit `UserPromptSubmit` (its loader
 * validates the event name against a closed list) and emits no
 * `PreToolUse` / `PostToolUse` on a turn that calls no tool, so nothing ever
 * opens the turn. Requiring an `openedAt` here would exclude precisely the case
 * this rule exists for.
 */
export function staleReadyCandidate(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  turn: PublishedTurn | null,
): boolean {
  if (!scraper.thinking) return false;
  if (structured === null || structured.status !== 'ready') return false;
  if (turn === null) return false;
  return turn.closedBy === 'stop' && turn.closedAt !== null;
}

/**
 * Whether the structured layer's `ready` has been outlived by the newest prompt
 * this instance was handed (Issue #2429).
 *
 * ## The defect this closes
 *
 * The merge above prefers the agent's own account to the screen, and until this
 * Issue the only exception was a scraper `waiting` (#1708). That is correct for
 * every tool that can say when a turn BEGINS — claude, codex, copilot, gemini
 * and antigravity all post a turn-opening event, so a live turn replaces the
 * previous turn's `stop` before the first generating frame is ever read.
 *
 * Command Code can post neither: no `UserPromptSubmit`, and no `PreToolUse` /
 * `PostToolUse` on a turn that calls no tool. The previous turn's `ready /
 * hook_stop` therefore stays the newest structured fact for the whole of the
 * next turn, and the merge published it over a pane that was visibly generating.
 * Measured 2026-09-08 on a 19 s turn: `sessionStatus` read `ready / hook_stop`
 * from 4 s to 18 s while the status row said `esc to interrupt`. `commandmate
 * wait` reads that field — not the frame — for "is at its composer", so #1975's
 * 60 s unanswered-prompt hold was the only thing standing between a long turn
 * and a `basis=scraper_ready` completion reported before the reply existed.
 *
 * ## Why a comparison rather than a timer
 *
 * The same comparison `wait` already makes (`outstandingPrompt`), against the
 * same two server-stamped facts: the turn's `closedAt`, and the timestamp of
 * the newest user row in the chat ledger. A `Stop` that POSTDATES the newest
 * prompt is this turn's own — the agent finished, the spinner on the frame is a
 * repaint that has not settled, and the structured `ready` keeps winning. A
 * `Stop` that predates it has reported neither the start nor the end of the
 * work now on screen, and about that work it says nothing at all.
 *
 * Shortening #1975's hold would have been the other repair, and the Issue rules
 * it out for a reason worth restating here: the hold is what stops a false
 * completion during a turn nobody has reported yet, so a shorter one moves the
 * false completion earlier rather than removing it.
 *
 * @param lastPromptAt - Epoch ms of the newest prompt handed to this instance,
 *   or null when the ledger was not read or holds none. Null decides nothing:
 *   an unreadable ledger is not evidence that nothing was sent, so the
 *   structured verdict stands exactly as it did before this Issue.
 */
function structuredReadyPredatesPrompt(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  turn: PublishedTurn | null,
  lastPromptAt: number | null,
): boolean {
  if (lastPromptAt === null) return false;
  if (!staleReadyCandidate(scraper, structured, turn)) return false;
  const closedAt = turn?.closedAt ?? null;
  return closedAt !== null && closedAt < lastPromptAt;
}

/**
 * When this instance was last handed a prompt, or null (Issue #2429).
 *
 * The server's half of the comparison `commandmate wait` makes over HTTP. Both
 * sides read the same row — the newest `role: 'user'` message scoped to this
 * (worktree, tool, instance) — so the field this function feeds and the notice
 * `wait` prints cannot describe different sends.
 *
 * Best effort, like {@link recordUnclassifiedFrame} and
 * {@link recordStructuredPrompt}: the caller is building a payload, and a
 * ledger that cannot be read must cost this one comparison and nothing else.
 * Null is reported rather than a guess, and null leaves the pre-#2429
 * precedence in place — an unreadable ledger is not evidence that nothing was
 * sent, which is the position `wait` takes on the same read.
 */
export function readNewestPromptAt(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string,
): number | null {
  try {
    const row = getLastUserMessageForInstance(db, worktreeId, cliToolId, instanceId);
    if (!row) return null;
    const at = row.timestamp instanceof Date ? row.timestamp.getTime() : NaN;
    return Number.isFinite(at) ? at : null;
  } catch (error: unknown) {
    logger.debug('newest-prompt-read-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
