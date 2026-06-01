/**
 * useSplitMessages hook (Issue #744)
 *
 * Per-(worktreeId, cliToolId) message-history polling for the PC split layout.
 * Each PC terminal split (#728) now embeds its own HistoryPane, and each pane
 * must show ONLY its own CLI's messages — simultaneously. The parent's
 * `state.messages` is server-filtered to the *active* CLI tab (fetchMessages
 * sends `?cliTool=<activeCliTab>`), so it cannot represent split A=Claude and
 * split B=Codex at once. This hook fetches each split's messages independently.
 *
 * Mirrors `useTerminalPanePolling` (Issue #728):
 *  - request-id + in-flight CLI stale-guard (drop out-of-order / wrong-CLI responses)
 *  - polling pauses when document.visibilityState === 'hidden'
 *  - re-fetches once when the page becomes visible
 *  - cadence aligned with the existing message poll interval
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

/** Polling cadence for per-split message history (ms). */
export const SPLIT_MESSAGES_POLL_INTERVAL_MS = 5000;

export interface UseSplitMessagesOptions {
  worktreeId: string;
  cliToolId: CLIToolType;
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

export function useSplitMessages({
  worktreeId,
  cliToolId,
  limit,
  includeArchived = false,
  enabled = true,
}: UseSplitMessagesOptions): UseSplitMessagesReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Stale-response guard. Bump on every fetch; ignore older resolutions.
  const requestIdRef = useRef(0);
  // The cliToolId active when the in-flight request started. Drop responses
  // that landed under a different CLI (mirrors useTerminalPanePolling).
  const inFlightCliToolRef = useRef<CLIToolType>(cliToolId);
  inFlightCliToolRef.current = cliToolId;

  const fetchMessages = useCallback(async (): Promise<void> => {
    const requestedCli = cliToolId;
    const requestId = ++requestIdRef.current;
    try {
      const params = new URLSearchParams({ cliTool: requestedCli });
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
      // Drop if a newer request superseded us or the CLI changed.
      if (
        requestIdRef.current !== requestId ||
        inFlightCliToolRef.current !== requestedCli
      ) {
        return;
      }
      setMessages(parseMessageTimestamps(data));
      setIsLoading(false);
    } catch (err) {
      if (
        requestIdRef.current !== requestId ||
        inFlightCliToolRef.current !== requestedCli
      ) {
        return;
      }
      // Network errors are swallowed; next interval will retry.
      console.error('[useSplitMessages] fetch error:', err);
      setIsLoading(false);
    }
  }, [worktreeId, cliToolId, limit, includeArchived]);

  // When (worktreeId, cliToolId) changes, clear stale messages so the new CLI
  // starts from an empty state and we re-enter the loading phase.
  const compositeKey = `${worktreeId}::${cliToolId}`;
  const prevCompositeKeyRef = useRef(compositeKey);
  useEffect(() => {
    if (prevCompositeKeyRef.current === compositeKey) return;
    prevCompositeKeyRef.current = compositeKey;
    // Bump requestId so any in-flight prior-CLI promise is dropped.
    requestIdRef.current += 1;
    setMessages([]);
    setIsLoading(true);
  }, [compositeKey]);

  // Initial + interval polling. Pauses when hidden, resumes on visible.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const intervalId = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void fetchMessages();
    }, SPLIT_MESSAGES_POLL_INTERVAL_MS);

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
  }, [enabled, fetchMessages]);

  const refresh = useCallback(() => fetchMessages(), [fetchMessages]);

  return { messages, isLoading, refresh };
}
