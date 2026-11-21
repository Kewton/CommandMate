/**
 * Issue #4503 (PR-B2, design-4503.md 第 2 版 §3・§6.3 U1〜U4) and Issue #4417: the optimistic layer
 * tells "the server said it was not sent" apart from "nobody knows whether it was sent".
 *
 * `POST /send` has no dedupe key, so a send whose outcome is unknown must never be sent again
 * without the person confirming it — not by ［再試行］, not by the offline recovery (#2503).
 * Answers are shaped as the route returns them (`sendOutcome` on the error body, `route.ts`
 * `unboundSendOutcome`): `not_sent` / a 4xx is a failure that may be retried; `unknown`, a 5xx other
 * than 500 with no `sendOutcome` (a proxy's 502/504), and a fetch that never completed
 * (`ApiError.kind` network / timeout / aborted) are `unknown`. A bare 500 stays a failure (pinned by
 * the #4385 / #4345 suites). Only a send refused before it left (`kind: 'offline'`) is parked
 * and resent on its own.
 *
 * #4417: every answer is applied to the row only when it answers the row's latest attempt — a late
 * success / 500 / 409 of an attempt that was retried leaves the retried row and its in-flight mark
 * alone. A not-sent new send hands its text back; its attachment cannot go back, so the screen is told.
 *
 * Negative controls: without the new options the hook behaves exactly as before (the existing
 * suites pin that), and `not_sent` / 4xx still fail with a working ［再試行］.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  usePendingMessages,
  isSendOutcomeUnknown,
  type PendingConnectivity,
  type SendFn,
  type UsePendingMessagesOptions,
} from '@/hooks/usePendingMessages';
import { ApiError } from '@/lib/api-client';
import { readSendRoleRefusal } from '@/components/worktree/role-refusal-notice';
import type { ChatMessage } from '@/types/models';

const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const OFFLINE: PendingConnectivity = { offline: true, reachable: false };
const GRACE_MS = 5;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, GRACE_MS * 5)));

/** The route's answers (`src/app/api/worktrees/[id]/send/route.ts`), as `fetchApi` turns them into errors. */
const unknown500 = () =>
  new ApiError('submit could not be confirmed', 500, { error: 'submit could not be confirmed', sendOutcome: 'unknown' });
const notSent500 = () => new ApiError('session start failed', 500, { error: 'session start failed', sendOutcome: 'not_sent' });
const bare502 = () => new ApiError('HTTP error 502', 502, {});
const bare504 = () => new ApiError('HTTP error 504', 504, {});
const bare500 = () => new ApiError('boom', 500, { error: 'boom' });
const network = () => new ApiError('Failed to fetch', 0, undefined, 'network');
const timeout = () => new ApiError('Request timed out after 600000ms', 0, undefined, 'timeout');
const aborted = () => new ApiError('Request aborted', 0, undefined, 'aborted');
const offline = () => new ApiError('No network connection', 0, undefined, 'offline');
const bad400 = () => new ApiError('content is required', 400, { error: 'content is required' });
const conflict409 = () => new ApiError('prompt waiting', 409, { error: 'prompt waiting', sendOutcome: 'not_sent' });
const roleRefused = () =>
  new ApiError('refused', 409, { error: 'refused', code: 'ROLE_LAUNCH_REFUSED', roleRefusal: 'not-applied', sendOutcome: 'not_sent' });

function serverUserMessage(content: string, id: string, timeMs: number): ChatMessage {
  return { id, worktreeId: 'w1', role: 'user', content, timestamp: new Date(timeMs), messageType: 'normal', archived: false };
}

interface HarnessProps {
  serverMessages: ChatMessage[];
  connectivity: PendingConnectivity;
  timeoutMs?: number;
}

/** The hook as the production surfaces wire it (`useOptimisticPaneMessages`, `SessionTile`). */
function renderPending(sendFn: SendFn, extra: Partial<UsePendingMessagesOptions> = {}, initial: Partial<HarnessProps> = {}) {
  return renderHook(
    ({ serverMessages, connectivity, timeoutMs }: HarnessProps) =>
      usePendingMessages({
        worktreeId: 'w1',
        serverMessages,
        sendFn,
        connectivity,
        resendGraceMs: GRACE_MS,
        isOutcomeUnknown: isSendOutcomeUnknown,
        holdInFlightOnTimeout: true,
        ...extra,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    { initialProps: { serverMessages: initial.serverMessages ?? [], connectivity: initial.connectivity ?? ONLINE } as HarnessProps },
  );
}

function deferredSend() {
  const answers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const sendFn = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        answers.push({ resolve, reject });
      }),
  );
  return { sendFn, answers };
}

describe('[#4503] isSendOutcomeUnknown: what the route answered', () => {
  it.each([
    ['500 sendOutcome:unknown', unknown500()],
    ['502 with no sendOutcome', bare502()],
    ['504 with no sendOutcome', bare504()],
    ['fetch rejected (network)', network()],
    ['client timeout', timeout()],
    ['aborted', aborted()],
  ])('%s → unknown', (_name, error) => {
    expect(isSendOutcomeUnknown(error)).toBe(true);
  });

  it.each([
    ['500 sendOutcome:not_sent', notSent500()],
    // A bare 500 stays a plain failure: #4385 / #4345 pin it (see isSendOutcomeUnknown).
    ['500 with no sendOutcome', bare500()],
    ['400', bad400()],
    ['409 not_sent', conflict409()],
    ['409 role refusal', roleRefused()],
    ['offline (never sent)', offline()],
    // Review 1 P2-1: a 5xx whose code says the server refused before any key (the session start).
    ['503 SESSION_STARTING with no sendOutcome', new ApiError('starting', 503, { error: 'starting', code: 'SESSION_STARTING' })],
    ['503 SESSION_START_FAILED with no sendOutcome', new ApiError('exited', 503, { error: 'exited', code: 'SESSION_START_FAILED' })],
    ['503 SESSION_START_UNAVAILABLE with no sendOutcome', new ApiError('missing', 503, { error: 'missing', code: 'SESSION_START_UNAVAILABLE' })],
    ['not an ApiError', new TypeError('Failed to fetch')],
    ['null', null],
  ])('%s → not unknown', (_name, error) => {
    expect(isSendOutcomeUnknown(error)).toBe(false);
  });
});

describe('[#4503] U1・U2: an unknown outcome is not a failure, and is never resent without a confirmation', () => {
  it.each([
    ['500 sendOutcome:unknown', unknown500],
    ['502 with no sendOutcome', bare502],
    ['fetch rejected (network)', network],
    ['client timeout', timeout],
    ['aborted', aborted],
  ])('%s: the row is unknown; retry() without a confirmation sends nothing', async (_name, make) => {
    const sendFn = vi.fn().mockRejectedValue(make());
    const { result } = renderPending(sendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('unknown');
    act(() => result.current.retry(result.current.pending[0].tempId));
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.current.messages[0].optimisticState).toBe('unknown');
  });

  it('an unknown outcome is not parked and not resent by the offline recovery (#2503)', async () => {
    const sendFn = vi.fn().mockRejectedValue(network());
    const { result, rerender } = renderPending(sendFn, {}, { connectivity: OFFLINE });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('unknown');
    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result.current.messages[0].optimisticState).toBe('unknown');
  });

  it('(control #2503) a send refused before it left (kind offline) is still parked and resent once', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValue({ success: true });
    const { result, rerender } = renderPending(sendFn, {}, { connectivity: OFFLINE });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.pending[0].queued).toBe(true);
    expect(result.current.messages[0].optimisticState).toBe('sending');
    rerender({ serverMessages: [], connectivity: ONLINE });
    await flush();
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it('a confirmed resend is a new send of the same text', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(unknown500()).mockResolvedValue({ success: true });
    const { result } = renderPending(sendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('unknown');
    act(() => result.current.retry(result.current.pending[0].tempId, { confirmedResend: true }));
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenLastCalledWith('hello', { cliToolId: 'antigravity' });
    expect(result.current.messages[0].optimisticState).toBe('sending');
  });

  it('discarding an unknown row does not hand its text back to the composer (no Enter resends it unconfirmed)', async () => {
    const sendFn = vi.fn().mockRejectedValue(unknown500());
    const { result } = renderPending(sendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    let restored: string | undefined = 'unset';
    act(() => {
      restored = result.current.discard(result.current.pending[0].tempId);
    });
    expect(restored).toBeUndefined();
    expect(result.current.messages).toHaveLength(0);
  });

  it('an unknown row whose echo arrives after all is reconciled (it was delivered)', async () => {
    const sendFn = vi.fn().mockRejectedValue(unknown500());
    const { result, rerender } = renderPending(sendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('unknown');
    rerender({ serverMessages: [serverUserMessage('hello', 's1', Date.now() + 1000)], connectivity: ONLINE });
    await flush();
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].optimisticState).toBeUndefined();
  });

  it('review 1 P3-6: a later send of the same text takes the echo before an older unknown row', async () => {
    const sendFn = vi.fn().mockRejectedValueOnce(unknown500()).mockResolvedValue({ success: true });
    const { result, rerender } = renderPending(sendFn, {}, { timeoutMs: 60_000 });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('unknown');
    // The person types the same text again (a new send, not a resend of the row).
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    const [older, newer] = result.current.pending.map((p) => p.tempId);
    rerender({ serverMessages: [serverUserMessage('hello', 's1', Date.now() + 1000)], connectivity: ONLINE, timeoutMs: 60_000 });
    await flush();
    // One echo: the new send's. The unknown row stays unknown (it never resends itself).
    expect(result.current.pending.map((p) => p.tempId)).toEqual([older]);
    expect(result.current.pending.some((p) => p.tempId === newer)).toBe(false);
    expect(result.current.pending[0].status).toBe('unknown');
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['500 sendOutcome:not_sent', notSent500],
    ['400', bad400],
    ['409 not_sent', conflict409],
  ])('(positive control) %s: the row fails and retry() sends it again', async (_name, make) => {
    const sendFn = vi.fn().mockRejectedValueOnce(make()).mockResolvedValue({ success: true });
    const { result } = renderPending(sendFn);
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
    act(() => result.current.retry(result.current.pending[0].tempId));
    await flush();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(result.current.messages[0].optimisticState).toBe('sending');
  });
});

describe('[#4503] U3: the clock runs out while the request is still in flight', () => {
  it('the row waits for the answer (no error, no retry), and the 201 + echo clears it', async () => {
    const { sendFn, answers } = deferredSend();
    const { result, rerender } = renderPending(sendFn, { timeoutMs: 10 });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('sending');
    expect(result.current.messages[0].optimisticAwaitingResponse).toBe(true);
    // Nothing to retry while it is in flight.
    act(() => result.current.retry(result.current.pending[0].tempId));
    expect(sendFn).toHaveBeenCalledTimes(1);
    await act(async () => answers[0].resolve({ id: 's1' }));
    rerender({ serverMessages: [serverUserMessage('hello', 's1', Date.now() + 1000)], connectivity: ONLINE });
    await flush();
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.messages[0].id).toBe('s1');
  });

  it('a late unknown answer after the wait lands on unknown, a late not_sent on error', async () => {
    const first = deferredSend();
    const a = renderPending(first.sendFn, { timeoutMs: 10 });
    act(() => a.result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    await act(async () => first.answers[0].reject(unknown500()));
    await flush();
    expect(a.result.current.messages[0].optimisticState).toBe('unknown');

    const second = deferredSend();
    const b = renderPending(second.sendFn, { timeoutMs: 10 });
    act(() => b.result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    await act(async () => second.answers[0].reject(notSent500()));
    await flush();
    expect(b.result.current.messages[0].optimisticState).toBe('error');
  });

  it('(control) without holdInFlightOnTimeout the clock fails the row as before', async () => {
    const { sendFn } = deferredSend();
    const { result } = renderPending(sendFn, { timeoutMs: 10, holdInFlightOnTimeout: false });
    act(() => result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('error');
  });
});

describe('[#4417] U4: a late answer to an older attempt leaves the retried row alone', () => {
  /** The first attempt is failed by the clock (pre-#4503 wiring), then retried: attempt 2 is in flight. */
  async function retriedWhileFirstInFlight(extra: Partial<UsePendingMessagesOptions> = {}) {
    const { sendFn, answers } = deferredSend();
    const hook = renderPending(sendFn, {
      timeoutMs: 10,
      holdInFlightOnTimeout: false,
      readRoleRefusal: readSendRoleRefusal,
      onRoleRefused: vi.fn(() => true),
      ...extra,
    });
    act(() => hook.result.current.sendOptimistic('hello', { cliToolId: 'antigravity' }));
    await flush();
    expect(hook.result.current.messages[0].optimisticState).toBe('error');
    // The retry gets a long clock, so only the answers move the row from here.
    hook.rerender({ serverMessages: [], connectivity: ONLINE, timeoutMs: 60_000 });
    act(() => hook.result.current.retry(hook.result.current.pending[0].tempId));
    expect(sendFn).toHaveBeenCalledTimes(2);
    return { ...hook, sendFn, answers };
  }

  it('success of the old attempt: the new row is not marked accepted and stays sending', async () => {
    const { result, answers } = await retriedWhileFirstInFlight();
    await act(async () => answers[0].resolve({ id: 's-old' }));
    await flush();
    expect(result.current.pending[0].status).toBe('sending');
    expect(result.current.pending[0].accepted).toBe(false);
  });

  it('500 of the old attempt: the new row does not fail', async () => {
    const { result, answers } = await retriedWhileFirstInFlight();
    await act(async () => answers[0].reject(bare500()));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('sending');
  });

  it('409 of the old attempt: the new row does not fail and carries no reason', async () => {
    const { result, answers } = await retriedWhileFirstInFlight();
    await act(async () => answers[0].reject(roleRefused()));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('sending');
    expect(result.current.messages[0].optimisticRoleRefusal).toBeUndefined();
  });

  it('after the old attempt settles, the new attempt is still the one the row follows', async () => {
    const { result, answers } = await retriedWhileFirstInFlight();
    await act(async () => answers[0].resolve({ id: 's-old' }));
    await flush();
    // The new attempt answers last; it is still the one the row follows.
    await act(async () => answers[1].reject(unknown500()));
    await flush();
    expect(result.current.messages[0].optimisticState).toBe('unknown');
  });
});

describe('[#4417] the attachment of a send handed back as not sent', () => {
  it('a not-sent new send hands its text back and tells the screen the image did not go back', async () => {
    const onNotSent = vi.fn();
    const onAttachmentNotReturned = vi.fn();
    const sendFn = vi.fn().mockRejectedValue(new Error('gate'));
    const { result } = renderPending(sendFn, {
      isNotSent: () => true,
      onNotSent,
      onAttachmentNotReturned,
    });
    act(() => result.current.sendOptimistic('see this', { cliToolId: 'claude', imagePath: '.commandmate/attachments/a.png' }));
    await flush();
    expect(onNotSent).toHaveBeenCalledWith('see this');
    expect(onAttachmentNotReturned).toHaveBeenCalledWith('.commandmate/attachments/a.png');
  });

  it('a role refusal of a new send with an image tells the screen too; without an image it does not', async () => {
    const onAttachmentNotReturned = vi.fn();
    const sendFn = vi.fn().mockRejectedValue(roleRefused());
    const { result } = renderPending(sendFn, {
      readRoleRefusal: readSendRoleRefusal,
      onRoleRefused: vi.fn(() => true),
      onAttachmentNotReturned,
    });
    act(() => result.current.sendOptimistic('plain', { cliToolId: 'claude' }));
    await flush();
    expect(onAttachmentNotReturned).not.toHaveBeenCalled();
    act(() => result.current.sendOptimistic('with image', { cliToolId: 'claude', imagePath: '.commandmate/attachments/b.png' }));
    await flush();
    expect(onAttachmentNotReturned).toHaveBeenCalledWith('.commandmate/attachments/b.png');
  });
});
