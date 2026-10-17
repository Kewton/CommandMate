/**
 * The `/sessions` tile's Auto-Yes toggle says "released by restart" too
 * (Issue #3730, from the consistency review).
 *
 * The tile reads the list row, never a request of its own (#2512). The list
 * carries a restart release beside `autoYesByInstance`, in
 * `autoYesStopReasonByInstance` (that map holds armed instances only), and
 * `readTileAutoYes` now reads it — so the tile and the worktree screen say the
 * same thing about the same instance.
 *
 * Positive control: before this, the tile read `autoYesByInstance` alone and
 * rendered a released instance as a plain OFF; the label tests fail there.
 * Negative controls: a plain OFF, another instance's release, an unknown
 * reason and an armed instance render as before.
 *
 * Harness from `session-tile-auto-yes-2512.test.tsx`: `MessageInput` and
 * `AutoYesToggle` are real, the two pollers and the chat body are stubbed.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { PendingConnectivity } from '@/hooks/usePendingMessages';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: () => ({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: true, isThinking: false, sessionStatus: 'ready',
      isSelectionListActive: false, isPagerActive: false, isDismissablePanelActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: ({ worktreeId }: { worktreeId: string }) =>
    React.createElement('div', { 'data-testid': `chat-surface-${worktreeId}` }),
}));

const cache = vi.hoisted(() => ({ refresh: vi.fn(() => Promise.resolve()) }));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cache,
}));

import { SessionTile } from '@/components/sessions/SessionTile';
import { AUTO_YES_OFF, readTileAutoYes } from '@/hooks/useSessionTileAutoYes';

const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const HOUR_MS = 60 * 60 * 1000;
const LABEL = 'auto-yes-released-by-restart';

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    branch: 'feature/3730',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    agentInstances: [
      { id: 'codex', cliTool: 'codex', alias: '', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'レビュー担当', order: 1 },
    ],
    autoYesByInstance: {},
    ...overrides,
  } as Worktree;
}

function composer(): HTMLElement {
  return screen.getByTestId('session-tile-composer-wt-1');
}

function label(): HTMLElement | null {
  return within(composer()).queryByTestId(LABEL);
}

beforeEach(() => {
  cache.refresh.mockReset();
  cache.refresh.mockImplementation(() => Promise.resolve());
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return {
      ok: true,
      json: async () => ({
        enabled: body.enabled === true,
        expiresAt: body.enabled === true ? Date.now() + HOUR_MS : null,
        pollingStarted: body.enabled === true,
      }),
    };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('[#3730] SessionTile: the restart label', () => {
  it('positive: a released instance shows the label beside the OFF switch', () => {
    render(
      <SessionTile
        worktree={createWorktree({ autoYesStopReasonByInstance: { codex: 'server-restart' } })}
        enabled
        connectivity={ONLINE}
      />,
    );

    expect(label()).not.toBeNull();
    expect(within(composer()).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('follows the instance selector — only the released instance says it', () => {
    render(
      <SessionTile
        worktree={createWorktree({ autoYesStopReasonByInstance: { 'codex-2': 'server-restart' } })}
        enabled
        connectivity={ONLINE}
      />,
    );
    expect(label()).toBeNull();

    fireEvent.change(screen.getByTestId('session-tile-instance-wt-1'), { target: { value: 'codex-2' } });

    expect(label()).not.toBeNull();
  });

  it('turning it on from the tile replaces the label with the grant', async () => {
    render(
      <SessionTile
        worktree={createWorktree({ autoYesStopReasonByInstance: { codex: 'server-restart' } })}
        enabled
        connectivity={ONLINE}
      />,
    );
    fireEvent.click(within(composer()).getByRole('switch'));
    const confirm = await screen.findByTestId('confirm-button');
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(within(composer()).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(label()).toBeNull();
  });

  it.each([
    ['a plain OFF (no field: a server older than #3730)', {}],
    ['an unknown reason', { autoYesStopReasonByInstance: { codex: 'something-new' } as never }],
  ])('negative: %s shows no label', (_label, overrides) => {
    render(<SessionTile worktree={createWorktree(overrides)} enabled connectivity={ONLINE} />);
    expect(label()).toBeNull();
  });

  it('negative: an armed instance shows its countdown, not the label', () => {
    render(
      <SessionTile
        worktree={createWorktree({
          autoYesByInstance: { codex: { enabled: true, expiresAt: Date.now() + HOUR_MS } },
          autoYesStopReasonByInstance: { codex: 'server-restart' },
        })}
        enabled
        connectivity={ONLINE}
      />,
    );
    expect(within(composer()).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(label()).toBeNull();
  });
});

describe('[#3730] readTileAutoYes and the restart release', () => {
  it('reads the release as OFF with stopReason server-restart', () => {
    expect(
      readTileAutoYes(createWorktree({ autoYesStopReasonByInstance: { codex: 'server-restart' } }), 'codex'),
    ).toEqual({ enabled: false, expiresAt: null, stopReason: 'server-restart' });
  });

  it('negative: anything else off is the shared OFF object, as before', () => {
    expect(readTileAutoYes(createWorktree(), 'codex')).toBe(AUTO_YES_OFF);
    expect(
      readTileAutoYes(createWorktree({ autoYesStopReasonByInstance: { 'codex-2': 'server-restart' } }), 'codex'),
    ).toBe(AUTO_YES_OFF);
  });
});
