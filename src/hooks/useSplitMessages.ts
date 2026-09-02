/**
 * useSplitMessages hook (Issue #744)
 *
 * Per-(worktreeId, cliToolId) message-history for the PC split layout.
 * Each PC terminal split (#728) now embeds its own HistoryPane, and each pane
 * must show ONLY its own CLI's messages — simultaneously. The parent's
 * `state.messages` is server-filtered to the *active* CLI tab (fetchMessages
 * sends `?cliTool=<activeCliTab>`), so it cannot represent split A=Claude and
 * split B=Codex at once. This hook fetches each split's messages independently.
 *
 * Issue #2195: history is now **push-first**. The server already broadcasts
 * every history row it writes as `message` / `message_updated` (payload:
 * `ChatMessage`), so this hook subscribes to those and upserts them by id
 * instead of waiting out the poll. HTTP polling is kept — demoted to a
 * fallback that runs at {@link WS_CONNECTED_SPLIT_MESSAGES_POLL_INTERVAL_MS}
 * while a live socket is up, and at the original cadence when it is not.
 *
 * Issue #2219: an upsert cannot express a **removal**, and one producer removes
 * rows — `sendUserMessage` deletes the previous identical user row when a send
 * is retried (#379). `messages_invalidated` is that missing signal: it names a
 * scope, not a row, and this hook answers it by re-reading its history.
 *
 * Mirrors `useTerminalPanePolling` (Issue #728 / #1120):
 *  - request-id + in-flight CLI stale-guard (drop out-of-order / wrong-CLI responses)
 *  - polling pauses when document.visibilityState === 'hidden'
 *  - re-fetches once when the page becomes visible
 *  - re-fetches once whenever the WS connection flips (connect *and* disconnect),
 *    which is how rows broadcast while the socket was down get picked up
 *  - `refresh()` for an immediate manual re-fetch (e.g. after sending a message)
 *
 * The backing API + DB already support per-cliToolId message queries
 * (`/api/worktrees/[id]/messages?cliTool=<id>&limit=<n>&includeArchived=<bool>`,
 * `chat-db.getMessages`), so no backend change is needed.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ChatMessage } from '@/types/models';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import type {
  MessageBroadcastEvent,
  MessagesInvalidatedEvent,
  RealtimeEvent,
  SessionStatusEvent,
} from '@/lib/realtime/types';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';

/** Polling cadence for per-split message history (ms). */
export const SPLIT_MESSAGES_POLL_INTERVAL_MS = 5000;

/**
 * Issue #2195: while a live WebSocket connection is established every history
 * row arrives as a `message` / `message_updated` push, so the HTTP poll is
 * throttled to a slow fallback that only has to recover from a delivery gap.
 * Same value and same intent as `WS_CONNECTED_POLLING_INTERVAL_MS` in
 * `useTerminalPanePolling` (Issue #1120).
 *
 * Unlike the terminal pane there is no push *heartbeat* to gate this on: the
 * terminal streams a snapshot every poll while a session generates, so "no
 * frame for 5s" means push is broken, whereas history rows are written only
 * when a turn ends and a quiet hour is completely normal. Connectedness is
 * therefore the only signal available, and the fallback poll is what covers a
 * socket that is up but not delivering.
 */
export const WS_CONNECTED_SPLIT_MESSAGES_POLL_INTERVAL_MS = 15000;

/**
 * The `cli_tool_id` a row without one is read as. `chat-db.mapChatMessage`
 * applies exactly this default (`row.cli_tool_id ?? 'claude'`) when it reads a
 * row back, so a pushed payload whose producer left the field off has to be
 * normalized the same way before it is matched against this pane — otherwise a
 * claude pane would drop its own row.
 */
const DEFAULT_PUSHED_CLI_TOOL_ID: CLIToolType = 'claude';

export interface UseSplitMessagesOptions {
  worktreeId: string;
  cliToolId: CLIToolType;
  /**
   * Issue #869: agent instance id for this pane. Defaults to the primary
   * instance (`=== cliToolId`). Additional instances scope their history via
   * the `instance` query param.
   */
  instanceId?: string;
  /** Issue #701: history display limit. Defaults to the API's own default when omitted. */
  limit?: number;
  /** Issue #168: include archived (previous-session) messages. Defaults to false. */
  includeArchived?: boolean;
  /** When false the poller is suspended (e.g. parent hidden / error state). */
  enabled?: boolean;
}

export interface UseSplitMessagesReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  /** Manually refresh; useful after sending a message in this split. */
  refresh: () => Promise<void>;
}

/** Parse message timestamps (ISO strings → Date) from the API response. */
function parseMessageTimestamps(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
}

/**
 * Sort chronologically (ascending), which is the order the API hands back and
 * therefore the order every consumer of this hook already assumes.
 *
 * `Array.prototype.sort` is stable (ES2019), so rows that share a timestamp —
 * common, because `savePendingAssistantResponse` deliberately backdates the
 * assistant row to `userTimestamp - 1ms` and codex emits several rows inside
 * one turn — keep the order they were inserted in rather than shuffling on
 * every push.
 */
function sortByTimestamp(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Drop rows the server would not have returned, using the same pair-unit rule
 * the API applies (Issue #1407).
 *
 * `limit` is `historyDisplayLimit` and this hook fetches with `unit=pairs`, so
 * it counts **user turns**, not rows: `getMessages` resolves the timestamp of
 * the `limit`-th newest user row and returns everything at or after it. Trimming
 * pushed rows by raw row count instead would make the pane disagree with its own
 * next poll — it would drop assistant rows that belong to a turn the server
 * still considers in range.
 */
export function trimToPairLimit(messages: ChatMessage[], limit?: number): ChatMessage[] {
  if (limit === undefined || limit < 1) return messages;
  const userTimestamps = messages
    .filter((msg) => msg.role === 'user')
    .map((msg) => msg.timestamp.getTime())
    .sort((a, b) => b - a);
  if (userTimestamps.length <= limit) return messages;
  const cutoff = userTimestamps[limit - 1];
  return messages.filter((msg) => msg.timestamp.getTime() >= cutoff);
}

/**
 * Insert-or-replace one row by id, then re-sort and re-trim.
 *
 * `message` and `message_updated` share this path on purpose: the two differ
 * only in what the *producer* knew (`recordAnsweredPrompt` reports whether it
 * created a row or stamped an existing one), and a client that trusted that
 * distinction would duplicate a row whenever a `message` arrived for an id it
 * already had — exactly what happens when an optimistic row (#2194) is
 * confirmed, or when a push and a poll race.
 */
export function upsertMessage(
  previous: ChatMessage[],
  incoming: ChatMessage,
  limit?: number,
): ChatMessage[] {
  const index = previous.findIndex((msg) => msg.id === incoming.id);
  const next = [...previous];
  if (index >= 0) {
    next[index] = incoming;
  } else {
    next.push(incoming);
  }
  return trimToPairLimit(sortByTimestamp(next), limit);
}

export function useSplitMessages({
  worktreeId,
  cliToolId,
  instanceId,
  limit,
  includeArchived = false,
  enabled = true,
}: UseSplitMessagesOptions): UseSplitMessagesReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Issue #1171: realtime access so a targeted kill (matching scoped stop event)
  // refreshes THIS split's history immediately instead of waiting for the poll.
  // Issue #2195: `connected` also drives the poll cadence, and every history row
  // arrives over the same listener.
  const { connected, subscribe, unsubscribe, addListener } = useRealtime();

  // Resolve to the primary instance when omitted (instanceId === cliToolId).
  const resolvedInstanceId = instanceId ?? cliToolId;

  // Stale-response guard. Bump on every fetch; ignore older resolutions.
  const requestIdRef = useRef(0);
  // The cliToolId active when the in-flight request started. Drop responses
  // that landed under a different CLI (mirrors useTerminalPanePolling).
  const inFlightCliToolRef = useRef<CLIToolType>(cliToolId);
  inFlightCliToolRef.current = cliToolId;
  // Issue #869: also drop responses that landed under a different instance.
  const inFlightInstanceRef = useRef<string>(resolvedInstanceId);
  inFlightInstanceRef.current = resolvedInstanceId;
  // Issue #2195: read inside the push listener, which must not be re-registered
  // (and thus miss frames) every time the limit changes.
  const limitRef = useRef<number | undefined>(limit);
  limitRef.current = limit;
  const includeArchivedRef = useRef<boolean>(includeArchived);
  includeArchivedRef.current = includeArchived;

  /**
   * Issue #2195: rows pushed while an HTTP fetch was already in flight.
   *
   * A poll that left before the row was committed comes back without it, and
   * `setMessages(fetched)` would then erase a row the socket had already
   * delivered — invisible at the old 5s cadence, three times as long at 15s.
   * The bucket is replaced at the start of every fetch, so a row can only be
   * re-applied over the one response that could have raced it; anything older
   * (a row the server has since deleted, e.g. #379's orphan cleanup) is gone.
   */
  const inFlightPushesRef = useRef<Map<string, ChatMessage>>(new Map());

  const fetchMessages = useCallback(async (): Promise<void> => {
    const requestedCli = cliToolId;
    const requestedInstance = resolvedInstanceId;
    const requestId = ++requestIdRef.current;
    const pushBucket = new Map<string, ChatMessage>();
    inFlightPushesRef.current = pushBucket;
    try {
      // Issue #1407: History renders conversation-pair cards, so the limit must be
      // counted in pairs (turns), not raw rows — otherwise codex's many-assistant-rows
      // -per-turn collapses `limit` rows into far fewer cards.
      const params = new URLSearchParams({ cliTool: requestedCli, instance: requestedInstance, unit: 'pairs' });
      if (limit !== undefined) {
        params.set('limit', String(limit));
      }
      if (includeArchived) {
        params.set('includeArchived', 'true');
      }
      const response = await fetch(
        `/api/worktrees/${worktreeId}/messages?${params.toString()}`,
      );
      if (!response.ok) return;
      const data: ChatMessage[] = await response.json();
      // Drop if a newer request superseded us, or the CLI / instance changed.
      if (
        requestIdRef.current !== requestId ||
        inFlightCliToolRef.current !== requestedCli ||
        inFlightInstanceRef.current !== requestedInstance
      ) {
        return;
      }
      let next = parseMessageTimestamps(data);
      // Re-apply anything the socket delivered while this request was open.
      for (const pushed of pushBucket.values()) {
        next = upsertMessage(next, pushed, limit);
      }
      if (inFlightPushesRef.current === pushBucket) {
        inFlightPushesRef.current = new Map();
      }
      setMessages(next);
      setIsLoading(false);
    } catch (err) {
      if (
        requestIdRef.current !== requestId ||
        inFlightCliToolRef.current !== requestedCli ||
        inFlightInstanceRef.current !== requestedInstance
      ) {
        return;
      }
      // Network errors are swallowed; next interval will retry.
      console.error('[useSplitMessages] fetch error:', err);
      setIsLoading(false);
    }
  }, [worktreeId, cliToolId, resolvedInstanceId, limit, includeArchived]);

  // When (worktreeId, cliToolId, instanceId) changes, clear stale messages so
  // the new instance starts from an empty state and re-enters the loading phase.
  const compositeKey = `${worktreeId}::${cliToolId}::${resolvedInstanceId}`;
  const prevCompositeKeyRef = useRef(compositeKey);
  useEffect(() => {
    if (prevCompositeKeyRef.current === compositeKey) return;
    prevCompositeKeyRef.current = compositeKey;
    // Bump requestId so any in-flight prior-CLI promise is dropped.
    requestIdRef.current += 1;
    inFlightPushesRef.current = new Map();
    setMessages([]);
    setIsLoading(true);
  }, [compositeKey]);

  // Initial + interval polling. Pauses when hidden, resumes on visible.
  //
  // Issue #2195: the cadence depends on `connected`, and re-running this effect
  // on a connection flip is also what performs the recovery re-fetch — on the
  // way down (the socket may already have dropped a frame) and on the way back
  // up (rows written during the outage were broadcast to nobody). Same shape as
  // useTerminalPanePolling's interval effect (#1120).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const intervalMs = connected
      ? WS_CONNECTED_SPLIT_MESSAGES_POLL_INTERVAL_MS
      : SPLIT_MESSAGES_POLL_INTERVAL_MS;

    const intervalId = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void fetchMessages();
    }, intervalMs);

    // Kick once immediately if the page is visible.
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
      void fetchMessages();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        void fetchMessages();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, connected, fetchMessages]);

  // Issue #1171: join the worktree room so scoped stop events are delivered
  // (ref-counted, so sharing the room with useTerminalPanePolling is harmless).
  // Issue #2195: the same room carries this split's history rows.
  useEffect(() => {
    if (!enabled) return;
    subscribe(worktreeId);
    return () => unsubscribe(worktreeId);
  }, [enabled, worktreeId, subscribe, unsubscribe]);

  // Realtime listener.
  //
  // Issue #1171: when THIS split's session is terminated (matching scoped stop
  // event; messages were archived server-side), re-fetch so the current session
  // history clears immediately. Scoped events for other splits are ignored, so a
  // sibling's kill never refetches — and thus never disturbs — this split.
  //
  // Issue #2195: `message` / `message_updated` are applied in place, without a
  // round trip. The pane accepts a row only when (worktreeId, cliToolId,
  // instanceId) all match, so a second instance of the same tool — the whole
  // point of #869/#1000 — cannot bleed its turns into this pane.
  //
  // Issue #2219: `messages_invalidated` re-fetches instead, under the same
  // three-way scope match. It is the one frame that cannot carry its own
  // answer — a deleted row has nothing to upsert — so the settled state has to
  // come from the server. The re-fetch also bumps `requestIdRef`, which retires
  // any poll that left before the delete and would otherwise resolve with the
  // removed row still in its body.
  //
  // Nothing here is gated on `document.visibilityState`: applying a frame is a
  // state update, not work, and while the tab is hidden the socket is the only
  // thing still running (the poll above is paused, and `useWebSocket.ts:182`
  // will not even reconnect until the tab is visible again). The gap a hidden
  // tab does accumulate is closed by the `visibilitychange` re-fetch above,
  // which is the same discipline every other consumer follows.
  useEffect(() => {
    if (!enabled) return;
    return addListener((event: RealtimeEvent) => {
      if (event.type === 'message' || event.type === 'message_updated') {
        const evt = event as MessageBroadcastEvent;
        if (evt.worktreeId !== worktreeId) return;
        const incoming = evt.message;
        if (!incoming || typeof incoming.id !== 'string') return;
        // Producers that never had a second instance to name (e.g. the
        // claude-done hook route) leave `instanceId` off, and `createMessage`
        // returns the caller's object rather than the stored row — so resolve
        // both fields the way the DB reader would before matching.
        const eventCliToolId = incoming.cliToolId ?? DEFAULT_PUSHED_CLI_TOOL_ID;
        const eventInstanceId = incoming.instanceId ?? eventCliToolId;
        if (eventCliToolId !== inFlightCliToolRef.current) return;
        if (eventInstanceId !== inFlightInstanceRef.current) return;
        // The API drops empty-content rows before returning them; a pushed row
        // that the next poll would not include must not appear either.
        if (!incoming.content || incoming.content.trim() === '') return;
        // Archived rows belong to a previous session and are only shown when
        // the pane asked for them (Issue #168).
        if (incoming.archived && !includeArchivedRef.current) return;
        const normalized: ChatMessage = {
          ...incoming,
          timestamp: new Date(incoming.timestamp),
          cliToolId: eventCliToolId,
          instanceId: eventInstanceId,
        };
        inFlightPushesRef.current.set(normalized.id, normalized);
        setMessages((prev) => upsertMessage(prev, normalized, limitRef.current));
        return;
      }

      if (event.type === MESSAGES_INVALIDATED_EVENT_TYPE) {
        const evt = event as Partial<MessagesInvalidatedEvent>;
        if (evt.worktreeId !== worktreeId) return;
        // Normalized exactly as the row path above normalizes a pushed
        // `ChatMessage`, so a producer that resolved its scope and one that
        // left the primary instance implicit address the same pane.
        const eventCliToolId = evt.cliToolId ?? DEFAULT_PUSHED_CLI_TOOL_ID;
        const eventInstanceId = evt.instanceId ?? eventCliToolId;
        if (eventCliToolId !== inFlightCliToolRef.current) return;
        if (eventInstanceId !== inFlightInstanceRef.current) return;
        // Deliberately not gated on `document.visibilityState`: this fires only
        // when a re-send actually removed a row, and a hidden tab that skipped
        // it would keep the duplicate on screen until its own visibility
        // re-fetch — which is the delay this Issue exists to remove.
        void fetchMessages();
        return;
      }

      if (event.type !== 'session_status_changed') return;
      const evt = event as SessionStatusEvent;
      if (evt.worktreeId !== worktreeId) return;
      if (evt.isRunning !== false) return;
      if (evt.instance != null && evt.instance !== inFlightInstanceRef.current) return;
      if (evt.cliTool != null && evt.cliTool !== inFlightCliToolRef.current) return;
      void fetchMessages();
    });
  }, [enabled, worktreeId, addListener, fetchMessages]);

  const refresh = useCallback(() => fetchMessages(), [fetchMessages]);

  return { messages, isLoading, refresh };
}
