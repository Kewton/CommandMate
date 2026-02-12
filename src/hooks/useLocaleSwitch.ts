/**
 * useLocaleSwitch Hook [MF-002: SRP compliant]
 *
 * Orchestrates locale switching: validates, persists to cookie/localStorage, reloads.
 * Cookie persistence is delegated to setLocaleCookie utility.
 */
'use client';

import { useLocale } from 'next-intl';
import { SUPPORTED_LOCALES } from '@/config/i18n-config';
import type { SupportedLocale } from '@/config/i18n-config';
import { setLocaleCookie } from '@/lib/locale-cookie';

export function useLocaleSwitch() {
  const currentLocale = useLocale();

  const switchLocale = (newLocale: string) => {
    if (!SUPPORTED_LOCALES.includes(newLocale as SupportedLocale)) {
      return;
    }
    setLocaleCookie(newLocale as SupportedLocale);
    localStorage.setItem('locale', newLocale);
    window.location.reload();
  };

  return { currentLocale, switchLocale };
}
