/**
 * `/sessions` falls back to the configured default (Issue #2065).
 *
 * `SessionsPage.test.tsx` gives every fixture an explicit `selectedAgents`, so
 * the fallback branch on the row (`wt.selectedAgents ?? getClientDefault…()`)
 * is never reached there. This file exercises exactly that branch, with the
 * store seeded to a value that differs from the compiled-in constant in both
 * membership and order — the only shape that can tell "reads the store" from
 * "reads the constant".
 *
 * The page renders a labelled chip only for a WORKING agent and collapses the
 * idle ones into a "+N" counter, so the fixtures below mark the seeded agents
 * as running; the counter is then a second, independent read of the same list.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
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
import {
  resetClientDefaultSelectedAgents,
  setClientDefaultSelectedAgents,
} from '@/config/default-agents';

const RUNNING = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
};

/** No `selectedAgents`: the row shape that reaches the fallback. */
function bareRow(sessionStatusByCli: Record<string, unknown>) {
  return {
    id: 'wt-2065',
    name: 'feature/2065',
    path: '/tmp/wt-2065',
    repositoryPath: '/tmp/repo',
    repositoryName: 'MyRepo',
    sessionStatusByCli,
  };
}

/** The labelled (working) chips of the row, in document order. */
function chips(): string[] {
  const row = screen.getByTestId('session-agents-wt-2065');
  return Array.from(row.querySelectorAll('[data-testid^="session-agent-"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('session-agent-', '')
  );
}

beforeEach(() => {
  mockWorktrees = [];
  vi.clearAllMocks();
  resetClientDefaultSelectedAgents();
});

afterEach(() => {
  cleanup();
  resetClientDefaultSelectedAgents();
});

describe('/sessions row fallback follows the configured default (Issue #2065)', () => {
  it('uses the constant while nothing has been seeded', () => {
    mockWorktrees = [bareRow({ claude: RUNNING, codex: RUNNING, antigravity: RUNNING })];

    render(<SessionsPage />);

    expect(chips()).toEqual(['claude', 'codex', 'antigravity']);
  });

  it('renders the seeded agents, in the seeded order', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);
    mockWorktrees = [bareRow({ claude: RUNNING, codex: RUNNING, antigravity: RUNNING })];

    render(<SessionsPage />);

    expect(chips()).toEqual(['codex', 'claude']);
    // antigravity is running, so it would appear if the row still read the
    // constant — its absence is the assertion, not an omission.
    expect(chips()).not.toContain('antigravity');
  });

  /**
   * The idle counter is derived from the same list (`agents.length` minus the
   * working ones), so it is a second read of the fallback that does not go
   * through the chips.
   */
  it('counts idle agents against the seeded list, not the constant', () => {
    // FOUR seeded agents, one running. The constant has three, so a row still
    // reading it would render "+2" here — the count is what separates them,
    // which is why the seeded list must not be three long.
    setClientDefaultSelectedAgents(['codex', 'claude', 'gemini', 'copilot']);
    mockWorktrees = [bareRow({ codex: RUNNING })];

    render(<SessionsPage />);

    expect(chips()).toEqual(['codex']);
    const cluster = screen.getByTestId('session-idle-cluster-wt-2065');
    expect(within(cluster).getByText('+3')).toBeTruthy();
  });

  it('still lets a row with its own selectedAgents ignore the default', () => {
    setClientDefaultSelectedAgents(['codex', 'claude']);
    mockWorktrees = [
      {
        ...bareRow({ gemini: RUNNING, copilot: RUNNING }),
        selectedAgents: ['gemini', 'copilot'],
      },
    ];

    render(<SessionsPage />);

    expect(chips()).toEqual(['gemini', 'copilot']);
  });
});
