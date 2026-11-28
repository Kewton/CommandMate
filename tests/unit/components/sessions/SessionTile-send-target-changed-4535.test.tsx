/**
 * Issue #4535 段 2 §3.2・§3.3 T19b (INV-V2, S2-Q5 (b)) on the `/sessions` tile: the fence's 409
 * `SEND_TARGET_CHANGED` `not_sent` says why (the app's toast, naming the original target) and hands
 * the text back to the tile's composer on screen. While the tile's To is not the original target
 * (its `instanceId` and its `cliToolId`), one press does not send it to the new To: Enter POSTs
 * nothing and asks (naming both), cancelling POSTs nothing, confirming POSTs once to the current To.
 *
 * Positive control: the To still the original target — the text back, Enter sends at once.
 * `worktree-gone`: the text goes back nowhere. The harness is `SessionTile-role-refusal-4385`'s.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

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
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-1';
const TEXT = 'please review the diff';

interface Target {
  id: string;
  tool: CLIToolType;
}

function worktree(target: Target): Worktree {
  return {
    id: WT,
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    agentInstances: [{ id: target.id, cliTool: target.tool, alias: '', order: 0 }],
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

const posts: Array<Record<string, unknown>> = [];
let firstAnswer: ((response: Response) => void) | null = null;

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/worktrees/${WT}/send` && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (posts.length === 1) return new Promise<Response>((resolve) => (firstAnswer = resolve));
      return json(201, { id: `srv-${posts.length}`, role: 'user', content: TEXT, timestamp: new Date().toISOString() });
    }
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    return json(200, {});
  }));
}

function fenceBody(reason: string, original: Target) {
  return {
    error: 'The send target changed',
    code: 'SEND_TARGET_CHANGED',
    reason,
    target: { worktreeId: WT, instanceId: original.id, cliToolId: original.tool },
    current: null,
    requestId: 'r-1',
    sendOutcome: 'not_sent',
  };
}

const composer = () => within(screen.getByTestId(`session-tile-composer-${WT}`));
const textarea = () => composer().getByTestId('message-input-textarea') as HTMLTextAreaElement;
const pressEnter = () => fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
const toastText = () => screen.queryByTestId('toast-container')?.textContent ?? '';

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function Tile({ target }: { target: Target }) {
  return (
    <ToastProvider>
      <SessionTile worktree={worktree(target)} enabled />
    </ToastProvider>
  );
}

async function sendThenRefuse(original: Target, current: Target, reason: string) {
  const view = render(<Tile target={original} />);
  fireEvent.change(textarea(), { target: { value: TEXT } });
  pressEnter();
  await waitFor(() => expect(posts).toHaveLength(1));
  await waitFor(() => expect(textarea().value).toBe(''));
  view.rerender(<Tile target={current} />);
  await flush();
  await act(async () => firstAnswer?.(json(409, fenceBody(reason, original))));
  await flush(30);
}

beforeEach(() => {
  window.localStorage.clear();
  posts.length = 0;
  firstAnswer = null;
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  mockPane();
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('[#4535 T19b] the /sessions tile: the text back, and no one-press send to a changed To', () => {
  it.each<[string, Target, Target]>([
    ['target-gone', { id: 'codex-2', tool: 'codex' }, { id: 'claude', tool: 'claude' }],
    ['tool-changed', { id: 'agent-1', tool: 'codex' }, { id: 'agent-1', tool: 'claude' }],
  ])('%s: the reason and the original target in the toast; Enter asks, cancel and confirm', async (reason, original, current) => {
    await sendThenRefuse(original, current, reason);
    await waitFor(() => expect(textarea().value).toBe(TEXT));
    expect(toastText()).toContain(original.id);
    expect(toastText()).toContain('送っていません');

    pressEnter();
    await flush();
    expect(posts).toHaveLength(1);
    const confirm = await composer().findByTestId('message-input-retarget-confirm');
    expect(confirm.textContent).toContain(original.id);
    expect(confirm.textContent).toContain(original.tool);
    expect(confirm.textContent).toContain(current.id);
    expect(confirm.textContent).toContain(current.tool);

    fireEvent.click(composer().getByTestId('message-input-retarget-confirm-no'));
    await flush();
    expect(posts).toHaveLength(1);
    expect(textarea().value).toBe(TEXT);

    pressEnter();
    fireEvent.click(await composer().findByTestId('message-input-retarget-confirm-yes'));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toMatchObject({ content: TEXT, cliToolId: current.tool });
    await flush(30);
    expect(posts).toHaveLength(2);
  });

  it('(positive control) the To still the original target: the text back, Enter sends at once', async () => {
    const same: Target = { id: 'codex-2', tool: 'codex' };
    await sendThenRefuse(same, same, 'dispatch-changed');
    await waitFor(() => expect(textarea().value).toBe(TEXT));
    pressEnter();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(composer().queryByTestId('message-input-retarget-confirm')).toBeNull();
  });

  it('worktree-gone: the reason is said, the text goes back nowhere', async () => {
    await sendThenRefuse({ id: 'codex-2', tool: 'codex' }, { id: 'claude', tool: 'claude' }, 'worktree-gone');
    await waitFor(() => expect(toastText()).toContain('worktree が無くなりました'));
    expect(textarea().value).toBe('');
    // Issue #4604 S13: nothing went into the draft's one value.
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}:instance:codex-2:value`)).toBeNull();
    expect(window.localStorage.getItem(`commandmate:draft-message:${WT}:retarget-hold`)).toBeNull();
    expect(posts).toHaveLength(1);
  });
});
