/**
 * Issue #4419: a `/sessions` tile's draft (the composer's text) belongs to the instance the tile
 * shows — `(worktree, instance)` — not to the worktree. With two instances of one worktree
 * (antigravity and claude), what is typed for one never shows in the other's composer, each keeps
 * its own, a send goes to the instance on screen, and a send refused because of its role (409,
 * #4385) comes back into the composer of the instance it was sent to.
 *
 * Positive control: red before #4419 (the tile's draft was stored under the worktree's split-0 key
 * and the composer kept its text across an instance switch, so the antigravity draft showed in the
 * claude composer; a late 409 went into whichever instance was on screen). Negative control: the
 * worktree screen's composer (no `draftScope`) still keeps its draft under the split key.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
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
import { MessageInput } from '@/components/worktree/MessageInput';
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { Worktree } from '@/types/models';

const AGY_DRAFT = 'only for antigravity';
const CLAUDE_DRAFT = 'only for claude';
const NOT_CONFIRMED = 'The role could not be confirmed for this session, so nothing was sent. Stop the session and start it again.';

function worktree(): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['antigravity', 'claude'],
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

const sendBodies: Array<Record<string, unknown>> = [];

function installFetch(send: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/worktrees/wt-1/send' && init?.method === 'POST') {
      sendBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return send();
    }
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    return json(200, {});
  }));
}

function renderTile() {
  const { container } = render(
    <ToastProvider>
      <SessionTile worktree={worktree()} enabled />
    </ToastProvider>,
  );
  const tile = within(container);
  const composer = () => within(tile.getByTestId('session-tile-composer-wt-1'));
  return {
    textarea: () => composer().getByTestId('message-input-textarea') as HTMLTextAreaElement,
    type: (value: string) => fireEvent.change(composer().getByTestId('message-input-textarea'), { target: { value } }),
    send: () => fireEvent.click(composer().getByRole('button', { name: /send message/i })),
    show: (instanceId: string) =>
      fireEvent.change(tile.getByTestId('session-tile-instance-wt-1'), { target: { value: instanceId } }),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  sendBodies.length = 0;
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  mockPane();
  installFetch(() => json(200, {}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('[#4419] a /sessions tile keeps one draft per instance', () => {
  it('switching the instance shows that instance\'s draft, never the other one\'s', async () => {
    const tile = renderTile();
    tile.type(AGY_DRAFT);
    tile.show('claude');
    expect(tile.textarea().value).toBe('');
    tile.type(CLAUDE_DRAFT);
    tile.show('antigravity');
    await waitFor(() => expect(tile.textarea().value).toBe(AGY_DRAFT));
    tile.show('claude');
    await waitFor(() => expect(tile.textarea().value).toBe(CLAUDE_DRAFT));
  });

  it('two tiles of the same worktree side by side: a draft typed on one never shows on the other', async () => {
    const agyTile = renderTile();
    agyTile.type(AGY_DRAFT);
    // Saved (debounced) before the second tile mounts and reads the storage.
    await waitFor(
      () => expect(Object.values({ ...window.localStorage })).toContain(AGY_DRAFT),
      { timeout: 2000 },
    );
    const claudeTile = renderTile();
    claudeTile.show('claude');
    expect(claudeTile.textarea().value).toBe('');
    claudeTile.type(CLAUDE_DRAFT);
    expect(agyTile.textarea().value).toBe(AGY_DRAFT);
    expect(claudeTile.textarea().value).toBe(CLAUDE_DRAFT);
  });

  it('a send goes to the instance on screen, and leaves the other instance\'s draft alone', async () => {
    const tile = renderTile();
    tile.type(AGY_DRAFT);
    tile.show('claude');
    tile.type(CLAUDE_DRAFT);
    tile.send();
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ content: CLAUDE_DRAFT, cliToolId: 'claude' });
    expect(sendBodies[0].instanceId === undefined || sendBodies[0].instanceId === 'claude').toBe(true);
    await waitFor(() => expect(tile.textarea().value).toBe(''));
    tile.show('antigravity');
    await waitFor(() => expect(tile.textarea().value).toBe(AGY_DRAFT));
  });

  it('a 409 role refusal that lands after an instance switch goes back to the instance it was sent to', async () => {
    let answer!: (r: Response) => void;
    installFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const tile = renderTile();
    tile.type(AGY_DRAFT);
    tile.send();
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ content: AGY_DRAFT, cliToolId: 'antigravity' });
    tile.show('claude');
    tile.type(CLAUDE_DRAFT);
    await act(async () => {
      answer(json(409, { error: 'refused', code: 'ROLE_LAUNCH_REFUSED', roleRefusal: 'not-confirmed', sendOutcome: 'not_sent' }));
    });
    // The toast still says why (the failed row is antigravity's, so the claude transcript hides it).
    await waitFor(() => expect(within(document.body).getByTestId('toast-container')).toHaveTextContent(NOT_CONFIRMED));
    expect(tile.textarea().value).toBe(CLAUDE_DRAFT);
    tile.show('antigravity');
    await waitFor(() => expect(tile.textarea().value).toBe(AGY_DRAFT));
  });

  it('a 409 on the instance still on screen comes back into that composer (as in #4385)', async () => {
    // 再指示 1: the answer is held until the send was made and the composer cleared, so the
    // check below can only pass by the text coming back (not by the draft not yet being sent).
    let answer!: (r: Response) => void;
    installFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const tile = renderTile();
    tile.show('claude');
    tile.type(CLAUDE_DRAFT);
    tile.send();
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0]).toMatchObject({ content: CLAUDE_DRAFT, cliToolId: 'claude' });
    await waitFor(() => expect(tile.textarea().value).toBe(''));
    await act(async () => {
      answer(json(409, { error: 'refused', code: 'ROLE_LAUNCH_REFUSED', roleRefusal: 'not-confirmed', sendOutcome: 'not_sent' }));
    });
    await waitFor(() => expect(within(document.body).getByTestId('toast-container')).toHaveTextContent(NOT_CONFIRMED));
    await waitFor(() => expect(tile.textarea().value).toBe(CLAUDE_DRAFT));
    tile.show('antigravity');
    await waitFor(() => expect(tile.textarea().value).toBe(''));
    tile.show('claude');
    await waitFor(() => expect(tile.textarea().value).toBe(CLAUDE_DRAFT));
  });

  it('a late 409 for an instance another tile is showing goes into that tile\'s composer and survives its next keystroke', async () => {
    let answer!: (r: Response) => void;
    installFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const sender = renderTile();
    const watcher = renderTile();
    sender.type(AGY_DRAFT);
    sender.send();
    await waitFor(() => expect(sendBodies).toHaveLength(1));
    sender.show('claude');
    watcher.type('watching');
    await act(async () => {
      answer(json(409, { error: 'refused', code: 'ROLE_LAUNCH_REFUSED', roleRefusal: 'not-confirmed', sendOutcome: 'not_sent' }));
    });
    await waitFor(() => expect(watcher.textarea().value).toBe(`watching\n\n${AGY_DRAFT}`));
    expect(sender.textarea().value).toBe('');
    watcher.type(`watching\n\n${AGY_DRAFT} more`);
    await waitFor(
      () =>
        expect(window.localStorage.getItem('commandmate:draft-message:wt-1:instance:antigravity')).toBe(
          `watching\n\n${AGY_DRAFT} more`,
        ),
      { timeout: 2000 },
    );
  });

  it('two tiles showing the same instance share its draft; the old split-0 draft shows on neither', async () => {
    window.localStorage.setItem('commandmate:draft-message:wt-1:0', 'typed before #4419');
    const first = renderTile();
    expect(first.textarea().value).toBe('');
    first.type(AGY_DRAFT);
    await waitFor(
      () => expect(window.localStorage.getItem('commandmate:draft-message:wt-1:instance:antigravity')).toBe(AGY_DRAFT),
      { timeout: 2000 },
    );
    const second = renderTile();
    expect(second.textarea().value).toBe(AGY_DRAFT);
    second.show('claude');
    expect(second.textarea().value).toBe('');
    // Left for the worktree screen's split 0, where it was typed.
    expect(window.localStorage.getItem('commandmate:draft-message:wt-1:0')).toBe('typed before #4419');
  });

  it('negative control: the worktree screen\'s composer keeps its draft under the split key', async () => {
    render(<MessageInput worktreeId="wt-1" cliToolId="antigravity" instanceId="antigravity" splitIndex={1} />);
    fireEvent.change(document.querySelector('[data-testid="message-input-textarea"]')!, { target: { value: AGY_DRAFT } });
    await waitFor(
      () => expect(window.localStorage.getItem('commandmate:draft-message:wt-1:1')).toBe(AGY_DRAFT),
      { timeout: 2000 },
    );
  });
});
