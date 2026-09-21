/**
 * Review's per-agent dots read an unreadable frame as "cannot tell"
 * (Issue #2775).
 *
 * Review draws its own `CliDot` from `SIDEBAR_STATUS_CONFIG`, where `running`
 * is the (deprecated) spinner — so the regression this Issue fixes looked like
 * a spinning ring here. The entries are the shapes the list API publishes.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/review',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

import ReviewTab from '@/components/review/ReviewTab';

const BASE = {
  isRunning: true,
  isWaitingForResponse: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
};

const ROW = {
  id: 'wt-2775',
  name: 'feature/2775',
  repositoryName: 'repo',
  status: 'in_review',
  reviewStatus: 'in_review',
  selectedAgents: ['claude', 'codex'],
  sessionStatusByCli: {
    claude: { ...BASE, isProcessing: true, statusEvidence: 'positive', sessionStatusReason: 'thinking_indicator' },
    codex: { ...BASE, isProcessing: false, statusEvidence: 'none', sessionStatusReason: 'default', isUnclassified: true },
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dotTitled(prefix: string): HTMLElement {
  const row = screen.getByTestId('review-item-wt-2775');
  const dot = Array.from(row.querySelectorAll<HTMLElement>('span[title]')).find((el) =>
    (el.getAttribute('title') ?? '').startsWith(prefix),
  );
  if (!dot) throw new Error(`no dot titled ${prefix}`);
  return dot;
}

describe('[#2775] ReviewTab CliDot', () => {
  it('draws the ring for the unclassified agent and keeps the spinner for the working one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ worktrees: [ROW], repositories: [] }),
      }),
    );
    render(React.createElement(ReviewTab));
    await waitFor(() => expect(screen.getByTestId('review-item-wt-2775')).toBeTruthy());

    const codex = dotTitled('Codex:');
    expect(codex.getAttribute('title')).toBe('Codex: Unknown');
    expect(codex).toHaveAttribute('data-unclassified', 'true');
    expect(codex.className).toContain('bg-transparent');
    expect(codex.className).not.toMatch(/animate-spin/);

    const claude = dotTitled('Claude:');
    expect(claude.getAttribute('title')).toBe('Claude: Running');
    expect(claude).not.toHaveAttribute('data-unclassified');
    expect(claude.className).toMatch(/animate-spin/);
  });
});
