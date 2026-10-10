/**
 * The phone's "To: <agent> · <branch>" line (Issue #3515).
 *
 * #3514 put this line above each PC split's composer. The phone's composer is
 * docked below this tab, so the tab draws it, in the same words
 * (`terminal.composerTarget*` from the real `locales/en/worktree.json`) and
 * from the same inputs the PC uses: the instance's alias-aware label and the
 * checked-out branch, falling back to the worktree's name.
 *
 * Negative controls: no worktrees cache above → "To: <agent>" and nothing
 * else changes; the direct-input keyboard open → the line stands down.
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
import type { CLIToolType } from '@/lib/cli-tools/types';
import enWorktree from '../../../../locales/en/worktree.json';

const WORKTREE_ID = 'wt-3515-target';

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

function publishWorktree(worktree: Record<string, unknown> | null): void {
  cacheState.value = worktree
    ? {
        worktrees: [
          { id: 'wt-other', name: 'other', gitStatus: { currentBranch: 'wrong-branch' } },
          { id: WORKTREE_ID, ...worktree },
        ],
        refresh: vi.fn(() => Promise.resolve()),
      }
    : null;
}

function renderTab(props: { cliToolId?: CLIToolType; instanceId?: string; directInputOpen?: boolean } = {}) {
  return render(
    <MobileTerminalTab
      worktreeId={WORKTREE_ID}
      cliToolId={props.cliToolId ?? 'claude'}
      instanceId={props.instanceId}
      directInputOpen={props.directInputOpen}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  realtimeListeners.clear();
  mockPaneState();
});

afterEach(() => {
  cacheState.value = null;
});

describe('MobileTerminalTab composer target (Issue #3515)', () => {
  it('says the agent and the checked-out branch, in the PC words', () => {
    publishWorktree({ name: 'wt-name', gitStatus: { currentBranch: 'feature/3515-x' } });
    renderTab();
    const line = screen.getByTestId('mobile-composer-target');
    expect(line).toHaveTextContent(
      format(enWorktree.terminal.composerTarget, { agent: 'Claude', branch: 'feature/3515-x' }),
    );
    expect(line).toHaveAttribute(
      'aria-label',
      format(enWorktree.terminal.composerTargetLabel, { agent: 'Claude', branch: 'feature/3515-x' }),
    );
  });

  it('uses the instance alias and falls back to the worktree name when git cannot tell', () => {
    publishWorktree({
      name: 'wt-name',
      gitStatus: { currentBranch: '(unknown)' },
      agentInstances: [{ id: 'claude-2', cliTool: 'claude', alias: 'Reviewer', order: 1 }],
    });
    renderTab({ instanceId: 'claude-2' });
    expect(screen.getByTestId('mobile-composer-target')).toHaveTextContent(
      format(enWorktree.terminal.composerTarget, { agent: 'Reviewer', branch: 'wt-name' }),
    );
  });

  it('floats over the output region instead of taking a row (#2106 budget)', () => {
    publishWorktree({ name: 'wt-name' });
    renderTab();
    const region = screen.getByTestId('mobile-terminal-region');
    const line = screen.getByTestId('mobile-composer-target');
    expect(region).toContainElement(line);
    expect(region.className).toContain('relative');
    expect(line.className).toContain('absolute');
    expect(line.className).toContain('pointer-events-none');
  });

  it('names only the agent with no worktrees cache above (negative control)', () => {
    publishWorktree(null);
    renderTab({ cliToolId: 'codex' });
    expect(screen.getByTestId('mobile-composer-target')).toHaveTextContent(
      format(enWorktree.terminal.composerTargetNoBranch, { agent: 'Codex' }),
    );
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });

  it('stands down while the direct-input keyboard is open (negative control)', () => {
    publishWorktree({ name: 'wt-name' });
    renderTab({ directInputOpen: true });
    expect(screen.queryByTestId('mobile-composer-target')).toBeNull();
  });
});
