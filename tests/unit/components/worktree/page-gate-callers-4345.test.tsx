/**
 * Issue #4345 1c 再指示 2 (K1, T4): the send-family callers take "not sent"
 * (`HandoffPageOperationRefusedError`, the gate's refusal) as nothing happening — not as a failure.
 *
 * - The composer's awaited send refused at the gate (here, between the press's early check and the
 *   gate — the refusal handed back by the send itself): no error shown, the draft kept.
 * - The hand-off dialog's stop whose kill was not sent (`onStop` → `not-sent`): no observation
 *   recorded, no notice.
 * Negative controls (green before and after): a real failure of the send still shows its error; a
 * kill that was sent is observed.
 *
 * The optimistic layer's handling is `usePendingMessages-not-sent-4345`; the controller's (prompt
 * answer, kill) is `useWorktreeDetailController-page-entries-auth-4345`.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockCommandGroups, typeMessage, getSendButton } from '@tests/helpers/message-input-test-utils';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
    filteredGroups: mockCommandGroups,
    allCommands: mockCommandGroups.flatMap((g) => g.commands),
    loading: false,
    error: null,
    isCatalogStale: false,
  })),
}));
// The send's answer is the test's: "not sent" (the gate's refusal) or a real failure.
const { sendAnswer } = vi.hoisted(() => ({ sendAnswer: { next: null as null | (() => Promise<never>) } }));
vi.mock('@/lib/handoff/page-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/page-owner')>();
  return {
    ...actual,
    sendMessageForHandoffPage: (...args: Parameters<typeof actual.sendMessageForHandoffPage>) =>
      sendAnswer.next ? sendAnswer.next() : actual.sendMessageForHandoffPage(...args),
  };
});

import { MessageInput } from '@/components/worktree/MessageInput';
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { ApiError } from '@/lib/api-client';
import { beginHandoffOpening, patchHandoffOpening, resetHandoffStoreForTests, type SessionStopResult } from '@/lib/handoff/close-rule';
import {
  HandoffPageOperationRefusedError,
  publishHandoffPageView,
  registerHandoffPage,
  resetHandoffRegistryForTests,
} from '@/lib/handoff/page-registration';
import type { HandoffReadResponse } from '@/lib/handoff/types';
import { HANDOFF_READ_VIEW, json, PAGE_WORKTREE as A, PageTree, standInPage } from '../../lib/handoff/page-owner-harness';

let calls: string[];
beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  window.localStorage.clear();
  sendAnswer.next = null;
  calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    if (url.includes('/mem/mode')) return json(200, { ok: true, mode: 'on', features: { popup: true } });
    if (url.endsWith('/end')) return json(200, { ...REVIEWING, request: { ...REVIEWING.request, state: 'ending', endToken: 'tok' }, endToken: 'tok' });
    if (url.includes('/mem/handoff/requests/r1')) return json(200, REVIEWING);
    return json(200, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const REVIEWING = { ...HANDOFF_READ_VIEW, request: { ...HANDOFF_READ_VIEW.request, state: 'reviewing', agentDoneAt: '2026-11-10T00:01:00.000Z', version: 3 } };
const draft = () => (screen.getByTestId('message-input-textarea') as HTMLTextAreaElement).value;
const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));

describe('[#4345 1c 再指示 2] (T4) the composer: "not sent" is not a failure', () => {
  const composer = () => <MessageInput worktreeId={A} cliToolId="claude" onMessageSent={() => undefined} />;

  it('the awaited send refused at the gate: no error, the draft kept', async () => {
    sendAnswer.next = () => Promise.reject(new HandoffPageOperationRefusedError());
    const page = standInPage();
    render(<PageTree owner={page.owner}>{composer()}</PageTree>);
    typeMessage('hello');
    fireEvent.click(getSendButton());
    await settle();
    expect(draft()).toBe('hello');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/not sent|Not sent/);
  });

  it('(negative control) a real failure still shows its error', async () => {
    sendAnswer.next = () => Promise.reject(new ApiError('Upstream exploded', 500));
    const page = standInPage();
    render(<PageTree owner={page.owner}>{composer()}</PageTree>);
    typeMessage('hello');
    fireEvent.click(getSendButton());
    await waitFor(() => expect(screen.getByText('Upstream exploded')).toBeInTheDocument());
  });
});

describe('[#4345 1c 再指示 2] (T4) the hand-off dialog: a kill not sent is not observed', () => {
  function pageWithStop(result: SessionStopResult): void {
    const registration = registerHandoffPage(A);
    const target = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' } as const;
    publishHandoffPageView(registration, { target, onClose: () => undefined, onStop: async () => result });
    const own = beginHandoffOpening(A, target);
    patchHandoffOpening(own.token, { created: 'done', view: REVIEWING as unknown as HandoffReadResponse, text: 'the request text' });
  }

  it('onStop says not-sent: no observation, no notice', async () => {
    pageWithStop('not-sent');
    render(<HandoffDialogHost />);
    fireEvent.click(await screen.findByTestId('handoff-stop'));
    await settle();
    expect(calls.some((call) => call.endsWith('/end'))).toBe(true);
    expect(calls.some((call) => call.includes('/end/observe'))).toBe(false);
    expect(screen.queryByTestId('handoff-notice')).toBeNull();
  });

  it('(negative control) a kill that was sent is observed', async () => {
    pageWithStop('stopped');
    render(<HandoffDialogHost />);
    fireEvent.click(await screen.findByTestId('handoff-stop'));
    await waitFor(() => expect(calls.some((call) => call.includes('/end/observe'))).toBe(true));
  });
});
