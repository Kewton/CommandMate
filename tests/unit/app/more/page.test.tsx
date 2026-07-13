/**
 * Unit tests for the More page (/more)
 * Issue #1081: Data screen control semantics — the "External Apps" heading is
 * owned by the page; ExternalAppsManager must not render a duplicate title.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// Mock AppShell to a passthrough so we don't pull in the full layout tree.
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // ExternalAppsManager fetches on mount; return an empty list.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ apps: [] }),
  }) as unknown as typeof fetch;
});

import MorePage from '@/app/more/page';

describe('More page (Issue #1081)', () => {
  it('renders exactly one "External Apps" heading (no duplicate from the manager)', async () => {
    render(React.createElement(MorePage));

    // Wait for ExternalAppsManager to settle its initial fetch.
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });

    const headings = screen.getAllByText('External Apps');
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe('H2');
  });

  it('still exposes the add-app action inside the External Apps section', async () => {
    render(React.createElement(MorePage));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add app/i })).toBeInTheDocument();
    });
  });
});
