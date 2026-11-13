/**
 * Issue #4345 1c: the composer a worktree page draws (`MessageInput`) reports its 401 through the
 * gateway under the page's registration holder (`HandoffPageOwnerContext`): the start-preview read
 * every plain send waits on (`fetchStartPreview`, its caller — 1b made the gateway's side), the
 * awaited send (`worktreeApi.sendMessage`) and the image upload (`worktreeApi.uploadImageFile`).
 * The optimistic send goes through `useOptimisticPaneMessages` (`page-owner-polls-auth-4345`).
 * Drawn beside the one host (see `page-owner-harness`).
 *
 * Positive controls are red before 1c (the composer handed no owner); the negative controls are
 * green before and after, and the send's existing error is still shown.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
// The real start-preview read (tests/setup.ts replaces it for the composer's other tests).
vi.mock('@/lib/handoff/screen-client', async () => vi.importActual('@/lib/handoff/screen-client'));

import { MessageInput } from '@/components/worktree/MessageInput';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { describeEntryCases, json, PAGE_WORKTREE as A, PageTree, standInPage, type EntryCase } from '../../lib/handoff/page-owner-harness';

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const composer = () => <MessageInput worktreeId={A} cliToolId="claude" onMessageSent={() => undefined} />;
const send = () => {
  typeMessage('hello');
  fireEvent.click(getSendButton());
};
const NOT_SHOWN = { ok: true, show: false, attended: false };

const CASES: Record<string, EntryCase> = {
  'start-preview read (MessageInput → fetchStartPreview)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/mem/start-preview`),
    ok: () => json(200, NOT_SHOWN),
    ui: composer,
    trigger: send,
  },
  'awaited send (MessageInput → worktreeApi.sendMessage)': {
    matches: (url, method) => url === `/api/worktrees/${A}/send` && method === 'POST',
    ok: () => json(201, { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-11-14T00:00:00.000Z' }),
    ui: composer,
    trigger: send,
  },
  'image upload (MessageInput → worktreeApi.uploadImageFile)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/upload/`),
    ok: () => json(201, { path: '.commandmate/attachments/a.png' }),
    ui: composer,
    trigger: () => {
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    },
  },
};

function fallback(url: string): Response {
  if (url.startsWith(`/api/worktrees/${A}/mem/start-preview`)) return json(200, NOT_SHOWN);
  return json(200, {});
}

describeEntryCases('the composer', CASES, fallback);

describe('[#4345 1c] (negative controls) the composer’s failure is shown as before', () => {
  it('the send’s 401 still shows its error and keeps the draft', async () => {
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/start-preview')) return json(200, NOT_SHOWN);
      if (url.endsWith('/send')) return json(401, { error: 'Unauthorized' });
      return json(200, {});
    }) as unknown as typeof fetch;
    const page = standInPage();
    render(<PageTree owner={page.owner}>{composer()}</PageTree>);
    send();
    await waitFor(() => expect(screen.getByText('Unauthorized')).toBeInTheDocument());
    expect((screen.getByTestId('message-input-textarea') as HTMLTextAreaElement).value).toBe('hello');
  });
});
