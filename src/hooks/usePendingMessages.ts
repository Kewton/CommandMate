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
 *
 * Issue #2535: "back" is a *standing* condition here, not a transition anyone
 * has to be watching at the right moment. The recovery edge below arms itself
 * from the queue as well as from the verdict, because the render in which the
 * connection is visibly down is not guaranteed to be committed — see the two
 * effects under "Issue #2503: connectivity".
 *
 * ## Unknown outcomes (Issue #4503)
 *
 * Given `isOutcomeUnknown` (the production surfaces pass {@link isSendOutcomeUnknown}), a rejection
 * that does not say "not sent" — `sendOutcome: 'unknown'`, a 5xx without `sendOutcome`, a request
 * that never completed — lands on `unknown`, not `error`: it is never parked for the offline
 * recovery and `retry()` sends it only with `{ confirmedResend: true }`. With
 * `holdInFlightOnTimeout` the clock running out while the request is still in flight leaves the
 * row waiting for the answer (`awaitingResponse`) instead of failing it. Omitted, both behave as
 * before #4503.
 *
 * Issue #4417: every answer is applied only when it answers the row's latest attempt — a late
 * answer to an attempt that was retried leaves the row and its in-flight mark alone.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, OptimisticSendState, RetryPendingOptions, SendRoleRefusalReason } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { SendTargetChangedRefusal } from '@/components/worktree/send-refusal-notice';

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

/**
 * Issue #4535 (C12): the codes of the middleware's typed refusals before the route (401 / 403) —
 * nothing reached the send route, so they are not unknown. Spelled here rather than imported:
 * the middleware's home is server-only.
 */
const REFUSED_BEFORE_ROUTE_CODES: ReadonlySet<string> = new Set(['AUTH_REQUIRED', 'IP_DENIED']);

/**
 * Issue #4503: whether a send's rejection leaves its outcome unknown — the screen must not offer a
 * direct retry, because the text may already be in the agent's session (`POST /send` has no dedupe
 * key). Read from the shape `fetchApi` gives its errors (`ApiError`: `kind`, `status`, `data`) —
 * duck-typed, so a test that replaces `@/lib/api-client` does not take this down with it.
 *
 * - `data.sendOutcome === 'unknown'` (the route's answer, `route.ts` `unboundSendOutcome`) → unknown
 * - `data.sendOutcome === 'not_sent'` → not unknown (nothing was typed: retrying is safe)
 * - `kind` `network` / `timeout` / `aborted` (the request may have reached the server) → unknown
 * - an HTTP 5xx without `sendOutcome` (500 included — PM's D4; a proxy's or tunnel's 502 / 504) → unknown.
 *   Issue #4535 (human decision on C10): the session start's 503s too — the route says `not_sent` on
 *   its own refusals (`recordNotSent` / the sender's `settle`), so one without it is not the route's
 * - Issue #4535 (C10): an HTTP 4xx without `sendOutcome` → unknown (a proxy's or tunnel's page: the
 *   route's own refusals say `not_sent`), except the middleware's typed 401 `AUTH_REQUIRED` / 403
 *   `IP_DENIED` (C12, {@link REFUSED_BEFORE_ROUTE_CODES}) → not unknown
 * - `kind: 'offline'` (refused before it was sent), anything that is not an `ApiError` → not unknown
 */
export function isSendOutcomeUnknown(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const { kind, status, data } = error as { kind?: unknown; status?: unknown; data?: unknown };
  if (typeof kind !== 'string' || typeof status !== 'number') return false;
  const outcome =
    data !== null && typeof data === 'object' ? (data as { sendOutcome?: unknown }).sendOutcome : undefined;
  if (outcome === 'not_sent') return false;
  // `sent` on a failed answer still means the text was typed: never a direct retry.
  if (outcome === 'unknown' || outcome === 'sent') return true;
  if (kind === 'network' || kind === 'timeout' || kind === 'aborted') return true;
  if (kind !== 'http') return false;
  const code = data !== null && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
  if (status >= 400 && status < 500) return !(typeof code === 'string' && REFUSED_BEFORE_ROUTE_CODES.has(code));
  return status >= 500 && status < 600;
}

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
  /**
   * Issue #4345 1c 再指示 2 (K1): an automatic resend of this parked message was not sent (the page's
   * gate refused it: the session expired). It stays parked with its resend not spent, but nothing
   * resends it on its own again (no recovery round is armed for it): the person retries once the
   * session is back. `retry()` clears it.
   */
  heldNotSent?: boolean;
  /**
   * Issue #4385: the last attempt was refused by the server because of the role (409
   * `roleRefusal`, nothing typed) — the reason the failed row shows. Cleared by `retry()`.
   */
  roleRefusal?: SendRoleRefusalReason;
  /**
   * Issue #4385: this message's text was already handed back to the composer by
   * {@link UsePendingMessagesOptions.onRoleRefused} (its first attempt was refused), so
   * `discard()` does not hand it back a second time.
   */
  returnedToComposer?: boolean;
  /**
   * Issue #4503: the clock ran out while this attempt's request is still in flight (with
   * `holdInFlightOnTimeout`). Paired with `status: 'sending'`: the row waits for the answer.
   */
  awaitingResponse?: boolean;
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
  /**
   * Issue #4345 1c 再指示 2 (K1): the send's rejection says it was NOT SENT (the hand-off page's gate
   * refused it) — not a failure. The row goes back to what it was before this attempt: a retried row
   * to its failed state, a parked one to parked with its automatic resend not spent (the person
   * retries after the recovery). A new send leaves no bubble (nothing was sent: no optimistic display
   * is left to look sent) and its text goes to {@link onNotSent}. Omitted: every rejection is a failure.
   */
  isNotSent?: (error: unknown) => boolean;
  /** Issue #4345 1c 再指示 2: a new send not sent — its text, for the composer to keep. */
  onNotSent?: (content: string) => void;
  /**
   * Issue #4385: the role reason of a rejection the server answered with 409 `roleRefusal`
   * (nothing typed), or null. Such a rejection fails the row at once (the server answered, so it
   * is never parked for connectivity) and the row carries the reason. Omitted: no reason is read.
   */
  readRoleRefusal?: (error: unknown) => SendRoleRefusalReason | null;
  /**
   * Issue #4385: a send was refused because of its role — for the screen to say why right away.
   * `firstAttempt` is true for a new send (not a retry): its text is the composer's to keep, as
   * the composer clears only what the server took. Returns whether it handed the text back to the
   * composer (then `discard()` does not hand it back again).
   */
  onRoleRefused?: (content: string, reason: SendRoleRefusalReason, info: { firstAttempt: boolean }) => boolean;
  /**
   * Issue #4535 (段 2 §3): the send fence's refusal (#4534, 409 `SEND_TARGET_CHANGED`), or null.
   * `not_sent` (nothing typed) fails the row at once, as a role refusal does, without a role
   * reason; `unknown` goes on to {@link isOutcomeUnknown} as before. Omitted: not read.
   */
  readTargetChanged?: (error: unknown) => SendTargetChangedRefusal | null;
  /**
   * Issue #4535: the fence stopped a send — for the screen to say why right away (both outcomes).
   * For `not_sent`, returns whether it handed the text back to the composer (only a new send's
   * text, `firstAttempt`); then `discard()` does not hand it back again. `unknown`: never handed back.
   */
  onTargetChanged?: (content: string, refusal: SendTargetChangedRefusal, info: { firstAttempt: boolean }) => boolean;
  /**
   * Issue #4503: whether a rejection leaves the send's outcome unknown (pass
   * {@link isSendOutcomeUnknown}). Such a row lands on `unknown`: never parked, never resent on its
   * own, and `retry()` sends it only when confirmed. Omitted: every such rejection is a failure.
   */
  isOutcomeUnknown?: (error: unknown) => boolean;
  /**
   * Issue #4503: when the clock runs out while the row's latest attempt is still in flight, the
   * row waits for the answer (`awaitingResponse`) instead of failing; the answer then decides.
   * Omitted: the clock fails the row as before.
   */
  holdInFlightOnTimeout?: boolean;
  /**
   * Issue #4417: a new send's text was handed back to the composer as not sent (`onNotSent`, or
   * `onRoleRefused` returning true) but its attached image could not go with it — for the screen to say so.
   */
  onAttachmentNotReturned?: (imagePath: string) => void;
}

export interface UsePendingMessagesResult {
  /** serverMessages with unreconciled pending messages merged in. */
  messages: ChatMessage[];
  pending: PendingMessage[];
  sendOptimistic: (content: string, options: OptimisticSendOptions) => void;
  /**
   * Re-sends a pending row. Issue #4503: an `unknown` row is sent again only with
   * `{ confirmedResend: true }` (the person confirmed it); a row waiting for its in-flight answer
   * is not sent again at all.
   */
  retry: (tempId: string, options?: RetryPendingOptions) => void;
  /**
   * Removes the pending and returns its content (for draft restore) — undefined when the text was
   * already handed back to the composer by `onRoleRefused` (Issue #4385).
   */
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
  // Issue #4503: an `unknown` row's echo proves it was delivered after all.
  const sending = pending.filter((p) => p.status === 'sending' || p.status === 'unknown');
  if (sending.length === 0) return { reconciledTempIds, consumedServerIds };

  const serverUser = serverMessages
    .filter((m) => m.role === 'user' && !alreadyConsumed.has(m.id))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const consumed = new Set<string>();

  // Issue #4503 (review P3-6): the rows still on their way take an echo first, the unknown ones
  // after. A later send of the same text must not lose its echo to an older unknown row — it would
  // then run out its clock with no echo, while the unknown row (which may never have arrived)
  // vanished as if delivered. An unknown row left over stays unknown: safe, it never resends itself.
  const ordered = [...sending].sort(
    (a, b) =>
      Number(a.status === 'unknown') - Number(b.status === 'unknown') ||
      a.timestamp.getTime() - b.timestamp.getTime(),
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
    // Issue #4345 1c-2: a parked message whose automatic resend was refused (`heldNotSent`) is
    // drawn as 'error' so the bubble offers retry / discard (both the PC card and the mobile bubble
    // show them for 'error' only). Nothing resends it on its own; retry is the person's.
    optimisticState: p.heldNotSent ? 'error' : p.status,
    ...(p.status === 'error' && p.roleRefusal ? { optimisticRoleRefusal: p.roleRefusal } : {}),
    ...(p.status === 'sending' && p.awaitingResponse && !p.heldNotSent ? { optimisticAwaitingResponse: true } : {}),
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
  isNotSent,
  onNotSent,
  readRoleRefusal,
  onRoleRefused,
  readTargetChanged,
  onTargetChanged,
  isOutcomeUnknown,
  holdInFlightOnTimeout = false,
  onAttachmentNotReturned,
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
  const isNotSentRef = useRef(isNotSent);
  isNotSentRef.current = isNotSent;
  const onNotSentRef = useRef(onNotSent);
  onNotSentRef.current = onNotSent;
  const readRoleRefusalRef = useRef(readRoleRefusal);
  readRoleRefusalRef.current = readRoleRefusal;
  const onRoleRefusedRef = useRef(onRoleRefused);
  onRoleRefusedRef.current = onRoleRefused;
  const readTargetChangedRef = useRef(readTargetChanged);
  readTargetChangedRef.current = readTargetChanged;
  const onTargetChangedRef = useRef(onTargetChanged);
  onTargetChangedRef.current = onTargetChanged;
  const isOutcomeUnknownRef = useRef(isOutcomeUnknown);
  isOutcomeUnknownRef.current = isOutcomeUnknown;
  const holdInFlightOnTimeoutRef = useRef(holdInFlightOnTimeout);
  holdInFlightOnTimeoutRef.current = holdInFlightOnTimeout;
  const onAttachmentNotReturnedRef = useRef(onAttachmentNotReturned);
  onAttachmentNotReturnedRef.current = onAttachmentNotReturned;

  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  const seqRef = useRef(0);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Issue #2503: tempIds whose send request has not settled. A request in
  // flight has an unknown outcome, and `POST /send` is not idempotent, so these
  // are never resend candidates however long the network has been back.
  // Issue #4385 再指示 2: kept per attempt (the object `dispatchSend` sent), so an older attempt
  // settling — a late answer after a retry — does not clear the in-flight mark of the attempt that
  // is still travelling. A tempId is in flight while any of its attempts is.
  const inFlightRef = useRef<Map<string, Set<PendingMessage>>>(new Map());
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
  // Issue #4385 再指示 1: each row's latest attempt (the object `dispatchSend` sent), so a late
  // answer is applied only to the attempt it answers. Removed when the row is discarded or
  // confirmed.
  const attemptsRef = useRef<Map<string, PendingMessage>>(new Map());

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
          // Issue #4503 (review 2 P2-2): the server answered 201 — it typed the text — and only the
          // echo is missing. Never error + ［再試行］ (that would send it twice): first it waits for
          // the echo (`awaitingResponse`, one more window), then nobody can say whether it landed.
          if (p.accepted && holdInFlightOnTimeoutRef.current) {
            return p.awaitingResponse
              ? { ...p, status: 'unknown', queued: false, awaitingResponse: false }
              : { ...p, awaitingResponse: true };
          }
          return { ...p, status: 'error', queued: false };
        }),
      );
    },
    [clearTimer],
  );

  /**
   * Issue #4503: the attempt `p` answered "nobody knows whether it was sent". The row (its latest
   * attempt — the caller checked) lands on `unknown`: never parked for the offline recovery, which
   * resends only what never left, and never offered a direct retry. A row the clock already failed
   * (pre-#4503 wiring) takes it too, so its retry goes away.
   */
  const settleUnknown = useCallback(
    (tempId: string) => {
      clearTimer(tempId);
      setPending((prev) =>
        prev.map((p) =>
          p.tempId === tempId && (p.status === 'sending' || p.status === 'error')
            ? { ...p, status: 'unknown', queued: false, awaitingResponse: false, heldNotSent: false }
            : p,
        ),
      );
    },
    [clearTimer],
  );

  const startTimer = useCallback(
    (tempId: string) => {
      clearTimer(tempId);
      const timer = setTimeout(() => {
        timersRef.current.delete(tempId);
        // Issue #4503: the clock says nothing about a request still on its way (the send itself
        // may run far longer, `getSendTimeoutMs()`): the row waits for the answer instead.
        if (holdInFlightOnTimeoutRef.current) {
          const latest = attemptsRef.current.get(tempId);
          if (latest && inFlightRef.current.get(tempId)?.has(latest)) {
            setPending((prev) =>
              prev.map((p) =>
                p.tempId === tempId && p.status === 'sending' && !p.awaitingResponse
                  ? { ...p, awaitingResponse: true }
                  : p,
              ),
            );
            return;
          }
        }
        failPending(tempId);
      }, timeoutMs);
      timersRef.current.set(tempId, timer);
    },
    [clearTimer, failPending, timeoutMs],
  );

  // Issue #4503 (review 2 P2-2): an accepted row whose clock ran out waits for its echo one more
  // window (`failPending` set `awaitingResponse`); when that one runs out too, it is unknown.
  // Read off the committed rows, so the re-armed clock follows what is on screen.
  useEffect(() => {
    if (!holdInFlightOnTimeout) return;
    for (const p of pending) {
      if (p.status === 'sending' && p.accepted && p.awaitingResponse && !p.queued && !timersRef.current.has(p.tempId)) {
        startTimer(p.tempId);
      }
    }
  }, [pending, startTimer, holdInFlightOnTimeout]);

  /** Issue #4417: a new send's text went back to the composer; its image could not. */
  const noteAttachmentNotReturned = useCallback((p: PendingMessage) => {
    if (p.options.imagePath) onAttachmentNotReturnedRef.current?.(p.options.imagePath);
  }, []);

  /**
   * Issue #4345 1c 再指示 2: the attempt `p` was not sent — the row goes back to `previous` (its state
   * before this attempt), or, for a new send (none), leaves with its text handed back.
   */
  const revertNotSent = useCallback(
    (p: PendingMessage, previous: PendingMessage | undefined, priorAttempt: PendingMessage | undefined) => {
      clearTimer(p.tempId);
      if (previous) {
        // Issue #4385 再指示 2: the row goes back, and so does which attempt it belongs to — the one
        // before this attempt (say a timed-out send whose answer is still to come), so its late
        // answer is still applied to the row. Only when this attempt is still the row's latest.
        if (attemptsRef.current.get(p.tempId) === p) {
          if (priorAttempt) attemptsRef.current.set(p.tempId, priorAttempt);
          else attemptsRef.current.delete(p.tempId);
        }
        setPending((prev) => prev.map((cur) => (cur.tempId === p.tempId ? previous : cur)));
        return;
      }
      attemptsRef.current.delete(p.tempId);
      setPending((prev) => prev.filter((cur) => cur.tempId !== p.tempId));
      onNotSentRef.current?.(p.content);
      if (onNotSentRef.current) noteAttachmentNotReturned(p);
    },
    [clearTimer, noteAttachmentNotReturned],
  );

  const dispatchSend = useCallback(
    async (p: PendingMessage, previous?: PendingMessage) => {
      const priorAttempt = attemptsRef.current.get(p.tempId);
      attemptsRef.current.set(p.tempId, p);
      startTimer(p.tempId);
      const attemptsInFlight = inFlightRef.current.get(p.tempId) ?? new Set<PendingMessage>();
      attemptsInFlight.add(p);
      inFlightRef.current.set(p.tempId, attemptsInFlight);
      try {
        await sendFnRef.current(p.content, p.options);
        // Issue #4417: an answer to an attempt that is no longer the row's latest (retried,
        // discarded, confirmed) changes nothing on the row. The refetch still runs: its echo is
        // what confirms the row if this older attempt is the one that arrived.
        if (attemptsRef.current.get(p.tempId) !== p) {
          void onSentRef.current?.();
          return;
        }
        // Issue #4503: a row that was waiting for this answer (its clock ran out in flight) gets
        // its clock back, as a send answered in time has it: the echo, or the fallback as before.
        const waited = pendingRef.current.some(
          (cur) => cur.tempId === p.tempId && cur.status === 'sending' && cur.awaitingResponse === true && !cur.queued,
        );
        // Issue #2503: the server took it. A request parked by the offline edge
        // while it was still travelling must not survive as a resend candidate
        // once it has been answered — it stays parked (no clock while there is
        // no network) but it is no longer something to send.
        setPending((prev) =>
          prev.map((cur) =>
            cur.tempId === p.tempId && (!cur.accepted || cur.awaitingResponse)
              ? { ...cur, accepted: true, awaitingResponse: false }
              : cur,
          ),
        );
        if (waited) startTimer(p.tempId);
        void onSentRef.current?.();
        // Stays 'sending' until the server echo reconciles it (or the timeout
        // fires as a fallback if the echo never arrives).
      } catch (error) {
        // Issue #4417: a late answer to an older attempt (after a retry or an automatic resend) or
        // to a row that was discarded or confirmed changes nothing — whatever kind it is.
        if (attemptsRef.current.get(p.tempId) !== p) return;
        // Issue #4345 1c 再指示 2 (K1): not sent — not a failure (no error row, no resend spent).
        if (isNotSentRef.current?.(error)) {
          revertNotSent(p, previous, priorAttempt);
          return;
        }
        // Issue #4385: refused because of the role (409, nothing typed). The server answered, so
        // the row fails now (never parked) with the reason; a new send's text goes back to the
        // composer, which clears only what the server took. Also when the answer is late — the
        // clock already failed this very attempt (再指示 1): the row still takes the reason and the
        // record that its text went back, so a discard does not hand it back again. Only the row's
        // latest attempt (`attemptsRef`) counts: a late answer to an older attempt (after a retry
        // or an automatic resend) or to a row that was discarded or confirmed changes nothing.
        const roleRefusal = readRoleRefusalRef.current?.(error) ?? null;
        if (roleRefusal !== null) {
          if (attemptsRef.current.get(p.tempId) !== p) return;
          const sameAttempt = (cur: PendingMessage) =>
            cur.tempId === p.tempId && (cur.status === 'sending' || cur.status === 'error');
          clearTimer(p.tempId);
          const firstAttempt = previous === undefined;
          const handedBack = onRoleRefusedRef.current?.(p.content, roleRefusal, { firstAttempt }) === true;
          if (handedBack) noteAttachmentNotReturned(p);
          setPending((prev) =>
            prev.map((cur) =>
              sameAttempt(cur)
                ? {
                    ...cur,
                    status: 'error',
                    queued: false,
                    roleRefusal,
                    awaitingResponse: false,
                    returnedToComposer: cur.returnedToComposer || handedBack,
                  }
                : cur,
            ),
          );
          return;
        }
        // Issue #4535 (段 2 §3): the send fence stopped it (409 `SEND_TARGET_CHANGED`). The reason
        // is said either way. `not_sent`: the road of the role refusal above — the row fails now
        // with its text handed back once (a new send's only); `unknown`: never handed back, the
        // row goes on to the unknown outcome below.
        const targetChanged = readTargetChangedRef.current?.(error) ?? null;
        if (targetChanged !== null) {
          const firstAttempt = previous === undefined;
          if (targetChanged.sendOutcome === 'not_sent') {
            const sameAttempt = (cur: PendingMessage) =>
              cur.tempId === p.tempId && (cur.status === 'sending' || cur.status === 'error');
            clearTimer(p.tempId);
            const handedBack = onTargetChangedRef.current?.(p.content, targetChanged, { firstAttempt }) === true;
            if (handedBack) noteAttachmentNotReturned(p);
            setPending((prev) =>
              prev.map((cur) =>
                sameAttempt(cur)
                  ? {
                      ...cur,
                      status: 'error',
                      queued: false,
                      awaitingResponse: false,
                      returnedToComposer: cur.returnedToComposer || handedBack,
                    }
                  : cur,
              ),
            );
            return;
          }
          onTargetChangedRef.current?.(p.content, targetChanged, { firstAttempt });
        }
        // Issue #4503: nobody knows whether it arrived — not a failure, and nothing to retry.
        if (isOutcomeUnknownRef.current?.(error)) {
          settleUnknown(p.tempId);
          return;
        }
        failPending(p.tempId);
      } finally {
        // Issue #4385 再指示 2: only this attempt stops being in flight; a newer one may still be.
        const attemptsLeft = inFlightRef.current.get(p.tempId);
        attemptsLeft?.delete(p);
        if (attemptsLeft && attemptsLeft.size === 0) inFlightRef.current.delete(p.tempId);
      }
    },
    [startTimer, failPending, revertNotSent, clearTimer, settleUnknown, noteAttachmentNotReturned],
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
    (tempId: string, options?: RetryPendingOptions) => {
      const target = pendingRef.current.find((p) => p.tempId === tempId);
      if (!target) return;
      // Issue #4503: an unknown outcome may already be in the agent's session — sent again only
      // when the person confirmed it (then as a new send of the same text). A row still waiting
      // for its in-flight answer is not sent again at all.
      if (target.status === 'unknown' && options?.confirmedResend !== true) return;
      if (target.status === 'sending' && target.awaitingResponse) return;
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
        heldNotSent: false,
        roleRefusal: undefined,
        awaitingResponse: false,
      };
      setPending((prev) =>
        prev.map((p) => (p.tempId === tempId ? revived : p)),
      );
      // Issue #4345 1c 再指示 2: not sent, the row goes back to `target` (failed, as it was).
      void dispatchSend(revived, target);
    },
    [dispatchSend],
  );

  const discard = useCallback(
    (tempId: string): string | undefined => {
      const target = pendingRef.current.find((p) => p.tempId === tempId);
      clearTimer(tempId);
      inFlightRef.current.delete(tempId);
      attemptsRef.current.delete(tempId);
      setPending((prev) => prev.filter((p) => p.tempId !== tempId));
      // Issue #4385: a text already handed back to the composer is not handed back twice.
      // Issue #4503: nor is an unknown one's — back in the composer, one Enter would send it again
      // without the confirmation its row asks for.
      if (target?.status === 'unknown') return undefined;
      return target?.returnedToComposer ? undefined : target?.content;
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
    reconciledTempIds.forEach((id) => attemptsRef.current.delete(id));
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
   * Split in two (Issue #2535). The first effect decides *that* a round is owed
   * and the second one runs it, because the two need different triggers and the
   * single effect that did both was wrong on each count.
   *
   * **Arming** — what the old version got wrong. It recorded "a round is owed"
   * only while rendering a `reachable === false` state, which made the whole
   * mechanism depend on React committing a render in the gap between the network
   * coming back and the WebSocket reconnecting — 5ms, on the acceptance test's
   * own measurement, and comfortably inside one batch. Miss that render and
   * nothing is ever owed. So the debt is now recorded from a *standing* fact
   * instead: a parked message is itself proof that a round is outstanding,
   * whether or not the transition it was parked by was ever rendered.
   *
   * **Firing** — the refetch is awaited rather than fired and forgotten because
   * it IS the duplicate check: `POST /send` has no dedupe key, so the only thing
   * that can tell a lost request from a lost *response* is whether the message
   * is in the transcript the server hands back. Landing the answer first also
   * gives the pruning effect its chance to drop the pendings that were delivered
   * all along. The request is published as a counter so that round, once begun,
   * is never restarted or torn down by an unrelated dependency moving — least of
   * all by the refetch it issued itself, which changes the very pending list the
   * arming effect watches.
   *
   * The resend is deferred one step further, to the effect below, via a token
   * raised a settle window *after* the refetch resolves — see
   * DEFAULT_RESEND_GRACE_MS for why resolving is not the same as having the
   * answer.
   */
  const recoveryOwedRef = useRef(false);
  const [recoveryRequest, setRecoveryRequest] = useState(0);
  const [recoveryToken, setRecoveryToken] = useState(0);
  // Read through a ref so retuning the window does not re-run the edge effect
  // (and re-arm a recovery that has already been handled).
  const graceRef = useRef(resendGraceMs);
  graceRef.current = resendGraceMs;

  // How many messages are parked for connectivity. A count rather than a
  // boolean so a second message joining the queue is a dependency change too.
  const parkedCount = pending.reduce(
    // Issue #4345 1c 再指示 2: a message held as not sent owes no automatic round.
    (n, p) => (p.queued && p.status === 'sending' && !p.heldNotSent ? n + 1 : n),
    0,
  );

  useEffect(() => {
    // Either fact owes a round: the connection is not confirmed, or something
    // is sitting in the queue waiting for one.
    if (!reachable || parkedCount > 0) recoveryOwedRef.current = true;
    if (!reachable || !recoveryOwedRef.current) return;
    recoveryOwedRef.current = false;
    if (!pendingRef.current.some((p) => p.status === 'sending')) return;
    setRecoveryRequest((n) => n + 1);
  }, [reachable, parkedCount]);

  useEffect(() => {
    if (recoveryRequest === 0) return;

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
  }, [recoveryRequest]);

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
      } else if (p.queued && !p.heldNotSent) {
        // `queued` already carries the budget: nothing parks a message whose
        // automatic resend is spent (see the offline effect and `failPending`),
        // so a parked message is by construction one that has an attempt left.
        resend.push(p);
      } else if (!p.heldNotSent && !timersRef.current.has(p.tempId)) {
        // (Issue #4345 1c 再指示 2: a message held as not sent gets no clock either — it is not failed.)
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
    // Issue #4345 1c 再指示 2: not sent (the page's gate refused it), the row stays parked with its
    // automatic resend not spent — the person retries after the recovery.
    resend.forEach((p) => {
      void dispatchSend(
        { ...p, queued: false, autoResendAttempted: true },
        { ...p, queued: true, autoResendAttempted: false, heldNotSent: true },
      );
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
