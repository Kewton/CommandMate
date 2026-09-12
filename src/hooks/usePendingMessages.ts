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
 *     → …unless the app is offline, in which case it is parked as `queued`
 *       and resent when the server answers again (see Connectivity below)
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
 *
 * ## Connectivity (Issue #2503)
 *
 * A send that fails because the phone is in a tunnel is not a failed message —
 * it is a message that has not been sent yet. Given a `connectivity` input the
 * hook adds a third resting place between 'sending' and 'error':
 *
 *   offline  → the pending is *parked* (`queued: true`, status stays 'sending',
 *              so it reads as "on its way" rather than "failed") and its
 *              timeout stops counting — 30s of no network is not evidence the
 *              send is lost.
 *   reachable → each parked pending is resent automatically, ONCE. A second
 *              failure lands on 'error', where the existing manual retry /
 *              discard take over. The budget is per message and is refilled by
 *              an explicit `retry()`, so recovery can never turn into a loop.
 *
 * `POST /send` is not idempotent, so the automatic resend is gated on positive
 * evidence that nothing arrived:
 *
 *   1. `onSent()` (the caller's refetch) is awaited *before* the resend, and the
 *      pending is dropped if the refreshed transcript contains its echo.
 *   2. A request still in flight is never resent — its outcome is unknown, so
 *      the clock is restarted instead and the user decides after it expires.
 *   3. A send that resolves un-parks its pending, so a request that was parked
 *      mid-flight and then succeeded is not a resend candidate at all.
 *
 * "Back online" is taken from #2501's `useConnectivity`, never from
 * `navigator.onLine === true` — see `isServerConfirmedReachable`.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, OptimisticSendState } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** Default: mark an unconfirmed 'sending' message as errored after this long. */
export const DEFAULT_PENDING_TIMEOUT_MS = 30_000;

/**
 * Issue #2503: how long the recovery pass waits, after the refetch it triggered
 * has resolved, before deciding what still needs sending.
 *
 * This is load-bearing rather than padding. `onSent()` resolving means the
 * caller has *called* setState, not that React has committed the new transcript
 * or run the pruning effect that retires the pendings it confirms — passive
 * effects are flushed on a later task. Deciding inside the promise therefore
 * reads a transcript that predates the answer it just asked for, and resends a
 * message the server already has. Waiting a beat costs nothing (the message has
 * been waiting for the network anyway) and moves the decision onto data that
 * has actually landed.
 */
export const DEFAULT_RESEND_GRACE_MS = 250;

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
  /**
   * Issue #2503: held for connectivity rather than failed — "waiting to send".
   * Always paired with `status: 'sending'` so the bubble reads as in-flight
   * instead of as an error, and no timeout runs while it is set.
   */
  queued: boolean;
  /**
   * Issue #2503: the send API resolved for this message — the server has it and
   * only its echo is outstanding. Kept apart from `queued` because the two
   * answer different questions: `queued` is "no clock is running", `accepted`
   * is "there is nothing left to send". A message can be both, which is exactly
   * the request that completed just as the connection dropped.
   */
  accepted: boolean;
  /**
   * Issue #2503: the one automatic resend for this message has been spent.
   * A later failure goes to 'error' (manual retry / discard) instead of being
   * parked again, which is what keeps recovery from becoming a resend loop.
   * `retry()` clears it — an explicit retry gets its own budget.
   */
  autoResendAttempted: boolean;
}

/**
 * Issue #2503: the connectivity facts this hook acts on, kept as two plain
 * booleans so the layer stays a pure function of its inputs and can be tested
 * without a network, a WebSocket or a `useConnectivity` mock. Call sites derive
 * them from `useConnectivity()` — see `TerminalSplitPaneContent` /
 * `MobileTerminalTab`.
 */
export interface PendingConnectivity {
  /**
   * The device is off the network, or the server has been measured unreachable.
   * A send that fails under this is parked instead of failed.
   */
  offline: boolean;
  /**
   * The server has *positively answered* — a live WebSocket or a completed HTTP
   * exchange (`isServerConfirmedReachable`). `navigator.onLine === true` alone
   * must never set this: #2501's whole point is that the flag can confirm
   * "offline" and never "online".
   */
  reachable: boolean;
}

export interface UsePendingMessagesOptions {
  worktreeId: string;
  /** Latest server-fetched messages for this pane (from useSplitMessages). */
  serverMessages: ChatMessage[];
  /** Performs the real send (e.g. worktreeApi.sendMessage bound to the worktree). */
  sendFn: SendFn;
  /**
   * Invoked after a send resolves so the caller can refetch and reconcile
   * promptly. Issue #2503 also awaits it before an automatic resend, which is
   * why the promise a refetch returns is part of the contract now — a caller
   * whose refetch is synchronous is unaffected.
   */
  onSent?: () => void | Promise<void>;
  /** Override the unconfirmed-send timeout (ms). Defaults to DEFAULT_PENDING_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Issue #2503: connectivity gate. Omitted, the hook behaves exactly as it did
   * before #2503 — nothing is ever parked and nothing is ever resent on its own,
   * which is what every caller without a connectivity source still gets.
   */
  connectivity?: PendingConnectivity;
  /**
   * Issue #2503: override the settle window between the recovery refetch and the
   * automatic resend. Defaults to DEFAULT_RESEND_GRACE_MS.
   */
  resendGraceMs?: number;
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

/**
 * Render form of a pending. A parked message (#2503) carries `status: 'sending'`
 * deliberately: it is waiting for the network, not failed, and 'sending' is the
 * state the bubble draws as in-flight (spinner, no discard affordance). The
 * parked/not-parked distinction stays on `pending[].queued` for a surface that
 * wants to say "送信待ち" in its own words.
 */
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
  connectivity,
  resendGraceMs = DEFAULT_RESEND_GRACE_MS,
}: UsePendingMessagesOptions): UsePendingMessagesResult {
  const [pending, setPending] = useState<PendingMessage[]>([]);

  // Issue #2503. Defaults reproduce the pre-#2503 hook exactly: never offline,
  // always reachable — so nothing is parked and the recovery edge never fires.
  const offline = connectivity?.offline ?? false;
  const reachable = connectivity?.reachable ?? true;

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

  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  const seqRef = useRef(0);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Issue #2503: tempIds whose send request has not settled. A request in
  // flight has an unknown outcome, and `POST /send` is not idempotent, so these
  // are never resend candidates however long the network has been back.
  const inFlightRef = useRef<Set<string>>(new Set());
  // Server ids already claimed by reconciled (and pruned) pendings. Persisted
  // across renders so a single echo can only ever confirm one pending. Bounded
  // to ids still present in serverMessages so it does not grow unbounded.
  const consumedServerIdsRef = useRef<Set<string>>(new Set());
  // Issue #2503: every tempId a pruning pass has confirmed. The recovery pass
  // can land in the same commit as a prune — and by then the prune has already
  // folded that echo into `consumedServerIdsRef`, so re-deriving the answer from
  // `computeReconciliation` alone reports the pending as unreconciled and
  // resends a message the server demonstrably has. This is the memory of what
  // the prune decided, read rather than recomputed. One short string per
  // confirmed send, for the life of the mount.
  const reconciledTempIdsRef = useRef<Set<string>>(new Set());

  const clearTimer = useCallback((tempId: string) => {
    const timer = timersRef.current.get(tempId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(tempId);
    }
  }, []);

  /**
   * The single place a send stops being in-flight without a server echo.
   *
   * Issue #2503 put a fork here: while the app is offline, a rejection (or an
   * expired clock) says nothing about the message, only about the network, so
   * the pending is parked rather than failed. Once its one automatic resend has
   * been spent the fork closes and the next failure is a failure — that is what
   * bounds recovery to a single attempt per message.
   */
  const failPending = useCallback(
    (tempId: string) => {
      clearTimer(tempId);
      setPending((prev) =>
        prev.map((p) => {
          if (p.tempId !== tempId || p.status !== 'sending') return p;
          if (offlineRef.current && !p.autoResendAttempted) {
            return p.queued ? p : { ...p, queued: true };
          }
          return { ...p, status: 'error', queued: false };
        }),
      );
    },
    [clearTimer],
  );

  const startTimer = useCallback(
    (tempId: string) => {
      clearTimer(tempId);
      const timer = setTimeout(() => {
        timersRef.current.delete(tempId);
        failPending(tempId);
      }, timeoutMs);
      timersRef.current.set(tempId, timer);
    },
    [clearTimer, failPending, timeoutMs],
  );

  const dispatchSend = useCallback(
    async (p: PendingMessage) => {
      startTimer(p.tempId);
      inFlightRef.current.add(p.tempId);
      try {
        await sendFnRef.current(p.content, p.options);
        // Issue #2503: the server took it. A request parked by the offline edge
        // while it was still travelling must not survive as a resend candidate
        // once it has been answered — it stays parked (no clock while there is
        // no network) but it is no longer something to send.
        setPending((prev) =>
          prev.map((cur) =>
            cur.tempId === p.tempId && !cur.accepted ? { ...cur, accepted: true } : cur,
          ),
        );
        void onSentRef.current?.();
        // Stays 'sending' until the server echo reconciles it (or the timeout
        // fires as a fallback if the echo never arrives).
      } catch {
        failPending(p.tempId);
      } finally {
        inFlightRef.current.delete(p.tempId);
      }
    },
    [startTimer, failPending],
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
        queued: false,
        accepted: false,
        autoResendAttempted: false,
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
        // Issue #2503: an explicit retry refills the automatic-resend budget —
        // the user asking again is a new attempt, not a continuation of the one
        // recovery already spent.
        queued: false,
        accepted: false,
        autoResendAttempted: false,
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
      inFlightRef.current.delete(tempId);
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
    reconciledTempIds.forEach((id) => reconciledTempIdsRef.current.add(id));
    reconciledTempIds.forEach(clearTimer);
    setPending((cur) => cur.filter((p) => !reconciledTempIds.has(p.tempId)));
  }, [serverMessages, clearTimer]);

  // ==========================================================================
  // Issue #2503: connectivity
  // ==========================================================================

  /**
   * Going offline parks every message still on its way.
   *
   * This runs on the transition rather than waiting for the send to reject
   * because the interesting case is the one that never rejects: a fetch issued
   * as the signal dies can hang for the whole 30s window, and a message the
   * user posted from a tunnel should read as "waiting", not spend half a minute
   * pretending to send and then claim to have failed. Clearing the timer here
   * is the "オフライン中はカウントしない" half — the clock is restarted from the
   * moment the server answers again, not from the moment the send was made.
   *
   * Messages whose automatic resend is already spent are left alone: they are
   * on their last attempt by design, and parking them again would hand recovery
   * a second budget it is not supposed to have.
   */
  useEffect(() => {
    if (!offline) return;
    const parkable = pending.filter(
      (p) => p.status === 'sending' && !p.queued && !p.autoResendAttempted,
    );
    if (parkable.length === 0) return;
    const ids = new Set(parkable.map((p) => p.tempId));
    ids.forEach(clearTimer);
    setPending((prev) =>
      prev.map((p) => (ids.has(p.tempId) ? { ...p, queued: true } : p)),
    );
  }, [offline, pending, clearTimer]);

  /**
   * The recovery edge: the server answered again, so ask it what it already has
   * before sending anything.
   *
   * `armedRef` makes this a rising edge — one round per loss-of-connection, not
   * one per render while connected. The refetch is awaited rather than fired and
   * forgotten because it IS the duplicate check: `POST /send` has no dedupe key,
   * so the only thing that can tell a lost request from a lost *response* is
   * whether the message is in the transcript the server hands back. Landing the
   * answer first also gives the pruning effect its chance to drop the pendings
   * that were delivered all along.
   *
   * The resend itself is deferred to the effect below via a token raised one
   * settle window *after* the refetch resolves — see DEFAULT_RESEND_GRACE_MS for
   * why resolving is not the same as having the answer.
   */
  const recoveryArmedRef = useRef(false);
  const [recoveryToken, setRecoveryToken] = useState(0);
  // Read through a ref so retuning the window does not re-run the edge effect
  // (and re-arm a recovery that has already been handled).
  const graceRef = useRef(resendGraceMs);
  graceRef.current = resendGraceMs;

  useEffect(() => {
    if (!reachable) {
      recoveryArmedRef.current = true;
      return;
    }
    if (!recoveryArmedRef.current) return;
    recoveryArmedRef.current = false;
    if (!pendingRef.current.some((p) => p.status === 'sending')) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        await onSentRef.current?.();
      } catch {
        // A refetch that fails leaves the transcript as it was; the resend pass
        // below still runs, and its reconciliation check simply has older data
        // to work from. Stranding the queue would be the worse answer.
      }
      if (cancelled) return;
      timer = setTimeout(() => setRecoveryToken((n) => n + 1), graceRef.current);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [reachable]);

  /**
   * One automatic resend per parked message, on the transcript the refetch just
   * produced.
   *
   * Four classes come out of the same pass:
   *   - reconciled → it arrived after all; the pruning effect removes it and
   *     nothing is sent.
   *   - already accepted → the send API answered before the line went down, so
   *     the server has it; only its echo is late. The clock is restarted.
   *   - still in flight → outcome unknown, so only the clock is restarted. This
   *     is the deliberately conservative branch: an unanswered request is not
   *     evidence of a lost message, and duplicating a prompt into an agent's
   *     session is worse than making the user press 再試行.
   *   - parked with its budget intact → resent, budget spent.
   */
  useEffect(() => {
    if (recoveryToken === 0) return;
    const current = pendingRef.current;
    const live = current.filter((p) => p.status === 'sending');
    if (live.length === 0) return;

    const { reconciledTempIds } = computeReconciliation(
      current,
      serverMessagesRef.current,
      consumedServerIdsRef.current,
    );

    const resend: PendingMessage[] = [];
    const restart: string[] = [];
    for (const p of live) {
      if (reconciledTempIds.has(p.tempId) || reconciledTempIdsRef.current.has(p.tempId))
        continue;
      if (p.accepted || inFlightRef.current.has(p.tempId)) {
        restart.push(p.tempId);
      } else if (p.queued) {
        // `queued` already carries the budget: nothing parks a message whose
        // automatic resend is spent (see the offline effect and `failPending`),
        // so a parked message is by construction one that has an attempt left.
        resend.push(p);
      } else if (!timersRef.current.has(p.tempId)) {
        restart.push(p.tempId);
      }
    }

    restart.forEach(startTimer);
    if (resend.length === 0) return;

    const ids = new Set(resend.map((p) => p.tempId));
    setPending((prev) =>
      prev.map((p) =>
        ids.has(p.tempId) ? { ...p, queued: false, autoResendAttempted: true } : p,
      ),
    );
    // The baseline is intentionally NOT recomputed (unlike `retry`): the echo
    // this message is waiting for may still be the one the original send
    // produced, and a fresh baseline would make the hook stop recognising it.
    resend.forEach((p) => {
      void dispatchSend({ ...p, queued: false, autoResendAttempted: true });
    });
  }, [recoveryToken, startTimer, dispatchSend]);

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
