/**
 * The Sessions tile's header dot reads an unreadable frame as "cannot tell"
 * (Issue #2775).
 *
 * Harness from `tests/unit/sessions/session-tile-2509.test.tsx` (network hooks
 * stubbed; this file is about markup). The entry is the shape the list API
 * publishes for a frame that fell to the detector's floor.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const pushMock = vi.fn();

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: pushMock }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

const paneState = vi.hoisted(() => ({
  terminal: {
    output: '',
    realtimeSnippet: '',
    isRunning: false,
    isThinking: false,
    sessionStatus: '',
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    composerText: '',
    attaching: true,
    autoScroll: true,
  },
  prompt: { visible: false, data: null, messageId: null, answering: false },
}));

const useTerminalPanePollingMock = vi.hoisted(() => vi.fn());
const useSplitMessagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

// Records what the tile asks its chat surface to render, so the instance
// selector's effect on the surface is observable without the real transcript.
vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: ({ worktreeId, cliToolId, instanceId }: {
    worktreeId: string;
    cliToolId?: string;
    instanceId?: string;
  }) =>
    React.createElement('div', {
      'data-testid': `chat-surface-${worktreeId}`,
      'data-cli-tool-id': cliToolId,
      'data-instance-id': instanceId,
    }),
}));

import { SessionTile } from '@/components/sessions/SessionTile';
import type { Worktree } from '@/types/models';

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  } as Worktree;
}

beforeEach(() => {
  pushMock.mockClear();
  useTerminalPanePollingMock.mockReset();
  useTerminalPanePollingMock.mockReturnValue({
    terminal: paneState.terminal,
    prompt: paneState.prompt,
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
});

function statusDot(): HTMLElement {
  const header = screen.getByTestId('session-tile-wt-1').querySelector('header')!;
  return header.querySelector('span.rounded-full') as HTMLElement;
}

const BASE = {
  isRunning: true,
  isWaitingForResponse: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
} as const;

describe('[#2775] SessionTile header dot', () => {
  it('is the "cannot tell" ring, labelled Unknown, for an unclassified session', () => {
    render(
      <SessionTile
        worktree={createWorktree({
          sessionStatusByInstance: {
            claude: { ...BASE, isProcessing: false, statusEvidence: 'none', sessionStatusReason: 'default', isUnclassified: true },
          },
        })}
        enabled
      />,
    );
    const dot = statusDot();

    expect(dot).toHaveAttribute('data-unclassified', 'true');
    expect(dot.className).toContain('bg-transparent');
    expect(dot.className).not.toMatch(/animate-status-glow/);
    expect(dot.getAttribute('aria-label')).toBe('Unknown');
  });

  it('still glows for a running with positive evidence', () => {
    render(
      <SessionTile
        worktree={createWorktree({
          sessionStatusByInstance: {
            claude: { ...BASE, isProcessing: true, statusEvidence: 'positive', sessionStatusReason: 'thinking_indicator' },
          },
        })}
        enabled
      />,
    );
    const dot = statusDot();

    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot.getAttribute('aria-label')).toBe('Running');
  });
});
