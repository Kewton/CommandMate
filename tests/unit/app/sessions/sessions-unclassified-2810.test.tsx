/**
 * `/sessions` (list mode) draws an agent whose frame no rule could read as
 * "cannot tell" (Issue #2810, the look #2775 gave the Sessions tile).
 *
 * Before this Issue the row read `deriveCliStatus` alone: the unreadable agent
 * derived `ready`, which is not a working status, so it was folded into the
 * "+N" idle counter as one more gray dot. It now gets its own chip, drawn with
 * the shared ring and labelled 不明.
 *
 * Harness from `sessions-default-agents-2065.test.tsx`; the entries are the
 * shapes the list API publishes (`worktree-status-unclassified-2775`). The
 * real `ja` dictionary is used so the word itself is pinned.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import React from 'react';
import { UNCLASSIFIED_STATUS_DOT_CLASS } from '@/components/sidebar/BranchStatusIndicator';

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

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

let mockWorktrees: Array<Record<string, unknown>> = [];
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import SessionsPage from '@/app/sessions/page';

const BASE = {
  isRunning: true,
  isWaitingForResponse: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
} as const;

const UNCLASSIFIED = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'none',
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING = {
  ...BASE,
  isProcessing: true,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

const READY = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'positive',
  sessionStatusReason: 'input_prompt',
};

function row(sessionStatusByCli: Record<string, unknown>) {
  return {
    id: 'wt-2810',
    name: 'fix/2810',
    path: '/tmp/wt-2810',
    repositoryPath: '/tmp/repo',
    repositoryName: 'CommandMate',
    selectedAgents: ['claude', 'codex'],
    sessionStatusByCli,
  };
}

/** The dot inside one agent's labelled chip. */
function chipDot(agent: string): HTMLElement {
  const chip = screen.getByTestId(`session-agent-${agent}`);
  return chip.querySelector('span.rounded-full') as HTMLElement;
}

beforeEach(() => {
  mockWorktrees = [];
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('[#2810] /sessions list: an unclassified agent', () => {
  it('gets its own chip, drawn as the "cannot tell" ring and labelled 不明', () => {
    mockWorktrees = [row({ codex: UNCLASSIFIED })];

    render(<SessionsPage />);

    const dot = chipDot('codex');
    expect(dot).toHaveAttribute('data-unclassified', 'true');
    for (const cls of UNCLASSIFIED_STATUS_DOT_CLASS.split(' ')) {
      expect(dot.className).toContain(cls);
    }
    expect(dot.className).not.toMatch(/animate-status/);
    expect(dot.className).not.toContain('bg-success');
    expect(dot.getAttribute('aria-label')).toBe('Codex: 不明');
    // claude (no entry) is still the only member of the idle counter.
    const cluster = screen.getByTestId('session-idle-cluster-wt-2810');
    expect(within(cluster).getByText('+1')).toBeTruthy();
  });

  it('does not light the card up as active — "cannot tell" is not work', () => {
    mockWorktrees = [row({ codex: UNCLASSIFIED })];

    render(<SessionsPage />);

    expect(screen.getByTestId('session-item-wt-2810').className).not.toContain('border-accent-500/40');
  });

  it('a running with positive evidence still glows, labelled 実行中', () => {
    mockWorktrees = [row({ codex: THINKING })];

    render(<SessionsPage />);

    const dot = chipDot('codex');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-glow/);
    expect(dot.className).not.toContain('bg-transparent');
    expect(dot.getAttribute('aria-label')).toBe('Codex: 実行中');
  });

  it('a ready that was actually read stays in the idle counter, with no chip', () => {
    mockWorktrees = [row({ codex: READY })];

    render(<SessionsPage />);

    expect(screen.queryByTestId('session-agent-codex')).toBeNull();
    const cluster = screen.getByTestId('session-idle-cluster-wt-2810');
    expect(within(cluster).getByText('+2')).toBeTruthy();
  });

  it('a waiting that carries the flag keeps its waiting dot', () => {
    mockWorktrees = [
      row({ codex: { ...UNCLASSIFIED, isWaitingForResponse: true, waitingKind: 'prompt' } }),
    ];

    render(<SessionsPage />);

    const dot = chipDot('codex');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-attention/);
    expect(dot.getAttribute('aria-label')).toBe('Codex: 応答待ち');
  });
});
