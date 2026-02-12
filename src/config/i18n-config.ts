/**
 * i18n Configuration - Single Source of Truth [MF-001]
 *
 * All locale-related constants are centralized here.
 * When adding a new language, update SUPPORTED_LOCALES and LOCALE_LABELS only.
 */

export const SUPPORTED_LOCALES = ['en', 'ja'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LOCALE_COOKIE_NAME = 'locale';

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  ja: '日本語',
};
