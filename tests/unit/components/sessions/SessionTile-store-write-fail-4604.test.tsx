/**
 * Issue #4604 (a P2-2, the steps of #4604 comment 7162107549): two `/sessions` tiles showing the same
 * instance (one draft key). Tile 1 types `hello`; tile 2 shows the same instance; then the draft's
 * `:retarget` `setItem` throws (a full store: a long value only; or always); tile 1's brief choice is
 * stopped by the send fence (409 `tool-changed`, `not_sent`) — its tag cannot be stored as a list.
 * The roster is read again; tile 2's Enter once must POST nothing and ask (develop: POST once, no
 * question, `{"content":"hello","cliToolId":"claude","instanceId":"codex-2"}`). Tiles of one page share
 * this page's mark (two tiles stand for two composers of a draft; on screen another composer of the
 * same draft is another tab — `MessageInput-store-write-fail-4604` records that column).
 *
 * Negative control: the store works — tile 2 asks too (#4607), and with no 409 it POSTs at once.
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

const { useTerminalPanePollingMock, useSplitMessagesMock, fetchStartPreviewMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  fetchStartPreviewMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock }));
vi.mock('@/lib/handoff/screen-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/screen-client')>();
  return { ...actual, fetchStartPreview: fetchStartPreviewMock };
});

import { SessionTile } from '@/components/sessions/SessionTile';
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import { getInstanceDraftKey } from '@/lib/drafts/message-draft';
import { installStoreFaults, isRetargetKey, releasePageMarks, type StoreFaultRule } from '@tests/helpers/draft-store-fault-4604';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-4604-tile';
const TEXT = 'hello';
const I1 = { id: 'codex-2', tool: 'codex' as CLIToolType };

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

const posts: Array<Record<string, unknown>> = [];
/** While set, a POST waits for its answer here; otherwise it is created at once. */
let holdAnswers = true;
const answers: Array<(response: Response) => void> = [];

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
      if (holdAnswers) return new Promise<Response>((resolve) => answers.push(resolve));
      answers.push(() => undefined);
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
let shown: Record<'A' | 'B', string>;
let view: ReturnType<typeof render>;
const tree = () => (
  <ToastProvider>
    {(['A', 'B'] as const).map((name) => (
      <div key={name} data-testid={`tile-${name}`}>
        <SessionTile worktree={worktree(roster)} enabled instanceIds={[shown[name]]} />
      </div>
    ))}
  </ToastProvider>
);
const tile = (n: 'A' | 'B') => within(screen.getByTestId(`tile-${n}`));
const scope = (n: 'A' | 'B') => within(tile(n).getByTestId(`session-tile-composer-${WT}`));
const ta = (n: 'A' | 'B') => scope(n).getByTestId('message-input-textarea') as HTMLTextAreaElement;

beforeEach(() => {
  window.localStorage.clear();
  posts.length = 0;
  answers.length = 0;
  holdAnswers = true;
  previewShown = false;
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
  vi.restoreAllMocks();
  releasePageMarks([getInstanceDraftKey(WT, I1.id)]);
  window.localStorage.clear();
});

/**
 * Both tiles show i1 with `hello`; tile 1's brief-choice send is answered by `refusal` (a 409 body)
 * or, with null, not sent at all; then the roster becomes `after`.
 */
async function arrange(refusal: string | null, after: Roster, rules: StoreFaultRule[] = []) {
  roster = { 'codex-2': 'codex', claude: 'claude' };
  shown = { A: 'codex-2', B: 'claude' };
  view = render(tree());
  await waitFor(() => expect(ta('A')).toBeInTheDocument());
  fireEvent.change(ta('A'), { target: { value: TEXT } });
  await flush(600);
  expect(window.localStorage.getItem(getInstanceDraftKey(WT, I1.id))).toBe(TEXT);
  shown = { ...shown, B: 'codex-2' };
  view.rerender(tree());
  await flush(30);
  await waitFor(() => expect(ta('B').value).toBe(TEXT));
  const faults = installStoreFaults(rules);
  if (refusal !== null) {
    previewShown = true;
    const k = posts.length;
    fireEvent.keyDown(ta('A'), { key: 'Enter', code: 'Enter' });
    fireEvent.click(await screen.findByTestId('session-start-brief-decline'));
    await waitFor(() => expect(posts).toHaveLength(k + 1));
    previewShown = false;
    await act(async () => answers[k](json(409, {
      error: 'The send target changed', code: 'SEND_TARGET_CHANGED', reason: refusal,
      target: { worktreeId: WT, instanceId: I1.id, cliToolId: I1.tool }, current: null, requestId: 'r-1', sendOutcome: 'not_sent',
    })));
    await flush(50);
    expect(ta('A').value).toBe(TEXT);
  }
  faults.restore();
  roster = after;
  view.rerender(tree());
  await flush(30);
  holdAnswers = false;
}

const AFTER: Roster = { 'codex-2': 'claude', claude: 'claude' };

describe.each<[string, StoreFaultRule[]]>([
  ['a full store (a long :retarget value throws)', [{ method: 'setItem', key: isRetargetKey, overBytes: 60 }]],
  ['every :retarget setItem throws', [{ method: 'setItem', key: isRetargetKey }]],
])('[#4604 a P2-2] two tiles, one draft key, the tag cannot be stored: %s', (_name, rules) => {
  it('tile 2: Enter once POSTs nothing and asks; yes POSTs once to this To', async () => {
    await arrange('tool-changed', AFTER, rules);
    const before = posts.length;
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    expect(scope('B').queryByTestId('message-input-retarget-confirm')).not.toBeNull();
    expect(ta('B').value).toBe(TEXT);
    fireEvent.click(scope('B').getByTestId('message-input-retarget-confirm-yes'));
    await waitFor(() => expect(posts.length - before).toBe(1));
    await flush(50);
    expect(posts.length - before).toBe(1);
    expect(posts[before]).toEqual(expect.objectContaining({ content: TEXT, cliToolId: 'claude', instanceId: 'codex-2' }));
  });

  it('(control) tile 1: Enter once POSTs nothing and asks', async () => {
    await arrange('tool-changed', AFTER, rules);
    const before = posts.length;
    fireEvent.keyDown(ta('A'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    expect(scope('A').queryByTestId('message-input-retarget-confirm')).not.toBeNull();
  });
});

describe('[#4604] (negative control) the store works', () => {
  it('the 409: tile 2 asks (#4607)', async () => {
    await arrange('tool-changed', AFTER);
    const before = posts.length;
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    expect(scope('B').queryByTestId('message-input-retarget-confirm')).not.toBeNull();
  });

  it('no 409: tile 2 POSTs once at once', async () => {
    await arrange(null, AFTER);
    const before = posts.length;
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts.length - before).toBe(1));
    expect(scope('B').queryByTestId('message-input-retarget-confirm')).toBeNull();
  });
});
