/**
 * The long-lived SSE subscription to one OpenCode V2 instance's own server
 * (Issue #2934, decision D5).
 *
 * One instance = one `opencode2 serve` (started by `scripts/opencode-v2/launch.sh`
 * in the instance's pane) = one subscription. Because the server is the
 * instance's alone, routing is by construction: every frame this stream yields
 * belongs to the instance it was opened for, whether or not the frame carries
 * `location.directory` (several do not).
 *
 * The loop, per connection attempt:
 *  1. read the password file — gone means the session was killed, so the
 *     subscription ends rather than retrying forever;
 *  2. probe `GET /openapi.json` with it — `rejected` means the port now belongs
 *     to something that does not hold this password, which ends the
 *     subscription too (reading it would be reading someone else's events);
 *  3. open `GET /api/event` and deliver the frames Phase 1 maps, while every
 *     frame and every `: heartbeat` refreshes the liveness and re-arms a
 *     watchdog that forces a reconnect on a silent socket.
 * Any other failure waits out a backoff and tries again.
 *
 * Unlike v1's subscription this one keeps no turn gate. It does record the
 * reply (Issue #2940): a frame that ends a turn also has `./history` read the
 * finished turn off `GET /api/session/{id}/message`. And (Issue #2951) each
 * connection first replays what the server is still waiting on
 * ({@link resyncOpencodeV2Pending}), as v1's `resyncPending` does, so an
 * approval raised while the stream was down is recorded and adjudicated.
 *
 * @module lib/hooks/sources/opencode-v2/subscription
 */

import { createLogger } from '@/lib/logger';
import type {
  AgentInstanceRef,
  NormalizedAgentEvent,
  RawAgentEvent,
  SourceLiveness,
  Subscription,
} from '../types';
import { isPlainObject } from '../event-mapper';
import {
  fetchOpencodeV2PendingForms,
  fetchOpencodeV2PendingPermissions,
  openOpencodeV2EventStream,
  probeOpencodeV2Server,
  type OpencodeV2Frame,
} from './client';
import { isOpencodeV2TurnEndEventType, syncOpencodeV2History } from './history';
import { frameSessionId, frameType, isHandledOpencodeV2EventType } from './mappers';
import { opencodeV2KeyOf, readOpencodeV2Password } from './secrets';

const logger = createLogger('lib/hooks/sources/opencode-v2/subscription');

/**
 * A connection that has said nothing — not even a heartbeat — for this long is
 * re-opened. 2.0.18 sends `: heartbeat` every 15 s (measured 2026-09-28), so
 * this is four missed beats.
 */
export const OPENCODE_V2_HEARTBEAT_TIMEOUT_MS = 60_000;

/** Waits between reconnect attempts; the last value repeats. */
export const OPENCODE_V2_RECONNECT_BACKOFF_MS: readonly number[] = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
];

/** Consecutive `rejected` probes after which the port is taken to be someone else's. */
export const OPENCODE_V2_MAX_REJECTED_PROBES = 3;

/**
 * Cap on decisions replayed per list on one connection (Issue #2951). The same
 * bound, for the same reason, as v1's `MAX_RESYNCED_DECISIONS`: the list comes
 * off a server CommandMate does not police.
 */
export const OPENCODE_V2_MAX_RESYNCED_DECISIONS = 50;

interface SubscriptionState {
  readonly key: string;
  readonly target: AgentInstanceRef;
  readonly port: number;
  readonly onEvent: (event: NormalizedAgentEvent) => void;
  readonly normalize: (raw: RawAgentEvent) => NormalizedAgentEvent | null;
  streamController: AbortController;
  readonly lifetimeController: AbortController;
  liveness: SourceLiveness;
  closed: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __opencodeV2Subscriptions: Map<string, SubscriptionState> | undefined;
  // eslint-disable-next-line no-var
  var __opencodeV2EndedLiveness: Map<string, SourceLiveness> | undefined;
}

const subscriptions = (globalThis.__opencodeV2Subscriptions ??= new Map<
  string,
  SubscriptionState
>());

/** The last liveness of a subscription that ended on its own, for `liveness()`. */
const endedLiveness = (globalThis.__opencodeV2EndedLiveness ??= new Map<
  string,
  SourceLiveness
>());

/** Whether a subscription is open for the instance. */
export function isOpencodeV2Subscribed(target: AgentInstanceRef): boolean {
  return subscriptions.has(opencodeV2KeyOf(target));
}

/** The instance's subscription liveness. */
export function getOpencodeV2Liveness(target: AgentInstanceRef): SourceLiveness {
  const key = opencodeV2KeyOf(target);
  return subscriptions.get(key)?.liveness ?? endedLiveness.get(key) ?? { state: 'unknown' };
}

/**
 * Whether this instance's replies are being written from its server
 * (Issue #2940).
 *
 * The screen scraper's stand-down test, read through
 * `lib/polling/structured-history-gate`. `live` only, for the reason v1's
 * `isOpencodeStructuredHistoryLive` gives: a `lost` stream delivers no end of
 * turn, so it writes nothing, and standing the scraper down for it would leave
 * the reply recorded by nobody.
 */
export function isOpencodeV2StructuredHistoryLive(target: AgentInstanceRef): boolean {
  return getOpencodeV2Liveness(target).state === 'live';
}

/** The port an open subscription reads, or null. */
export function getOpencodeV2SubscribedPort(target: AgentInstanceRef): number | null {
  return subscriptions.get(opencodeV2KeyOf(target))?.port ?? null;
}

function handleFor(state: SubscriptionState): Subscription {
  return {
    close: async () => {
      await closeOpencodeV2Subscription(state.target);
    },
    get liveness(): SourceLiveness {
      return state.liveness;
    },
  };
}

/**
 * Open (or return the already-open) subscription for an instance.
 *
 * @param target - The instance
 * @param port - Its server's port
 * @param onEvent - Receives every mapped event
 * @param normalize - The source's normalizer
 */
export function openOpencodeV2Subscription(
  target: AgentInstanceRef,
  port: number,
  onEvent: (event: NormalizedAgentEvent) => void,
  normalize: (raw: RawAgentEvent) => NormalizedAgentEvent | null
): Subscription {
  const key = opencodeV2KeyOf(target);
  const existing = subscriptions.get(key);
  if (existing) return handleFor(existing);
  endedLiveness.delete(key);

  const state: SubscriptionState = {
    key,
    target,
    port,
    onEvent,
    normalize,
    streamController: new AbortController(),
    lifetimeController: new AbortController(),
    liveness: { state: 'unknown' },
    closed: false,
    watchdog: null,
  };
  subscriptions.set(key, state);
  logger.info('opencode-v2-subscription-opened', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    port,
  });
  void runStream(state);
  return handleFor(state);
}

/** Close the instance's subscription. Safe to call when none is open. */
export async function closeOpencodeV2Subscription(target: AgentInstanceRef): Promise<void> {
  const key = opencodeV2KeyOf(target);
  endedLiveness.delete(key);
  const state = subscriptions.get(key);
  if (!state) return;
  stop(state);
  subscriptions.delete(key);
  logger.info('opencode-v2-subscription-closed', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    port: state.port,
  });
}

/** Close every subscription. For tests. */
export function resetOpencodeV2Subscriptions(): void {
  for (const state of subscriptions.values()) stop(state);
  subscriptions.clear();
  endedLiveness.clear();
}

function stop(state: SubscriptionState): void {
  state.closed = true;
  clearWatchdog(state);
  state.streamController.abort();
  state.lifetimeController.abort();
}

/** End a subscription from inside its own loop, remembering why. */
function endSubscription(state: SubscriptionState, reason: string): void {
  stop(state);
  state.liveness = { state: 'lost', since: Date.now(), reason };
  if (subscriptions.get(state.key) === state) subscriptions.delete(state.key);
  endedLiveness.set(state.key, state.liveness);
  logger.warn('opencode-v2-subscription-ended', {
    worktreeId: state.target.worktreeId,
    instanceId: state.target.instanceId ?? state.target.cliToolId,
    port: state.port,
    reason,
  });
}

function clearWatchdog(state: SubscriptionState): void {
  if (state.watchdog !== null) {
    clearTimeout(state.watchdog);
    state.watchdog = null;
  }
}

function markAlive(state: SubscriptionState): void {
  state.liveness = { state: 'live', lastHeartbeatAt: Date.now() };
  clearWatchdog(state);
  const timer = setTimeout(() => {
    if (state.closed) return;
    logger.warn('opencode-v2-subscription-heartbeat-lost', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      port: state.port,
      afterMs: OPENCODE_V2_HEARTBEAT_TIMEOUT_MS,
    });
    state.streamController.abort();
  }, OPENCODE_V2_HEARTBEAT_TIMEOUT_MS);
  timer.unref?.();
  state.watchdog = timer;
}

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
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
  return OPENCODE_V2_RECONNECT_BACKOFF_MS[
    Math.min(attempt, OPENCODE_V2_RECONNECT_BACKOFF_MS.length - 1)
  ];
}

async function runStream(state: SubscriptionState): Promise<void> {
  let attempt = 0;
  let rejected = 0;
  while (!state.closed) {
    state.streamController = new AbortController();
    let reason = 'stream-ended';
    try {
      const password = readOpencodeV2Password(state.target);
      if (password === null) {
        endSubscription(state, 'password-file-missing');
        return;
      }
      const probe = await probeOpencodeV2Server(state.port, password);
      if (state.closed) return;
      if (probe.kind === 'rejected') {
        rejected += 1;
        reason = `server-rejected-${probe.status}`;
        if (rejected >= OPENCODE_V2_MAX_REJECTED_PROBES) {
          endSubscription(state, 'port-identity-changed');
          return;
        }
      } else if (probe.kind === 'unreachable') {
        reason = 'server-unreachable';
      } else {
        rejected = 0;
        const items = await openOpencodeV2EventStream(
          state.port,
          password,
          state.streamController.signal
        );
        markAlive(state);
        attempt = 0;
        // Issue #2951: before the first live frame, so an approval raised while
        // the stream was down reaches the same ingest (and Auto-Yes) as a live
        // one. A frame for the same id on the new stream is then a duplicate by
        // identity, not a second approval.
        await resyncOpencodeV2Pending(state.target, state.port, password, (frame) =>
          deliver(state, frame)
        );
        for await (const item of items) {
          if (state.closed) break;
          markAlive(state);
          if (item.kind === 'frame') deliver(state, item.frame);
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    } finally {
      clearWatchdog(state);
    }
    if (state.closed) return;
    state.liveness = { state: 'lost', since: Date.now(), reason };
    logger.info('opencode-v2-subscription-disconnected', {
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

/**
 * Replay what the server is still waiting on as the frames that announced it
 * (Issue #2951).
 *
 * `GET /api/permission/request` entries become `permission.asked` frames and
 * `GET /api/form` entries `form.created` frames (the form nested as
 * `data.form`, as 2.0.18 sends it), so one mapper and one parser cover both
 * arrival routes. Never throws; an unreachable server replays nothing.
 *
 * Exported for the tests.
 *
 * @returns How many frames were replayed
 */
export async function resyncOpencodeV2Pending(
  target: AgentInstanceRef,
  port: number,
  password: string,
  replay: (frame: OpencodeV2Frame) => void
): Promise<number> {
  let replayed = 0;
  try {
    const [permissions, forms] = await Promise.all([
      fetchOpencodeV2PendingPermissions(port, password),
      fetchOpencodeV2PendingForms(port, password),
    ]);
    const each = (
      entries: unknown[] | null,
      type: string,
      wrap: (entry: Record<string, unknown>) => Record<string, unknown>
    ): void => {
      const list = (entries ?? []).filter(isPlainObject);
      const kept = list.slice(0, OPENCODE_V2_MAX_RESYNCED_DECISIONS);
      if (list.length > kept.length) {
        logger.warn('opencode-v2-resync-truncated', {
          worktreeId: target.worktreeId,
          instanceId: target.instanceId ?? target.cliToolId,
          type,
          examined: kept.length,
          skipped: list.length - kept.length,
          limit: OPENCODE_V2_MAX_RESYNCED_DECISIONS,
        });
      }
      for (const entry of kept) {
        const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null;
        if (id === null) continue;
        replay({ id: `resync_${id}`, type, data: wrap(entry) });
        replayed += 1;
      }
    };
    each(permissions, 'permission.asked', (entry) => entry);
    each(forms, 'form.created', (entry) => ({ form: entry }));
  } catch (error) {
    logger.warn('opencode-v2-resync-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (replayed > 0) {
    logger.info('opencode-v2-resync', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      replayed,
    });
  }
  return replayed;
}

/**
 * Normalize one frame and hand it on, if Phase 1 reads its type.
 *
 * Exported for the mapping tests, which drive frames through exactly the path
 * the stream does.
 */
export function deliverOpencodeV2Frame(
  frame: OpencodeV2Frame,
  normalize: (raw: RawAgentEvent) => NormalizedAgentEvent | null,
  onEvent: (event: NormalizedAgentEvent) => void,
  receivedAt: number = Date.now()
): boolean {
  if (!isHandledOpencodeV2EventType(frameType(frame))) return false;
  const event = normalize({ payload: frame, receivedAt });
  if (!event) return false;
  onEvent(event);
  return true;
}

function deliver(state: SubscriptionState, frame: OpencodeV2Frame): void {
  try {
    deliverOpencodeV2Frame(frame, state.normalize, state.onEvent);
  } catch (error) {
    logger.warn('opencode-v2-frame-delivery-failed', {
      worktreeId: state.target.worktreeId,
      instanceId: state.target.instanceId ?? state.target.cliToolId,
      type: frameType(frame),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void recordOpencodeV2TurnEnd(state.target, state.port, frame);
}

/**
 * Have `./history` record the reply of a turn this frame ends (Issue #2940).
 *
 * Not awaited: the read loop delivers one frame at a time and a fetch plus a
 * database write must not hold the stream (or the `stop` just delivered).
 * `syncOpencodeV2History` catches its own failures; the guard here is for a
 * frame that cannot even be read.
 *
 * Exported for the tests, which drive frames through the path the stream does.
 *
 * @returns The sync, or null when the frame ends no turn
 */
export function recordOpencodeV2TurnEnd(
  target: AgentInstanceRef,
  port: number,
  frame: OpencodeV2Frame
): Promise<number> | null {
  try {
    if (!isOpencodeV2TurnEndEventType(frameType(frame))) return null;
    const sessionId = frameSessionId(frame);
    if (sessionId === null) return null;
    return syncOpencodeV2History(target, port, sessionId);
  } catch (error) {
    logger.warn('opencode-v2-history-trigger-failed', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
