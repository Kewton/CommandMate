/**
 * Issue #4385 (A4 再指示 1): a send from a `/sessions` tile that the server refuses because of the
 * role (409 `roleRefusal`, nothing typed) is handled as on the worktree screen — the shared
 * `useRoleRefusalNotice`: the app's toast says why, the tile's history row carries the reason
 * under "Failed to send", and the body goes back to the tile's composer.
 *
 * Positive control: red before 再指示 1 (the tile handed `usePendingMessages` no
 * `readRoleRefusal`: the row said only "Failed to send", no toast, an empty composer). Negative
 * control: a 500 is a plain failure as before.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock }));

import { SessionTile } from '@/components/sessions/SessionTile';
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { Worktree } from '@/types/models';

const BODY = 'please review the diff';
const NOT_CONFIRMED = 'The role could not be confirmed for this session, so nothing was sent. Stop the session and start it again.';

function worktree(): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['antigravity'],
  } as Worktree;
}

function mockPane() {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: true, isThinking: false, sessionStatus: 'ready',
      isSelectionListActive: false, isPagerActive: false, isDismissablePanelActive: false,
      isUnclassifiedActive: false, composerText: '', agentMode: 'unknown', startingSince: null,
      attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(), setPromptAnswering: vi.fn(), clearPrompt: vi.fn(), refresh: vi.fn(),
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function installFetch(send: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/worktrees/wt-1/send' && init?.method === 'POST') return send();
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    return json(200, {});
  }));
}

const textarea = () =>
  within(screen.getByTestId('session-tile-composer-wt-1')).getByTestId('message-input-textarea') as HTMLTextAreaElement;

async function sendFromTile() {
  render(
    <ToastProvider>
      <SessionTile worktree={worktree()} enabled />
    </ToastProvider>,
  );
  fireEvent.change(textarea(), { target: { value: BODY } });
  fireEvent.click(within(screen.getByTestId('session-tile-composer-wt-1')).getByRole('button', { name: /send message/i }));
  await waitFor(() => expect(screen.getByText('Failed to send')).toBeInTheDocument());
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  mockPane();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[#4385 A4 再指示 1] the /sessions tile and a role refusal', () => {
  it('says why (toast and the history row) and gives the body back to the composer', async () => {
    installFetch(() =>
      json(409, { error: 'refused', code: 'ROLE_LAUNCH_REFUSED', roleRefusal: 'not-confirmed', sendOutcome: 'not_sent' }),
    );
    await sendFromTile();
    await waitFor(() => expect(screen.getByTestId('toast-container')).toHaveTextContent(NOT_CONFIRMED));
    expect(screen.getByTestId('chat-optimistic-error-reason')).toHaveTextContent(NOT_CONFIRMED);
    await waitFor(() => expect(textarea().value).toBe(BODY));
  });

  // Issue #4503 review 2 (PM: D4): a 500 with no sendOutcome is unknown, not a plain failure. The
  // negative control's core stays: no role reason, the composer is not refilled.
  it('negative control: a 500 is unknown (no direct retry) — no reason, the composer is not refilled', async () => {
    installFetch(() => json(500, { error: 'Internal failure' }));
    render(
      <ToastProvider>
        <SessionTile worktree={worktree()} enabled />
      </ToastProvider>,
    );
    fireEvent.change(textarea(), { target: { value: BODY } });
    fireEvent.click(within(screen.getByTestId('session-tile-composer-wt-1')).getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(screen.getByTestId('chat-optimistic-unknown')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-pending-retry')).toBeNull();
    expect(screen.queryByTestId('chat-optimistic-error-reason')).toBeNull();
    expect(textarea().value).toBe('');
  });
});
