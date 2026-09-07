/**
 * RepositoryTabBarModeSelector — "show the repository tabs when?" (Issue #2374).
 *
 * Sits next to `PcDisplaySizeSelector` in the header because it is the same
 * kind of control: a display preference for the PC chrome, persisted in
 * localStorage, with no server round-trip. Hidden on mobile for the same reason
 * that one is — the strip it governs is desktop-only.
 *
 * Wording lives in `common.repoTabBar.*` (locales/{en,ja}/common.json). Every
 * other string the strip renders reuses an existing key — repository names are
 * data, the status words are `common.status.*` via `SIDEBAR_STATUS_CONFIG`, the
 * attention count is `common.attention.badgeLabel`, the overflow trigger is
 * `common.nav.more`, and the popover's landmark / empty copy is
 * `common.sidebar.*`.
 *
 * @module components/layout/RepositoryTabBarModeSelector
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { useOptionalSidebarContext } from '@/contexts/SidebarContext';
import { REPO_TAB_BAR_MODES, isValidRepoTabBarMode } from '@/lib/sidebar-utils';

/**
 * Three-way visibility selector for the repository tab bar.
 *
 * @example
 * ```tsx
 * <RepositoryTabBarModeSelector />
 * ```
 */
export function RepositoryTabBarModeSelector() {
  // Optional on purpose: the header is mounted on its own in several component
  // tests, and a preference control has no business being the reason one of
  // them throws. In the app the provider is always above it (AppProviders).
  const sidebar = useOptionalSidebarContext();
  const t = useTranslations('common');

  if (!sidebar) return null;
  const { repoTabBarMode, setRepoTabBarMode } = sidebar;

  return (
    <div className="hidden md:flex items-center">
      <label htmlFor="repo-tab-bar-mode" className="sr-only">
        {t('repoTabBar.settingLabel')}
      </label>
      <select
        id="repo-tab-bar-mode"
        data-testid="repo-tab-bar-mode-select"
        aria-label={t('repoTabBar.settingLabel')}
        title={t('repoTabBar.settingLabel')}
        value={repoTabBarMode}
        onChange={(event) => {
          const next = event.target.value;
          // The <select> can only emit the values rendered below; the guard is
          // for the type, not for a case that can happen.
          if (isValidRepoTabBarMode(next)) setRepoTabBarMode(next);
        }}
        className="rounded-md border border-border bg-surface px-2 py-1 text-sm
          text-muted-foreground transition-colors hover:text-foreground
          focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {REPO_TAB_BAR_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`repoTabBar.mode.${mode}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
