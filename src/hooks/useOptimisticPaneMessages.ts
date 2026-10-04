import { useCallback, useMemo } from 'react';
import {
  usePendingMessages,
  type OptimisticSendOptions,
  type UsePendingMessagesResult,
} from '@/hooks/usePendingMessages';
import {
  useConnectivity,
  isServerConfirmedReachable,
  isConnectionKnownDown,
} from '@/hooks/useConnectivity';
import { worktreeApi } from '@/lib/api-client';
import type { ChatMessage } from '@/types/models';

export interface UseOptimisticPaneMessagesArgs {
  worktreeId: string;
  /** The server-side transcript the pending bubbles are merged into. */
  serverMessages: ChatMessage[];
  /** Refetch after a send resolves, so reconciliation is prompt. */
  onSent: () => void | Promise<void>;
}

/**
 * Shared by `TerminalSplitPaneContent` (PC) and `MobileTerminalTab` (phone).
 *
 * Issue #1121: optimistic-UI layer. Merges a just-sent message into this
 * split's history as a pending bubble (< 100ms) before the send resolves, then
 * reconciles it against the server echo (no duplicate) or surfaces a
 * retry/discard error on failure. onSent refetches so reconciliation is prompt.
 *
 * Issue #2213: the same optimistic layer PC has had since #1121, wired the same
 * way (`TerminalSplitPaneContent`) — the send is `worktreeApi.sendMessage` and
 * `onSent` refetches so the bubble reconciles promptly rather than waiting for
 * the next poll. The push from #2195 usually beats that refetch; both land on
 * the same row id, and `usePendingMessages` consumes one echo per bubble.
 */
export function useOptimisticPaneMessages({
  worktreeId,
  serverMessages,
  onSent,
}: UseOptimisticPaneMessagesArgs): UsePendingMessagesResult {
  const sendMessageFn = useCallback(
    (content: string, options: OptimisticSendOptions) =>
      worktreeApi.sendMessage(worktreeId, content, options),
    [worktreeId],
  );
  // Issue #2503: the same connection verdict the header pill renders (#2501),
  // read here so a send made in a tunnel is held as "waiting" and resent once
  // the server answers again, instead of failing after 30s of no network.
  // Both halves read the *signals* rather than `status`, because both decide
  // to act: `isServerConfirmedReachable` rather than `isOnline`, so a desktop
  // carried by polling with the WebSocket down still counts as able to send;
  // `isConnectionKnownDown` rather than `isOffline`, so a send is only held back
  // from failing when something actually measured the network as gone.
  // (Phone, #2503: the same verdict MobileConnectionBanner shows (#2501) decides
  // whether a send that could not get out is "送信待ち" or a failure — and, on
  // the way back, triggers exactly one automatic resend of what is still
  // waiting. Read through the two evidence-only helpers rather than the
  // banner's verdict: holding a failure back needs proof the network is gone,
  // not merely a socket that is closed.)
  const connectivity = useConnectivity();
  const pendingConnectivity = useMemo(
    () => ({
      offline: isConnectionKnownDown(connectivity.signals),
      reachable: isServerConfirmedReachable(connectivity.signals),
    }),
    [connectivity.signals],
  );
  return usePendingMessages({
    worktreeId,
    serverMessages,
    sendFn: sendMessageFn,
    onSent,
    connectivity: pendingConnectivity,
  });
}

/**
 * Issue #1121: discarding a failed optimistic message removes its bubble and
 * restores the text to the composer (via the existing insert-to-message
 * pathway) so the user can edit and re-send.
 */
export function useDiscardPending(
  discardPending: (tempId: string) => string | undefined,
  insertToComposer: ((content: string) => void) | undefined,
): (tempId: string) => void {
  return useCallback(
    (tempId: string) => {
      const content = discardPending(tempId);
      if (content) {
        insertToComposer?.(content);
      }
    },
    [discardPending, insertToComposer],
  );
}
