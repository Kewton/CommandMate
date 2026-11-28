/**
 * Issue #4603 (T3, design `send-outcome-4535.md` §2.2 D4): a send whose 2xx answer is not a
 * ChatMessage (`201 {}`) is "nobody knows whether it arrived" on the screen, as on the CLI — not a
 * send that went through.
 *
 * Driven through the real `worktreeApi.sendMessage` with `fetch` stubbed (and the session-brief
 * preview answered, as `tests/setup.ts` does for jsdom), so the reading under
 * test is `src/lib/api-client.ts`'s, as each surface receives it:
 *  - the composer's awaited sends (the plain send, and the send of the session-brief choice): the
 *    draft stays and the composer says it is not known whether it arrived (`markSendUnknown`);
 *  - the `/sessions` tile's optimistic send: the row is unknown, not waiting for its echo.
 * Red before #4603: the send resolved on `{}`, the draft was cleared and the row went on waiting.
 * Negative control: a ChatMessage 201 still clears the draft / leaves the row waiting for its echo.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { createDefaultProps, getTextarea, typeMessage } from '@tests/helpers/message-input-test-utils';
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
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const { useTerminalPanePollingMock, useSplitMessagesMock, fetchStartPreviewMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  fetchStartPreviewMock: vi.fn(),
}));
// The session-brief preview (`tests/setup.ts` replaces it for jsdom; this file says what it answers).
vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock }));

import { MessageInput } from '@/components/worktree/MessageInput';
import { SessionTile } from '@/components/sessions/SessionTile';
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { Worktree } from '@/types/models';

const BODY = 'hello agent';
const JA = ja.conversation.sendUnknown;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** D4: a 201 whose JSON is not a ChatMessage. */
const notAMessage = () => json(201, {});
/** S1: the route's ChatMessage. */
const created = () => json(201, { id: 'srv-1', worktreeId: 'wt-1', role: 'user', content: BODY, timestamp: new Date().toISOString() });

const NOT_SHOWN = { ok: true, show: false, attended: false };
const SHOWN = {
  ok: true,
  show: true,
  attended: true,
  injectOnStart: true,
  mode: 'on',
  boundary: { id: 'b-1', kind: 'launch' },
  preview: { open: { count: 1, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: [] }, lastUpdatedAt: null },
};

let sendCalls = 0;
function installFetch(answer: () => Response, preview: unknown = NOT_SHOWN) {
  sendCalls = 0;
  fetchStartPreviewMock.mockResolvedValue(preview);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/worktrees/wt-1/send' && init?.method === 'POST') {
      sendCalls += 1;
      return answer();
    }
    return json(200, {});
  }));
}

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
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

function renderComposer() {
  const props = createDefaultProps({ worktreeId: 'wt-1', cliToolId: 'antigravity', isSessionRunning: true });
  render(<MessageInput {...props} />);
  return props;
}

async function submit() {
  await act(async () => {
    fireEvent.submit(getTextarea().closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('[#4603 T3] the composer\'s awaited sends on a 2xx that is not a ChatMessage', () => {
  it('the plain send, 201 {}: the draft stays and the composer says it is not known whether it arrived', async () => {
    installFetch(notAMessage);
    const props = renderComposer();
    typeMessage(BODY);
    await submit();
    await waitFor(() => expect(sendCalls).toBe(1));
    await flush();
    expect(getTextarea().value).toBe(BODY);
    expect(screen.getByTestId('message-input-send-unknown')).toHaveTextContent(JA.status);
    expect(props.onMessageSent).not.toHaveBeenCalled();
  });

  it('the brief-choice send, 201 {}: the dialog closes, the draft stays, the composer says unknown', async () => {
    installFetch(notAMessage, SHOWN);
    renderComposer();
    typeMessage(BODY);
    await submit();
    fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    await waitFor(() => expect(sendCalls).toBe(1));
    await waitFor(() => expect(screen.getByTestId('message-input-send-unknown')).toHaveTextContent(JA.status));
    expect(screen.queryByTestId('session-start-brief-dialog')).toBeNull();
    expect(getTextarea().value).toBe(BODY);
  });

  it('(negative control) the plain send, 201 ChatMessage: the draft is cleared, nothing unknown', async () => {
    installFetch(created);
    const props = renderComposer();
    typeMessage(BODY);
    await submit();
    await waitFor(() => expect(sendCalls).toBe(1));
    await waitFor(() => expect(getTextarea().value).toBe(''));
    expect(screen.queryByTestId('message-input-send-unknown')).toBeNull();
    expect(props.onMessageSent).toHaveBeenCalled();
  });
});

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

const tile = () => within(screen.getByTestId('session-tile-wt-1'));
const tileTextarea = () =>
  within(screen.getByTestId('session-tile-composer-wt-1')).getByTestId('message-input-textarea') as HTMLTextAreaElement;

async function sendFromTile() {
  render(
    <ToastProvider>
      <SessionTile worktree={worktree()} enabled />
    </ToastProvider>,
  );
  fireEvent.change(tileTextarea(), { target: { value: BODY } });
  fireEvent.click(within(screen.getByTestId('session-tile-composer-wt-1')).getByRole('button', { name: /send message|送信/i }));
  await flush();
}

describe('[#4603 T3] the /sessions tile\'s optimistic send on a 2xx that is not a ChatMessage', () => {
  it('201 {}: the row is unknown (no ［再試行］), not waiting for its echo', async () => {
    installFetch(notAMessage);
    await sendFromTile();
    await waitFor(() => expect(tile().getByTestId('chat-optimistic-unknown')).toHaveTextContent(JA.status));
    expect(tile().queryByTestId('chat-pending-retry')).toBeNull();
    expect(tile().queryByTestId('chat-optimistic-sending')).toBeNull();
    expect(sendCalls).toBe(1);
  });

  it('(negative control) 201 ChatMessage: the row waits for its echo, nothing unknown', async () => {
    installFetch(created);
    await sendFromTile();
    await waitFor(() => expect(tile().getByTestId('chat-optimistic-sending')).toBeInTheDocument());
    expect(tile().queryByTestId('chat-optimistic-unknown')).toBeNull();
    expect(sendCalls).toBe(1);
  });
});
