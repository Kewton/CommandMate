/**
 * @vitest-environment jsdom
 */

/**
 * The header control for "show the repository tabs when?" (Issue #2374).
 *
 * Two properties are worth pinning beyond "the select works":
 *
 *   - It renders the SAME three modes the storage validator accepts. A control
 *     that offered two of them, or a fourth that `isValidRepoTabBarMode`
 *     rejects, would be a setting the user can pick and the app then discards
 *     on the next reload.
 *   - It is safe without a `SidebarProvider`. `Header` is mounted bare in
 *     several component tests, and a preference control has no business being
 *     the reason one of them throws.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
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
import { REPOSITORY_TAB_BAR_COPY } from '@/components/layout/repository-tab-bar-copy';

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

describe('RepositoryTabBarModeSelector (Issue #2374)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts on the default mode', () => {
    mount();
    expect(screen.getByTestId('repo-tab-bar-mode-select')).toHaveValue(
      DEFAULT_REPO_TAB_BAR_MODE
    );
  });

  it('offers exactly the modes the storage validator accepts', () => {
    mount();
    const options = Array.from(
      screen.getByTestId('repo-tab-bar-mode-select').querySelectorAll('option')
    ).map((option) => option.value);

    expect(options).toEqual([...REPO_TAB_BAR_MODES]);
    for (const value of options) {
      expect(isValidRepoTabBarMode(value)).toBe(true);
    }
  });

  it('labels every option in both supported locales', () => {
    for (const locale of ['en', 'ja']) {
      const copy = REPOSITORY_TAB_BAR_COPY[locale];
      expect(copy, `missing copy for ${locale}`).toBeDefined();
      expect(copy.settingLabel).toBeTruthy();
      for (const mode of REPO_TAB_BAR_MODES) {
        expect(copy.mode[mode], `${locale}: ${mode}`).toBeTruthy();
      }
      // Three modes, three distinct words — a duplicate would make two of them
      // indistinguishable in the dropdown.
      expect(new Set(Object.values(copy.mode)).size).toBe(REPO_TAB_BAR_MODES.length);
    }
    // ...and the Japanese wording is actually translated, not the English one.
    for (const mode of REPO_TAB_BAR_MODES) {
      expect(REPOSITORY_TAB_BAR_COPY.ja.mode[mode]).not.toBe(
        REPOSITORY_TAB_BAR_COPY.en.mode[mode]
      );
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
