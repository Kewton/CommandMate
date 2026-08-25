/**
 * Holding the SSE connection to one opencode instance (Issue #1763, constraint
 * C1).
 *
 * Every other tool CommandMate supports pushes: the agent runs a hook, the hook
 * POSTs, and there is nothing to keep alive. opencode is subscribed to, so this
 * module owns the states a push transport does not have — connected, lost,
 * reconnecting — and the failure modes that come with them.
 *
 * ## What it has to get right
 *
 * - **Reconnect, and re-read what was missed.** Durable replay does not work on
 *   1.18.3: `GET /api/session/:id/event?after=<seq>` returns zero bytes (#1758
 *   §5.2.2). So a reconnect cannot ask "what did I miss"; it re-reads *state*
 *   instead, from `GET /permission`, `GET /question` and — since Issue #1900 —
 *   `GET /session/status`. The first two make a dropped approval recoverable
 *   rather than lost forever. The third makes a dropped *turn boundary*
 *   recoverable too: a session the server still calls busy is re-armed, and one
 *   it calls idle that was mid-turn when the stream died is the `stop` that
 *   never arrived. What is still not recoverable is a boundary the server has
 *   stopped reporting either way, and that is not pretended to be — `wait` falls
 *   back to the scraper, which is the pre-#1763 behaviour.
 * - **Not believe a port that changed hands.** The server is loopback and
 *   unauthenticated, so the identity check in {@link degradeToScraper}'s caller
 *   is what stands between "the pane owns this port" and a squatter closing a
 *   `wait` with one frame (§4 D3, DR4-004).
 * - **Not report a turn twice.** See `./turn-gate`.
 * - **Answer "did this session just go idle?" for somebody who is not the
 *   status layer.** An abort sent over the API is confirmed by the frame, not
 *   by its own reply (Issue #2034) — see {@link watchOpencodeSessionIdle},
 *   which observes the frame without taking any of the publishing decision
 *   away from the gate.
 * - **Not throw on an unknown frame.** `server.heartbeat` arrives every ten
 *   seconds and is not in the server's own OpenAPI `Event` union (#1758 D5), so
 *   a strict reader would fail six times a minute on a healthy connection. It is
 *   counted, not raised.
 * - **Know when the connection is dead.** The heartbeat is the signal: 60 of
 *   them over ten minutes, gaps of 10.00-10.03 s (§5.7.1). Silence past
 *   {@link OPENCODE_HEARTBEAT_TIMEOUT_MS} means the stream is gone even if the
 *   socket has not noticed.
 *
 * ## Held on `globalThis`
 *
 * Not decoration (Issue #1736). Under `next dev` every route handler is bundled
 * separately, so a module-scoped map of live subscriptions would be one map per
 * bundle: the launcher would open a stream the receiver cannot see, closing a
 * session would leave a stream running against a dead pane, and starting the
 * same instance twice would open two streams that both deliver every event.
 * None of that produces an error.
 *
 * @module lib/hooks/sources/opencode/subscription
 */

import { createLogger } from '@/lib/logger';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import {
  forgetAgentSessionTelemetry,
  readOpencodeSessionFrame,
  recordAgentSessionTelemetry,
} from '@/lib/hooks/agent-session-telemetry';
import { getRememberedOpencodeSession } from '@/lib/session/opencode-session-store';
import { isPlainObject, readStringField } from '../event-mapper';
import type {
  AgentInstanceRef,
  NormalizedAgentEvent,
  RawAgentEvent,
  SourceLiveness,
  SourceResync,
  Subscription,
} from '../types';
import {
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  fetchOpencodeSessionStatuses,
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from './client';
import {
  backfillOpencodeHistory,
  flushOpencodeTurn,
  forgetOpencodeTranscripts,
  recordOpencodeTranscriptFrame,
} from './history';
import { partCallId, partToolName } from './mappers';
import { rememberOpencodeToolCall } from './payloads';
import { getAssignedOpencodePort } from './ports';
import { createTurnGate, type TurnGate, type TurnObservation } from './turn-gate';

const logger = createLogger('lib/hooks/sources/opencode/subscription');

/**
 * How long a connection may be silent before it counts as dead.
 *
 * The heartbeat is a metronome at 10 s (#1758 §5.7.1), so three missed beats is
 * unambiguous while leaving room for a stalled event loop. Shorter would churn
 * connections on a busy server; longer would leave `liveness` claiming `live`
 * for a stream that stopped.
 */
export const OPENCODE_HEARTBEAT_TIMEOUT_MS = 30_000;

/** Reconnect backoff, in ms. The last value repeats. */
export const OPENCODE_RECONNECT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
];

/** Cap on remembered decision ids, so a long session cannot grow the set. */
const MAX_SEEN_DECISIONS = 256;

/**
 * Cap on approvals and questions replayed by one re-sync (§4 D3, DR4-009).
 *
 * The same number and the same reason as `MAX_RECHECKED_DECISIONS`: the list
 * comes off a server CommandMate did not start, and a bounded pass that reports
 * its overflow beats an unbounded one that does not.
 */
export const MAX_RESYNCED_DECISIONS = 50;

/** One live subscription. */
interface OpencodeSubscriptionState {
  readonly key: string;
  readonly target: AgentInstanceRef;
  readonly port: number;
  readonly onEvent: (event: NormalizedAgentEvent) => void;
  readonly normalize: (raw: RawAgentEvent) => NormalizedAgentEvent | null;
  readonly gate: TurnGate;
  /** The source's declared {@link SourceResync}; gates the status poll. */
  readonly resync: SourceResync;
  /** Ids already delivered, so a re-sync does not re-announce a live dialog. */
  readonly seenDecisions: Set<string>;
  /**
   * Who is waiting for a `session.idle`, by session id (Issue #2034).
   *
   * Fed from {@link deliver}, so a synthesised idle from a re-sync counts too.
   * See {@link watchOpencodeSessionIdle} for why this observes the *frame*
   * rather than the gate's verdict.
   */
  readonly idleWaiters: Map<string, Set<(seen: boolean) => void>>;
  /** Aborts the current attempt. Replaced on every reconnect. */
  streamController: AbortController;
  /**
   * Aborted by `close()` alone, and never replaced.
   *
   * The backoff waits on this rather than on `streamController` (Issue #1900):
   * by the time the loop reaches the sleep, `streamController` has *already*
   * been aborted — that abort is what ended the read — and
   * `addEventListener('abort')` on an already-aborted signal never fires. So a
   * `close()` during the backoff could not shorten it, and a torn-down
   * subscription held a timer for up to thirty seconds.
   */
  readonly lifetimeController: AbortController;
  /**
   * `/global/health`'s `version` from the first probe (Issue #1900, DR4-004).
   *
   * The identity a later probe is compared against. A different answer on the
   * same port is a different process, and the whole trust model here is "the
   * pane owns this port" — see {@link degradeToScraper}.
   */
  serverVersion: string | null;
  liveness: SourceLiveness;
  /** Set by `close()`; the loop checks it instead of being cancelled. */
  closed: boolean;
  /** Fires when the heartbeat stops. */
  watchdog: ReturnType<typeof setTimeout> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __opencodeSubscriptions: Map<string, OpencodeSubscriptionState> | undefined;
}

const subscriptions = (globalThis.__opencodeSubscriptions ??= new Map<
  string,
  OpencodeSubscriptionState
>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/** Whether a stream is currently held for this instance. */
export function isOpencodeSubscribed(target: AgentInstanceRef): boolean {
  return subscriptions.has(keyOf(target));
}

/**
 * How the connection to this instance is doing (C6).
 *
 * `unknown` for an instance with no subscription, which is the honest answer:
 * a session started before this feature, or launched with structured events off,
 * is indistinguishable from one whose stream has not been opened.
 */
export function getOpencodeLiveness(target: AgentInstanceRef): SourceLiveness {
  return subscriptions.get(keyOf(target))?.liveness ?? { state: 'unknown' };
}

/**
 * Whether this instance's conversation history is being written from the server
 * (Issue #2041).
 *
 * The screen scraper's stand-down test, and the one place the "port connected"
 * of the Issue text is turned into something checkable. `lib/polling/response-
 * checker` calls it before saving an opencode reply: true means `./history` has
 * the agent's own Markdown and the pane's rendering of it must not be saved on
 * top, false means nothing else is recording the turn and the scrape is the
 * only record there will be.
 *
 * Deliberately **not** {@link isOpencodeSubscribed}. A subscription whose stream
 * has dropped is `lost` — it delivers no `session.idle`, so it flushes no turn —
 * and standing the scraper down for one would leave the reply recorded by
 * nobody. `live` is the same word `cli-tools/opencode` requires before it will
 * post a prompt over REST (#2034 / #2035), and for the same reason: it is the
 * only state in which the port is known to still belong to this pane.
 *
 * The fallback direction is safe and the other is not, which is why the test is
 * this way round: two writers produce a duplicated reply, no writer produces a
 * turn that never happened.
 *
 * @param target - The instance
 */
export function isOpencodeStructuredHistoryLive(target: AgentInstanceRef): boolean {
  return getOpencodeLiveness(target).state === 'live';
}

/**
 * The session whose turn is this instance's turn, or null (Issue #2034).
 *
 * One server can carry several sessions and a sub-agent runs in one of its own,
 * so "abort this instance" has to name a session — and the gate has already
 * decided which one that is (see `./turn-gate`). Null when there is no
 * subscription, or when no session has been seen busy on this connection yet:
 * both mean CommandMate does not know whose turn to end, which the caller reads
 * as "use the keyboard instead".
 */
export function getOpencodePrimarySession(target: AgentInstanceRef): string | null {
  return subscriptions.get(keyOf(target))?.gate.primarySession() ?? null;
}

/** A registered interest in one session's next `session.idle`. */
export interface OpencodeIdleWatch {
  /** True if the frame arrived before the timeout, false otherwise. */
  readonly seen: Promise<boolean>;
  /** Stop waiting and resolve `seen` false. Idempotent. */
  cancel(): void;
}

/**
 * Watch for one session's next `session.idle` (Issue #2034).
 *
 * The confirmation half of an API abort: `POST /session/:id/abort` answers
 * `200 true` even for a session that was already idle (measured on 1.18.22, see
 * `./client`), so the reply says the request was taken and nothing about
 * whether a turn ended. The frame is the only thing that does.
 *
 * **Armed before the request, not after.** The same measurement had the first
 * idle emitted in the same millisecond the abort replied, so a caller that
 * awaits the POST and only then starts watching is racing its own completion.
 *
 * ## Why this reads the frame and not the gate's verdict
 *
 * `session.idle` arrives **twice** for an abort — 23 ms apart on 1.18.22, 19 ms
 * on 1.18.3 (#1758 §5.3.2) — and the gate is what stops the repeat from being
 * published as a second `stop`. This watch does not second-guess that: it
 * settles on the *first* frame and unregisters, so the duplicate lands on no
 * waiter, which is the same idempotence by a different route. Publication stays
 * the gate's decision alone.
 *
 * Reading the raw frame also keeps the watch working in the one case the gate
 * deliberately says nothing about: an idle for a session the gate never saw
 * arm — a stream that opened mid-turn — is `never-armed` and is not published,
 * but it is still the answer to "did the turn this abort targeted end?".
 *
 * @param target - The instance
 * @param sessionId - `ses_…`, from {@link getOpencodePrimarySession}
 * @param timeoutMs - How long to wait before answering false
 * @returns A handle whose `seen` resolves once, either way. `seen` is already
 *   `false` when there is no subscription to watch
 */
export function watchOpencodeSessionIdle(
  target: AgentInstanceRef,
  sessionId: string,
  timeoutMs: number
): OpencodeIdleWatch {
  const state = subscriptions.get(keyOf(target));
  if (!state) return { seen: Promise.resolve(false), cancel: () => {} };

  let resolveSeen: (seen: boolean) => void = () => {};
  const seen = new Promise<boolean>((resolve) => {
    resolveSeen = resolve;
  });

  const waiters = state.idleWaiters.get(sessionId) ?? new Set<(seen: boolean) => void>();
  state.idleWaiters.set(sessionId, waiters);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = (value: boolean): void => {
    // The delete is the guard: a waiter that is no longer registered has
    // already answered, and the second idle must not resolve anything twice.
    if (!waiters.delete(settle)) return;
    if (waiters.size === 0) state.idleWaiters.delete(sessionId);
    if (timer !== null) clearTimeout(timer);
    resolveSeen(value);
  };

  waiters.add(settle);
  timer = setTimeout(() => settle(false), timeoutMs);
  // The turn is over whether or not this timer fires; it must never be the
  // reason a CLI process stays up.
  timer.unref?.();

  return { seen, cancel: () => settle(false) };
}

/** Answer every outstanding watch false — the connection is going away. */
function releaseIdleWaiters(state: OpencodeSubscriptionState): void {
  for (const waiters of [...state.idleWaiters.values()]) {
    for (const settle of [...waiters]) settle(false);
  }
  state.idleWaiters.clear();
}

/** Tell whoever asked that this session reached idle (Issue #2034). */
function notifyIdleWaiters(state: OpencodeSubscriptionState, sessionId: string): void {
  const waiters = state.idleWaiters.get(sessionId);
  if (!waiters) return;
  // A copy: each `settle` unregisters itself from the live set.
  for (const settle of [...waiters]) settle(true);
}

/** A subscription handle for an instance that has no server to subscribe to. */
function inertSubscription(): Subscription {
  return { close: async () => {}, liveness: { state: 'unknown' } };
}

/** What the caller may tell {@link openOpencodeSubscription}. */
export interface OpencodeSubscriptionOptions {
  /** Overrides the recorded assignment. For tests. */
  readonly port?: number;
  /**
   * The source's `capabilities.resync` (Issue #1900, #1924 §4 D3).
   *
   * Passed in rather than read from the registry because the registry imports
   * `./source`, which imports this module — so a static import back would close
   * a cycle, and the declaration is the source's to make anyway. `'none'` is the
   * default and means the reconnect re-reads pending approvals and nothing else:
   * no `GET /session/status`, no re-arming, no synthesised `stop`.
   */
  readonly resync?: SourceResync;
}

/**
 * Open — or re-use — the event stream for one instance.
 *
 * Resolves as soon as the stream loop is running, not when the first frame
 * arrives: the caller is a `startSession` that must not be held up by a server
 * that is still booting, and the loop's own reconnect handles a port that is
 * not listening yet.
 *
 * Never throws. A source that cannot reach its agent degrades to the scraper,
 * and this call sits on the session-start path.
 *
 * @param target - The instance to watch
 * @param onEvent - Receives normalised events, gated by {@link TurnGate}
 * @param normalize - The source's own `normalizeEvent`, passed in rather than
 *   imported so this module does not depend on the module that depends on it
 * @param options - See {@link OpencodeSubscriptionOptions}
 */
export async function openOpencodeSubscription(
  target: AgentInstanceRef,
  onEvent: (event: NormalizedAgentEvent) => void,
  normalize: (raw: RawAgentEvent) => NormalizedAgentEvent | null,
  options: OpencodeSubscriptionOptions = {}
): Promise<Subscription> {
  const key = keyOf(target);
  const existing = subscriptions.get(key);
  if (existing) return handleFor(existing);

  const resolvedPort = options.port ?? getAssignedOpencodePort(target);
  if (resolvedPort === null) {
    // No port was assigned: structured events are off, allocation failed, or
    // this pane predates the feature. All three mean "the scraper is in charge",
    // which is exactly what an inert subscription expresses.
    logger.info('opencode-subscription-skipped-no-port', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
    });
    return inertSubscription();
  }

  const state: OpencodeSubscriptionState = {
    key,
    target,
    port: resolvedPort,
    onEvent,
    normalize,
    gate: createTurnGate(),
    resync: options.resync ?? 'none',
    seenDecisions: new Set<string>(),
    idleWaiters: new Map<string, Set<(seen: boolean) => void>>(),
    streamController: new AbortController(),
    lifetimeController: new AbortController(),
    serverVersion: null,
    liveness: { state: 'unknown' },
    closed: false,
    watchdog: null,
  };
  subscriptions.set(key, state);

  logger.info('opencode-subscription-opened', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    port: resolvedPort,
  });

  // Deliberately not awaited: the loop runs for the life of the session.
  void runStream(state);

  return handleFor(state);
}

/** The handle the caller holds. `liveness` reads through to the live state. */
function handleFor(state: OpencodeSubscriptionState): Subscription {
  return {
    close: async () => {
      await closeOpencodeSubscription(state.target);
    },
    get liveness(): SourceLiveness {
      return state.liveness;
    },
  };
}

/** Stop watching an instance. Idempotent. */
export async function closeOpencodeSubscription(target: AgentInstanceRef): Promise<void> {
  const key = keyOf(target);
  const state = subscriptions.get(key);
  if (!state) return;
  state.closed = true;
  clearWatchdog(state);
  releaseIdleWaiters(state);
  state.streamController.abort();
  // Issue #1900: the only signal a backoff is listening to.
  state.lifetimeController.abort();
  subscriptions.delete(key);
  // Issue #2040: the record describes the conversation a process was having,
  // and this is the call that means the process is gone. Left behind, it would
  // report the previous session's cost against the next pane started on the same
  // instance id — the same argument `buildCurrentOutput` makes for blanking
  // `model` on a session that is not running.
  forgetAgentSessionTelemetry(target);
  // Issue #2041, on the same terms: an accumulator holds a reply a process was
  // in the middle of writing, and a process that is gone will not finish it.
  // Whatever it had already produced is in `opencode.db` and comes back through
  // `recoverHistory` on the next attach.
  forgetOpencodeTranscripts(target);
  logger.info('opencode-subscription-closed', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    port: state.port,
  });
}

/** Close every subscription without waiting. Test seam. */
export function resetOpencodeSubscriptions(): void {
  for (const state of subscriptions.values()) {
    state.closed = true;
    clearWatchdog(state);
    releaseIdleWaiters(state);
    state.streamController.abort();
    state.lifetimeController.abort();
    forgetOpencodeTranscripts(state.target);
  }
  subscriptions.clear();
}

function clearWatchdog(state: OpencodeSubscriptionState): void {
  if (state.watchdog !== null) {
    clearTimeout(state.watchdog);
    state.watchdog = null;
  }
}

/**
 * Restart the silence timer.
 *
 * `unref` so a held connection never keeps a CLI process alive; the server has
 * its own reasons to stay up and does not need this timer to supply one.
 */
function armWatchdog(state: OpencodeSubscriptionState): void {
  clearWatchdog(state);
  const timer = setTimeout(() => {
    if (state.closed) return;
    logger.warn('opencode-subscription-heartbeat-lost', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      port: state.port,
      afterMs: OPENCODE_HEARTBEAT_TIMEOUT_MS,
    });
    // Force the read to end; the loop treats it as a dropped connection.
    state.streamController.abort();
  }, OPENCODE_HEARTBEAT_TIMEOUT_MS);
  timer.unref?.();
  state.watchdog = timer;
}

/**
 * Sleep, unless the subscription is torn down first.
 *
 * The already-aborted check and the listener removal are both load-bearing
 * (Issue #1900). Without the first, a signal that aborted before the call — the
 * ordinary case, because the abort is what ended the read — waits out the full
 * delay with nothing able to cut it short. Without the second, every reconnect
 * leaves a listener on a signal that lives as long as the session, and a pane
 * that reconnects a dozen times collects a `MaxListenersExceededWarning`.
 *
 * Exported as a test seam: both properties are invisible from outside the loop
 * — a backoff that is not cut short still ends, it just ends late — so the only
 * way to pin them without a wall-clock assertion is to drive this directly.
 */
export function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
  });
}

function backoffFor(attempt: number): number {
  const index = Math.min(attempt, OPENCODE_RECONNECT_BACKOFF_MS.length - 1);
  return OPENCODE_RECONNECT_BACKOFF_MS[index];
}

/**
 * The connection loop.
 *
 * Runs until `close()`. Every ending — a clean EOF, an aborted read, a refused
 * connection — is the same thing to this function: reconnect after a backoff,
 * having first re-read the state that could not be replayed.
 *
 * ## The order the reconnect does things in (Issue #1900)
 *
 * 1. **Ask who is on the port.** `/global/health` has to answer, and answer with
 *    the same `version` as the first time. §4 D3 (DR4-004) makes this a
 *    precondition of trusting the stream at all: the port is loopback and
 *    unauthenticated, so a different process squatting on it could otherwise
 *    close a `wait` with one `session.idle` frame — or with a single
 *    `{"ses_x":{"type":"idle"}}` reply to step 3.
 * 2. **Open the stream, then re-read.** The re-read used to run first, which
 *    left a window: an approval raised between `GET /permission` and the `/event`
 *    subscription appeared on neither, and stayed invisible until the *next*
 *    reconnect. Opening first makes the window an overlap instead — a duplicate
 *    the `seenDecisions` set collapses.
 * 3. **Find out whether the turn survived.** See {@link recoverTurnState}.
 */
async function runStream(state: OpencodeSubscriptionState): Promise<void> {
  let attempt = 0;

  while (!state.closed) {
    state.streamController = new AbortController();
    // A reconnect is a new arming window: whatever was mid-turn when the
    // connection dropped, its `session.status(busy)` was on the old stream, and
    // an idle that arrives without one must not resolve a `wait`. What *was*
    // armed is carried into `recoverTurnState`, which is the half of the answer
    // this reset used to throw away.
    const armedBefore = state.gate.armedSessions();
    state.gate.reset();

    let reason = 'stream-ended';
    try {
      const identity = await verifyServerIdentity(state);
      if (state.closed) break;
      if (identity === 'changed') return;
      if (identity === 'unreachable') {
        reason = 'health-unreachable';
      } else {
        const frames = await openOpencodeEventStream(state.port, state.streamController.signal);
        state.liveness = { state: 'live', lastHeartbeatAt: Date.now() };
        armWatchdog(state);
        await resyncPending(state);
        await recoverTurnState(state, armedBefore);
        // Issue #2041. After `recoverTurnState`, so a session the status poll
        // re-armed has already named itself to the gate and this can prefer it
        // over the remembered id. Awaited rather than fired-and-forgotten: it
        // must finish before the loop starts delivering frames, so a turn that
        // completes on the new connection cannot be written by the stream and
        // then written again by a backfill that had not read the row yet.
        await recoverHistory(state);
        attempt = 0;
        for await (const frame of frames) {
          attempt = 0;
          armWatchdog(state);
          handleFrame(state, frame);
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    } finally {
      clearWatchdog(state);
    }

    if (state.closed) break;

    state.liveness = { state: 'lost', since: Date.now(), reason };
    logger.warn('opencode-subscription-disconnected', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      port: state.port,
      reason,
      attempt,
    });

    await waitUnlessAborted(backoffFor(attempt), state.lifetimeController.signal);
    attempt += 1;
  }
}

/** What a pre-connect health probe concluded. */
type ServerIdentity = 'same' | 'changed' | 'unreachable';

/**
 * Health-before-trust (Issue #1900, §4 D3 DR4-004 / §13.2 S5).
 *
 * The first successful probe records the `version`; every later one is compared
 * against it. Equal — or unknowable, because the field is missing — means carry
 * on. Different means the process that owned this port is gone and somebody else
 * has it, at which point nothing on the port may be believed, including the
 * `/session/status` answer {@link recoverTurnState} would otherwise turn into a
 * `stop`.
 *
 * Anything that is merely *not answering* is a reconnect, not a betrayal: the
 * caller falls through to the ordinary backoff.
 */
async function verifyServerIdentity(state: OpencodeSubscriptionState): Promise<ServerIdentity> {
  const outcome = await probeOpencodeHealth(state.port);
  if (outcome.kind !== 'healthy') {
    logger.info('opencode-subscription-health-unavailable', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      port: state.port,
      outcome: outcome.kind,
      status: outcome.kind === 'rejected' ? outcome.status : undefined,
    });
    return 'unreachable';
  }

  const version = outcome.health.version;
  if (state.serverVersion === null || version === null) {
    state.serverVersion ??= version;
    return 'same';
  }
  if (version === state.serverVersion) return 'same';

  degradeToScraper(state, version);
  return 'changed';
}

/**
 * Stop watching a port that is no longer this instance's, and say so.
 *
 * Not a close in the ordinary sense — the pane may still be alive — so the
 * subscription is dropped rather than the session. Everything above falls back
 * to the screen scraper, which is the pre-#1763 behaviour and the only source
 * left that is reading the pane rather than the port.
 */
function degradeToScraper(state: OpencodeSubscriptionState, observedVersion: string): void {
  logger.warn('opencode-subscription-port-identity-changed', {
    worktreeId: state.target.worktreeId,
    instanceId: state.target.instanceId ?? state.target.cliToolId,
    port: state.port,
    reason: 'port_identity_changed',
    expectedVersion: state.serverVersion,
    observedVersion,
  });
  state.closed = true;
  clearWatchdog(state);
  state.streamController.abort();
  state.lifetimeController.abort();
  state.liveness = { state: 'lost', since: Date.now(), reason: 'port_identity_changed' };
  subscriptions.delete(state.key);
}

/**
 * Re-read what is waiting on a human and announce anything not seen yet (C7).
 *
 * The only recovery opencode offers for a *decision*. An approval raised while
 * CommandMate was disconnected is still pending on the server, so re-reading it
 * restores both the "a human is blocked" state and Auto-Yes's chance to
 * adjudicate it — which matters more here than anywhere else, because an
 * unanswered opencode approval waits forever (#1758 §5.5.3).
 *
 * Not the same contract as `recheckPendingDecisions` (#1898), which answers the
 * *policy changed* trigger of §4 D3 decision 3 and adjudicates directly. This
 * one replays the frames so the whole ingest path runs, and the two cannot
 * double-answer one approval: an id delivered here is in `seenDecisions`, and an
 * approval adjudicated there has already left through `answerPendingDecision`,
 * which is idempotent per decision id.
 */
async function resyncPending(state: OpencodeSubscriptionState): Promise<void> {
  const now = Date.now();
  const [permissions, questions] = await Promise.all([
    fetchOpencodePendingPermissions(state.port),
    fetchOpencodePendingQuestions(state.port),
  ]);

  const replay = (entries: Record<string, unknown>[], type: string): void => {
    // DR4-009: bounded, and the overflow is counted rather than dropped in
    // silence. Same limit and same reason as `MAX_RECHECKED_DECISIONS`.
    const kept = entries.slice(0, MAX_RESYNCED_DECISIONS);
    if (entries.length > kept.length) {
      logger.warn('opencode-resync-truncated', {
        worktreeId: state.target.worktreeId,
        instanceId: state.target.instanceId ?? state.target.cliToolId,
        type,
        examined: kept.length,
        skipped: entries.length - kept.length,
        limit: MAX_RESYNCED_DECISIONS,
      });
    }
    for (const entry of kept) {
      const id = readStringField(entry, 'id');
      if (!id || state.seenDecisions.has(id)) continue;
      // Rebuilt into the envelope the live path uses, so one mapper and one
      // parser cover both arrival routes.
      deliver(state, { id: `resync_${id}`, type, properties: entry }, now);
    }
  };

  replay(permissions, 'permission.asked');
  replay(questions, 'question.asked');
}

/**
 * Work out what happened to the turn while the connection was down (Issue
 * #1900 item 1, §4 D3 `closedBy: 'resync_idle'`).
 *
 * `?after=<seq>` returns zero bytes on this server, so a reconnect cannot ask
 * what it missed. What it *can* ask is what is true now, and `GET /session/status`
 * answers per session. Two things follow from one reply:
 *
 *  - **`busy` re-arms.** Without this the gate is empty, the `session.idle` that
 *    eventually arrives is dropped as `never-armed`, and the instance reads
 *    `running` off its last `post_tool_use` for the whole thirty-minute
 *    staleness bound. That is the reported failure: a watchdog trip mid-turn
 *    cost the `stop` entirely.
 *  - **`idle` for a session that *was* armed is the completion that was lost.**
 *    It is synthesised into the same `session.idle` frame the live path would
 *    have carried, so it goes through the gate, the mapper and the ingest
 *    unchanged. Only an explicit `idle` counts — a session missing from the
 *    reply says nothing, and guessing there would resolve a `wait` on absence.
 *
 * Re-arming runs first so the primary session is claimed by something that is
 * genuinely working before any synthesised idle can claim it.
 *
 * Gated on the declared {@link SourceResync}: a source that says `'none'` has no
 * endpoint to poll and this must be a no-op for it.
 *
 * @param armedBefore - Sessions the gate had mid-turn when the stream dropped
 */
async function recoverTurnState(
  state: OpencodeSubscriptionState,
  armedBefore: readonly string[]
): Promise<void> {
  if (state.resync !== 'session-status-poll') return;

  const statuses = await fetchOpencodeSessionStatuses(state.port);
  if (statuses === null) {
    // Unreachable between the health probe and here. Nothing is claimed, and
    // the scraper decides — which is the pre-#1900 outcome, not a new one.
    logger.info('opencode-resync-status-unavailable', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      port: state.port,
    });
    return;
  }

  const rearmed: string[] = [];
  for (const [sessionId, activity] of Object.entries(statuses)) {
    if (activity !== 'busy') continue;
    state.gate.arm(sessionId);
    rearmed.push(sessionId);
  }

  const synthesized: string[] = [];
  for (const sessionId of armedBefore) {
    if (statuses[sessionId] !== 'idle') continue;
    // Armed so the gate reads the synthesised frame as a completion rather than
    // as the `never-armed` idle its own reset just made it.
    state.gate.arm(sessionId);
    synthesized.push(sessionId);
    deliver(
      state,
      {
        id: `resync_idle_${sessionId}`,
        type: 'session.idle',
        properties: { sessionID: sessionId },
      },
      Date.now()
    );
  }

  if (rearmed.length > 0 || synthesized.length > 0) {
    logger.info('opencode-turn-state-recovered', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      port: state.port,
      rearmed,
      synthesized,
      primarySession: state.gate.primarySession(),
    });
  }
}

/**
 * Recover replies that were produced while nothing was listening (Issue #2041).
 *
 * The event stream cannot answer this. Measured on 1.18.22: a second
 * subscription opened to `/event` after three completed turns received one
 * `server.connected` frame and then nothing at all — there is no replay, with
 * or without `?after=<seq>` (#1758 §5.2.2). So every turn that finished while
 * CommandMate was down, or between the drop and the reconnect, exists only in
 * `opencode.db`, and `GET /session/:id/message` is the only way to it.
 *
 * ## Which session
 *
 * The gate first, because after {@link recoverTurnState} it holds a session the
 * server has just confirmed is this pane's. Then #2038's persisted memory,
 * which is the only source that survives a CommandMate restart — and a restart
 * is the case this whole function exists for.
 *
 * `GET /session/status` is deliberately not consulted as a third source. It was
 * measured answering `{}` for a server whose session had completed three turns:
 * the map lists what is *doing* something, so on the quiet server a restart
 * finds, it names nothing.
 *
 * Nothing here throws, and a failure costs history rather than the connection.
 */
async function recoverHistory(state: OpencodeSubscriptionState): Promise<void> {
  try {
    const remembered = getRememberedOpencodeSession(state.target)?.sessionId ?? null;
    const sessionId = state.gate.primarySession() ?? remembered;
    if (!sessionId) return;
    await backfillOpencodeHistory(state.target, state.port, sessionId);
  } catch (error) {
    logger.warn('opencode-history-recovery-failed', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      port: state.port,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Process one frame off the stream. */
function handleFrame(state: OpencodeSubscriptionState, frame: OpencodeFrame): void {
  const type = readStringField(frame, 'type');

  if (type === 'server.heartbeat' || type === 'server.connected') {
    state.liveness = { state: 'live', lastHeartbeatAt: Date.now() };
    // Still normalised below so the unknown-event tally counts it: the tally is
    // the diagnostic for "this tool sends words we have none for", and a
    // keepalive silently excluded from it would make the count look healthier
    // than the vocabulary is.
  }

  deliver(state, frame, Date.now());
}

/**
 * Normalise one frame and hand it on, if the gate allows.
 *
 * @param frame - `{ id, type, properties }`, live or rebuilt from a re-sync
 * @param receivedAt - Epoch ms
 */
function deliver(
  state: OpencodeSubscriptionState,
  frame: OpencodeFrame,
  receivedAt: number
): void {
  const type = readStringField(frame, 'type');

  // Recorded before the mapping, and for every status: `permission.asked` names
  // no tool, only a `callID`, and the frame that does name it is the `pending`
  // one — which maps to nothing at all. Reading it only from mapped events
  // would leave every approval anonymous (see ./payloads).
  if (type === 'message.part.updated') {
    const callId = partCallId(frame);
    const toolName = partToolName(frame);
    if (callId && toolName) rememberOpencodeToolCall(callId, toolName);
  }

  // Issue #2040, recorded on the same terms and for the same reason as the tool
  // name above: `session.updated` maps to none of the seven event words, so a
  // fact that only this frame carries would be lost between `normalize` and the
  // `return` two lines below it. What it carries is the whole `Session` — title,
  // agent, model, cost, tokens (measured against 1.18.22's own `GET /doc`) — and
  // it is the only place any of those reach this server without a request.
  //
  // Deliberately not gated on the turn gate's primary session: the frame's own
  // `parentID` is the sub-agent marker and `readOpencodeSessionFrame` reads it,
  // so this stays a frame-local rule with no ordering relationship to `observe`.
  if (type === 'session.updated') {
    const session = readOpencodeSessionFrame(frame, receivedAt);
    if (session) recordAgentSessionTelemetry(state.target, session);
  }

  // Issue #2041, in the same position and for the same reason as the two reads
  // above: the agent's reply travels on `message.part.updated`, which maps to
  // `pre_tool_use` / `post_tool_use` for its tool parts and to *nothing at all*
  // for its text ones — the seven words have no place to put prose. So the only
  // chance to keep the text is before `normalize` decides the frame is silent.
  //
  // `message.part.delta` is deliberately absent from this branch: the closing
  // `message.part.updated` carries the whole part text, which makes the reader
  // idempotent against a re-sent boundary frame instead of dependent on a dedup
  // set. See `./transcript` for the measurement.
  if (type === 'message.updated' || type === 'message.part.updated') {
    recordOpencodeTranscriptFrame(state.target, frame, receivedAt);
  }

  // Issue #2034: before the gate, and independent of what it decides. An abort
  // asked whether THIS session reached idle; whether the frame is also publishable
  // as a `stop` is a separate question with its own — correct — answer below.
  if (type === 'session.idle') {
    const idleSession = readStringField(
      isPlainObject(frame.properties) ? frame.properties : {},
      'sessionID'
    );
    if (idleSession) {
      notifyIdleWaiters(state, idleSession);
      // Issue #2041: the turn is over, so the reply is complete. Not awaited —
      // `deliver` is synchronous by contract (the SSE read loop calls it once
      // per frame) and a database write must not hold the stream. Nothing here
      // rejects; `flushOpencodeTurn` catches its own failures.
      void flushOpencodeTurn(state.target, idleSession);
    }
  }

  const observation = state.gate.observe(type, frame);
  if (observation.kind === 'failed') {
    logger.warn('opencode-session-error', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      sessionId: observation.sessionId,
      errorName: observation.errorName,
    });
  }

  let normalized: NormalizedAgentEvent | null = null;
  try {
    normalized = state.normalize({ payload: frame, receivedAt });
  } catch (error) {
    // The interface forbids this, and a source that broke the rule must still
    // not take the connection down with it.
    logger.error('opencode-normalize-threw', {
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!normalized) return;

  const suppressedBecause = gateVerdict(normalized.event, observation);
  if (suppressedBecause !== null) {
    logger.info('opencode-repeat-suppressed', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      sessionId: normalized.conversationId,
      event: normalized.event,
      reason: suppressedBecause,
    });
    return;
  }

  rememberDecisionId(state, frame);

  try {
    state.onEvent(normalized);
  } catch (error) {
    logger.error('opencode-event-handler-failed', {
      type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Whether the gate refuses to let this event through, and why.
 *
 * Both words opencode repeats are gated, and both would be wrong in the same
 * direction — the status layer reads only the newest event, so a repeat of
 * either overwrites the truth:
 *
 *  - a second `stop` resolves a `wait` for work that is not over;
 *  - a trailing `user_prompt_submit` — which opencode emits *after*
 *    `session.idle` — leaves a finished turn reading `running` for the next
 *    thirty minutes.
 *
 * Everything else passes: repeats of `pre_tool_use` and `post_tool_use` are
 * idempotent in the state machine they feed, and the receiver's own dedup
 * window collapses them anyway.
 *
 * @returns The suppression reason, or null when the event may be delivered
 */
function gateVerdict(event: AgentEventType, observation: TurnObservation): string | null {
  if (event === 'stop' && observation.kind !== 'completed') {
    return observation.kind === 'suppressed' ? observation.reason : 'not-a-turn-end';
  }
  if (event === 'user_prompt_submit' && observation.kind !== 'announced') {
    return observation.kind === 'suppressed' ? observation.reason : 'not-a-new-prompt';
  }
  return null;
}

/** Note an approval / question id so a later re-sync does not repeat it. */
function rememberDecisionId(state: OpencodeSubscriptionState, frame: OpencodeFrame): void {
  const type = readStringField(frame, 'type');
  if (type !== 'permission.asked' && type !== 'question.asked') return;
  const properties = isPlainObject(frame.properties) ? frame.properties : {};
  const id = readStringField(properties, 'id');
  if (!id) return;
  state.seenDecisions.add(id);
  while (state.seenDecisions.size > MAX_SEEN_DECISIONS) {
    const oldest = state.seenDecisions.values().next();
    if (oldest.done) break;
    state.seenDecisions.delete(oldest.value);
  }
}
