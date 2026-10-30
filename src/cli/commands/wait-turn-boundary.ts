/**
 * wait Command - turn boundaries: completion basis, turn adoption, self-resume and the prompt ledger
 * Issue #3964: split out of wait.ts; wait.ts re-exports what it exported.
 */

import type { WaitOptions } from '../types';
import type { CurrentOutputResponse, PromptMessageResponse } from '../types/api-responses';
import type { ApiClient } from '../utils/api-client';
import { POLL_INTERVAL_MS } from './wait-timing';

/**
 * Why `wait` decided the agent was done, printed on the completion line
 * (Issue #1839).
 *
 * `Completed: <id>` used to be the whole story, which made two very different
 * situations indistinguishable in a log: the agent's own `Stop` hook arrived, or
 * nothing but the screen said so. The measurement behind this Issue is exactly
 * that difference — a 529 storm returns Claude to its composer in ~3 s with the
 * scraper reporting `ready`/`input_prompt` and no `Stop` ever sent — so the
 * basis belongs next to the verdict rather than in a triage session afterwards.
 */
export const COMPLETION_BASIS = {
  /** The agent reported the turn ended, and the report postdates this wait's turn. */
  HOOK_STOP: 'hook_stop',
  /** The tmux session went away after we had seen it alive. */
  SESSION_GONE: 'session_gone',
  /** The terminal frame says the agent is back at its composer. Nothing corroborated it. */
  SCRAPER_READY: 'scraper_ready',
} as const;

/**
 * Structured event types that mean "a turn is under way" (Issue #1839).
 *
 * Mirrors AGENT_EVENT_TYPES in src/lib/hooks/agent-event-types.ts; duplicated
 * rather than imported because the CLI bundle keeps its own copy of the API
 * shapes (see api-responses.ts).
 *
 * `notification` is deliberately absent, and that is the one measured deviation
 * from the design sketched in Issue #1839. The Issue proposed accepting
 * `stop` **or** `idle_prompt` as the end of a turn; the live capture of
 * 2026-08-20 (see docs/design/upstream-fault-turn-boundary-1839.md) shows
 * Claude 2.1.236 emitting `Notification(idle_prompt)` 62 s into a turn that
 * ran nothing at all, because the composer had been idle for a minute. Reading
 * it as a turn boundary would have re-created the false completion this gate
 * exists to stop, one minute later. Only `Stop` ends a turn.
 *
 * Exported for the cross-layer pin in
 * `tests/unit/session/status-contract-1926.test.ts`. The server opens a turn on
 * the same three events (`src/lib/session/provisional-turn.ts`
 * TURN_ACTIVITY_EVENTS), and since Issue #1930 `adoptTurnStart` reads that
 * turn's `openedAt` rather than this set — so a set that drifted would change
 * this gate silently. The set is still read here for the pre-#1930 fallback
 * path, and the CLI cannot import the server module (`tsconfig.cli.json` sets
 * `"paths": {}`), so the test is the only thing holding the two together.
 */
export const TURN_OPENING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
]);

/**
 * How far *before* this wait started a turn-opening event may sit and still be
 * read as the turn this wait is about (Issue #1839).
 *
 * `wait` does not know when `send` ran, and the honest proxy is its own start:
 * an orchestrator sends and then waits, so the turn's `UserPromptSubmit` lands
 * after `wait` is already polling (measured at +0.6 s from the send). One poll
 * interval of slack covers a `wait` that starts a moment late.
 *
 * The bound is what keeps this from being a new way to hang, and Issue #1930
 * narrowed what it has to defend against. It was written when structured events
 * were NOT fenced by generation on the way into `structuredEvents`, so a stale
 * `user_prompt_submit` from a previous agent process could still be the last
 * event on the wire and this window was the only thing stopping it from gating
 * a wait for ever. The server fences the turn now and publishes null when it
 * does, so the window's remaining job is narrower and sharper: a turn that has
 * already CLOSED must have closed inside this wait to count, or `wait` on a
 * session that finished an hour ago would inherit that turn's gate. An open
 * turn is adopted whatever its age — see {@link adoptTurnStart}.
 */
const TURN_ADOPTION_GRACE_MS = POLL_INTERVAL_MS;

/**
 * Whether this server publishes a real turn record (Issue #1930).
 *
 * `dialogPendingMaxMs` landed with the turn model and is set on every payload a
 * server of that vintage produces, so its presence is the version probe. A
 * *value* rather than a version string, for the reason #1924 gives for the
 * capability block: a payload that has to be interpreted by its sender's
 * version number is a payload nobody can read forward.
 *
 * The probe is needed because the two readings below disagree in exactly the
 * case that matters. On a #1930 server, `openedAt` being null while
 * `lastEventType` is `user_prompt_submit` means the turn was fenced off by a
 * generation or aged out — the server has *decided* it is not this instance's
 * turn. Falling back to the event on such a payload would put back the stale
 * adoption the turn record exists to remove.
 */
export function publishesTurnRecord(data: CurrentOutputResponse): boolean {
  return data.structuredEvents?.dialogPendingMaxMs != null;
}

/**
 * Adopt the turn this wait is about, if this poll shows one (Issue #1839,
 * moved onto the turn record in #1930).
 *
 * ## What changed, and why the grace window is no longer the whole guard
 *
 * Before #1930 this read `lastEventType` / `lastEventAt` — the newest event of
 * any kind — and refused anything older than {@link TURN_ADOPTION_GRACE_MS},
 * because (in the words of that constant) structured events "are NOT fenced by
 * generation on the way into `structuredEvents`", so a stale
 * `user_prompt_submit` from a previous agent process could still be the last
 * event on the wire. The bound was the only thing keeping such a record from
 * gating a wait for ever.
 *
 * The server fences the turn now, and publishes null when it does. So an **open**
 * turn is adopted whatever its age — which closes a hole the old reading had:
 * a turn that opened ten minutes before this `wait` started, and is still
 * running, used to be adopted only because its *newest* event was fresh. An
 * agent that goes quiet mid-turn (thinking, a long tool call) has no fresh
 * event, so the #1839 gate came down at exactly the moment a 529 storm would
 * exploit it.
 *
 * A **closed** turn still has to have opened inside this wait's window, and the
 * reason is the one the grace constant gives: `wait` does not know when `send`
 * ran, so the last turn of a session that finished an hour ago must not gate a
 * wait that has only just started. `commandmate wait` on an already-idle
 * session therefore adopts nothing and completes on its first poll, exactly as
 * it did before — #1975 measured that at 234/242/259 ms and it is the
 * orchestrator's normal path.
 *
 * @param previous - the turn start adopted so far, or null
 * @returns the newest adopted turn start, or `previous` when nothing qualified
 */
export function adoptTurnStart(
  data: CurrentOutputResponse,
  waitStartedAt: number,
  previous: number | null,
): number | null {
  const events = data.structuredEvents;
  if (!events) return previous;

  if (!publishesTurnRecord(data)) {
    // A server older than #1930. Same reading this function has had since
    // #1839, kept so a newer CLI pointed at an older server does not silently
    // lose the gate.
    if (events.lastEventAt == null || events.lastEventType == null) return previous;
    if (!TURN_OPENING_EVENT_TYPES.has(events.lastEventType)) return previous;
    if (events.lastEventAt < waitStartedAt - TURN_ADOPTION_GRACE_MS) return previous;
    return previous === null || events.lastEventAt > previous ? events.lastEventAt : previous;
  }

  const openedAt = events.openedAt;
  // Null covers every "there is no turn to adopt" case the server knows about:
  // nothing reported, a previous generation, aged out, or a `stop` whose
  // opening was never observed.
  if (openedAt == null) return previous;
  if (events.closedAt != null && openedAt < waitStartedAt - TURN_ADOPTION_GRACE_MS) {
    return previous;
  }
  return previous === null || openedAt > previous ? openedAt : previous;
}

/**
 * `structuredEvents.closedBy`, phrased for a diagnostic line (Issue #1930).
 *
 * The server's close-reason vocabulary and {@link COMPLETION_BASIS} answer two
 * different questions — "why did the turn end" and "what did `wait` decide on"
 * — and are deliberately printed side by side rather than folded together.
 * `hook_stop` is the only place they meet: it is `closedBy: 'stop'` seen from
 * the CLI's end. Everything else (`stale`, `scraper_evidence`, `session_end`,
 * `generation`, `resync_idle`) is a reason the turn stopped being trusted, which
 * is precisely what `wait` must NOT read as completion.
 */
export function describeTurnClose(data: CurrentOutputResponse): string {
  const events = data.structuredEvents;
  if (!events) return 'turn=unknown';
  const id = events.turnId ?? 'none';
  const closedBy = events.closedBy ?? (events.openedAt != null ? 'open' : 'none');
  return `turn=${id} closedBy=${closedBy}`;
}

/**
 * Whether the agent has reported the end of the turn this wait adopted
 * (Issue #1839).
 *
 * True when no turn was adopted at all, which is the whole of the unchanged
 * path: a session whose agent posts no hooks never adopts one, so every caller
 * on a machine without hook injection sees precisely the pre-#1839 behaviour.
 */
export function turnSettled(data: CurrentOutputResponse, turnStartedAt: number | null): boolean {
  if (turnStartedAt === null) return true;
  const stoppedAt = data.lastStopEventAt;
  return stoppedAt != null && stoppedAt >= turnStartedAt;
}

/**
 * The structured event that ends a turn (Issue #1975).
 *
 * The counterpart of {@link TURN_OPENING_EVENT_TYPES}, kept as a bare constant
 * because the vocabulary a source declares in `capabilities.supportedEvents` is
 * the wire's, not this build's: a tool that cannot say `stop` cannot release the
 * hold below, so asking for the word by name is the whole of the check.
 */
const TURN_CLOSING_EVENT_TYPE = 'stop';

/**
 * How long `wait` will hold a composer frame open for an agent that has been
 * handed a prompt it has not reported the end of (Issue #1975).
 *
 * The hold's *reason* is exact — see {@link outstandingPrompt} — so this is not
 * a settling window standing in for evidence. It is the bound the contract of
 * this Issue asks for: hooks are fail-open on every path, so a `Stop` that is
 * simply lost (the receiver was restarted, the machine-wide
 * `~/.copilot/settings.json` was rewritten by another server mid-session, the
 * 4-second curl in the hook timed out) must not turn `wait` into a command that
 * never returns. After this it completes on the frame alone, exactly as it did
 * before this Issue, and says so.
 *
 * 60s is the same dwell {@link UNCLASSIFIED_DWELL_MS} uses for the same job, and
 * it is ~55x the widest send-to-turn-open window measured for this Issue
 * (2026-08-22, copilot 1.0.80 against an isolated server: 0.04s / 0.75s / 0.88s
 * / 1.10s over four sends, the last of them a cold session start). `--timeout`
 * and `--stall-timeout` below 60s still win, as they do for the unclassified
 * dwell: this pre-empts long waits, it does not extend short ones.
 */
export const PENDING_PROMPT_HOLD_MS = 60_000;

/**
 * Whether this tool's event source claims it can report both ends of a turn
 * (Issue #1975).
 *
 * The gate that keeps the hold below off every path it has no evidence for.
 * `structuredEvents.source.capabilities` is #1924's declaration, published to
 * the CLI already, and the compatibility source a tool with no implementation
 * gets (`src/lib/hooks/sources/legacy-relay.ts`) declares `supportedEvents: []`
 * — so a tool that posts no hooks answers `false` here and takes precisely the
 * pre-#1975 path. So does a server older than #1924, which sends no `source` at
 * all.
 *
 * Both words are required. Without a turn-opening word nothing would ever open
 * the turn this waits for; without `stop` nothing could ever close it, and the
 * hold would only ever end at its own bound.
 */
export function reportsTurnBoundaries(data: CurrentOutputResponse): boolean {
  const declared = data.structuredEvents?.source?.capabilities?.supportedEvents;
  if (!Array.isArray(declared)) return false;
  return (
    declared.includes(TURN_CLOSING_EVENT_TYPE) &&
    declared.some(event => TURN_OPENING_EVENT_TYPES.has(event))
  );
}

/**
 * The `stop` detail meaning "the agent ended its turn with its own background
 * work still running, and resumes by itself when that work finishes"
 * (Issue #2614).
 *
 * A copy of `SELF_RESUME_PENDING_DETAIL` in `src/lib/hooks/agent-event-types.ts`
 * for the reason {@link TURN_OPENING_EVENT_TYPES} is a copy: the CLI builds with
 * `"paths": {}`. `tests/unit/cli/commands/wait-self-resume-2614.test.ts` pins the
 * two together.
 */
export const SELF_RESUME_PENDING_DETAIL = 'self_resume_pending';

/**
 * The capability a source declares when its `stop` can carry
 * {@link SELF_RESUME_PENDING_DETAIL} (Issue #2614).
 *
 * Read by name rather than through the mirrored type in `api-responses.ts`,
 * which predates it: `structuredEvents.source.capabilities` is published as the
 * source's whole declaration, so a newer server sends the key and an older one
 * simply does not.
 */
export const SELF_RESUME_CAPABILITY = 'stopReportsSelfResume';

/**
 * How long `wait` holds a `stop` whose agent said it would resume by itself
 * (Issue #2614).
 *
 * Measured 2026-09-17 against antigravity 1.2.4: a `schedule` of 60 s closed the
 * turn, the agent woke 58 s after its `Stop` and did it again three more times,
 * and the real end came five minutes after the first `Stop` — which is where
 * `wait` had already reported `Completed (basis=hook_stop)` and started a
 * verification against a half-finished worktree. The wake is not something to
 * time: it is a `post_tool_use` that opens a new turn, and #1839's gate takes
 * over from there. What needs a bound is only the case where it never comes.
 *
 * A timer's own length is not on the wire (the `schedule` arguments reach the
 * permission receiver and stop there), and a command sent to the background has
 * no length at all, so the bound is the one the server already uses for the
 * same question the other way round: how long an open turn is trusted with
 * nothing heard (`TURN_STALE_AFTER_MS` in `src/lib/session/provisional-turn.ts`,
 * pinned equal by `wait-self-resume-2614.test.ts`). Every wake starts a new
 * `stop` and a new hold, so an agent that keeps rescheduling never reaches it.
 *
 * A constant, like {@link PENDING_PROMPT_HOLD_MS}: `--timeout` and
 * `--stall-timeout` below it still win.
 */
export const SELF_RESUME_HOLD_MS = 30 * 60 * 1000;

/**
 * Whether this tool's event source can say, on its `stop`, that the agent will
 * resume by itself (Issue #2614).
 *
 * The same kind of gate as {@link reportsTurnBoundaries}, and it requires that
 * one too: the hold below is released by a turn-opening event, and a source
 * that cannot send one could only ever end the hold at its bound. A server that
 * predates the declaration answers `false`, and so does every source but the one
 * that writes the detail.
 */
function reportsSelfResume(data: CurrentOutputResponse): boolean {
  const declared: Readonly<Record<string, unknown>> | undefined =
    data.structuredEvents?.source?.capabilities;
  return declared?.[SELF_RESUME_CAPABILITY] === true && reportsTurnBoundaries(data);
}

/**
 * The instant of the `stop` this agent said it would resume from, or null
 * (Issue #2614).
 *
 * Non-null only while that `stop` is still the newest thing the agent has said.
 * The wake is a `post_tool_use` (antigravity reports the timer's own tool call
 * finishing when it fires), which replaces the displayed event and opens a new
 * turn, so this answers null from the first poll after it — and a later `stop`
 * is a different instant, which is how a hold knows it is about a new one.
 *
 * On a server that publishes a turn record the `stop` must also be what closed
 * that turn: a turn ended by `generation` or `session_end` belongs to a process
 * that is gone, and nothing it scheduled is going to wake anything.
 */
export function pendingSelfResumeStop(data: CurrentOutputResponse): number | null {
  if (!reportsSelfResume(data)) return null;
  const events = data.structuredEvents;
  if (!events || events.lastEventType !== TURN_CLOSING_EVENT_TYPE) return null;
  if (events.lastEventDetail !== SELF_RESUME_PENDING_DETAIL) return null;
  // `closedBy` is the server's close-reason vocabulary; `'stop'` there is the
  // agent's own `Stop`, the only close this hold is about.
  if (publishesTurnRecord(data) && events.closedBy !== 'stop') return null;
  return events.lastEventAt ?? null;
}

/** What the chat ledger could tell us about the newest prompt (Issue #1975). */
export type PromptLedgerRead =
  /** Epoch ms of the newest prompt sent to this instance, or null if it has had none. */
  | { readable: true; submittedAt: number | null }
  /** The ledger could not be read. Not a verdict — see the call site. */
  | { readable: false };

/**
 * When this (worktree, instance) was last handed a prompt (Issue #1975).
 *
 * `limit=1&unit=pairs` is "every row at or after the newest user message"
 * (src/lib/db/chat-db.ts), which is the smallest query that is *guaranteed* to
 * contain that message: plain `limit=1` returns the newest row of either role,
 * and for a turn the agent has already answered that row is the assistant's.
 *
 * Scoped the same way the poll above is: `--instance` when the caller named one,
 * otherwise the `cliToolId` the server resolved for that same poll. Asking
 * unscoped would let a message sent to claude decide a wait on codex.
 *
 * Never throws. An unreadable ledger is not evidence that nothing was sent, so
 * it is reported as such rather than as "nothing was sent" — the call site
 * degrades to the pre-#1975 behaviour instead of holding on a guess.
 *
 * `quietWhenAborted` (Issue #3974): a read aborted by `signal` prints no note,
 * for a caller that says what an aborted read leads to itself; other failures
 * print it as before.
 */
export async function readNewestPromptAt(
  client: ApiClient,
  worktreeId: string,
  options: WaitOptions,
  data: CurrentOutputResponse,
  signal?: AbortSignal,
  quietWhenAborted = false,
): Promise<PromptLedgerRead> {
  const query = new URLSearchParams({ limit: '1', unit: 'pairs' });
  if (options.instance) query.set('instance', options.instance);
  else if (data.cliToolId) query.set('cliTool', data.cliToolId);

  try {
    // Issue #3956: `signal` only when a caller bounds the read; the others
    // call `get` exactly as before.
    const path = `/api/worktrees/${worktreeId}/messages?${query.toString()}`;
    const rows = signal
      ? await client.get<PromptMessageResponse[]>(path, { signal })
      : await client.get<PromptMessageResponse[]>(path);
    let newest: number | null = null;
    for (const row of rows ?? []) {
      if (row.role !== 'user') continue;
      // ISO string on the wire (a JSON-serialized Date), so this is the only
      // place the two clocks meet — and both sides of the comparison below are
      // stamped by the server, so no CLI/server skew enters the verdict.
      const at = Date.parse(row.timestamp);
      if (Number.isNaN(at)) continue;
      if (newest === null || at > newest) newest = at;
    }
    return { readable: true, submittedAt: newest };
  } catch (error) {
    if (quietWhenAborted && signal?.aborted) return { readable: false };
    console.error(
      `Note: could not read the message ledger for ${worktreeId} ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        'completion will be judged from the frame alone.',
    );
    return { readable: false };
  }
}

/**
 * Whether the newest prompt this instance was handed is still unanswered
 * (Issue #1975).
 *
 * This is the distinction the whole Issue turns on, and it is a comparison of
 * two server-stamped facts rather than a timer:
 *
 *   - **idle before this wait began** — the agent's `Stop` postdates the newest
 *     prompt. Nothing is outstanding; `wait` completes on the first poll exactly
 *     as it always has. An orchestrator waiting on a session that finished long
 *     ago pays nothing.
 *   - **`send` a moment ago** — the newest prompt postdates the last `Stop`
 *     (or there has never been one). The agent has been given work and has not
 *     reported finishing it, so a composer frame is "it has not started yet",
 *     not "it is done".
 *
 * `wait` could not tell these apart before, because from `current-output` alone
 * they are the same payload: in both, the last thing the agent said was the
 * previous turn's `stop`, and `adoptTurnStart` adopts nothing. Measured against
 * copilot 1.0.80 on 2026-08-22, the window in which that is true after a send is
 * ~1s wide, and `wait`'s first poll is immediate — which is why the false
 * completions came back in 0.3s with `basis=scraper_ready`, 3 times in 5.
 *
 * The fast-turn case falls out of the same comparison rather than needing a rule
 * of its own: a turn that opens and closes between two polls leaves
 * `lastEventType: 'stop'` (so no turn is adopted) but a `stop` that postdates
 * the prompt — answered, and completed on the spot.
 */
export function outstandingPrompt(data: CurrentOutputResponse, submittedAt: number): boolean {
  const stoppedAt = data.lastStopEventAt;
  return stoppedAt == null || stoppedAt < submittedAt;
}
