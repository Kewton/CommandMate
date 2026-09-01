/**
 * Process-local registry naming the one module instance that owns live
 * WebSocket rooms (Issue #2220).
 *
 * ## The failure this exists to close
 *
 * `ws-server` keeps `wss`, `clients` and `rooms` in its module scope, and only
 * the instance the custom server called `setupWebSocket()` on ever holds a
 * socket. That was believed to be a `next dev` nicety; it is not. A production
 * build has two graphs, and the build artifacts say so:
 *
 * ```
 * dist/server/server.js          -> require("./src/lib/ws-server")   // owner
 * .next/server/app/api/**\/route.js -> .next/server/chunks/<n>.js      // a second copy
 * ```
 *
 * `setupWebSocket` appears in the `.next` chunk only as an exported binding —
 * grep it and the sole hit is the export map, never a call. So the route
 * bundle's `rooms` is empty for the life of the process, and every
 * `broadcast()` reached from a route handler returned in silence.
 *
 * ## What is shared and what is not
 *
 * Only the *capability* crosses the boundary: four functions the owner hands
 * over. `wss`, the socket set, `clients` and `rooms` stay inside the owner's
 * module scope, so a route bundle can ask for a frame to be published but can
 * neither enumerate nor mutate the connection state. Putting the maps
 * themselves on `globalThis` would work — same process, same `globalThis` — but
 * it exposes the central state to every bundle and leaves ownership undefined
 * once two instances have both initialised.
 *
 * This is the shape #1788 already uses for the waiting edge
 * (`waiting-episode-state`'s `globalThis` listener set, written by
 * `ws-server`'s `setupWebSocket`), and it is measurably cross-bundle in the same
 * build: `__sessionWaitingTransitionListeners` appears in both `dist/server` and
 * the `.next` chunks.
 *
 * ## Ownership
 *
 * Registration is a generation counter that only ever moves forward, and
 * withdrawal is authorised by the token handed out at registration. A stale
 * instance calling `closeWebSocket()` after a newer one has taken over
 * therefore cannot silence the live server — the classic HMR / re-entered
 * `setupWebSocket` hazard.
 *
 * ## Import discipline
 *
 * This module must stay a leaf: it imports the logger and nothing else. Both
 * `ws-server` and every producer reach it, so an edge back into either would
 * rebuild the module-scope cycle `tests/unit/guards/no-ws-server-manager-cycle-1984.test.ts`
 * exists to forbid.
 *
 * @module lib/realtime/publisher-registry
 */

import { createLogger } from '@/lib/logger';

const logger = createLogger('publisher-registry');

/** One worktree ID rename, as `migrateRooms` consumes it. */
export interface RoomRename {
  oldId: string;
  newId: string;
}

/** A rename that actually had subscribers to move. */
export interface RoomMigrationResult {
  oldId: string;
  newId: string;
  subscribers: number;
}

/**
 * The capability the socket owner publishes to the rest of the process.
 *
 * Deliberately four functions and no state. Anything a caller could use to
 * reach a socket directly is absent by construction.
 */
export interface RoomPublisher {
  /** Send `data` to every client subscribed to the worktree room. */
  publish(worktreeId: string, data: unknown): void;
  /**
   * Whether anyone is listening. Producers gate expensive work on this
   * (`terminal-broadcast` skips a tmux capture, `emitChatTurnProgress` skips a
   * transcript read), so it has to answer for the owner's rooms rather than for
   * the caller's empty ones.
   */
  hasSubscribers(worktreeId: string): boolean;
  /** Drop the rooms of worktrees that no longer exist. */
  cleanupRooms(worktreeIds: string[]): void;
  /** Move rooms and terminal subscriptions onto renamed worktree IDs. */
  migrateRooms(renames: ReadonlyArray<RoomRename>): RoomMigrationResult[];
}

/** What {@link registerRoomPublisher} hands back to the owner. */
export interface RoomPublisherHandle {
  /** The generation this registration claimed. */
  readonly token: number;
  /**
   * Withdraw, but only while this registration is still the current one.
   *
   * @returns Whether the withdrawal applied.
   */
  unregister(): boolean;
}

interface RoomPublisherRegistration {
  generation: number;
  publisher: RoomPublisher;
}

/** Counters behind {@link recordUnroutedPublish}. */
interface UnroutedPublishState {
  /** Calls that found no owner, over the process's life. */
  total: number;
  /** Warnings withheld since the last one that was emitted. */
  suppressed: number;
  /** Epoch ms of the last emitted warning, or null if none yet. */
  lastWarnedAt: number | null;
  /** Per-operation totals, so the log names which surface went quiet. */
  operations: Record<string, number>;
}

/**
 * `globalThis` and not module scope, for exactly the reason this file exists:
 * a module-scoped registry would give the owner and the route bundle one
 * registry each, which is the bug rather than the fix.
 *
 * The generation counter is kept separate from the registration so it survives
 * a withdrawal — reusing a token after `unregister()` would let a stale handle
 * unseat its successor.
 */
declare global {
  // eslint-disable-next-line no-var
  var __realtimeRoomPublisher: RoomPublisherRegistration | undefined;
  // eslint-disable-next-line no-var
  var __realtimeRoomPublisherGeneration: number | undefined;
  // eslint-disable-next-line no-var
  var __realtimeUnroutedPublish: UnroutedPublishState | undefined;
}

/** At most one warning per minute; the rest are counted, not printed. */
export const UNROUTED_PUBLISH_WARN_INTERVAL_MS = 60_000;

function unroutedState(): UnroutedPublishState {
  return (globalThis.__realtimeUnroutedPublish ??= {
    total: 0,
    suppressed: 0,
    lastWarnedAt: null,
    operations: {},
  });
}

/**
 * Claim ownership of the process's rooms.
 *
 * Called from `setupWebSocket()` and nowhere else. A second call supersedes the
 * first rather than being rejected: re-entering `setupWebSocket` builds a new
 * `WebSocketServer`, and the newest one is the one holding sockets.
 *
 * @param publisher - The owner's implementation, closed over its own maps.
 * @returns A handle whose `unregister()` is honoured only while it is current.
 */
export function registerRoomPublisher(publisher: RoomPublisher): RoomPublisherHandle {
  const token = (globalThis.__realtimeRoomPublisherGeneration ?? 0) + 1;
  globalThis.__realtimeRoomPublisherGeneration = token;
  globalThis.__realtimeRoomPublisher = { generation: token, publisher };

  // A live owner means the frames counted below are no longer being dropped;
  // carrying the old totals forward would keep warning about a fixed process.
  globalThis.__realtimeUnroutedPublish = undefined;

  return {
    token,
    unregister: () => unregisterRoomPublisher(token),
  };
}

/**
 * Withdraw the registration identified by `token`.
 *
 * A token that is not the current generation is ignored. That is the whole
 * point: under HMR — or in a suite that stands two servers up — the instance
 * being torn down is frequently *not* the one that owns the live sockets, and
 * its `closeWebSocket()` must not take the running server's publisher with it.
 *
 * @returns Whether this call actually cleared the registration.
 */
export function unregisterRoomPublisher(token: number): boolean {
  const current = globalThis.__realtimeRoomPublisher;
  if (!current || current.generation !== token) return false;
  globalThis.__realtimeRoomPublisher = undefined;
  return true;
}

/** The owner's publisher, or null when no instance has claimed the rooms. */
export function getRoomPublisher(): RoomPublisher | null {
  return globalThis.__realtimeRoomPublisher?.publisher ?? null;
}

/** Generation of the current registration; 0 when there is none. */
export function getRoomPublisherGeneration(): number {
  return globalThis.__realtimeRoomPublisher?.generation ?? 0;
}

/**
 * Note that a publish found no owner, warning at most once a minute.
 *
 * Without this the failure has no symptom at all. The room lookup returns
 * `undefined`, the function returns, and the browser still shows the socket as
 * `connected` — because it is: the socket is healthy and only the server-side
 * publisher is missing. That is the state #2220 sat in unnoticed. The counters
 * are readable through {@link getUnroutedPublishStats} so a test can assert the
 * signal exists rather than trusting a log line.
 *
 * @param operation - The surface that lost the frame, e.g. `'broadcast'`.
 * @param worktreeId - Room the frame was addressed to.
 */
export function recordUnroutedPublish(
  operation: string,
  worktreeId: string,
  now: number = Date.now(),
): void {
  const state = unroutedState();
  state.total += 1;
  state.operations[operation] = (state.operations[operation] ?? 0) + 1;

  if (state.lastWarnedAt !== null && now - state.lastWarnedAt < UNROUTED_PUBLISH_WARN_INTERVAL_MS) {
    state.suppressed += 1;
    return;
  }

  const suppressed = state.suppressed;
  state.suppressed = 0;
  state.lastWarnedAt = now;
  logger.warn('realtime:no-room-publisher', {
    operation,
    worktreeId,
    total: state.total,
    suppressedSinceLastWarning: suppressed,
    operations: { ...state.operations },
  });
}

/** Read-only view of the unrouted-publish counters. */
export function getUnroutedPublishStats(): Readonly<UnroutedPublishState> {
  const state = unroutedState();
  return { ...state, operations: { ...state.operations } };
}

/**
 * Drop the registration and the counters.
 *
 * Test seam. The generation counter is deliberately NOT reset — a suite that
 * reset it could hand two different registrations the same token and stop
 * exercising the ownership rule this module is built around.
 */
export function __resetRoomPublisherRegistryForTest(): void {
  globalThis.__realtimeRoomPublisher = undefined;
  globalThis.__realtimeUnroutedPublish = undefined;
}
