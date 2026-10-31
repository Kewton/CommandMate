/**
 * Review's approval list opens the waiting instance (Issue #4014), like the
 * sidebar rows (#4001): `/worktrees/<id>?instance=<id>`, else the bare URL.
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
  useSearchParams: () => new URLSearchParams('filter=approval'),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

import ReviewTab from '@/components/review/ReviewTab';

const agentInstances = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'claude-cc', cliTool: 'claude', alias: 'Command Code', order: 1 },
];
const idle = { isRunning: true, isWaitingForResponse: false, isProcessing: false };

function row(id: string, waitingSince: number | null) {
  return {
    id,
    name: `feature/${id}`,
    repositoryName: 'repo',
    status: 'in_review',
    isWaitingForResponse: true,
    selectedAgents: ['claude'],
    agentInstances,
    sessionStatusByCli: { claude: idle },
    sessionStatusByInstance: {
      claude: idle,
      'claude-cc': {
        isRunning: true,
        isWaitingForResponse: true,
        isProcessing: false,
        waitingKind: 'prompt',
        waitingSince,
      },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderWith(rows: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ worktrees: rows, repositories: [] }) }),
  );
  render(React.createElement(ReviewTab));
  await waitFor(() => expect(screen.getByTestId('review-list')).toBeTruthy());
}

describe('[#4014] ReviewTab approval list href', () => {
  it('opens the waiting instance with ?instance=', async () => {
    await renderWith([row('wt-a', 1000)]);
    await waitFor(() => expect(screen.getByTestId('review-item-wt-a')).toBeTruthy());
    expect(screen.getByTestId('review-item-wt-a').getAttribute('href')).toBe('/worktrees/wt-a?instance=claude-cc');
  });

  it('keeps the bare URL when no waiting instance can be named', async () => {
    await renderWith([row('wt-b', null)]);
    await waitFor(() => expect(screen.getByTestId('review-item-wt-b')).toBeTruthy());
    expect(screen.getByTestId('review-item-wt-b').getAttribute('href')).toBe('/worktrees/wt-b');
  });
});
