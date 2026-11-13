/**
 * Issue #4345 1c 再指示 1 (指摘 1): a send of the composer a worktree page draws starts only while
 * the page's registration (fixed at the press) may start — not once a 401 was taken, whatever the
 * preview's own 200 says (another entry's 200 recovers nothing).
 *
 * Positive controls (red before 再指示 1): (a) the preview is held, another entry's 401 is taken, the
 * preview answers 200 — nothing is sent and the draft stays; pressed while expired — no preview,
 * no send. Negative controls (green before and after): with no 401 the send goes once and the draft
 * is cleared; drawn outside any page (the sessions view) the registry's expiry does not stop it.
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
vi.mock('@/lib/handoff/screen-client', async () => vi.importActual('@/lib/handoff/screen-client'));

import { MessageInput } from '@/components/worktree/MessageInput';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { beginHandoffPageRequest, reportHandoffPageResponse, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { json, PAGE_WORKTREE as A, PageTree, sessionExpired, standInPage, type StandInPage } from '../../lib/handoff/page-owner-harness';

const NOT_SHOWN = { ok: true, show: false, attended: false };
let previews: number;
let sends: number;
let previewHeld: Array<() => void>;
let holdPreview: boolean;

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  window.localStorage.clear();
  previews = 0;
  sends = 0;
  previewHeld = [];
  holdPreview = false;
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/start-preview')) {
      previews += 1;
      if (holdPreview) await new Promise<void>((resolve) => previewHeld.push(resolve));
      return json(200, NOT_SHOWN);
    }
    if (url.endsWith('/send')) {
      sends += 1;
      return json(201, { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-11-14T00:00:00.000Z' });
    }
    return json(200, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  for (const release of previewHeld.splice(0)) release();
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const draft = () => (screen.getByTestId('message-input-textarea') as HTMLTextAreaElement).value;
const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));
function anotherEntryAnswers401(page: StandInPage): void {
  act(() => {
    reportHandoffPageResponse(beginHandoffPageRequest(page.registration), { status: 401 });
  });
}

describe.each([
  ['awaited (the phone)', false],
  ['optimistic (the PC split)', true],
] as const)('[#4345 1c 再指示 1] %s send', (_label, optimistic) => {
  const onOptimisticSend = vi.fn();
  const composer = () => (
    <MessageInput worktreeId={A} cliToolId="claude" onMessageSent={() => undefined} {...(optimistic ? { onOptimisticSend } : {})} />
  );
  const sent = () => (optimistic ? onOptimisticSend.mock.calls.length : sends);
  beforeEach(() => onOptimisticSend.mockClear());

  it('(a) preview held → another entry’s 401 → preview 200: nothing sent, the draft stays', async () => {
    const page = standInPage();
    render(<PageTree owner={page.owner}>{composer()}</PageTree>);
    holdPreview = true;
    typeMessage('hello');
    fireEvent.click(getSendButton());
    await waitFor(() => expect(previewHeld).toHaveLength(1));
    anotherEntryAnswers401(page);
    await act(async () => previewHeld.shift()!());
    await settle();
    expect(sessionExpired()).toBe(true);
    expect(sent()).toBe(0);
    expect(draft()).toBe('hello');
  });

  it('pressed while expired: no preview, nothing sent, the draft stays', async () => {
    const page = standInPage();
    render(<PageTree owner={page.owner}>{composer()}</PageTree>);
    anotherEntryAnswers401(page);
    typeMessage('hello');
    fireEvent.click(getSendButton());
    await settle();
    expect(previews).toBe(0);
    expect(sent()).toBe(0);
    expect(draft()).toBe('hello');
  });

  it('(negative control) no 401: sent once, the draft cleared', async () => {
    const page = standInPage();
    render(<PageTree owner={page.owner}>{composer()}</PageTree>);
    typeMessage('hello');
    fireEvent.click(getSendButton());
    await waitFor(() => expect(sent()).toBe(1));
    await waitFor(() => expect(draft()).toBe(''));
  });

  it('(negative control) outside any page: the registry’s expiry does not stop it', async () => {
    const page = standInPage();
    render(<PageTree owner={null}>{composer()}</PageTree>);
    anotherEntryAnswers401(page);
    typeMessage('hello');
    fireEvent.click(getSendButton());
    await waitFor(() => expect(sent()).toBe(1));
  });
});
