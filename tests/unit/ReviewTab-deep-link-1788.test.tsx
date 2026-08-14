/**
 * @vitest-environment jsdom
 *
 * `/review?filter=approval` opens on the approval list (Issue #1788).
 *
 * The approval filter is the actual "needs attention" list — its predicate is
 * `isWaitingForResponse === true`, the same one the badge counts — so this deep
 * link is what makes the badge, the mobile nav bubble and Home's Waiting stat
 * lead somewhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

const searchParamsMock = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
  usePathname: () => '/review',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import ReviewTab from '@/components/review/ReviewTab';

const mockFetch = vi.fn();

function wt(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    name: id,
    path: `/${id}`,
    repositoryPath: '/repo',
    repositoryName: 'Repo',
    ...overrides,
  };
}

const WORKTREES: Worktree[] = [
  wt('needs-you', { isWaitingForResponse: true }),
  wt('in-review-one', { status: 'in_review' }),
  wt('in-review-two', { status: 'in_review' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  searchParamsMock.current = new URLSearchParams();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ worktrees: WORKTREES }) });
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderTab() {
  render(<ReviewTab />);
  await waitFor(() => expect(screen.queryByTestId('review-loading')).toBeNull());
}

describe('ReviewTab initial filter (Issue #1788)', () => {
  it('defaults to In Review with no query', async () => {
    await renderTab();
    expect(screen.getByTestId('review-filter-in_review').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('review-filter-approval').getAttribute('aria-pressed')).toBe('false');
  });

  it('opens on approval for ?filter=approval, listing the waiting worktree', async () => {
    searchParamsMock.current = new URLSearchParams('filter=approval');
    await renderTab();

    expect(screen.getByTestId('review-filter-approval').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('review-filter-in_review').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('review-item-needs-you')).toBeDefined();
    expect(screen.queryByTestId('review-item-in-review-one')).toBeNull();
  });

  it('honours the other filter ids too', async () => {
    searchParamsMock.current = new URLSearchParams('filter=stalled');
    await renderTab();
    expect(screen.getByTestId('review-filter-stalled').getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the default for an unknown filter instead of showing nothing', async () => {
    searchParamsMock.current = new URLSearchParams('filter=nonsense');
    await renderTab();
    expect(screen.getByTestId('review-filter-in_review').getAttribute('aria-pressed')).toBe('true');
  });

  it('re-applies the filter when the deep link is followed while already on /review', async () => {
    // Same-route navigation: the component does not remount, so a state
    // initializer alone would make the badge click look like a no-op.
    const { rerender } = render(<ReviewTab />);
    await waitFor(() => expect(screen.queryByTestId('review-loading')).toBeNull());
    expect(screen.getByTestId('review-filter-in_review').getAttribute('aria-pressed')).toBe('true');

    searchParamsMock.current = new URLSearchParams('filter=approval');
    rerender(<ReviewTab />);

    await waitFor(() =>
      expect(screen.getByTestId('review-filter-approval').getAttribute('aria-pressed')).toBe('true'),
    );
  });

  it('shows the same count on the approval chip as the badge would', async () => {
    searchParamsMock.current = new URLSearchParams('filter=approval');
    await renderTab();
    const approvalChip = screen.getByTestId('review-filter-approval');
    expect(approvalChip.textContent).toContain('1');
  });
});
