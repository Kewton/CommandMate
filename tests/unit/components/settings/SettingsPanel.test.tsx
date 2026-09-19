/**
 * SettingsPanel (Issue #2707).
 *
 * The panel is a pure lift-and-shift out of `/more`, so what is worth pinning
 * is not that it renders, but the three things a later edit could silently
 * break for the PC settings modal (#2708) that will reuse it:
 *
 *   1. The five headings come from `common.settings.sections.*` — the same keys
 *      the modal's left-hand categories will use — and they still carry the
 *      exact markup the page had inline (`mb-8` frame, `<h2>` classes).
 *   2. Each section renders on its own, because the modal mounts one category
 *      at a time rather than stacking all five.
 *   3. `onNavigate` fires from *every* quick link, so a modal can close itself
 *      before the route changes no matter which card was clicked.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

const intlLocale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => intlLocale.current);
});

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

import {
  SettingsPanel,
  SettingsQuickLinksSection,
  SettingsGeneralSection,
  SettingsNotificationsSection,
  SettingsExternalAppsSection,
  SettingsAboutSection,
} from '@/components/settings';

const HEADING_CLASS = 'text-lg font-semibold mb-4 text-foreground';

function headingTexts(): (string | null)[] {
  return screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
}

async function renderPanel(): Promise<void> {
  render(<SettingsPanel />);
  await waitFor(() => {
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(5);
  });
}

describe('SettingsPanel (Issue #2707)', () => {
  it('renders the five section headings from the dictionary, in order (en)', async () => {
    await renderPanel();

    expect(headingTexts()).toEqual([
      'Quick Links',
      'General',
      'Notifications',
      'External Apps',
      'About',
    ]);
  });

  it('translates the first three headings in ja', async () => {
    intlLocale.current = 'ja';
    await renderPanel();

    expect(headingTexts().slice(0, 3)).toEqual(['クイックリンク', '一般', '通知']);
  });

  it('keeps the section markup the page had inline', async () => {
    await renderPanel();

    for (const h2 of screen.getAllByRole('heading', { level: 2 })) {
      expect(h2.className).toBe(HEADING_CLASS);
      expect(h2.parentElement).toHaveClass('mb-8');
    }
  });
});

describe('SettingsPanel quick links (Issue #2707)', () => {
  const LINKS: [string, string][] = [
    ['more-link-repositories', '/repositories'],
    ['more-link-skills', '/skills'],
    ['more-link-skills-installed', '/skills/installed'],
  ];

  it.each(LINKS)('keeps %s pointing at %s', async (testId, href) => {
    await renderPanel();

    expect(screen.getByTestId(testId)).toHaveAttribute('href', href);
  });

  it.each(LINKS.map(([testId]) => testId))('calls onNavigate when %s is clicked', (testId) => {
    const onNavigate = vi.fn();
    render(<SettingsQuickLinksSection onNavigate={onNavigate} />);

    fireEvent.click(screen.getByTestId(testId));

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('stays clickable without onNavigate (how the page mounts it)', () => {
    render(<SettingsQuickLinksSection />);

    for (const [testId] of LINKS) {
      expect(() => fireEvent.click(screen.getByTestId(testId))).not.toThrow();
    }
  });
});

describe('SettingsPanel sections render standalone (Issue #2707)', () => {
  const SECTIONS: [string, React.ComponentType, string][] = [
    ['SettingsQuickLinksSection', SettingsQuickLinksSection, 'Quick Links'],
    ['SettingsGeneralSection', SettingsGeneralSection, 'General'],
    ['SettingsNotificationsSection', SettingsNotificationsSection, 'Notifications'],
    ['SettingsExternalAppsSection', SettingsExternalAppsSection, 'External Apps'],
    ['SettingsAboutSection', SettingsAboutSection, 'About'],
  ];

  it.each(SECTIONS)('renders %s on its own', async (_name, Section, heading) => {
    render(<Section />);

    await waitFor(() => {
      expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(heading);
  });
});
