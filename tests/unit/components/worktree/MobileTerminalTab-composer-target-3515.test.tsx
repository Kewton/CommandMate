/**
 * The phone's "To: <agent> · <branch>" line (Issue #3515).
 *
 * #3514 put this line above each PC split's composer. The phone's composer is
 * docked below this tab, so the tab draws it, in the same words
 * (`terminal.composerTarget*` from the real `locales/en/worktree.json`) and
 * from the same inputs the PC uses: the instance's alias-aware label and the
 * DETAIL screen's checked-out branch (`MobileContent` resolves it like
 * `WorktreeDetailDesktop`), falling back to the worktree's name. The list
 * cache (`/api/worktrees`, no `gitStatus`) is never read for it.
 *
 * Negative controls: no git info → the worktree name; no branch at all →
 * "To: <agent>"; the direct-input keyboard open → the line stands down.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RealtimeEvent } from '@/lib/realtime/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

const { useTerminalPanePollingMock, useSplitMessagesMock, realtimeListeners, cacheState } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  realtimeListeners: new Set<(event: RealtimeEvent) => void>(),
  /** What the app-wide worktrees cache publishes; null = no provider above. */
  cacheState: { value: null as null | { worktrees: unknown[]; refresh: () => Promise<void> } },
}));
// The worktrees cache: the sidebar's `/api/worktrees` list, which is where the
// row reads `sessionStatusByInstance[instance].model` from.
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cacheState.value,
  useWorktreesCacheContext: () => cacheState.value,
  WorktreesCacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));
// The realtime seam: the listener the tab registers is captured so a test can
// deliver a frame the way the socket would, without a provider or a socket.
vi.mock('@/hooks/useRealtimeConnection', async () => {
  const ReactModule = await import('react');
  return {
    useRealtime: () => ({
      status: 'connected',
      connected: true,
      subscribe: () => {},
      unsubscribe: () => {},
      addListener: (listener: (event: RealtimeEvent) => void) => {
        realtimeListeners.add(listener);
        return () => realtimeListeners.delete(listener);
      },
    }),
    useRealtimeListener: (listener: (event: RealtimeEvent) => void) => {
      const ref = ReactModule.useRef(listener);
      ref.current = listener;
      ReactModule.useEffect(() => {
        const wrapped = (event: RealtimeEvent) => ref.current(event);
        realtimeListeners.add(wrapped);
        return () => {
          realtimeListeners.delete(wrapped);
        };
      }, []);
    },
    useRealtimeSubscription: () => {},
  };
});

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';
import { MobileContent } from '@/components/worktree/WorktreeDetailMobile';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import enWorktree from '../../../../locales/en/worktree.json';

const WORKTREE_ID = 'wt-3515-target';

type MobileContentProps = React.ComponentProps<typeof MobileContent>;

const refreshMock = vi.fn(() => Promise.resolve());

function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '',
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: refreshMock,
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
}

function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

const CACHE_ONLY_BRANCH = 'cache-only-branch';

/**
 * The list cache, as `/api/worktrees` really publishes it: no `gitStatus`.
 * One row carries a branch anyway, so a line that read the cache would show it.
 */
function publishListCache(): void {
  cacheState.value = {
    worktrees: [{ id: WORKTREE_ID, name: 'wt-name', gitStatus: { currentBranch: CACHE_ONLY_BRANCH } }],
    refresh: vi.fn(() => Promise.resolve()),
  };
}

function detailWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return { id: WORKTREE_ID, name: 'wt-name', path: '/tmp/wt', repositoryPath: '/tmp/repo', repositoryName: 'repo', ...overrides } as Worktree;
}

/** The detail screen's terminal tab, mounted the way the phone mounts it. */
function renderThroughDetail(worktree: Worktree | null, extra: Partial<MobileContentProps> = {}) {
  const props = {
    activeTab: 'terminal',
    worktreeId: WORKTREE_ID,
    worktree,
    messages: [],
    cliToolId: 'claude',
    ...extra,
  } as unknown as MobileContentProps;
  return render(<MobileContent {...props} />);
}

function renderTab(props: { cliToolId?: CLIToolType; instanceId?: string; directInputOpen?: boolean; branchName?: string | null } = {}) {
  return render(
    <MobileTerminalTab
      worktreeId={WORKTREE_ID}
      cliToolId={props.cliToolId ?? 'claude'}
      instanceId={props.instanceId}
      directInputOpen={props.directInputOpen}
      branchName={props.branchName}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  realtimeListeners.clear();
  mockPaneState();
  publishListCache();
});

afterEach(() => {
  cacheState.value = null;
});

describe('MobileTerminalTab composer target (Issue #3515)', () => {
  it('says the agent and the checked-out branch, in the PC words', () => {
    // Positive control: the worktree name and the current branch differ, and
    // the branch comes from the DETAIL screen's git info.
    renderThroughDetail(detailWorktree({ gitStatus: { currentBranch: 'feature/3515-x', initialBranch: 'main', isBranchMismatch: true, commitHash: 'abc', isDirty: false } }));
    const line = screen.getByTestId('mobile-composer-target');
    expect(line).toHaveTextContent(
      format(enWorktree.terminal.composerTarget, { agent: 'Claude', branch: 'feature/3515-x' }),
    );
    expect(line).toHaveAttribute(
      'aria-label',
      format(enWorktree.terminal.composerTargetLabel, { agent: 'Claude', branch: 'feature/3515-x' }),
    );
    expect(line).not.toHaveTextContent(CACHE_ONLY_BRANCH);
  });

  it('uses the instance alias and falls back to the worktree name when git cannot tell', () => {
    renderThroughDetail(
      detailWorktree({ gitStatus: { currentBranch: '(unknown)', initialBranch: null, isBranchMismatch: false, commitHash: '', isDirty: false } }),
      {
        instanceId: 'claude-2',
        instances: [{ id: 'claude-2', cliTool: 'claude', alias: 'Reviewer', order: 1 }],
      } as Partial<MobileContentProps>,
    );
    expect(screen.getByTestId('mobile-composer-target')).toHaveTextContent(
      format(enWorktree.terminal.composerTarget, { agent: 'Reviewer', branch: 'wt-name' }),
    );
  });

  it('falls back to the worktree name when the detail has no git info, never the list cache (negative control)', () => {
    renderThroughDetail(detailWorktree());
    const line = screen.getByTestId('mobile-composer-target');
    expect(line).toHaveTextContent(format(enWorktree.terminal.composerTarget, { agent: 'Claude', branch: 'wt-name' }));
    expect(line).not.toHaveTextContent(CACHE_ONLY_BRANCH);
  });

  it('floats over the output region instead of taking a row (#2106 budget)', () => {
    renderTab({ branchName: 'main' });
    const region = screen.getByTestId('mobile-terminal-region');
    const line = screen.getByTestId('mobile-composer-target');
    expect(region).toContainElement(line);
    expect(region.className).toContain('relative');
    expect(line.className).toContain('absolute');
    expect(line.className).toContain('pointer-events-none');
  });

  it('names only the agent with no branch given (negative control)', () => {
    renderTab({ cliToolId: 'codex' });
    expect(screen.getByTestId('mobile-composer-target')).toHaveTextContent(
      format(enWorktree.terminal.composerTargetNoBranch, { agent: 'Codex' }),
    );
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });

  it('stands down while the direct-input keyboard is open (negative control)', () => {
    renderTab({ directInputOpen: true, branchName: 'main' });
    expect(screen.queryByTestId('mobile-composer-target')).toBeNull();
  });
});
