/**
 * Issue #4604＋#4606 r3 T-P (INV-P, the oracle of every row): a POST from a tile or a composer goes out
 * only when, at that moment, the facts that allow its To and each piece of its text are there — the
 * piece's mark names that To, or the person said yes to a question that showed that piece (the To of
 * the question, the ids and the generations it saw), and for a hold: a successful roster fetch after it.
 * A later render's value, a passive copy, a count, having passed an entry, or a mark missing from the
 * store never stands in for them.
 *
 * The oracle is kept by this file, not read from the implementation: each piece of text with the fact
 * it came with (`pieces`), each yes with what its question showed when it was shown (`yeses`, per draft
 * key — a mark born after the question is not covered), and each hold with the roster fetches that
 * succeeded after it (`holds`). Every POST (counted at the fetch, the one place `/send` leaves the page)
 * is checked against them. "The To of the last yes" and render counts are not part of it.
 *
 * The table: every exit a POST leaves by × one event that changes the facts. Composer (PC split pane):
 * Enter · [send] · the form's submit · the band's [yes] · the brief's choice · #4503's [resend].
 * Tile (`/sessions`): Enter · the brief's choice · the history's [retry] · the automatic resend of a
 * parked row · the send waiting on its preview. Events: a text handed back after the question into the
 * same generation (P1-1); another composer of the same draft (in place of a second tab) says yes and
 * lets go, then `storage`, and this composer's To is a third one (P1-2); status notifications that do
 * not change the roster, 1 and 2 (the real `applyWaitingEdge`, P1-3); the hold coming up while a send
 * waits (P1-4b); another exit while the hold is shown (P1-4a, the automatic resend). Pairs that cannot
 * happen are cut, each with its reason (`CUT`).
 *
 * The choke-point rows (r3c) count differently: whatever exit a POST comes from, while a hold is up and
 * before a roster fetch, the POSTs that reach `/send` are 0 — counted at the fetch, so an exit missing
 * from the table is still counted. A row the gate stopped stays (not removed, not failed, not
 * "unknown") and can be sent after the roster fetch.
 *
 * Positive controls: with the facts there, one send goes (the original To, a question shown and
 * answered yes, after the roster fetch).
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
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

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
vi.mock('@/components/providers/WorktreesCacheProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/WorktreesCacheProvider')>();
  return { ...actual, useOptionalWorktreesCacheContext: () => null };
});

import { MessageInput } from '@/components/worktree/MessageInput';
import { SessionTile } from '@/components/sessions/SessionTile';
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import { applyWaitingEdge, useWorktreesCache } from '@/hooks/useWorktreesCache';
import {
  getRetargetTagKey,
  getSplitDraftKey,
  newRetargetTag,
  readRetargetUnstorable,
  returnRetargetedText,
} from '@/lib/drafts/message-draft';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

// ---------------------------------------------------------------- the oracle

interface Target {
  id: string;
  tool: string;
}
const sameTo = (a: Target, b: Target) => a.id === b.id && a.tool === b.tool;
const show = (t: Target) => `${t.id}/${t.tool}`;

/** A piece of text and the fact it came with: its mark's original To, or the "unknown" generation it is under. */
interface Piece {
  text: string;
  tagId: string | null;
  original: Target | null;
  generation: string | null;
}
/** A yes: what its question showed when it was shown (per draft key). */
interface Yes {
  key: string;
  to: Target;
  ids: string[];
  seen: string[];
}
/** A hold: the pair the fence named, and the roster fetches that succeeded after it. */
interface Hold {
  pair: Target;
  fetchedAfter: number;
}
const oracle = {
  key: '',
  pieces: [] as Piece[],
  yeses: [] as Yes[],
  /** The composer bench's hold (its `sendBlockedReason`): no roster fetch there. */
  composerHeld: false,
  holds: [] as Hold[],
  posts: [] as Array<{ to: Target; content: string }>,
  violations: [] as string[],
};

function checkPost(to: Target, content: string) {
  oracle.posts.push({ to, content });
  if (oracle.composerHeld) oracle.violations.push(`POST to ${show(to)} while the composer's To is held`);
  for (const hold of oracle.holds) {
    if (sameTo(hold.pair, to) && hold.fetchedAfter === 0) {
      oracle.violations.push(`POST to the held ${show(to)} before a roster fetch succeeded after the hold`);
    }
  }
  for (const piece of oracle.pieces) {
    if (!content.includes(piece.text)) continue;
    if (piece.tagId === null && piece.generation === null) continue;
    if (piece.original !== null && sameTo(piece.original, to)) continue;
    const covered = oracle.yeses.some(
      (yes) =>
        yes.key === oracle.key &&
        sameTo(yes.to, to) &&
        (piece.tagId === null || yes.ids.includes(piece.tagId)) &&
        (piece.generation === null || yes.seen.includes(piece.generation)),
    );
    if (!covered) oracle.violations.push(`POST to ${show(to)} carries "${piece.text}" — no fact allows it`);
  }
}

/** What a question shown now shows: the ids and generations of the draft's marks (store and page mark). */
function storeFacts(key: string): { ids: string[]; seen: string[] } {
  const raw = window.localStorage.getItem(getRetargetTagKey(key));
  const ids: string[] = [];
  const seen: string[] = [];
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) ids.push(...parsed.map((t: { id: string }) => t.id));
      else if (parsed && typeof parsed === 'object') {
        const { unknown, tags } = parsed as { unknown?: string; tags?: Array<{ id: string }> };
        if (typeof unknown === 'string') seen.push(unknown);
        if (Array.isArray(tags)) ids.push(...tags.map((t) => t.id));
      }
    } catch {
      /* junk: no ids, no generation — a yes to it covers nothing named */
    }
  }
  const mark = readRetargetUnstorable(key);
  if (mark !== null) seen.push(mark);
  return { ids, seen };
}

// ---------------------------------------------------------------- the fetch (the one place `/send` leaves)

const WT = 'wt-4604-exits';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fenceBody = (reason: string, instanceId: string, cliToolId: string) => ({
  error: 'The send target changed', code: 'SEND_TARGET_CHANGED', reason,
  target: { worktreeId: WT, instanceId, cliToolId }, current: null, requestId: 'r-1', sendOutcome: 'not_sent',
});
const PROMPT_WAITING = { error: 'prompt waiting', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' };
const NOT_SHOWN = { ok: true, show: false, attended: false };
const SHOWN = {
  ok: true, show: true, attended: true, injectOnStart: true, mode: 'on',
  boundary: { id: 'b-1', kind: 'launch' },
  preview: { open: { count: 1, unreflected: 1 }, humanQuestions: { count: 0, unknownSources: [] }, lastUpdatedAt: null },
};

/** The answers the next POSTs get, in order (then 201). */
let answers: Array<() => Response | Promise<Response>> = [];
let serverRoster: Record<string, CLIToolType> = {};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function worktree(roster: Record<string, CLIToolType>): Worktree {
  return {
    id: WT, name: 'feature/test', path: '/path/to/wt', repositoryPath: '/path/to/repo', repositoryName: 'MyRepo',
    agentInstances: Object.entries(roster).map(([id, cliTool], order) => ({ id, cliTool, alias: '', order })),
    isWaitingForResponse: false,
    sessionStatusByInstance: Object.fromEntries(
      Object.keys(roster).map((id) => [id, { isRunning: true, isWaitingForResponse: false, isProcessing: false }]),
    ),
  } as Worktree;
}

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/worktrees/${WT}/send` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { content: string; cliToolId: string; instanceId?: string };
      checkPost({ id: body.instanceId ?? body.cliToolId, tool: body.cliToolId }, body.content);
      const next = answers.shift();
      const response = next ? await next() : json(201, { id: `srv-${oracle.posts.length}`, role: 'user', content: body.content, timestamp: new Date().toISOString() });
      // The fence's 409 for the roster's reasons is a hold (the tile's rule; the oracle keeps its own).
      if (response.status === 409) {
        const answer = (await response.clone().json()) as { code?: string; reason?: string; sendOutcome?: string; target?: { instanceId: string; cliToolId: string } };
        if (answer.code === 'SEND_TARGET_CHANGED' && answer.sendOutcome === 'not_sent' && answer.target && (answer.reason === 'target-gone' || answer.reason === 'tool-changed')) {
          oracle.holds.push({ pair: { id: answer.target.instanceId, tool: answer.target.cliToolId }, fetchedAfter: 0 });
        }
      }
      return response;
    }
    if (url === '/api/worktrees') return json(200, { worktrees: [worktree(serverRoster)], repositories: [] });
    return json(200, {});
  }));
}

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  oracle.key = '';
  oracle.pieces = [];
  oracle.yeses = [];
  oracle.composerHeld = false;
  oracle.holds = [];
  oracle.posts = [];
  oracle.violations = [];
  answers = [];
  serverRoster = {};
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
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
  installFetch();
  fetchStartPreviewMock.mockReset();
  fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// ---------------------------------------------------------------- the table

type ComposerExit = 'enter' | 'send-button' | 'form-submit' | 'band-yes' | 'brief-decline' | 'resend-yes';
type ComposerEvent = 'returned-after-question' | 'other-composer-yes' | 'hold-during-await';
type TileExit = 'enter' | 'brief-decline' | 'retry' | 'autoresend' | 'preview-await';
type TileEvent = 'edges-1' | 'edges-2' | 'hold-shown' | 'hold-during-await';

const COMPOSER_EXITS: ComposerExit[] = ['enter', 'send-button', 'form-submit', 'band-yes', 'brief-decline', 'resend-yes'];
const COMPOSER_EVENTS: ComposerEvent[] = ['returned-after-question', 'other-composer-yes', 'hold-during-await'];
const TILE_EXITS: TileExit[] = ['enter', 'brief-decline', 'retry', 'autoresend', 'preview-await'];
const TILE_EVENTS: TileEvent[] = ['edges-1', 'edges-2', 'hold-shown', 'hold-during-await'];

/** The pairs that cannot happen, each with why. */
const CUT: Record<string, string> = {
  'composer / returned-after-question / resend-yes':
    "#4503's [resend] row is drawn only while the draft is that send's text; a text handed back changes the draft, so the row is gone before it can be pressed",
  'composer / other-composer-yes / resend-yes':
    "#4503's [resend] reaches the same entry as Enter (`submitMessage`) and adds only its own question before it — the enter row is the same road",
  'tile / edges-1 / autoresend': 'the automatic resend runs only when the connection comes back, not on a status notification: it is counted in the hold-shown row',
  'tile / edges-2 / autoresend': 'the same as edges-1 / autoresend',
  'tile / edges-1 / preview-await': 'with the hold already up before the press, Enter is blocked at its entry: that is the enter row (the hold coming up during the wait is hold-during-await)',
  'tile / edges-2 / preview-await': 'the same as edges-1 / preview-await',
  'tile / hold-shown / preview-await': 'the hold up before the press is the enter row; up during the wait is hold-during-await',
  'tile / hold-during-await / enter': 'Enter waits on its preview — that wait is the preview-await exit',
  'tile / hold-during-await / retry': 'a retry dispatches at once: nothing waits between the press and the POST for the hold to come up in',
  'tile / hold-during-await / autoresend': 'the automatic resend dispatches at once after its refetch: it is counted in the hold-shown row',
};

const COMPOSER_ROWS: Array<[string, ComposerEvent, ComposerExit]> = [];
for (const event of COMPOSER_EVENTS) for (const exit of COMPOSER_EXITS) {
  const name = `composer / ${event} / ${exit}`;
  if (!CUT[name]) COMPOSER_ROWS.push([name, event, exit]);
}
const TILE_ROWS: Array<[string, TileEvent, TileExit]> = [];
for (const event of TILE_EVENTS) for (const exit of TILE_EXITS) {
  const name = `tile / ${event} / ${exit}`;
  if (!CUT[name]) TILE_ROWS.push([name, event, exit]);
}

describe('[#4604+#4606 T-P] the table', () => {
  it('is counted: composer 6 × 3 and tile 5 × 4 listed; the cut pairs each have a reason', () => {
    expect(COMPOSER_EXITS.length * COMPOSER_EVENTS.length).toBe(18);
    expect(TILE_EXITS.length * TILE_EVENTS.length).toBe(20);
    expect(Object.keys(CUT)).toHaveLength(10);
    expect(COMPOSER_ROWS).toHaveLength(16);
    expect(TILE_ROWS).toHaveLength(12);
    for (const reason of Object.values(CUT)) expect(reason.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------- the composer bench

const KEY = getSplitDraftKey(WT, 1);
const ORIGINAL: Target = { id: 'codex-2', tool: 'codex' };
const TO_A: Target = { id: 'claude-2', tool: 'claude' };
const TO_B: Target = { id: 'claude-3', tool: 'claude' };
const HELD_REASON = '宛先が替わりました。名簿を読み直しています';

function Composer({ name, to, blocked }: { name: string; to: Target; blocked: boolean }) {
  return (
    <div data-testid={`composer-${name}`}>
      <MessageInput
        worktreeId={WT}
        cliToolId={to.tool as CLIToolType}
        instanceId={to.id}
        splitIndex={1}
        isSessionRunning
        onMessageSent={vi.fn()}
        sendBlockedReason={blocked ? HELD_REASON : null}
      />
    </div>
  );
}

const inComposer = (name: string) => within(screen.getByTestId(`composer-${name}`));
const pendingQuestions: Record<string, Yes | null> = {};

/** The band is up in `name`: what its question shows now (the oracle's record of it). */
function noteQuestion(name: string, to: Target) {
  expect(inComposer(name).getByTestId('message-input-retarget-confirm')).toBeInTheDocument();
  pendingQuestions[name] = { key: oracle.key, to, ...storeFacts(oracle.key) };
}
function sayYes(name: string) {
  const asked = pendingQuestions[name];
  expect(asked).toBeTruthy();
  oracle.yeses.push(asked!);
  pendingQuestions[name] = null;
  fireEvent.click(inComposer(name).getByTestId('message-input-retarget-confirm-yes'));
}

async function pressComposer(name: string, to: Target, exit: ComposerExit) {
  const scope = inComposer(name);
  const textarea = scope.getByTestId('message-input-textarea');
  switch (exit) {
    case 'enter':
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      break;
    case 'send-button':
      fireEvent.click(scope.getByTestId('send-message-button'));
      break;
    case 'form-submit':
      fireEvent.submit(textarea.closest('form')!);
      break;
    case 'band-yes':
      if (scope.queryByTestId('message-input-retarget-confirm') && !pendingQuestions[name]) noteQuestion(name, to);
      if (pendingQuestions[name]) sayYes(name);
      break;
    case 'brief-decline': {
      const decline = screen.queryByTestId('session-start-brief-decline');
      if (decline) fireEvent.click(decline);
      break;
    }
    case 'resend-yes': {
      const yes = scope.queryByTestId('message-input-resend-confirm-yes');
      if (yes) fireEvent.click(yes);
      break;
    }
  }
  await flush(50);
}

function handBack(text: string): void {
  const tag = newRetargetTag({ instanceId: ORIGINAL.id, cliToolId: ORIGINAL.tool });
  oracle.pieces.push({ text, tagId: tag.id, original: ORIGINAL, generation: null });
  act(() => {
    returnRetargetedText(KEY, { text, tag });
  });
}

async function typeInto(name: string, text: string) {
  fireEvent.change(inComposer(name).getByTestId('message-input-textarea'), { target: { value: text } });
  await flush(30);
}

describe('[#4604 T-P] composer exits × events (PC split pane)', () => {
  it.each(COMPOSER_ROWS)('%s', async (_name, event, exit) => {
    oracle.key = KEY;
    pendingQuestions.A = null;
    pendingQuestions.B = null;
    if (event === 'returned-after-question') {
      // P1-1: an "unknown" draft is asked about; while the question is up a text comes back into the
      // same generation (another composer's 409, the tile's). The question never showed it.
      window.localStorage.setItem(getRetargetTagKey(KEY), JSON.stringify({ unknown: 'g1', tags: [] }));
      oracle.pieces.push({ text: 'hello', tagId: null, original: null, generation: 'g1' });
      if (exit === 'brief-decline') fetchStartPreviewMock.mockResolvedValue(SHOWN);
      render(<Composer name="A" to={TO_A} blocked={false} />);
      await typeInto('A', 'hello');
      fireEvent.keyDown(inComposer('A').getByTestId('message-input-textarea'), { key: 'Enter', code: 'Enter' });
      await flush(30);
      noteQuestion('A', TO_A);
      if (exit === 'brief-decline') {
        sayYes('A');
        await screen.findByTestId('session-start-brief-decline');
        fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
      }
      handBack('returned-r2');
      await flush(30);
      expect((inComposer('A').getByTestId('message-input-textarea') as HTMLTextAreaElement).value).toContain('returned-r2');
      await pressComposer('A', TO_A, exit);
    } else if (event === 'other-composer-yes') {
      // P1-2: two composers of the same draft (in place of two tabs). A says yes to its To and sends;
      // B — a third To — then presses. A's yes is not a fact for B's To.
      window.localStorage.setItem(KEY, 'hello');
      window.localStorage.setItem(getRetargetTagKey(KEY), JSON.stringify({ unknown: 'g1', tags: [] }));
      oracle.pieces.push({ text: 'hello', tagId: null, original: null, generation: 'g1' });
      render(
        <>
          <Composer name="A" to={TO_A} blocked={false} />
          <Composer name="B" to={TO_B} blocked={false} />
        </>,
      );
      await flush(30);
      fireEvent.keyDown(inComposer('A').getByTestId('message-input-textarea'), { key: 'Enter', code: 'Enter' });
      await flush(30);
      noteQuestion('A', TO_A);
      sayYes('A');
      await flush(50);
      expect(oracle.posts).toHaveLength(1);
      await act(async () => {
        window.dispatchEvent(new StorageEvent('storage', { key: getRetargetTagKey(KEY) }));
        window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
      });
      await flush(30);
      expect((inComposer('B').getByTestId('message-input-textarea') as HTMLTextAreaElement).value).toBe('hello');
      if (exit === 'brief-decline') fetchStartPreviewMock.mockResolvedValue(SHOWN);
      if (exit === 'band-yes' || exit === 'brief-decline') {
        // The press that comes before these exits: Enter (it asks, or opens the brief, or sends).
        fireEvent.keyDown(inComposer('B').getByTestId('message-input-textarea'), { key: 'Enter', code: 'Enter' });
        await flush(30);
        if (inComposer('B').queryByTestId('message-input-retarget-confirm')) {
          noteQuestion('B', TO_B);
          if (exit === 'brief-decline') {
            sayYes('B');
            await flush(30);
          }
        }
      }
      await pressComposer('B', TO_B, exit);
    } else {
      // P1-4b at the composer: the hold comes up while the send waits on its preview (or while the
      // band, the brief, or #4503's question is up).
      window.localStorage.setItem(getRetargetTagKey(KEY), JSON.stringify(exit === 'band-yes' ? { unknown: 'g1', tags: [] } : []));
      if (exit === 'band-yes') oracle.pieces.push({ text: 'hello', tagId: null, original: null, generation: 'g1' });
      if (exit === 'resend-yes') {
        window.localStorage.setItem(`${KEY}:send-unknown`, JSON.stringify({ text: 'hello', target: `${WT}\u0000${TO_A.id}` }));
      }
      const preview = deferred<typeof NOT_SHOWN>();
      if (exit === 'brief-decline') fetchStartPreviewMock.mockResolvedValue(SHOWN);
      else if (exit !== 'band-yes' && exit !== 'resend-yes') fetchStartPreviewMock.mockImplementationOnce(() => preview.promise);
      const view = render(<Composer name="A" to={TO_A} blocked={false} />);
      await typeInto('A', 'hello');
      if (exit === 'enter' || exit === 'send-button' || exit === 'form-submit') {
        await pressComposer('A', TO_A, exit);
        expect(oracle.posts).toHaveLength(0);
        oracle.composerHeld = true;
        view.rerender(<Composer name="A" to={TO_A} blocked />);
        await flush(30);
        await act(async () => preview.resolve(NOT_SHOWN));
        await flush(80);
      } else {
        fireEvent.keyDown(inComposer('A').getByTestId('message-input-textarea'), { key: 'Enter', code: 'Enter' });
        await flush(30);
        if (exit === 'band-yes') noteQuestion('A', TO_A);
        if (exit === 'brief-decline') {
          await screen.findByTestId('session-start-brief-decline');
          fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
        }
        if (exit === 'resend-yes') expect(inComposer('A').getByTestId('message-input-resend-confirm-yes')).toBeInTheDocument();
        oracle.composerHeld = true;
        view.rerender(<Composer name="A" to={TO_A} blocked />);
        await flush(30);
        await pressComposer('A', TO_A, exit);
      }
    }
    expect(oracle.violations).toEqual([]);
  });
});

describe('[#4604 T-P] composer positive controls (the facts are there: one send goes)', () => {
  it('a question shown and answered yes, nothing new after it: one POST to the To', async () => {
    oracle.key = KEY;
    pendingQuestions.A = null;
    window.localStorage.setItem(getRetargetTagKey(KEY), JSON.stringify({ unknown: 'g1', tags: [] }));
    oracle.pieces.push({ text: 'hello', tagId: null, original: null, generation: 'g1' });
    render(<Composer name="A" to={TO_A} blocked={false} />);
    await typeInto('A', 'hello');
    fireEvent.keyDown(inComposer('A').getByTestId('message-input-textarea'), { key: 'Enter', code: 'Enter' });
    await flush(30);
    noteQuestion('A', TO_A);
    sayYes('A');
    await flush(50);
    expect(oracle.posts).toEqual([{ to: TO_A, content: 'hello' }]);
    expect(oracle.violations).toEqual([]);
  });

  it('the mark names the To: one POST, no question', async () => {
    oracle.key = KEY;
    const tag = newRetargetTag({ instanceId: TO_A.id, cliToolId: TO_A.tool });
    window.localStorage.setItem(getRetargetTagKey(KEY), JSON.stringify([tag]));
    oracle.pieces.push({ text: 'hello', tagId: tag.id, original: TO_A, generation: null });
    render(<Composer name="A" to={TO_A} blocked={false} />);
    await typeInto('A', 'hello');
    fireEvent.keyDown(inComposer('A').getByTestId('message-input-textarea'), { key: 'Enter', code: 'Enter' });
    await flush(50);
    expect(oracle.posts).toEqual([{ to: TO_A, content: 'hello' }]);
    expect(oracle.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------- the tile bench

const X: Target = { id: 'codex-2', tool: 'codex' };
const TEXT = 'please review';
let current: Worktree;
let view: ReturnType<typeof render>;
let conn = { offline: false, reachable: true };
const tile = () => (
  <ToastProvider>
    <SessionTile worktree={current} enabled instanceIds={['codex-2']} connectivity={conn} />
  </ToastProvider>
);
const tileScope = () => within(screen.getByTestId(`session-tile-composer-${WT}`));
const tileTa = () => tileScope().getByTestId('message-input-textarea') as HTMLTextAreaElement;
const heldNotice = () => tileScope().queryByTestId('message-input-send-blocked');

/** A roster fetch through the cache's own `refresh()`: the tile renders the object it adopted. */
async function fetchRoster(roster: Record<string, CLIToolType>): Promise<void> {
  serverRoster = roster;
  const hook = renderHook(() => useWorktreesCache({ enabled: false }));
  await act(async () => {
    await hook.result.current.refresh();
  });
  const fetched = hook.result.current.worktrees.find((wt) => wt.id === WT);
  hook.unmount();
  expect(fetched).toBeDefined();
  for (const hold of oracle.holds) hold.fetchedAfter += 1;
  current = fetched!;
  view.rerender(tile());
  await flush(30);
}

async function mountTile() {
  current = worktree({ 'codex-2': 'codex', claude: 'claude' });
  view = render(tile());
  await waitFor(() => expect(tileTa()).toBeInTheDocument());
}
async function tileTypeAndEnter(text: string) {
  fireEvent.change(tileTa(), { target: { value: text } });
  await flush(30);
  fireEvent.keyDown(tileTa(), { key: 'Enter', code: 'Enter' });
}
/** The fence's 409 on the optimistic send of TEXT: the text back in the composer, a failed row, the hold. */
async function arrangeHold() {
  await mountTile();
  answers.push(() => json(409, fenceBody('target-gone', X.id, X.tool)));
  await tileTypeAndEnter(TEXT);
  await waitFor(() => expect(oracle.posts).toHaveLength(1));
  await flush(80);
  await waitFor(() => expect(tileTa().value).toBe(TEXT));
  expect(oracle.holds).toHaveLength(1);
}
async function statusEdges(n: number) {
  const waiting = [true, false];
  for (let i = 0; i < n; i += 1) {
    const next = applyWaitingEdge(current, { waiting: waiting[i], instance: 'claude' });
    expect(next).not.toBe(current);
    expect(next.agentInstances).toBe(current.agentInstances);
    current = next;
    view.rerender(tile());
    await flush(30);
  }
}
/** Two sends; offline; the first is answered by the fence (the hold), the second by a `not_sent` 409 (parked); back online. */
async function arrangeParkedUnderHold() {
  conn = { offline: false, reachable: true };
  await mountTile();
  const a = deferred<Response>();
  const b = deferred<Response>();
  answers.push(() => a.promise, () => b.promise);
  await tileTypeAndEnter('first');
  await waitFor(() => expect(oracle.posts).toHaveLength(1));
  await tileTypeAndEnter('second');
  await waitFor(() => expect(oracle.posts).toHaveLength(2));
  conn = { offline: true, reachable: false };
  view.rerender(tile());
  await flush(30);
  await act(async () => a.resolve(json(409, fenceBody('target-gone', X.id, X.tool))));
  await flush(50);
  await act(async () => b.resolve(json(409, PROMPT_WAITING)));
  await flush(50);
  expect(oracle.holds).toHaveLength(1);
  conn = { offline: false, reachable: true };
  view.rerender(tile());
  await flush(600);
}

async function pressTile(exit: TileExit) {
  switch (exit) {
    case 'enter':
      fireEvent.keyDown(tileTa(), { key: 'Enter', code: 'Enter' });
      break;
    case 'brief-decline': {
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      fireEvent.keyDown(tileTa(), { key: 'Enter', code: 'Enter' });
      await flush(50);
      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
      const decline = screen.queryByTestId('session-start-brief-decline');
      if (decline) fireEvent.click(decline);
      break;
    }
    case 'retry':
      for (const button of screen.queryAllByTestId('chat-pending-retry')) fireEvent.click(button);
      break;
    default:
      break;
  }
  await flush(80);
}

describe('[#4606 T-P] tile exits × events (`/sessions`, the To codex-2/codex held by the fence\'s 409)', () => {
  beforeEach(() => {
    conn = { offline: false, reachable: true };
  });

  it.each(TILE_ROWS)('%s', async (_name, event, exit) => {
    if (exit === 'autoresend') {
      // P1-4a's other exit: the automatic resend of a row parked while the hold came up.
      await arrangeParkedUnderHold();
    } else if (event === 'hold-during-await' && exit === 'preview-await') {
      // P1-4b: a send waits on its preview; meanwhile a retry is answered by the fence (the hold).
      await mountTile();
      answers.push(() => json(409, PROMPT_WAITING));
      await tileTypeAndEnter(TEXT);
      await waitFor(() => expect(oracle.posts).toHaveLength(1));
      await flush(80);
      await waitFor(() => expect(screen.getAllByTestId('chat-pending-retry')).toHaveLength(1));
      const retryAnswer = deferred<Response>();
      answers.push(() => retryAnswer.promise);
      fireEvent.click(screen.getAllByTestId('chat-pending-retry')[0]);
      await waitFor(() => expect(oracle.posts).toHaveLength(2));
      const preview = deferred<typeof NOT_SHOWN>();
      fetchStartPreviewMock.mockImplementationOnce(() => preview.promise);
      await tileTypeAndEnter('second text');
      await flush(30);
      await act(async () => retryAnswer.resolve(json(409, fenceBody('target-gone', X.id, X.tool))));
      await flush(50);
      expect(oracle.holds).toHaveLength(1);
      await act(async () => preview.resolve(NOT_SHOWN));
      await flush(80);
    } else if (event === 'hold-during-await' && exit === 'brief-decline') {
      // PB-1: the brief is up for a second text when the first send's 409 lands.
      await mountTile();
      const first = deferred<Response>();
      answers.push(() => first.promise);
      await tileTypeAndEnter('first');
      await waitFor(() => expect(oracle.posts).toHaveLength(1));
      fireEvent.change(tileTa(), { target: { value: 'second' } });
      await flush(30);
      fetchStartPreviewMock.mockResolvedValue(SHOWN);
      fireEvent.keyDown(tileTa(), { key: 'Enter', code: 'Enter' });
      await screen.findByTestId('session-start-brief-decline');
      fetchStartPreviewMock.mockResolvedValue(NOT_SHOWN);
      await act(async () => first.resolve(json(409, fenceBody('tool-changed', X.id, X.tool))));
      await flush(80);
      expect(oracle.holds).toHaveLength(1);
      expect(heldNotice()).not.toBeNull();
      fireEvent.click(screen.getByTestId('session-start-brief-decline'));
      await flush(80);
    } else {
      await arrangeHold();
      if (event === 'edges-1') await statusEdges(1);
      if (event === 'edges-2') await statusEdges(2);
      await pressTile(exit);
    }
    expect(oracle.violations).toEqual([]);
  });

  it('(positive control) after a roster fetch that succeeded after the hold, Enter sends to the original To once', async () => {
    await arrangeHold();
    await fetchRoster({ 'codex-2': 'codex', claude: 'claude' });
    expect(heldNotice()).toBeNull();
    const before = oracle.posts.length;
    fireEvent.keyDown(tileTa(), { key: 'Enter', code: 'Enter' });
    await flush(80);
    expect(oracle.posts.slice(before)).toEqual([{ to: X, content: TEXT }]);
    expect(oracle.violations).toEqual([]);
  });
});

describe('[#4606 T-P] the choke point: whatever the exit, no POST reaches `/send` for the held pair before a roster fetch', () => {
  beforeEach(() => {
    conn = { offline: false, reachable: true };
  });

  it('every exit after the hold: 0 POSTs to the held pair; the stopped rows stay (not removed, not failed for good, not unknown) and go after the fetch', async () => {
    await arrangeParkedUnderHold();
    // Every exit there is, in turn (the table's and any other a press reaches).
    for (const exit of ['retry', 'enter', 'brief-decline', 'retry'] as TileExit[]) await pressTile(exit);
    fireEvent.click(tileScope().getByTestId('send-message-button'));
    await flush(80);
    const toHeld = oracle.posts.slice(2).filter((post) => sameTo(post.to, X));
    expect(toHeld).toEqual([]);
    expect(oracle.violations).toEqual([]);
    // The two rows are still there, each with its [retry] (none became "unknown").
    expect(screen.getAllByTestId('chat-pending-retry')).toHaveLength(2);
    // After a roster fetch: they can be sent.
    await fetchRoster({ 'codex-2': 'codex', claude: 'claude' });
    const before = oracle.posts.length;
    fireEvent.click(screen.getAllByTestId('chat-pending-retry')[0]);
    await flush(80);
    expect(oracle.posts.length).toBe(before + 1);
    expect(oracle.violations).toEqual([]);
  });
});
