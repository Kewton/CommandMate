/**
 * Issue #4535 段 2 §3 (T19〜T21, INV-V1〜V4): the fence's 409 `SEND_TARGET_CHANGED` (#4534) on the
 * screen's optimistic send goes through the same road as the role refusal (#4385) — the reason is
 * said right away (the app's toast, which is still on screen after the To changed), and a `not_sent`
 * new send's text goes back to the composer once, with a hold: while the composer's To is not the
 * original target (`instanceId` and `cliToolId`), the composer asks before sending it (T19b).
 *
 * Driven through `useOptimisticPaneMessages` (the PC split's and the phone's wiring), with the real
 * ja dictionary so the sentences are asserted as written. The send is `worktreeApi.sendMessage`.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, screen, waitFor, cleanup } from '@testing-library/react';
import type { ConnectivityState } from '@/hooks/useConnectivity';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

vi.mock('@/hooks/useConnectivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useConnectivity')>();
  const online = {
    status: 'online', isOnline: true, isReconnecting: false, isOffline: false, shouldSurface: false,
    signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
    lastReachableAt: 1, recheck: () => undefined,
  } as ConnectivityState;
  return { ...actual, useConnectivity: () => online };
});

const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock } };
});

import { ApiError } from '@/lib/api-client';
import { useOptimisticPaneMessages } from '@/hooks/useOptimisticPaneMessages';
import { ToastProvider } from '@/components/common/Toast';
import { findRetargetHolds, holdRetargetedText } from '@/lib/drafts/message-draft';

const WT = 'wt-4535';
const TEXT = 'please look at the diff';
const HOLD_KEY = `commandmate:draft-message:${WT}:retarget-hold`;
const LOCALES = path.resolve(__dirname, '../../../locales');

function fence(reason: string, sendOutcome: 'not_sent' | 'unknown', instanceId = 'codex-2', cliToolId = 'codex') {
  return new ApiError('The send target changed', 409, {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason,
    target: { worktreeId: WT, instanceId, cliToolId },
    current: null,
    requestId: 'r-1',
    sendOutcome,
  });
}

function renderPane(onNotSent = vi.fn()) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ToastProvider>{children}</ToastProvider>
  );
  const hook = renderHook(
    () => useOptimisticPaneMessages({ worktreeId: WT, serverMessages: [], onSent: () => undefined, onNotSent }),
    { wrapper },
  );
  return { ...hook, onNotSent };
}

const toastText = () => screen.queryByTestId('toast-container')?.textContent ?? '';

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function load(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, locale, 'worktree.json'), 'utf-8'));
}
function resolveKey(dict: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

beforeEach(() => {
  window.localStorage.clear();
  sendMessageMock.mockReset();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('[#4535 T19〜T21] the fence 409 on the optimistic send', () => {
  it('409 SEND_TARGET_CHANGED not_sent (target-gone) — a toast with the reason and the old target, the text back in the composer once', async () => {
    sendMessageMock.mockRejectedValue(fence('target-gone', 'not_sent'));
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(toastText()).toContain('送り先の instance が名簿から外れました'));
    expect(toastText()).toContain('codex-2');
    expect(toastText()).toContain('送っていません');
    expect(onNotSent).toHaveBeenCalledTimes(1);
    expect(onNotSent).toHaveBeenCalledWith(TEXT);
    // The row fails (it is not dropped) and a discard does not hand the text back a second time.
    expect(result.current.messages[0].optimisticState).toBe('error');
    let discarded: string | undefined = 'x';
    act(() => {
      discarded = result.current.discard(result.current.pending[0].tempId);
    });
    expect(discarded).toBeUndefined();
    // The hold names the original target, both halves (T19b reads it at the composer).
    expect(JSON.parse(window.localStorage.getItem(HOLD_KEY) ?? '[]')).toEqual([
      { text: TEXT, instanceId: 'codex-2', cliToolId: 'codex' },
    ]);
    // Nothing was sent again on its own (INV-V2).
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('a late 409 after a retry does not hand the text back again', async () => {
    const answers: Array<(e: unknown) => void> = [];
    sendMessageMock.mockImplementation(() => new Promise((_resolve, reject) => answers.push(reject)));
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    // Retried while the first attempt is still on its way.
    act(() => result.current.retry(result.current.pending[0].tempId));
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    // The first attempt's 409 arrives late: it answers an older attempt and changes nothing.
    await act(async () => answers[0](fence('target-gone', 'not_sent')));
    await flush();
    expect(onNotSent).not.toHaveBeenCalled();
    // The retry's own 409: not the first attempt, so the text is not handed back either.
    await act(async () => answers[1](fence('target-gone', 'not_sent')));
    await flush();
    expect(onNotSent).not.toHaveBeenCalled();
    expect(result.current.messages[0].optimisticState).toBe('error');
    // The discard hands it back (it never went back), once.
    let discarded: string | undefined;
    act(() => {
      discarded = result.current.discard(result.current.pending[0].tempId);
    });
    expect(discarded).toBe(TEXT);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('409 SEND_TARGET_CHANGED unknown — no text back, no "not sent", the row is unknown', async () => {
    sendMessageMock.mockRejectedValue(fence('dispatch-changed', 'unknown'));
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(toastText()).toContain('届いたかどうか分かりません'));
    expect(toastText()).toContain('送り先の起動の仕方が替わりました');
    expect(toastText()).toContain('codex-2');
    expect(toastText()).not.toContain('送っていません');
    expect(onNotSent).not.toHaveBeenCalled();
    expect(result.current.messages[0].optimisticState).toBe('unknown');
    expect(window.localStorage.getItem(HOLD_KEY)).toBeNull();
    let discarded: string | undefined = 'x';
    act(() => {
      discarded = result.current.discard(result.current.pending[0].tempId);
    });
    expect(discarded).toBeUndefined();
  });

  it('(positive control) an unreadable target is not said to have changed', async () => {
    sendMessageMock.mockRejectedValue(fence('unreadable', 'unknown'));
    const { result } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(toastText()).toContain('送り先を確かめられませんでした'));
    expect(toastText()).not.toContain('替わりました');
  });

  it('worktree-gone: the reason is said, the text goes nowhere (no composer, no hold)', async () => {
    sendMessageMock.mockRejectedValue(fence('worktree-gone', 'not_sent'));
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(toastText()).toContain('worktree が無くなりました'));
    expect(onNotSent).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(HOLD_KEY)).toBeNull();
    expect(result.current.messages[0].optimisticState).toBe('error');
  });

  it('(INV-V4 control) a 409 PROMPT_WAITING not_sent stays a plain failure: no toast, no text back', async () => {
    sendMessageMock.mockRejectedValue(
      new ApiError('prompt waiting', 409, { error: 'prompt waiting', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' }),
    );
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush(30);
    expect(result.current.messages[0].optimisticState).toBe('error');
    expect(toastText()).toBe('');
    expect(onNotSent).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(HOLD_KEY)).toBeNull();
  });
});

describe('[#4535 T19] the sentences are in ja and en', () => {
  const KEYS = [
    'conversation.sendTargetChanged.reason.worktreeGone',
    'conversation.sendTargetChanged.reason.targetGone',
    'conversation.sendTargetChanged.reason.toolChanged',
    'conversation.sendTargetChanged.reason.dispatchChanged',
    'conversation.sendTargetChanged.reason.unreadable',
    'conversation.sendTargetChanged.reason.other',
    'conversation.sendTargetChanged.notSent',
    'conversation.sendTargetChanged.textReturned',
    'conversation.sendTargetChanged.unknown',
    'conversation.sendTargetChanged.retargetConfirm',
    'conversation.sendTargetChanged.retargetConfirmYes',
    'conversation.sendTargetChanged.retargetConfirmNo',
  ];
  const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();

  it.each(KEYS)('%s is in ja and en with the same placeholders', (key) => {
    const ja = resolveKey(load('ja'), key);
    const en = resolveKey(load('en'), key);
    expect(ja).toBeTypeOf('string');
    expect(en).toBeTypeOf('string');
    expect(placeholders(ja as string)).toEqual(placeholders(en as string));
  });

  it('the unknown sentence never says "not sent", and unreadable never says "changed"', () => {
    for (const locale of ['ja', 'en']) {
      const dict = load(locale);
      const unknown = resolveKey(dict, 'conversation.sendTargetChanged.unknown') as string;
      const unreadable = resolveKey(dict, 'conversation.sendTargetChanged.reason.unreadable') as string;
      expect(unknown).not.toMatch(/送っていません|not sent/i);
      expect(unreadable).not.toMatch(/替わりました|changed/i);
    }
  });
});

/**
 * Issue #4535 r5 (review H2・H4・P3 exact match): the text a fence refusal did not hand back goes to
 * the composer on a discard only with its hold (never without its original target), and a hold that
 * cannot be written keeps the text out of the composer (fail-closed).
 */
describe('[#4535 T19b r5] the discard, a hold that cannot be written, and the hold\'s match', () => {
  function fenceWithoutTarget() {
    return new ApiError('The send target changed', 409, {
      error: 'The send target changed',
      code: 'SEND_TARGET_CHANGED',
      reason: 'target-gone',
      target: null,
      current: null,
      requestId: 'r-1',
      sendOutcome: 'not_sent',
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('H2: a retry\'s 409 not_sent, then the discard: the text goes back with the hold of its original target', async () => {
    const answers: Array<(e: unknown) => void> = [];
    sendMessageMock.mockImplementation(() => new Promise((_resolve, reject) => answers.push(reject)));
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await act(async () =>
      answers[0](new ApiError('prompt waiting', 409, { error: 'prompt waiting', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' })),
    );
    await flush();
    act(() => result.current.retry(result.current.pending[0].tempId));
    await act(async () => answers[1](fence('target-gone', 'not_sent')));
    await flush();
    expect(onNotSent).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(HOLD_KEY)).toBeNull();
    let discarded: string | undefined;
    act(() => {
      discarded = result.current.discard(result.current.pending[0].tempId);
    });
    expect(discarded).toBe(TEXT);
    expect(JSON.parse(window.localStorage.getItem(HOLD_KEY) ?? '[]')).toEqual([
      { text: TEXT, instanceId: 'codex-2', cliToolId: 'codex' },
    ]);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('H2: a 409 not_sent that does not name its target — not handed back, and not on the discard either', async () => {
    sendMessageMock.mockRejectedValue(fenceWithoutTarget());
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(result.current.messages[0].optimisticState).toBe('error'));
    expect(onNotSent).not.toHaveBeenCalled();
    let discarded: string | undefined = 'x';
    act(() => {
      discarded = result.current.discard(result.current.pending[0].tempId);
    });
    expect(discarded).toBeUndefined();
    expect(window.localStorage.getItem(HOLD_KEY)).toBeNull();
  });

  it('H2: worktree-gone — the discard does not hand the text back', async () => {
    sendMessageMock.mockRejectedValue(fence('worktree-gone', 'not_sent'));
    const { result } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(result.current.messages[0].optimisticState).toBe('error'));
    let discarded: string | undefined = 'x';
    act(() => {
      discarded = result.current.discard(result.current.pending[0].tempId);
    });
    expect(discarded).toBeUndefined();
  });

  it('H4: the hold cannot be written (localStorage throws) — the text is not handed back, and the toast says so', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    sendMessageMock.mockRejectedValue(fence('target-gone', 'not_sent'));
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(toastText()).toContain('送っていません'));
    expect(onNotSent).not.toHaveBeenCalled();
    expect(toastText()).toContain('本文を入力欄に戻せませんでした');
    // Nor on the discard: the hold still cannot be written.
    let discarded: string | undefined = 'x';
    act(() => {
      discarded = result.current.discard(result.current.pending[0].tempId);
    });
    expect(discarded).toBeUndefined();
  });

  it('(negative control) the hold written: the text is handed back as before', async () => {
    sendMessageMock.mockRejectedValue(fence('target-gone', 'not_sent'));
    const { result, onNotSent } = renderPane();
    act(() => result.current.sendOptimistic(TEXT, { cliToolId: 'codex', instanceId: 'codex-2' }));
    await flush();
    await waitFor(() => expect(onNotSent).toHaveBeenCalledWith(TEXT));
    expect(toastText()).not.toContain('本文を入力欄に戻せませんでした');
  });

  // Issue #4535 r6 (INV-V2 rewritten, PM's disposition): any draft that holds the text matches — the
  // safe side (an extra question is accepted, a send to a changed To is not).
  it('a hold matches any draft that holds its text (INV-V2 r6)', () => {
    holdRetargetedText(WT, { text: 'ok', instanceId: 'codex-2', cliToolId: 'codex' });
    expect(findRetargetHolds(WT, 'ok')).toHaveLength(1);
    expect(findRetargetHolds(WT, 'ok, then look at the diff')).toHaveLength(1);
    expect(findRetargetHolds(WT, 'not ok')).toHaveLength(1);
    expect(findRetargetHolds(WT, 'fine')).toEqual([]);
  });

  it('conversation.sendTargetChanged.textNotReturned is in ja and en', () => {
    for (const locale of ['ja', 'en']) {
      expect(resolveKey(load(locale), 'conversation.sendTargetChanged.textNotReturned')).toBeTypeOf('string');
    }
  });
});
