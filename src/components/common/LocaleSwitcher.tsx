/**
 * LocaleSwitcher Component [MF-001]
 *
 * Language switcher dropdown for the sidebar.
 * References LOCALE_LABELS and SUPPORTED_LOCALES from i18n-config.ts.
 */
'use client';

import { useTranslations } from 'next-intl';
import { useLocaleSwitch } from '@/hooks/useLocaleSwitch';
import { LOCALE_LABELS, SUPPORTED_LOCALES } from '@/config/i18n-config';

export function LocaleSwitcher() {
  const { currentLocale, switchLocale } = useLocaleSwitch();
  const t = useTranslations('common');

  return (
    <select
      value={currentLocale}
      onChange={(e) => switchLocale(e.target.value)}
      aria-label={t('language')}
      className="
        w-full px-3 py-2 rounded-md
        bg-sidebar text-sidebar-foreground
        border border-sidebar-border
        focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent
        text-sm
      "
    >
      {SUPPORTED_LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {LOCALE_LABELS[locale]}
        </option>
      ))}
    </select>
  );
}
