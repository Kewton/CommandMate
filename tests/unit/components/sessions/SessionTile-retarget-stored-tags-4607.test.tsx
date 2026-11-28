/**
 * Issue #4607 (INV-V2c', 設計書 §3.4.1): two `/sessions` tiles showing the same instance (one draft
 * key, #4419). Tile 1's awaited send (the brief choice — a tile's only awaited road; its plain send is
 * optimistic, whose handed-back text reaches every composer of the draft) is stopped by the send
 * fence (409 `SEND_TARGET_CHANGED`, `not_sent`): the tag goes to tile 1's state and to the store, not
 * to tile 2's state. The roster is read again (the instance's tool changed). Tile 2's Enter once must
 * POST nothing and ask — its check reads the stored tags too.
 *
 * - T1: `tool-changed` — tile 2 asks (POST 0); cancelled POST 0; yes POST 1 to this To. Control: tile 1
 *   asks too.
 * - T2: the same with `target-gone`. (A tile has no awaited send without the brief choice.)
 * - T3 (positive control): no 409 (nothing stored) → tile 2 POSTs once, no question; the 409 but the
 *   roster unchanged (the stored tag's original is this To) → POST once, no question.
 *
 * Harness: `SessionTile-retarget-tag-columns-4535.test.tsx` (the lead's V2-B repro on develop 890446374).
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
import { getInstanceDraftKey, readDraft, readRetargetStore } from '@/lib/drafts/message-draft';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-1';
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
  window.localStorage.clear();
});

/**
 * Both tiles show i1 with `hello`; tile 1's brief-choice send is answered by `refusal` (a 409 body)
 * or, with null, not sent at all; then the roster becomes `after`.
 */
async function arrange(refusal: string | null, after: Roster) {
  roster = { 'codex-2': 'codex', claude: 'claude' };
  shown = { A: 'codex-2', B: 'claude' };
  view = render(tree());
  await waitFor(() => expect(ta('A')).toBeInTheDocument());
  fireEvent.change(ta('A'), { target: { value: TEXT } });
  await flush(600);
  // Issue #4604 S13: the draft is its one value (read with the lib's public read).
  expect(readDraft(getInstanceDraftKey(WT, I1.id)).text).toBe(TEXT);
  shown = { ...shown, B: 'codex-2' };
  view.rerender(tree());
  await flush(30);
  await waitFor(() => expect(ta('B').value).toBe(TEXT));
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
    expect(readRetargetStore(getInstanceDraftKey(WT, I1.id)).kind).not.toBe('absent');
  }
  roster = after;
  view.rerender(tree());
  await flush(30);
  holdAnswers = false;
}

describe.each([['tool-changed'], ['target-gone']])('[#4607 T1/T2] two tiles, one draft key: the brief send stopped by the fence (%s)', (reason) => {
  const AFTER: Roster = { 'codex-2': 'claude', claude: 'claude' };

  it('tile 2: Enter once POSTs nothing and asks; cancelled POSTs nothing; yes POSTs once to this To', async () => {
    await arrange(reason, AFTER);
    const before = posts.length;
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    const confirm = scope('B').getByTestId('message-input-retarget-confirm');
    expect(confirm.textContent).toContain('codex-2 (codex)');
    expect(confirm.textContent).toContain('codex-2 (claude)');
    fireEvent.click(scope('B').getByTestId('message-input-retarget-confirm-no'));
    await flush(50);
    expect(posts.length - before).toBe(0);
    expect(ta('B').value).toBe(TEXT);

    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    fireEvent.click(scope('B').getByTestId('message-input-retarget-confirm-yes'));
    await waitFor(() => expect(posts.length - before).toBe(1));
    await flush(50);
    expect(posts.length - before).toBe(1);
    expect(posts[before]).toEqual(expect.objectContaining({ content: TEXT, cliToolId: 'claude', instanceId: 'codex-2' }));
  });

  it('(control) tile 1: Enter once POSTs nothing and asks', async () => {
    await arrange(reason, AFTER);
    const before = posts.length;
    fireEvent.keyDown(ta('A'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    expect(scope('A').queryByTestId('message-input-retarget-confirm')).not.toBeNull();
  });
});

describe('[#4607 T3] (positive control) tile 2 sends at once', () => {
  it('no 409 (nothing stored): no question, POST once', async () => {
    await arrange(null, { 'codex-2': 'claude', claude: 'claude' });
    const before = posts.length;
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts.length - before).toBe(1));
    await flush(50);
    expect(posts.length - before).toBe(1);
    expect(scope('B').queryByTestId('message-input-retarget-confirm')).toBeNull();
    expect(posts[before]).toEqual(expect.objectContaining({ content: TEXT, cliToolId: 'claude', instanceId: 'codex-2' }));
  });

  it('the 409, but the roster unchanged (the stored tag\'s original is this To): no question, POST once', async () => {
    await arrange('tool-changed', { 'codex-2': 'codex', claude: 'claude' });
    const before = posts.length;
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts.length - before).toBe(1));
    await flush(50);
    expect(posts.length - before).toBe(1);
    expect(scope('B').queryByTestId('message-input-retarget-confirm')).toBeNull();
    expect(posts[before]).toEqual(expect.objectContaining({ content: TEXT, cliToolId: 'codex', instanceId: 'codex-2' }));
  });
});

/**
 * Issue #4607 r3 (INV-V2c''): tile 2 asks (the stored tag's original `codex-2 (codex)`, the To
 * `codex-2 (claude)`); the roster is read again and the same instance's tool changes once more
 * (`gemini`) — the instance (and so the tile's draft and brief key) stays. Whether the question is
 * up, or the yes was given and the brief is up: one press POSTs nothing and asks again naming
 * `codex-2 (gemini)`; cancelled POSTs nothing; yes POSTs once there.
 */
describe('[#4607 r3] tile 2: the same instance\'s tool changes again after the question', () => {
  const AFTER: Roster = { 'codex-2': 'claude', claude: 'claude' };
  const AGAIN: Roster = { 'codex-2': 'gemini', claude: 'claude' };

  it.each([['the question up'], ['the yes given, the brief up']])('%s: one press POSTs nothing and asks again naming the To now', async (scene) => {
    await arrange('tool-changed', AFTER);
    const before = posts.length;
    const band = () => scope('B').queryByTestId('message-input-retarget-confirm');
    if (scene !== 'the question up') previewShown = true;
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    expect(band()?.textContent).toContain('codex-2 (claude)');
    if (scene !== 'the question up') {
      fireEvent.click(scope('B').getByTestId('message-input-retarget-confirm-yes'));
      await screen.findByTestId('session-start-brief-decline');
    }

    roster = AGAIN;
    view.rerender(tree());
    await flush(50);
    previewShown = false;
    expect(band()?.textContent ?? '').not.toContain('codex-2 (claude)');
    const decline = screen.queryByTestId('session-start-brief-decline');
    if (band()) fireEvent.click(scope('B').getByTestId('message-input-retarget-confirm-yes'));
    else if (decline) fireEvent.click(decline);
    await flush(100);
    expect(posts.length - before).toBe(0);
    if (!band()) fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    expect(posts.length - before).toBe(0);
    expect(band()?.textContent).toContain('codex-2 (gemini)');

    fireEvent.click(scope('B').getByTestId('message-input-retarget-confirm-no'));
    await flush(50);
    expect(posts.length - before).toBe(0);
    expect(ta('B').value).toBe(TEXT);
    fireEvent.keyDown(ta('B'), { key: 'Enter', code: 'Enter' });
    await flush(100);
    fireEvent.click(scope('B').getByTestId('message-input-retarget-confirm-yes'));
    await waitFor(() => expect(posts.length - before).toBe(1));
    await flush(50);
    expect(posts.length - before).toBe(1);
    expect(posts[before]).toEqual(expect.objectContaining({ content: TEXT, cliToolId: 'gemini', instanceId: 'codex-2' }));
  });
});
