/**
 * Issue #4389: under a /sessions role filter, a tile's instance switch offers only the matching
 * instances, shows the first match first, hides the switch for a single match, and moves to the
 * first match when the instance on screen drops out. Without `instanceIds` the tile is as before.
 *
 * Positive control: red before #4389 (the tile ignored `instanceIds` and always offered and
 * started at the whole roster). Negative control: no `instanceIds` keeps the whole roster.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
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
import { ToastProvider } from '@/components/common/Toast';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { Worktree } from '@/types/models';

import { selectTileInstances } from '@/components/sessions/SessionTile';

function worktree(): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude', 'codex'],
    agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 2 },
    ],
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

function shownInstance(): string | undefined {
  const calls = useTerminalPanePollingMock.mock.calls;
  return (calls[calls.length - 1]?.[0] as { instanceId?: string } | undefined)?.instanceId;
}

function renderTile(instanceIds?: readonly string[]) {
  const ui = (ids?: readonly string[]) => (
    <ToastProvider>
      <SessionTile worktree={worktree()} enabled instanceIds={ids} />
    </ToastProvider>
  );
  const view = render(ui(instanceIds));
  const tile = within(view.container);
  return {
    select: () => tile.queryByTestId('session-tile-instance-wt-1') as HTMLSelectElement | null,
    options: () =>
      Array.from((tile.queryByTestId('session-tile-instance-wt-1') as HTMLSelectElement | null)?.options ?? []).map(
        (o) => o.value,
      ),
    show: (id: string) => fireEvent.change(tile.getByTestId('session-tile-instance-wt-1'), { target: { value: id } }),
    rerender: (ids?: readonly string[]) => view.rerender(ui(ids)),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
  mockPane();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('[#4389] a /sessions tile under a role filter', () => {
  it('offers only the matching instances and starts at the first match', () => {
    const tile = renderTile(['codex', 'codex-2']);
    expect(tile.options()).toEqual(['codex', 'codex-2']);
    expect(tile.select()?.value).toBe('codex');
    expect(shownInstance()).toBe('codex');
  });

  it('a single match hides the switch and shows that instance', () => {
    const tile = renderTile(['codex-2']);
    expect(tile.select()).toBeNull();
    expect(shownInstance()).toBe('codex-2');
  });

  it('moves to the first match when the instance on screen drops out', () => {
    const tile = renderTile(['codex', 'codex-2']);
    tile.show('codex-2');
    expect(shownInstance()).toBe('codex-2');
    tile.rerender(['claude', 'codex']);
    expect(tile.options()).toEqual(['claude', 'codex']);
    expect(shownInstance()).toBe('claude');
  });

  it('control: without instanceIds the whole roster is offered, from the first', () => {
    const tile = renderTile();
    expect(tile.options()).toEqual(['claude', 'codex', 'codex-2']);
    expect(shownInstance()).toBe('claude');
  });
});

describe('[#4389] selectTileInstances', () => {
  const roster = worktree().agentInstances!;
  it('keeps roster order, ignores unknown ids', () => {
    expect(selectTileInstances(roster, ['codex-2', 'zzz', 'claude']).map((i) => i.id)).toEqual(['claude', 'codex-2']);
  });
  it('undefined keeps all; nothing left keeps all', () => {
    expect(selectTileInstances(roster, undefined)).toHaveLength(3);
    expect(selectTileInstances(roster, ['zzz'])).toHaveLength(3);
  });
});

describe('[#4389-f1] the tile heading link under a role filter', () => {
  const headingHref = (ids?: readonly string[]) => {
    const view = render(
      <ToastProvider>
        <SessionTile worktree={worktree()} enabled instanceIds={ids} />
      </ToastProvider>,
    );
    return within(view.container).getByTestId('session-tile-branch-wt-1').getAttribute('href');
  };

  it('T1: carries ?instance= of the first match', () => {
    expect(headingHref(['codex', 'codex-2'])).toBe('/worktrees/wt-1?instance=codex');
  });

  it('T2: equals the list row href for the same worktree and filter', async () => {
    const { buildSessionRowHref } = await import('@/lib/sidebar-utils');
    expect(headingHref(['codex-2', 'codex'])).toBe(
      buildSessionRowHref({ worktreeId: 'wt-1', instanceId: 'codex-2' }),
    );
  });

  it('T3: without a filter the link is the plain worktree link', () => {
    expect(headingHref()).toBe('/worktrees/wt-1');
  });
});
