/**
 * De-duplication of agent event deliveries — the time window and the identity
 * rule — and the per-instance tally of what was dropped.
 *
 * Split out of `agent-event-state` (Issue #3375), which re-exports the public
 * names. The bound helpers ({@link MAX_RECENT_EVENT_KEYS},
 * {@link trimOldestEntries}) live here and are shared by the sibling modules.
 *
 * @module lib/session/agent-event-dedup
 */

import { createHash } from 'crypto';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import type { AgentSourceCapabilities } from '@/lib/hooks/sources/types';
import { acceptExternalId, TURN_ACTIVITY_EVENTS } from '@/lib/session/provisional-turn';
import { getOrInitGlobal } from '../global-state';

// The maps below live on `globalThis`; see the note above `declare global` in
// `agent-event-state` for why (Issue #1736).
declare global {
  // eslint-disable-next-line no-var
  var __agentEventDrops: Map<string, AgentEventDropCounts> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventRecentKeys: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventRecentIdentities: Map<string, Map<string, number>> | undefined;
}

/** compositeKey -> what this instance has had dropped, and why (Issue #1930). */
export const dropCounts = getOrInitGlobal('__agentEventDrops', () => new Map<string, AgentEventDropCounts>());

/** dedup key -> epoch ms it was first seen. See {@link isDuplicateAgentEvent}. */
export const recentEventKeys = getOrInitGlobal('__agentEventRecentKeys', () => new Map<string, number>());

/**
 * compositeKey -> (identity key -> epoch ms it was first seen) (Issue #1899).
 *
 * Nested rather than flat so the bound is *per instance*, which the flat
 * {@link recentEventKeys} is not: one chatty agent must not be able to evict
 * another's ids and let a genuine re-delivery through on a quiet pane. See
 * {@link claimEventIdentity}.
 */
export const recentEventIdentities = getOrInitGlobal('__agentEventRecentIdentities', () => new Map<string, Map<string, number>>());

/**
 * How long two identical events count as one delivery.
 *
 * Issue #1722 injects hooks at session start, and `--settings` hooks are
 * *concatenated* with the user's own rather than replacing them, so anyone who
 * followed the #1549 manual setup now has two `Stop` hooks posting the same
 * turn. `applyAgentStopEvent` is idempotent for the timestamp, but
 * `applyTaskEvent` is not: each delivery writes its own `agent_idle` row, and a
 * reader counting rows would see one turn as two.
 *
 * Both deliveries carry the same `session_id` and land milliseconds apart, so
 * the window is generous relative to the real signal. It is not tight relative
 * to what it can wrongly swallow, which is what this comment used to say: "a
 * turn cannot end twice in three seconds" is false of a turn the agent starts
 * for itself, and Issue #3289 measured the `Stop`s of two turns 1473 ms apart.
 * The clock cannot tell those from two deliveries of one, so for `stop` the
 * window is reset by the start of a turn — and for the start of a turn, which
 * happens twice in three seconds just as readily (Issue #3301), by a `stop`.
 * See {@link isDuplicateAgentEvent}, which also records what the window turned
 * out to be dropping for `user_prompt_submit`: not a second hook's delivery.
 */
export const AGENT_EVENT_DEDUP_WINDOW_MS = 3000;

/** Cap on retained dedup keys, so a long-lived server cannot grow one per turn. */
export const MAX_RECENT_EVENT_KEYS = 512;

/**
 * What this instance has had dropped, and on whose authority (Issue #1930, S14).
 *
 * Every bound in this module discards something, and §7's discoverability rule
 * is that an automatic action visible only in the server log does not exist. So
 * each bound has a counter, the counters are published on `structuredEvents`,
 * and `commandmate capture --json` is where an operator finds out that the
 * reason their `stop` never landed is that something already claimed its id.
 *
 * Counters only ever grow within a generation; they are reset with the rest of
 * the instance state, because a tally that outlived the process it describes
 * would answer a question about a different session.
 */
export interface AgentEventDropCounts {
  /** Deliveries judged repeats, by the rule that judged them (#1899). */
  dedupDropped: { identity: number; timeWindow: number };
  /** Pending decisions discarded because the process that raised them was replaced. */
  decisionEvicted: number;
  /** External ids refused rather than truncated (S1). See {@link acceptExternalId}. */
  idsDiscarded: number;
  /** Pending decisions dropped at the retention bound (`releasedBy: dialog_timeout`). */
  dialogTimedOut: number;
  /** Pending decisions refused because the turn already held {@link MAX_PENDING_DECISIONS_PER_TURN}. */
  decisionOverflow: number;
}

/** A zeroed tally. */
function emptyDropCounts(): AgentEventDropCounts {
  return {
    dedupDropped: { identity: 0, timeWindow: 0 },
    decisionEvicted: 0,
    idsDiscarded: 0,
    dialogTimedOut: 0,
    decisionOverflow: 0,
  };
}

/** The live tally for one instance, created on first use. */
export function dropsFor(key: string): AgentEventDropCounts {
  let counts = dropCounts.get(key);
  if (!counts) {
    counts = emptyDropCounts();
    dropCounts.set(key, counts);
    // The composite key is (worktree, tool, instance) and a long-lived server
    // accumulates worktrees; bounded like every other map here (DR4-009).
    trimOldestEntries(dropCounts, MAX_RECENT_EVENT_KEYS);
  }
  return counts;
}

/**
 * What this instance has had dropped, or a zeroed tally when nothing has.
 *
 * A copy, not the live object: this is published on the hot path and a caller
 * that could mutate it would be able to erase the evidence.
 */
export function getAgentEventDropCounts(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentEventDropCounts {
  const counts = dropCounts.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  if (!counts) return emptyDropCounts();
  return { ...counts, dedupDropped: { ...counts.dedupDropped } };
}

/**
 * Whether this event is a second copy of one already handled, and should be
 * dropped.
 *
 * Only events that name a `sessionId` can be deduplicated, and calling this
 * *claims* the key: a first call answers false and marks it, so the caller must
 * ask once per request and act on the answer. Events with no session id are
 * never suppressed — a caller that omits it (the #1549 relay run without a hook
 * payload, a hand-rolled `curl`) has given us nothing to tell two deliveries of
 * one turn from two genuine turns, and inventing a match there would silently
 * drop real events.
 *
 * The subtype is part of the key (Issue #1726). It has to be, now that
 * `pre_tool_use` exists: that event's subtype is the tool name, several tool
 * calls a second is ordinary, and a key without it would read a `Bash` call and
 * the `AskUserQuestion` that follows it as one delivery and drop the second. The
 * same correction applies to two `Notification`s of different types inside the
 * window, which were previously collapsed as well.
 *
 * ## A `stop` after a turn start is another turn's (Issue #3289)
 *
 * Nothing in the key names a turn, and a `session_id` outlives one: every turn
 * of a conversation carries the same id. So two `stop`s of one session inside
 * the window share a key whether they are two deliveries of one turn or the
 * ends of two, and the second used to be dropped either way. Claude 2.1.289
 * was measured doing the latter — the completion notice of a background task
 * opens a turn the moment the previous one ends, and that turn ended 1473 ms
 * after the first `Stop`. Its `stop` was dropped, the turn it should have
 * closed stayed open, and `commandmate wait` blocked on a finished agent until
 * {@link STRUCTURED_STATE_MAX_AGE_MS}.
 *
 * What tells the two apart is what arrived in between. A delivery in
 * {@link TURN_ACTIVITY_EVENTS} that is itself applied releases every `stop`
 * its session has claimed ({@link releaseStopClaims}), so the next `stop` is a
 * first delivery again, and that `stop`'s own copy is dropped behind it.
 *
 *  - **Those three events, not `user_prompt_submit` alone**, because they are
 *    the ones the turn model opens a turn on, and the property is stated in its
 *    terms: a turn this server opened is never left open by a `stop` dropped as
 *    a copy. antigravity and Command Code send no `user_prompt_submit` at all —
 *    their turns are opened by a tool event — and a narrower rule would leave
 *    them where Claude was.
 *  - **Only a turn start that was applied.** One dropped as a copy is recorded
 *    by nobody and opens no turn, so it releases nothing: a turn start and the
 *    `stop` that answers it are applied together or not at all.
 *  - **Only the session that started the turn.** A turn start with no session
 *    id releases nothing, for the reason the second paragraph gives; another
 *    session's says nothing about this one's `stop` (codex can file a second
 *    instance's turns under the first, #2874).
 *  - **By order of arrival, not by timestamp.** The release is a deletion made
 *    when the turn start is claimed, so it holds for deliveries inside one
 *    millisecond, where comparing "turn started at" with "stop seen at" cannot.
 *
 * What this still cannot tell apart is `stop(A)`, `user_prompt_submit(B)`, and
 * then a *late copy* of `stop(A)`. The copy is read as `stop(B)` and closes
 * turn B early. Nothing it carries says otherwise — the copy that can be late
 * is the relay's, and the relay rebuilds the body it posts (tool, event, cwd,
 * session id) and drops the rest of the payload — and the order needs a hook
 * the agent does not wait for. Claude Code runs its `Stop` hooks to completion
 * before the next turn's `UserPromptSubmit` (in the measurement the prompt
 * arrives 29 ms after the reply to the `Stop` and 540 ms after the `Stop`
 * itself), `type: "http"` has no async form, and
 * `scripts/hooks/cmate-agent-event.sh` posts with a foreground `curl`. That
 * leaves a hand-written `"async": true` command hook, where the cost is a
 * `wait` that returns one turn early — against a `wait` that does not return
 * at all on the configuration CommandMate itself injects.
 *
 * The alternative was to put the turn in the key: a per-session counter, bumped
 * by a turn start. It decides every case above the same way, the late copy
 * included, and it needs a second map that has to outlive every key built from
 * it — prune the counter while its key is still inside the window and the copy
 * gets a different key and is applied — with a bound, a pruning rule and a test
 * seam of its own. Releasing the claim keeps no state beyond the map that was
 * already here, so {@link MAX_RECENT_EVENT_KEYS} bounds it as before.
 *
 * ## A turn start after a `stop` is another turn's (Issue #3301)
 *
 * The same defect from the other side. A turn start is on the window as well,
 * and a turn can start twice in three seconds: logged on 2026-10-04, the
 * `UserPromptSubmit` of a turn a background task's completion notice opened,
 * that turn's `Stop` 2624 ms later, and the next notice's `UserPromptSubmit`
 * 22 ms after the `Stop`. The second start was dropped as a copy of the first,
 * so this server never opened the turn the agent was in and went on publishing
 * the end of the previous one.
 *
 * So the release runs in both directions: a `stop` that is itself applied
 * releases every turn start its session has claimed
 * ({@link releaseTurnStartClaims}), and the next one is a first delivery
 * again. Together the two releases leave the window comparing a delivery only
 * with what has arrived since the last turn boundary this server applied — the
 * one stretch in which "the same event again" can mean a copy.
 *
 *  - **All of {@link TURN_ACTIVITY_EVENTS}, every subtype**, for the reason the
 *    other direction gives: antigravity's and Command Code's turns are opened
 *    by a tool event, and a short turn of either can open with the tool the
 *    previous one used.
 *  - **Only a `stop` that names the session.** One with no session id is never
 *    judged a copy, and cannot say whose turn it ended either.
 *  - **Only a `stop` that was applied**, as with the turn start above — though
 *    with both releases in place neither condition decides anything any more:
 *    a delivery is dropped only while the one it copies holds its claim, and
 *    that one released the other side of the boundary when it was applied.
 *  - **Also for a `stop` that never reaches this function.**
 *    {@link classifyAgentEventDelivery} lets the `stop` of a source that
 *    declares an identity through before the window is consulted, and makes
 *    the release itself. OpenCode V2 is the source that needs it: its
 *    `session.execution.started` carries no id and is judged here.
 *
 * What the window still drops on this side is not the double delivery its
 * constant describes. The injected settings register one `UserPromptSubmit`
 * hook, and in the server logs of 2026-10-02 to 2026-10-05 a `Stop` —
 * registered the same way — was dropped once, by the defect #3289 fixed. A
 * `UserPromptSubmit` was dropped in 15 bursts, and the session transcripts say
 * what each one was. Thirteen are Claude Code taking two or three
 * background-task notices off its queue at once, after a tool result, and
 * attaching them to the turn that is already running: it fires the hook once
 * per notice, 4–21 ms apart, and the deliveries match the transcript's
 * `queue-operation: remove` entries one for one. One is the operator
 * submitting a prompt 804 ms into a running turn. One is the defect above.
 * These are different prompts joining one turn, not copies of one event.
 * Counting them as one is still right — none of them begins a turn — and none
 * has a `stop` before it, because the turn it joins has not ended. That is what
 * makes a `stop` the thing to release on. Since Issue #3330 it no longer
 * decides the turn either: a notice the window lets through is marked
 * {@link AgentEventRecord.joinsOpenTurn} and continues the running turn, so a
 * burst — and a notice minutes into the turn, which the window never saw as a
 * repeat — leaves `turnId` where it was.
 *
 * What this cannot tell apart:
 *
 *  - `start(A)`, `stop(A)`, then a *late copy* of `start(A)`. The copy is read
 *    as `start(B)` and opens a turn no `stop` is coming for: `running` is
 *    published until the scraper has seen the composer on
 *    {@link SCRAPER_COMPLETION_POLLS} polls, and a `commandmate wait` that
 *    adopted the turn is left waiting for a `stop`. The copy has to arrive
 *    after the whole turn and inside three seconds of the original; any later
 *    and it was applied before this change too. Claude Code holds the turn
 *    until its `UserPromptSubmit` hooks have answered (a stalled one is
 *    cancelled at its timeout and only then does the session go on,
 *    `docs/design/agent-hooks-live-verification.md` §5.3.3), `type: "http"`
 *    has no async form, and the relay posts with a foreground `curl`; every
 *    burst above landed before the model was called. That leaves the
 *    hand-written `"async": true` command hook again, beside the injected one
 *    and on a turn shorter than its delay — §5.3.6 measured one posting after
 *    a four-second session had already finished.
 *  - A tool event of turn A that arrives after `stop(A)`, inside three seconds
 *    of one for the same tool: read as the first activity of a new turn, at
 *    the same cost. It takes a tool hook the agent does not wait for, or a
 *    tool call that outlives the turn that made it. Not measured per tool; in
 *    the logs above no tool event arrives within three seconds of a `stop` of
 *    codex or Command Code, of which there are about thirty.
 *  - `start(A)`, `start(B)` with no `stop` of their session applied between
 *    them. `start(B)` is dropped, as before. When the `Stop` was lost (every
 *    hook failure is fail-open), the turn this server opened for A is still
 *    open, so what it publishes stays true and `stop(B)` closes it. When the
 *    `Stop` came without a session id, it closed that turn — {@link closesTurn}
 *    reads an anonymous `stop` as the open turn's — and released nothing, so
 *    the defect is as it was. That takes hand-written hooks that send the
 *    session id on the turn start and not on the `Stop`.
 *  - The late copy of `stop(A)` above, one step on. Read as `stop(B)`, it is
 *    an applied `stop` and releases turn starts like any other, so a copy of
 *    `start(B)` behind it is read as `start(C)`. Two unwaited copies in a row.
 *
 * The alternative was the agent's own name for the turn: Claude's payloads
 * carry a `prompt_id` on `UserPromptSubmit` and on `Stop`. It could not be
 * measured here whether a turn the agent starts for itself gets a new one on
 * the hook channel (the transcript's `promptId` does change from one such turn
 * to the next), nor whether the hooks of one burst share one — and if they do
 * not, a key built on it turns each burst into that many turns. It would also
 * cover one tool on one channel: the relay script does not forward the field,
 * codex spells it `turn_id`, and copilot, gemini and antigravity carry nothing
 * of the kind (#1757 R5), so all of them stay on the window either way. The
 * counter described above is the remaining alternative, and it loses to a
 * release here for the reasons it lost there.
 *
 * @param at - Epoch ms; defaults to now
 * @param detail - The event's subtype, when it has one
 */
export function isDuplicateAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  event: AgentEventType,
  sessionId: string | null | undefined,
  at: number = Date.now(),
  detail: string | null = null
): boolean {
  if (!sessionId) return false;

  const composite = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const key = dedupKey(composite, event, detail, sessionId);
  const seenAt = recentEventKeys.get(key);
  if (seenAt !== undefined && at - seenAt < AGENT_EVENT_DEDUP_WINDOW_MS) {
    return true;
  }

  recentEventKeys.set(key, at);
  if (TURN_ACTIVITY_EVENTS.has(event)) releaseStopClaims(composite, sessionId);
  else if (event === 'stop') releaseTurnStartClaims(composite, sessionId);
  pruneRecentEventKeys(at);
  return false;
}

/** The key {@link isDuplicateAgentEvent} claims: `<instance> <event> <detail> <session>`. */
function dedupKey(composite: string, event: AgentEventType, detail: string | null, sessionId: string): string {
  return [composite, event, detail ?? '', sessionId].join(' ');
}

/**
 * When the delivery that claimed this event's de-duplication key was received
 * (Issue #3311), or null when nothing holds the key.
 *
 * Read by the receiver right after {@link isDuplicateAgentEvent} dropped an
 * event — a drop does not move the claim — so `at - result` is how long after
 * the applied delivery the dropped one came. That interval is what the daily
 * metrics read to tell a copy (a few ms) from a second turn the window
 * swallowed; it changes nothing here.
 */
export function agentEventKeyClaimedAt(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  event: AgentEventType,
  sessionId: string | null | undefined,
  detail: string | null = null
): number | null {
  if (!sessionId) return null;
  const composite = buildCompositeKey(worktreeId, cliToolId, instanceId);
  return recentEventKeys.get(dedupKey(composite, event, detail, sessionId)) ?? null;
}

/**
 * The agent's session id in a form a log line may carry (Issue #3311): the
 * first 8 hex characters of its SHA-256. Enough to tell the sessions of one
 * instance apart in a day's log; the id itself is never written, because the
 * daily metrics that read these lines are published.
 */
export function shortSessionTag(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

/**
 * Forget every `stop` one session of one instance has claimed (Issue #3289).
 *
 * Every subtype: antigravity (#2614) and claude (#3430) post `stop` /
 * `self_resume_pending` beside the plain one.
 */
function releaseStopClaims(composite: string, sessionId: string): void {
  releaseClaims(composite, ['stop'], sessionId);
}

/**
 * Forget every turn start one session of one instance has claimed
 * (Issue #3301) — {@link releaseStopClaims} from the other side of the turn
 * boundary.
 *
 * Every event in {@link TURN_ACTIVITY_EVENTS} and every subtype: a tool event's
 * subtype is the tool's name, and a turn claims one key per tool it called.
 */
function releaseTurnStartClaims(composite: string, sessionId: string): void {
  releaseClaims(composite, TURN_ACTIVITY_EVENTS, sessionId);
}

/**
 * Forget every claim one session of one instance holds on `events`, whatever
 * subtype it was made under.
 *
 * A walk instead of a lookup because the subtype sits in the middle of the key
 * {@link isDuplicateAgentEvent} builds — `<instance> <event> <detail>
 * <session>` — and the subtypes that were claimed are not known here. The walk
 * is over at most {@link MAX_RECENT_EVENT_KEYS} entries.
 */
function releaseClaims(
  composite: string,
  events: Iterable<AgentEventType>,
  sessionId: string
): void {
  const prefixes = Array.from(events, (event) => `${composite} ${event} `);
  const suffix = ` ${sessionId}`;
  const claimedUnder = (key: string, prefix: string): boolean =>
    key.length >= prefix.length + suffix.length && key.startsWith(prefix);

  for (const key of recentEventKeys.keys()) {
    if (key.endsWith(suffix) && prefixes.some((prefix) => claimedUnder(key, prefix))) {
      recentEventKeys.delete(key);
    }
  }
}

/** Drop keys past the window, then the oldest survivors if still over the cap. */
function pruneRecentEventKeys(now: number): void {
  for (const [key, seenAt] of recentEventKeys) {
    if (now - seenAt >= AGENT_EVENT_DEDUP_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
  // Map iterates in insertion order, so the head is the oldest.
  while (recentEventKeys.size > MAX_RECENT_EVENT_KEYS) {
    const oldest = recentEventKeys.keys().next();
    if (oldest.done) break;
    recentEventKeys.delete(oldest.value);
  }
}

/** How many dedup keys are currently retained. Test seam for the bound above. */
export function getRecentEventKeyCount(): number {
  return recentEventKeys.size;
}

// =============================================================================
// Identity de-duplication (Issue #1899)
// =============================================================================

/**
 * Event words whose repeat is a fact about the session, not a re-delivery
 * (Issue #1899; design §4 D3 decision 2).
 *
 * These are the two words that end something, and neither of them carries an
 * id on any source measured so far. `session.idle` — opencode's `stop` — is
 * `{ "sessionID": "ses_…" }` and nothing else, which is exactly why
 * `sources/opencode/turn-gate` exists. With no id, a generic deduper has only
 * the clock, and the clock cannot tell a second turn from a second delivery:
 * #1899 measured a real `stop` 2.5 s after the previous one being dropped,
 * which leaves the newest event at `user_prompt_submit`, the instance reading
 * `running`, and `commandmate wait` blocked until the 30-minute staleness
 * bound.
 *
 * **The exemption is conditional on the source declaring an identity**, and
 * that condition is the whole safety argument. A source that declares one is a
 * source with a real deduper elsewhere — on the SSE path, `TurnGate`, which
 * arms on `session.status(busy)` and completes on the first `session.idle`
 * after arming, so the abort double-idle (19 ms apart, §5.3.2) never reaches
 * the ingest at all. Push hooks have no such gate: #1722's concatenated
 * settings really do post two `Stop`s for one turn, so they stay on the window
 * in {@link isDuplicateAgentEvent}, which is what every hook receiver still
 * calls.
 *
 * The window had the same defect there — Claude ends two turns inside three
 * seconds when it resumes itself (Issue #3289) — and it is closed differently,
 * because a push source has no gate to lean on and so cannot be exempted: on
 * the window, a `stop` is released by the start of a turn instead.
 *
 * Being exempt does not make a `stop` any less the end of a turn. The turn
 * starts of a declared source are on the window whenever their frame carries
 * no id, so the `stop` let through here releases them, as a `stop` on the
 * window does (Issue #3301; {@link classifyAgentEventDelivery}).
 */
export const LIFECYCLE_AGENT_EVENT_TYPES: readonly AgentEventType[] = ['stop', 'session_end'];

/** Which rule judged a delivery a repeat. */
export type AgentEventDedupBasis = 'identity' | 'time-window';

/** One delivery, described as far as its source can describe it. */
export interface AgentEventDelivery {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  event: AgentEventType;
  /** The event's subtype, when it has one. */
  detail: string | null;
  /** The source's own conversation id. Only the time-window rule reads it. */
  sessionId: string | null | undefined;
  /** Epoch ms. */
  at: number;
  /**
   * The frame's own id — `AgentEventSource.eventIdentityOf` — or null when
   * this frame publishes none.
   */
  identity: string | null;
  /**
   * What the source declares in {@link AgentSourceCapabilities.eventIdentity}.
   * `null` selects the time window, which is every push source today.
   */
  identityKind: AgentSourceCapabilities['eventIdentity'];
}

/** Whether to drop this delivery, and on whose authority. */
export type AgentEventDedupVerdict =
  | { duplicate: false }
  | { duplicate: true; by: AgentEventDedupBasis };

/**
 * Whether this delivery is a second copy of one already handled (Issue #1899).
 *
 * The tool-agnostic replacement for calling {@link isDuplicateAgentEvent}
 * directly, and it branches on the source's declared capability rather than on
 * its name — flip opencode's `eventIdentity` to `null` and every case below
 * falls back to the 3-second window it used before this Issue.
 *
 * Three rules, in order:
 *
 *  1. **The frame has an id** — key on it, with no time bound at all. An id is
 *     a claim about identity that a clock cannot improve on: two approvals
 *     1 s apart are two approvals, and the same approval replayed by
 *     `resyncPending` four minutes later is still one approval. That second
 *     half is what the ingest's window was reaching for ("a frame delivered
 *     twice by a re-sync racing the live stream") and never actually covered,
 *     since a re-sync is not obliged to land within three seconds.
 *  2. **No id, but the word ends something** — never suppressed. See
 *     {@link LIFECYCLE_AGENT_EVENT_TYPES}. A `stop` that leaves by this rule
 *     releases its session's turn starts from the window on the way (#3301):
 *     rule 3 would have done it, and this `stop` never gets there.
 *  3. **Anything else** — the time window, unchanged. That is every push
 *     source, and the identity-declaring source's `session.created` /
 *     `session.error`, which publish no id either but are not turn boundaries
 *     — and OpenCode V2's `session.execution.started`, which is one. A push
 *     source's `stop` is on it too, and is released from it by the start of a
 *     turn (#3289), as a turn start is by a `stop` (#3301) — rules of
 *     {@link isDuplicateAgentEvent}'s, not of this function's.
 *
 * Calling this *claims* the key, exactly as {@link isDuplicateAgentEvent} does:
 * ask once per delivery and act on the answer.
 */
export function classifyAgentEventDelivery(
  delivery: AgentEventDelivery
): AgentEventDedupVerdict {
  const composite = buildCompositeKey(
    delivery.worktreeId,
    delivery.cliToolId,
    delivery.instanceId
  );

  if (delivery.identityKind !== null) {
    // Issue #1930 / S1: the id is the agent's, and it becomes a Map key. One
    // that fails validation is DISCARDED — the delivery then takes the
    // no-id path below, which is a path this function already has — rather than
    // truncated, because a truncated id compares equal to a different id that
    // shares its prefix and would drop a real event as a repeat.
    const identity = delivery.identity === null ? null : acceptExternalId(delivery.identity);
    if (delivery.identity !== null && identity === null) dropsFor(composite).idsDiscarded += 1;

    if (identity !== null) {
      if (claimEventIdentity(delivery, identity)) {
        dropsFor(composite).dedupDropped.identity += 1;
        return { duplicate: true, by: 'identity' };
      }
      return { duplicate: false };
    }
    if (LIFECYCLE_AGENT_EVENT_TYPES.includes(delivery.event)) {
      // Issue #3301: this `stop` is applied without the window ever seeing it,
      // so the release an applied `stop` owes its session's turn starts is made
      // here. Those turn starts ARE on the window whenever their frame carries
      // no id, which is every `session.execution.started` of OpenCode V2.
      if (delivery.event === 'stop' && delivery.sessionId) {
        releaseTurnStartClaims(composite, delivery.sessionId);
      }
      return { duplicate: false };
    }
  }

  const duplicate = isDuplicateAgentEvent(
    delivery.worktreeId,
    delivery.cliToolId,
    delivery.instanceId,
    delivery.event,
    delivery.sessionId,
    delivery.at,
    delivery.detail
  );
  if (!duplicate) return { duplicate: false };
  dropsFor(composite).dedupDropped.timeWindow += 1;
  return { duplicate: true, by: 'time-window' };
}

/**
 * Claim `(event, detail, identity)` for one instance, answering whether it was
 * already claimed.
 *
 * `event` and `detail` are in the key and are not decoration: opencode asks an
 * approval under `properties.id` and answers it under `properties.requestID`
 * with **the same `per_…` value** (#1898), so a key made of the identity alone
 * would read `permission.replied` as a repeat of `permission.asked` and drop
 * the one frame that releases the dialog. The same shape covers
 * `pre_tool_use` / `post_tool_use`, which share a `callID`.
 *
 * `sessionId` is deliberately *not* in the key. An id is unique within the
 * agent that issued it, and folding in a field that is null on some deliveries
 * would let the same frame through twice.
 */
function claimEventIdentity(delivery: AgentEventDelivery, identity: string): boolean {
  const composite = buildCompositeKey(
    delivery.worktreeId,
    delivery.cliToolId,
    delivery.instanceId
  );

  let claimed = recentEventIdentities.get(composite);
  if (!claimed) {
    claimed = new Map<string, number>();
    recentEventIdentities.set(composite, claimed);
    // Bound the instances as well as the entries per instance: the composite
    // key is (worktree, tool, instance) and a long-lived server accumulates
    // worktrees (DR4-009).
    trimOldestEntries(recentEventIdentities, MAX_RECENT_EVENT_KEYS);
  }

  const key = [delivery.event, delivery.detail ?? '', identity].join(' ');
  if (claimed.has(key)) return true;

  claimed.set(key, delivery.at);
  trimOldestEntries(claimed, MAX_RECENT_EVENT_KEYS);
  return false;
}

/** Drop the oldest entries until the map fits. Maps iterate in insertion order. */
export function trimOldestEntries<V>(entries: Map<string, V>, max: number): void {
  while (entries.size > max) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * How many identities are retained for one instance, or across all of them when
 * no instance is named. Test seam for the bound above.
 */
export function getRecentEventIdentityCount(
  worktreeId?: string,
  cliToolId?: CLIToolType,
  instanceId?: string
): number {
  if (worktreeId === undefined || cliToolId === undefined) {
    let total = 0;
    for (const claimed of recentEventIdentities.values()) total += claimed.size;
    return total;
  }
  return recentEventIdentities.get(buildCompositeKey(worktreeId, cliToolId, instanceId))?.size ?? 0;
}
