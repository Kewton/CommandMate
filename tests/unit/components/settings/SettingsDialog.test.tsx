/**
 * SettingsDialog (Issue #2708).
 *
 * The sections themselves are covered by SettingsPanel.test.tsx, so they are
 * mocked away here and what is left under test is the dialog skeleton — the
 * three things #2709 and later edits could silently break:
 *
 *   1. Nothing mounts while the modal is closed (the notification / external-app
 *      fetches must not run on every page load just because AppProviders now
 *      renders <SettingsDialog /> app-wide).
 *   2. The left-hand categories resolve to a *vertical* tablist: the class list
 *      is passed through tailwind-merge, so `items-center` from TabsList has to
 *      lose to `items-stretch` or the categories end up in a row.
 *   3. Only the selected category is mounted, and Escape / a quick link both
 *      close the dialog.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const intlLocale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => intlLocale.current);
});

vi.mock('@/components/settings/SettingsPanel', () => ({
  SettingsGeneralSection: () => <div data-testid="section-general" />,
  SettingsNotificationsSection: () => <div data-testid="section-notifications" />,
  SettingsExternalAppsSection: () => <div data-testid="section-externalApps" />,
  SettingsAboutSection: () => <div data-testid="section-about" />,
  SettingsQuickLinksSection: ({ onNavigate }: { onNavigate?: () => void }) => (
    <button type="button" data-testid="section-quicklinks" onClick={onNavigate} />
  ),
}));

import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { SettingsDialogProvider, useSettingsDialog } from '@/contexts/SettingsDialogContext';

/** Gives the test the only way to open the modal (#2709 wires the real ones). */
function OpenProbe() {
  const { open } = useSettingsDialog();
  return <button type="button" data-testid="open-probe" onClick={open} />;
}

function renderDialog(): void {
  render(
    <SettingsDialogProvider>
      <OpenProbe />
      <SettingsDialog />
    </SettingsDialogProvider>
  );
}

function openDialog(): void {
  fireEvent.click(screen.getByTestId('open-probe'));
}

/**
 * Radix activates a tab on mousedown, not on click — the same way
 * tests/unit/components/ui/Tabs.test.tsx drives it. A bare `click` leaves the
 * first category selected and the assertions below silently pass on nothing.
 */
function selectCategory(id: string): void {
  fireEvent.mouseDown(screen.getByTestId(`settings-dialog-tab-${id}`));
}

beforeEach(() => {
  cleanup();
  intlLocale.current = 'en';
});

describe('SettingsDialog', () => {
  describe('while closed', () => {
    it('renders neither the dialog nor any section', () => {
      renderDialog();

      expect(screen.queryByTestId('settings-dialog')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByTestId('section-general')).toBeNull();
      expect(screen.queryByTestId('section-notifications')).toBeNull();
      expect(screen.queryByTestId('section-externalApps')).toBeNull();
      expect(screen.queryByTestId('section-about')).toBeNull();
    });
  });

  describe('once opened', () => {
    beforeEach(() => {
      renderDialog();
      openDialog();
    });

    it('renders a modal dialog titled Settings', () => {
      const dialog = screen.getByRole('dialog');

      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Settings');
      expect(screen.getByTestId('settings-dialog')).toBeTruthy();
    });

    it('labels the category list and orients it vertically', () => {
      const tablist = screen.getByRole('tablist', { name: 'Settings categories' });

      expect(tablist.getAttribute('aria-orientation')).toBe('vertical');
    });

    it('lists the four categories in order', () => {
      expect(screen.getAllByRole('tab').map((el) => el.textContent)).toEqual([
        'General',
        'Notifications',
        'External Apps',
        'About',
      ]);
    });

    it('resolves the category list to a stacked column (tailwind-merge)', () => {
      const { className } = screen.getByRole('tablist');

      expect(className).toContain('flex-col');
      expect(className).toContain('items-stretch');
      expect(className).toContain('sticky');
      expect(className).not.toContain('items-center');
    });

    it('mounts only the selected category', () => {
      expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true');
      expect(screen.getByTestId('section-general')).toBeTruthy();
      expect(screen.queryByTestId('section-notifications')).toBeNull();
      expect(screen.queryByTestId('section-externalApps')).toBeNull();
      expect(screen.queryByTestId('section-about')).toBeNull();
    });

    it('unmounts the previous category when another is picked', () => {
      selectCategory('notifications');

      expect(screen.getByTestId('section-notifications')).toBeTruthy();
      expect(screen.queryByTestId('section-general')).toBeNull();
    });

    it('shows the quick links alongside About', () => {
      selectCategory('about');

      expect(screen.getByTestId('section-quicklinks')).toBeTruthy();
      expect(screen.getByTestId('section-about')).toBeTruthy();
    });

    it('closes on Escape', async () => {
      fireEvent.keyDown(document, { key: 'Escape' });

      // Modal keeps the panel mounted for the exit animation window.
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('closes when a quick link is followed, so the route change is not hidden behind the modal', async () => {
      selectCategory('about');
      fireEvent.click(screen.getByTestId('section-quicklinks'));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });

  describe('in Japanese', () => {
    beforeEach(() => {
      intlLocale.current = 'ja';
      renderDialog();
      openDialog();
    });

    it('translates the title and the categories', () => {
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('設定');
      expect(screen.getByRole('tablist', { name: '設定のカテゴリ' })).toBeTruthy();
      expect(screen.getAllByRole('tab').map((el) => el.textContent)).toEqual([
        '一般',
        '通知',
        'External Apps',
        'About',
      ]);
    });
  });
});
