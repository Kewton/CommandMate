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
 *   instead, from `GET /permission` and `GET /question`, which is what makes a
 *   dropped approval recoverable rather than lost forever. A missed
 *   `session.idle` is not recoverable and is not pretended to be — `wait` falls
 *   back to the scraper, which is the pre-#1763 behaviour.
 * - **Not report a turn twice.** See `./turn-gate`.
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
import { isPlainObject, readStringField } from '../event-mapper';
import type {
  AgentInstanceRef,
  NormalizedAgentEvent,
  RawAgentEvent,
  SourceLiveness,
  Subscription,
} from '../types';
import {
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  readOpencodeEventStream,
  type OpencodeFrame,
} from './client';
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

/** One live subscription. */
interface OpencodeSubscriptionState {
  readonly key: string;
  readonly target: AgentInstanceRef;
  readonly port: number;
  readonly onEvent: (event: NormalizedAgentEvent) => void;
  readonly normalize: (raw: RawAgentEvent) => NormalizedAgentEvent | null;
  readonly gate: TurnGate;
  /** Ids already delivered, so a re-sync does not re-announce a live dialog. */
  readonly seenDecisions: Set<string>;
  /** Aborts the current attempt. Replaced on every reconnect. */
  streamController: AbortController;
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

/** A subscription handle for an instance that has no server to subscribe to. */
function inertSubscription(): Subscription {
  return { close: async () => {}, liveness: { state: 'unknown' } };
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
 * @param port - Overrides the recorded assignment. For tests
 */
export async function openOpencodeSubscription(
  target: AgentInstanceRef,
  onEvent: (event: NormalizedAgentEvent) => void,
  normalize: (raw: RawAgentEvent) => NormalizedAgentEvent | null,
  port?: number
): Promise<Subscription> {
  const key = keyOf(target);
  const existing = subscriptions.get(key);
  if (existing) return handleFor(existing);

  const resolvedPort = port ?? getAssignedOpencodePort(target);
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
    seenDecisions: new Set<string>(),
    streamController: new AbortController(),
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
  state.streamController.abort();
  subscriptions.delete(key);
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
    state.streamController.abort();
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

/** Sleep, unless the subscription is torn down first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
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
 */
async function runStream(state: OpencodeSubscriptionState): Promise<void> {
  let attempt = 0;

  while (!state.closed) {
    state.streamController = new AbortController();
    // A reconnect is a new arming window: whatever was mid-turn when the
    // connection dropped, its `session.status(busy)` was on the old stream, and
    // an idle that arrives without one must not resolve a `wait`.
    state.gate.reset();

    let reason = 'stream-ended';
    try {
      await resyncPending(state);
      armWatchdog(state);
      for await (const frame of readOpencodeEventStream(state.port, state.streamController.signal)) {
        attempt = 0;
        armWatchdog(state);
        handleFrame(state, frame);
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

    await delay(backoffFor(attempt), state.streamController.signal);
    attempt += 1;
  }
}

/**
 * Re-read what is waiting on a human and announce anything not seen yet (C7).
 *
 * The only recovery opencode offers. An approval raised while CommandMate was
 * disconnected is still pending on the server, so re-reading it restores both
 * the "a human is blocked" state and Auto-Yes's chance to adjudicate it — which
 * matters more here than anywhere else, because an unanswered opencode approval
 * waits forever (#1758 §5.5.3).
 */
async function resyncPending(state: OpencodeSubscriptionState): Promise<void> {
  const now = Date.now();
  const [permissions, questions] = await Promise.all([
    fetchOpencodePendingPermissions(state.port),
    fetchOpencodePendingQuestions(state.port),
  ]);

  const replay = (entries: Record<string, unknown>[], type: string): void => {
    for (const entry of entries) {
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
