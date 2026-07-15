/**
 * usePendingMessages hook (Issue #1121)
 *
 * Optimistic-UI layer for chat message sending. It merges client-side "pending"
 * messages into the server-fetched message array so a just-sent message renders
 * instantly (< 100ms) as a bubble at the end of the history — before the send
 * API resolves and long before the next poll returns it.
 *
 * Lifecycle of a pending message:
 *   sendOptimistic() → status 'sending' (bubble shown immediately)
 *     → server echo appears in `serverMessages` → reconciled (pending removed,
 *       real message takes over; never double-shown)
 *     → send API rejects OR timeout elapses → status 'error' (retry / discard)
 *
 * Reconciliation matches a pending to a server message by (role === 'user' &&
 * identical content) that was NOT already present when the pending was created
 * (baseline snapshot). This is robust against re-sending identical text: an old
 * identical message can never satisfy the "not in baseline" condition. Matching
 * is one-to-one and ordered by send time so rapid consecutive sends (連投) of the
 * same text each consume a distinct server echo.
 *
 * The reconcile computation is also applied inside the merge memo so a confirmed
 * message is hidden on the very render its server echo arrives (no flicker /
 * duplicate), independent of the pruning effect that trims hook state afterward.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, OptimisticSendState } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** Default: mark an unconfirmed 'sending' message as errored after this long. */
export const DEFAULT_PENDING_TIMEOUT_MS = 30_000;

export interface OptimisticSendOptions {
  cliToolId: CLIToolType;
  instanceId?: string;
  imagePath?: string;
}

export type SendFn = (
  content: string,
  options: OptimisticSendOptions,
) => Promise<unknown>;

export interface PendingMessage {
  /** Client-generated temporary id (also used as the bubble's message id). */
  tempId: string;
  content: string;
  options: OptimisticSendOptions;
  timestamp: Date;
  status: OptimisticSendState;
  /** Server user-message ids present when this pending was created (reconcile baseline). */
  baselineUserIds: Set<string>;
}

export interface UsePendingMessagesOptions {
  worktreeId: string;
  /** Latest server-fetched messages for this pane (from useSplitMessages). */
  serverMessages: ChatMessage[];
  /** Performs the real send (e.g. worktreeApi.sendMessage bound to the worktree). */
  sendFn: SendFn;
  /** Invoked after a send resolves so the caller can refetch and reconcile promptly. */
  onSent?: () => void;
  /** Override the unconfirmed-send timeout (ms). Defaults to DEFAULT_PENDING_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface UsePendingMessagesResult {
  /** serverMessages with unreconciled pending messages merged in. */
  messages: ChatMessage[];
  pending: PendingMessage[];
  sendOptimistic: (content: string, options: OptimisticSendOptions) => void;
  retry: (tempId: string) => void;
  /** Removes the pending and returns its content (for draft restore). */
  discard: (tempId: string) => string | undefined;
}

/** Collect the ids of all user-role messages (reconcile baseline). */
function userMessageIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === 'user') ids.add(m.id);
  }
  return ids;
}

interface ReconcileResult {
  /** tempIds of pending messages confirmed by a server echo this pass. */
  reconciledTempIds: Set<string>;
  /** Server message ids that were newly claimed by a pending this pass. */
  consumedServerIds: Set<string>;
}

/**
 * Determine which pending messages have been confirmed by a server echo.
 * Ordered by send time with one-to-one server-message consumption so repeated
 * identical sends each reconcile against a distinct new server message.
 *
 * `alreadyConsumed` holds server ids claimed by pendings that were reconciled in
 * earlier passes and have since been pruned from state. Excluding them prevents
 * a later identical pending from re-claiming the same echo once its partner is
 * gone (which would otherwise drop a message that has not actually been sent).
 */
function computeReconciliation(
  pending: PendingMessage[],
  serverMessages: ChatMessage[],
  alreadyConsumed: Set<string>,
): ReconcileResult {
  const reconciledTempIds = new Set<string>();
  const consumedServerIds = new Set<string>();
  const sending = pending.filter((p) => p.status === 'sending');
  if (sending.length === 0) return { reconciledTempIds, consumedServerIds };

  const serverUser = serverMessages
    .filter((m) => m.role === 'user' && !alreadyConsumed.has(m.id))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const consumed = new Set<string>();

  const ordered = [...sending].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );
  for (const p of ordered) {
    const match = serverUser.find(
      (m) =>
        !consumed.has(m.id) &&
        !p.baselineUserIds.has(m.id) &&
        m.content === p.content,
    );
    if (match) {
      consumed.add(match.id);
      reconciledTempIds.add(p.tempId);
      consumedServerIds.add(match.id);
    }
  }
  return { reconciledTempIds, consumedServerIds };
}

function toChatMessage(p: PendingMessage, worktreeId: string): ChatMessage {
  return {
    id: p.tempId,
    worktreeId,
    role: 'user',
    content: p.content,
    timestamp: p.timestamp,
    messageType: 'normal',
    archived: false,
    cliToolId: p.options.cliToolId,
    instanceId: p.options.instanceId,
    optimisticState: p.status,
  };
}

export function usePendingMessages({
  worktreeId,
  serverMessages,
  sendFn,
  onSent,
  timeoutMs = DEFAULT_PENDING_TIMEOUT_MS,
}: UsePendingMessagesOptions): UsePendingMessagesResult {
  const [pending, setPending] = useState<PendingMessage[]>([]);

  // Latest values mirrored into refs so stable callbacks read current state
  // without re-subscribing on every render.
  const serverMessagesRef = useRef(serverMessages);
  serverMessagesRef.current = serverMessages;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const sendFnRef = useRef(sendFn);
  sendFnRef.current = sendFn;

  const seqRef = useRef(0);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Server ids already claimed by reconciled (and pruned) pendings. Persisted
  // across renders so a single echo can only ever confirm one pending. Bounded
  // to ids still present in serverMessages so it does not grow unbounded.
  const consumedServerIdsRef = useRef<Set<string>>(new Set());

  const clearTimer = useCallback((tempId: string) => {
    const timer = timersRef.current.get(tempId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(tempId);
    }
  }, []);

  const startTimer = useCallback(
    (tempId: string) => {
      clearTimer(tempId);
      const timer = setTimeout(() => {
        timersRef.current.delete(tempId);
        setPending((prev) =>
          prev.map((p) =>
            p.tempId === tempId && p.status === 'sending'
              ? { ...p, status: 'error' }
              : p,
          ),
        );
      }, timeoutMs);
      timersRef.current.set(tempId, timer);
    },
    [clearTimer, timeoutMs],
  );

  const dispatchSend = useCallback(
    async (p: PendingMessage) => {
      startTimer(p.tempId);
      try {
        await sendFnRef.current(p.content, p.options);
        onSentRef.current?.();
        // Stays 'sending' until the server echo reconciles it (or the timeout
        // fires as a fallback if the echo never arrives).
      } catch {
        clearTimer(p.tempId);
        setPending((prev) =>
          prev.map((cur) =>
            cur.tempId === p.tempId ? { ...cur, status: 'error' } : cur,
          ),
        );
      }
    },
    [startTimer, clearTimer],
  );

  const sendOptimistic = useCallback(
    (content: string, options: OptimisticSendOptions) => {
      const tempId = `pending-${seqRef.current++}`;
      const p: PendingMessage = {
        tempId,
        content,
        options,
        timestamp: new Date(),
        status: 'sending',
        baselineUserIds: userMessageIds(serverMessagesRef.current),
      };
      setPending((prev) => [...prev, p]);
      void dispatchSend(p);
    },
    [dispatchSend],
  );

  const retry = useCallback(
    (tempId: string) => {
      const target = pendingRef.current.find((p) => p.tempId === tempId);
      if (!target) return;
      const revived: PendingMessage = {
        ...target,
        status: 'sending',
        timestamp: new Date(),
        baselineUserIds: userMessageIds(serverMessagesRef.current),
      };
      setPending((prev) =>
        prev.map((p) => (p.tempId === tempId ? revived : p)),
      );
      void dispatchSend(revived);
    },
    [dispatchSend],
  );

  const discard = useCallback(
    (tempId: string): string | undefined => {
      const target = pendingRef.current.find((p) => p.tempId === tempId);
      clearTimer(tempId);
      setPending((prev) => prev.filter((p) => p.tempId !== tempId));
      return target?.content;
    },
    [clearTimer],
  );

  // Prune pending messages whose server echo has arrived, and stop their timers.
  // Side effects (timer clears, consumed-set update) are kept OUT of the
  // setPending updater so the updater stays pure (React may double-invoke it).
  useEffect(() => {
    const prev = pendingRef.current;
    const { reconciledTempIds, consumedServerIds } = computeReconciliation(
      prev,
      serverMessages,
      consumedServerIdsRef.current,
    );

    // Rebuild the consumed set: keep previously-consumed ids still in view plus
    // the ids claimed this pass. Bounds growth to the fetched window.
    const presentIds = new Set(serverMessages.map((m) => m.id));
    const nextConsumed = new Set<string>();
    consumedServerIdsRef.current.forEach((id) => {
      if (presentIds.has(id)) nextConsumed.add(id);
    });
    consumedServerIds.forEach((id) => nextConsumed.add(id));
    consumedServerIdsRef.current = nextConsumed;

    if (reconciledTempIds.size === 0) return;
    reconciledTempIds.forEach(clearTimer);
    setPending((cur) => cur.filter((p) => !reconciledTempIds.has(p.tempId)));
  }, [serverMessages, clearTimer]);

  // Clear all timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const messages = useMemo(() => {
    if (pending.length === 0) return serverMessages;
    const { reconciledTempIds } = computeReconciliation(
      pending,
      serverMessages,
      consumedServerIdsRef.current,
    );
    const extra = pending
      .filter((p) => !reconciledTempIds.has(p.tempId))
      .map((p) => toChatMessage(p, worktreeId));
    return extra.length === 0 ? serverMessages : [...serverMessages, ...extra];
  }, [serverMessages, pending, worktreeId]);

  return { messages, pending, sendOptimistic, retry, discard };
}
