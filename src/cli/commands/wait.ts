/**
 * wait Command - Block until agent completion or prompt detection
 * Issue #518: [DR1-08] Factory pattern
 *
 * Exit codes [DR1-03]:
 * - 0: SUCCESS (agent completed)
 * - 10: PROMPT_DETECTED (agent waiting for user input, including arrow-key
 *       selection lists — Issue #1628 — and interactive frames the detection
 *       layer could not classify at all — Issue #1708. Both are reported as
 *       exit 10 with a distinguishing `type` rather than a new exit code, so
 *       callers that already branch on 10 keep working.)
 * - 11: UPSTREAM_FAULT (--fail-on-upstream-fault only, Issue #1839: the agent
 *       came back to its composer with an upstream API failure on the frame)
 * - 124: TIMEOUT (--timeout exceeded)
 * Issue #1544 adds --verify / --require-work, which can turn a detected
 * completion into 20 (VERIFY_FAILED) or 21 (NOT_STARTED).
 * Issue #1628 also returns 21 without --verify when the session was never
 * running: a wait with nothing to wait for must not report success.
 * Infrastructure errors use ExitCode (1, 2, 99)
 */

import { Command } from 'commander';
import { ExitCode, VerifyExitCode, WAIT_EXIT_CODE_PRIORITY, WaitExitCode } from '../types';
import type { WaitOptions } from '../types';
import type {
  AutoYesSuppressionReason,
  CurrentOutputResponse,
  PromptMessageResponse,
  TaskListResponse,
  TaskStatus,
  WaitPromptOutput,
} from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { runVerification, WORK_EVIDENCE_GATE_ID } from '../utils/verify-runner';
import { WAIT_INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';

/** [IA3-02] Polling interval 5 seconds (matches tmux-capture-cache TTL=2s) */
const POLL_INTERVAL_MS = 5000;

/**
 * `type` reported for a blocked-on-a-human frame that carries no parsable prompt
 * (Issue #1628). Arrow-key menus — Codex's pager and `/model`, antigravity's
 * permission menu, OpenCode's `/models` overlay — are deliberately published as
 * selection lists rather than prompts so the UI renders NavigationButtons, which
 * left `wait` with no signal at all for them: it polled until the timeout while
 * the agent sat stopped. They are not answerable as a prompt, so the payload
 * names the state instead of inventing options.
 */
const SELECTION_LIST_PROMPT_TYPE = 'selection_list';

/**
 * `type` reported for an interactive frame the detection layer could not
 * classify at all (Issue #1708).
 *
 * Rides the existing exit 10 rather than a new code on purpose: every caller
 * that already branches on PROMPT_DETECTED (the `--auto-yes` dispatch runner
 * among them) keeps working and simply meets a kind it does not recognise,
 * whereas a new exit code reads as an infrastructure error to all of them.
 */
const UNCLASSIFIED_PROMPT_TYPE = 'unclassified';

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
const COMPLETION_BASIS = {
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
 * How long `isUnclassifiedActive` must hold before `wait` treats it as a stop
 * reason (Issue #1708).
 *
 * The flag is a single-poll observation of "interactive, but unparsed", and a
 * frame captured mid-repaint can raise it once and clear on the next poll — so
 * stopping on the instantaneous value would abort healthy runs. 60s is 12
 * consecutive POLL_INTERVAL_MS polls: far past any repaint, far short of the
 * 900s timeout this exists to pre-empt.
 *
 * Intentionally a constant with no flag. Two consequences, both intended:
 *   - `--timeout`/`--stall-timeout` below 60s always win, so a caller that asks
 *     for a short deadline still gets 124 rather than a delayed 10. The dwell
 *     pre-empts long waits; it does not extend short ones.
 *   - There is no way to tune it per call. Add one only if a real pane is found
 *     that legitimately sits unclassified for a minute — a flag here is a knob
 *     for working around a detector bug, and the bug is the thing to fix.
 */
const UNCLASSIFIED_DWELL_MS = 60_000;

/**
 * How recent `autoYes.lastSuppression` must be to be reported as the reason this
 * wait is blocked (Issue #1699).
 *
 * The record is refreshed on every poll for as long as the suppressed prompt is
 * on screen, so a fresh timestamp means "this is happening now" while an old one
 * is a historical suppression of some earlier prompt. The window is generous
 * against the server's own poll interval — being a few seconds late with a true
 * report beats staying silent, which is the failure this exists to fix.
 */
const SUPPRESSION_FRESH_MS = 60_000;

type LastSuppression = NonNullable<CurrentOutputResponse['autoYes']['lastSuppression']>;

/** The suppression currently blocking this session, or null. */
function activeSuppression(
  data: CurrentOutputResponse,
  now: number,
): { suppression: LastSuppression; ageSeconds: number } | null {
  const suppression = data.autoYes?.lastSuppression;
  if (!suppression) return null;
  const ageMs = now - suppression.at;
  // A negative age is clock skew between the CLI and the server, not staleness.
  if (ageMs > SUPPRESSION_FRESH_MS) return null;
  return { suppression, ageSeconds: Math.max(0, Math.round(ageMs / 1000)) };
}

/** The wording for the four reasons a contract's `autoYes` block really authors. */
const CONTRACT_POLICY_CAUSE = 'by contract policy';

/**
 * What withheld the answer, in the words `wait` puts on stderr (Issue #1843).
 *
 * A Record over the whole reason union rather than one fixed phrase: adding a
 * reason to {@link AutoYesSuppressionReason} without deciding what `wait` should
 * say about it is a compile error here, which is the point. Until #1843 the
 * notice hard-coded "by contract policy" for every reason, so #1829's
 * `agent-launch-dialog` — a product-side decision the poller makes with no
 * contract in sight (`src/lib/auto-yes-poller.ts`, the `getCodexLifecycleDialog`
 * branch) — sent operators of contract-less worktrees hunting for a
 * `denyPatterns` entry that did not exist.
 *
 * The three sites that record a suppression are covered: the poller's launch-dialog
 * branch (`agent-launch-dialog`), the poller's policy branch and
 * `lib/hooks/permission-decision-service.ts` (both the four `evaluatePolicyAgainstTexts`
 * verdicts, which is why those four keep the pre-#1843 wording exactly).
 */
const SUPPRESSION_CAUSE: Record<AutoYesSuppressionReason, string> = {
  'mode-off': CONTRACT_POLICY_CAUSE,
  'deny-pattern': CONTRACT_POLICY_CAUSE,
  'deny-pattern-unusable': CONTRACT_POLICY_CAUSE,
  'type-not-allowed': CONTRACT_POLICY_CAUSE,
  'agent-launch-dialog': "while the agent's launch dialog was on screen",
  // Issue #1924. Deliberately not "by contract policy": no contract was
  // consulted. The frame looked like a numbered list to the generic estimator
  // and like prose to the tool's own detector, and an operator who reads this
  // should go and look at the pane rather than at `denyPatterns`.
  'unclassified-frame': 'because no tool-specific dialog detector recognised the frame',
};

/**
 * {@link SUPPRESSION_CAUSE} for a reason that arrived over the wire.
 *
 * `reason` is a server-supplied string, so a server newer than this CLI can name
 * a reason the union does not have. Naming it verbatim is the only honest answer:
 * quietly folding an unknown reason into "by contract policy" is the same
 * misattribution #1843 exists to remove, just for a future reason instead of
 * `agent-launch-dialog`.
 */
function suppressionCause(reason: string): string {
  return Object.prototype.hasOwnProperty.call(SUPPRESSION_CAUSE, reason)
    ? SUPPRESSION_CAUSE[reason as AutoYesSuppressionReason]
    : `for a reason this CLI does not recognise (${reason})`;
}

/**
 * One stderr line naming what is holding this prompt (Issue #1699).
 *
 * `wait` used to print only "Waiting for human response...", which reads the
 * same whether a human was always going to answer or whether Auto-Yes silently
 * refused to. That ambiguity is what let a deny pattern matching a finished turn
 * stall two workers unnoticed; the pattern and the reason code belong on screen.
 *
 * Issue #1843: the cause is chosen per reason rather than asserted. `reason=` is
 * in the payload either way, so the prefix is the only part that can lie — and it
 * did, for every non-contract suppression.
 */
function formatSuppressionNotice(suppression: LastSuppression, ageSeconds: number): string {
  const parts = [
    `reason=${suppression.reason}`,
    `mode=${suppression.mode ?? 'none'}`,
    `promptType=${suppression.promptType}`,
  ];
  if (suppression.pattern !== undefined) {
    parts.push(`pattern=${JSON.stringify(suppression.pattern)}`);
  }
  const cause = suppressionCause(suppression.reason);
  return `  auto-yes suppressed this prompt ${cause}: ${parts.join(' ')} (${ageSeconds}s ago)`;
}

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
function publishesTurnRecord(data: CurrentOutputResponse): boolean {
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
function adoptTurnStart(
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
function describeTurnClose(data: CurrentOutputResponse): string {
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
function turnSettled(data: CurrentOutputResponse, turnStartedAt: number | null): boolean {
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
const PENDING_PROMPT_HOLD_MS = 60_000;

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
function reportsTurnBoundaries(data: CurrentOutputResponse): boolean {
  const declared = data.structuredEvents?.source?.capabilities?.supportedEvents;
  if (!Array.isArray(declared)) return false;
  return (
    declared.includes(TURN_CLOSING_EVENT_TYPE) &&
    declared.some(event => TURN_OPENING_EVENT_TYPES.has(event))
  );
}

/** What the chat ledger could tell us about the newest prompt (Issue #1975). */
type PromptLedgerRead =
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
 */
async function readNewestPromptAt(
  client: ApiClient,
  worktreeId: string,
  options: WaitOptions,
  data: CurrentOutputResponse,
): Promise<PromptLedgerRead> {
  const query = new URLSearchParams({ limit: '1', unit: 'pairs' });
  if (options.instance) query.set('instance', options.instance);
  else if (data.cliToolId) query.set('cliTool', data.cliToolId);

  try {
    const rows = await client.get<PromptMessageResponse[]>(
      `/api/worktrees/${worktreeId}/messages?${query.toString()}`,
    );
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
function outstandingPrompt(data: CurrentOutputResponse, submittedAt: number): boolean {
  const stoppedAt = data.lastStopEventAt;
  return stoppedAt == null || stoppedAt < submittedAt;
}

/**
 * Poll a single worktree until completion, prompt, or timeout.
 */
async function pollWorktree(
  client: ApiClient,
  worktreeId: string,
  options: WaitOptions,
): Promise<{ exitCode: number; output?: WaitPromptOutput }> {
  const startTime = Date.now();
  let lastActivityTime = Date.now();
  let lastContent = '';
  /**
   * Issue #1628: whether this wait ever saw the session alive. `!isRunning` on the
   * FIRST poll is "there is nothing here to wait for", not "the agent finished" —
   * reporting SUCCESS for it is how a wait on a worktree whose agent never started
   * (wrong tool, wrong instance, session never created) came back `Completed` in
   * milliseconds and handed a `passed` verdict to whatever ran next.
   */
  let everRunning = false;
  /**
   * Epoch ms of the first poll in the current unbroken run of
   * `isUnclassifiedActive === true`, or null when the last poll cleared it
   * (Issue #1708).
   */
  let unclassifiedSince: number | null = null;
  /**
   * Epoch ms of the `user_prompt_submit` / `pre_tool_use` / `post_tool_use` this
   * wait adopted as "the turn I am waiting on", or null when the agent has
   * reported none (Issue #1839). See {@link adoptTurnStart}.
   */
  let turnStartedAt: number | null = null;
  /**
   * Whether the chat ledger is still worth asking (Issue #1975). Cleared by the
   * first read that fails, after which this wait judges completion from the
   * frame alone — the pre-#1975 behaviour — rather than re-reporting the same
   * unreachable endpoint on every poll.
   */
  let promptLedgerReadable = true;

  while (true) {
    // Check timeout
    if (options.timeout) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed >= options.timeout) {
        console.error(`Timeout: ${worktreeId} exceeded ${options.timeout}s`);
        return { exitCode: WaitExitCode.TIMEOUT };
      }
    }

    // Check stall-timeout
    if (options.stallTimeout) {
      const stallElapsed = (Date.now() - lastActivityTime) / 1000;
      if (stallElapsed >= options.stallTimeout) {
        console.error(`Stall timeout: ${worktreeId} no output for ${options.stallTimeout}s`);
        return { exitCode: WaitExitCode.TIMEOUT };
      }
    }

    try {
      // Issue #868: scope polling to a specific agent instance when provided.
      const path = options.instance
        ? `/api/worktrees/${worktreeId}/current-output?instance=${encodeURIComponent(options.instance)}`
        : `/api/worktrees/${worktreeId}/current-output`;
      const data = await client.get<CurrentOutputResponse>(path);

      // Track content changes for stall detection
      if (data.content !== lastContent) {
        lastContent = data.content;
        lastActivityTime = Date.now();
      }

      if (data.isRunning) {
        everRunning = true;
      }

      // Issue #1839: done before any exit path so the turn is adopted even on a
      // poll that ends in a prompt — the same turn is still open when the human
      // answers and `--on-prompt human` resumes polling.
      turnStartedAt = adoptTurnStart(data, startTime, turnStartedAt);

      // Prompt detected
      if (data.isPromptWaiting && data.promptData) {
        // Issue #1699: report a policy suppression on both exits — the human one
        // keeps polling and would otherwise say nothing about why nobody
        // answered, and the agent one is read by pipelines that never see stderr.
        const suppressed = activeSuppression(data, Date.now());

        // [DR1-03] Prompt detection exit code
        if (options.onPrompt === 'human') {
          // Block and continue polling - user handles prompt manually
          console.error(`Prompt detected on ${worktreeId}. Waiting for human response...`);
          if (suppressed) {
            console.error(formatSuppressionNotice(suppressed.suppression, suppressed.ageSeconds));
          }
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Default (agent mode): output prompt info and exit 10
        //
        // Issue #1898: the degraded `unclassified` payload carries no `options`
        // — by construction, because nothing parsed the screen — but for a
        // source whose approvals are answered by decision id it does carry
        // `decisionOptions`, which ARE answerable (`respond <id> 1`). Reporting
        // an empty list there told the caller a dialog was open and gave it
        // nothing to do about it, which is the whole of #1898-3 seen from the
        // pipeline's side.
        const promptOptions =
          (data.promptData.options as unknown[])?.length
            ? (data.promptData.options as unknown[])
            : (data.promptData.decisionOptions ?? []);
        const promptOutput: WaitPromptOutput = {
          worktreeId,
          cliToolId: data.cliToolId || 'claude',
          type: data.promptData.type || 'unknown',
          question: data.promptData.question || '',
          options: promptOptions,
          status: data.promptData.status || 'pending',
          ...(data.promptData.approvalTarget !== undefined && {
            approvalTarget: data.promptData.approvalTarget,
          }),
          ...(suppressed && {
            autoYesSuppression: {
              reason: suppressed.suppression.reason,
              mode: suppressed.suppression.mode,
              promptType: suppressed.suppression.promptType,
              ...(suppressed.suppression.pattern !== undefined && {
                pattern: suppressed.suppression.pattern,
              }),
              ageSeconds: suppressed.ageSeconds,
            },
          }),
        };
        if (suppressed) {
          console.error(formatSuppressionNotice(suppressed.suppression, suppressed.ageSeconds));
        }

        return { exitCode: WaitExitCode.PROMPT_DETECTED, output: promptOutput };
      }

      // Issue #1628: an arrow-key menu is the agent blocked on a human just as much
      // as a numbered prompt is, but it is published with isPromptWaiting=false so
      // the UI can render NavigationButtons instead of PromptPanel. Treat it as a
      // prompt here — otherwise `wait` polls a stopped agent until --timeout.
      if (data.isSelectionListActive) {
        if (options.onPrompt === 'human') {
          console.error(
            `Selection list active on ${worktreeId} (${data.sessionStatusReason ?? 'selection_list'}). ` +
              'Waiting for human response...',
          );
          // Issue #1699: the poller parses frames status-detector publishes as
          // selection lists, so a policy can be the reason this one is stuck too.
          const suppressed = activeSuppression(data, Date.now());
          if (suppressed) {
            console.error(formatSuppressionNotice(suppressed.suppression, suppressed.ageSeconds));
          }
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        return {
          exitCode: WaitExitCode.PROMPT_DETECTED,
          output: {
            worktreeId,
            cliToolId: data.cliToolId || 'claude',
            type: SELECTION_LIST_PROMPT_TYPE,
            question: data.sessionStatusReason ?? SELECTION_LIST_PROMPT_TYPE,
            options: [],
            status: 'pending',
          },
        };
      }

      // Issue #1708: the frame is interactive but nothing could parse it. The
      // detection layer is the single entry point every downstream safeguard
      // hangs off, so a frame that slips past it disables Auto-Yes, the exit-10
      // handoff and the contract's autoYes policy all at once — and `wait` used
      // to burn its whole --timeout without ever mentioning it. Treat a
      // PERSISTENT unclassified frame as a stop reason of its own.
      //
      // The dwell deliberately spans ALL THREE states that raise this flag, and
      // the completion check below is suppressed while it is up. That is the
      // whole point, and it is worth spelling out because the obvious reading is
      // the wrong one. The server's definition (`isUnclassifiedFrame` in
      // `src/lib/session/status-evidence.ts`, restated there by Issue #2011):
      //
      //   isUnclassifiedActive =
      //     running && (default | unknown_frame | no_recent_output)
      //
      // `no_recent_output` is there because a static unrecognised overlay
      // DEGRADES into it — once the Auto-Yes poller stamps
      // lastServerResponseTimestamp, a frame that stopped changing flips from
      // `running`/`default` after STALE_OUTPUT_THRESHOLD_MS (5s). `unknown_frame`
      // is the same floor for a tool that opts out of the generic composer check
      // (copilot, opencode), and says "this tool's own rules looked and read
      // nothing". Both arrive about twelve times faster than this dwell. Letting
      // the completion check claim one turned a stalled worker into `Completed`,
      // which is worse than the timeout Issue #1708 complained about: exit 124
      // stops a pipeline, exit 0 lets it merge. Measured before this guard: two
      // unclassified polls followed by the degraded state returned SUCCESS.
      //
      // What is deliberately NOT in the set is `ready`/`input_prompt` with
      // `statusEvidence: 'none'` — the agent back at its composer on a frame no
      // tool-specific idle rule could vouch for. That frame WAS classified; what
      // is missing is positive proof, which is a different question and §4 D1's
      // to answer. Issue #1927 folded the two together and every idle Claude pane
      // stopped completing (#2011). Whether `wait` should hold for evidence as
      // well as classification is open, and any answer belongs in the same place
      // as the rollout that produces the evidence — not here.
      if (data.isUnclassifiedActive === true) {
        if (unclassifiedSince === null) unclassifiedSince = Date.now();
        const dwellMs = Date.now() - unclassifiedSince;
        if (dwellMs >= UNCLASSIFIED_DWELL_MS) {
          const dwellSeconds = Math.round(dwellMs / 1000);
          const question =
            `Unclassified interactive frame on ${worktreeId} for ${dwellSeconds}s ` +
            `(status=${data.sessionStatus ?? 'unknown'}/${data.sessionStatusReason ?? 'unknown'}). ` +
            `The detection layer could not parse it; inspect the raw pane with ` +
            `\`commandmate capture ${worktreeId} --pane\`.`;

          if (options.onPrompt === 'human') {
            console.error(question);
            console.error('Waiting for human response...');
            await sleep(POLL_INTERVAL_MS);
            continue;
          }

          console.error(question);
          return {
            exitCode: WaitExitCode.PROMPT_DETECTED,
            output: {
              worktreeId,
              cliToolId: data.cliToolId || 'claude',
              type: UNCLASSIFIED_PROMPT_TYPE,
              question,
              options: [],
              status: 'pending',
            },
          };
        }
      } else {
        unclassifiedSince = null;
      }

      // Completion check [DR1-04]:
      // Path A: the tmux session went away after we had seen it alive — the agent
      //         finished and its session was stopped.
      // Path B: agent completed task (sessionStatus === 'ready', input prompt detected)
      // Both indicate "no more work in progress" from wait command's perspective.
      //
      // Issue #1628 narrowed Path A: a session that was NEVER seen running is
      // "nothing to wait for" (NOT_STARTED), not a completion. See `everRunning`.
      if (!data.isRunning && !everRunning) {
        console.error(
          `Not started: ${worktreeId} has no running ${data.cliToolId ?? 'agent'} session` +
            `${options.instance ? ` for instance ${options.instance}` : ''}` +
            // Issue #1884: name the stage that chose the agent above. `wait` has
            // no --agent to correct a mis-resolution with, so "no running claude
            // session for instance opencode" was the entire evidence an operator
            // got for a live agent reported as absent. `worktree-default` here
            // means the instance is neither in the roster nor named after a
            // tool; `client-fallback`, that the server is too old to resolve.
            `${data.resolvedBy ? ` (resolvedBy=${data.resolvedBy})` : ''}.`,
        );
        return { exitCode: VerifyExitCode.NOT_STARTED };
      }

      // Issue #1708 narrowed Path B: `ready` is only a completion when the frame
      // was actually understood. A structured `hook_stop` over an unreadable
      // pane is the degraded form of an overlay nobody could parse (see the note
      // above), and reporting it as `Completed` is how a stalled worker gets
      // merged. Path A is untouched — a session that went away really is
      // finished, and carries no flag anyway.
      if (!data.isRunning) {
        console.error(`Completed: ${worktreeId} (basis=${COMPLETION_BASIS.SESSION_GONE})`);
        return { exitCode: WaitExitCode.SUCCESS };
      }

      if (data.sessionStatus === 'ready' && data.isUnclassifiedActive !== true) {
        // Issue #1839: the agent is back at its composer with an upstream
        // failure on the frame. Checked BEFORE the turn-boundary gate below,
        // because it is the answer to the question that gate can only ask: the
        // turn did not end, and this is why. Without it the same session runs
        // to --timeout and reports 124, which says nothing about the cause.
        const fault = data.upstreamFault ?? null;
        if (options.failOnUpstreamFault && fault) {
          console.error(
            `Upstream fault on ${worktreeId}: id=${fault.id} — the agent is back at its ` +
              'composer with an upstream API failure on screen, so this turn did not run. ' +
              `Matched: ${JSON.stringify(fault.matchedText)}`,
          );
          return { exitCode: WaitExitCode.UPSTREAM_FAULT };
        }

        // Issue #1839: `ready` off the terminal frame is the agent's composer,
        // not the agent's verdict. Measured 2026-08-20 against a stub upstream
        // answering 529: Claude returns to the composer ~3 s after the send
        // having executed nothing, and never sends `Stop`. When this instance's
        // hooks ARE reporting — the only case in which `turnStartedAt` is
        // non-null — that missing `Stop` is the difference between "finished"
        // and "never ran", and it is the only signal that carries it.
        if (!turnSettled(data, turnStartedAt)) {
          console.error(
            `Waiting: ${worktreeId} is back at its composer, but its agent has not reported ` +
              `the end of this turn (turnStartedAt=${turnStartedAt}, ` +
              `lastStopEventAt=${data.lastStopEventAt ?? 'none'}, ${describeTurnClose(data)}). ` +
              'Not reporting completion; inspect with ' +
              `\`commandmate capture ${worktreeId} --json\`.`,
          );
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Issue #1975: the same frame, one question further back. #1839's gate
        // above can only fire once a turn has been ADOPTED, and `send` leaves a
        // window ~1s wide in which nothing has been: the newest structured event
        // is still the previous turn's `stop`, so `adoptTurnStart` takes nothing,
        // `turnSettled` reads null as "settled", and the composer the agent has
        // not touched yet is read as the composer it came back to. Measured
        // 2026-08-22 against copilot 1.0.80 on an isolated server: 3 of 5
        // send-then-wait runs came back in ~0.3s with `basis=scraper_ready` and
        // no artefact on disk.
        //
        // So ask the ledger instead of the clock: has this instance been handed
        // a prompt that the agent has not reported the end of? See
        // {@link outstandingPrompt} for why that comparison is the one that
        // separates "not started" from "finished", and
        // {@link reportsTurnBoundaries} for why a tool that posts no hooks never
        // reaches it.
        let answeredNewestPrompt = false;
        if (turnStartedAt === null && promptLedgerReadable && reportsTurnBoundaries(data)) {
          const ledger = await readNewestPromptAt(client, worktreeId, options, data);
          // One notice, then stop asking: a ledger that failed once will fail
          // every poll, and the point of degrading is to stop paying for it.
          promptLedgerReadable = ledger.readable;
          if (ledger.readable && ledger.submittedAt !== null) {
            if (outstandingPrompt(data, ledger.submittedAt)) {
              const heldMs = Date.now() - startTime;
              if (heldMs < PENDING_PROMPT_HOLD_MS) {
                console.error(
                  `Waiting: ${worktreeId} is at its composer, but the newest prompt sent to it ` +
                    `has no reported end (sentAt=${new Date(ledger.submittedAt).toISOString()}, ` +
                    `lastStopEventAt=${data.lastStopEventAt ?? 'none'}, ${describeTurnClose(data)}). ` +
                    'Not reporting completion: the agent has not started this turn yet.',
                );
                await sleep(POLL_INTERVAL_MS);
                continue;
              }
              console.error(
                `Note: ${worktreeId} has been at its composer for ` +
                  `${Math.round(heldMs / 1000)}s with the newest prompt still unreported by its ` +
                  'agent. Its hooks are not answering; completing on the frame alone.',
              );
            } else {
              answeredNewestPrompt = true;
            }
          }
        }

        // `hook_stop` on both branches that have one, and they are the same
        // statement made from two records: the agent reported the end of the
        // turn this wait is about. `scraper_ready` keeps its documented meaning
        // — "the screen said so and nothing corroborated it" — which is now
        // exactly the set of cases that reach it.
        const basis =
          turnStartedAt !== null || answeredNewestPrompt
            ? COMPLETION_BASIS.HOOK_STOP
            : COMPLETION_BASIS.SCRAPER_READY;
        console.error(`Completed: ${worktreeId} (basis=${basis})`);
        return { exitCode: WaitExitCode.SUCCESS };
      }

      // Progress indicator on stderr [DR1-05]
      console.error(`Waiting: ${worktreeId} (status=${data.sessionStatus}, running=${data.isRunning}, prompt=${data.isPromptWaiting})`);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      console.error(`Poll error for ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** True when the caller asked for a verdict rather than "the agent stopped". */
function verifyRequested(options: WaitOptions): boolean {
  return Boolean(options.verify || options.requireWork);
}

/**
 * Whether this poll outcome should still be handed to the verification gates.
 *
 * A completion is the obvious case. NOT_STARTED joins it (Issue #1628) so the
 * operator gets the gate results instead of a bare "no session": work committed
 * by an agent whose session has since gone away is still worth reporting. The
 * verdict is merged rather than substituted — mergeExitCode never lets a passing
 * run overwrite NOT_STARTED, so "wait never saw this agent" survives to the exit
 * code even when the gates are green.
 */
function shouldVerify(exitCode: number, options: WaitOptions): boolean {
  if (!verifyRequested(options)) return false;
  return exitCode === WaitExitCode.SUCCESS || exitCode === VerifyExitCode.NOT_STARTED;
}

/**
 * Task statuses that mean "this wait is about that task".
 *
 * Mirrors ACTIVE_TASK_STATUSES in src/lib/db/tasks-db.ts. Deliberately narrower
 * than the set the server will attach a run to: this is a guess made from a
 * worktree id alone, and a task that had already finished before the wait began
 * is a different delegation, not this one.
 */
const IN_FLIGHT_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'running',
  'waiting_input',
  'verifying',
]);

/**
 * Read the task this wait is about, before waiting for it (Issue #1620).
 *
 * Timing is the whole point. Agents are asked to run the gates themselves
 * before reporting completion, and doing so moves their task to a terminal
 * status — after which a verification run started with only a worktree id has
 * no contract to resolve, judges no scope, and still reports `passed`. Read
 * while the task is still in flight, the id survives that transition and the
 * run that follows is judged against the contract it was supposed to judge.
 *
 * Never throws: an unreadable ledger costs the attribution, and refusing to
 * verify over it would cost every gate.
 *
 * @returns the task id, or undefined to leave resolution to the server
 */
async function resolveWaitedTaskId(
  client: ApiClient,
  worktreeId: string,
): Promise<string | undefined> {
  try {
    const data = await client.get<TaskListResponse>(
      `/api/worktrees/${worktreeId}/tasks?limit=1`,
    );
    const task = data?.tasks?.[0];
    if (!task || !IN_FLIGHT_TASK_STATUSES.has(task.status)) return undefined;
    return task.id;
  } catch (error) {
    console.error(
      `Note: could not read the task ledger for ${worktreeId} ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        'verification will resolve its own task.',
    );
    return undefined;
  }
}

/**
 * Run verification for one worktree after its completion was detected.
 *
 * Swallows ApiError into an exit code: with several worktrees in flight, one
 * unreachable run must not abort the verdicts of the others.
 */
async function verifyAfterWait(
  client: ApiClient,
  worktreeId: string,
  options: WaitOptions,
  taskId: string | undefined,
): Promise<number> {
  // --verify runs every gate, and work-evidence is always part of "every gate",
  // so combining it with --require-work is a superset rather than a conflict.
  const gateIds = options.verify ? undefined : [WORK_EVIDENCE_GATE_ID];
  try {
    const outcome = await runVerification(client, {
      worktreeId,
      trigger: 'wait',
      instanceId: options.instance,
      taskId,
      gateIds,
      // stdout stays reserved for the prompt JSON contract.
      resultStream: 'stderr',
    });
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`Error: ${error.message}`);
      return error.exitCode;
    }
    console.error(
      `Error: verification of ${worktreeId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return ExitCode.UNEXPECTED_ERROR;
  }
}

/**
 * Fold one worktree's exit code into the aggregate.
 *
 * Ranked codes (see WAIT_EXIT_CODE_PRIORITY) beat unranked infrastructure
 * codes, and among equals the first one observed stands.
 */
function mergeExitCode(current: number, candidate: number): number {
  if (candidate === WaitExitCode.SUCCESS) return current;
  if (current === WaitExitCode.SUCCESS) return candidate;

  const rank = (code: number): number => {
    const index = WAIT_EXIT_CODE_PRIORITY.indexOf(code);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return rank(candidate) < rank(current) ? candidate : current;
}

export function createWaitCommand(): Command {
  const cmd = new Command('wait');
  cmd
    .description('Wait for agent completion (1 worktree per CLI instance recommended)')
    .argument('<worktree-ids...>', 'Worktree ID(s) to wait on')
    .option('--timeout <seconds>', 'Maximum wait time in seconds', parseInt)
    .option('--on-prompt <mode>', 'Prompt handling: agent (default) exits 10 with a prompt JSON payload on stdout (read it before re-capturing); human keeps waiting for a human reply')
    .option('--stall-timeout <seconds>', 'Maximum time without output change', parseInt)
    .option('--instance <id>', WAIT_INSTANCE_OPTION_DESCRIPTION)
    .option('--verify', 'After completion, run every verification gate; exit 20 when a gate fails, 21 when there is nothing to verify')
    .option('--require-work', 'After completion, run only the work-evidence gate; exit 21 when the worktree has no commits and no uncommitted changes')
    .option('--fail-on-upstream-fault', 'Exit 11 instead of 0 when the agent returns to its composer with an upstream API failure (529/limit/API Error) on the frame')
    .option('--token <token>', TOKEN_WARNING)
    // Issue #1926 (design 規約 3): the unclassified dwell is a stop reason with
    // no flag of its own, so `--help` is the only place a caller can find out
    // that it exists — and the only place the interaction with --stall-timeout
    // and --timeout can be stated. Leaving it to the guide means an operator
    // debugging an unexpected exit 10 has nowhere local to look.
    .addHelpText('after', `
Unclassified frames (exit 10, Issue #1708):
  A frame that is interactive but that the detection layer could not parse
  raises isUnclassifiedActive. It is not an immediate stop reason: a capture
  taken mid-repaint raises it for a single poll. Only after it has held for
  60 s does wait exit 10 with {"type":"unclassified"}, and --on-prompt human
  keeps waiting through it like any other prompt.

  Distinct from statusEvidence: 'none', which says the verdict rests on no
  positive proof — an idle composer no tool-specific rule vouched for is
  classified but unproven, and wait completes on it (Issue #2011).

  The 60 s dwell is a constant, not a flag. --timeout and --stall-timeout below
  60 s therefore always win and return 124 instead: the dwell pre-empts long
  waits, it never extends short ones. Inspect the raw pane with
  \`commandmate capture <id> --pane\`; see also statusEvidence /
  sessionStatusReason / lastKnownStatus in \`commandmate capture <id> --json\`.

A prompt the agent has not answered yet (Issue #1975):
  A composer frame right after a send looks exactly like a composer frame the
  agent came back to. When the tool's event source declares it reports both
  ends of a turn, wait therefore checks the chat ledger: if the newest prompt
  sent to this instance postdates the agent's last reported Stop, the turn has
  not been answered and wait keeps polling rather than reporting completion.

  Like the dwell above this is a constant, not a flag: the hold ends after 60 s
  with a note on stderr and a completion of basis=scraper_ready, so hooks that
  stop answering cannot make wait hang, and --timeout / --stall-timeout below
  60 s still win and return 124. A tool that posts no hooks (supportedEvents is
  empty) never enters this path at all. The completion line says which record
  decided it: basis=hook_stop when the agent reported the end of that turn.
`)
    .action(async (worktreeIds: string[], options: WaitOptions) => {
      try {
        // [SEC4-04] Validate all worktree IDs
        for (const id of worktreeIds) {
          if (!isValidWorktreeId(id)) {
            console.error(`Error: Invalid worktree ID format: ${id}`);
            process.exit(ExitCode.CONFIG_ERROR);
            return;
          }
        }

        // Issue #868: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });

        // Issue #1620: resolved before any polling starts. Once the agent stops
        // there is no reliable way left to tell which contract this wait was
        // about — the agent's own verification may have closed it by then.
        const boundTaskIds = verifyRequested(options)
          ? await Promise.all(worktreeIds.map(id => resolveWaitedTaskId(client, id)))
          : worktreeIds.map(() => undefined);

        if (worktreeIds.length === 1) {
          // Single worktree
          const result = await pollWorktree(client, worktreeIds[0], options);
          if (result.output) {
            // stdout for result (JSON output)
            console.log(JSON.stringify(result.output));
          }
          // Issue #1544: only a detected completion is worth verifying — a
          // prompt or a timeout means the agent never claimed to be done.
          const exitCode = shouldVerify(result.exitCode, options)
            ? mergeExitCode(
                result.exitCode,
                await verifyAfterWait(client, worktreeIds[0], options, boundTaskIds[0]),
              )
            : result.exitCode;
          process.exit(exitCode);
          return;
        }

        // [DR1-07] Multiple worktrees: Promise.allSettled for error isolation
        const results = await Promise.allSettled(
          worktreeIds.map(id => pollWorktree(client, id, options))
        );

        // Collect results
        const outputs: WaitPromptOutput[] = [];
        let finalExitCode: number = WaitExitCode.SUCCESS;
        const verifyTargets: Array<{ id: string; taskId: string | undefined }> = [];

        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            if (result.value.output) {
              outputs.push(result.value.output);
            }
            if (shouldVerify(result.value.exitCode, options)) {
              verifyTargets.push({ id: worktreeIds[index], taskId: boundTaskIds[index] });
              // Issue #1628: fold NOT_STARTED in before verification so a green
              // gate run cannot promote "no session was ever running" to success.
              finalExitCode = mergeExitCode(finalExitCode, result.value.exitCode);
              return;
            }
            finalExitCode = mergeExitCode(finalExitCode, result.value.exitCode);
          } else {
            const err = result.reason;
            finalExitCode = mergeExitCode(
              finalExitCode,
              err instanceof ApiError ? err.exitCode : ExitCode.UNEXPECTED_ERROR,
            );
          }
        });

        // Issue #1544: serial on purpose. The server caps concurrent runs
        // process-wide, so firing them together only queues them behind each
        // other while every gate competes for the same machine.
        for (const target of verifyTargets) {
          finalExitCode = mergeExitCode(
            finalExitCode,
            await verifyAfterWait(client, target.id, options, target.taskId),
          );
        }

        if (outputs.length > 0) {
          console.log(JSON.stringify(outputs));
        }
        process.exit(finalExitCode);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
