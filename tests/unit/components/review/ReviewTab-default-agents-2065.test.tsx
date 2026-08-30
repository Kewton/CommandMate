/**
 * `/review` adopts the default the list payload carries (Issue #2065).
 *
 * `GET /api/worktrees` sends `defaultSelectedAgents` on every call, and this is
 * the one screen in scope that reads that envelope directly rather than through
 * the shared worktrees cache. So the wiring claim worth pinning is narrow: the
 * value from the payload reaches the module store, and the row's agent chips
 * come from it rather than from the compiled-in constant.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

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
import {
  getClientDefaultSelectedAgents,
  resetClientDefaultSelectedAgents,
} from '@/config/default-agents';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';

/** No `selectedAgents`, so the row falls back — which is the point. */
const ROW = {
  id: 'wt-2065',
  name: 'feature/2065',
  repositoryName: 'repo',
  status: 'in_review',
  reviewStatus: 'in_review',
};

function mockList(defaultSelectedAgents: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ worktrees: [ROW], repositories: [], defaultSelectedAgents }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClientDefaultSelectedAgents();
});

afterEach(() => {
  cleanup();
  resetClientDefaultSelectedAgents();
});

describe('ReviewTab adopts defaultSelectedAgents (Issue #2065)', () => {
  it('seeds the client store from the list payload', async () => {
    mockList(['codex', 'claude']);
    render(React.createElement(ReviewTab));

    await waitFor(() => expect(screen.getByTestId('review-item-wt-2065')).toBeTruthy());
    expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude']);
  });

  it('keeps the constant when an older server omits the field', async () => {
    mockList(undefined);
    render(React.createElement(ReviewTab));

    await waitFor(() => expect(screen.getByTestId('review-item-wt-2065')).toBeTruthy());
    expect(getClientDefaultSelectedAgents()).toEqual(DEFAULT_SELECTED_AGENTS);
  });
});
