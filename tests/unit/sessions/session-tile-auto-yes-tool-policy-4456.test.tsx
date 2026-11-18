/**
 * Issue #4456 item 3: the `/sessions` tile's Auto-Yes shows a tool-policy
 * refusal (409 `TOOL_POLICY_DENIED`) with its reason and the terms / FAQ links,
 * as the worktree screen does (I3). Before this the tile's hook dropped every
 * non-OK answer, so the switch just stayed OFF with nothing said.
 *
 * Negative controls: another failure (another status, a 409 of another code,
 * the network) still resolves quietly and draws no notice.
 *
 * Harness from `session-tile-auto-yes-restart-3730.test.tsx`: `MessageInput` and
 * `AutoYesToggle` are real, the two pollers and the chat body are stubbed.
 *
 * @vitest-environment jsdom
 */


import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, act, within, cleanup } from '@testing-library/react';
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
import { useSessionTileAutoYes } from '@/hooks/useSessionTileAutoYes';
import { ToolPolicyRefusalError } from '@/lib/tool-policy/refusal-view';

const ONLINE: PendingConnectivity = { offline: false, reachable: true };
const TERMS = 'https://antigravity.google/terms';
const FAQ = 'https://antigravity.google/docs/faq';
const REASON = 'Refused by default for antigravity under the terms §6 (4456). Nothing was typed.';
const NOTICE = 'auto-yes-tool-policy-refusal';

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    branch: 'feature/4456',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    agentInstances: [{ id: 'antigravity', cliTool: 'antigravity', alias: '', order: 0 }],
    autoYesByInstance: {},
    ...overrides,
  } as Worktree;
}

function answer(status: number, body: unknown): void {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const REFUSAL_BODY = {
  code: 'TOOL_POLICY_DENIED',
  error: REASON,
  reason: 'ANTIGRAVITY_CONSUMER_TERMS',
  links: { terms: TERMS, faq: FAQ },
  cliToolId: 'antigravity',
  instanceId: 'antigravity',
};

function composer(): HTMLElement {
  return screen.getByTestId('session-tile-composer-wt-1');
}

async function enableOnTile(): Promise<void> {
  fireEvent.click(within(composer()).getByRole('switch'));
  const confirm = await screen.findByTestId('confirm-button');
  await act(async () => {
    fireEvent.click(confirm);
  });
}

beforeEach(() => {
  cache.refresh.mockReset();
  cache.refresh.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('[#4456] SessionTile: a tool-policy refusal of the Auto-Yes enabling', () => {
  it('positive: 409 TOOL_POLICY_DENIED shows the reason and both links; the switch stays OFF (4456)', async () => {
    answer(409, REFUSAL_BODY);
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    await enableOnTile();
    const message = await within(composer()).findByTestId(`${NOTICE}-message`);
    expect(message.textContent).toBe(REASON);
    expect(within(composer()).getByTestId(`${NOTICE}-terms`).getAttribute('href')).toBe(TERMS);
    expect(within(composer()).getByTestId(`${NOTICE}-faq`).getAttribute('href')).toBe(FAQ);
    expect(within(composer()).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['500', 500, { error: 'boom' }],
    ['409 of another code', 409, { code: 'SESSION_NOT_RUNNING', error: 'no session' }],
    ['409 without web links', 409, { ...REFUSAL_BODY, links: { terms: 'javascript:alert(1)', faq: FAQ } }],
  ])('negative: %s draws no notice and the switch stays OFF (4456)', async (_label, status, body) => {
    answer(status, body);
    render(<SessionTile worktree={createWorktree()} enabled connectivity={ONLINE} />);
    await enableOnTile();
    expect(within(composer()).queryByTestId(NOTICE)).toBeNull();
    expect(within(composer()).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });
});

describe('[#4456] useSessionTileAutoYes: what toggle() answers', () => {
  const hook = () =>
    renderHook(() => useSessionTileAutoYes({ worktree: createWorktree(), cliToolId: 'antigravity', instanceId: 'antigravity' }));

  it('rejects an enabling refused by the tool policy with ToolPolicyRefusalError (4456)', async () => {
    answer(409, REFUSAL_BODY);
    const { result } = hook();
    let caught: unknown;
    await act(async () => {
      await result.current.toggle({ enabled: true }).catch((err: unknown) => {
        caught = err;
      });
    });
    expect(caught).toBeInstanceOf(ToolPolicyRefusalError);
    expect((caught as ToolPolicyRefusalError).view).toEqual({ message: REASON, links: { terms: TERMS, faq: FAQ } });
    expect(result.current.enabled).toBe(false);
  });

  it('a disabling answered 409 still resolves (only an enabling is refused by the policy) (4456)', async () => {
    answer(409, REFUSAL_BODY);
    const { result } = hook();
    await act(async () => {
      await expect(result.current.toggle({ enabled: false })).resolves.toBeUndefined();
    });
  });

  it('another failure and the network still resolve (4456)', async () => {
    answer(500, { error: 'boom' });
    const { result } = hook();
    await act(async () => {
      await expect(result.current.toggle({ enabled: true })).resolves.toBeUndefined();
    });
    global.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await act(async () => {
      await expect(result.current.toggle({ enabled: true })).resolves.toBeUndefined();
    });
  });
});
