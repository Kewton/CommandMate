/**
 * The turn model (Issue #1930): the generation fence, the turn record each
 * instance is in, its transitions, and the decisions (dialogs) it holds.
 *
 * Split out of `agent-event-state` (Issue #3375), which re-exports the public
 * names and drives the transitions from `recordAgentEvent`.
 *
 * @module lib/session/agent-event-turn
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { PERMISSION_REPLIED_DETAIL } from '@/lib/hooks/agent-event-types';
import type { StructuredPromptSource } from '@/lib/session/structured-prompt';
// Issue #1930: the turn model. Pure, so importing it here costs nothing at
// runtime beyond the two bounds it owns.
import {
  acceptExternalId,
  boundDecisionMessage,
  boundDecisionPatterns,
  boundDecisionToolName,
  closesTurn,
  derivePublishedTurn,
  isDecisionLive,
  MAX_PENDING_DECISIONS_PER_TURN,
  SCRAPER_COMPLETION_POLLS,
  TURN_STALE_AFTER_MS,
  type PublishedTurn,
  type StructuredPendingDecision,
  type TurnCloseReason,
  type TurnRecord,
} from '@/lib/session/provisional-turn';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import { dropsFor, MAX_RECENT_EVENT_KEYS, trimOldestEntries } from '@/lib/session/agent-event-dedup';
import { getOrInitGlobal } from '../global-state';

// The maps below live on `globalThis`; see the note above `declare global` in
// `agent-event-state` for why (Issue #1736).
declare global {
  // eslint-disable-next-line no-var
  var __agentEventGenerationStartedAt: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventTurns: Map<string, TurnRecord> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventReopenedTurns: Map<string, { turnId: string; replaced: TurnRecord }> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventTurnSeq: { value: number } | undefined;
}

/** compositeKey -> epoch ms the current generation began. See {@link beginAgentEventGeneration}. */
export const generationStartedAt = getOrInitGlobal('__agentEventGenerationStartedAt', () => new Map<string, number>());

/**
 * compositeKey -> the turn this instance is in, or the last one it was in
 * (Issue #1930).
 *
 * The map that replaced "the newest event is the verdict". `lastAgentEvent`
 * above is still written on every delivery and is still what
 * `structuredEvents.lastEventType` publishes — it answers "did anything reach
 * this server, and for the right instance?", which is a diagnostic question.
 * This map answers the state question, and the two deliberately disagree
 * whenever an event carries no verdict.
 *
 * The open dialogs #1725 kept in a map of their own live on the turn now
 * ({@link TurnRecord.pendingDecisions}), because a dialog only ever happens
 * *inside* a turn and holding them apart is what let a generation bump retire
 * one and not the other.
 */
export const agentTurns = getOrInitGlobal('__agentEventTurns', () => new Map<string, TurnRecord>());

/**
 * compositeKey -> the open turn the newest unmarked `user_prompt_submit`
 * replaced, under the id of the turn it opened in its place (Issue #3330).
 *
 * Kept so that a copy of that delivery which carries the queued-notice mark,
 * and is dropped as a duplicate, can still undo the re-open; see
 * {@link joinOpenTurnFromDuplicate}. One entry per instance, overwritten by the
 * next re-open, and only ever read while the turn it names is still the
 * instance's turn.
 */
export const reopenedTurns = getOrInitGlobal(
  '__agentEventReopenedTurns',
  () => new Map<string, { turnId: string; replaced: TurnRecord }>()
);

/**
 * Monotonic suffix for {@link TurnRecord.turnId}.
 *
 * Two turns can open in the same millisecond — a `post_tool_use` closing one
 * agent's turn while another's `user_prompt_submit` lands — and an id built from
 * the timestamp alone would then compare equal across instances. `wait` reads a
 * change of id as "a new turn began", so the collision would be a missed turn
 * boundary rather than a cosmetic clash.
 */
const turnSequence = getOrInitGlobal('__agentEventTurnSeq', () => ({ value: 0 }));

// =============================================================================
// Turn model (Issue #1930)
// =============================================================================

/** Epoch ms the current generation began, or null when none was opened. */
export function currentGeneration(key: string): number | null {
  return generationStartedAt.get(key) ?? null;
}

/**
 * The turn this instance is in, with the generation fence applied.
 *
 * A turn whose {@link TurnRecord.generationAt} is not the current generation was
 * opened by a process that has been replaced. It is not deleted — the fence is
 * cheap and deleting would lose the eviction tally — it is simply not this
 * instance's turn any more.
 */
function fencedTurn(key: string): TurnRecord | null {
  const turn = agentTurns.get(key);
  if (!turn) return null;
  if (turn.generationAt !== currentGeneration(key)) return null;
  return turn;
}

/**
 * {@link fencedTurn} with the staleness bound applied.
 *
 * The bound is applied by *closing* the turn rather than by hiding it, so
 * `capture --json` says `closedBy: 'stale'` instead of going quiet — "the agent
 * never reported the end of this turn" and "nothing has been reported at all"
 * are different problems and an operator has to be able to tell them apart.
 *
 * Writes on read, which this module already does for corroboration, and is
 * idempotent: the close is stamped from the event's own clock, so it does not
 * move with the reader's `now`.
 */
export function effectiveTurn(key: string, now: number): TurnRecord | null {
  const turn = fencedTurn(key);
  if (turn === null) return null;
  if (turn.closedAt === null && now - turn.displayEvent.at >= TURN_STALE_AFTER_MS) {
    turn.closedAt = turn.displayEvent.at + TURN_STALE_AFTER_MS;
    turn.closedBy = 'stale';
  }
  return turn;
}

/** Next {@link TurnRecord.turnId}. See {@link turnSequence}. */
function nextTurnId(at: number): string {
  turnSequence.value += 1;
  return `turn-${at}-${turnSequence.value}`;
}

/**
 * Drop the decisions this turn is holding, counting them.
 *
 * The generation path is the one §4 D3 決定 2 names: a process that has been
 * replaced cannot have its approvals answered, and leaving them behind would
 * publish `waiting` for a pane whose dialog went away with the process that
 * drew it.
 */
function evictDecisions(key: string, turn: TurnRecord): void {
  if (turn.pendingDecisions.length === 0) return;
  dropsFor(key).decisionEvicted += turn.pendingDecisions.length;
  turn.pendingDecisions = [];
}

/**
 * The decisions still describing something, dropping the ones that are not.
 *
 * The retention bound of {@link DIALOG_PENDING_MAX_MS}, applied on read and
 * counted as `dialogTimedOut` so the release is visible. Kept here rather than
 * in a timer for the reason the rest of this module has no timers: the state
 * describes a live tmux session, and a reader is the only thing that ever needs
 * the answer.
 */
export function livePendingDecisions(
  key: string,
  turn: TurnRecord,
  now: number
): StructuredPendingDecision[] {
  const live = turn.pendingDecisions.filter((decision) => isDecisionLive(decision, now));
  const dropped = turn.pendingDecisions.length - live.length;
  if (dropped > 0) {
    dropsFor(key).dialogTimedOut += dropped;
    turn.pendingDecisions = live;
  }
  return live;
}

/**
 * The approvals this instance is blocked on right now (Issue #1930).
 *
 * Published as `structuredEvents.pendingDecisions`; `#1932` is what teaches
 * `commandmate respond` to name one of these ids.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getPendingDecisions(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): StructuredPendingDecision[] {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = effectiveTurn(key, now);
  if (turn === null) return [];
  return livePendingDecisions(key, turn, now);
}

/**
 * The turn record for one instance, fenced and aged, or null.
 *
 * The seam `current-output-builder` publishes from and the suites drive. The
 * returned object is the live record; nothing outside this module writes to it.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getAgentTurn(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): TurnRecord | null {
  return effectiveTurn(buildCompositeKey(worktreeId, cliToolId, instanceId), now);
}

/** {@link getAgentTurn} projected onto the four published fields. */
export function getPublishedAgentTurn(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): PublishedTurn {
  return derivePublishedTurn(getAgentTurn(worktreeId, cliToolId, instanceId, now));
}

/**
 * Close the open turn on evidence that did not come from the agent (Issue #1930).
 *
 * The one seam for the two {@link TurnCloseReason} values nothing in the event
 * stream can produce:
 *
 *  - `scraper_evidence` — see {@link observeScraperCompletionEvidence}, which is
 *    the caller in this tree.
 *  - `resync_idle` — a source whose `capabilities.resync` lets it be re-read
 *    answering "not busy" after a dropped transport. The reconnect loop that
 *    would call it lives in `sources/opencode/subscription`, which is #1931's
 *    file and deliberately untouched here; the value is in the vocabulary and
 *    the seam accepts it, so wiring it is a call site rather than a new state.
 *
 * A no-op when no turn is open, which is the ordinary case: neither of these is
 * a statement about a session that already reported it finished.
 *
 * @param at - Epoch ms; defaults to now
 * @returns Whether a turn was closed
 */
export function closeAgentTurn(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  closedBy: Extract<TurnCloseReason, 'scraper_evidence' | 'resync_idle'>,
  at: number = Date.now()
): boolean {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = fencedTurn(key);
  if (turn === null || turn.closedAt !== null) return false;
  turn.closedAt = at;
  turn.closedBy = closedBy;
  return true;
}

/**
 * Feed one poll's reading of the pane into the turn's completion counter
 * (Issue #1930).
 *
 * `completed` is the scraper's own verdict — `ready` with positive evidence —
 * NOT the merged one, which would be circular: the merge is what the structured
 * layer's `running` overrides, so reading it back would only ever confirm this
 * layer's own answer.
 *
 * See {@link SCRAPER_COMPLETION_POLLS} for why three, and for why closing here
 * does not complete a `commandmate wait`.
 *
 * ## `mayClose` — when the screen is not allowed to close (Issue #3337)
 *
 * The caller passes false while the agent's own hooks are speaking for the
 * pane, the tool is one whose hook turns the screen may not end (codex;
 * `lib/detection/turn-abandoned`), and nothing says the `Stop` will not come. Then the counter still
 * counts, but the turn stays open and the structured `running` stands.
 *
 * The screen's "finished composer" is a reading of one frame, and a frame of a
 * live turn can be misread: codex 0.160.0's status row blinks between `•` and
 * `◦`, and the `◦` half read `ready`, so three polls in a row closed a
 * nine-minute codex turn and `capture --json` published `ready` in the middle
 * of it (`tests/fixtures/codex-mid-turn-3337/`). An operator who sent on that
 * `ready` interrupted the running turn. On a hooks source the agent itself
 * reports the end, so the screen can only add a wrong answer there — except
 * when the `Stop` is known not to come. Two cases say so:
 *
 *  - the turn has been unheard from for {@link TURN_STALE_AFTER_MS}: the
 *    existing `stale` close, which `effectiveTurn` applies regardless of this
 *    function. It stays the bound on a `Stop` that was simply lost.
 *  - the frame shows the turn was abandoned — codex's `■ Conversation
 *    interrupted` — which the caller folds into `mayClose`. Measured on codex
 *    0.160.0 with hooks: an Esc fires no `Stop`.
 *
 * A source with no hooks (`scraper`), a pull source (`sse`) and a hooks tool
 * with no such policy (Claude among them) pass true and keep the #1930
 * behaviour.
 *
 * @param at - Epoch ms; defaults to now
 * @param mayClose - Whether a third positive poll may close the turn
 * @returns Whether this poll closed the turn
 */
export function observeScraperCompletionEvidence(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  completed: boolean,
  at: number = Date.now(),
  mayClose: boolean = true
): boolean {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = fencedTurn(key);
  if (turn === null || turn.closedAt !== null) return false;

  if (!completed) {
    turn.scraperCompletionPolls = 0;
    return false;
  }

  turn.scraperCompletionPolls += 1;
  if (turn.scraperCompletionPolls < SCRAPER_COMPLETION_POLLS) return false;
  if (!mayClose) return false;

  turn.closedAt = at;
  turn.closedBy = 'scraper_evidence';
  return true;
}

/**
 * End the open turn because the process that owned it has been replaced
 * (Issue #1930).
 *
 * The turn is closed and re-stamped into the new generation rather than
 * deleted, which is the difference between `capture --json` reporting
 * `closedBy: 'generation'` and reporting nothing at all. Its approvals go: they
 * were raised by a process that no longer exists, and answering one would
 * deliver a verdict into a slot nobody is holding.
 */
export function fenceTurnForNewGeneration(key: string, at: number): void {
  const turn = agentTurns.get(key);
  if (!turn) return;
  evictDecisions(key, turn);

  // A turn that had ALREADY ended is left where it is, which means the fence in
  // `fencedTurn` hides it from here on. That asymmetry is deliberate: the
  // previous process's `Stop` is not this process's, and re-stamping it into the
  // new generation would publish `ready` — "the agent finished" — for a session
  // nobody has typed into yet. Before #1930 the same protection came from
  // comparing the event's timestamp against the generation.
  if (turn.closedAt !== null) return;

  // An OPEN turn is closed and carried across, so `capture --json` can say
  // `closedBy: 'generation'` rather than going quiet. `getStructuredSessionState`
  // reads that reason as "nothing is known", so it publishes no verdict either
  // way; what it buys is an operator being able to tell "the session was
  // restarted under this turn" from "nothing was ever reported".
  turn.closedAt = at;
  turn.closedBy = 'generation';
  turn.generationAt = at;
}

/**
 * The turn transition: what one delivery does to {@link TurnRecord}
 * (Issue #1930, §4 D3 決定 2).
 *
 * | event                              | turn                    | dialog   | display |
 * |------------------------------------|-------------------------|----------|---------|
 * | `user_prompt_submit`               | **opens a new one**     | release  | yes     |
 * | `user_prompt_submit` (joins, #3330)| continues, else opens   | release  | yes     |
 * | `pre_tool_use`                     | continues, else opens   | unchanged| yes     |
 * | `post_tool_use`                    | continues, else opens   | release  | yes     |
 * | `stop` (this session)              | **closes** `stop`       | release  | yes     |
 * | `stop` (another session)           | unchanged               | unchanged| no      |
 * | `session_end`                      | **closes** `session_end`| release  | no      |
 * | `session_start`                    | new generation (above)  | evicted  | no      |
 * | `notification(permission_prompt)`  | unchanged               | **open** | only to bootstrap |
 * | `notification(permission_replied)` | unchanged               | release  | no      |
 * | `notification(idle_prompt)`        | unchanged               | release  | yes     |
 * | `notification(anything else)`      | unchanged               | unchanged| no      |
 *
 * Four rows are the whole point of the Issue, and each of them was a defect
 * under "the newest event is the verdict":
 *
 *  - **`user_prompt_submit` opens a new turn, the tool-call events continue the
 *    open one.** That is what makes {@link TurnRecord.turnId} an identity: #1926
 *    re-stamped it on every `pre_tool_use`, so a consumer reading a changed id
 *    as "a new turn began" false-positived several times inside one turn. `wait`
 *    reads it that way now.
 *  - **A `stop` naming another session changes nothing.** opencode publishes
 *    `session.idle` for every session its server holds, other processes'
 *    included (#1758 §5.6).
 *  - **`session_start` / `session_end` / an unknown notification /
 *    `permission_replied` do not become the displayed event.** An event carrying
 *    no verdict must not erase one. #1903 fixed the single measured instance
 *    (copilot's late `SessionStart`) by holding the delivery; the rule is
 *    general here, and the capability it reads is still the only reason a
 *    `session_start` is held rather than recorded.
 *  - **`notification(permission_prompt)` does not become the displayed event
 *    when a turn already exists.** The dialog is a fact about the *pane*, and
 *    it is published by the decision ledger below. Letting it overwrite the
 *    display is how the pre-#1898 `waiting` outlived the approval that caused
 *    it: released, the record still said `waiting`, because the only thing it
 *    could read was the event that opened the dialog.
 *
 * The `joins` row is the one exception to the first (Issue #3330). Claude Code
 * fires `UserPromptSubmit` for every background-task notice it attaches to a
 * turn that is already running, so a turn of an orchestrator that runs
 * background work was re-opened once per notice. The source marks those
 * deliveries ({@link AgentEventRecord.joinsOpenTurn}), and they continue the
 * open turn of their session as a tool event does. In the server logs of
 * 2026-10-02 to 2026-10-05, 188 of the 1,182 applied Claude
 * `user_prompt_submit`s arrived with a turn of theirs still open, and the
 * transcripts sort them as: 178 a queued notice (one `queue-operation: remove`
 * of a `<task-notification>` per delivery), 0 a prompt the operator typed into
 * the running turn (Claude attaches it without firing the hook), 0 a prompt
 * sent after an interrupt, 6 after a turn that had ended with no `stop`
 * applied, and 4 with nothing in the transcript to say. Only the first carry
 * the mark; the others open a new turn, as before:
 *
 *  - **After an interrupt** there is nothing on the hook channel to tell the
 *    prompt from one joining the turn — Claude Code has no interrupt hook, and
 *    the prompt is the operator's own text either way — so the turn the
 *    operator sent is a new one, which is what a resend is.
 *  - **After a `Stop` this server never got** the turn it opened is over, and a
 *    new one is right whatever the prompt was. A notice is the one case it
 *    cannot see: a lost `Stop` followed by a notice that opens a turn of its
 *    own is read as the notice joining the old turn, so the id does not change
 *    and the notice turn's `stop` closes it — the same `stop` a `wait` holding
 *    either turn was waiting for.
 *
 * Nothing in the row reads a clock. A burst of notices inside three seconds is
 * still dropped by the window in front of it ({@link isDuplicateAgentEvent}),
 * and dropped or applied, none of them moves the turn.
 *
 * `idle_prompt` is the one row that publishes `ready` **without** closing the
 * turn, and that is a measurement rather than an oversight: #1839 caught Claude
 * emitting it 62 s into a turn that ran nothing, so it cannot be a turn
 * boundary. `wait`'s gate stays armed through it; what changes is only what the
 * pane displays.
 */
export function applyTurnTransition(key: string, record: AgentEventRecord): void {
  const generation = currentGeneration(key);
  // An event stamped before the current generation was produced by a process
  // that has been replaced. Refusing it here is what makes re-recording a stale
  // `user_prompt_submit` at its original timestamp a no-op.
  if (generation !== null && record.at < generation) return;

  switch (record.event) {
    case 'user_prompt_submit':
      // Issue #3330: a queued notice the agent attached to its running turn
      // continues that turn; any other prompt is a new one.
      openTurn(key, record, generation, { continueOpen: record.joinsOpenTurn === true });
      releaseAllDecisions(key);
      return;
    case 'post_tool_use':
      openTurn(key, record, generation, { continueOpen: true });
      // The tool call the dialog was gating has finished, so somebody answered
      // it (Issue #1726). This is the release #1725 could not have: it had no
      // event meaning "the human answered", only `Stop` meaning "the turn
      // ended", which can be minutes later.
      releaseAllDecisions(key);
      return;
    case 'pre_tool_use':
      // Deliberately leaves the dialog alone (Issue #1726). It is the
      // `AskUserQuestion` invocation, and a picker being *about to be drawn* is
      // not a fact this state can carry.
      openTurn(key, record, generation, { continueOpen: true });
      return;
    case 'stop':
      applyStopToTurn(key, record, generation);
      return;
    case 'session_end':
      applySessionEndToTurn(key, record);
      releaseAllDecisions(key);
      return;
    case 'session_start':
      // The generation was opened by `recordAgentEvent` before this ran, and
      // `fenceTurnForNewGeneration` closed the turn with it. Nothing further:
      // the frame carries no verdict, so it is not the displayed event either.
      return;
    case 'notification':
      applyNotificationToTurn(key, record, generation);
      return;
    default:
      // exhaustive check: a new AgentEventType must decide its transition here
      record.event satisfies never;
      return;
  }
}

/** The three fields the turn keeps from a record. */
function displayOf(record: AgentEventRecord): TurnRecord['displayEvent'] {
  return { event: record.event, at: record.at, detail: record.detail };
}

/**
 * Open a turn for this event, or move the display onto an open one.
 *
 * @param continueOpen - Whether an already-open turn of the same session is
 *   this event's turn. False for `user_prompt_submit`, which IS a new turn —
 *   unless the source marked it as joining the running one (Issue #3330).
 */
function openTurn(
  key: string,
  record: AgentEventRecord,
  generation: number | null,
  { continueOpen }: { continueOpen: boolean }
): void {
  const turn = fencedTurn(key);
  const openHere =
    turn !== null &&
    turn.closedAt === null &&
    turn.openedAt !== null &&
    closesTurn(turn, record.sessionId);

  if (continueOpen && openHere) {
    turn.displayEvent = displayOf(record);
    // A hand-configured relay posts no session id, so a turn can learn one
    // partway through. Learning it is what lets a later `stop` be matched.
    turn.sessionId ??= record.sessionId;
    turn.scraperCompletionPolls = 0;
    return;
  }

  // A dialog-only record (openedAt null) is not a turn; its decisions belong to
  // the turn that is opening now, because that is when they were raised.
  const carried = turn !== null && turn.openedAt === null && turn.closedAt === null
    ? turn.pendingDecisions
    : [];

  const opened: TurnRecord = {
    turnId: nextTurnId(record.at),
    sessionId: record.sessionId,
    openedAt: record.at,
    closedAt: null,
    closedBy: null,
    generationAt: generation,
    displayEvent: displayOf(record),
    pendingDecisions: carried,
    scraperCompletionPolls: 0,
  };
  agentTurns.set(key, opened);
  boundTurnMap();

  // Issue #3330: a prompt with no mark that replaced a running turn of its
  // session. A marked copy of it may still arrive and be dropped as a repeat.
  if (record.event === 'user_prompt_submit' && openHere) {
    reopenedTurns.set(key, { turnId: opened.turnId, replaced: turn });
    trimOldestEntries(reopenedTurns, MAX_RECENT_EVENT_KEYS);
  }
}

/**
 * Give a dropped copy's queued-notice mark its effect (Issue #3330).
 *
 * The injected `type: "http"` hook posts Claude's payload, prompt included,
 * and is marked {@link AgentEventRecord.joinsOpenTurn} when the prompt is a
 * queued notice. A hand-configured relay beside it posts the same event a few
 * milliseconds earlier or later, and the two share the de-duplication key — so
 * when the relay's copy lands first and carries no mark (an older relay, or a
 * hook that never forwards it), it is the one applied, it re-opens the running
 * turn, and the marked copy is dropped behind it.
 *
 * Called for a `user_prompt_submit` the window dropped and that carries the
 * mark. When the instance's turn is still exactly the one an unmarked prompt
 * opened in place of a running turn of the same session, the running turn is
 * put back — under its own id and `openedAt` — with what the newer record had
 * learned since (display, dialogs). Anything else, and this does nothing.
 *
 * The other ways to keep the mark were weighed and lost:
 *
 *  - **Put the mark in the de-duplication key.** Both copies are then applied,
 *    but in arrival order: the unmarked one has already re-opened the turn by
 *    the time the marked one joins it, so the id has moved either way.
 *  - **Drop the unmarked copy instead.** Which copy is the duplicate is decided
 *    by whichever lands first, and the first has already been applied.
 *
 * What it cannot tell apart: an unmarked prompt that really begins a turn (a
 * resend after an interrupt) followed, inside the window, by a queued notice
 * of the same session. The notice is read as a copy of the prompt and the two
 * become one turn under the older id; the next `stop` closes it, which is the
 * `stop` a `wait` holding either turn was waiting for.
 *
 * @returns Whether a turn was put back.
 */
export function joinOpenTurnFromDuplicate(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  record: Pick<AgentEventRecord, 'event' | 'sessionId' | 'joinsOpenTurn'>
): boolean {
  if (record.event !== 'user_prompt_submit' || record.joinsOpenTurn !== true) return false;

  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const reopened = reopenedTurns.get(key);
  const current = fencedTurn(key);
  if (!reopened || current === null || current.turnId !== reopened.turnId) return false;
  if (current.closedAt !== null) return false;
  if (!closesTurn(current, record.sessionId)) return false;
  const { replaced } = reopened;
  if (replaced.generationAt !== current.generationAt) return false;

  agentTurns.set(key, {
    ...replaced,
    closedAt: null,
    closedBy: null,
    displayEvent: current.displayEvent,
    pendingDecisions: current.pendingDecisions,
    scraperCompletionPolls: 0,
  });
  reopenedTurns.delete(key);
  return true;
}

/**
 * Apply a `stop` — the only event that is the agent saying its turn is over.
 *
 * A `stop` for another session leaves everything alone; see {@link closesTurn}.
 * A `stop` with no turn open still records one, because "this instance last
 * reported it stopped at T" is the fact `ready` is published from, and the
 * opening it never saw is published as null rather than guessed.
 */
function applyStopToTurn(
  key: string,
  record: AgentEventRecord,
  generation: number | null
): void {
  const turn = fencedTurn(key);
  if (turn !== null && turn.closedAt === null && turn.openedAt !== null) {
    if (!closesTurn(turn, record.sessionId)) return;
    turn.closedAt = record.at;
    turn.closedBy = 'stop';
    turn.displayEvent = displayOf(record);
    releaseAllDecisions(key);
    return;
  }

  agentTurns.set(key, {
    turnId: nextTurnId(record.at),
    sessionId: record.sessionId,
    openedAt: null,
    closedAt: record.at,
    closedBy: 'stop',
    generationAt: generation,
    displayEvent: displayOf(record),
    pendingDecisions: [],
    scraperCompletionPolls: 0,
  });
  boundTurnMap();
}

/**
 * `session_end`: the agent session this instance was talking to is gone.
 *
 * **Overwrites an existing close reason**, which is the one place in this
 * module where a later event rewrites an earlier verdict, and #1723's contract
 * is why. `/clear` emits `SessionEnd(reason=clear)` on a session that is alive
 * and about to keep going, and the turn before it may perfectly well have ended
 * with a `Stop`. Leaving that `Stop` standing would keep publishing "the agent
 * finished" about a conversation that no longer exists — the integration pin is
 * `current-output-structured-status-1723`, which asserts the session goes back
 * to the scraper the moment `SessionEnd` lands.
 *
 * `closedBy: 'session_end'` publishes no verdict of its own (see
 * {@link getStructuredSessionState}), so this is a retirement rather than a
 * different answer.
 */
function applySessionEndToTurn(key: string, record: AgentEventRecord): void {
  const turn = fencedTurn(key);
  if (turn === null) return;
  if (!closesTurn(turn, record.sessionId)) return;
  turn.closedAt = record.at;
  turn.closedBy = 'session_end';
}

/**
 * The notification rows of the transition table.
 *
 * Matched on `notification_type` ({@link AgentEventRecord.detail}), never on the
 * human-facing `message` (D3): the observed messages are English prose the agent
 * is free to reword.
 */
function applyNotificationToTurn(
  key: string,
  record: AgentEventRecord,
  generation: number | null
): void {
  if (record.detail === 'permission_prompt') {
    if (record.promptSettled === true) {
      // Issue #1898: adjudicated before it was recorded, and the verdict
      // reached the agent. There is no dialog and there never was one for a
      // human to answer — opening a record for it published `waiting` for the
      // whole of the tool call that followed (measured at eight seconds).
      releaseSettledDecision(key, record);
      return;
    }
    openDecision(key, generation, {
      source: 'notification',
      at: record.at,
      message: record.message ?? null,
      // Issue #2031. Was a hard `null`, which is what left an opencode approval
      // reaching the browser with no statement of what it was for: the tool
      // name is not in `permission.asked` and has to be carried on the record
      // by whoever correlated it. Absent still means "this source had nothing
      // to say", and `openDecision` leaves an earlier name in place for that.
      toolName: record.toolName ?? null,
      patterns: record.decisionPatterns ?? null,
      decisionId: record.decisionId ?? null,
      bootstrapDisplay: displayOf(record),
    });
    return;
  }

  if (record.detail === PERMISSION_REPLIED_DETAIL) {
    // Issue #1898. The agent's own statement that the dialog is gone — whoever
    // answered it. Not a word this build reads a status from, so it decides
    // nothing; all it does is retire the record.
    if (record.promptSettled === true) releaseSettledDecision(key, record);
    return;
  }

  if (record.detail === 'idle_prompt') {
    // The agent reporting it is sitting at the composer waiting for input is the
    // agent saying nothing is in front of that composer.
    releaseAllDecisions(key);
    const turn = fencedTurn(key);
    if (turn !== null && turn.closedAt === null) {
      turn.displayEvent = displayOf(record);
      return;
    }
    if (turn !== null) return;
    // Nothing to attach it to — the first thing this instance ever said, or the
    // first since a generation. It still carries a verdict (`ready`), and #1723
    // publishes it, so a display-only record is opened to hold it. `openedAt`
    // stays null: an agent sitting at its composer is not in a turn, and a
    // record that claimed otherwise would gate `wait` on a turn nobody opened.
    agentTurns.set(key, {
      turnId: nextTurnId(record.at),
      sessionId: record.sessionId,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      generationAt: generation,
      displayEvent: displayOf(record),
      pendingDecisions: [],
      scraperCompletionPolls: 0,
    });
    boundTurnMap();
    return;
  }

  // An unrecognised notification type is not evidence of anything, and guessing
  // would be worse than the scraper.
}

/**
 * Open, or refresh, a dialog record on this instance's turn.
 *
 * `bootstrapDisplay` is used only when there is no record at all to hang the
 * decision on. That record is deliberately **not** an open turn — its
 * `openedAt` is null — so releasing the decision hands the pane back to the
 * scraper rather than asserting `running` for a turn nobody ever saw open.
 */
export function openDecision(
  key: string,
  generation: number | null,
  input: {
    source: StructuredPromptSource;
    at: number;
    message: string | null;
    toolName: string | null;
    decisionId: string | null;
    /** Issue #2031. Bounded here, not by the caller. */
    patterns: readonly unknown[] | null;
    bootstrapDisplay: TurnRecord['displayEvent'];
  }
): void {
  let turn = fencedTurn(key);
  if (turn === null) {
    turn = {
      turnId: nextTurnId(input.at),
      sessionId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      generationAt: generation,
      displayEvent: input.bootstrapDisplay,
      pendingDecisions: [],
      scraperCompletionPolls: 0,
    };
    agentTurns.set(key, turn);
    boundTurnMap();
  } else if (turn.closedAt !== null) {
    // The dialog is being raised after the turn it would have belonged to
    // ended — a `PermissionRequest` racing a `Stop`, or a re-check landing
    // late. Re-open a dialog-only record rather than resurrecting the turn.
    turn = {
      turnId: nextTurnId(input.at),
      sessionId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      generationAt: generation,
      displayEvent: input.bootstrapDisplay,
      pendingDecisions: [],
      scraperCompletionPolls: 0,
    };
    agentTurns.set(key, turn);
    boundTurnMap();
  }

  // Issue #1930 / S1: an id that fails validation is DISCARDED, not truncated —
  // a truncated id compares equal to a different id sharing its prefix, and the
  // reply to one approval would then retire another's record.
  const decisionId = input.decisionId === null ? null : acceptExternalId(input.decisionId);
  if (input.decisionId !== null && decisionId === null) dropsFor(key).idsDiscarded += 1;

  const confirmed = input.source === 'notification';
  // Which record, if any, this report is a second sighting of.
  //
  //  - an id matches its own record;
  //  - an id with no record of its own may still be *confirming* the anonymous
  //    prediction that forecast it. That is the measured pair: a
  //    `PermissionRequest` this server declined to decide fires ~6 s before the
  //    `Notification(permission_prompt)` that proves the dialog, and the
  //    request carries no id;
  //  - an anonymous report merges only with another anonymous one. A source
  //    that publishes no ids therefore keeps exactly one dialog record per
  //    instance, which is what #1725 did and the honest limit for it — matching
  //    an anonymous report against an *identified* record would let one
  //    approval's forecast confirm a different approval's dialog.
  const existing =
    decisionId !== null
      ? (turn.pendingDecisions.find((decision) => decision.decisionId === decisionId) ??
        turn.pendingDecisions.find(
          (decision) => decision.decisionId === null && decision.source === 'permission-request'
        ))
      : turn.pendingDecisions.find((decision) => decision.decisionId === null);

  if (existing) {
    // The same dialog, reported twice: `PermissionRequest` predicted it and the
    // `Notification` then proved it. Keep the earliest `at` — that is when the
    // human was first blocked, and it is what the scraper-release grace and the
    // age bound are measured from — and take the confirmation.
    existing.message = boundDecisionMessage(input.message) ?? existing.message;
    existing.toolName = boundDecisionToolName(input.toolName) ?? existing.toolName;
    // Issue #2031, same rule as the two lines above it: a second sighting that
    // knows the rules fills them in, one that does not leaves the earlier
    // answer alone. The measured pair is exactly this — the `PermissionRequest`
    // forecast carries no patterns, the `Notification` that confirms it does.
    existing.patterns = boundDecisionPatterns(input.patterns) ?? existing.patterns;
    existing.decisionId ??= decisionId;
    if (confirmed) {
      existing.source = 'notification';
      existing.confirmedAt ??= input.at;
    }
    return;
  }

  if (turn.pendingDecisions.length >= MAX_PENDING_DECISIONS_PER_TURN) {
    // S14(d). Counted rather than dropped in silence: an agent raising more
    // approvals than this in one turn is a fact an operator has to be able to
    // see, and the oldest is the one a human has been looking at.
    dropsFor(key).decisionOverflow += 1;
    return;
  }

  turn.pendingDecisions.push({
    decisionId,
    at: input.at,
    source: input.source,
    message: boundDecisionMessage(input.message),
    toolName: boundDecisionToolName(input.toolName),
    patterns: boundDecisionPatterns(input.patterns),
    confirmedAt: confirmed ? input.at : null,
    scraperCorroborated: false,
    recorded: false,
  });
}

/** Retire every dialog this instance was holding. */
export function releaseAllDecisions(key: string): void {
  const turn = fencedTurn(key);
  if (turn !== null) turn.pendingDecisions = [];
}

/**
 * Retire the record a verdict was delivered for (Issue #1898).
 *
 * Matched on {@link AgentEventRecord.decisionId} when both sides have one: an
 * agent that can run two approvals at once would otherwise have the reply to
 * the first retire the record for the second. When either side is anonymous the
 * release is unconditional — an unmatched id is a source that publishes none,
 * and refusing to act there would leave the pre-#1898 stall in place for it.
 */
function releaseSettledDecision(key: string, record: AgentEventRecord): void {
  const turn = fencedTurn(key);
  if (turn === null || turn.pendingDecisions.length === 0) return;
  const settledId = record.decisionId === null || record.decisionId === undefined
    ? null
    : acceptExternalId(record.decisionId);
  if (settledId === null) {
    turn.pendingDecisions = [];
    return;
  }
  turn.pendingDecisions = turn.pendingDecisions.filter(
    (decision) => decision.decisionId !== null && decision.decisionId !== settledId
  );
}

/** Keep the turn map bounded the way every other map in this module is. */
function boundTurnMap(): void {
  trimOldestEntries(agentTurns, MAX_RECENT_EVENT_KEYS);
}
