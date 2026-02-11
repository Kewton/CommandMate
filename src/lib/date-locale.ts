/**
 * date-fns Locale Mapping [SF-004]
 *
 * Maps next-intl locale strings to date-fns Locale objects.
 * When adding a new language, add an entry to DATE_FNS_LOCALE_MAP.
 */
import { ja } from 'date-fns/locale/ja';
import { enUS } from 'date-fns/locale/en-US';
import type { Locale } from 'date-fns';
import type { SupportedLocale } from '@/config/i18n-config';

const DATE_FNS_LOCALE_MAP: Record<SupportedLocale, Locale> = {
  en: enUS,
  ja: ja,
};

export function getDateFnsLocale(locale: string): Locale {
  return DATE_FNS_LOCALE_MAP[locale as SupportedLocale] ?? enUS;
}
