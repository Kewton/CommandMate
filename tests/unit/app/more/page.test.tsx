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

import fs from 'fs';
import path from 'path';

const intlLocale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => intlLocale.current);
});

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
  intlLocale.current = 'en';
  // ExternalAppsManager fetches on mount; return an empty list.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ apps: [] }),
  }) as unknown as typeof fetch;
});

import MorePage from '@/app/more/page';

const enCommon = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'locales/en/common.json'), 'utf-8')
);
const jaCommon = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'locales/ja/common.json'), 'utf-8')
);

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

describe('heading (Issue #2645)', () => {
  it('renders en heading and pageDescription, without old copy', async () => {
    intlLocale.current = 'en';
    render(React.createElement(MorePage));

    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });

    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent(enCommon.nav.more);
    expect(screen.getByText(enCommon.settings.pageDescription)).toBeInTheDocument();
    expect(screen.queryByText('Settings, external apps, and more.')).toBeNull();
  });

  it('renders ja heading and pageDescription without latin characters', async () => {
    intlLocale.current = 'ja';
    render(React.createElement(MorePage));

    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    });

    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent(jaCommon.nav.more);
    expect(h1.textContent).not.toMatch(/[A-Za-z]/);
    expect(screen.getByText(jaCommon.settings.pageDescription)).toBeInTheDocument();
  });
});
