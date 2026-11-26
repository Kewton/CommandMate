/**
 * Issue #4606 (O-1, 設計書 §3.6, v3 §2.2): on a `/sessions` tile, after the send fence's 409
 * (`SEND_TARGET_CHANGED`, `not_sent`) the tile's To stayed the old one until its roster was read again
 * (11 s or more), and one Enter in between POSTed to the old target (target-gone: an ad-hoc launch of an
 * id no longer in the roster). Now the 409's original target (instance and tool) is held by the tile:
 * while the To is that pair, nothing is sent — Enter, [send], the brief's choice — and the composer
 * says it is reading the roster again (the text stays). The roster is asked for again (the provider's
 * `refresh()`, when there is one).
 *
 * When the hold goes (S-1, N-3 — r3, INV-P: only after a roster fetch that succeeded after the hold):
 * - in a render of a `worktree` object a roster fetch begun after the hold adopted (the cache's own
 *   `refresh()`, run here through `useWorktreesCache` against the fetch below): the tile shows the
 *   roster as it is — without the pair (target-gone, tool-changed), or with it (then it sends; the
 *   fence answers the same 409 if it still applies);
 * - another object that is not such a fetch keeps it: a fetch begun before the 409 that lands after
 *   it, the status notifications that copy the object (`applyWaitingEdge`, 1 or 2 — 4a2b973dc counted
 *   objects and let the hold go on the second, review a P1-3), a failed fetch;
 * - `refresh()` resolving with no new roster (it failed, or was overtaken) keeps the hold (INV-T2).
 * r3 also: the brief up when the hold comes (review b PB-1); a 409 for another reason (`worktree-gone`)
 * holds nothing (review b P3-2 MD); Q2's move runs after the composer's waiting save (review a P1-6),
 * and a move that cannot be written says so.
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
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
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
import { getInstanceDraftKey, getRetargetTagKey } from '@/lib/drafts/message-draft';
import { applyWaitingEdge, useWorktreesCache } from '@/hooks/useWorktreesCache';
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
    // r3: the statuses a status notification (`applyWaitingEdge`) updates.
    isWaitingForResponse: false,
    sessionStatusByInstance: Object.fromEntries(
      Object.keys(roster).map((id) => [id, { isRunning: true, isWaitingForResponse: false, isProcessing: false }]),
    ),
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
let answers: Array<() => Response | Promise<Response>> = [];
/** The roster `/api/worktrees` answers with; `rosterAnswer` (once) instead, when set. */
let serverRoster: Roster = {};
let rosterAnswer: (() => Response | Promise<Response>) | null = null;
/** r4: the answers of the next roster fetches, in order (after `rosterAnswer`). */
let rosterQueue: Array<() => Response | Promise<Response>> = [];
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
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
    if (url === '/api/worktrees') {
      const answer = rosterAnswer ?? rosterQueue.shift() ?? null;
      rosterAnswer = null;
      if (answer) return answer();
      return json(200, { worktrees: [worktree(serverRoster)], repositories: [] });
    }
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
/** A roster fetch through the cache's own `refresh()` (begun now): the object it adopted, if it did. */
function startRosterFetch(next: Roster) {
  serverRoster = next;
  const hook = renderHook(() => useWorktreesCache({ enabled: false }));
  let done!: Promise<void>;
  act(() => {
    done = hook.result.current.refresh();
  });
  return {
    async settle(): Promise<Worktree | undefined> {
      await act(async () => {
        await done;
      });
      const fetched = hook.result.current.worktrees.find((wt) => wt.id === WT);
      hook.unmount();
      return fetched;
    },
  };
}
/** The roster is read again: a fetch begun now succeeds, and the tile renders the object it adopted. */
async function readRoster(next: Roster) {
  roster = next;
  const fetched = await startRosterFetch(next).settle();
  expect(fetched).toBeDefined();
  current = fetched!;
  view.rerender(tree());
}

beforeEach(() => {
  window.localStorage.clear();
  posts.length = 0;
  answers = [];
  serverRoster = {};
  rosterAnswer = null;
  rosterQueue = [];
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
    await readRoster({ claude: 'claude' });
    await flush(30);
    expect(notice()).toBeNull();
    for (const post of posts.slice(1)) expect(post.instanceId).not.toBe('codex-2');
  });

  it('tool-changed: the roster read again with the new tool — the hold goes, the To is the new pair (and the tag asks)', async () => {
    await arrange('tool-changed', road);
    await readRoster({ 'codex-2': 'claude', claude: 'claude' });
    await flush(30);
    expect(notice()).toBeNull();
    expect(await enterOnce()).toBe(0);
    expect(scope().queryByTestId('message-input-retarget-confirm')).not.toBeNull();
  });
});

describe('[#4606 S-1・N-3] when the hold goes', () => {
  it('S-1: a roster fetch begun before the 409 that lands after it keeps the hold; one begun after it lets it go', async () => {
    roster = { 'codex-2': 'codex', claude: 'claude' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    const early = deferred<Response>();
    rosterAnswer = () => early.promise;
    const before409 = startRosterFetch(roster);
    fireEvent.change(ta(), { target: { value: TEXT } });
    await flush(30);
    answers.push(() => json(409, fenceBody('tool-changed', 'codex-2', 'codex')));
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    await flush(80);
    await waitFor(() => expect(ta().value).toBe(TEXT));
    expect(notice()).not.toBeNull();
    early.resolve(json(200, { worktrees: [worktree(roster)], repositories: [] }));
    const late = await before409.settle();
    expect(late).toBeDefined();
    current = late!;
    view.rerender(tree());
    await flush(30);
    expect(notice()).not.toBeNull();
    expect(await enterOnce()).toBe(0);
    await readRoster({ 'codex-2': 'codex', claude: 'claude' });
    await flush(30);
    expect(notice()).toBeNull();
    // The server's roster says codex-2 is codex: the text's tag names it — it sends (the fence answers if not).
    expect(await enterOnce()).toBe(1);
  });

  it.each([1, 2])('P1-3: %i status notification(s) (`applyWaitingEdge`: new objects, the same roster) keep the hold', async (edges) => {
    await arrange('target-gone', 'optimistic');
    const waiting = [true, false];
    for (let i = 0; i < edges; i += 1) {
      const next = applyWaitingEdge(current, { waiting: waiting[i], instance: 'claude' });
      expect(next).not.toBe(current);
      expect(next.agentInstances).toBe(current.agentInstances);
      current = next;
      view.rerender(tree());
      await flush(30);
    }
    expect(notice()).not.toBeNull();
    expect(await enterOnce()).toBe(0);
  });

  it('a roster fetch that fails keeps the hold', async () => {
    await arrange('target-gone', 'optimistic');
    rosterAnswer = () => json(500, { error: 'down' });
    await startRosterFetch({ claude: 'claude' }).settle();
    view.rerender(tree());
    await flush(30);
    expect(notice()).not.toBeNull();
    expect(await enterOnce()).toBe(0);
  });

  it('PB-1: the brief is up for a second text when the first send\'s 409 lands — the brief\'s choice POSTs nothing to the held target', async () => {
    roster = { 'codex-2': 'codex', claude: 'claude' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    fireEvent.change(ta(), { target: { value: 'first' } });
    await flush(30);
    const first = deferred<Response>();
    answers.push(() => first.promise);
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.change(ta(), { target: { value: 'second' } });
    await flush(30);
    previewShown = true;
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    await screen.findByTestId('session-start-brief-decline');
    previewShown = false;
    await act(async () => first.resolve(json(409, fenceBody('tool-changed', 'codex-2', 'codex'))));
    await flush(80);
    expect(notice()).not.toBeNull();
    fireEvent.click(screen.getByTestId('session-start-brief-decline'));
    await flush(80);
    expect(posts).toHaveLength(1);
  });

  it('(negative control, MD) a 409 for another reason (`worktree-gone`) holds nothing', async () => {
    roster = { 'codex-2': 'codex', claude: 'claude' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    fireEvent.change(ta(), { target: { value: TEXT } });
    await flush(30);
    answers.push(() => json(409, fenceBody('worktree-gone', 'codex-2', 'codex')));
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    await flush(80);
    expect(notice()).toBeNull();
    fireEvent.change(ta(), { target: { value: 'again' } });
    await flush(30);
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
    await readRoster({ claude: 'claude' });
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
    await readRoster({ claude: 'claude' });
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

// r3 (review a P1-6, c5's table): the move to the fallback runs after the composer's waiting save — the
// latest text (and its marks) is what moves; a move that cannot be written says so.
describe('[#4606 r3 P1-6] the move to the fallback after the composer\'s waiting save', () => {
  const KX = getInstanceDraftKey(WT, 'codex-2');
  const KY = getInstanceDraftKey(WT, 'claude');
  afterEach(() => vi.restoreAllMocks());

  async function showXWithSaved(text: string) {
    roster = { 'codex-2': 'codex', claude: 'claude' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    fireEvent.change(ta(), { target: { value: text } });
    await flush(600);
    expect(window.localStorage.getItem(KX)).toBe(text);
  }

  it.each([
    ['rewritten', '新本文'],
    ['cleared', ''],
  ] as const)('%s within the 500 ms of the save, then X leaves the roster: Y shows the latest, the old text does not come back', async (_how, latest) => {
    await showXWithSaved('旧本文');
    fireEvent.change(ta(), { target: { value: latest } });
    await flush(50);
    shownId = null;
    await readRoster({ claude: 'claude' });
    await flush(600);
    expect(ta().value).toBe(latest);
    expect(window.localStorage.getItem(KX)).toBeNull();
    expect(window.localStorage.getItem(KY) ?? '').toBe(latest);
  });

  it('(control) rewritten, 600 ms, then X leaves: Y gets the rewritten text', async () => {
    await showXWithSaved('旧本文');
    fireEvent.change(ta(), { target: { value: '新本文' } });
    await flush(600);
    shownId = null;
    await readRoster({ claude: 'claude' });
    await flush(600);
    expect(ta().value).toBe('新本文');
    expect(window.localStorage.getItem(KX)).toBeNull();
  });

  it('the move cannot write Y\'s text: a toast says so, and X keeps its text and marks', async () => {
    await showXWithSaved('旧本文');
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === KY) throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, key, value);
    });
    shownId = null;
    await readRoster({ claude: 'claude' });
    await flush(600);
    expect(screen.getByText('下書きを移せませんでした。元のインスタンスの下書きに残っています。')).toBeInTheDocument();
    expect(window.localStorage.getItem(KX)).toBe('旧本文');
    // Its marks went in to Y before the text failed (marks first): Y asks before it sends anything of it.
    expect(window.localStorage.getItem(getRetargetTagKey(KY))).not.toBeNull();
  });
});

// ---------------------------------------------------------------- r4
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toX = (post: Record<string, unknown>) => post.instanceId === 'codex-2';
const rosterReply = () => json(200, { worktrees: [worktree(serverRoster)], repositories: [] });

// r4 Q-1 (INV-P2): the gate reads the hold when it is called — from the tile's ref, never a render's
// copy. The 409 is handled (the tile's ref has the hold) and, before the tile renders again (the same
// `act`: the composer's `sendBlockedReason` is still the old value), a send is pressed.
describe('[#4606 r4 Q-1] a send pressed after the hold is in the tile, before the composer renders it', () => {
  async function firstInFlight() {
    roster = { 'codex-2': 'codex', claude: 'claude' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    // The first send is refused for another reason (not sent); its [retry] is answered by the fence —
    // a retry hands no text back, so the composer's draft does not change when the hold comes.
    fireEvent.change(ta(), { target: { value: 'first' } });
    await flush(30);
    answers.push(() => json(409, { error: 'prompt waiting', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' }));
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    await flush(80);
    const first = deferred<Response>();
    answers.push(() => first.promise);
    fireEvent.click(screen.getByTestId('chat-pending-retry'));
    await waitFor(() => expect(posts).toHaveLength(2));
    fireEvent.change(ta(), { target: { value: 'second' } });
    await flush(30);
    return first;
  }

  it("the awaited road (the brief's choice): nothing is POSTed to the held target", async () => {
    const first = await firstInFlight();
    previewShown = true;
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    const decline = await screen.findByTestId('session-start-brief-decline');
    previewShown = false;
    await act(async () => {
      first.resolve(json(409, fenceBody('tool-changed', 'codex-2', 'codex')));
      await sleep(30);
      // Not rendered yet: the composer still has no hold on screen.
      expect(notice()).toBeNull();
      fireEvent.click(decline);
      await sleep(30);
    });
    await flush(80);
    expect(posts.slice(2).filter(toX)).toEqual([]);
  });

  it('the optimistic road (Enter): nothing is POSTed, and the text stays in the composer', async () => {
    const first = await firstInFlight();
    // A command waits for no preview: the press reaches the gate at once, inside this act.
    fireEvent.change(ta(), { target: { value: '!ls -la' } });
    await flush(30);
    await act(async () => {
      first.resolve(json(409, fenceBody('tool-changed', 'codex-2', 'codex')));
      await sleep(30);
      expect(notice()).toBeNull();
      fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
      await sleep(50);
    });
    await flush(80);
    expect(posts.slice(2).filter(toX)).toEqual([]);
    expect(ta().value).toBe('!ls -la');
  });
});

// r4 (review a P1-3): two 409s for the same pair. The first takes the hold and begins fetch A; A is
// adopted (with the pair still on it) and, before it is rendered, the second 409 lands (fetch B begins).
// The hold counts from the latest refusal: A's render keeps it; B's lets it go.
describe('[#4606 r4 P1-3] two 409s for the same pair overlap a roster fetch', () => {
  function CachedTile() {
    const cache = useWorktreesCache({ enabled: false });
    provider.value = cache;
    const wt = cache.worktrees.find((w) => w.id === WT);
    return wt ? (
      <ToastProvider>
        <SessionTile worktree={wt} enabled instanceIds={['codex-2']} />
      </ToastProvider>
    ) : null;
  }

  it('A (begun before the second refusal) keeps the hold — a [retry] POSTs nothing; after B, it sends', async () => {
    serverRoster = { 'codex-2': 'codex', claude: 'claude' };
    render(<CachedTile />);
    await act(async () => {
      await provider.value!.refresh();
    });
    await waitFor(() => expect(ta()).toBeInTheDocument());
    const p1 = deferred<Response>();
    const p2 = deferred<Response>();
    answers.push(() => p1.promise, () => p2.promise);
    fireEvent.change(ta(), { target: { value: 'one' } });
    await flush(30);
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.change(ta(), { target: { value: 'two' } });
    await flush(30);
    fireEvent.keyDown(ta(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(posts).toHaveLength(2));
    const fetchA = deferred<Response>();
    const fetchB = deferred<Response>();
    rosterQueue.push(() => fetchA.promise, () => fetchB.promise);
    await act(async () => {
      p1.resolve(json(409, fenceBody('target-gone', 'codex-2', 'codex')));
      await sleep(30);
    });
    await flush(30);
    expect(notice()).not.toBeNull();
    await act(async () => {
      fetchA.resolve(rosterReply());
      await sleep(30);
      p2.resolve(json(409, fenceBody('target-gone', 'codex-2', 'codex')));
      await sleep(30);
    });
    await flush(30);
    const before = posts.length;
    fireEvent.click(screen.getAllByTestId('chat-pending-retry')[0]);
    await flush(80);
    expect(posts.slice(before).filter(toX)).toEqual([]);
    // (positive control) B — begun after the second refusal — lets it go.
    await act(async () => {
      fetchB.resolve(rosterReply());
      await sleep(30);
    });
    await flush(30);
    expect(notice()).toBeNull();
    const afterB = posts.length;
    fireEvent.click(screen.getAllByTestId('chat-pending-retry')[0]);
    await flush(80);
    expect(posts.length).toBe(afterB + 1);
  });
});

// r4 (review a P1-4a): a row the gate stopped is not a failed send — it says it was not sent and can be
// retried after the roster is read (its [retry] and [discard] stay). A real failure keeps its words.
// And a send of the same text from another screen does not take the stopped row as delivered.
describe('[#4606 r4 P1-4a] the row the gate stopped', () => {
  const HELD = '送っていません（宛先が替わりました）。名簿の読み直しの後に再試行できます';
  const FAILED = '送信に失敗しました';

  it('says "not sent" (not "failed"), and keeps [retry] and [discard]; the failed row before it keeps "failed" (control)', async () => {
    await arrange('target-gone', 'optimistic');
    // (control) the fence's 409: a failed row, as before.
    expect(screen.getByTestId('chat-optimistic-error')).toHaveTextContent(FAILED);
    fireEvent.click(screen.getByTestId('chat-pending-retry'));
    await flush(80);
    expect(posts).toHaveLength(1);
    expect(screen.queryByTestId('chat-optimistic-error')).toBeNull();
    expect(screen.getByTestId('chat-optimistic-held')).toHaveTextContent(HELD);
    expect(screen.getByTestId('chat-pending-retry')).toBeInTheDocument();
    expect(screen.getByTestId('chat-pending-discard')).toBeInTheDocument();
  });

  it('the same text sent from another screen (a user message in the history) does not take the stopped row', async () => {
    await arrange('target-gone', 'optimistic');
    fireEvent.click(screen.getByTestId('chat-pending-retry'));
    await flush(80);
    expect(screen.getAllByTestId('chat-pending-retry')).toHaveLength(1);
    useSplitMessagesMock.mockReturnValue({
      messages: [{ id: 'srv-other', worktreeId: WT, role: 'user', content: TEXT, timestamp: new Date(), messageType: 'normal', archived: false, cliToolId: 'codex', instanceId: 'codex-2' }],
      isLoading: false,
      refresh: vi.fn(),
    });
    view.rerender(tree());
    await flush(50);
    expect(screen.getAllByTestId('chat-pending-retry')).toHaveLength(1);
  });
});

// r4 (review a P1-6): the composer's waiting save of X cannot be written at the switch — X's stored
// text is the old one; it is not moved to Y (it would bring the old version back), and it is told.
describe('[#4606 r4 P1-6] X\'s waiting save fails at the switch', () => {
  const KX = getInstanceDraftKey(WT, 'codex-2');
  const KY = getInstanceDraftKey(WT, 'claude');
  afterEach(() => vi.restoreAllMocks());

  async function showXWithSaved(text: string) {
    roster = { 'codex-2': 'codex', claude: 'claude' };
    current = worktree(roster);
    shownId = 'codex-2';
    view = render(tree());
    await waitFor(() => expect(ta()).toBeInTheDocument());
    fireEvent.change(ta(), { target: { value: text } });
    await flush(600);
    expect(window.localStorage.getItem(KX)).toBe(text);
  }

  it('rewritten, and X\'s `setItem` throws: Y does not get the old text; a toast says it was not moved', async () => {
    await showXWithSaved('旧本文');
    fireEvent.change(ta(), { target: { value: '新本文' } });
    await flush(50);
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === KX) throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, key, value);
    });
    shownId = null;
    await readRoster({ claude: 'claude' });
    await flush(600);
    expect(ta().value).not.toContain('旧本文');
    expect(window.localStorage.getItem(KY) ?? '').not.toContain('旧本文');
    expect(screen.getByText('下書きを移せませんでした。元のインスタンスの下書きに残っています。')).toBeInTheDocument();
  });

  it('cleared, and X\'s first `removeItem` throws: the old text does not come back in Y', async () => {
    await showXWithSaved('旧本文');
    fireEvent.change(ta(), { target: { value: '' } });
    await flush(50);
    const realRemove = Storage.prototype.removeItem;
    let thrown = false;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === KX && !thrown) {
        thrown = true;
        throw new DOMException('denied', 'SecurityError');
      }
      return realRemove.call(this, key);
    });
    shownId = null;
    await readRoster({ claude: 'claude' });
    await flush(600);
    expect(ta().value).not.toContain('旧本文');
    expect(window.localStorage.getItem(KY) ?? '').not.toContain('旧本文');
  });
});
