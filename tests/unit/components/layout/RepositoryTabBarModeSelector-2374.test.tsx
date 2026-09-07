/**
 * @vitest-environment jsdom
 */

/**
 * The header control for "show the repository tabs when?" (Issue #2374).
 *
 * next-intl is backed by the REAL dictionary here rather than the key-echoing
 * global mock in tests/setup.ts. The wording is the thing under test — these
 * four strings were the only genuinely new sentences this Issue introduced — so
 * `getByText('Always show')` has to prove that `common.repoTabBar.mode.always`
 * resolves through locales/<locale>/common.json to that literal. The helper
 * throws on an unknown key, which is what turns a typo in the key path into a
 * failure instead of an option labelled `repoTabBar.mode.always`.
 *
 * Two further properties are worth pinning beyond "the select works":
 *
 *   - It renders the SAME three modes the storage validator accepts. A control
 *     that offered two of them, or a fourth that `isValidRepoTabBarMode`
 *     rejects, would be a setting the user can pick and the app then discards
 *     on the next reload.
 *   - It is safe without a `SidebarProvider`. `Header` is mounted bare in
 *     several component tests, and a preference control has no business being
 *     the reason one of them throws.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// Issue #2374: resolve labels through the real dictionary. A getter, because
// vi.mock factories are hoisted above the `locale` declaration.
const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { RepositoryTabBarModeSelector } from '@/components/layout/RepositoryTabBarModeSelector';
import {
  SidebarProvider,
  useSidebarContext,
  REPO_TAB_BAR_MODE_STORAGE_KEY,
} from '@/contexts/SidebarContext';
import {
  REPO_TAB_BAR_MODES,
  DEFAULT_REPO_TAB_BAR_MODE,
  isValidRepoTabBarMode,
} from '@/lib/sidebar-utils';

/** The English wording, pinned so a copy change is a deliberate act. */
const EN_LABELS: Record<string, string> = {
  always: 'Always show',
  collapsed: 'Only when the sidebar is collapsed',
  hidden: 'Hidden',
};

/** The Japanese wording, pinned for the same reason. */
const JA_LABELS: Record<string, string> = {
  always: '常に表示',
  collapsed: 'サイドバー折りたたみ時のみ',
  hidden: '非表示',
};

function ModeReadout() {
  const { repoTabBarMode } = useSidebarContext();
  return <span data-testid="mode">{repoTabBarMode}</span>;
}

function mount() {
  return render(
    <SidebarProvider>
      <RepositoryTabBarModeSelector />
      <ModeReadout />
    </SidebarProvider>
  );
}

function optionLabels(): string[] {
  return Array.from(
    screen.getByTestId('repo-tab-bar-mode-select').querySelectorAll('option')
  ).map((option) => option.textContent ?? '');
}

describe('RepositoryTabBarModeSelector (Issue #2374)', () => {
  beforeEach(() => {
    localStorage.clear();
    locale.current = 'en';
  });

  it('starts on the default mode', () => {
    mount();
    expect(screen.getByTestId('repo-tab-bar-mode-select')).toHaveValue(
      DEFAULT_REPO_TAB_BAR_MODE
    );
  });

  it('offers exactly the modes the storage validator accepts', () => {
    mount();
    const values = Array.from(
      screen.getByTestId('repo-tab-bar-mode-select').querySelectorAll('option')
    ).map((option) => option.value);

    expect(values).toEqual([...REPO_TAB_BAR_MODES]);
    for (const value of values) {
      expect(isValidRepoTabBarMode(value)).toBe(true);
    }
  });

  it('labels the control and every option from common.repoTabBar.* in English', () => {
    mount();
    expect(screen.getByLabelText('Repository tabs')).toBeInTheDocument();
    expect(optionLabels()).toEqual(REPO_TAB_BAR_MODES.map((mode) => EN_LABELS[mode]));
  });

  it('labels the control and every option in Japanese', () => {
    locale.current = 'ja';
    mount();
    expect(screen.getByLabelText('リポジトリタブ帯')).toBeInTheDocument();
    expect(optionLabels()).toEqual(REPO_TAB_BAR_MODES.map((mode) => JA_LABELS[mode]));
  });

  /**
   * Three modes, three distinct words. A duplicate would leave two options
   * indistinguishable in the dropdown — and the parity test in tests/unit/i18n
   * checks that the key SETS match across locales, not that the values differ.
   */
  it('keeps the three option labels distinct in both locales', () => {
    for (const labels of [EN_LABELS, JA_LABELS]) {
      const rendered = REPO_TAB_BAR_MODES.map((mode) => labels[mode]);
      expect(new Set(rendered).size).toBe(REPO_TAB_BAR_MODES.length);
    }
    for (const mode of REPO_TAB_BAR_MODES) {
      expect(JA_LABELS[mode]).not.toBe(EN_LABELS[mode]);
    }
  });

  it('publishes the chosen mode and persists it', () => {
    mount();
    fireEvent.change(screen.getByTestId('repo-tab-bar-mode-select'), {
      target: { value: 'always' },
    });

    expect(screen.getByTestId('mode').textContent).toBe('always');
    expect(localStorage.getItem(REPO_TAB_BAR_MODE_STORAGE_KEY)).toBe('always');
  });

  it('shows the stored mode after a remount', () => {
    localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, 'hidden');
    mount();
    expect(screen.getByTestId('repo-tab-bar-mode-select')).toHaveValue('hidden');
  });

  it('renders nothing rather than throwing when no SidebarProvider is above it', () => {
    cleanup();
    render(<RepositoryTabBarModeSelector />);
    expect(screen.queryByTestId('repo-tab-bar-mode-select')).toBeNull();
  });
});
