import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  usePendingMessages,
  isSendOutcomeUnknown,
  type OptimisticSendOptions,
  type UsePendingMessagesResult,
} from '@/hooks/usePendingMessages';
import { useToast } from '@/components/common/Toast';
import {
  useConnectivity,
  isServerConfirmedReachable,
  isConnectionKnownDown,
} from '@/hooks/useConnectivity';
import { isHandoffPageOperationRefused, sendMessageForHandoffPage } from '@/lib/handoff/page-owner';
import { useHandoffPageOwner } from '@/hooks/useHandoffPageOwner';
import type { ChatMessage } from '@/types/models';
import { useSendRefusalNotice } from '@/hooks/useSendRefusalNotice';

export interface UseOptimisticPaneMessagesArgs {
  worktreeId: string;
  /** The server-side transcript the pending bubbles are merged into. */
  serverMessages: ChatMessage[];
  /** Refetch after a send resolves, so reconciliation is prompt. */
  onSent: () => void | Promise<void>;
  /**
   * Issue #4345 1c 再指示 2: a new send the page's gate refused (not sent) — its text, for the
   * composer to keep (no bubble is left).
   */
  onNotSent?: (content: string) => void;
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
  onNotSent,
}: UseOptimisticPaneMessagesArgs): UsePendingMessagesResult {
  // Issue #4345 1c: the worktree page's registration holder (PC split, phone). Each send — a resend
  // included — is owned by the registration held when it leaves; its 401 reaches the gateway before
  // it becomes an ApiError. Outside a worktree page nothing changes in the call.
  const handoffOwner = useHandoffPageOwner();
  const sendMessageFn = useCallback(
    // 再指示 2 (K1): gated as it leaves (no press: the registration held then) — a retry and an
    // automatic resend included; refused, it rejects "not sent" (`isNotSent` below).
    (content: string, options: OptimisticSendOptions) => sendMessageForHandoffPage(handoffOwner, worktreeId, content, options),
    [worktreeId, handoffOwner],
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
  // Issue #4385: a send the server refused because of its role (409 `roleRefusal`, nothing typed)
  // says why right away (the app's toast) and on its failed row; a new send's text goes back to the
  // composer (the same insert as `onNotSent`). Shared with the `/sessions` tile.
  // Issue #4535: the send fence's 409 `SEND_TARGET_CHANGED` goes the same road (the same insert,
  // with a hold the composer reads while its To is not the original target).
  const { readRoleRefusal, onRoleRefused, readTargetChanged, onTargetChanged } = useSendRefusalNotice(onNotSent);
  const onAttachmentNotReturned = useAttachmentNotReturnedNotice();
  return usePendingMessages({
    worktreeId,
    serverMessages,
    sendFn: sendMessageFn,
    onSent,
    connectivity: pendingConnectivity,
    isNotSent: isHandoffPageOperationRefused,
    onNotSent,
    readRoleRefusal,
    onRoleRefused,
    readTargetChanged,
    onTargetChanged,
    // Issue #4503: an unknown outcome is not a failure (no direct retry, no automatic resend), and
    // a clock that runs out while the request is in flight waits for the answer.
    isOutcomeUnknown: isSendOutcomeUnknown,
    holdInFlightOnTimeout: true,
    onAttachmentNotReturned,
  });
}

/**
 * Issue #4417: a not-sent send's text goes back to the composer, but its attached image cannot
 * (the composer's attachment holds an uploaded file, not a path) — the screen says so, so the
 * person attaches it again before sending. Shared with the `/sessions` tile.
 */
export function useAttachmentNotReturnedNotice(): (imagePath: string) => void {
  const t = useTranslations('worktree');
  const { showToast } = useToast();
  return useCallback(() => {
    showToast(t('conversation.attachmentNotReturned'), 'warning');
  }, [showToast, t]);
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
