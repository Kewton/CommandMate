/**
 * Issue #4606 (O-1, 設計書 §3.6, v3 §2.2): on a `/sessions` tile, after the send fence's 409
 * (`SEND_TARGET_CHANGED`, `not_sent`) the tile's To stayed the old one until its roster was read again
 * (11 s or more), and one Enter in between POSTed to the old target (target-gone: an ad-hoc launch of an
 * id no longer in the roster). Now the 409's original target (instance and tool) is held by the tile:
 * while the To is that pair, nothing is sent — Enter, [send], the brief's choice — and the composer
 * says it is reading the roster again (the text stays). The roster is asked for again (the provider's
 * `refresh()`, when there is one).
 *
 * When the hold goes (S-1, N-3 — decided in the render, never by `refresh()` settling):
 * - in a render of another `worktree` object (the roster read again) in which the held pair is not on
 *   the roster any more (target-gone, tool-changed): the tile shows the roster as it is;
 * - a render of another object that still has the pair (a roster read before the 409 landing late)
 *   keeps the hold; a second such render lets it go (the server's roster is then the truth — the
 *   fence answers the same 409 if it still applies).
 * - `refresh()` resolving with no new roster (it failed, or was overtaken) keeps the hold (INV-T2).
 *
 * F11: the optimistic road (the plain send); F12: the awaited road (the brief's choice); F13: no
 * provider (the tile alone) — `refresh` is not called, the hold works and the next roster lets it go.
 * Positive control: another instance of the same tile sends at once. Q2: the shown instance leaves
 * the roster and the tile falls back — its draft (text and tags) moves to the fallback's draft, which
 * asks before sending it.
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

const { useTerminalPanePollingMock, useSplitMessagesMock, fetchStartPreviewMock, provider } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  fetchStartPreviewMock: vi.fn(),
  provider: { value: null as null | { refresh: () => Promise<void> } },
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock }));
vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});
vi.mock('@/components/providers/WorktreesCacheProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/WorktreesCacheProvider')>();
  return { ...actual, useOptionalWorktreesCacheContext: () => provider.value };
});

import { SessionTile } from '@/components/sessions/SessionTile';
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import { getInstanceDraftKey } from '@/lib/drafts/message-draft';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-4606';
const TEXT = 'please review';
type Roster = Record<string, CLIToolType>;

function worktree(roster: Roster): Worktree {
  return {
    id: WT,
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    agentInstances: Object.entries(roster).map(([id, cliTool], order) => ({ id, cliTool, alias: '', order })),
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
const fenceBody = (reason: string, instanceId: string, cliToolId: string) => ({
  error: 'The send target changed', code: 'SEND_TARGET_CHANGED', reason,
  target: { worktreeId: WT, instanceId, cliToolId }, current: null, requestId: 'r-1', sendOutcome: 'not_sent',
});

const posts: Array<Record<string, unknown>> = [];
/** The answers the next POSTs get, in order (then 201). */
let answers: Array<() => Response> = [];
const NOT_SHOWN = { ok: true, show: false, attended: false };
const SHOWN = {
  ok: true, show: true, attended: true, injectOnStart: true, mode: 'on',
  boundary: { id: 'b-1', kind: 'launch' },
  preview: { open: { count: 1, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: [] }, lastUpdatedAt: null },
};
let previewShown = false;

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/worktrees/${WT}/send` && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      const next = answers.shift();
      if (next) return next();
      return json(201, { id: `srv-${posts.length}`, role: 'user', content: 'x', timestamp: new Date().toISOString() });
    }
    if (url.includes('/start-preview')) return json(200, previewShown ? SHOWN : NOT_SHOWN);
    return json(200, {});
  }));
}

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

let roster: Roster;
let current: Worktree;
let shownId: string | null;
let view: ReturnType<typeof render>;
const tree = () => (
  <ToastProvider>
    <SessionTile worktree={current} enabled instanceIds={shownId ? [shownId] : undefined} />
  </ToastProvider>
);
const scope = () => within(screen.getByTestId(`session-tile-composer-${WT}`));
const ta = () => scope().getByTestId('message-input-textarea') as HTMLTextAreaElement;
const notice = () => scope().queryByTestId('message-input-send-blocked');
/** The roster is read again: a new `worktree` object (as the page's poll or `refresh()` gives one). */
function readRoster(next: Roster) {
  roster = next;
  current = worktree(roster);
  view.rerender(tree());
}

beforeEach(() => {
  window.localStorage.clear();
  posts.length = 0;
  answers = [];
  previewShown = false;
  provider.value = null;
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  mockPane();
  installFetch();
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockImplementation(async () => (previewShown ? SHOWN : NOT_SHOWN));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** The tile shows codex-2; its send is answered by the fence's 409 on `road`; the roster is not read yet. */
async function arrange(reason: 'target-gone' | 'tool-changed', road: 'optimistic' | 'awaited', start: Roster = { 'codex-2': 'codex', claude: 'claude' }) {
  roster = start;
  current = worktree(roster);
  shownId = 'codex-2';
  view = render(tree());
  await waitFor(() => expect(ta()).toBeInTheDocument());
  fireEvent.change(ta(), { target: { value: TEXT } });
  await flush(30);
  answers.push(() => json(409, fenceBody(reason, 'codex-2', 'codex')));
  if (road === 'awaited') previewShown = true;
  fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
  if (road === 'awaited') {
    fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    previewShown = false;
  }
  await waitFor(() => expect(posts).toHaveLength(1));
  await flush(80);
  // The text is in the composer again (the optimistic road hands it back; the awaited one keeps it).
  await waitFor(() => expect(ta().value).toBe(TEXT));
}

async function enterOnce() {
  const before = posts.length;
  fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
  await flush(80);
  return posts.length - before;
}

describe.each<['optimistic' | 'awaited', string]>([
  ['optimistic', 'F11'],
  ['awaited', 'F12'],
])('[#4606 %s road, %s] after the fence\'s 409, before the roster is read again', (road) => {
  it.each<['target-gone' | 'tool-changed']>([['target-gone'], ['tool-changed']])('%s: Enter POSTs nothing, the composer says the roster is read again, the text stays', async (reason) => {
    await arrange(reason, road);
    expect(await enterOnce()).toBe(0);
    expect(notice()).toHaveTextContent('宛先が替わりました。名簿を読み直しています');
    expect(ta().value).toBe(TEXT);
    // [send] and the brief's choice too.
    fireEvent.click(scope().getByTestId('send-message-button'));
    await flush(50);
    expect(posts).toHaveLength(1);
  });

  it('target-gone: the roster read again without the instance — the tile shows the roster, nothing goes to the gone id', async () => {
    await arrange('target-gone', road);
    readRoster({ claude: 'claude' });
    await flush(30);
    expect(notice()).toBeNull();
    for (const post of posts.slice(1)) expect(post.instanceId).not.toBe('codex-2');
  });

  it('tool-changed: the roster read again with the new tool — the hold goes, the To is the new pair (and the tag asks)', async () => {
    await arrange('tool-changed', road);
    readRoster({ 'codex-2': 'claude', claude: 'claude' });
    await flush(30);
    expect(notice()).toBeNull();
    expect(await enterOnce()).toBe(0);
    expect(scope().queryByTestId('message-input-retarget-confirm')).not.toBeNull();
  });
});

describe('[#4606 S-1・N-3] when the hold goes', () => {
  it('S-1: a roster read before the 409 that lands late (another object, the pair still on it) keeps the hold; a second one lets it go', async () => {
    await arrange('tool-changed', 'optimistic');
    readRoster({ 'codex-2': 'codex', claude: 'claude' });
    await flush(30);
    expect(notice()).not.toBeNull();
    expect(await enterOnce()).toBe(0);
    readRoster({ 'codex-2': 'codex', claude: 'claude' });
    await flush(30);
    expect(notice()).toBeNull();
    // The server's roster says codex-2 is codex: the text's tag names it — it sends (the fence answers if not).
    expect(await enterOnce()).toBe(1);
  });

  it('N-3: `refresh()` is asked for, and its resolving with no new roster keeps the hold (INV-T2)', async () => {
    const refresh = vi.fn(async () => undefined);
    provider.value = { refresh };
    await arrange('target-gone', 'optimistic');
    expect(refresh).toHaveBeenCalled();
    await flush(30);
    // The same object re-rendered (a failed or overtaken read sets nothing).
    view.rerender(tree());
    await flush(30);
    expect(await enterOnce()).toBe(0);
    expect(notice()).not.toBeNull();
  });

  it('F13: no provider (the tile alone) — nothing to refresh, the hold works, and the next roster lets it go', async () => {
    await arrange('target-gone', 'optimistic');
    expect(await enterOnce()).toBe(0);
    readRoster({ claude: 'claude' });
    await flush(30);
    expect(notice()).toBeNull();
  });

  it('(positive control) another instance of the tile is not held: it sends at once', async () => {
    await arrange('target-gone', 'optimistic');
    shownId = 'claude';
    view.rerender(tree());
    await flush(30);
    fireEvent.change(ta(), { target: { value: 'for claude' } });
    await flush(30);
    expect(notice()).toBeNull();
    expect(await enterOnce()).toBe(1);
    expect(posts[posts.length - 1]).toEqual(expect.objectContaining({ content: 'for claude', cliToolId: 'claude' }));
  });

  it('(negative control) no 409: no hold, the send goes', async () => {
    roster = { 'codex-2': 'codex' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    fireEvent.change(ta(), { target: { value: TEXT } });
    await flush(30);
    expect(await enterOnce()).toBe(1);
    expect(notice()).toBeNull();
  });
});

describe('[#4606 Q2] the shown instance leaves the roster and the tile falls back', () => {
  it('its draft (the text and its tag) moves to the fallback\'s draft, after what was there; the fallback asks before sending it', async () => {
    window.localStorage.setItem(getInstanceDraftKey(WT, 'claude'), 'already for claude');
    await arrange('target-gone', 'optimistic');
    await flush(600);
    shownId = null;
    readRoster({ claude: 'claude' });
    await flush(50);
    expect(ta().value).toBe(`already for claude\n\n${TEXT}`);
    expect(window.localStorage.getItem(getInstanceDraftKey(WT, 'codex-2'))).toBeNull();
    expect(await enterOnce()).toBe(0);
    expect(scope().queryByTestId('message-input-retarget-confirm')).not.toBeNull();
  });

  it('(negative control) an instance switched away by the person is not moved', async () => {
    roster = { 'codex-2': 'codex', claude: 'claude' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    fireEvent.change(ta(), { target: { value: TEXT } });
    await flush(600);
    shownId = 'claude';
    view.rerender(tree());
    await flush(30);
    expect(ta().value).toBe('');
    expect(window.localStorage.getItem(getInstanceDraftKey(WT, 'codex-2'))).toBe(TEXT);
  });
});
