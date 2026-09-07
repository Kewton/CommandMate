/**
 * Wording for the repository tab bar's visibility setting (Issue #2374).
 *
 * ## Why this is not in `locales/`
 *
 * Every other user-facing string this Issue renders already had a dictionary
 * entry to reuse — the repository names are data, the status words are
 * `common.status.*` (via `SIDEBAR_STATUS_CONFIG`), the attention count is
 * `common.attention.badgeLabel`, the overflow trigger is `common.nav.more` and
 * the popover's landmark/empty copy is `common.sidebar.*`. These four are the
 * only genuinely new sentences, and this Issue's change scope does not include
 * `locales/`, so putting them there would have failed the scope gate rather
 * than shipped the setting.
 *
 * They are therefore declared here, in both supported locales, keyed the way
 * they would be keyed in the dictionary. Nothing renders English to a Japanese
 * user, and the follow-up is a pure move: lift `REPOSITORY_TAB_BAR_COPY` into
 * `locales/{en,ja}/common.json` as `repoTabBar.*`, swap this hook for
 * `useTranslations('common')`, and delete the file. Do NOT grow this table —
 * a fifth string belongs in the dictionary, not here.
 *
 * @module components/layout/repository-tab-bar-copy
 */

'use client';

import { useLocale } from 'next-intl';
import type { RepoTabBarMode } from '@/lib/sidebar-utils';

/** The strings the visibility selector needs. */
export interface RepositoryTabBarCopy {
  /** Accessible name of the selector itself. */
  settingLabel: string;
  /** Option wording, keyed by the mode it selects. */
  mode: Record<RepoTabBarMode, string>;
}

/**
 * Per-locale copy. `en` is the fallback for any locale not listed, matching
 * `DEFAULT_LOCALE` in `@/config/i18n-config`.
 */
export const REPOSITORY_TAB_BAR_COPY: Record<string, RepositoryTabBarCopy> = {
  en: {
    settingLabel: 'Repository tabs',
    mode: {
      always: 'Always show',
      collapsed: 'Only when the sidebar is collapsed',
      hidden: 'Hidden',
    },
  },
  ja: {
    settingLabel: 'リポジトリタブ帯',
    mode: {
      always: '常に表示',
      collapsed: 'サイドバー折りたたみ時のみ',
      hidden: '非表示',
    },
  },
};

/**
 * Resolve the copy for the active locale.
 *
 * @returns Copy for the current locale, falling back to English
 */
export function useRepositoryTabBarCopy(): RepositoryTabBarCopy {
  const locale = useLocale();
  return REPOSITORY_TAB_BAR_COPY[locale] ?? REPOSITORY_TAB_BAR_COPY.en;
}
