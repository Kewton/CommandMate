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

/**
 * The agent chips the row actually renders, in order.
 *
 * `ReviewTab` draws one `<span>` per agent holding that CLI's display name, so
 * reading the row's text in document order is reading the fallback's output.
 * This is the assertion the file header always claimed and did not make: the
 * store-level checks below pass even if the row still reads the constant.
 */
function chipsFor(id: string): string[] {
  const row = screen.getByTestId(`review-item-${id}`);
  return Array.from(row.querySelectorAll('span'))
    .map((el) => el.textContent ?? '')
    .filter((text) => AGENT_LABELS.includes(text));
}

const AGENT_LABELS = ['Claude', 'Codex', 'Gemini', 'Vibe Local', 'OpenCode', 'Copilot', 'Antigravity'];

describe('ReviewTab adopts defaultSelectedAgents (Issue #2065)', () => {
  it('renders the row chips from the payload default, in that order', async () => {
    mockList(['codex', 'claude']);
    render(React.createElement(ReviewTab));

    await waitFor(() => expect(screen.getByTestId('review-item-wt-2065')).toBeTruthy());
    await waitFor(() => expect(chipsFor('wt-2065')).toEqual(['Codex', 'Claude']));
    // The constant is ['claude','codex','antigravity'] — a different set in a
    // different order, so this cannot be satisfied by ignoring the payload.
    expect(chipsFor('wt-2065')).not.toContain('Antigravity');
  });

  it('seeds the client store from the list payload', async () => {
    mockList(['codex', 'claude']);
    render(React.createElement(ReviewTab));

    await waitFor(() => expect(screen.getByTestId('review-item-wt-2065')).toBeTruthy());
    expect(getClientDefaultSelectedAgents()).toEqual(['codex', 'claude']);
  });

  it('keeps the constant, and renders it, when an older server omits the field', async () => {
    mockList(undefined);
    render(React.createElement(ReviewTab));

    await waitFor(() => expect(screen.getByTestId('review-item-wt-2065')).toBeTruthy());
    expect(getClientDefaultSelectedAgents()).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(chipsFor('wt-2065')).toEqual(['Claude', 'Codex', 'Antigravity']);
  });

  it('lets a row with its own selectedAgents ignore the default', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        worktrees: [{ ...ROW, selectedAgents: ['gemini', 'copilot'] }],
        repositories: [],
        defaultSelectedAgents: ['codex', 'claude'],
      }),
    }) as unknown as typeof fetch;
    render(React.createElement(ReviewTab));

    await waitFor(() => expect(screen.getByTestId('review-item-wt-2065')).toBeTruthy());
    await waitFor(() => expect(chipsFor('wt-2065')).toEqual(['Gemini', 'Copilot']));
  });
});
