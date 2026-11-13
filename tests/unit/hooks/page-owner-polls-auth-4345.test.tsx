/**
 * Issue #4345 1c: the polls and the send the page's surfaces own report their 401 through the
 * gateway under the page's registration holder (`HandoffPageOwnerContext`): the pane's own
 * current-output poll (`useTerminalPanePolling`, the PC split and the phone), the split's History
 * poll (`useSplitMessages`), the optimistic send (`useOptimisticPaneMessages`) and the open file's
 * poll (`useFileContentPolling`). Drawn beside the one host (see `page-owner-harness`).
 *
 * Positive controls are red before 1c (nothing here reported); the negative controls are green
 * before and after.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import { useOptimisticPaneMessages } from '@/hooks/useOptimisticPaneMessages';
import { useFileContentPolling } from '@/hooks/useFileContentPolling';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import { HandoffPageOwnerContext } from '@/hooks/useHandoffPageOwner';
import type { FileTab } from '@/hooks/useFileTabs';
import type { ChatMessage } from '@/types/models';
import { describeEntryCases, json, PAGE_WORKTREE as A, standInPage, type EntryCase } from '../lib/handoff/page-owner-harness';

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

function PanePoll() {
  useTerminalPanePolling({ worktreeId: A, cliToolId: 'claude', instanceId: 'claude' });
  return null;
}
function SplitHistory() {
  useSplitMessages({ worktreeId: A, cliToolId: 'claude', instanceId: 'claude' });
  return null;
}
const NO_MESSAGES: ChatMessage[] = [];
let sendOptimistic: ((content: string) => void) | null = null;
function OptimisticSend() {
  const pending = useOptimisticPaneMessages({ worktreeId: A, serverMessages: NO_MESSAGES, onSent: () => undefined });
  sendOptimistic = (content) => pending.sendOptimistic(content, { cliToolId: 'claude' });
  return null;
}
const TAB: FileTab = {
  path: 'README.md',
  name: 'README.md',
  content: { path: 'README.md', content: '# a', extension: 'md', worktreePath: '/p' } as FileTab['content'],
  loading: false,
  error: null,
  isDirty: false,
};
function FilePoll() {
  useFileContentPolling({ tab: TAB, worktreeId: A, onLoadContent: () => undefined });
  return null;
}

const CASES: Record<string, EntryCase> = {
  'pane current-output (useTerminalPanePolling)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/current-output`),
    ok: () => json(200, { isRunning: false }),
    ui: () => <PanePoll />,
  },
  'split messages (useSplitMessages)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/messages`),
    ok: () => json(200, []),
    ui: () => <SplitHistory />,
  },
  'optimistic send (useOptimisticPaneMessages)': {
    matches: (url, method) => url === `/api/worktrees/${A}/send` && method === 'POST',
    ok: () => json(201, { id: 'm1', role: 'user', content: 'hi', timestamp: '2026-11-14T00:00:00.000Z' }),
    ui: () => <OptimisticSend />,
    trigger: () => act(() => sendOptimistic?.('hi')),
  },
  'open file poll (useFileContentPolling)': {
    matches: (url) => url.startsWith(`/api/worktrees/${A}/files/README.md`),
    ok: () => json(200, { path: 'README.md', content: '# b', extension: 'md' }),
    ui: () => <FilePoll />,
    trigger: () =>
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      }),
  },
};

describeEntryCases('the surfaces’ polls and the optimistic send', CASES, () => json(200, {}));

describe('[#4345 1c] (negative controls) the poll is the same request', () => {
  it('the pane poll calls fetch with the URL alone, under a page as outside one', async () => {
    const seen: unknown[][] = [];
    global.fetch = vi.fn(async (...args: unknown[]) => {
      seen.push(args);
      return json(200, { isRunning: false });
    }) as unknown as typeof fetch;
    const page = standInPage();
    render(
      <HandoffPageOwnerContext.Provider value={page.owner}>
        <PanePoll />
      </HandoffPageOwnerContext.Provider>,
    );
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const first = seen.find(([url]) => String(url).includes('/current-output'));
    expect(first).toEqual([`/api/worktrees/${A}/current-output?cliTool=claude&instance=claude`]);
    await act(async () => undefined);
  });
});
