/**
 * Issue #4535 r7 (INV-V2a〜V2c, 設計書 §3.4.1): the columns of `retarget-tag-columns-4535.test.tsx` on
 * the `/sessions` tiles — two tiles of the same worktree, each showing one instance (its composer
 * keeps one draft per instance, #4419) — and on the discard road. The last Enter's expectation comes
 * from the small model (per composer — a tile's draft of one instance — the set of original targets
 * of the texts it received; only its own send empties it), never from the shape of the draft.
 *
 * | # | column (steps) |
 * |---|---|
 * | 1 | return(optimistic) in tile A → changeTo → otherSend(tile B, holding the text, to the original) → Enter in A |
 * | 4 | return(discard: a retry stopped by the fence, then [Discard]) → changeTo (tool-changed) → otherSend(tile B) → Enter in A |
 * | 8 | return → changeTo → tileSwitch (another instance and back) → Enter; return → reload → Enter |
 * | 10 | (positive control) the To the original: POST 1, no question |
 *
 * The discard road leaves one tag next to the draft it brings the text into (`<draftKey>:retarget`).
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
const TEXT = 'please look at the diff';

interface Target {
  id: string;
  tool: CLIToolType;
}

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

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/worktrees/${WT}/send` && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (holdAnswers) return new Promise<Response>((resolve) => answers.push(resolve));
      answers.push(() => undefined);
      return json(201, { id: `srv-${posts.length}`, role: 'user', content: 'x', timestamp: new Date().toISOString() });
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

const PROMPT_WAITING = { error: 'prompt waiting', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' };

async function flush(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const targetKey = (t: Target) => `${t.id}\u0000${t.tool}`;

/** Per composer (a tile's draft of one instance): the original targets of the texts it received. */
class Model {
  private readonly held = new Map<string, Set<string>>();
  receive(composer: string, original: Target): void {
    const set = this.held.get(composer) ?? new Set<string>();
    set.add(targetKey(original));
    this.held.set(composer, set);
  }
  sent(composer: string): void {
    this.held.set(composer, new Set());
  }
  asks(composer: string, to: Target): boolean {
    return [...(this.held.get(composer) ?? [])].some((key) => key !== targetKey(to));
  }
}

type TileName = 'A' | 'B';

class Run {
  readonly model = new Model();
  private view: ReturnType<typeof render> | null = null;

  constructor(
    private roster: Roster,
    private shown: Record<TileName, string>,
  ) {}

  private tree() {
    return (
      <ToastProvider>
        {(['A', 'B'] as const).map((name) => (
          <div key={name} data-testid={`tile-${name}`}>
            <SessionTile worktree={worktree(this.roster)} enabled instanceIds={[this.shown[name]]} />
          </div>
        ))}
      </ToastProvider>
    );
  }

  async mount(): Promise<void> {
    this.view = render(this.tree());
    await waitFor(() => expect(this.textarea('A')).toBeInTheDocument());
  }

  unmount(): void {
    this.view?.unmount();
    this.view = null;
  }

  to(name: TileName): Target {
    const id = this.shown[name];
    return { id, tool: this.roster[id] };
  }

  /** The model's name of the composer tile `name` shows now (its draft is per instance). */
  composer(name: TileName): string {
    return `${name}:${this.shown[name]}`;
  }

  tile(name: TileName) {
    return within(screen.getByTestId(`tile-${name}`));
  }

  composerScope(name: TileName) {
    return within(this.tile(name).getByTestId(`session-tile-composer-${WT}`));
  }

  textarea(name: TileName): HTMLTextAreaElement {
    return this.composerScope(name).getByTestId('message-input-textarea') as HTMLTextAreaElement;
  }

  async show(name: TileName, instanceId: string): Promise<void> {
    this.shown = { ...this.shown, [name]: instanceId };
    this.view?.rerender(this.tree());
    await flush();
  }

  async setRoster(roster: Roster): Promise<void> {
    this.roster = roster;
    this.view?.rerender(this.tree());
    await flush();
  }

  enter(name: TileName): void {
    fireEvent.keyDown(this.textarea(name), { key: 'Enter', code: 'Enter' });
  }

  async send(name: TileName, text: string): Promise<number> {
    const before = posts.length;
    fireEvent.change(this.textarea(name), { target: { value: text } });
    this.enter(name);
    await waitFor(() => expect(posts).toHaveLength(before + 1));
    await waitFor(() => expect(this.textarea(name).value).toBe(''));
    return before;
  }

  async answer(k: number, status: number, body: unknown): Promise<void> {
    await act(async () => answers[k](json(status, body)));
    await flush(30);
  }

  /**
   * otherSend: tile `name` sends `text` and it is taken. Should that tile ask first (it holds no tag
   * of its own, so the model says it does not; a worktree-wide hold would), the person says yes there.
   */
  async otherSend(name: TileName, text: string): Promise<void> {
    const k = posts.length;
    fireEvent.change(this.textarea(name), { target: { value: text } });
    this.enter(name);
    await flush(30);
    const confirm = this.composerScope(name).queryByTestId('message-input-retarget-confirm-yes');
    if (confirm) fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(k + 1));
    await waitFor(() => expect(this.textarea(name).value).toBe(''));
    await this.answer(k, 201, { id: `srv-${k}`, role: 'user', content: text, timestamp: new Date().toISOString() });
    this.model.sent(this.composer(name));
  }

  async lastEnter(name: TileName): Promise<void> {
    const asks = this.model.asks(this.composer(name), this.to(name));
    holdAnswers = false;
    const before = posts.length;
    const draft = this.textarea(name).value;
    this.enter(name);
    await flush(30);
    if (asks) {
      expect(posts).toHaveLength(before);
      expect(await this.composerScope(name).findByTestId('message-input-retarget-confirm')).toBeInTheDocument();
      fireEvent.click(this.composerScope(name).getByTestId('message-input-retarget-confirm-no'));
      await flush();
      expect(posts).toHaveLength(before);
      expect(this.textarea(name).value).toBe(draft);
    } else {
      await waitFor(() => expect(posts).toHaveLength(before + 1));
      expect(this.composerScope(name).queryByTestId('message-input-retarget-confirm')).toBeNull();
      this.model.sent(this.composer(name));
    }
  }
}

function storedTags(draftKey: string): Array<{ id: string; original: { instanceId: string; cliToolId: string } }> {
  const raw = window.localStorage.getItem(`${draftKey}:retarget`);
  return raw ? JSON.parse(raw) : [];
}
const instanceKey = (instanceId: string) => `commandmate:draft-message:${WT}:instance:${instanceId}`;

beforeEach(() => {
  window.localStorage.clear();
  posts.length = 0;
  answers.length = 0;
  holdAnswers = true;
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

const X: Target = { id: 'codex-2', tool: 'codex' };

/** return(optimistic) in tile A: sent to X, A then shows `changedTo`, the fence answers. */
async function returnInTileA(run: Run, changedTo: string): Promise<void> {
  const k = await run.send('A', TEXT);
  await run.show('A', changedTo);
  await run.answer(k, 409, fenceBody('target-gone', X));
  run.model.receive(run.composer('A'), X);
  await waitFor(() => expect(run.textarea('A').value).toBe(TEXT));
}

describe('[#4535 r7 INV-V2b] the /sessions tiles: another tile\'s send does not let the text go', () => {
  it('column 1: return(optimistic) in tile A → changeTo → otherSend(tile B, holding the text, to the original) → Enter in A', async () => {
    const run = new Run({ 'codex-2': 'codex', claude: 'claude' }, { A: 'codex-2', B: 'codex-2' });
    await run.mount();
    await returnInTileA(run, 'claude');
    await run.otherSend('B', `${TEXT} — and the tests`);
    await run.lastEnter('A');
  });

  it('column 4: return(discard) → changeTo (tool-changed) → otherSend(tile B) → Enter in A; one tag next to the draft', async () => {
    const original: Target = { id: 'agent-1', tool: 'codex' };
    const run = new Run({ 'agent-1': 'codex', 'codex-2': 'codex' }, { A: 'agent-1', B: 'codex-2' });
    await run.mount();
    const first = await run.send('A', TEXT);
    await run.answer(first, 409, PROMPT_WAITING);
    await waitFor(() => expect(run.tile('A').getAllByTestId('chat-pending-retry')).toHaveLength(1));
    fireEvent.click(run.tile('A').getAllByTestId('chat-pending-retry')[0]);
    await waitFor(() => expect(posts).toHaveLength(first + 2));
    await run.answer(first + 1, 409, fenceBody('tool-changed', original));
    // A retry's refusal is not handed back (T20); the row stays, failed.
    expect(run.textarea('A').value).toBe('');
    await run.setRoster({ 'agent-1': 'claude', 'codex-2': 'codex' });
    fireEvent.click(run.tile('A').getAllByTestId('chat-pending-discard')[0]);
    await flush(30);
    run.model.receive(run.composer('A'), original);
    await waitFor(() => expect(run.textarea('A').value).toBe(TEXT));
    const tags = storedTags(instanceKey('agent-1'));
    expect(tags).toHaveLength(1);
    expect(tags[0].original).toEqual({ instanceId: original.id, cliToolId: original.tool });
    await run.otherSend('B', `${TEXT} — and the tests`);
    await run.lastEnter('A');
  });

  it('column 8: return → changeTo → tileSwitch (another instance and back) → Enter', async () => {
    const run = new Run({ 'codex-2': 'codex', claude: 'claude', 'codex-4': 'codex' }, { A: 'codex-2', B: 'codex-4' });
    await run.mount();
    await returnInTileA(run, 'claude');
    await run.show('A', 'codex-4');
    await waitFor(() => expect(run.textarea('A').value).toBe(''));
    await run.show('A', 'claude');
    await waitFor(() => expect(run.textarea('A').value).toBe(TEXT));
    await run.lastEnter('A');
  });

  it('column 8: return → changeTo → reload → Enter', async () => {
    const run = new Run({ 'codex-2': 'codex', claude: 'claude', 'codex-4': 'codex' }, { A: 'codex-2', B: 'codex-4' });
    await run.mount();
    await returnInTileA(run, 'claude');
    await flush(600);
    run.unmount();
    await run.mount();
    await waitFor(() => expect(run.textarea('A').value).toBe(TEXT));
    await run.lastEnter('A');
  });

  it('column 10 (positive control): the To still the original target — POST 1, no question', async () => {
    const run = new Run({ 'codex-2': 'codex', 'codex-4': 'codex' }, { A: 'codex-2', B: 'codex-4' });
    await run.mount();
    const k = await run.send('A', TEXT);
    await run.answer(k, 409, fenceBody('dispatch-changed', X));
    run.model.receive(run.composer('A'), X);
    await waitFor(() => expect(run.textarea('A').value).toBe(TEXT));
    await run.lastEnter('A');
    expect(storedTags(instanceKey('codex-2'))).toEqual([]);
  });
});
