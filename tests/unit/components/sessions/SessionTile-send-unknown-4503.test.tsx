/**
 * Issue #4503 (review 1, P1-1・P2-3・U-0): the `/sessions` tile's own wiring (`SessionTile` hands
 * `usePendingMessages` `isOutcomeUnknown` / `holdInFlightOnTimeout`): a send whose outcome is unknown
 * offers no ［再試行］, 「送り直す」 sends only after its confirmation, and ［ターミナルを確かめる］
 * switches the tile to its terminal. Positive control: a 400 still fails with a direct ［再試行］.
 *
 * Red with the wiring taken out of `SessionTile.tsx` (checked by hand, #4503 review 1).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import ja from '../../../../locales/ja/worktree.json';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
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
const JA = ja.conversation.sendUnknown;

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

let sendCalls = 0;
function installFetch(...answers: Array<() => Response>) {
  sendCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/worktrees/wt-1/send' && init?.method === 'POST') {
      const answer = answers[Math.min(sendCalls, answers.length - 1)];
      sendCalls += 1;
      return answer();
    }
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    return json(200, {});
  }));
}

const tile = () => within(screen.getByTestId('session-tile-wt-1'));
const textarea = () =>
  within(screen.getByTestId('session-tile-composer-wt-1')).getByTestId('message-input-textarea') as HTMLTextAreaElement;

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function sendFromTile() {
  render(
    <ToastProvider>
      <SessionTile worktree={worktree()} enabled />
    </ToastProvider>,
  );
  fireEvent.change(textarea(), { target: { value: BODY } });
  fireEvent.click(within(screen.getByTestId('session-tile-composer-wt-1')).getByRole('button', { name: /send message|送信/i }));
  await flush();
}

const created = () => json(201, { id: 'srv-1', worktreeId: 'wt-1', role: 'user', content: BODY, timestamp: new Date().toISOString() });

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

describe('[#4503 U-0] the /sessions tile and a send whose outcome is unknown', () => {
  it('500 sendOutcome:unknown: no ［再試行］, 「送り直す」 only after the confirmation', async () => {
    installFetch(() => json(500, { error: 'submit could not be confirmed', sendOutcome: 'unknown' }), created);
    await sendFromTile();
    await waitFor(() => expect(tile().getByTestId('chat-optimistic-unknown')).toHaveTextContent(JA.status));
    expect(tile().getByTestId('chat-optimistic-unknown-guidance')).toHaveTextContent(JA.guidance);
    expect(tile().queryByTestId('chat-pending-retry')).toBeNull();
    expect(sendCalls).toBe(1);
    // The composer holds nothing of it.
    expect(textarea().value).toBe('');

    fireEvent.click(tile().getByTestId('chat-pending-resend'));
    await flush();
    expect(sendCalls).toBe(1);
    await act(async () => {
      fireEvent.click(tile().getByTestId('chat-pending-resend-confirm-yes'));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(sendCalls).toBe(2);
  });

  it('［ターミナルを確かめる］ switches the tile to its terminal', async () => {
    installFetch(() => json(502, { error: 'Bad Gateway' }));
    await sendFromTile();
    await waitFor(() => expect(tile().getByTestId('chat-optimistic-unknown')).toBeInTheDocument());
    expect(screen.queryByTestId('session-tile-terminal-stack-wt-1')).toBeNull();
    fireEvent.click(tile().getByTestId('chat-pending-check-terminal'));
    await waitFor(() => expect(screen.getByTestId('session-tile-terminal-stack-wt-1')).toBeInTheDocument());
    expect(sendCalls).toBe(1);
  });

  it('(positive control) a 400 fails and ［再試行］ sends it again directly', async () => {
    installFetch(() => json(400, { error: 'content is required' }), created);
    await sendFromTile();
    await waitFor(() => expect(tile().getByTestId('chat-pending-retry')).toBeInTheDocument());
    expect(tile().queryByTestId('chat-optimistic-unknown')).toBeNull();
    fireEvent.click(tile().getByTestId('chat-pending-retry'));
    await flush();
    expect(sendCalls).toBe(2);
  });
});
