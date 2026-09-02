/**
 * Realtime (WebSocket) message contracts shared by the server broadcasters and
 * the client consumers. Issue #1120.
 *
 * Server broadcasts are double-wrapped by `handleBroadcast` into an envelope:
 *   { type: 'broadcast', worktreeId, data: { type: '<realType>', ...payload } }
 * `parseRealtimeEvent` unwraps that envelope and returns the inner payload as
 * the canonical {@link RealtimeEvent}.
 */

import type { ChatMessage, LivePromptData } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Client → server hello carrying the client bundle version, sent on every
 * (re)connect so the server can detect a version drift (#1356). Kept as a shared
 * constant so the client sender and the server handler cannot drift apart.
 */
export const CLIENT_VERSION_MESSAGE_TYPE = 'client_version' as const;

/**
 * Server → client notice that the running server version differs from this
 * tab's bundle version (#1338/#1356). Drives the reload banner.
 */
export const VERSION_MISMATCH_EVENT_TYPE = 'version_mismatch' as const;

/**
 * Whether the running server version and this tab's bundle version have drifted
 * apart and the user should be nudged to reload (#1338/#1356).
 *
 * Conservative on purpose (受入条件: 版が一致している間は誤検知しない): an empty or
 * `'0.0.0'` fallback on either side means "version unknown" and is never treated
 * as a mismatch, so a server that cannot resolve its own version stays silent.
 */
export function isVersionMismatch(serverVersion: string, clientVersion: string): boolean {
  if (!serverVersion || !clientVersion) return false;
  if (serverVersion === '0.0.0' || clientVersion === '0.0.0') return false;
  return serverVersion !== clientVersion;
}

/**
 * Session running/stopped transition (sidebar status dots), and — since Issue
 * #1788 — the waiting edge.
 *
 * The two are carried by one frame rather than two event types because every
 * client that already listens for `session_status_changed` is exactly the set
 * that needs the waiting edge, and a second type would have to be threaded
 * through `parseRealtimeEvent`, the room subscription and every listener again.
 * They are still distinguishable: a running/stopped frame carries `isRunning`, a
 * waiting frame carries `isWaitingForResponse`.
 */
export interface SessionStatusEvent {
  type: 'session_status_changed';
  worktreeId: string;
  /**
   * Whether the session exists. Unchanged in meaning (Issue #1788 added fields
   * only) — but now **optional**, because the waiting-edge frame cannot answer
   * it honestly.
   *
   * `observeWaitingEdge` is called for every probe, including the ones where the
   * session is gone or the capture threw, so a `waiting: false` crossing means
   * "not waiting" and says nothing about whether the tmux session is still
   * alive. Publishing `isRunning: true` there would resurrect a killed session
   * in the sidebar until the next poll; publishing `false` would kill a live one.
   * Absent means "this frame carries no session-existence verdict", and the two
   * consumers that act on a stop already guard with `isRunning !== false`.
   */
  isRunning?: boolean;
  cliTool?: string | null;
  instance?: string | null;
  messagesCleared?: boolean;
  /**
   * The waiting edge (Issue #1788): true when this instance just started
   * waiting for the user, false when the wait just ended.
   *
   * Emitted from `onWaitingTransition` — the single edge observer #1786 built —
   * so it fires once per wait, not once per poll, and fires for a wait only the
   * agent's structured events could see just as it does for one the screen
   * scraper read. Absent on the running/stopped frames.
   */
  isWaitingForResponse?: boolean;
  /** `WaitingKind` for this wait (`prompt` / `menu` / `unclassified`), or null. */
  waitingKind?: string | null;
  /**
   * Epoch ms the wait began; stable for the whole episode.
   *
   * Carried so a client can tell one wait from the next: it is the dedup key for
   * the cross-screen toast, which must fire once per episode rather than once
   * per frame. Null when the wait just ended.
   */
  waitingSince?: number | null;
}

/** New / updated chat message. */
export interface MessageBroadcastEvent {
  type: 'message' | 'message_updated';
  worktreeId: string;
  message: ChatMessage;
}

/**
 * Terminal output snapshot pushed from the server-side response poller while a
 * session is generating. Mirrors the `/current-output` payload. `version` is a
 * monotonic counter per (worktreeId, cliToolId, instanceId) so the client can
 * drop out-of-order deliveries (stale-response parity with the polling guard).
 */
export interface TerminalSnapshotEvent {
  type: 'terminal_snapshot';
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
  output: string;
  isRunning: boolean;
  /**
   * The merged status verdict (`SessionStatus`: `'idle' | 'ready' | 'running' |
   * 'waiting'`), carried since Issue #2240 — the same value, from the same
   * `buildCurrentOutput` call, that `/current-output` publishes to the HTTP
   * poll. Typed `string` to match `CurrentOutputPayload.sessionStatus`.
   *
   * Required rather than optional on purpose. This frame already carried
   * `isRunning` — "a healthy tmux session exists" — and not the verdict that
   * says whether a turn is running, so the one field the chat surface gates on
   * (#2238) was the one field only the poll could deliver. Requiring it here is
   * the compile-time half of the fix: within a build, `emitTerminalSnapshot`
   * cannot forget it. The wire is not typechecked, so the client still treats
   * an absent value as "this frame says nothing" — see `applySnapshot`.
   */
  sessionStatus: string;
  thinking: boolean;
  isPromptWaiting: boolean;
  /**
   * Issue #1738: {@link LivePromptData}, because `emitTerminalSnapshot` assigns
   * `buildCurrentOutput`'s payload straight through and that has published the
   * degraded structured form since #1725. The old `PromptData` here typechecked
   * only because {@link RealtimeEvent}'s catch-all member absorbed the object
   * literal, so the mismatch never surfaced at the broadcast site.
   */
  promptData?: LivePromptData | null;
  isSelectionListActive: boolean;
  isPagerActive: boolean;
  isUnclassifiedActive: boolean;
  version: number;
}

/**
 * The body of the turn that is being generated **right now** (Issue #2199).
 *
 * The chat surface has no partial assistant text of its own: a reply reaches
 * `chat_messages` only once the turn is over, so a long turn leaves the surface
 * saying "Responding…" for minutes while the terminal surface next to it is
 * filling up. This frame is that missing text, and everything about its shape
 * follows from one decision — **it is never persisted**.
 *
 * Not persisted means the row this becomes is written by somebody else: the
 * existing `message` broadcast, from `sources/<tool>/history`, whose `requestId`
 * is exactly {@link ChatTurnProgressEvent.turnKey}. So a client replaces the
 * progress body with the confirmed row by matching that one string, and a
 * missed frame costs a moment of staleness rather than a lost reply. It is also
 * why there is no replay on reconnect and no `done: true` member: the settled
 * state of a turn is a `chat_messages` row, and this event has nothing to say
 * about it.
 *
 * `version` is monotonic per (worktreeId, cliToolId, instanceId) — the same
 * discipline {@link TerminalSnapshotEvent} carries, and for a sharper reason
 * here: opencode's SSE re-sends its boundary frames, so a client that trusted
 * arrival order would redraw an older body over a newer one.
 */
export const CHAT_TURN_PROGRESS_EVENT_TYPE = 'chat_turn_progress' as const;

/**
 * Smallest gap between two progress frames for one instance.
 *
 * The producers are a 2 s poller tick (claude) and an SSE part stream that
 * measured 88 delta frames for a single 967-character paragraph (opencode), so
 * the second one needs a brake and the first one does not. One brake for both,
 * because the expensive half of the claude path — a 4 MiB tail read and a parse
 * — happens *behind* this gate too, and a surface polled over HTTP at ~1 s
 * would otherwise pay for it on every request.
 */
export const CHAT_TURN_PROGRESS_MIN_INTERVAL_MS = 1000;

/**
 * Longest body one progress frame carries, in UTF-16 code units.
 *
 * Two orders of magnitude below `MAX_CLAUDE_TURN_BODY_LENGTH` /
 * `MAX_OPENCODE_TURN_BODY_LENGTH`, which bound the body that gets *saved*. This
 * one is re-sent every second while a turn runs, so its cost is per frame
 * rather than per turn.
 */
export const MAX_CHAT_TURN_PROGRESS_BODY_LENGTH = 64 * 1024;

/** What {@link truncateChatTurnProgressBody} answers. */
export interface ChatTurnProgressBody {
  readonly body: string;
  /** True when the head of the body was dropped to fit. */
  readonly truncated: boolean;
}

/**
 * Cut an over-long progress body, **keeping the tail**.
 *
 * The head is what goes, and that is the opposite of what the two turn writers
 * do. They are recording a reply and the reply reads from the top; this is
 * showing a reply being written, and the interesting end is the one the model
 * is still adding to. A reader who needs the head has the terminal surface and,
 * a moment later, the settled row.
 *
 * The cut is reported rather than hidden — see `partial` on
 * {@link ChatTurnProgressEvent}. Silently showing the middle of a reply as if it
 * were the whole of one is the failure this signature exists to prevent.
 */
export function truncateChatTurnProgressBody(
  body: string,
  maxLength: number = MAX_CHAT_TURN_PROGRESS_BODY_LENGTH,
): ChatTurnProgressBody {
  if (maxLength <= 0) return { body: '', truncated: body.length > 0 };
  if (body.length <= maxLength) return { body, truncated: false };
  return { body: body.slice(body.length - maxLength), truncated: true };
}

/** The in-flight body of one turn. See {@link CHAT_TURN_PROGRESS_EVENT_TYPE}. */
export interface ChatTurnProgressEvent {
  type: typeof CHAT_TURN_PROGRESS_EVENT_TYPE;
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Always resolved (`instanceId ?? cliToolId`), as `terminal_snapshot` is. */
  instanceId: string;
  /**
   * The `requestId` the settled row will carry — `claudeTurnRequestId(...)` or
   * `opencodeTurnRequestId(...)`. The join key between this frame and the
   * `message` that replaces it.
   */
  turnKey: string;
  /** Markdown, as the agent wrote it. Never a screen scrape. */
  body: string;
  /**
   * True when {@link body} does not start at the beginning of the turn.
   *
   * Two independent causes, one flag, because the reader's question is the same
   * for both: the claude transcript is read through a 4 MiB tail window and a
   * turn bigger than that has no head to read, and
   * {@link truncateChatTurnProgressBody} drops the head of anything over
   * {@link MAX_CHAT_TURN_PROGRESS_BODY_LENGTH}. The UI has to say so — a body
   * that starts mid-sentence and does not admit it is worse than no body.
   */
  partial: boolean;
  /** Monotonic per (worktreeId, cliToolId, instanceId). Older frames are dropped. */
  version: number;
  /**
   * Always false.
   *
   * Kept as a literal member rather than dropped because it is the wire's own
   * statement that this event never settles a turn — the settling frame is a
   * `message`, and a client that learns to treat a `done: true` here as one
   * would be writing the second history writer this Issue exists to avoid.
   */
  done: false;
}

/**
 * "This instance's history changed in a way no row-level frame can express —
 * re-read it" (Issue #2219).
 *
 * The one mutation that has no row to publish is a **delete**:
 * `sendUserMessage` removes the previous, identical user row after the retry is
 * persisted (#379's duplicate guard), and `message` / `message_updated` can only
 * ever say "this row now looks like this". A second device therefore kept the
 * deleted row until its own poll came round — 15s while a socket is up, since
 * #2195 demoted that poll to a fallback — showing the same sentence twice.
 *
 * It carries a **scope, not a payload**, and that is the whole design:
 *
 *  - the receiver re-fetches, so it lands on the DB's settled state rather than
 *    on a diff it has to merge — a `message` frame that was dropped on the way
 *    is repaired by the same round trip;
 *  - the re-fetch bumps `useSplitMessages`' request id, which retires any fetch
 *    that started *before* the delete and would otherwise resolve with the row
 *    still in it;
 *  - no tombstone has to be kept anywhere, and `archived` — which means "a
 *    previous session's history" — keeps meaning only that.
 *
 * The cost is one extra GET per orphan cleanup, on an event that fires only when
 * someone re-sends the exact text of their last unanswered message.
 *
 * {@link instanceId} is always resolved (`instanceId ?? cliToolId`), like
 * {@link TerminalSnapshotEvent}'s: a client matches it against its own pane and
 * an omitted field would simply never match.
 */
export const MESSAGES_INVALIDATED_EVENT_TYPE = 'messages_invalidated' as const;

/** Why a {@link MessagesInvalidatedEvent} was emitted. Diagnostics only — a
 * receiver re-fetches regardless, and must not branch on this. */
export type MessagesInvalidatedReason = 'orphan_cleanup';

/** See {@link MESSAGES_INVALIDATED_EVENT_TYPE}. */
export interface MessagesInvalidatedEvent {
  type: typeof MESSAGES_INVALIDATED_EVENT_TYPE;
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Always resolved (`instanceId ?? cliToolId`). */
  instanceId: string;
  reason: MessagesInvalidatedReason;
}

export interface RepositoryDeletedEvent {
  type: 'repository_deleted';
  worktreeId?: string;
  repositoryPath?: string;
  deletedWorktreeIds?: string[];
}

/**
 * Server-initiated notice that the running server version no longer matches the
 * version this tab's bundle was built from (#1338/#1356). Sent directly (not via
 * the room broadcast envelope) in response to the client's {@link
 * CLIENT_VERSION_MESSAGE_TYPE} hello. The reload banner listens for this.
 */
export interface VersionMismatchEvent {
  type: typeof VERSION_MISMATCH_EVENT_TYPE;
  serverVersion: string;
  clientVersion: string;
}

export type RealtimeEvent =
  | SessionStatusEvent
  | MessageBroadcastEvent
  | MessagesInvalidatedEvent
  | TerminalSnapshotEvent
  | ChatTurnProgressEvent
  | RepositoryDeletedEvent
  | VersionMismatchEvent
  | { type: string; worktreeId?: string; [key: string]: unknown };

/**
 * Parse a raw WebSocket frame into the inner realtime event.
 *
 * Handles both the room broadcast envelope ({ type:'broadcast', data:{...} })
 * and (defensively) already-unwrapped frames. Returns null on malformed input
 * or frames without a usable inner `type`.
 */
export function parseRealtimeEvent(raw: string): RealtimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const env = parsed as Record<string, unknown>;

  if (env.type === 'broadcast') {
    const inner = env.data;
    if (!inner || typeof inner !== 'object') return null;
    const innerObj = inner as Record<string, unknown>;
    if (typeof innerObj.type !== 'string') return null;
    // Ensure worktreeId is present even if the payload omitted it.
    if (innerObj.worktreeId === undefined && typeof env.worktreeId === 'string') {
      innerObj.worktreeId = env.worktreeId;
    }
    return innerObj as RealtimeEvent;
  }

  if (typeof env.type === 'string') {
    return env as RealtimeEvent;
  }
  return null;
}
