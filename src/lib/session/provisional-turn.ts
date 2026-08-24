/**
 * The per-instance turn model (Issue #1930, 方針書 §4 D3 決定 2・3 / §5.2 / §6.2).
 *
 * ## What this replaces
 *
 * Issue #1926 landed the CONTRACT — `turnId` / `openedAt` / `closedAt` /
 * `closedBy` on `structuredEvents` — and derived it from the single most recent
 * structured event, because that was all `agent-event-state` retained. Its own
 * module doc said what was wrong with that and named the fix:
 *
 * > It is not a stable turn identity yet. The retained record is one event, so
 * > a `pre_tool_use` arriving mid-turn re-stamps `openedAt` and therefore the
 * > id. […] that is exactly what the Phase 4 `TurnRecord` fixes.
 *
 * This module is that `TurnRecord`. The state it describes is held by
 * `agent-event-state` (one record per `(worktree, tool, instance)`); everything
 * here is pure, so the whole state machine can be driven from a test with no
 * tmux session, no database and no clock behind it.
 *
 * ## The two rules the old model could not express
 *
 *  1. **An event that carries no verdict does not close a turn, and does not
 *     erase one either** (§4 D3 決定 2). Under "the newest event is the
 *     verdict", a `session_start`, a `session_end`, an unrecognised
 *     `Notification` or a `permission.replied` frame each overwrote the record
 *     the verdict was read from, so an event that said nothing published
 *     "nothing is known". Issue #1903 fixed the one instance of that which was
 *     measured (copilot's late `SessionStart`) by *holding the delivery*; here
 *     the rule is general, and the hold is only about which event is displayed.
 *  2. **A turn has an identity**, so `turnId` survives the tool calls inside it
 *     and does not survive a session that was recreated underneath it.
 *
 * ## Why the file is still called `provisional-turn.ts`
 *
 * Because the published field names are a contract that `capture --json`,
 * `wait` and the header chip already read, and renaming the module would move
 * that contract for no reader's benefit. The *provisional* derivation is gone;
 * see {@link derivePublishedTurn}, which now reads a real record.
 *
 * @module lib/session/provisional-turn
 */

import { MAX_EVENT_DETAIL_LENGTH, type AgentEventType } from '@/lib/hooks/agent-event-types';
import {
  MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH,
  type StructuredPromptSource,
} from '@/lib/session/structured-prompt';

/**
 * The events that mean "the agent is mid-turn".
 *
 * The same three `wait.ts` adopts a turn from (`TURN_OPENING_EVENT_TYPES`), and
 * that is not a coincidence to be tidied away: `wait`'s `adoptTurnStart` reads
 * {@link PublishedTurn.openedAt} since Issue #1930, so a derivation that opened
 * a turn on a different set would silently change `wait`'s completion gate.
 * `tests/unit/session/status-contract-1926.test.ts` pins the two sets equal —
 * the CLI cannot import this module (`tsconfig.cli.json` sets `"paths": {}`),
 * so the pin is the only thing holding them together.
 *
 * `stop` is not here and `notification(idle_prompt)` is not either: #1839
 * measured Claude emitting `idle_prompt` 62 s into a turn that ran nothing, so
 * only `Stop` ends a turn and nothing but these three opens one.
 */
export const TURN_ACTIVITY_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
]);

/**
 * Why a turn ended.
 *
 * The vocabulary §7 reserved and this Issue fills in. Every value is a
 * different *kind* of evidence, and an operator reading `capture --json` or a
 * `wait` diagnostic has to be able to tell them apart:
 *
 *  - `stop` — the agent's own `Stop`, for the session that opened the turn.
 *    The only value that is the agent speaking.
 *  - `session_end` — the agent's session ended under the turn (`/clear`, exit).
 *    Not a completion: the work was abandoned, so no `ready` is published.
 *  - `stale` — nothing has been heard for {@link TURN_STALE_AFTER_MS}. The
 *    bound that stops a lost `Stop` from asserting `running` forever.
 *  - `scraper_evidence` — the terminal frame said "done" on
 *    {@link SCRAPER_COMPLETION_POLLS} consecutive polls with positive evidence.
 *    The screen, not the agent.
 *  - `resync_idle` — a source that can be re-read (`capabilities.resync`) was
 *    asked after a dropped transport and answered "not busy".
 *  - `generation` — the process that owned the turn was replaced.
 */
export const TURN_CLOSE_REASONS = [
  'stop',
  'session_end',
  'stale',
  'scraper_evidence',
  'resync_idle',
  'generation',
] as const;

export type TurnCloseReason = (typeof TURN_CLOSE_REASONS)[number];

/**
 * How long a turn is trusted after the last thing that was heard about it
 * (Issue #1723, renamed here in #1930).
 *
 * Hooks are fail-open by design: a timeout or a refused connection costs the
 * event and never the agent's turn (`agent-hooks-live-verification.md` §1.1).
 * A *lost* `Stop` is therefore possible, and without a bound it would leave
 * this layer asserting `running` for a session that finished — `commandmate
 * wait` would then poll until `--timeout` on a session the scraper could have
 * called done. The bound converts "forever" into "at most this long", after
 * which the scraper takes the session back.
 *
 * Deliberately generous. A single agent turn running past 30 minutes is
 * ordinary for the workloads this tool exists to babysit, and expiring a live
 * verdict mid-turn costs the whole benefit of the two-layer split.
 *
 * Re-exported by `agent-event-state` as `STRUCTURED_STATE_MAX_AGE_MS`, which is
 * the name `status-evidence` and the suites already read. One expression, two
 * names — §4 D1 決定 2 forbids two expressions, not two spellings.
 */
export const TURN_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * How long a dialog record is held without being answered (Issue #1930).
 *
 * §4 D3 asks for `dialogPendingMaxMs` as a **retention** bound, and separates it
 * from the **delivery** bound (`decisionTimeoutSeconds`, #1924). The two answer
 * different questions and are allowed to disagree:
 *
 *  - delivery — "can a verdict from this server still reach the agent?"
 *    copilot gives up after ~10 s. Past it the record is reported as
 *    `deliveryExpired`; the dialog is **still on screen**, so `waiting` is kept.
 *    Expiring the state there would tell an operator the pane is free while a
 *    human is still blocked on it.
 *  - retention — "is this record still describing something?" Two values,
 *    because the two sources of a record are different kinds of statement:
 *
 *    `predicted` (20 s) is a `PermissionRequest` this server declined to decide.
 *    It fires *before* the dialog, so it is a prediction — an accurate one (D5
 *    measured `{}` landing in the ordinary TUI approval flow), but about a
 *    version of the agent, a permission mode and a rule set this server does not
 *    get to see in full. A prediction that nothing confirms must expire, because
 *    the cost of it sticking is a `wait --on-prompt agent` that exits 10 on a
 *    session with no dialog in it. 20 s is generous against both confirmations:
 *    `Notification(permission_prompt)` lands at ~6 s, and the scraper reads the
 *    pane through a 5 s capture cache on a 5 s poll.
 *
 *    `confirmed` is the turn's own staleness bound: something independent saw
 *    the dialog, so it is as trustworthy as the turn around it.
 */
export const DIALOG_PENDING_MAX_MS = {
  predicted: 20_000,
  confirmed: TURN_STALE_AFTER_MS,
} as const;

/**
 * Consecutive positive "the agent is back at its composer" polls that close a
 * turn as {@link TurnCloseReason} `scraper_evidence`.
 *
 * Three rather than one, because one poll is one capture and a capture taken
 * mid-repaint is exactly the frame the detector is worst at. Three at the 5 s
 * poll is ~15 s of agreement, which is far inside the 30-minute staleness bound
 * it exists to shorten and far outside any single-frame artefact.
 *
 * **This does not complete a `wait`.** `wait`'s turn-boundary gate is
 * `lastStopEventAt`, and #1839 measured why: a 529 storm returns Claude to its
 * composer in ~3 s having executed nothing, with the frame reading positively
 * as `ready`. Closing the turn here retires the *structured verdict* — so
 * `capture --json` and `instances` stop saying `running` for a session nothing
 * is running in — and leaves the completion question exactly where #1839 and
 * #1975 put it.
 */
export const SCRAPER_COMPLETION_POLLS = 3;

/**
 * Cap on the decisions one turn retains (S14(d)).
 *
 * The list is fed by frames from a process CommandMate did not start. An agent
 * that raised hundreds of approvals in one turn must cost a bounded record, and
 * the overflow has to be *counted* rather than dropped in silence — see
 * `getAgentEventDropCounts`.
 */
export const MAX_PENDING_DECISIONS_PER_TURN = 16;

/**
 * Longest external id this layer will store (S1).
 *
 * Ids arrive from the agent and reach a Map key, a log line and a JSON payload.
 * An id longer than this is **discarded, never truncated**: a truncated id
 * compares equal to a different id that shares its prefix, which would let one
 * approval's reply retire another's record. The discard is counted
 * (`idsDiscarded`) so an operator can see it happened.
 */
export const MAX_EXTERNAL_ID_LENGTH = 128;

/**
 * One approval this instance is blocked on, as much of it as is kept (S3).
 *
 * **The received payload is deliberately not retained.** What a permission
 * request carries is the agent's own `tool_input` — a command line, a patch, a
 * file's contents — and this record outlives the request by up to 30 minutes in
 * a process that also serves it back over HTTP. What is kept is what a later
 * reader has to be able to do: match a reply to the dialog it answers
 * ({@link decisionId}), tell an operator what is being asked ({@link message} /
 * {@link toolName}, both bounded), and re-judge it against a policy that
 * changed — which reads the *live* list off the source
 * (`pending-decision-recheck`) rather than anything stored here.
 *
 * The fields below {@link decisionId} are the #1725 episode verbatim: this type
 * is what `getStructuredPromptWaiting` returns, and `prompt-waiting-composition`
 * writes {@link scraperCorroborated} / {@link recorded} on the live object.
 */
export interface StructuredPendingDecision {
  /**
   * The agent's own id for this approval, or null (Issue #1898).
   *
   * Present only for a source whose `capabilities.eventIdentity` names one. It
   * is what makes "this reply answered *that* dialog" a question with an
   * answer. Published as `pendingDecisions[].id`; teaching `commandmate respond`
   * to name one is #1932's work, not this Issue's.
   */
  decisionId: string | null;
  /** Epoch ms the dialog was first reported. */
  at: number;
  /** Which signal reported it. */
  source: StructuredPromptSource;
  /** The agent's own human-facing line, or null. Display only (D3). */
  message: string | null;
  /** Tool the pre-empted permission request named, or null. */
  toolName: string | null;
  /**
   * Epoch ms something independent established that a dialog is really there:
   * a `Notification(permission_prompt)`, or the scraper reading the frame as
   * `waiting`. Null while the record is still only a prediction.
   */
  confirmedAt: number | null;
  /**
   * Whether the scraper has itself seen a blocking frame during this episode.
   *
   * This is what makes "the scraper observed the prompt disappear" a rule that
   * can be applied at all. A scraper that never saw the dialog cannot report it
   * gone — and that case is not hypothetical, it is the whole reason #1725
   * exists — so only a layer that once said `waiting` is allowed to say
   * `not waiting` and be believed.
   */
  scraperCorroborated: boolean;
  /** Whether a prompt-history row has been written for this episode. */
  recorded: boolean;
}

/** The part of an event record the turn model reads. */
export interface TurnDisplayEvent {
  event: AgentEventType;
  at: number;
  detail: string | null;
}

/**
 * Everything known about one turn of one agent instance.
 *
 * Held by `agent-event-state` under the composite key, one record per instance.
 * A record exists from the event that opened the turn until a later event opens
 * a different one; a *closed* record is retained deliberately, because "the last
 * turn ended at T because of X" is the fact `wait` and the header chip read.
 */
export interface TurnRecord {
  /**
   * Stable for the life of the turn.
   *
   * Derived from `openedAt` plus a per-process sequence, so two turns opened in
   * the same millisecond are still two ids. **Not** derived from the agent's
   * `session_id`: `/clear` issues a new one while the pane, the worktree and the
   * instance all stay put (#1721 §1.1), and a turn id that changed there would
   * be a turn boundary nobody crossed.
   */
  turnId: string;
  /**
   * The agent session the turn belongs to, or null when nothing said.
   *
   * Load-bearing rather than diagnostic since this Issue: a `stop` naming a
   * different session does not close this turn (§4 D3 決定 2), which is what
   * keeps one conversation's idle from completing another's work.
   */
  sessionId: string | null;
  /**
   * Epoch ms of the event that opened the turn, or null when the opening was
   * never observed.
   *
   * Null is the honest answer for a `stop` that arrives with no turn open —
   * the previous events were fenced off, or this server started mid-turn. #1926
   * made the same call for the same reason and it is worth repeating: publishing
   * a guess would be worse than publishing null, because `closedAt - openedAt`
   * is the elapsed time a header chip renders and `wait` adopts a turn from it.
   */
  openedAt: number | null;
  /** Epoch ms the turn ended, or null while it is open. */
  closedAt: number | null;
  /** Why it ended, or null while it is open. */
  closedBy: TurnCloseReason | null;
  /**
   * The generation this turn belongs to, or null when none was ever opened.
   *
   * The fence. Events are keyed by `(worktree, tool, instance)` — a key a
   * recreated session reuses verbatim — so a turn whose generation is not the
   * current one belongs to a process that no longer exists and is read as
   * nothing at all. See `beginAgentEventGeneration`.
   */
  generationAt: number | null;
  /**
   * The event this turn's verdict is read from.
   *
   * Not "the last event": an event carrying no verdict (`session_start`,
   * `session_end`, an unrecognised `Notification`, a `permission_replied`) is
   * inert here, and a `session_start` on a source that declares
   * `sessionStartMayArriveLate` is inert even though it opens a generation.
   * `getLastAgentEvent` is still the honest "what arrived most recently", and
   * `structuredEvents.lastEventType` still publishes that.
   */
  displayEvent: TurnDisplayEvent;
  /** Approvals raised during this turn that nobody has answered. */
  pendingDecisions: StructuredPendingDecision[];
  /**
   * Consecutive polls on which the scraper positively read the pane as finished.
   *
   * Reset by anything the agent says. At {@link SCRAPER_COMPLETION_POLLS} the
   * turn is closed as `scraper_evidence`.
   */
  scraperCompletionPolls: number;
}

/** The turn fields as published on `structuredEvents`. */
export interface PublishedTurn {
  /**
   * The turn's id, or null when no turn is known for this instance.
   *
   * Stable for the life of the turn since Issue #1930 — a `pre_tool_use`
   * arriving mid-turn no longer re-stamps it. A consumer may therefore treat a
   * changed `turnId` as "a new turn began", which `wait` now does.
   */
  turnId: string | null;
  /** Epoch ms the turn opened, or null. */
  openedAt: number | null;
  /** Epoch ms the turn ended, or null. */
  closedAt: number | null;
  /** Why the turn ended, or null while none has. One of {@link TURN_CLOSE_REASONS}. */
  closedBy: string | null;
}

/**
 * Backwards-compatible alias for {@link PublishedTurn}.
 *
 * `StructuredEventsPayload extends ProvisionalTurn` was #1926's spelling and the
 * CLI mirrors the same four fields; keeping the name costs nothing and removing
 * it would be a rename with no reader's benefit.
 */
export type ProvisionalTurn = PublishedTurn;

/** Nothing has been reported, so nothing can be said about a turn. */
export const NO_TURN: PublishedTurn = {
  turnId: null,
  openedAt: null,
  closedAt: null,
  closedBy: null,
};

/**
 * Publish the turn fields for one instance.
 *
 * Pure, and takes the *effective* record — the caller has already applied the
 * generation fence and the staleness bound, because those need state this
 * module does not hold.
 */
export function derivePublishedTurn(turn: TurnRecord | null): PublishedTurn {
  if (turn === null) return NO_TURN;
  return {
    turnId: turn.turnId,
    openedAt: turn.openedAt,
    closedAt: turn.closedAt,
    closedBy: turn.closedBy,
  };
}

/**
 * Accept an external id, or refuse it (S1).
 *
 * Refusal is the whole point: an id that is empty, over-long, or carrying
 * control characters is **discarded**, and the caller then behaves as it does
 * for a source that publishes no id at all — a path every consumer already has,
 * because five of the six sources take it. Truncating instead would manufacture
 * collisions between ids that share a prefix, and the failure that produces
 * (one approval's reply retiring another's record) is silent.
 *
 * @returns The id, or null when it must not be used
 */
export function acceptExternalId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_EXTERNAL_ID_LENGTH) return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // An id reaches a Map key, a log line and a JSON payload; control
    // characters in any of the three are somebody else's parsing bug.
    if (code < 0x20 || code === 0x7f) return null;
  }
  return raw;
}

/** Bound a human-facing line before it is retained (S3). */
export function boundDisplayText(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return raw.slice(0, max);
}

/** {@link boundDisplayText} at the message bound. */
export function boundDecisionMessage(raw: string | null | undefined): string | null {
  return boundDisplayText(raw, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH);
}

/** {@link boundDisplayText} at the detail bound — tool names, subtypes. */
export function boundDecisionToolName(raw: string | null | undefined): string | null {
  return boundDisplayText(raw, MAX_EVENT_DETAIL_LENGTH);
}

/**
 * Whether this decision is still describing something, at `now`.
 *
 * The retention bound of {@link DIALOG_PENDING_MAX_MS}, applied on read. A
 * decision that has fallen out is not mutated in place — the caller drops it and
 * counts it — so this stays a pure predicate.
 */
export function isDecisionLive(decision: StructuredPendingDecision, now: number): boolean {
  const bound =
    decision.confirmedAt === null
      ? DIALOG_PENDING_MAX_MS.predicted
      : DIALOG_PENDING_MAX_MS.confirmed;
  return now - decision.at < bound;
}

/**
 * Whether a verdict from this server can still reach the agent, at `now`.
 *
 * Independent of {@link isDecisionLive} on purpose — see
 * {@link DIALOG_PENDING_MAX_MS}. An expired delivery window keeps `waiting`:
 * the dialog is on the pane whether or not this server can still answer it.
 *
 * The timeout is passed in rather than stored on the record, because it is a
 * *declared capability* of the source (#1924) and `agent-event-state` cannot
 * reach the source registry — its module graph pulls in `better-sqlite3`, which
 * is why every capability arrives there as a value the caller hands over. The
 * one layer that already holds both is `current-output-builder`, which is where
 * this is computed for the payload.
 *
 * @param decisionTimeoutSeconds - `capabilities.decisionTimeoutSeconds`; null
 *   for a source that waits forever, which can never expire
 */
export function isDeliveryExpired(
  decision: StructuredPendingDecision,
  decisionTimeoutSeconds: number | null,
  now: number,
): boolean {
  if (decisionTimeoutSeconds === null) return false;
  return now - decision.at >= decisionTimeoutSeconds * 1000;
}

/**
 * Whether a turn-ending event naming `eventSessionId` ends `turn`.
 *
 * §4 D3 決定 2: a `stop` closes **the turn of the session that sent it**. The
 * acceptance case is "another session's idle": opencode publishes `session.idle`
 * for every session its server holds, including ones belonging to other
 * processes entirely (#1758 §5.6), and one of those completing must not
 * complete this pane's work.
 *
 * When either side is anonymous the two are treated as the same session,
 * because "no id" is the shape a hand-configured #1549 relay hook posts and the
 * rule has to survive it. That residue is bounded by {@link TURN_STALE_AFTER_MS}
 * and by the generation fence.
 */
export function closesTurn(turn: TurnRecord, eventSessionId: string | null): boolean {
  if (turn.sessionId === null || eventSessionId === null) return true;
  return turn.sessionId === eventSessionId;
}
